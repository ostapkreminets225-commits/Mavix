import { useEffect, useRef, useState } from "react";
import { ChevronDown, FolderOpen, LayoutGrid, MessageSquarePlus, Minus, Plus, X } from "lucide-react";
import { openMenu, useStore, type MenuItem, type Workspace } from "../store";
import { themeById } from "../themes";
import { connectAccount, focusedAccountId, globalAccountId } from "../actions";
import { basename, samePath } from "../util";
import {
  MAX_PANES,
  MIN_PANES,
  QUICK_COUNTS,
  assignPane,
  assignPaneFolder,
  assignPaneRoot,
  attachChat,
  chatsIn,
  clampCount,
  clearPane,
  closeMulti,
  closePicker,
  findChatTab,
  gridRows,
  lastCount,
  projectWorkspaces,
  setPaneCount,
  setPaneProjectAccount,
  startMulti,
  tabsInPanes,
  useMulti,
  windowsWord,
  type MultiPane,
} from "../multi";
import { ChatView } from "./editor/ChatView";
import { ClaudeIcon } from "./ClaudeIcon";

function projectColor(ws: Workspace): string {
  return ws.themeId ? themeById(ws.themeId).swatches[3] : ws.color;
}

function LayoutGlyph({ count }: { count: number }) {
  return (
    <span className="multi-glyph">
      {gridRows(count).map((inRow, row) => (
        <span key={row} className="multi-glyph-row">
          {Array.from({ length: inRow }, (_, i) => (
            <i key={i} />
          ))}
        </span>
      ))}
    </span>
  );
}

function paneMenuItems(pane: MultiPane, number: number): MenuItem[] {
  const state = useStore.getState();
  const items: MenuItem[] = projectWorkspaces(state).map((w) => ({
    label: `${w.name}  —  ${w.root}`,
    shortcut: w.id === pane.workspaceId ? "✓" : undefined,
    action: () => assignPane(pane.id, w.id),
  }));
  const recents = state.recent.filter((r) => !state.workspaces.some((w) => samePath(w.root, r))).slice(0, 6);
  if (recents.length) {
    items.push("separator");
    recents.forEach((r) => items.push({ label: `${basename(r)}  —  ${r}`, action: () => assignPaneRoot(pane.id, r) }));
  }
  items.push("separator", { label: "Відкрити папку…", action: () => assignPaneFolder(pane.id) });
  if (pane.workspaceId) {
    const busy = tabsInPanes();
    const others = chatsIn(pane.workspaceId, state).filter((t) => t.id !== pane.tabId && !busy.has(t.id));
    items.push("separator", { label: "Новий чат у цьому проекті", action: () => assignPane(pane.id, pane.workspaceId!) });
    others.slice(0, 8).forEach((t) => items.push({ label: `Чат: ${t.title}`, action: () => attachChat(pane.id, pane.workspaceId!, t.id) }));
  }
  const ws = state.workspaces.find((w) => w.id === pane.workspaceId);
  if (ws?.root) items.push("separator", ...subscriptionItems(pane, ws));
  if (pane.tabId) items.push("separator", { label: `Звільнити вікно ${number}`, action: () => clearPane(pane.id) });
  return items;
}

function subscriptionItems(pane: MultiPane, ws: Workspace): MenuItem[] {
  const { accounts } = useStore.getState();
  const focused = focusedAccountId(ws);
  const global = accounts.find((a) => a.id === globalAccountId());
  const mark = (on: boolean, label: string) => `${on ? "●" : "  "}  ${label}`;
  const items: MenuItem[] = [
    { label: `Підписка Claude для «${ws.name}»`, disabled: true, action: () => {} },
    { label: mark(!focused, `За замовчуванням${global ? ` · ${global.label}` : ""}`), action: () => setPaneProjectAccount(pane.id, null) },
  ];
  for (const a of accounts) {
    items.push({
      label: mark(a.id === focused, `${a.label}${a.email ? ` · ${a.email}` : a.loggedIn ? "" : " · вхід не виконано"}`),
      action: () => setPaneProjectAccount(pane.id, a.id),
    });
  }
  items.push({ label: "Підключити ще одну підписку…", action: () => connectAccount() });
  return items;
}

function ProjectSlot({ pane, number }: { pane: MultiPane; number: number }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === pane.workspaceId) ?? null);
  const open = (event: React.MouseEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu({ clientX: rect.left, clientY: rect.bottom + 4 }, paneMenuItems(pane, number));
  };
  return (
    <button className="multi-project" onClick={open} title={`Вікно ${number} (Alt ${number}) · ${ws?.root ?? "проект не вибрано"}. Натисни, щоб змінити проект`}>
      <span className="multi-num">{number}</span>
      {ws && <span className="dot" style={{ background: projectColor(ws) }} />}
      <span className="multi-project-name">{ws?.name ?? "Проект"}</span>
      <ChevronDown size={11} />
    </button>
  );
}

function AccountTag({ ws }: { ws: Workspace }) {
  const accounts = useStore((s) => s.accounts);
  useStore((s) => s.settings.defaultAccountId);
  if (accounts.length < 2) return null;
  const focused = focusedAccountId(ws);
  const account = accounts.find((a) => a.id === (focused ?? globalAccountId()));
  if (!account) return null;
  return (
    <span className={`multi-pick-acc${focused ? " pinned" : ""}`} title={focused ? "Підписка закріплена за проектом" : "Підписка за замовчуванням"}>
      <span className="dot" style={{ background: account.color }} />
      {account.label}
    </span>
  );
}

