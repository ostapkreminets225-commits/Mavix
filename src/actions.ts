import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, errorText, type Account, type BulkSkillsResult, type Rule, type SessionInfo, type Skill, type SkillDraft, type SlackChat, type Template } from "./ipc";
import {
  activeWorkspace,
  allWorkspaces,
  ask,
  confirm,
  emptyWorkspace,
  get,
  prompt,
  set,
  toast,
  updateWorkspace,
  useStore,
  type Activity,
  type MenuItem,
  type Pane,
  type Tab,
  type TermTab,
  type Workspace,
} from "./store";
import { closeDoc, getDoc, loadDoc, renameDoc, revealLine, saveDoc } from "./docs";
import { disposePane, focusPane, updatePane } from "./terminals";
import { chatHooks, getChat, stopChat } from "./chat";
import { PROJECT_COLORS, badFileName, basename, dirname, isInside, joinPath, pathKey, samePath, uid, uuid } from "./util";

type ChatTab = Extract<Tab, { kind: "chat" }>;

const NEW_CHAT_TITLE = "Новий чат";

function chatTabs(): { ws: Workspace; tab: ChatTab }[] {
  return allWorkspaces().flatMap((ws) => ws.tabs.filter((t): t is ChatTab => t.kind === "chat").map((tab) => ({ ws, tab })));
}

export function updateChatTab(tabId: string, fields: Partial<Omit<ChatTab, "kind" | "id">>) {
  const patch = (w: Workspace): Workspace =>
    w.tabs.some((t) => t.id === tabId) ? { ...w, tabs: w.tabs.map((t) => (t.id === tabId && t.kind === "chat" ? { ...t, ...fields } : t)) } : w;
  set((s) => ({ home: patch(s.home), workspaces: s.workspaces.map(patch) }));
}

export function chatTitleFrom(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > 48 ? `${single.slice(0, 47)}…` : single || NEW_CHAT_TITLE;
}

export function isUntitledChat(title: string): boolean {
  return title === NEW_CHAT_TITLE;
}

chatHooks.sessionChanged = (key, sessionId) => updateChatTab(key, { sessionId });

chatHooks.turnDone = (key) => {
  const entry = chatTabs().find((x) => x.tab.id === key);
  if (!entry) return;
  const state = get();
  const visible = document.hasFocus() && activeWorkspace(state).id === entry.ws.id && entry.ws.activeTabId === key;
  if (!visible) toast(`Claude закінчив: ${entry.tab.title}`, "ok");
  refreshSessions().then(() => {
    const chat = getChat(key);
    const info = get().sessions.find((s) => s.id === (chat?.sessionId ?? entry.tab.sessionId));
    if (info?.title && info.title !== entry.tab.title && !info.title.startsWith("<")) updateChatTab(key, { title: info.title.slice(0, 60) });
  });
};

useStore.subscribe((state, previous) => {
  if (state.workspaces === previous.workspaces && state.home === previous.home) return;
  const changes: Record<string, string> = {};
  for (const ws of [state.home, ...state.workspaces]) {
    const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
    if (tab?.kind === "file" && state.recentFile[ws.id] !== tab.path) changes[ws.id] = tab.path;
  }
  if (Object.keys(changes).length) set({ recentFile: { ...state.recentFile, ...changes } });
});

export function setActivity(activity: Activity) {
  const state = get();
  if (state.activity === activity && state.sidebarVisible) set({ sidebarVisible: false });
  else set({ activity, sidebarVisible: true });
}

export function toggleSidebar() {
  set((s) => ({ sidebarVisible: !s.sidebarVisible }));
}

export function togglePanel() {
  const state = get();
  if (!state.panelVisible) {
    set({ panelVisible: true });
    const ws = activeWorkspace();
    if (ws.termTabs.length === 0) newTerminal();
    else focusActivePane();
  } else {
    set({ panelVisible: false, panelMaximized: false });
  }
}

export function focusActivePane() {
  const ws = activeWorkspace();
  const tab = ws.termTabs.find((t) => t.id === ws.activeTermTabId);
  if (tab) window.setTimeout(() => focusPane(tab.activePaneId), 30);
}

export function addRecent(root: string) {
  set((s) => ({ recent: [root, ...s.recent.filter((r) => !samePath(r, root))].slice(0, 14) }));
}

export async function openProject(root: string) {
  const existing = get().workspaces.find((w) => samePath(w.root, root));
  if (existing) {
    set({ activeId: existing.id });
    addRecent(root);
    return existing;
  }
  if (!(await api.exists(root))) {
    toast(`Папки не існує: ${root}`, "error");
    set((s) => ({ recent: s.recent.filter((r) => !samePath(r, root)) }));
    return null;
  }
  const color = PROJECT_COLORS[get().workspaces.length % PROJECT_COLORS.length];
  const ws = { ...emptyWorkspace(uid("ws"), root, basename(root), color), accountId: get().projectAccounts[pathKey(root)] ?? null };
  set((s) => ({ workspaces: [...s.workspaces, ws], activeId: ws.id, activity: s.activity }));
  addRecent(root);
  loadDir(root);
  api.gitBranch(root).then((branch) => set((s) => ({ branches: { ...s.branches, [ws.id]: branch } })));
  return ws;
}

export async function openFolderDialog() {
  const picked = await openDialog({ directory: true, multiple: false, title: "Відкрити папку проекту" });
  if (typeof picked === "string") await openProject(picked);
}

export async function closeProject(id: string) {
  const ws = get().workspaces.find((w) => w.id === id);
  if (!ws) return;
  const dirtyFiles = Object.keys(get().dirty).filter((p) => ws.root && isInside(ws.root, p));
  if (dirtyFiles.length > 0) {
    const ok = await confirm(`Закрити «${ws.name}»?`, `Незбережених файлів: ${dirtyFiles.length}. Зміни буде втрачено.`, true, "Закрити");
    if (!ok) return;
  }
  const running = ws.termTabs.reduce((n, t) => n + t.panes.length, 0);
  ws.termTabs.forEach((t) => t.panes.forEach((p) => disposePane(p.id)));
  ws.tabs.forEach((t) => t.kind === "file" && closeDoc(t.path));
  ws.tabs.forEach((t) => t.kind === "chat" && stopChat(t.id, true));
  set((s) => {
    const index = s.workspaces.findIndex((w) => w.id === id);
    const rest = s.workspaces.filter((w) => w.id !== id);
    const nextActive = s.activeId === id ? (rest[Math.max(0, index - 1)]?.id ?? null) : s.activeId;
    return { workspaces: rest, activeId: nextActive };
  });
  if (running > 0) toast(`Закрито терміналів: ${running}`);
}

