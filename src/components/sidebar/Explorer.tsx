import { useEffect, useRef, useState } from "react";
import { ChevronRight, FilePlus, FolderPlus, RefreshCw, ChevronsDownUp, FolderOpen, Sparkles } from "lucide-react";
import { api, type Entry } from "../../ipc";
import { activeWorkspace, openMenu, useActiveWorkspace, useStore } from "../../store";
import {
  applyRename,
  beginRename,
  collapseAll,
  copyText,
  currentFilePath,
  deletePath,
  endRename,
  loadDir,
  newClaudeSession,
  newFileIn,
  newFolderIn,
  newTerminal,
  openFile,
  openFolderDialog,
  openProject,
  refreshExpanded,
  revealInTree,
  toggleExpanded,
} from "../../actions";
import { FileIcon } from "../FileIcon";
import { SideHeader } from "../Sidebar";
import { basename, relativePath, samePath } from "../../util";

function entryMenu(event: React.MouseEvent, entry: Entry) {
  const ws = activeWorkspace();
  const dir = entry.dir ? entry.path : entry.path.replace(/[\\/][^\\/]+$/, "");
  openMenu(event, [
    { label: "Новий файл…", action: () => newFileIn(dir) },
    { label: "Нова папка…", action: () => newFolderIn(dir) },
    "separator",
    ...(entry.dir
      ? [
          { label: "Термінал тут", action: () => newTerminal({ cwd: entry.path }) },
          { label: "Claude тут", action: () => newClaudeSession(undefined, entry.path) },
          "separator" as const,
        ]
      : []),
    { label: "Перейменувати", shortcut: "F2", action: () => beginRename(entry.path) },
    { label: "Видалити в кошик", danger: true, action: () => deletePath(entry.path) },
    "separator",
    { label: "Копіювати шлях", action: () => copyText(entry.path) },
    { label: "Копіювати відносний шлях", action: () => copyText(ws.root ? relativePath(ws.root, entry.path) : entry.path) },
    { label: "Показати в Провіднику", action: () => api.reveal(entry.path) },
  ]);
}

const RENAME_FOCUS_GRACE_MS = 600;

function RenameField({ entry }: { entry: Entry }) {
  const [value, setValue] = useState(entry.name);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const shownAt = useRef(0);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    shownAt.current = performance.now();
    el.focus();
    const dot = entry.dir ? -1 : entry.name.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  }, [entry]);
  const onBlur = () => {
    if (performance.now() - shownAt.current < RENAME_FOCUS_GRACE_MS) {
      window.setTimeout(() => input.current?.focus(), 0);
      return;
    }
    finish(true);
  };
  const finish = async (commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (!commit || value.trim() === entry.name || !value.trim()) {
      endRename();
      return;
    }
    const ok = await applyRename(entry.path, value);
    if (ok) endRename();
    else {
      finished.current = false;
      input.current?.focus();
    }
  };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <input
      ref={input}
      className="tree-rename"
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onClick={stop}
      onMouseDown={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={onBlur}
    />
  );
}

function TreeRow({ entry, depth }: { entry: Entry; depth: number }) {
  const expanded = useStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeId) ?? s.home;
    return ws.expanded.some((p) => samePath(p, entry.path));
  });
  const active = useStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeId) ?? s.home;
    const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
    return tab?.kind === "file" && samePath(tab.path, entry.path);
  });
  const dirty = useStore((s) => !!s.dirty[entry.path]);
  const renaming = useStore((s) => samePath(s.renaming, entry.path));
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) row.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const onClick = (event: React.MouseEvent) => {
    if (renaming) return;
    if (event.detail >= 3) {
      beginRename(entry.path);
      return;
    }
    if (event.detail !== 1) return;
    if (entry.dir) toggleExpanded(entry.path);
    else openFile(entry.path);
  };
  return (
    <>
      <div
        ref={row}
        className={`tree-row${active ? " active" : ""}${entry.dim ? " dim" : ""}${renaming ? " renaming" : ""}`}
        style={{ paddingLeft: 8 + depth * 14, ["--depth" as string]: depth }}
        onClick={onClick}
        onContextMenu={(e) => entryMenu(e, entry)}
        onKeyDown={(e) => e.key === "F2" && beginRename(entry.path)}
        tabIndex={-1}
        title={renaming ? undefined : `${entry.path}\nПотрійний клік або F2 — перейменувати`}
      >
        {Array.from({ length: depth }, (_, i) => (
          <span key={i} className="guide" style={{ left: 15 + i * 14 }} />
        ))}
        <span className={`chev${entry.dir ? "" : " invisible"}${expanded ? " open" : ""}`}>
          <ChevronRight size={13} strokeWidth={2} />
        </span>
        <FileIcon name={entry.name} dir={entry.dir} open={expanded} />
        {renaming ? <RenameField entry={entry} /> : <span className="tree-name">{entry.name}</span>}
        {dirty && !renaming && <span className="dirty-dot" />}
      </div>
      {entry.dir && expanded && <TreeChildren dir={entry.path} depth={depth + 1} />}
    </>
  );
}

