import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { listen } from "@tauri-apps/api/event";
import { api, errorText } from "./ipc";
import { activeWorkspace, get, set, type Pane, type Settings, type Workspace } from "./store";
import { themeById } from "./themes";
import { hotkey } from "./util";

export function effectiveThemeId(): string {
  const state = get();
  return activeWorkspace(state).themeId ?? state.settings.uiTheme;
}

type Instance = {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  started: boolean;
  alive: boolean;
  gpu: "pending" | "on" | "off";
};

const instances = new Map<string, Instance>();

function attachGpuRenderer(instance: Instance) {
  if (instance.gpu !== "pending") return;
  try {
    const renderer = new WebglAddon();
    renderer.onContextLoss(() => {
      renderer.dispose();
      instance.gpu = "off";
    });
    instance.term.loadAddon(renderer);
    instance.gpu = "on";
  } catch {
    instance.gpu = "off";
  }
}

const EMBER_FALLBACK: Record<string, string> = {
  background: "#0A0908",
  foreground: "#E6DCCB",
  cursorColor: "#FF8A1F",
  selectionBackground: "#4A2A0C",
  black: "#16130F",
  red: "#FF4B2B",
  green: "#A3C45A",
  yellow: "#FFB000",
  blue: "#7F97A8",
  purple: "#D2693A",
  cyan: "#79A8A0",
  white: "#CBBFAE",
  brightBlack: "#4A4136",
  brightRed: "#FF7A5C",
  brightGreen: "#C4E07A",
  brightYellow: "#FFCC4D",
  brightBlue: "#A6BCCB",
  brightPurple: "#FF9A5C",
  brightCyan: "#A3CFC7",
  brightWhite: "#FFF4E2",
};

const GRAPHITE: ITheme = {
  foreground: "#d6d3ce",
  cursor: "#e8e6e3",
  selectionBackground: "#3a3a3a",
  black: "#1e1e1e",
  red: "#f16c5f",
  green: "#93c474",
  yellow: "#e5c07b",
  blue: "#6aa9ff",
  magenta: "#c49bff",
  cyan: "#5fc4c0",
  white: "#d6d3ce",
  brightBlack: "#6b6b6b",
  brightRed: "#ff8a7f",
  brightGreen: "#b1dc94",
  brightYellow: "#f2d49b",
  brightBlue: "#94c1ff",
  brightMagenta: "#d9bcff",
  brightCyan: "#8fe0dc",
  brightWhite: "#ffffff",
};

const ZED: ITheme = {
  foreground: "#dce0e5",
  cursor: "#74ade8",
  selectionBackground: "#3b4252",
  black: "#282c33",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#dce0e5",
  brightBlack: "#5d636f",
  brightRed: "#ea858b",
  brightGreen: "#aad581",
  brightYellow: "#ffd885",
  brightBlue: "#85c1ff",
  brightMagenta: "#d398eb",
  brightCyan: "#6ed5de",
  brightWhite: "#fafafa",
};

export function terminalSurface(settings: Settings): string {
  if (settings.terminalTheme === "ide") return themeById(effectiveThemeId()).terminal.surface;
  if (settings.terminalTheme === "ember") {
    const scheme = get().info?.terminalScheme ?? EMBER_FALLBACK;
    return scheme.background ?? EMBER_FALLBACK.background;
  }
  return settings.terminalTheme === "zed" ? "#1c1c1e" : "#161616";
}

