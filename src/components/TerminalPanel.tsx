import { useEffect, useRef } from "react";
import { Plus, ChevronDown, Columns2, Trash2, Ellipsis, Maximize2, Minimize2, X, SquareTerminal, Sparkles, Play, RotateCcw } from "lucide-react";
import { get, openMenu, prompt, set, useStore, type MenuItem, type Pane, type TermTab, type Workspace } from "../store";
import {
  activatePane,
  activateTermTab,
  closePane,
  closeTermTab,
  newClaudeSession,
  newTerminal,
  renamePane,
  splitTerminal,
  togglePanel,
  defaultAccountFor,
} from "../actions";
import { clearPane, ensureInstance, fitPane, focusPane, isStarted, restartPane, startPane, terminalSurface } from "../terminals";
import { basename } from "../util";

function PaneView({ pane, tabId, visible, active, single }: { pane: Pane; tabId: string; visible: boolean; active: boolean; single: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const accounts = useStore((s) => s.accounts);
  useEffect(() => {
    const instance = ensureInstance(pane);
    ref.current!.appendChild(instance.host);
    const observer = new ResizeObserver(() => fitPane(pane.id));
    observer.observe(ref.current!);
    return () => observer.disconnect();
  }, [pane.id]);
  const waiting = pane.restored && pane.kind === "claude";
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      fitPane(pane.id);
      if (!waiting && !isStarted(pane.id)) startPane(pane);
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, waiting, pane.id]);
  useEffect(() => {
    if (visible && active) focusPane(pane.id);
  }, [visible, active, pane.id]);
  const account = accounts.find((a) => a.id === (pane.accountId ?? "main"));
  return (
    <div className={`pane${active && !single ? " active" : ""}`} onMouseDown={() => activatePane(tabId, pane.id)}>
      {!single && (
        <div className="pane-strip">
          {pane.kind === "claude" ? <Sparkles size={11} className="accent" /> : <SquareTerminal size={11} />}
          <span className="ellipsis">{pane.title}</span>
          <button
            className="icon-btn tiny"
            onClick={(e) => {
              e.stopPropagation();
              closePane(pane.id);
            }}
          >
            <X size={11} />
          </button>
        </div>
      )}
      <div ref={ref} className="pane-term" />
      {waiting && (
        <div className="pane-overlay">
          <div className="resume-card">
            <Sparkles size={18} className="accent" />
            <div className="resume-title">Сесія Claude збережена</div>
            <div className="resume-sub">
              {account ? `${account.label} · ` : ""}
              {basename(pane.cwd)}
            </div>
            <button className="btn primary" onClick={() => startPane(pane)}>
              <Play size={13} /> Продовжити сесію
            </button>
            <button className="link-btn" onClick={() => closePane(pane.id)}>
              Закрити
            </button>
          </div>
        </div>
      )}
      {pane.exited && (
        <div className="pane-exit">
          <span>Процес завершився</span>
          <button className="btn small" onClick={() => restartPane(pane)}>
            <RotateCcw size={12} /> Перезапустити
          </button>
          <button className="btn small" onClick={() => closePane(pane.id)}>
            Закрити
          </button>
        </div>
      )}
    </div>
  );
}

function TabBody({ tab, visible }: { tab: TermTab; visible: boolean }) {
  return (
    <div className="term-tab-body" style={{ display: visible ? "flex" : "none" }}>
      {tab.panes.map((pane, index) => (
        <div key={pane.id} className="pane-wrap" style={{ borderLeft: index > 0 ? "1px solid var(--line)" : "none" }}>
          <PaneView pane={pane} tabId={tab.id} visible={visible} active={tab.activePaneId === pane.id} single={tab.panes.length === 1} />
        </div>
      ))}
    </div>
  );
}

function WorkspaceTerminals({ ws, visible }: { ws: Workspace; visible: boolean }) {
  return (
    <>
      {ws.termTabs.map((tab) => (
        <TabBody key={tab.id} tab={tab} visible={visible && tab.id === ws.activeTermTabId} />
      ))}
    </>
  );
}

