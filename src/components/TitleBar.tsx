import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { House, Minus, Plus, Search, Square, Copy, X, ChevronDown, FolderOpen, FolderPlus, History, Palette } from "lucide-react";
import { ThemePopover } from "./ThemePicker";
import { themeById } from "../themes";
import { api } from "../ipc";
import { activeWorkspace, openMenu, set, useActiveWorkspace, useStore, type MenuItem, type Workspace } from "../store";
import { accountMenuItems, closeProject, copyText, focusedAccountId, globalAccountId, openFolderDialog, openProject, setActivity, switchProject } from "../actions";
import { basename } from "../util";

function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setMaximized);
    const off = win.onResized(() => win.isMaximized().then(setMaximized));
    return () => {
      off.then((f) => f());
    };
  }, []);
  const win = getCurrentWindow();
  return (
    <div className="window-controls">
      <button onClick={() => win.minimize()} title="Згорнути">
        <Minus size={15} strokeWidth={1.5} />
      </button>
      <button onClick={() => win.toggleMaximize()} title={maximized ? "Відновити" : "Розгорнути"}>
        {maximized ? <Copy size={12} strokeWidth={1.6} style={{ transform: "scaleX(-1)" }} /> : <Square size={12} strokeWidth={1.6} />}
      </button>
      <button className="close" onClick={() => win.close()} title="Закрити">
        <X size={16} strokeWidth={1.5} />
      </button>
    </div>
  );
}

function menuUnder(event: React.MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return { clientX: rect.left, clientY: rect.bottom + 4 };
}

function useTabAccount(ws: Workspace) {
  const accounts = useStore((s) => s.accounts);
  useStore((s) => s.settings.defaultAccountId);
  const focused = focusedAccountId(ws);
  const account = accounts.find((a) => a.id === (focused ?? globalAccountId())) ?? accounts[0];
  return { account, focused, many: accounts.length > 1 };
}

function TabSubscription({ ws }: { ws: Workspace }) {
  const { account, focused, many } = useTabAccount(ws);
  if (!account || (!many && !focused)) return null;
  return (
    <button
      className={`ptab-sub${focused ? "" : " inherit"}`}
      style={{ "--sub": account.color } as React.CSSProperties}
      title={focused ? `Підписка вкладки: ${account.label}` : `Підписка за замовчуванням: ${account.label}. Клікни, щоб закріпити іншу`}
      onClick={(event) => {
        event.stopPropagation();
        openMenu(menuUnder(event), accountMenuItems(ws));
      }}
    >
      {account.label.slice(0, 1).toUpperCase()}
    </button>
  );
}

function AccountChip() {
  const ws = useActiveWorkspace();
  const { account, focused } = useTabAccount(ws);
  if (!account) return null;
  const session = account.usage?.limits.find((l) => l.kind === "session" || l.kind === "five_hour");
  const onClick = (event: React.MouseEvent) => openMenu(menuUnder(event), accountMenuItems(ws));
  const title = ws.root ? `Підписка вкладки «${ws.name}»${focused ? "" : " (за замовчуванням)"}` : "Підписка за замовчуванням";
  return (
    <button className="account-chip" onClick={onClick} title={title}>
      <span className="avatar" style={{ background: account.color }}>
        {account.label.slice(0, 1).toUpperCase()}
      </span>
      <span className="label">{account.label}</span>
      {account.plan && <span className="plan">{account.plan}</span>}
      {session && (
        <span className="mini-meter" title={`${session.label}: ${Math.round(session.percent)}%`}>
          <i style={{ width: `${Math.min(100, session.percent)}%` }} />
        </span>
      )}
      <ChevronDown size={12} className="muted" />
    </button>
  );
}