function themeFor(settings: Settings): ITheme {
  const transparent = "rgba(0,0,0,0)";
  const chrome = {
    background: transparent,
    scrollbarSliderBackground: "rgba(255,255,255,0.08)",
    scrollbarSliderHoverBackground: "rgba(255,255,255,0.16)",
    scrollbarSliderActiveBackground: "rgba(255,255,255,0.22)",
  };
  if (settings.terminalTheme === "ide") {
    const t = themeById(effectiveThemeId()).terminal;
    return { ...ZED, ...chrome, foreground: t.foreground, cursor: t.cursor, cursorAccent: t.surface, selectionBackground: t.selection };
  }
  if (settings.terminalTheme === "graphite") return { ...GRAPHITE, ...chrome };
  if (settings.terminalTheme === "zed") return { ...ZED, ...chrome };
  const s = { ...EMBER_FALLBACK, ...(get().info?.terminalScheme ?? {}) };
  return {
    ...chrome,
    foreground: s.foreground,
    cursor: s.cursorColor,
    cursorAccent: s.background,
    selectionBackground: s.selectionBackground,
    black: s.black,
    red: s.red,
    green: s.green,
    yellow: s.yellow,
    blue: s.blue,
    magenta: s.purple,
    cyan: s.cyan,
    white: s.white,
    brightBlack: s.brightBlack,
    brightRed: s.brightRed,
    brightGreen: s.brightGreen,
    brightYellow: s.brightYellow,
    brightBlue: s.brightBlue,
    brightMagenta: s.brightPurple,
    brightCyan: s.brightCyan,
    brightWhite: s.brightWhite,
  };
}

function findPane(paneId: string): Pane | undefined {
  const state = get();
  for (const w of [state.home, ...state.workspaces]) {
    for (const t of w.termTabs) {
      const pane = t.panes.find((p) => p.id === paneId);
      if (pane) return pane;
    }
  }
  return undefined;
}

export function updatePane(paneId: string, fn: (p: Pane) => Pane) {
  const current = findPane(paneId);
  if (!current) return;
  const next = fn(current);
  if (next === current) return;
  const patch = (w: Workspace): Workspace =>
    w.termTabs.some((t) => t.panes.some((p) => p.id === paneId))
      ? { ...w, termTabs: w.termTabs.map((t) => (t.panes.some((p) => p.id === paneId) ? { ...t, panes: t.panes.map((p) => (p.id === paneId ? next : p)) } : t)) }
      : w;
  set((s) => ({ home: patch(s.home), workspaces: s.workspaces.map(patch) }));
}

function buildNumber(): number {
  const match = navigator.userAgent.match(/Windows NT 10\.0/);
  return match ? 22621 : 19045;
}

export function ensureInstance(pane: Pane): Instance {
  const existing = instances.get(pane.id);
  if (existing) return existing;
  const settings = get().settings;
  const host = document.createElement("div");
  host.className = "xterm-host";
  const term = new Terminal({
    allowTransparency: true,
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorInactiveStyle: "outline",
    fontFamily: settings.terminalFont,
    fontSize: settings.terminalFontSize,
    lineHeight: 1.25,
    scrollback: 20000,
    smoothScrollDuration: 0,
    theme: themeFor(settings),
    windowsPty: { backend: "conpty", buildNumber: buildNumber() },
    rescaleOverlappingGlyphs: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_event, uri) => api.openExternal(uri).catch(() => {})));
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.open(host);
  const instance: Instance = { term, fit, host, started: false, alive: false, gpu: "pending" };
  term.onData((data) => {
    if (instance.alive) api.termWrite(pane.id, data).catch(() => {});
  });
  term.onResize(({ cols, rows }) => {
    if (instance.alive) api.termResize(pane.id, cols, rows).catch(() => {});
  });
  term.onTitleChange((title) => {
    const clean = title.replace(/^[^\p{L}\p{N}]+/u, "").trim();
    if (!clean || /^[a-z]:[\\/]/i.test(clean) || /\.exe$/i.test(clean) || /^(administrator|адміністратор):/i.test(clean)) return;
    const short = clean.slice(0, 60);
    updatePane(pane.id, (p) => (p.title === short ? p : { ...p, title: short }));
  });
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    const key = hotkey(event);
    if (event.ctrlKey && key === "c" && (event.shiftKey || term.hasSelection())) {
      const text = term.getSelection();
      if (text) navigator.clipboard.writeText(text).catch(() => {});
      term.clearSelection();
      return false;
    }
    if (event.ctrlKey && key === "v") return false;
    if (event.ctrlKey && (key === "p" || key === "b" || key === "`" || key === "j" || key === "tab" || key === "m")) return false;
    if (event.ctrlKey && event.shiftKey && (key === "p" || key === "f")) return false;
    return true;
  });
  instances.set(pane.id, instance);
  return instance;
}