export function switchProject(id: string | null) {
  set({ activeId: id });
}

export function cycleProject(direction: 1 | -1) {
  const state = get();
  const ids: (string | null)[] = [null, ...state.workspaces.map((w) => w.id)];
  const index = ids.indexOf(state.activeId);
  set({ activeId: ids[(index + direction + ids.length) % ids.length] });
}

function tabMatches(a: Tab, b: Tab): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "file":
      return samePath(a.path, (b as typeof a).path);
    case "session":
      return a.sessionId === (b as typeof a).sessionId;
    case "chat":
      return a.sessionId === (b as typeof a).sessionId;
    case "skill":
      return a.skillId === (b as typeof a).skillId;
    case "settings":
      return true;
    case "structure":
      return true;
    case "new-skill":
      return false;
  }
}

export function openTab(tab: Tab, workspaceId = activeWorkspace().id) {
  updateWorkspace(workspaceId, (w) => {
    const existing = w.tabs.find((t) => tabMatches(t, tab));
    if (existing) {
      const merged = { ...existing, ...tab, id: existing.id } as Tab;
      return { ...w, tabs: w.tabs.map((t) => (t.id === existing.id ? merged : t)), activeTabId: existing.id };
    }
    const index = w.tabs.findIndex((t) => t.id === w.activeTabId);
    const tabs = [...w.tabs];
    tabs.splice(index + 1, 0, tab);
    return { ...w, tabs, activeTabId: tab.id };
  });
}

export function workspaceFor(path: string): Workspace {
  const state = get();
  const current = activeWorkspace(state);
  if (current.root && isInside(current.root, path)) return current;
  return state.workspaces.find((w) => w.root && isInside(w.root, path)) ?? current;
}

export function openFile(path: string, line?: number) {
  if (line) revealLine.set(path.toLowerCase(), line);
  const ws = workspaceFor(path);
  if (ws.id !== get().activeId && ws.id !== "home") set({ activeId: ws.id });
  openTab({ kind: "file", id: uid("tab"), title: basename(path), path }, ws.id);
  loadDoc(path);
}

export async function closeTab(tabId: string, workspaceId = activeWorkspace().id) {
  const ws = allWorkspaces().find((w) => w.id === workspaceId);
  const tab = ws?.tabs.find((t) => t.id === tabId);
  if (!ws || !tab) return;
  if (tab.kind === "file" && get().dirty[tab.path]) {
    const answer = await ask({
      title: `Зберегти зміни у «${tab.title}»?`,
      message: "Якщо не зберегти, зміни буде втрачено.",
      choices: [
        { label: "Не зберігати", value: "discard" },
        { label: "Зберегти", value: "save" },
      ],
    });
    if (answer === null || answer === false) return;
    if (answer === "save" && !(await saveDoc(tab.path))) return;
  }
  if (tab.kind === "chat") {
    if (getChat(tab.id)?.busy) {
      const ok = await confirm(`Закрити «${tab.title}»?`, "Claude ще працює — роботу буде зупинено. Розмова збережеться в сесіях.", true, "Закрити");
      if (!ok) return;
    }
    stopChat(tab.id, true);
  }
  if (tab.kind === "file") {
    const stillOpen = allWorkspaces().some((w) => w.tabs.some((t) => t.id !== tabId && t.kind === "file" && samePath(t.path, tab.path)));
    if (!stillOpen) closeDoc(tab.path);
  }
  updateWorkspace(workspaceId, (w) => {
    const index = w.tabs.findIndex((t) => t.id === tabId);
    const tabs = w.tabs.filter((t) => t.id !== tabId);
    const activeTabId = w.activeTabId === tabId ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : w.activeTabId;
    return { ...w, tabs, activeTabId };
  });
}

export function closeOtherTabs(tabId: string) {
  const ws = activeWorkspace();
  ws.tabs.filter((t) => t.id !== tabId).forEach((t) => closeTab(t.id, ws.id));
}

export function activateTab(tabId: string) {
  updateWorkspace(activeWorkspace().id, (w) => ({ ...w, activeTabId: tabId }));
}

export function cycleTab(direction: 1 | -1) {
  const ws = activeWorkspace();
  if (ws.tabs.length < 2) return;
  const index = ws.tabs.findIndex((t) => t.id === ws.activeTabId);
  const next = ws.tabs[(index + direction + ws.tabs.length) % ws.tabs.length];
  activateTab(next.id);
}

export function moveTab(tabId: string, toIndex: number) {
  updateWorkspace(activeWorkspace().id, (w) => {
    const tabs = [...w.tabs];
    const from = tabs.findIndex((t) => t.id === tabId);
    if (from < 0) return w;
    const [tab] = tabs.splice(from, 1);
    tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab);
    return { ...w, tabs };
  });
}

export function openSettings() {
  openTab({ kind: "settings", id: uid("tab"), title: "Налаштування" });
}

export function openStructure(templateId: string | null = null) {
  openTab({ kind: "structure", id: uid("tab"), title: "Структура папок", templateId });
}

export function openSkill(skill: Skill) {
  openTab({ kind: "skill", id: uid("tab"), title: skill.name, skillId: skill.id });
}

export function openNewSkill(markdown = "", sourceName: string | null = null) {
  openTab({ kind: "new-skill", id: uid("tab"), title: "Новий скіл", markdown, sourceName });
}

export function openSession(info: SessionInfo) {
  openTab({ kind: "session", id: uid("tab"), title: info.title, file: info.file, accountId: info.accountId, sessionId: info.id, cwd: info.cwd });
}

