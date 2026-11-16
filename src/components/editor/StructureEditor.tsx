import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Copy, Trash2, Wand2, FileText, FolderTree, Check } from "lucide-react";
import { api, errorText, type PlanItem, type Template } from "../../ipc";
import { activeWorkspace, confirm, get, toast, updateWorkspace, useActiveWorkspace, useStore, type Tab } from "../../store";
import { applyStructure, openFile, saveTemplates } from "../../actions";
import { FileIcon } from "../FileIcon";
import { debounce, uid } from "../../util";

type StructureTab = Extract<Tab, { kind: "structure" }>;

export function StructureEditor({ tab }: { tab: StructureTab }) {
  const ws = useActiveWorkspace();
  const templates = useStore((s) => s.templates);
  const info = useStore((s) => s.info);
  const selectedId = tab.templateId ?? ws.structureId ?? templates[0]?.id ?? null;
  const template = templates.find((t) => t.id === selectedId) ?? null;
  const [name, setName] = useState(template?.name ?? "");
  const [tree, setTree] = useState(template?.tree ?? "");
  const [plan, setPlan] = useState<PlanItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setName(template?.name ?? "");
    setTree(template?.tree ?? "");
  }, [template?.id]);

  const persist = useMemo(
    () =>
      debounce((id: string, nextName: string, nextTree: string) => {
        const list = get().templates.map((t) => (t.id === id ? { ...t, name: nextName, tree: nextTree } : t));
        saveTemplates(list);
      }, 500),
    [],
  );

  useEffect(() => {
    if (!template) return;
    if (template.name !== name || template.tree !== tree) persist(template.id, name, tree);
  }, [name, tree, template, persist]);

  useEffect(() => {
    const root = ws.root ?? `${info?.dataDir ?? "C:\\"}\\__preview__`;
    let alive = true;
    const timer = window.setTimeout(() => {
      api
        .structurePlan(root, tree)
        .then((p) => {
          if (!alive) return;
          setPlan(p);
          setError(null);
        })
        .catch((e) => alive && setError(errorText(e)));
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [tree, ws.root, info?.dataDir]);

  const select = (id: string) => {
    updateWorkspace(activeWorkspace().id, (w) => ({ ...w, tabs: w.tabs.map((t) => (t.id === tab.id ? { ...t, templateId: id } : t)) }));
  };

  const create = async (base?: Template) => {
    const created: Template = {
      id: uid("tpl"),
      name: base ? `${base.name} (копія)` : "Новий шаблон",
      tree: base?.tree ?? "src/\n  components/\n  lib/\ndocs/\nREADME.md\n",
      builtin: false,
    };
    await saveTemplates([...get().templates, created]);
    select(created.id);
  };

  const remove = async () => {
    if (!template) return;
    if (!(await confirm(`Видалити шаблон «${template.name}»?`, undefined, true, "Видалити"))) return;
    const rest = get().templates.filter((t) => t.id !== template.id);
    await saveTemplates(rest);
    if (rest[0]) select(rest[0].id);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const el = event.currentTarget;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const lineStart = tree.lastIndexOf("\n", start - 1) + 1;
    if (event.shiftKey) {
      if (tree.slice(lineStart, lineStart + 2) === "  ") {
        const next = tree.slice(0, lineStart) + tree.slice(lineStart + 2);
        setTree(next);
        requestAnimationFrame(() => el.setSelectionRange(Math.max(lineStart, start - 2), Math.max(lineStart, end - 2)));
      }
      return;
    }
    const next = tree.slice(0, start) + "  " + tree.slice(end);
    setTree(next);
    requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2));
  };

  const assign = async () => {
    if (!ws.root || !template) return;
    updateWorkspace(ws.id, (w) => ({ ...w, structureId: template.id }));
    await applyStructure(ws.root, tree);
    setPlan(await api.structurePlan(ws.root, tree));
  };

  const writeClaude = async () => {
    if (!ws.root) return;
    try {
      const file = await api.structureWriteClaudeMd(ws.root, tree);
      toast("Структуру записано в CLAUDE.md проекту", "ok");
      openFile(file);
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const missing = plan.filter((p) => !p.exists).length;

  return (
    <div className="structure-editor">
      <div className="tpl-list">
        <div className="pane-head">
          <FolderTree size={14} />
          <span>Шаблони</span>
          <div className="grow" />
          <button className="icon-btn" title="Новий шаблон" onClick={() => create()}>
            <Plus size={14} />
          </button>
        </div>
        <div className="tpl-scroll">
          {templates.map((t) => (
            <button key={t.id} className={`tpl-item${t.id === selectedId ? " active" : ""}`} onClick={() => select(t.id)}>
              <span className="grow ellipsis">{t.name}</span>
              {t.id === ws.structureId && <Check size={12} className="accent" />}
            </button>
          ))}
        </div>
      </div>
      {template ? (
        <>
          <div className="tpl-edit">
            <div className="pane-head">
              <input className="input bare" value={name} onChange={(e) => setName(e.target.value)} />
              <button className="icon-btn" title="Дублювати" onClick={() => create(template)}>
                <Copy size={13} />
              </button>
              <button className="icon-btn" title="Видалити" onClick={remove}>
                <Trash2 size={13} />
              </button>
            </div>
            <textarea
              ref={area}
              className="tree-input"
              value={tree}
              spellCheck={false}
              onChange={(e) => setTree(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={"src/\n  components/\n  lib/\ndocs/\nREADME.md"}
            />
            <div className="tree-help">
              Один рядок — одна папка або файл. Відступ = вкладеність (Tab / Shift Tab). Папки закінчуй на «/». Можна вставити вивід команди tree.
            </div>
          </div>
          <div className="tpl-preview">
            <div className="pane-head">
              <span>{ws.root ? `Як ляже на ${ws.name}` : "Попередній перегляд"}</span>
              <div className="grow" />
              {ws.root && <span className={missing ? "warn-text small" : "ok-text small"}>{missing ? `створить ${missing}` : "усе на місці"}</span>}
            </div>
            <div className="preview-tree">
              {error && <div className="hint error">{error}</div>}
              {plan.map((item) => (
                <div key={item.path} className={`plan-item${ws.root ? (item.exists ? " exists" : " missing") : ""}`} style={{ paddingLeft: 10 + item.depth * 16 }}>
                  <FileIcon name={item.name} dir={item.dir} size={14} open={item.dir} />
                  <span>{item.name}</span>
                  {ws.root && !item.exists && <span className="plan-new">нове</span>}
                </div>
              ))}
            </div>
            {ws.root && (
              <div className="preview-actions">
                <button className="btn primary grow" onClick={assign}>
                  <Wand2 size={13} /> Застосувати до {ws.name}
                </button>
                <button className="btn" onClick={writeClaude} title="Записати структуру як правило для Claude">
                  <FileText size={13} /> У CLAUDE.md
                </button>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="file-message">Створи перший шаблон структури.</div>
      )}
    </div>
  );
}
