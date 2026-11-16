import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { Eye, Code2, FolderOpen, RotateCcw, ChevronRight, WrapText } from "lucide-react";
import { getDoc, loadDoc, reloadDoc, revealLine, storeState, type Doc } from "../../docs";
import { languageFor } from "../../editor/setup";
import { set, useStore, type Tab } from "../../store";
import { api } from "../../ipc";
import { formatBytes, relativePath, samePath, extname } from "../../util";
import { handleMarkdownClick, renderMarkdown, splitFrontmatter } from "../../markdown";
import { FileIcon } from "../FileIcon";

type FileTab = Extract<Tab, { kind: "file" }>;

const previewing = new Set<string>();

function Breadcrumbs({ path, root }: { path: string; root: string | null }) {
  const parts = (root ? relativePath(root, path) : path).split(/[\\/]/).filter(Boolean);
  return (
    <div className="crumbs">
      {parts.map((part, index) => (
        <span key={index} className="crumb">
          {index > 0 && <ChevronRight size={12} className="crumb-sep" />}
          {index === parts.length - 1 && <FileIcon name={part} size={13} />}
          <span>{part}</span>
        </span>
      ))}
    </div>
  );
}

export function CodeEditor({ tab, root }: { tab: FileTab; root: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const currentPath = useRef<string | null>(null);
  const [doc, setDoc] = useState<Doc | null>(() => getDoc(tab.path) ?? null);
  const [preview, setPreview] = useState(previewing.has(tab.path.toLowerCase()));
  const [previewText, setPreviewText] = useState("");
  const epoch = useStore((s) => s.editorEpoch);
  const wrap = useStore((s) => s.settings.editorWrap);
  const isMarkdown = ["md", "mdx", "markdown"].includes(extname(tab.path));

  useEffect(() => {
    let alive = true;
    const existing = getDoc(tab.path);
    setDoc(existing && existing.status !== "loading" ? existing : null);
    loadDoc(tab.path).then((d) => alive && setDoc({ ...d }));
    setPreview(previewing.has(tab.path.toLowerCase()));
    return () => {
      alive = false;
    };
  }, [tab.path]);

  useEffect(() => {
    view.current = new EditorView({ parent: host.current! });
    return () => {
      if (currentPath.current && view.current) storeState(currentPath.current, view.current.state);
      view.current?.destroy();
      view.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const v = view.current;
    if (!v) return;
    if (currentPath.current && !samePath(currentPath.current, tab.path)) storeState(currentPath.current, v.state);
    const live = getDoc(tab.path);
    if (live && live.status === "text" && live.state) {
      if (!samePath(currentPath.current, tab.path) || v.state !== live.state) v.setState(live.state);
      currentPath.current = tab.path;
      set({ language: languageFor(tab.path).label });
      const head = v.state.selection.main.head;
      const line = v.state.doc.lineAt(head);
      set({ cursor: { line: line.number, col: head - line.from + 1, selected: 0 } });
      const pending = revealLine.get(tab.path.toLowerCase());
      if (pending) {
        revealLine.delete(tab.path.toLowerCase());
        const target = v.state.doc.line(Math.min(pending, v.state.doc.lines));
        v.dispatch({ selection: EditorSelection.cursor(target.from), effects: EditorView.scrollIntoView(target.from, { y: "center" }) });
      }
      if (!preview) requestAnimationFrame(() => v.focus());
    } else {
      currentPath.current = null;
      set({ language: live?.status === "image" ? "Зображення" : "", cursor: null });
    }
  }, [doc, tab.path, epoch, preview]);

  useEffect(() => {
    if (preview && view.current) setPreviewText(view.current.state.doc.toString());
  }, [preview, doc]);

  const togglePreview = () => {
    const key = tab.path.toLowerCase();
    if (preview) previewing.delete(key);
    else previewing.add(key);
    setPreview(!preview);
  };

  const rendered = useMemo(() => {
    if (!preview) return null;
    const { fields, body } = splitFrontmatter(previewText);
    return { fields, html: renderMarkdown(body) };
  }, [preview, previewText]);

  const status = doc?.status ?? "loading";
  const showEditor = status === "text" && !preview;

  return (
    <div className="file-view">
      <div className="file-bar">
        <Breadcrumbs path={tab.path} root={root} />
        <div className="file-bar-actions">
          {isMarkdown && status === "text" && (
            <button className={`icon-btn${preview ? " on" : ""}`} title={preview ? "Показати код" : "Перегляд Markdown"} onClick={togglePreview}>
              {preview ? <Code2 size={14} /> : <Eye size={14} />}
            </button>
          )}
          {status === "text" && (
            <button
              className={`icon-btn${wrap ? " on" : ""}`}
              title="Перенос рядків"
              onClick={() => set((s) => ({ settings: { ...s.settings, editorWrap: !s.settings.editorWrap } }))}
            >
              <WrapText size={14} />
            </button>
          )}
          <button className="icon-btn" title="Перечитати з диска" onClick={() => reloadDoc(tab.path).then((d) => setDoc({ ...d }))}>
            <RotateCcw size={13} />
          </button>
          <button className="icon-btn" title="Показати в Провіднику" onClick={() => api.reveal(tab.path)}>
            <FolderOpen size={14} />
          </button>
        </div>
      </div>
      <div className="file-content">
        <div ref={host} className="cm-host" style={{ display: showEditor ? "block" : "none" }} />
        {status === "loading" && <div className="file-message">Відкриваю…</div>}
        {status === "binary" && <div className="file-message">Це бінарний файл ({formatBytes(doc?.size ?? 0)}). Mavix не відкриває його як текст.</div>}
        {status === "large" && <div className="file-message">Файл завеликий для редактора ({formatBytes(doc?.size ?? 0)}).</div>}
        {status === "error" && <div className="file-message error">{doc?.error}</div>}
        {status === "image" && doc?.dataUrl && (
          <div className="image-view">
            <img src={doc.dataUrl} alt="" />
          </div>
        )}
        {status === "text" && preview && rendered && (
          <div className="md-preview" onClick={handleMarkdownClick}>
            {rendered.fields.length > 0 && (
              <div className="fm-table">
                {rendered.fields.map((f) => (
                  <div key={f.key} className="fm-row">
                    <span className="fm-key">{f.key}</span>
                    <span className="fm-value">{f.value}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="md" dangerouslySetInnerHTML={{ __html: rendered.html }} />
          </div>
        )}
      </div>
    </div>
  );
}