export function fitPane(paneId: string) {
  const instance = instances.get(paneId);
  if (!instance || !instance.host.isConnected || instance.host.offsetWidth < 20 || instance.host.offsetHeight < 20) return;
  attachGpuRenderer(instance);
  try {
    instance.fit.fit();
  } catch {
    return;
  }
}

export function claudeCommand(sessionId: string | null, resume: boolean): string {
  if (!sessionId) return "claude";
  return resume ? `claude --resume ${sessionId}` : `claude --session-id ${sessionId}`;
}

export async function startPane(pane: Pane) {
  const instance = ensureInstance(pane);
  if (instance.started) return;
  instance.started = true;
  fitPane(pane.id);
  let startup: string | null = null;
  let resume = pane.resume;
  if (pane.kind === "claude") {
    if (pane.sessionId && pane.restored) {
      resume = await api.sessionExists(pane.accountId ?? "main", pane.sessionId).catch(() => false);
    }
    startup = claudeCommand(pane.sessionId, resume);
  }
  if (pane.command && !pane.restored) startup = pane.command;
  try {
    instance.alive = true;
    await api.termSpawn({
      id: pane.id,
      shellId: pane.shellId,
      cwd: pane.cwd,
      cols: Math.max(instance.term.cols, 20),
      rows: Math.max(instance.term.rows, 5),
      startup,
      accountId: pane.kind === "claude" ? pane.accountId : pane.accountId,
    });
    updatePane(pane.id, (p) => ({ ...p, restored: false, exited: false, command: null, resume: p.kind === "claude" && !!p.sessionId ? true : p.resume }));
  } catch (error) {
    instance.alive = false;
    instance.started = false;
    instance.term.write(`\r\n\x1b[31mНе вдалося запустити термінал: ${errorText(error)}\x1b[0m\r\n`);
  }
}

export async function restartPane(pane: Pane) {
  const instance = instances.get(pane.id);
  if (instance) {
    await api.termKill(pane.id).catch(() => {});
    instance.alive = false;
    instance.started = false;
    instance.term.reset();
  }
  updatePane(pane.id, (p) => ({ ...p, exited: false }));
  await startPane({ ...pane, restored: pane.kind === "claude" });
}

export function disposePane(paneId: string) {
  const instance = instances.get(paneId);
  api.termKill(paneId).catch(() => {});
  if (instance) {
    instance.term.dispose();
    instance.host.remove();
    instances.delete(paneId);
  }
}

export function focusPane(paneId: string) {
  instances.get(paneId)?.term.focus();
}

export function clearPane(paneId: string) {
  instances.get(paneId)?.term.clear();
}

export function writeToPane(paneId: string, text: string) {
  const instance = instances.get(paneId);
  if (instance?.alive) api.termWrite(paneId, text).catch(() => {});
}

export function isStarted(paneId: string): boolean {
  return instances.get(paneId)?.started ?? false;
}

export function applyTerminalSettings(settings: Settings) {
  for (const [id, instance] of instances) {
    instance.term.options.fontFamily = settings.terminalFont;
    instance.term.options.fontSize = settings.terminalFontSize;
    instance.term.options.theme = themeFor(settings);
    fitPane(id);
  }
}

export async function initTerminalEvents() {
  await listen<{ id: string; data: string }>("term-data", (event) => {
    instances.get(event.payload.id)?.term.write(event.payload.data);
  });
  await listen<{ id: string; code: number }>("term-exit", (event) => {
    const instance = instances.get(event.payload.id);
    if (!instance) return;
    instance.alive = false;
    instance.term.write(`\r\n\x1b[2m— процес завершився (код ${event.payload.code}) —\x1b[0m\r\n`);
    updatePane(event.payload.id, (p) => ({ ...p, exited: true }));
  });
}