export function TitleBar() {
  const workspaces = useStore((s) => s.workspaces);
  const activeId = useStore((s) => s.activeId);
  const recent = useStore((s) => s.recent);
  const dirty = useStore((s) => s.dirty);
  const ws = useActiveWorkspace();
  const [themeOpen, setThemeOpen] = useState(false);

  useEffect(() => {
    document.querySelector(".project-tabs .ptab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, workspaces.length]);

  const projectMenu = (event: React.MouseEvent, id: string) => {
    const target = workspaces.find((w) => w.id === id);
    if (!target?.root) return;
    const at = { clientX: event.clientX, clientY: event.clientY };
    openMenu(event, [
      { label: "Підписка для вкладки…", action: () => openMenu(at, accountMenuItems(target)) },
      "separator",
      { label: "Закрити проект", action: () => closeProject(id) },
      { label: "Закрити інші", action: () => workspaces.filter((w) => w.id !== id).forEach((w) => closeProject(w.id)) },
      "separator",
      { label: "Показати в Провіднику", action: () => api.reveal(target.root!) },
      { label: "Копіювати шлях", action: () => copyText(target.root!) },
    ]);
  };

  const addMenu = (event: React.MouseEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = [
      { label: "Відкрити папку…", shortcut: "Ctrl O", action: openFolderDialog },
      { label: "Новий проект зі структурою…", action: () => window.dispatchEvent(new CustomEvent("mavix:new-project")) },
    ];
    const recents = recent.filter((r) => !workspaces.some((w) => w.root?.toLowerCase() === r.toLowerCase())).slice(0, 8);
    if (recents.length) {
      items.push("separator");
      recents.forEach((r) => items.push({ label: `${basename(r)}  —  ${r}`, action: () => openProject(r) }));
    }
    openMenu({ clientX: rect.left, clientY: rect.bottom + 4 }, items);
  };

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <span className="brand-mark">M</span>
      </div>
      <div className="project-tabs">
        <button className={`ptab home${activeId === null ? " active" : ""}`} onClick={() => switchProject(null)} title="Головна (Alt 0)">
          <House size={14} strokeWidth={1.7} />
        </button>
        {workspaces.map((w, index) => {
          const hasDirty = w.root ? Object.keys(dirty).some((p) => p.toLowerCase().startsWith(w.root!.toLowerCase())) : false;
          return (
            <div
              key={w.id}
              className={`ptab${w.id === activeId ? " active" : ""}`}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeProject(w.id);
                }
              }}
              onClick={() => switchProject(w.id)}
              onContextMenu={(e) => projectMenu(e, w.id)}
              title={`${w.root}${index < 9 ? `  (Alt ${index + 1})` : ""}`}
            >
              <span className="ptab-dot" style={{ background: w.themeId ? themeById(w.themeId).swatches[3] : w.color }} />
              <span className="ptab-name">{w.name}</span>
              {hasDirty && <span className="ptab-dirty" />}
              <TabSubscription ws={w} />
              <button
                className="ptab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeProject(w.id);
                }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
        <button className="ptab-add" onClick={addMenu} title="Відкрити проект">
          <Plus size={14} />
        </button>
      </div>
      <div className="drag-fill" data-tauri-drag-region />
      <button className="command-center" onClick={() => set({ palette: { mode: "files", query: "" } })}>
        <Search size={13} />
        <span className="cc-text">{activeWorkspace().root ? `Пошук у ${ws.name}` : "Пошук файлів і команд"}</span>
        <kbd>Ctrl P</kbd>
      </button>
      <div className="drag-fill" data-tauri-drag-region />
      <div className="title-actions">
        <button className={`icon-btn${themeOpen ? " on" : ""}`} title="Кольорова гамма" onClick={() => setThemeOpen(!themeOpen)}>
          <Palette size={15} strokeWidth={1.6} />
        </button>
        {themeOpen && <ThemePopover onClose={() => setThemeOpen(false)} />}
        <button className="icon-btn" title="Відкрити папку (Ctrl O)" onClick={openFolderDialog}>
          <FolderOpen size={15} strokeWidth={1.6} />
        </button>
        <button className="icon-btn" title="Новий проект зі структурою" onClick={() => window.dispatchEvent(new CustomEvent("mavix:new-project"))}>
          <FolderPlus size={15} strokeWidth={1.6} />
        </button>
        <button className="icon-btn" title="Сесії Claude" onClick={() => setActivity("claude")}>
          <History size={15} strokeWidth={1.6} />
        </button>
      </div>
      <AccountChip />
      <WindowControls />
    </div>
  );
}
