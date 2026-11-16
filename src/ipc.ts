import { invoke } from "@tauri-apps/api/core";

export type Entry = { name: string; path: string; dir: boolean; size: number; modified: number; dim: boolean };
export type TextFile = { content: string; binary: boolean; tooLarge: boolean; size: number };
export type ShellInfo = { id: string; name: string; path: string };
export type AppInfo = {
  home: string;
  dataDir: string;
  claudeDir: string;
  claudePath: string | null;
  shells: ShellInfo[];
  terminalImage: string | null;
  terminalImageOpacity: number | null;
  terminalScheme: Record<string, string> | null;
};
export type Skill = {
  id: string;
  name: string;
  folder: string;
  description: string;
  scope: "user" | "project" | "plugin" | "synced";
  project: string | null;
  plugin: string | null;
  enabled: boolean;
  always: boolean;
  path: string;
  skillFile: string | null;
  issues: string[];
  files: number;
  modified: number;
  created: number;
  mine: boolean;
};
export type SkillUsage = { skill: string; total: number; auto: number; manual: number; sessions: number; last: string };
export type UsageReport = { skills: SkillUsage[]; files: number; scanned: number };
export type Plugin = { key: string; name: string; version: string; description: string; enabled: boolean; path: string; skills: number };
export type SkillsSnapshot = { skills: Skill[]; plugins: Plugin[]; restorable: number };
export type BulkSkillsResult = { skills: number; plugins: number; failed: string[] };
export type ProjectSkills = { root: string; on: boolean; selected: string[]; hidden: number };
export type Limit = { kind: string; label: string; percent: number; resetsAt: string | null; severity: string; active: boolean };
export type Usage = { fetchedAt: number; live: boolean; limits: Limit[] };
export type Account = {
  id: string;
  label: string;
  color: string;
  configDir: string;
  main: boolean;
  default: boolean;
  loggedIn: boolean;
  email: string | null;
  organization: string | null;
  plan: string | null;
  tokenExpiresAt: number | null;
  usage: Usage | null;
  shared: boolean;
};
export type SessionInfo = {
  id: string;
  accountId: string;
  title: string;
  firstPrompt: string;
  cwd: string;
  gitBranch: string;
  modified: number;
  size: number;
  file: string;
};
export type TranscriptMessage = { role: "user" | "assistant" | "command"; text: string; tools: { name: string; detail: string }[]; time: string };
export type Transcript = { messages: TranscriptMessage[]; total: number; cwd: string };
export type Rule = { id: string; text: string; enabled: boolean; created: number };
export type RuleTarget = { label: string; path: string; ok: boolean; error: string | null };
export type RulesState = { rules: Rule[]; targets: RuleTarget[]; prompt: string | null };
export type ChatHistory = { lines: string[]; title: string | null };
export type SlackChatKind = "channel" | "private" | "group" | "dm";
export type SlackChat = { id: string; name: string; kind: SlackChatKind };
export type SlackTarget = { label: string; ok: boolean; error: string | null };
export type SlackRef = { chat: string; user: string; time: string; link: string; mention: boolean };
export type SlackDigestKind = "edits" | "questions" | "bugs" | "deadlines" | "mentions" | "info";
export type SlackDigest = {
  createdAt: number;
  days: number;
  count: number;
  summary: string;
  groups: { kind: SlackDigestKind; items: { text: string; refs: SlackRef[] }[] }[];
  failed: string[];
};
export type SlackState = {
  connected: boolean;
  team: string;
  url: string;
  user: string;
  scopes: string[];
  selected: SlackChat[];
  targets: SlackTarget[];
  digest: SlackDigest | null;
  readScopes: string[];
};
export type ChatStartRequest = {
  id: string;
  cwd: string;
  accountId: string | null;
  sessionId: string | null;
  resume: boolean;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
};
export type Template = { id: string; name: string; tree: string; builtin: boolean };
export type PlanItem = { path: string; name: string; dir: boolean; exists: boolean; depth: number };
export type SearchHit = { file: string; line: number; text: string };
export type SkillDraft = {
  markdown: string;
  name: string;
  description: string;
  scope: "user" | "project";
  project: string | null;
  always: boolean;
  overwrite: boolean;
};

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  imageDataUrl: (path: string) => invoke<string>("image_data_url", { path }),
  stateLoad: () => invoke<string | null>("state_load"),
  stateSave: (json: string) => invoke<void>("state_save", { json }),

  termShells: () => invoke<ShellInfo[]>("term_shells"),
  termSpawn: (req: { id: string; shellId: string; cwd: string; cols: number; rows: number; startup: string | null; accountId: string | null }) =>
    invoke<number>("term_spawn", { req }),
  termWrite: (id: string, data: string) => invoke<void>("term_write", { id, data }),
  termResize: (id: string, cols: number, rows: number) => invoke<void>("term_resize", { id, cols, rows }),
  termKill: (id: string) => invoke<void>("term_kill", { id }),

  chatStart: (req: ChatStartRequest) => invoke<number>("chat_start", { req }),
  chatSend: (id: string, line: string) => invoke<void>("chat_send", { id, line }),
  chatStop: (id: string) => invoke<void>("chat_stop", { id }),
  chatHistory: (accountId: string, sessionId: string) => invoke<ChatHistory>("chat_history", { accountId, sessionId }),

  rulesLoad: () => invoke<RulesState>("rules_load"),
  rulesSave: (rules: Rule[]) => invoke<RulesState>("rules_save", { rules }),

  slackLoad: () => invoke<SlackState>("slack_load"),
  slackConnect: (token: string) => invoke<SlackState>("slack_connect", { token }),
  slackDisconnect: () => invoke<SlackState>("slack_disconnect"),
  slackChats: () => invoke<SlackChat[]>("slack_chats"),
  slackSelect: (chats: SlackChat[]) => invoke<SlackState>("slack_select", { chats }),
  slackDigest: (accountId: string | null, days: number) => invoke<SlackState>("slack_digest", { accountId, days }),

  list: (path: string) => invoke<Entry[]>("fs_list", { path }),
  readText: (path: string) => invoke<TextFile>("fs_read_text", { path }),
  writeText: (path: string, content: string) => invoke<number>("fs_write_text", { path, content }),
  readDataUrl: (path: string) => invoke<string>("fs_read_data_url", { path }),
  createFile: (path: string) => invoke<void>("fs_create_file", { path }),
  createDir: (path: string) => invoke<void>("fs_create_dir", { path }),
  rename: (from: string, to: string) => invoke<void>("fs_rename", { from, to }),
  trash: (path: string) => invoke<void>("fs_trash", { path }),
  exists: (path: string) => invoke<boolean>("fs_exists", { path }),
  reveal: (path: string) => invoke<void>("fs_reveal", { path }),
  walk: (root: string) => invoke<string[]>("fs_walk", { root }),
  search: (root: string, query: string) => invoke<SearchHit[]>("fs_search", { root, query }),
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  gitBranch: (root: string) => invoke<string | null>("git_branch", { root }),

  skillsList: (projects: string[]) => invoke<SkillsSnapshot>("skills_list", { projects }),
  skillsSetEnabled: (path: string, scope: string, project: string | null, enabled: boolean) =>
    invoke<string>("skills_set_enabled", { path, scope, project, enabled }),
  skillsSetAlways: (name: string, scope: string, project: string | null, always: boolean) =>
    invoke<void>("skills_set_always", { name, scope, project, always }),
  skillsCreate: (draft: SkillDraft) => invoke<Skill>("skills_create", { draft }),
  skillsImport: (path: string, scope: string, project: string | null, overwrite: boolean) =>
    invoke<Skill[]>("skills_import", { path, scope, project, overwrite }),
  skillsDelete: (path: string, name: string, scope: string, project: string | null) =>
    invoke<void>("skills_delete", { path, name, scope, project }),
  pluginsSetEnabled: (key: string, enabled: boolean) => invoke<void>("plugins_set_enabled", { key, enabled }),
  skillsDisableAll: (projects: string[]) => invoke<BulkSkillsResult>("skills_disable_all", { projects }),
  skillsEnableAll: (projects: string[]) => invoke<BulkSkillsResult>("skills_enable_all", { projects }),
  skillFiles: (path: string) => invoke<string[]>("skill_files", { path }),
  skillsSetMine: (name: string, mine: boolean) => invoke<void>("skills_set_mine", { name, mine }),
  skillsProject: (root: string) => invoke<ProjectSkills>("skills_project", { root }),
  skillsProjectSet: (root: string, on: boolean, selected: string[]) => invoke<ProjectSkills>("skills_project_set", { root, on, selected }),
  skillsUsage: () => invoke<UsageReport>("skills_usage"),

  accountsList: () => invoke<Account[]>("accounts_list"),
  accountsAdd: (label: string) => invoke<string>("accounts_add", { label }),
  accountsUpdate: (id: string, label: string | null, color: string | null) => invoke<void>("accounts_update", { id, label, color }),
  accountsSetDefault: (id: string) => invoke<void>("accounts_set_default", { id }),
  accountsRemove: (id: string, deleteData: boolean) => invoke<void>("accounts_remove", { id, deleteData }),
  accountsSync: () => invoke<void>("accounts_sync"),
  accountsRefreshUsage: (id: string) => invoke<void>("accounts_refresh_usage", { id }),

  sessionsList: (accountId: string | null) => invoke<SessionInfo[]>("sessions_list", { accountId }),
  sessionRead: (file: string) => invoke<Transcript>("session_read", { file }),
  sessionExists: (accountId: string, sessionId: string) => invoke<boolean>("session_exists", { accountId, sessionId }),
  sessionCopyToAccount: (sessionId: string, from: string, to: string) => invoke<void>("session_copy_to_account", { sessionId, from, to }),

  templates: () => invoke<Template[]>("structure_templates"),
  templatesSave: (templates: Template[]) => invoke<void>("structure_save", { templates }),
  structurePlan: (root: string, tree: string) => invoke<PlanItem[]>("structure_plan", { root, tree }),
  structureApply: (root: string, tree: string) => invoke<string[]>("structure_apply", { root, tree }),
  structureCapture: (root: string, depth: number) => invoke<string>("structure_capture", { root, depth }),
  structureWriteClaudeMd: (root: string, tree: string) => invoke<string>("structure_write_claude_md", { root, tree }),
  projectCreate: (parent: string, name: string, tree: string | null) => invoke<string>("project_create", { parent, name, tree }),
};

export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