export async function loadDir(path: string) {
  try {
    const entries = await api.list(path);
    const previous = get().dirCache[path];
    const same =
      previous &&
      previous.length === entries.length &&
      previous.every((e, i) => e.path === entries[i].path && e.modified === entries[i].modified && e.dir === entries[i].dir);
    if (!same) set((s) => ({ dirCache: { ...s.dirCache, [path]: entries } }));
  } catch {
    set((s) => {
      const next = { ...s.dirCache };
      delete next[path];
      return { dirCache: next };
    });
  }
}

export function toggleExpanded(path: string) {
  const ws = activeWorkspace();
  const open = ws.expanded.some((p) => samePath(p, path));
  updateWorkspace(ws.id, (w) => ({ ...w, expanded: open ? w.expanded.filter((p) => !samePath(p, path)) : [...w.expanded, path] }));
  if (!open) loadDir(path);
}

export function collapseAll() {
  const ws = activeWorkspace();
  updateWorkspace(ws.id, (w) => ({ ...w, expanded: w.root ? [w.root] : [] }));
}

export async function refreshExpanded() {
  const ws = activeWorkspace();
  if (!ws.root) return;
  const paths = ws.expanded.length ? ws.expanded : [ws.root];
  await Promise.all(paths.map((p) => loadDir(p)));
}

function ensureExpanded(dir: string) {
  const ws = activeWorkspace();
  if (!ws.expanded.some((p) => samePath(p, dir))) updateWorkspace(ws.id, (w) => ({ ...w, expanded: [...w.expanded, dir] }));
}

export async function newFileIn(dir: string) {
  const name = await prompt("Новий файл", "", { input: { value: "", placeholder: "назва.ts або папка/назва.md" }, confirm: "Створити" });
  if (!name?.trim()) return;
  const path = joinPath(dir, name.trim());
  try {
    await api.createFile(path);
    ensureExpanded(dir);
    await loadDir(dirname(path));
    await loadDir(dir);
    openFile(path);
  } catch (error) {
    toast(errorText(error), "error");
  }
}

export async function newFolderIn(dir: string) {
  const name = await prompt("Нова папка", "", { input: { value: "", placeholder: "назва папки" }, confirm: "Створити" });
  if (!name?.trim()) return;
  try {
    await api.createDir(joinPath(dir, name.trim()));
    ensureExpanded(dir);
    await loadDir(dir);
  } catch (error) {
    toast(errorText(error), "error");
  }
}

export function revealInTree(path: string) {
  const ws = activeWorkspace();
  if (!ws.root || samePath(ws.root, path) || !isInside(ws.root, path)) return;
  const chain: string[] = [];
  let dir = dirname(path);
  while (dir && !samePath(dir, ws.root) && isInside(ws.root, dir)) {
    chain.unshift(dir);
    const up = dirname(dir);
    if (samePath(up, dir)) break;
    dir = up;
  }
  const missing = chain.filter((d) => !ws.expanded.some((p) => samePath(p, d)));
  if (missing.length) updateWorkspace(ws.id, (w) => ({ ...w, expanded: [...w.expanded, ...missing] }));
}

export function beginRename(path: string) {
  set({ renaming: path });
}

export function endRename() {
  set({ renaming: null });
}

function moved(path: string, from: string, to: string) {
  return isInside(from, path) ? to + path.slice(from.replace(/[\\/]+$/, "").length) : path;
}

export async function applyRename(path: string, name: string): Promise<boolean> {
  const next = name.trim();
  if (next === basename(path)) return true;
  const problem = badFileName(next);
  if (problem) {
    toast(problem, "error");
    return false;
  }
  const target = joinPath(dirname(path), next);
  try {
    await api.rename(path, target);
  } catch (error) {
    toast(errorText(error), "error");
    return false;
  }
  for (const ws of allWorkspaces()) {
    for (const tab of ws.tabs) if (tab.kind === "file" && isInside(path, tab.path)) renameDoc(tab.path, moved(tab.path, path, target));
  }
  const patch = (w: Workspace): Workspace => ({
    ...w,
    tabs: w.tabs.map((t) => {
      if (t.kind !== "file" || !isInside(path, t.path)) return t;
      const to = moved(t.path, path, target);
      return { ...t, path: to, title: basename(to) };
    }),
    expanded: w.expanded.map((p) => moved(p, path, target)),
  });
  set((s) => ({ home: patch(s.home), workspaces: s.workspaces.map(patch) }));
  await loadDir(dirname(path));
  return true;
}

export async function renamePath(path: string) {
  const current = basename(path);
  const dot = current.lastIndexOf(".");
  const name = await prompt("Перейменувати", current, { input: { value: current, select: [0, dot > 0 ? dot : current.length] }, confirm: "Перейменувати" });
  if (!name?.trim() || name.trim() === current) return;
  await applyRename(path, name);
}

export async function deletePath(path: string) {
  const ok = await confirm(`Видалити «${basename(path)}»?`, "Файл піде в Кошик Windows — його можна буде відновити.", true, "У кошик");
  if (!ok) return;
  try {
    await api.trash(path);
    for (const ws of allWorkspaces()) {
      for (const tab of ws.tabs) {
        if (tab.kind === "file" && isInside(path, tab.path)) {
          closeDoc(tab.path);
          updateWorkspace(ws.id, (w) => ({ ...w, tabs: w.tabs.filter((t) => t.id !== tab.id), activeTabId: w.activeTabId === tab.id ? null : w.activeTabId }));
        }
      }
    }
    await loadDir(dirname(path));
    toast(`«${basename(path)}» у кошику`);
  } catch (error) {
    toast(errorText(error), "error");
  }
}

export function copyText(text: string, label = "Скопійовано") {
  navigator.clipboard.writeText(text).then(() => toast(label, "ok"));
}

function shellName(id: string): string {
  return get().info?.shells.find((s) => s.id === id)?.name ?? id;
}

function accountLabel(id: string | null): string {
  const account = get().accounts.find((a) => a.id === (id ?? "main"));
  return account?.label ?? "Claude";
}

function availableShell(id: string): string {
  const shells = get().info?.shells ?? [];
  if (shells.some((s) => s.id === id)) return id;
  return shells.find((s) => s.id === "powershell")?.id ?? shells[0]?.id ?? "powershell";
}

type TerminalOptions = {
  shellId?: string;
  cwd?: string;
  kind?: Pane["kind"];
  accountId?: string | null;
  sessionId?: string | null;
  resume?: boolean;
  title?: string;
  workspaceId?: string;
  split?: boolean;
  command?: string;
};

