import { create } from "zustand";
import { api, type Account, type AppInfo, type Entry, type ProjectSkills, type RulesState, type SessionInfo, type SkillsSnapshot, type SlackChat, type SlackState, type Template, type UsageReport } from "./ipc";
import { debounce, pathKey } from "./util";
import type { ThemeId } from "./themes";
import type { PermissionMode } from "./chat";

export type Activity = "files" | "search" | "claude" | "rules" | "slack" | "skills" | "accounts" | "structure";

export type Tab =
  | { kind: "file"; id: string; title: string; path: string }
  | {
      kind: "chat";
      id: string;
      title: string;
      sessionId: string;
      accountId: string;
      cwd: string;
      model: string | null;
      effort: string | null;
      mode: PermissionMode | null;
    }
  | { kind: "session"; id: string; title: string; file: string; accountId: string; sessionId: string; cwd: string }
  | { kind: "skill"; id: string; title: string; skillId: string }
  | { kind: "new-skill"; id: string; title: string; markdown: string; sourceName: string | null }
  | { kind: "structure"; id: string; title: string; templateId: string | null }
  | { kind: "settings"; id: string; title: string };

export type Pane = {
  id: string;
  kind: "shell" | "claude";
  shellId: string;
  cwd: string;
  title: string;
  accountId: string | null;
  sessionId: string | null;
  resume: boolean;
  restored: boolean;
  exited: boolean;
  command?: string | null;
};

export type TermTab = { id: string; panes: Pane[]; activePaneId: string };

export type Workspace = {
  id: string;
  root: string | null;
  name: string;
  color: string;
  tabs: Tab[];
  activeTabId: string | null;
  expanded: string[];
  termTabs: TermTab[];
  activeTermTabId: string | null;
  structureId: string | null;
  autoStructure: boolean;
  accountId: string | null;
  themeId: ThemeId | null;
};

export type Settings = {
  uiTheme: ThemeId;
  uiFontSize: number;
  editorFontSize: number;
  editorWrap: boolean;
  terminalFontSize: number;
  terminalFont: string;
  terminalTheme: "ide" | "ember" | "graphite" | "zed";
  terminalImage: string | null;
  terminalImageOpacity: number;
  terminalBlur: number;
  defaultShell: string;
  defaultAccountId: string;
  confirmClose: boolean;
};

export type SessionGroup = { id: string; name: string };

export type SessionsPrefs = {
  tab: "local" | "web";
  activeOnly: boolean;
  groups: SessionGroup[];
  groupOf: Record<string, string>;
  archived: string[];
  collapsed: Record<string, boolean>;
  expanded: Record<string, boolean>;
};

export const DEFAULT_SESSIONS_PREFS: SessionsPrefs = {
  tab: "local",
  activeOnly: false,
  groups: [],
  groupOf: {},
  archived: [],
  collapsed: {},
  expanded: {},
};

export type Toast = { id: number; text: string; kind: "info" | "ok" | "error" };

export type MenuItem =
  | { label: string; action: () => void; shortcut?: string; danger?: boolean; disabled?: boolean }
  | "separator";

export type DialogSpec = {
  title: string;
  message?: string;
  input?: { value: string; placeholder?: string; select?: [number, number] };
  confirm?: string;
  cancel?: string;
  danger?: boolean;
  choices?: { label: string; value: string }[];
};

export type Dialog = DialogSpec & { resolve: (value: string | boolean | null) => void };

type Persisted = {
  workspaces: Workspace[];
  home: Workspace;
  activeId: string | null;
  recent: string[];
  activity: Activity;
  sidebarVisible: boolean;
  sidebarWidth: number;
  panelVisible: boolean;
  panelHeight: number;
  settings: Settings;
  sessionsScope: "project" | "all";
  sessionsAccount: string | null;
  sessionsPrefs: SessionsPrefs;
  projectAccounts: Record<string, string>;
};

