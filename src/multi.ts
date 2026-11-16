import { create } from "zustand";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { allWorkspaces, get, set, toast, useStore, type State, type Tab, type Workspace } from "./store";
import { chatTitleFrom, defaultAccountFor, focusProjectAccount, openProject, openTab, updateChatTab } from "./actions";
import { getChat, switchChatAccount } from "./chat";
import { errorText } from "./ipc";
import { uid, uuid } from "./util";

type ChatTab = Extract<Tab, { kind: "chat" }>;

export type MultiPane = { id: string; workspaceId: string | null; tabId: string | null };

type MultiState = { open: boolean; picking: boolean; panes: MultiPane[] };

export const MIN_PANES = 1;
export const MAX_PANES = 12;
export const QUICK_COUNTS = [2, 3, 4, 6, 8, 9];
export const DEFAULT_COUNT = 4;
const STORAGE_KEY = "mavix.multi";

function validPane(value: unknown): value is MultiPane {
  const pane = value as MultiPane;
  return !!pane && typeof pane.id === "string" && (pane.workspaceId === null || typeof pane.workspaceId === "string") && (pane.tabId === null || typeof pane.tabId === "string");
}

function loadSaved(): MultiState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as { open?: boolean; panes?: unknown[] };
      const panes = Array.isArray(data.panes) ? data.panes.filter(validPane).slice(0, MAX_PANES) : [];
      return { open: !!data.open && panes.length > 0, picking: false, panes };
    }
  } catch {
    return { open: false, picking: false, panes: [] };
  }
  return { open: false, picking: false, panes: [] };
}

export const useMulti = create<MultiState>(loadSaved);

useMulti.subscribe((state) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: state.open, panes: state.panes }));
  } catch {
    return;
  }
});

export function clampCount(count: number): number {
  if (!Number.isFinite(count)) return DEFAULT_COUNT;
  return Math.max(MIN_PANES, Math.min(MAX_PANES, Math.round(count)));
}

export function windowsWord(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return "вікон";
  if (ones === 1) return "вікно";
  if (ones >= 2 && ones <= 4) return "вікна";
  return "вікон";
}

export function gridRows(count: number): number[] {
  const rowCount = count <= 3 ? 1 : count === 9 || count > 10 ? 3 : 2;
  const rows: number[] = [];
  let left = count;
  for (let remaining = rowCount; remaining > 0; remaining--) {
    const inRow = Math.ceil(left / remaining);
    rows.push(inRow);
    left -= inRow;
  }
  return rows;
}

function resized(panes: MultiPane[], count: number): MultiPane[] {
  const list = [...panes];
  for (let i = list.length - 1; i >= 0 && list.length > count; i--) {
    if (!list[i].tabId) list.splice(i, 1);
  }
  const kept = list.slice(0, count);
  while (kept.length < count) kept.push({ id: uid("mp"), workspaceId: null, tabId: null });
  return kept;
}

export function lastCount(): number {
  const count = useMulti.getState().panes.length;
  return count > 0 ? count : DEFAULT_COUNT;
}

export function toggleMulti() {
  const state = useMulti.getState();
  if (state.open) closeMulti();
  else useMulti.setState({ picking: !state.picking });
}

export function closePicker() {
  useMulti.setState({ picking: false });
}

export function closeMulti() {
  useMulti.setState({ open: false, picking: false });
}

export function startMulti(count: number) {
  const total = clampCount(count);
  useMulti.setState((s) => ({ open: true, picking: false, panes: resized(s.panes, total) }));
}

export function setPaneCount(count: number) {
  const total = clampCount(count);
  useMulti.setState((s) => ({ panes: resized(s.panes, total) }));
}

function patchPane(paneId: string, fields: Partial<Omit<MultiPane, "id">>) {
  useMulti.setState((s) => ({ panes: s.panes.map((p) => (p.id === paneId ? { ...p, ...fields } : p)) }));
}

export function findChatTab(state: State, tabId: string | null): ChatTab | null {
  if (!tabId) return null;
  for (const ws of allWorkspaces(state)) {
    const tab = ws.tabs.find((t) => t.id === tabId);
    if (tab) return tab.kind === "chat" ? tab : null;
  }
  return null;
}