export function newTerminal(options: TerminalOptions = {}): Pane {
  const state = get();
  const ws = allWorkspaces().find((w) => w.id === (options.workspaceId ?? state.activeId ?? "home")) ?? activeWorkspace();
  const shellId = availableShell(options.shellId ?? state.settings.defaultShell);
  const kind = options.kind ?? "shell";
  const pane: Pane = {
    id: uid("pty"),
    kind,
    shellId,
    cwd: options.cwd ?? ws.root ?? state.info?.home ?? "C:\\",
    title: options.title ?? (kind === "claude" ? `Claude · ${accountLabel(options.accountId ?? null)}` : shellName(shellId)),
    accountId: options.accountId ?? null,
    sessionId: options.sessionId ?? null,
    resume: options.resume ?? false,
    restored: false,
    exited: false,
    command: options.command ?? null,
  };
  updateWorkspace(ws.id, (w) => {
    const active = w.termTabs.find((t) => t.id === w.activeTermTabId);
    if (options.split && active) {
      const termTabs = w.termTabs.map((t) => (t.id === active.id ? { ...t, panes: [...t.panes, pane], activePaneId: pane.id } : t));
      return { ...w, termTabs };
    }
    const tab: TermTab = { id: uid("tt"), panes: [pane], activePaneId: pane.id };
    return { ...w, termTabs: [...w.termTabs, tab], activeTermTabId: tab.id };
  });
  set({ panelVisible: true });
  if (ws.id !== (state.activeId ?? "home")) set({ activeId: ws.id === "home" ? null : ws.id });
  window.setTimeout(() => focusPane(pane.id), 60);
  return pane;
}

export function splitTerminal() {
  const ws = activeWorkspace();
  const tab = ws.termTabs.find((t) => t.id === ws.activeTermTabId);
  const source = tab?.panes.find((p) => p.id === tab.activePaneId);
  if (!tab || !source) {
    newTerminal();
    return;
  }
  if (tab.panes.length >= 4) {
    toast("У вкладці вже 4 панелі");
    return;
  }
  newTerminal({ split: true, shellId: source.shellId, cwd: source.cwd });
}

export function closePane(paneId: string) {
  disposePane(paneId);
  const patch = (w: Workspace): Workspace => {
    if (!w.termTabs.some((t) => t.panes.some((p) => p.id === paneId))) return w;
    const termTabs = w.termTabs
      .map((t) => {
        const panes = t.panes.filter((p) => p.id !== paneId);
        return { ...t, panes, activePaneId: t.activePaneId === paneId ? (panes[panes.length - 1]?.id ?? "") : t.activePaneId };
      })
      .filter((t) => t.panes.length > 0);
    const activeTermTabId = termTabs.some((t) => t.id === w.activeTermTabId) ? w.activeTermTabId : (termTabs[termTabs.length - 1]?.id ?? null);
    return { ...w, termTabs, activeTermTabId };
  };
  set((s) => ({ home: patch(s.home), workspaces: s.workspaces.map(patch) }));
  focusActivePane();
}

export function closeTermTab(tabId: string) {
  const ws = activeWorkspace();
  const tab = ws.termTabs.find((t) => t.id === tabId);
  tab?.panes.forEach((p) => closePane(p.id));
}

export function activateTermTab(tabId: string) {
  updateWorkspace(activeWorkspace().id, (w) => ({ ...w, activeTermTabId: tabId }));
  focusActivePane();
}

export function activatePane(tabId: string, paneId: string) {
  updateWorkspace(activeWorkspace().id, (w) => ({
    ...w,
    activeTermTabId: tabId,
    termTabs: w.termTabs.map((t) => (t.id === tabId ? { ...t, activePaneId: paneId } : t)),
  }));
}

export function renamePane(paneId: string, title: string) {
  updatePane(paneId, (p) => ({ ...p, title }));
}

export function globalAccountId(): string {
  const state = get();
  const id = state.settings.defaultAccountId ?? "main";
  return state.accounts.length && !state.accounts.some((a) => a.id === id) ? "main" : id;
}

export function focusedAccountId(ws: Workspace): string | null {
  const accounts = get().accounts;
  if (!ws.root || !ws.accountId) return null;
  return accounts.length && !accounts.some((a) => a.id === ws.accountId) ? null : ws.accountId;
}

export function defaultAccountFor(ws: Workspace = activeWorkspace()): string {
  return focusedAccountId(ws) ?? globalAccountId();
}

export function newClaudeSession(accountId?: string, cwd?: string) {
  const account = accountId ?? defaultAccountFor();
  const target = cwd ? workspaceFor(cwd) : activeWorkspace();
  newTerminal({ kind: "claude", accountId: account, sessionId: uuid(), resume: false, cwd: cwd ?? target.root ?? undefined, workspaceId: target.id });
}

export function newChat(options: { accountId?: string; cwd?: string } = {}) {
  const target = options.cwd ? workspaceFor(options.cwd) : activeWorkspace();
  const accountId = options.accountId ?? defaultAccountFor(target);
  const cwd = options.cwd ?? target.root ?? get().info?.home ?? "C:\\";
  if (target.id !== activeWorkspace().id) set({ activeId: target.id === "home" ? null : target.id });
  openTab(
    { kind: "chat", id: uid("chat"), title: NEW_CHAT_TITLE, sessionId: uuid(), accountId, cwd, model: null, effort: null, mode: null },
    target.id,
  );
}

export async function openChatSession(info: SessionInfo) {
  const live = allWorkspaces()
    .flatMap((w) => w.termTabs.flatMap((t) => t.panes))
    .find((p) => p.sessionId === info.id && !p.exited);
  if (live) {
    const ok = await confirm("Сесія відкрита в терміналі", "Закрити термінал і продовжити цю розмову в чаті?", false, "Продовжити в чаті");
    if (!ok) return;
    closePane(live.id);
  }
  const ws = workspaceFor(info.cwd);
  const cwdOk = info.cwd ? await api.exists(info.cwd) : false;
  if (ws.id !== activeWorkspace().id) set({ activeId: ws.id === "home" ? null : ws.id });
  openTab(
    {
      kind: "chat",
      id: uid("chat"),
      title: info.title.slice(0, 60),
      sessionId: info.id,
      accountId: info.accountId,
      cwd: cwdOk ? info.cwd : (ws.root ?? get().info?.home ?? "C:\\"),
      model: null,
      effort: null,
      mode: null,
    },
    ws.id,
  );
}