export type State = Persisted & {
  ready: boolean;
  info: AppInfo | null;
  panelMaximized: boolean;
  dirty: Record<string, boolean>;
  dirCache: Record<string, Entry[]>;
  accounts: Account[];
  skills: SkillsSnapshot | null;
  skillsLoading: boolean;
  skillsBulk: "off" | "on" | null;
  sessions: SessionInfo[];
  sessionsLoading: boolean;
  templates: Template[];
  palette: { mode: "files" | "commands"; query: string } | null;
  cursor: { line: number; col: number; selected: number } | null;
  language: string;
  toasts: Toast[];
  menu: { x: number; y: number; items: MenuItem[] } | null;
  dialog: Dialog | null;
  branches: Record<string, string | null>;
  terminalImageUrl: string | null;
  dragOver: boolean;
  editorEpoch: number;
  newProjectOpen: boolean;
  recentFile: Record<string, string>;
  rules: RulesState | null;
  slack: SlackState | null;
  slackChats: SlackChat[] | null;
  slackBusy: "" | "connect" | "chats" | "digest" | "disconnect";
  renaming: string | null;
  projectSkills: Record<string, ProjectSkills>;
  skillUsage: UsageReport | null;
  skillUsageLoading: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  uiTheme: "navy",
  uiFontSize: 13,
  editorFontSize: 13.5,
  editorWrap: false,
  terminalFontSize: 13.5,
  terminalFont: "'JetBrains Mono Variable', 'Cascadia Mono', Consolas, monospace",
  terminalTheme: "ide",
  terminalImage: null,
  terminalImageOpacity: 0.38,
  terminalBlur: 0,
  defaultShell: "powershell",
  defaultAccountId: "main",
  confirmClose: true,
};

export function emptyWorkspace(id: string, root: string | null, name: string, color: string): Workspace {
  return {
    id,
    root,
    name,
    color,
    tabs: [],
    activeTabId: null,
    expanded: root ? [root] : [],
    termTabs: [],
    activeTermTabId: null,
    structureId: null,
    autoStructure: false,
    accountId: null,
    themeId: null,
  };
}

export const useStore = create<State>(() => ({
  workspaces: [],
  home: emptyWorkspace("home", null, "Mavix", "#ff8a3d"),
  activeId: null,
  recent: [],
  activity: "files",
  sidebarVisible: true,
  sidebarWidth: 286,
  panelVisible: true,
  panelHeight: 300,
  settings: DEFAULT_SETTINGS,
  sessionsScope: "project",
  sessionsAccount: null,
  sessionsPrefs: DEFAULT_SESSIONS_PREFS,
  projectAccounts: {},
  ready: false,
  info: null,
  panelMaximized: false,
  dirty: {},
  dirCache: {},
  accounts: [],
  skills: null,
  skillsLoading: false,
  skillsBulk: null,
  sessions: [],
  sessionsLoading: false,
  templates: [],
  palette: null,
  cursor: null,
  language: "",
  toasts: [],
  menu: null,
  dialog: null,
  branches: {},
  terminalImageUrl: null,
  dragOver: false,
  editorEpoch: 0,
  newProjectOpen: false,
  recentFile: {},
  rules: null,
  slack: null,
  slackChats: null,
  slackBusy: "",
  renaming: null,
  projectSkills: {},
  skillUsage: null,
  skillUsageLoading: false,
}));

export const get = useStore.getState;
export const set = useStore.setState;

export function activeWorkspace(state: State = get()): Workspace {
  return state.workspaces.find((w) => w.id === state.activeId) ?? state.home;
}

export function updateWorkspace(id: string, fn: (w: Workspace) => Workspace) {
  set((state) => {
    if (state.home.id === id) return { home: fn(state.home) };
    return { workspaces: state.workspaces.map((w) => (w.id === id ? fn(w) : w)) };
  });
}

export function allWorkspaces(state: State = get()): Workspace[] {
  return [state.home, ...state.workspaces];
}

export function useActiveWorkspace(): Workspace {
  return useStore((s) => s.workspaces.find((w) => w.id === s.activeId) ?? s.home);
}