export function projectWorkspaces(state: State = get()): Workspace[] {
  return state.workspaces.filter((w) => !!w.root);
}

export function chatsIn(workspaceId: string, state: State = get()): ChatTab[] {
  const ws = allWorkspaces(state).find((w) => w.id === workspaceId);
  return ws ? ws.tabs.filter((t): t is ChatTab => t.kind === "chat") : [];
}

export function tabsInPanes(): Set<string> {
  return new Set(useMulti.getState().panes.flatMap((p) => (p.tabId ? [p.tabId] : [])));
}

let quiet = 0;

function createChatTab(ws: Workspace): string {
  const tab: ChatTab = {
    kind: "chat",
    id: uid("chat"),
    title: chatTitleFrom(""),
    sessionId: uuid(),
    accountId: defaultAccountFor(ws),
    cwd: ws.root ?? get().info?.home ?? "C:\\",
    model: null,
    effort: null,
    mode: null,
  };
  quiet++;
  try {
    openTab(tab, ws.id);
  } finally {
    quiet--;
  }
  return tab.id;
}

export function assignPane(paneId: string, workspaceId: string) {
  const ws = allWorkspaces().find((w) => w.id === workspaceId);
  if (!ws) return;
  patchPane(paneId, { workspaceId, tabId: createChatTab(ws) });
}

export function attachChat(paneId: string, workspaceId: string, tabId: string) {
  patchPane(paneId, { workspaceId, tabId });
}

export function clearPane(paneId: string) {
  patchPane(paneId, { tabId: null });
}

export async function assignPaneRoot(paneId: string, root: string) {
  const previous = get().activeId;
  quiet++;
  try {
    const ws = await openProject(root);
    set({ activeId: previous });
    if (ws) assignPane(paneId, ws.id);
  } finally {
    quiet--;
  }
}

export async function assignPaneFolder(paneId: string) {
  const picked = await openDialog({ directory: true, multiple: false, title: "Проект для цього вікна" });
  if (typeof picked === "string") await assignPaneRoot(paneId, picked);
}

export async function setPaneProjectAccount(paneId: string, accountId: string | null) {
  const pane = useMulti.getState().panes.find((p) => p.id === paneId);
  const ws = pane && get().workspaces.find((w) => w.id === pane.workspaceId);
  if (!pane || !ws?.root) return;
  focusProjectAccount(ws.root, accountId);
  const target = defaultAccountFor(get().workspaces.find((w) => w.id === ws.id) ?? ws);
  const tab = findChatTab(get(), pane.tabId);
  const chat = tab ? getChat(tab.id) : undefined;
  if (!tab || !chat || chat.accountId === target) return;
  if (chat.busy) {
    toast("Claude у цьому вікні ще працює. Нова підписка буде в наступному чаті цього проекту");
    return;
  }
  const account = get().accounts.find((a) => a.id === target);
  try {
    await switchChatAccount(tab.id, target, account?.label ?? target);
    updateChatTab(tab.id, { accountId: target });
  } catch (error) {
    toast(errorText(error), "error");
  }
}

export function focusPane(number: number) {
  const pane = document.querySelector<HTMLElement>(`.multi-pane[data-pane="${number}"]`);
  if (!pane) return;
  const target = pane.querySelector<HTMLElement>(".composer-input") ?? pane.querySelector<HTMLElement>("button");
  target?.focus();
}

function revealsOtherView(state: State, previous: State): boolean {
  if (state.activeId !== previous.activeId) return true;
  if (state.panelVisible && !previous.panelVisible) return true;
  const before = new Map(allWorkspaces(previous).map((w) => [w.id, w]));
  for (const ws of allWorkspaces(state)) {
    const old = before.get(ws.id);
    if (!old) continue;
    if (ws.termTabs.length > old.termTabs.length) return true;
    if (ws.activeTabId === old.activeTabId) continue;
    const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
    if (tab && tab.kind !== "chat") return true;
  }
  return false;
}

useStore.subscribe((state, previous) => {
  if (quiet > 0 || !previous.ready || !useMulti.getState().open) return;
  if (state.workspaces === previous.workspaces && state.home === previous.home && state.activeId === previous.activeId && state.panelVisible === previous.panelVisible) return;
  if (revealsOtherView(state, previous)) closeMulti();
});
