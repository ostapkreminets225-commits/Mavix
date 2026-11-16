import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api, errorText } from "./ipc";
import { imageBlock, type ChatImage } from "./images";

type Wire = Record<string, any>;

export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions" | "dontAsk";

export type ModelOption = {
  value: string;
  displayName: string;
  description: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
};

export type SlashCommand = { name: string; description: string; argumentHint?: string };

export type ToolItem = {
  kind: "tool";
  id: string;
  toolId: string;
  name: string;
  input: Wire;
  result: string | null;
  isError: boolean;
  images: number;
  subagentSteps: number;
  subagentLast: string;
};

export type ChatItem =
  | { kind: "user"; id: string; text: string; time: number; files: string[]; images: number; previews?: string[] }
  | { kind: "text"; id: string; text: string }
  | { kind: "thinking"; id: string; text: string; seconds: number | null }
  | ToolItem
  | { kind: "note"; id: string; text: string; tone: "info" | "warn" | "error" };

export type PermissionRequest = {
  requestId: string;
  toolName: string;
  toolId: string | null;
  input: Wire;
  description: string;
  suggestions: Wire[];
};

export type LiveBlock = { kind: "text" | "thinking" | "tool"; text: string; name: string; startedAt: number };

export type Limits = { fiveHour: number | null; sevenDay: number | null; fiveHourResets: number | null; warning: boolean };

export type Chat = {
  key: string;
  sessionId: string;
  accountId: string;
  cwd: string;
  running: boolean;
  starting: boolean;
  ready: boolean;
  busy: boolean;
  historyLoaded: boolean;
  items: ChatItem[];
  requests: PermissionRequest[];
  live: LiveBlock | null;
  turnStartedAt: number | null;
  turnChars: number;
  status: string | null;
  interrupted: boolean;
  model: string | null;
  effort: string | null;
  mode: PermissionMode | null;
  currentMode: PermissionMode | null;
  resolvedModel: string | null;
  models: ModelOption[];
  commands: SlashCommand[];
  email: string | null;
  plan: string | null;
  limits: Limits | null;
  lastTurn: { seconds: number; cost: number } | null;
  stderr: string[];
};

export type ChatSeed = {
  key: string;
  sessionId: string;
  accountId: string;
  cwd: string;
  model: string | null;
  effort: string | null;
  mode: PermissionMode | null;
};

export const FALLBACK_MODELS: ModelOption[] = [
  { value: "default", displayName: "Типова", description: "Модель з налаштувань Claude" },
  { value: "opus", displayName: "Opus", description: "Найсильніша для складних задач" },
  { value: "sonnet", displayName: "Sonnet", description: "Швидка і розумна" },
  { value: "haiku", displayName: "Haiku", description: "Найшвидша" },
];

export const useChats = create<Record<string, Chat>>(() => ({}));

export const chatHooks: {
  turnDone: (key: string) => void;
  sessionChanged: (key: string, sessionId: string) => void;
} = {
  turnDone: () => {},
  sessionChanged: () => {},
};

type Pending = { key: string; resolve: (value: Wire) => void; reject: (reason: unknown) => void };

type SharedInit = { models: ModelOption[]; commands: SlashCommand[] };

const SHARED_INIT_KEY = "mavix.chat.init";

function loadSharedInit(): SharedInit {
  try {
    const raw = localStorage.getItem(SHARED_INIT_KEY);
    if (raw) {
      const value = JSON.parse(raw);
      return { models: Array.isArray(value.models) ? value.models : [], commands: Array.isArray(value.commands) ? value.commands : [] };
    }
  } catch {
    return { models: [], commands: [] };
  }
  return { models: [], commands: [] };
}

let sharedInit: SharedInit = loadSharedInit();

function rememberSharedInit(models: ModelOption[], commands: SlashCommand[]) {
  if (!models.length && !commands.length) return;
  sharedInit = { models: models.length ? models : sharedInit.models, commands: commands.length ? commands : sharedInit.commands };
  try {
    localStorage.setItem(SHARED_INIT_KEY, JSON.stringify(sharedInit));
  } catch {
    return;
  }
}