export async function resumeSession(info: SessionInfo) {
  chatTabs()
    .filter((x) => x.tab.sessionId === info.id && getChat(x.tab.id)?.running)
    .forEach((x) => stopChat(x.tab.id));
  const ws = workspaceFor(info.cwd);
  const existing = allWorkspaces()
    .flatMap((w) => w.termTabs.flatMap((t) => t.panes.map((p) => ({ w, t, p }))))
    .find((x) => x.p.sessionId === info.id);
  if (existing) {
    set({ activeId: existing.w.id === "home" ? null : existing.w.id, panelVisible: true });
    activatePane(existing.t.id, existing.p.id);
    focusPane(existing.p.id);
    return;
  }
  const cwdOk = info.cwd ? await api.exists(info.cwd) : false;
  newTerminal({
    kind: "claude",
    accountId: info.accountId,
    sessionId: info.id,
    resume: true,
    cwd: cwdOk ? info.cwd : undefined,
    title: info.title.slice(0, 48),
    workspaceId: ws.id,
  });
}

export function loginAccount(accountId: string) {
  newTerminal({ kind: "claude", accountId, sessionId: null, title: `Вхід · ${accountLabel(accountId)}` });
  toast("У терміналі пройди вхід у Claude (тема → спосіб входу → браузер)");
}

const MAIN_ACCOUNT_ID = "main";
const RELOGIN_COMMAND = "claude auth logout; claude auth login --claudeai";
const LOGIN_POLL_MS = 3000;
const LOGIN_POLL_LIMIT = 100;

function watchLogin(accountId: string, previousEmail: string | null) {
  let tries = 0;
  const timer = window.setInterval(async () => {
    tries++;
    await refreshAccounts();
    const account = get().accounts.find((a) => a.id === accountId);
    const changed = !!account?.loggedIn && !!account.email && account.email !== previousEmail;
    if (changed) toast(`«${account!.label}» тепер на ${account!.email}`, "ok");
    if (!account || changed || tries >= LOGIN_POLL_LIMIT) window.clearInterval(timer);
  }, LOGIN_POLL_MS);
}

export function duplicatesOf(account: Account, accounts: Account[] = get().accounts): Account[] {
  const email = account.loggedIn ? account.email?.toLowerCase() : null;
  if (!email) return [];
  return accounts.filter((a) => a.id !== account.id && a.loggedIn && a.email?.toLowerCase() === email);
}

export async function changeAccountEmail(accountId: string) {
  const account = get().accounts.find((a) => a.id === accountId);
  if (!account || account.main) return;
  const ok = await confirm(
    `Змінити акаунт для «${account.label}»?`,
    `${account.email ? `Mavix вийде з ${account.email} на цій підписці` : "Mavix вийде з цієї підписки"} і відкриє вхід у браузері. Увійди тією поштою, яка має бути на «${account.label}». Чати й сесії підписки залишаться.`,
    false,
    "Вийти й увійти іншою поштою",
  );
  if (!ok) return;
  newTerminal({ kind: "shell", shellId: "powershell", accountId, title: `Зміна акаунта · ${account.label}`, command: RELOGIN_COMMAND });
  toast("У браузері увійди потрібною поштою. Mavix сам оновить підписку");
  watchLogin(accountId, account.email);
}

export function forgetAccount(accountId: string) {
  set((s) => {
    const projectAccounts = Object.fromEntries(Object.entries(s.projectAccounts).filter(([, id]) => id !== accountId));
    const unpin = (w: Workspace): Workspace => (w.accountId === accountId ? { ...w, accountId: null } : w);
    const settings = s.settings.defaultAccountId === accountId ? { ...s.settings, defaultAccountId: MAIN_ACCOUNT_ID } : s.settings;
    return { projectAccounts, workspaces: s.workspaces.map(unpin), settings };
  });
}

export async function renameAccount(account: Account) {
  const label = await prompt("Назва підписки", account.label);
  if (!label?.trim() || label.trim() === account.label) return;
  try {
    await api.accountsUpdate(account.id, label.trim(), null);
    await refreshAccounts();
  } catch (error) {
    toast(errorText(error), "error");
  }
}

export async function removeAccount(account: Account) {
  if (account.main) return;
  const choice = await ask({
    title: `Видалити «${account.label}»?`,
    message: `${account.email ? `${account.email}\n\n` : ""}«Прибрати» — підписка зникне з Mavix, папка з входом і сесіями лишиться на диску.\n«Видалити з даними» — вхід і сесії підуть у Кошик. Спільні скіли не постраждають.\n\nВкладки, закріплені за нею, перейдуть на підписку за замовчуванням.`,
    danger: true,
    choices: [
      { label: "Видалити з даними", value: "delete" },
      { label: "Прибрати", value: "keep" },
    ],
  });
  if (choice !== "keep" && choice !== "delete") return;
  try {
    await api.accountsRemove(account.id, choice === "delete");
    forgetAccount(account.id);
    await refreshAccounts();
    toast(`«${account.label}» ${choice === "delete" ? "видалено" : "прибрано"}`, "ok");
  } catch (error) {
    toast(errorText(error), "error");
  }
}

function loginIfNeeded(accountId: string) {
  const account = get().accounts.find((a) => a.id === accountId);
  if (account && !account.loggedIn) loginAccount(accountId);
}

export function setDefaultAccount(accountId: string) {
  set((s) => ({ settings: { ...s.settings, defaultAccountId: accountId } }));
  api.accountsSetDefault(accountId).then(refreshAccounts).catch(() => {});
  loginIfNeeded(accountId);
}

export function focusProjectAccount(root: string, accountId: string | null) {
  const key = pathKey(root);
  set((s) => {
    const projectAccounts = { ...s.projectAccounts };
    if (accountId) projectAccounts[key] = accountId;
    else delete projectAccounts[key];
    const patch = (w: Workspace): Workspace => (w.root && pathKey(w.root) === key ? { ...w, accountId } : w);
    return { projectAccounts, workspaces: s.workspaces.map(patch) };
  });
  if (accountId) loginIfNeeded(accountId);
}