function TreeChildren({ dir, depth }: { dir: string; depth: number }) {
  const entries = useStore((s) => s.dirCache[dir]);
  useEffect(() => {
    if (!entries) loadDir(dir);
  }, [dir, entries]);
  if (!entries) return <div className="tree-loading" style={{ paddingLeft: 30 + depth * 14 }}>…</div>;
  if (entries.length === 0 && depth > 0) return <div className="tree-empty" style={{ paddingLeft: 30 + depth * 14 }}>порожньо</div>;
  return (
    <>
      {entries.map((entry) => (
        <TreeRow key={entry.path} entry={entry} depth={depth} />
      ))}
    </>
  );
}

function NoProject() {
  const recent = useStore((s) => s.recent);
  return (
    <div className="side-empty">
      <p>Відкрий папку проекту — вона стане окремою вкладкою вгорі. Проектів може бути скільки завгодно.</p>
      <button className="btn primary wide" onClick={openFolderDialog}>
        <FolderOpen size={14} /> Відкрити папку
      </button>
      <button className="btn wide" onClick={() => window.dispatchEvent(new CustomEvent("mavix:new-project"))}>
        <Sparkles size={14} /> Новий проект зі структурою
      </button>
      {recent.length > 0 && (
        <div className="recent-list">
          <div className="section-label">Нещодавні</div>
          {recent.slice(0, 10).map((r) => (
            <button key={r} className="recent-item" onClick={() => openProject(r)} title={r}>
              <FileIcon name={basename(r)} dir />
              <span className="recent-name">{basename(r)}</span>
              <span className="recent-path">{r}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function useRevealActiveFile() {
  const path = useStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeId) ?? s.home;
    const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
    return tab?.kind === "file" ? tab.path : null;
  });
  useEffect(() => {
    if (path) revealInTree(path);
  }, [path]);
}

export function Explorer() {
  const ws = useActiveWorkspace();
  useRevealActiveFile();
  if (!ws.root) {
    return (
      <>
        <SideHeader title="Файли" />
        <NoProject />
      </>
    );
  }
  const root = ws.root;
  const rootEntry: Entry = { name: ws.name, path: root, dir: true, size: 0, modified: 0, dim: false };
  return (
    <>
      <SideHeader title={ws.name} sub={root}>
        <button className="icon-btn" title="Новий файл" onClick={() => newFileIn(currentDir(root))}>
          <FilePlus size={15} strokeWidth={1.6} />
        </button>
        <button className="icon-btn" title="Нова папка" onClick={() => newFolderIn(currentDir(root))}>
          <FolderPlus size={15} strokeWidth={1.6} />
        </button>
        <button className="icon-btn" title="Оновити" onClick={() => refreshExpanded()}>
          <RefreshCw size={14} strokeWidth={1.6} />
        </button>
        <button className="icon-btn" title="Згорнути все" onClick={collapseAll}>
          <ChevronsDownUp size={15} strokeWidth={1.6} />
        </button>
      </SideHeader>
      <div className="tree" onContextMenu={(e) => e.target === e.currentTarget && entryMenu(e, rootEntry)}>
        <TreeChildren dir={root} depth={0} />
      </div>
    </>
  );
}

function currentDir(root: string): string {
  const path = currentFilePath();
  if (path && path.toLowerCase().startsWith(root.toLowerCase())) return path.replace(/[\\/][^\\/]+$/, "");
  return root;
}