function persistedSnapshot(state: State): Persisted {
  const cleanPane = (p: Pane): Pane => ({ ...p, restored: true, exited: false });
  const cleanWorkspace = (w: Workspace): Workspace => ({
    ...w,
    termTabs: w.termTabs.map((t) => ({ ...t, panes: t.panes.map(cleanPane) })),
  });
  return {
    workspaces: state.workspaces.map(cleanWorkspace),
    home: cleanWorkspace(state.home),
    activeId: state.activeId,
    recent: state.recent,
    activity: state.activity,
    sidebarVisible: state.sidebarVisible,
    sidebarWidth: state.sidebarWidth,
    panelVisible: state.panelVisible,
    panelHeight: state.panelHeight,
    settings: state.settings,
    sessionsScope: state.sessionsScope,
    sessionsAccount: state.sessionsAccount,
    sessionsPrefs: state.sessionsPrefs,
    projectAccounts: state.projectAccounts,
  };
}

function boundAccounts(workspaces: Workspace[]): Record<string, string> {
  return Object.fromEntries(workspaces.filter((w) => w.root && w.accountId).map((w) => [pathKey(w.root!), w.accountId!]));
}

let lastSaved = "";
const saveNow = () => {
  const state = get();
  if (!state.ready) return;
  const json = JSON.stringify(persistedSnapshot(state));
  if (json === lastSaved) return;
  lastSaved = json;
  api.stateSave(json).catch(() => {});
};
const saveSoon = debounce(saveNow, 450);

export function flushSave() {
  saveNow();
}

export async function loadPersisted(): Promise<boolean> {
  const raw = await api.stateLoad().catch(() => null);
  if (!raw) return false;
  try {
    const data = JSON.parse(raw) as Partial<Persisted>;
    const fixWorkspace = (w: Workspace): Workspace => ({
      ...emptyWorkspace(w.id, w.root, w.name, w.color),
      ...w,
      termTabs: (w.termTabs ?? []).map((t) => ({ ...t, panes: t.panes.map((p) => ({ ...p, restored: true, exited: false })) })),
    });
    const workspaces = (data.workspaces ?? []).map(fixWorkspace);
    set({
      workspaces,
      projectAccounts: { ...boundAccounts(workspaces), ...(data.projectAccounts ?? {}) },
      home: data.home ? fixWorkspace({ ...data.home, root: null }) : get().home,
      activeId: data.activeId ?? null,
      recent: data.recent ?? [],
      activity: data.activity ?? "files",
      sidebarVisible: data.sidebarVisible ?? true,
      sidebarWidth: data.sidebarWidth ?? 286,
      panelVisible: data.panelVisible ?? true,
      panelHeight: data.panelHeight ?? 300,
      settings: { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) },
      sessionsScope: data.sessionsScope ?? "project",
      sessionsAccount: data.sessionsAccount ?? null,
      sessionsPrefs: { ...DEFAULT_SESSIONS_PREFS, ...(data.sessionsPrefs ?? {}) },
    });
    lastSaved = raw;
    return true;
  } catch {
    return false;
  }
}

useStore.subscribe(() => saveSoon());

let toastSeq = 0;
export function toast(text: string, kind: Toast["kind"] = "info") {
  const id = ++toastSeq;
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind }] }));
  window.setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 6000 : 3600);
}

export function ask(spec: DialogSpec): Promise<string | boolean | null> {
  return new Promise((resolve) => {
    set({ dialog: { ...spec, resolve } });
  });
}

export async function prompt(title: string, value = "", options: Partial<DialogSpec> = {}): Promise<string | null> {
  const result = await ask({ title, input: { value, ...(options.input ?? {}) }, confirm: "Готово", ...options });
  return typeof result === "string" ? result : null;
}

export async function confirm(title: string, message?: string, danger = false, confirmLabel = "Так"): Promise<boolean> {
  const result = await ask({ title, message, danger, confirm: confirmLabel });
  return result === true;
}

export function openMenu(event: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) {
  event.preventDefault?.();
  set({ menu: { x: event.clientX, y: event.clientY, items } });
}