export function chooseAccount(accountId: string, ws: Workspace = activeWorkspace()) {
  if (ws.root) focusProjectAccount(ws.root, accountId);
  else setDefaultAccount(accountId);
}

export function accountMenuItems(ws: Workspace): MenuItem[] {
  const { accounts } = get();
  const focused = focusedAccountId(ws);
  const global = accounts.find((a) => a.id === globalAccountId());
  const mark = (on: boolean, label: string) => `${on ? "●" : "  "}  ${label}`;
  const items: MenuItem[] = [];
  if (ws.root) {
    items.push({ label: `Підписка для вкладки «${ws.name}»`, disabled: true, action: () => {} });
    items.push({ label: mark(!focused, `За замовчуванням${global ? ` · ${global.label}` : ""}`), action: () => focusProjectAccount(ws.root!, null) });
    items.push("separator");
  } else {
    items.push({ label: "Підписка за замовчуванням", disabled: true, action: () => {} });
  }
  const current = ws.root ? focused : (global?.id ?? null);
  for (const a of accounts) items.push({ label: mark(a.id === current, `${a.label}${a.email ? " · " + a.email : ""}`), action: () => chooseAccount(a.id, ws) });
  items.push("separator", { label: "Підключити ще одну підписку…", action: () => connectAccount() }, { label: "Керувати підписками", action: () => set({ activity: "accounts", sidebarVisible: true }) });
  return items;
}

export async function connectAccount(): Promise<string | null> {
  const count = get().accounts.length;
  const label = await prompt("Підключити підписку Claude", "", {
    message:
      "Mavix відкриє вхід у терміналі: увійди тією поштою, на якій ця підписка. Усі підключені підписки працюють одночасно, кожен чат на своїй. Скіли, правила й CLAUDE.md спільні, а вхід, чати й ліміти в кожної свої.",
    input: { value: "", placeholder: `Наприклад: Підписка ${count + 1}` },
    confirm: "Підключити й увійти",
  });
  if (!label?.trim()) return null;
  try {
    const id = await api.accountsAdd(label.trim());
    await refreshAccounts();
    loginAccount(id);
    return id;
  } catch (error) {
    toast(errorText(error), "error");
    return null;
  }
}

export async function refreshAccounts() {
  try {
    const previous = get().accounts.map((a) => a.id).join("|");
    const accounts = await api.accountsList();
    set({ accounts });
    if (previous && previous !== accounts.map((a) => a.id).join("|")) refreshRules();
  } catch (error) {
    toast(`Акаунти: ${errorText(error)}`, "error");
  }
}

let rulesRevision = 0;

export async function refreshRules() {
  const revision = ++rulesRevision;
  try {
    const state = await api.rulesLoad();
    if (revision === rulesRevision) set({ rules: state });
  } catch (error) {
    toast(`Правила: ${errorText(error)}`, "error");
  }
}

export async function saveRules(rules: Rule[]) {
  const revision = ++rulesRevision;
  set((s) => ({ rules: { targets: s.rules?.targets ?? [], prompt: s.rules?.prompt ?? null, rules } }));
  try {
    const state = await api.rulesSave(rules);
    if (revision === rulesRevision) set({ rules: state });
    const broken = state.targets.filter((t) => !t.ok);
    if (broken.length) toast(`Правила не вшито в: ${broken.map((t) => t.label).join(", ")}`, "error");
  } catch (error) {
    toast(`Правила не збережено: ${errorText(error)}`, "error");
  }
}

export async function refreshSlack() {
  try {
    const state = await api.slackLoad();
    set({ slack: state });
    const broken = state.targets.filter((t) => !t.ok);
    if (broken.length) toast(`Slack не підключено до Claude в: ${broken.map((t) => t.label).join(", ")}`, "error");
    if (state.connected && !get().slackChats) loadSlackChats();
  } catch (error) {
    toast(`Slack: ${errorText(error)}`, "error");
  }
}

export async function connectSlack(token: string): Promise<boolean> {
  set({ slackBusy: "connect" });
  try {
    const state = await api.slackConnect(token);
    set({ slack: state, slackChats: null });
    toast(`Slack підключено: ${state.team}`, "ok");
    loadSlackChats();
    return true;
  } catch (error) {
    toast(errorText(error), "error");
    return false;
  } finally {
    if (get().slackBusy === "connect") set({ slackBusy: "" });
  }
}

export async function disconnectSlack() {
  const ok = await confirm("Відключити Slack?", "Claude більше не бачитиме жодного чату. Токен і зведення буде видалено з цього ПК.", true, "Відключити");
  if (!ok) return;
  set({ slackBusy: "disconnect" });
  try {
    set({ slack: await api.slackDisconnect(), slackChats: null });
    toast("Slack відключено");
  } catch (error) {
    toast(`Slack: ${errorText(error)}`, "error");
  } finally {
    set({ slackBusy: "" });
  }
}

export async function loadSlackChats() {
  set({ slackBusy: "chats" });
  try {
    set({ slackChats: await api.slackChats() });
  } catch (error) {
    toast(`Чати Slack: ${errorText(error)}`, "error");
  } finally {
    if (get().slackBusy === "chats") set({ slackBusy: "" });
  }
}

export async function selectSlackChats(chats: SlackChat[]) {
  set((s) => ({ slack: s.slack ? { ...s.slack, selected: chats } : s.slack }));
  try {
    const state = await api.slackSelect(chats);
    set((s) => ({ slack: s.slack ? { ...state, targets: s.slack.targets } : state }));
  } catch (error) {
    toast(`Чати Slack не збережено: ${errorText(error)}`, "error");
  }
}

export async function buildSlackDigest(days: number) {
  const accountId = defaultAccountFor();
  set({ slackBusy: "digest" });
  try {
    const next = await api.slackDigest(accountId, days);
    set((s) => ({ slack: s.slack ? { ...next, targets: s.slack.targets } : next }));
  } catch (error) {
    toast(`Зведення: ${errorText(error)}`, "error");
  } finally {
    set({ slackBusy: "" });
  }
}