const pending = new Map<string, Pending>();
const starts = new Map<string, Promise<void>>();
let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence}`;
}

export function getChat(key: string): Chat | undefined {
  return useChats.getState()[key];
}

function patch(key: string, fn: (chat: Chat) => Partial<Chat>) {
  const chat = getChat(key);
  if (!chat) return;
  useChats.setState({ [key]: { ...chat, ...fn(chat) } });
}

function blankChat(seed: ChatSeed): Chat {
  return {
    key: seed.key,
    sessionId: seed.sessionId,
    accountId: seed.accountId,
    cwd: seed.cwd,
    running: false,
    starting: false,
    ready: false,
    busy: false,
    historyLoaded: false,
    items: [],
    requests: [],
    live: null,
    turnStartedAt: null,
    turnChars: 0,
    status: null,
    interrupted: false,
    model: seed.model,
    effort: seed.effort,
    mode: seed.mode,
    currentMode: null,
    resolvedModel: null,
    models: sharedInit.models,
    commands: sharedInit.commands,
    email: null,
    plan: null,
    limits: null,
    lastTurn: null,
    stderr: [],
  };
}

function write(key: string, payload: Wire): Promise<void> {
  return api.chatSend(key, JSON.stringify(payload));
}

function control(key: string, request: Wire): Promise<Wire> {
  const id = nextId("mavix");
  return new Promise((resolve, reject) => {
    pending.set(id, { key, resolve, reject });
    write(key, { type: "control_request", request_id: id, request }).catch((error) => {
      pending.delete(id);
      reject(error);
    });
  });
}

function settle(response: Wire) {
  const entry = pending.get(response?.request_id);
  if (!entry) return;
  pending.delete(response.request_id);
  if (response.subtype === "error") entry.reject(new Error(response.error ?? "Помилка Claude"));
  else entry.resolve(response.response ?? {});
}

function rejectAll(key: string, reason: string) {
  for (const [id, entry] of pending) {
    if (entry.key !== key) continue;
    pending.delete(id);
    entry.reject(new Error(reason));
  }
}

const IDE_FILE = /<ide_opened_file>The user opened the file (.+?) in the IDE[\s\S]*?<\/ide_opened_file>/g;
const ATTACHED = /<mavix_files>([\s\S]*?)<\/mavix_files>/g;

export function composeMessage(text: string, openFile: string | null, attachments: string[]): string {
  const parts = [text.trim()];
  if (attachments.length) parts.push(`<mavix_files>\n${attachments.join("\n")}\n</mavix_files>`);
  if (openFile) parts.push(`<ide_opened_file>The user opened the file ${openFile} in the IDE. This may or may not be related to the current task.</ide_opened_file>`);
  return parts.filter(Boolean).join("\n\n");
}

function parsePrompt(raw: string): { text: string; files: string[] } | null {
  const files: string[] = [];
  for (const match of raw.matchAll(IDE_FILE)) files.push(match[1]);
  for (const match of raw.matchAll(ATTACHED)) files.push(...match[1].split("\n").map((l) => l.trim()).filter(Boolean));
  const command = raw.match(/<command-name>([^<]*)<\/command-name>/);
  if (command) {
    const args = raw.match(/<command-args>([^<]*)<\/command-args>/)?.[1] ?? "";
    return { text: `${command[1].trim()} ${args.trim()}`.trim(), files };
  }
  const bash = raw.match(/<bash-input>([\s\S]*?)<\/bash-input>/);
  if (bash) return { text: `! ${bash[1].trim()}`, files };
  const text = raw
    .replace(IDE_FILE, "")
    .replace(ATTACHED, "")
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
  if (!text && files.length === 0) return null;
  if (text.startsWith("<") || text.startsWith("Caveat:")) return null;
  return { text, files };
}

function contentText(content: unknown): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: "", images: 0 };
  const texts: string[] = [];
  let images = 0;
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
    else if (part?.type === "image") images += 1;
  }
  return { text: texts.join("\n"), images };
}

function findToolIndex(items: ChatItem[], toolId: string): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === "tool" && item.toolId === toolId) return i;
  }
  return -1;
}

function addPrompt(draft: Chat, raw: string, images: number, message: Wire) {
  if (message.isMeta) return;
  if (message.isCompactSummary) {
    draft.items.push({ kind: "note", id: nextId("n"), text: "Розмову стиснуто — продовжуємо з підсумку", tone: "info" });
    return;
  }
  const parsed = parsePrompt(raw);
  if (!parsed && images === 0) return;
  const time = Date.parse(message.timestamp ?? "") || Date.now();
  draft.items.push({ kind: "user", id: nextId("u"), text: parsed?.text ?? "", time, files: parsed?.files ?? [], images });
}

function applyUser(draft: Chat, message: Wire, live: boolean) {
  if (message.parent_tool_use_id || message.isSidechain) return;
  const content = message.message?.content;
  if (typeof content === "string") {
    if (/^\[Request interrupted/.test(content.trim())) {
      draft.items.push({ kind: "note", id: nextId("n"), text: "Зупинено", tone: "warn" });
      return;
    }
    if (!live) addPrompt(draft, content, 0, message);
    return;
  }
  if (!Array.isArray(content)) return;
  const texts: string[] = [];
  let images = 0;
  for (const part of content) {
    if (part?.type === "tool_result") {
      const index = findToolIndex(draft.items, part.tool_use_id);
      if (index < 0) continue;
      const tool = draft.items[index] as ToolItem;
      const result = contentText(part.content);
      draft.items[index] = { ...tool, result: result.text, images: result.images, isError: part.is_error === true };
    } else if (part?.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    } else if (part?.type === "image") {
      images += 1;
    }
  }
  const joined = texts.join("\n").trim();
  if (/^\[Request interrupted/.test(joined)) {
    draft.items.push({ kind: "note", id: nextId("n"), text: "Зупинено", tone: "warn" });
    return;
  }
  if (!live && (joined || images)) addPrompt(draft, joined, images, message);
}

function applySubagent(draft: Chat, message: Wire) {
  const index = findToolIndex(draft.items, message.parent_tool_use_id);
  if (index < 0) return;
  const blocks = message.message?.content;
  if (!Array.isArray(blocks)) return;
  const used = blocks.filter((b: Wire) => b?.type === "tool_use");
  if (used.length === 0) return;
  const tool = draft.items[index] as ToolItem;
  draft.items[index] = { ...tool, subagentSteps: tool.subagentSteps + used.length, subagentLast: used[used.length - 1].name ?? "" };
}

function applyAssistant(draft: Chat, message: Wire) {
  if (message.parent_tool_use_id) {
    applySubagent(draft, message);
    return;
  }
  const blocks = message.message?.content;
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (block?.type === "text") {
      if (typeof block.text === "string" && block.text.trim()) draft.items.push({ kind: "text", id: nextId("t"), text: block.text });
      if (draft.live?.kind === "text") draft.live = null;
    } else if (block?.type === "thinking" || block?.type === "redacted_thinking") {
      const seconds = draft.live?.kind === "thinking" ? (Date.now() - draft.live.startedAt) / 1000 : null;
      draft.items.push({ kind: "thinking", id: nextId("k"), text: typeof block.thinking === "string" ? block.thinking : "", seconds });
      if (draft.live?.kind === "thinking") draft.live = null;
    } else if (block?.type === "tool_use" || block?.type === "server_tool_use") {
      if (findToolIndex(draft.items, block.id) < 0) {
        draft.items.push({
          kind: "tool",
          id: nextId("x"),
          toolId: block.id,
          name: block.name ?? "tool",
          input: block.input ?? {},
          result: null,
          isError: false,
          images: 0,
          subagentSteps: 0,
          subagentLast: "",
        });
      }
      if (draft.live?.kind === "tool") draft.live = null;
    }
  }
}

function applyStream(draft: Chat, message: Wire) {
  if (message.parent_tool_use_id) return;
  const event = message.event ?? {};
  if (event.type === "content_block_start") {
    const block = event.content_block ?? {};
    const kind =
      block.type === "thinking" || block.type === "redacted_thinking"
        ? "thinking"
        : block.type === "tool_use" || block.type === "server_tool_use"
          ? "tool"
          : block.type === "text"
            ? "text"
            : null;
    if (kind) draft.live = { kind, text: "", name: block.name ?? "", startedAt: Date.now() };
    draft.busy = true;
    if (!draft.turnStartedAt) draft.turnStartedAt = Date.now();
  } else if (event.type === "content_block_delta" && draft.live) {
    const delta = event.delta ?? {};
    const add = delta.type === "text_delta" ? delta.text : delta.type === "thinking_delta" ? delta.thinking : delta.type === "input_json_delta" ? delta.partial_json : "";
    if (typeof add === "string" && add) {
      draft.live = { ...draft.live, text: draft.live.text + add };
      draft.turnChars += add.length;
    }
  } else if (event.type === "content_block_stop") {
    draft.live = null;
  }
}

function applySystem(draft: Chat, message: Wire) {
  switch (message.subtype) {
    case "init":
      if (typeof message.model === "string") draft.resolvedModel = message.model;
      if (message.permissionMode) draft.currentMode = message.permissionMode;
      if (typeof message.session_id === "string" && message.session_id && message.session_id !== draft.sessionId) {
        draft.sessionId = message.session_id;
      }
      if (Array.isArray(message.slash_commands) && draft.commands.length === 0) {
        draft.commands = message.slash_commands.map((name: string) => ({ name, description: "" }));
      }
      break;
    case "status":
      if (message.permissionMode) draft.currentMode = message.permissionMode;
      draft.status = typeof message.status === "string" ? message.status : null;
      if (message.status === "requesting") draft.busy = true;
      break;
    case "compact_boundary":
      draft.items.push({ kind: "note", id: nextId("n"), text: "Контекст стиснуто", tone: "info" });
      break;
    case "commands_changed":
      if (Array.isArray(message.commands)) draft.commands = message.commands;
      break;
    case "api_retry":
      draft.status = "retrying";
      break;
    default:
      break;
  }
}

function applyResult(draft: Chat, message: Wire) {
  const started = draft.turnStartedAt;
  draft.busy = false;
  draft.live = null;
  draft.status = null;
  draft.turnStartedAt = null;
  draft.turnChars = 0;
  const seconds = typeof message.duration_ms === "number" ? message.duration_ms / 1000 : started ? (Date.now() - started) / 1000 : 0;
  draft.lastTurn = { seconds, cost: typeof message.total_cost_usd === "number" ? message.total_cost_usd : 0 };
  const errors: string[] = Array.isArray(message.errors) ? message.errors.filter((e: unknown) => typeof e === "string" && e) : [];
  if (message.is_error && typeof message.result === "string" && message.result) {
    draft.items.push({ kind: "note", id: nextId("n"), text: message.result, tone: "error" });
  } else if (typeof message.subtype === "string" && message.subtype.startsWith("error") && !draft.interrupted) {
    const text = errors.length ? errors.join("\n") : message.subtype === "error_max_turns" ? "Досягнуто ліміту кроків" : "Claude зупинився з помилкою";
    draft.items.push({ kind: "note", id: nextId("n"), text, tone: "error" });
  }
  draft.interrupted = false;
}

function applyLimits(draft: Chat, message: Wire) {
  const info = message.rate_limit_info ?? {};
  const windows = info.unifiedWindows ?? {};
  const five = windows.five_hour ?? (info.rateLimitType === "five_hour" ? info : null);
  const seven = windows.seven_day ?? null;
  draft.limits = {
    fiveHour: typeof five?.utilization === "number" ? five.utilization : (draft.limits?.fiveHour ?? null),
    sevenDay: typeof seven?.utilization === "number" ? seven.utilization : (draft.limits?.sevenDay ?? null),
    fiveHourResets: typeof five?.resetsAt === "number" ? five.resetsAt : (draft.limits?.fiveHourResets ?? null),
    warning: info.status === "allowed_warning" || info.status === "rejected",
  };
}

function applyRequest(draft: Chat, message: Wire) {
  const request = message.request ?? {};
  draft.requests = [
    ...draft.requests,
    {
      requestId: message.request_id,
      toolName: request.tool_name ?? request.display_name ?? "tool",
      toolId: request.tool_use_id ?? null,
      input: request.input ?? {},
      description: request.description ?? "",
      suggestions: Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [],
    },
  ];
}

function reduce(draft: Chat, message: Wire, live: boolean) {
  switch (message.type) {
    case "stream_event":
      applyStream(draft, message);
      break;
    case "assistant":
      applyAssistant(draft, message);
      break;
    case "user":
      applyUser(draft, message, live);
      break;
    case "system":
      applySystem(draft, message);
      break;
    case "result":
      applyResult(draft, message);
      break;
    case "rate_limit_event":
      applyLimits(draft, message);
      break;
    case "control_request":
      applyRequest(draft, message);
      break;
    case "control_cancel_request":
      draft.requests = draft.requests.filter((r) => r.requestId !== message.request_id);
      break;
    default:
      break;
  }
}

function replay(lines: string[]): ChatItem[] {
  const draft = blankChat({ key: "", sessionId: "", accountId: "", cwd: "", model: null, effort: null, mode: null });
  for (const line of lines) {
    try {
      reduce(draft, JSON.parse(line), false);
    } catch {
      continue;
    }
  }
  return draft.items;
}

export function ensureChat(seed: ChatSeed) {
  if (getChat(seed.key)) return;
  useChats.setState({ [seed.key]: blankChat(seed) });
  void bootChat(seed.key);
}

async function bootChat(key: string) {
  const chat = getChat(key);
  if (!chat) return;
  const exists = await api.sessionExists(chat.accountId, chat.sessionId).catch(() => false);
  if (exists) {
    const history = await api.chatHistory(chat.accountId, chat.sessionId).catch(() => null);
    if (history) patch(key, (c) => ({ items: [...replay(history.lines), ...c.items] }));
  }
  patch(key, () => ({ historyLoaded: true }));
  if (!exists) await startChat(key, false).catch(() => {});
}

export function startChat(key: string, resume?: boolean): Promise<void> {
  const inFlight = starts.get(key);
  if (inFlight) return inFlight;
  const chat = getChat(key);
  if (!chat || chat.running) return Promise.resolve();
  const job = (async () => {
    patch(key, () => ({ starting: true }));
    try {
      const current = getChat(key)!;
      const shouldResume = resume ?? (await api.sessionExists(current.accountId, current.sessionId).catch(() => false));
      await api.chatStart({
        id: key,
        cwd: current.cwd,
        accountId: current.accountId,
        sessionId: current.sessionId,
        resume: shouldResume,
        model: current.model && current.model !== "default" ? current.model : null,
        effort: current.effort,
        permissionMode: current.mode,
      });
      patch(key, () => ({ running: true, starting: false, stderr: [] }));
      const init = await control(key, { subtype: "initialize", hooks: null });
      rememberSharedInit(Array.isArray(init.models) ? init.models : [], Array.isArray(init.commands) ? init.commands : []);
      patch(key, (c) => ({
        ready: true,
        models: Array.isArray(init.models) && init.models.length ? init.models : c.models,
        commands: Array.isArray(init.commands) && init.commands.length ? init.commands : c.commands,
        email: init.account?.email ?? c.email,
        plan: init.account?.subscriptionType ?? c.plan,
        currentMode: init.current_permission_mode ?? c.currentMode,
      }));
    } catch (error) {
      patch(key, (c) => ({
        starting: false,
        items: [...c.items, { kind: "note", id: nextId("n"), text: `Не вдалося запустити Claude: ${errorText(error)}`, tone: "error" }],
      }));
      throw error;
    } finally {
      starts.delete(key);
    }
  })();
  starts.set(key, job);
  return job;
}

export async function sendMessage(key: string, text: string, openFile: string | null, attachments: string[], images: ChatImage[] = []) {
  const chat = getChat(key);
  if (!chat || (!text.trim() && attachments.length === 0 && images.length === 0)) return;
  const files = [...attachments, ...(openFile ? [openFile] : [])];
  const body = composeMessage(text, openFile, attachments);
  const content = [...(body ? [{ type: "text", text: body }] : []), ...images.map(imageBlock)];
  patch(key, (c) => ({
    items: [...c.items, { kind: "user", id: nextId("u"), text: text.trim(), time: Date.now(), files, images: images.length, previews: images.map((i) => i.url) }],
    busy: true,
    turnStartedAt: c.turnStartedAt ?? Date.now(),
    turnChars: c.busy ? c.turnChars : 0,
    interrupted: false,
  }));
  try {
    if (!getChat(key)?.running) await startChat(key);
    await write(key, {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: "",
    });
  } catch (error) {
    patch(key, (c) => ({
      busy: false,
      turnStartedAt: null,
      items: [...c.items, { kind: "note", id: nextId("n"), text: `Повідомлення не надіслано: ${errorText(error)}`, tone: "error" }],
    }));
  }
}

export async function interruptChat(key: string) {
  const chat = getChat(key);
  if (!chat?.running || !chat.busy) return;
  patch(key, () => ({ interrupted: true, requests: [] }));
  await control(key, { subtype: "interrupt" }).catch(() => {});
}

export async function setChatModel(key: string, model: string) {
  patch(key, () => ({ model }));
  const chat = getChat(key);
  if (!chat?.running) return;
  try {
    const response = await control(key, { subtype: "set_model", model });
    if (typeof response.model === "string") patch(key, () => ({ resolvedModel: response.model }));
  } catch (error) {
    patch(key, (c) => ({ items: [...c.items, { kind: "note", id: nextId("n"), text: `Модель не змінено: ${errorText(error)}`, tone: "error" }] }));
  }
}

export async function setChatEffort(key: string, effort: string) {
  patch(key, () => ({ effort }));
  if (!getChat(key)?.running) return;
  await control(key, { subtype: "apply_flag_settings", settings: { effortLevel: effort } }).catch(() => {});
}

export async function setChatMode(key: string, mode: PermissionMode) {
  patch(key, () => ({ mode }));
  if (!getChat(key)?.running) {
    patch(key, () => ({ currentMode: mode }));
    return;
  }
  try {
    const response = await control(key, { subtype: "set_permission_mode", mode });
    patch(key, () => ({ currentMode: (response.mode as PermissionMode) ?? mode }));
  } catch (error) {
    patch(key, (c) => ({ items: [...c.items, { kind: "note", id: nextId("n"), text: `Режим не змінено: ${errorText(error)}`, tone: "error" }] }));
  }
}

export async function answerRequest(key: string, requestId: string, decision: "allow" | "always" | "deny", options: { input?: Wire; message?: string } = {}) {
  const chat = getChat(key);
  const request = chat?.requests.find((r) => r.requestId === requestId);
  if (!chat || !request) return;
  patch(key, (c) => ({ requests: c.requests.filter((r) => r.requestId !== requestId) }));
  const response =
    decision === "deny"
      ? { behavior: "deny", message: options.message?.trim() || "The user declined this action." }
      : {
          behavior: "allow",
          updatedInput: options.input ?? request.input,
          ...(decision === "always" && request.suggestions.length ? { updatedPermissions: request.suggestions } : {}),
        };
  await write(key, { type: "control_response", response: { subtype: "success", request_id: requestId, response } }).catch((error) =>
    patch(key, (c) => ({ items: [...c.items, { kind: "note", id: nextId("n"), text: errorText(error), tone: "error" }] })),
  );
}

export async function stopChat(key: string, forget = false) {
  rejectAll(key, "Чат закрито");
  starts.delete(key);
  await api.chatStop(key).catch(() => {});
  if (forget) {
    useChats.setState((state) => {
      const next = { ...state };
      delete next[key];
      return next;
    }, true);
  } else {
    patch(key, () => ({ running: false, ready: false, busy: false, live: null, requests: [], status: null, turnStartedAt: null }));
  }
}

export async function restartChat(key: string) {
  await stopChat(key);
  await startChat(key).catch(() => {});
}

export async function switchChatAccount(key: string, accountId: string, label: string) {
  const chat = getChat(key);
  if (!chat || chat.accountId === accountId) return;
  if (chat.busy) throw new Error("Дочекайся, поки Claude закінчить відповідь, або зупини його");
  const from = chat.accountId;
  const hasHistory = await api.sessionExists(from, chat.sessionId).catch(() => false);
  await stopChat(key);
  if (hasHistory) await api.sessionCopyToAccount(chat.sessionId, from, accountId);
  patch(key, (c) => ({
    accountId,
    models: [],
    commands: [],
    email: null,
    plan: null,
    limits: null,
    items: hasHistory ? [...c.items, { kind: "note", id: nextId("n"), text: `Далі цей чат іде на підписці «${label}»`, tone: "info" }] : c.items,
  }));
  if (!hasHistory) await startChat(key, false).catch(() => {});
}

export async function initChatEvents() {
  await listen<{ id: string; lines: string[] }>("chat-lines", (event) => {
    const { id, lines } = event.payload;
    const chat = getChat(id);
    if (!chat) return;
    const draft: Chat = { ...chat, items: [...chat.items] };
    const wasBusy = chat.busy;
    for (const line of lines) {
      let message: Wire;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type === "control_response") {
        settle(message.response);
        continue;
      }
      if (message.type === "control_request" && message.request?.subtype !== "can_use_tool") {
        write(id, { type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "Mavix не підтримує цей запит" } }).catch(() => {});
        continue;
      }
      reduce(draft, message, true);
    }
    useChats.setState({ [id]: draft });
    if (draft.sessionId !== chat.sessionId) chatHooks.sessionChanged(id, draft.sessionId);
    if (wasBusy && !draft.busy) chatHooks.turnDone(id);
  });
  await listen<{ id: string; text: string }>("chat-stderr", (event) => {
    patch(event.payload.id, (c) => ({ stderr: [...c.stderr.slice(-30), event.payload.text] }));
  });
  await listen<{ id: string; code: number }>("chat-exit", (event) => {
    const { id, code } = event.payload;
    rejectAll(id, "Claude завершився");
    patch(id, (c) => {
      const detail = c.stderr.slice(-4).join("\n");
      const note: ChatItem[] =
        code !== 0 || c.busy
          ? [{ kind: "note", id: nextId("n"), text: `Claude завершився (код ${code})${detail ? `\n${detail}` : ""}. Напиши ще раз — він перезапуститься.`, tone: "error" }]
          : [];
      return { running: false, ready: false, busy: false, live: null, requests: [], status: null, turnStartedAt: null, items: [...c.items, ...note] };
    });
  });
}

export function prettyModel(id: string | null): string {
  if (!id) return "";
  const match = id.match(/claude-([a-z]+)-(\d+)(?:-(\d+))?/i);
  if (!match) return id;
  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  return match[3] && match[3].length <= 2 ? `${family} ${match[2]}.${match[3]}` : `${family} ${match[2]}`;
}