function PanePicker({ pane, number }: { pane: MultiPane; number: number }) {
  const workspaces = useStore((s) => s.workspaces);
  const recent = useStore((s) => s.recent);
  const projects = workspaces.filter((w) => !!w.root);
  const recents = recent.filter((r) => !workspaces.some((w) => samePath(w.root, r))).slice(0, 6);
  return (
    <div className="multi-empty">
      <div className="multi-pick">
        <div className="multi-pick-head">
          <span className="multi-num big">{number}</span>
          <div>
            <div className="multi-pick-title">Вікно {number}</div>
            <div className="multi-pick-sub">Обери проект, і Claude працюватиме в ньому</div>
          </div>
        </div>
        <div className="multi-pick-list">
          {projects.map((w) => (
            <button key={w.id} className={`multi-pick-item${w.id === pane.workspaceId ? " last" : ""}`} onClick={() => assignPane(pane.id, w.id)} title={w.root ?? ""}>
              <span className="dot" style={{ background: projectColor(w) }} />
              <span className="multi-pick-name">{w.name}</span>
              <span className="multi-pick-path">{w.root}</span>
              <AccountTag ws={w} />
            </button>
          ))}
          {recents.length > 0 && <div className="multi-pick-label">Недавні</div>}
          {recents.map((r) => (
            <button key={r} className="multi-pick-item" onClick={() => assignPaneRoot(pane.id, r)} title={r}>
              <span className="dot hollow" />
              <span className="multi-pick-name">{basename(r)}</span>
              <span className="multi-pick-path">{r}</span>
            </button>
          ))}
          {projects.length === 0 && recents.length === 0 && <div className="multi-pick-none">Відкритих проектів ще немає</div>}
        </div>
        <button className="btn small" onClick={() => assignPaneFolder(pane.id)}>
          <FolderOpen size={13} />
          Відкрити папку…
        </button>
      </div>
    </div>
  );
}

function PaneView({ pane, number }: { pane: MultiPane; number: number }) {
  const tab = useStore((s) => findChatTab(s, pane.tabId));
  return (
    <div className="multi-pane" data-pane={number}>
      {tab ? (
        <ChatView key={tab.id} tab={tab} paneSlot={<ProjectSlot pane={pane} number={number} />} onNewChat={() => pane.workspaceId && assignPane(pane.id, pane.workspaceId)} />
      ) : (
        <PanePicker pane={pane} number={number} />
      )}
    </div>
  );
}

function MultiBar() {
  const count = useMulti((s) => s.panes.length);
  return (
    <div className="multi-bar">
      <LayoutGrid size={14} className="accent" />
      <span className="multi-bar-title">Мульти-режим</span>
      <div className="multi-stepper">
        <button className="icon-btn" title="Менше вікон" disabled={count <= MIN_PANES} onClick={() => setPaneCount(count - 1)}>
          <Minus size={13} />
        </button>
        <span className="multi-count">
          {count} {windowsWord(count)}
        </span>
        <button className="icon-btn" title="Більше вікон" disabled={count >= MAX_PANES} onClick={() => setPaneCount(count + 1)}>
          <Plus size={13} />
        </button>
      </div>
      <div className="grow" />
      <span className="multi-hint">
        <kbd className="kbd">Alt 1–9</kbd> вікно
      </span>
      <span className="multi-hint">
        <kbd className="kbd">Ctrl M</kbd> вийти
      </span>
      <button className="icon-btn" title="Вийти з мульти-режиму (Ctrl M)" onClick={closeMulti}>
        <X size={14} />
      </button>
    </div>
  );
}

export function MultiView() {
  const panes = useMulti((s) => s.panes);
  const rows = gridRows(panes.length);
  let offset = 0;
  return (
    <div className="multi">
      <MultiBar />
      <div className="multi-grid">
        {rows.map((inRow, row) => {
          const slice = panes.slice(offset, offset + inRow);
          const start = offset;
          offset += inRow;
          return (
            <div key={row} className="multi-row">
              {slice.map((pane, i) => (
                <PaneView key={pane.id} pane={pane} number={start + i + 1} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MultiPicker() {
  const picking = useMulti((s) => s.picking);
  const [value, setValue] = useState(String(lastCount()));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!picking) return;
    setValue(String(lastCount()));
    requestAnimationFrame(() => input.current?.select());
  }, [picking]);
  if (!picking) return null;
  const typed = clampCount(Number(value));
  return (
    <div className="modal-backdrop" onMouseDown={closePicker}>
      <div
        className="modal multi-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") closePicker();
          if (e.key === "Enter") {
            e.preventDefault();
            startMulti(typed);
          }
        }}
      >
        <div className="modal-head">
          <ClaudeIcon size={16} />
          <div className="modal-title">Мульти-режим</div>
        </div>
        <div className="modal-message">Mavix поділиться на рівні вікна. У кожному вибереш проект кнопкою, і Claude працюватиме там окремо.</div>
        <div className="multi-quick">
          {QUICK_COUNTS.map((n) => (
            <button key={n} className={`multi-quick-item${n === typed ? " on" : ""}`} onClick={() => startMulti(n)} title={`${n} ${windowsWord(n)}`}>
              <LayoutGlyph count={n} />
              <span>{n}</span>
            </button>
          ))}
        </div>
        <div className="multi-custom">
          <span>Скільки вікон</span>
          <input
            ref={input}
            className="input"
            type="number"
            min={MIN_PANES}
            max={MAX_PANES}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <span className="muted">
            {MIN_PANES}–{MAX_PANES}
          </span>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={closePicker}>
            Скасувати
          </button>
          <button className="btn primary" onClick={() => startMulti(typed)}>
            <MessageSquarePlus size={14} />
            Відкрити {typed} {windowsWord(typed)}
          </button>
        </div>
      </div>
    </div>
  );
}