export async function refreshSkills() {
  set({ skillsLoading: true });
  try {
    const roots = get().workspaces.map((w) => w.root).filter((r): r is string => !!r);
    set({ skills: await api.skillsList(roots) });
  } catch (error) {
    toast(`Скіли: ${errorText(error)}`, "error");
  } finally {
    set({ skillsLoading: false });
  }
}

export function skillKey(skill: Skill): string {
  if (skill.scope === "plugin") return `${skill.plugin ?? ""}:${skill.name}`;
  if (skill.scope === "synced") {
    const group = basename(dirname(skill.path));
    return group ? `${group}:${skill.name}` : skill.name;
  }
  return skill.name;
}

export async function loadProjectSkills(root: string) {
  try {
    const state = await api.skillsProject(root);
    set((s) => ({ projectSkills: { ...s.projectSkills, [root]: state } }));
  } catch (error) {
    toast(`Скіли проекту: ${errorText(error)}`, "error");
  }
}

let projectSkillsRevision = 0;

export async function setProjectSkills(root: string, on: boolean, selected: string[]) {
  const revision = ++projectSkillsRevision;
  set((s) => ({ projectSkills: { ...s.projectSkills, [root]: { root, on, selected, hidden: s.projectSkills[root]?.hidden ?? 0 } } }));
  try {
    const state = await api.skillsProjectSet(root, on, selected);
    if (revision === projectSkillsRevision) set((s) => ({ projectSkills: { ...s.projectSkills, [root]: state } }));
  } catch (error) {
    toast(`Скіли проекту не збережено: ${errorText(error)}`, "error");
    loadProjectSkills(root);
  }
}

export async function refreshSessions() {
  set({ sessionsLoading: true });
  try {
    set({ sessions: await api.sessionsList(null) });
  } catch (error) {
    toast(`Сесії: ${errorText(error)}`, "error");
  } finally {
    set({ sessionsLoading: false });
  }
}

export async function refreshTemplates() {
  try {
    set({ templates: await api.templates() });
  } catch (error) {
    toast(errorText(error), "error");
  }
}

export async function saveTemplates(templates: Template[]) {
  set({ templates });
  await api.templatesSave(templates).catch((e) => toast(errorText(e), "error"));
}

const togglingSkills = new Set<string>();

function patchSkills(fn: (skill: Skill) => Skill) {
  set((state) => (state.skills ? { skills: { ...state.skills, skills: state.skills.skills.map(fn) } } : {}));
}

function setPluginEnabled(key: string, name: string, enabled: boolean) {
  set((state) =>
    state.skills
      ? {
          skills: {
            ...state.skills,
            plugins: state.skills.plugins.map((p) => (p.key === key ? { ...p, enabled } : p)),
            skills: state.skills.skills.map((s) => (s.scope === "plugin" && s.plugin === name ? { ...s, enabled } : s)),
          },
        }
      : {},
  );
}

export async function togglePlugin(key: string, enabled: boolean) {
  const plugin = get().skills?.plugins.find((p) => p.key === key);
  if (!plugin || plugin.enabled === enabled) return;
  setPluginEnabled(key, plugin.name, enabled);
  try {
    await api.pluginsSetEnabled(key, enabled);
    toast(`Плагін ${plugin.name} ${enabled ? "увімкнено" : "вимкнено"} для всіх акаунтів`, "ok");
  } catch (error) {
    setPluginEnabled(key, plugin.name, !enabled);
    toast(errorText(error), "error");
  }
}

export async function toggleSkill(skill: Skill) {
  if (skill.scope === "synced") {
    toast("Цей скіл синхронізується з claude.ai — вмикай його в налаштуваннях claude.ai");
    return;
  }
  if (togglingSkills.has(skill.id)) return;
  togglingSkills.add(skill.id);
  try {
    if (skill.scope === "plugin") {
      const plugin = get().skills?.plugins.find((p) => p.name === skill.plugin);
      if (plugin) await togglePlugin(plugin.key, !plugin.enabled);
      return;
    }
    const enabled = !skill.enabled;
    patchSkills((s) => (s.id === skill.id ? { ...s, enabled, always: enabled ? s.always : false } : s));
    try {
      const path = await api.skillsSetEnabled(skill.path, skill.scope, skill.project, enabled);
      const skillFile = skill.skillFile ? path + skill.skillFile.slice(skill.path.length) : null;
      patchSkills((s) => (s.id === skill.id ? { ...s, path, skillFile } : s));
      toast(`${skill.name}: ${enabled ? "увімкнено" : "вимкнено"}`, "ok");
    } catch (error) {
      patchSkills((s) => (s.id === skill.id ? skill : s));
      toast(errorText(error), "error");
    }
  } finally {
    togglingSkills.delete(skill.id);
  }
}

function openProjectRoots(): string[] {
  return get().workspaces.map((w) => w.root).filter((r): r is string => !!r);
}

function skillWord(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return "скілів";
  if (ones === 1) return "скіл";
  if (ones >= 2 && ones <= 4) return "скіли";
  return "скілів";
}

function reportBulk(result: BulkSkillsResult, verb: string, tail: string) {
  const plugins = result.plugins ? ` і ${result.plugins} ${result.plugins === 1 ? "плагін" : "плагіни"}` : "";
  const done = `${verb} ${result.skills} ${skillWord(result.skills)}${plugins}`;
  if (result.failed.length) {
    const more = result.failed.length > 3 ? ` і ще ${result.failed.length - 3}` : "";
    toast(`${done}. Не вдалося: ${result.failed.slice(0, 3).join("; ")}${more}`, "error");
  } else {
    toast(`${done}. ${tail}`, "ok");
  }
}

async function runBulk(mode: "off" | "on") {
  if (get().skillsBulk) return;
  set({ skillsBulk: mode });
  try {
    if (mode === "off") {
      reportBulk(await api.skillsDisableAll(openProjectRoots()), "Вимкнено", "Той самий перемикач поверне все як було");
    } else {
      reportBulk(await api.skillsEnableAll(openProjectRoots()), "Увімкнено", "Нові сесії Claude вже бачать скіли");
    }
  } catch (error) {
    toast(`Скіли: ${errorText(error)}`, "error");
  } finally {
    await refreshSkills();
    set({ skillsBulk: null });
  }
}