export function TerminalPanel() {
  const visible = useStore((s) => s.panelVisible);
  const height = useStore((s) => s.panelHeight);
  const maximized = useStore((s) => s.panelMaximized);
  const home = useStore((s) => s.home);
  const workspaces = useStore((s) => s.workspaces);
  const activeId = useStore((s) => s.activeId);
  const settings = useStore((s) => s.settings);
  const imageUrl = useStore((s) => s.terminalImageUrl);
  const shells = useStore((s) => s.info?.shells ?? []);
  const accounts = useStore((s) => s.accounts);
  const ws = workspaces.find((w) => w.id === activeId) ?? home;
  const activeTab = ws.termTabs.find((t) => t.id === ws.activeTermTabId);
  const activePane = activeTab?.panes.find((p) => p.id === activeTab.activePaneId);
  const defaultShell = shells.find((s) => s.id === settings.defaultShell) ?? shells[0];

  const shellMenu = (event: React.MouseEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = shells.map((s) => ({
      label: `${s.id === settings.defaultShell ? "● " : "   "}${s.name}`,
      action: () => {
        set((st) => ({ settings: { ...st.settings, defaultShell: s.id } }));
        newTerminal({ shellId: s.id });
      },
    }));
    items.push("separator");
    accounts.forEach((a) =>
      items.push({ label: `Claude · ${a.label}${a.email ? " · " + a.email : ""}`, action: () => newClaudeSession(a.id), disabled: !a.loggedIn }),
    );
    openMenu({ clientX: rect.left, clientY: rect.bottom + 4 }, items);
  };

  const moreMenu = (event: React.MouseEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (!activePane) return;
    openMenu({ clientX: rect.right - 210, clientY: rect.bottom + 4 }, [
      { label: "Очистити", action: () => clearPane(activePane.id) },
      {
        label: "Перейменувати…",
        action: async () => {
          const title = await prompt("Назва терміналу", activePane.title);
          if (title?.trim()) renamePane(activePane.id, title.trim());
        },
      },
      { label: "Перезапустити", action: () => restartPane(activePane) },
      "separator",
      { label: "Закрити всі термінали проекту", danger: true, action: () => get().workspaces.concat(get().home).find((w) => w.id === ws.id)?.termTabs.forEach((t) => closeTermTab(t.id)) },
    ]);
  };

  return (
    <section
      className={`panel${maximized ? " maximized" : ""}`}
      style={{ height: maximized ? undefined : height, display: visible ? "flex" : "none" }}
    >
      <div className="panel-head">
        <div className="term-tabs">
          {ws.termTabs.map((tab) => {
            const lead = tab.panes.find((p) => p.id === tab.activePaneId) ?? tab.panes[0];
            const account = lead.kind === "claude" ? accounts.find((a) => a.id === (lead.accountId ?? "main")) : null;
            return (
              <div
                key={tab.id}
                className={`term-tab${tab.id === ws.activeTermTabId ? " active" : ""}${lead.exited ? " exited" : ""}`}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    closeTermTab(tab.id);
                  } else activateTermTab(tab.id);
                }}
                onDoubleClick={async () => {
                  const title = await prompt("Назва терміналу", lead.title);
                  if (title?.trim()) renamePane(lead.id, title.trim());
                }}
                title={`${lead.title} — ${lead.cwd}`}
              >
                {lead.kind === "claude" ? (
                  <Sparkles size={13} className="accent" />
                ) : (
                  <SquareTerminal size={13} strokeWidth={1.7} />
                )}
                <span className="term-tab-title">{lead.title}</span>
                {account && accounts.length > 1 && <span className="dot" style={{ background: account.color }} />}
                {tab.panes.length > 1 && <span className="term-tab-count">{tab.panes.length}</span>}
                <button
                  className="term-tab-close"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTermTab(tab.id);
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="panel-tools">
          <button className="shell-pick" onClick={shellMenu} title="Вибрати оболонку">
            <SquareTerminal size={13} strokeWidth={1.7} />
            <span>{defaultShell?.name.toLowerCase() ?? "shell"}</span>
            <ChevronDown size={12} />
          </button>
          <button className="icon-btn" title="Новий термінал (Ctrl Shift `)" onClick={() => newTerminal()}>
            <Plus size={15} />
          </button>
          <button className="icon-btn claude-btn" title={`Нова сесія Claude (Ctrl Shift L)`} onClick={() => newClaudeSession(defaultAccountFor(ws))}>
            <Sparkles size={14} />
          </button>
          <button className="icon-btn" title="Розділити" onClick={splitTerminal}>
            <Columns2 size={14} />
          </button>
          <button className="icon-btn" title="Закрити термінал" onClick={() => activePane && closePane(activePane.id)} disabled={!activePane}>
            <Trash2 size={14} />
          </button>
          <button className="icon-btn" title="Ще" onClick={moreMenu} disabled={!activePane}>
            <Ellipsis size={15} />
          </button>
          <span className="tool-sep" />
          <button className="icon-btn" title={maximized ? "Зменшити" : "Розгорнути"} onClick={() => set({ panelMaximized: !maximized })}>
            {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button className="icon-btn" title="Сховати (Ctrl `)" onClick={togglePanel}>
            <X size={15} />
          </button>
        </div>
      </div>
      <div className="panel-body" style={{ background: terminalSurface(settings) }}>
        {imageUrl && (
          <div
            className="term-bg"
            style={{ backgroundImage: `url(${imageUrl})`, opacity: settings.terminalImageOpacity, filter: settings.terminalBlur ? `blur(${settings.terminalBlur}px)` : undefined }}
          />
        )}
        {[home, ...workspaces].map((w) => (
          <WorkspaceTerminals key={w.id} ws={w} visible={visible && w.id === ws.id} />
        ))}
        {ws.termTabs.length === 0 && (
          <div className="panel-empty">
            <button className="btn" onClick={() => newTerminal()}>
              <SquareTerminal size={14} /> Новий термінал
            </button>
            <button className="btn primary" onClick={() => newClaudeSession(defaultAccountFor(ws))}>
              <Sparkles size={14} /> Нова сесія Claude
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