export function disableAllSkills() {
  return runBulk("off");
}

export function enableAllSkills() {
  return runBulk("on");
}

export async function refreshSkillUsage() {
  if (get().skillUsageLoading) return;
  set({ skillUsageLoading: true });
  try {
    set({ skillUsage: await api.skillsUsage() });
  } catch (error) {
    toast(`Статистика скілів: ${errorText(error)}`, "error");
  } finally {
    set({ skillUsageLoading: false });
  }
}

export async function setSkillMine(skill: Skill, mine: boolean) {
  set((s) => (s.skills ? { skills: { ...s.skills, skills: s.skills.skills.map((x) => (x.id === skill.id ? { ...x, mine } : x)) } } : {}));
  try {
    await api.skillsSetMine(skill.name, mine);
    toast(mine ? `«${skill.name}» тепер у «Мої»` : `«${skill.name}» прибрано з «Мої»`, "ok");
  } catch (error) {
    toast(errorText(error), "error");
    await refreshSkills();
  }
}

export async function setSkillAlways(skill: Skill, always: boolean) {
  if (togglingSkills.has(skill.id)) return;
  togglingSkills.add(skill.id);
  patchSkills((s) => (s.id === skill.id ? { ...s, always, enabled: always ? true : s.enabled } : s));
  try {
    if (always && !skill.enabled) {
      const path = await api.skillsSetEnabled(skill.path, skill.scope, skill.project, true);
      const skillFile = skill.skillFile ? path + skill.skillFile.slice(skill.path.length) : null;
      patchSkills((s) => (s.id === skill.id ? { ...s, path, skillFile } : s));
    }
    await api.skillsSetAlways(skill.name, skill.scope === "project" ? "project" : "user", skill.project, always);
    toast(always ? `«${skill.name}» тепер завжди активний — правило додано в CLAUDE.md` : `«${skill.name}» знову вмикається лише коли доречно`, "ok");
  } catch (error) {
    toast(errorText(error), "error");
    await refreshSkills();
  } finally {
    togglingSkills.delete(skill.id);
  }
}

export async function deleteSkill(skill: Skill) {
  const ok = await confirm(`Видалити скіл «${skill.name}»?`, "Папка скіла піде в Кошик Windows.", true, "У кошик");
  if (!ok) return false;
  try {
    await api.skillsDelete(skill.path, skill.name, skill.scope, skill.project);
    toast(`Скіл «${skill.name}» видалено`, "ok");
    await refreshSkills();
    return true;
  } catch (error) {
    toast(errorText(error), "error");
    return false;
  }
}

export async function createSkill(draft: SkillDraft): Promise<Skill | null> {
  try {
    const skill = await api.skillsCreate(draft);
    await refreshSkills();
    return skill;
  } catch (error) {
    toast(errorText(error), "error");
    return null;
  }
}

export async function importSkillPaths(paths: string[], scope: "user" | "project" = "user") {
  const project = scope === "project" ? activeWorkspace().root : null;
  for (const path of paths) {
    const lower = path.toLowerCase();
    if (lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".txt")) {
      try {
        const file = await api.readText(path);
        openNewSkill(file.content, basename(path));
      } catch (error) {
        toast(errorText(error), "error");
      }
      continue;
    }
    try {
      const installed = await api.skillsImport(path, scope, project, false);
      toast(`Встановлено: ${installed.map((s) => s.name).join(", ")}`, "ok");
    } catch (error) {
      const message = errorText(error);
      if (message.includes("уже встановлено")) {
        const replace = await confirm("Скіл уже є", `${message}. Замінити його новою версією? Стара піде в кошик.`, false, "Замінити");
        if (replace) {
          try {
            const installed = await api.skillsImport(path, scope, project, true);
            toast(`Оновлено: ${installed.map((s) => s.name).join(", ")}`, "ok");
          } catch (inner) {
            toast(errorText(inner), "error");
          }
        }
      } else {
        toast(message, "error");
      }
    }
  }
  await refreshSkills();
}

export async function importSkillDialog() {
  const picked = await openDialog({
    multiple: true,
    title: "Завантажити скіл",
    filters: [{ name: "Скіли", extensions: ["md", "zip", "skill", "markdown", "txt"] }],
  });
  const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
  if (paths.length) await importSkillPaths(paths);
}

export async function importSkillFolderDialog() {
  const picked = await openDialog({ directory: true, multiple: false, title: "Папка зі скілом (SKILL.md)" });
  if (typeof picked === "string") await importSkillPaths([picked]);
}

export async function applyStructure(root: string, tree: string, silent = false) {
  try {
    const created = await api.structureApply(root, tree);
    if (created.length || !silent) toast(created.length ? `Створено: ${created.length} (${created.slice(0, 4).join(", ")}${created.length > 4 ? "…" : ""})` : "Структура вже повна", "ok");
    await loadDir(root);
    await refreshExpanded();
    return created;
  } catch (error) {
    toast(errorText(error), "error");
    return [];
  }
}

export async function autoStructure(ws: Workspace) {
  if (!ws.root || !ws.autoStructure || !ws.structureId) return;
  const template = get().templates.find((t) => t.id === ws.structureId);
  if (template) await applyStructure(ws.root, template.tree, true);
}

export async function handleDrop(paths: string[]) {
  if (!paths.length) return;
  const state = get();
  const isSkillish = (p: string) => /\.(zip|skill)$/i.test(p);
  if (state.activity === "skills" && state.sidebarVisible) {
    await importSkillPaths(paths);
    return;
  }
  if (paths.some(isSkillish)) {
    await importSkillPaths(paths.filter(isSkillish));
  }
  for (const path of paths.filter((p) => !isSkillish(p))) {
    const entries = await api.list(path).then(() => true).catch(() => false);
    if (entries) await openProject(path);
    else openFile(path);
  }
}

export function currentFilePath(): string | null {
  const ws = activeWorkspace();
  const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
  return tab?.kind === "file" ? tab.path : null;
}

export async function saveCurrent() {
  const path = currentFilePath();
  if (path && getDoc(path)) {
    if (await saveDoc(path)) toast(`Збережено ${basename(path)}`, "ok");
  }
}
