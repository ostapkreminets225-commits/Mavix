import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api } from "./ipc";
import { activeWorkspace, confirm, flushSave, get, loadPersisted, set, useStore } from "./store";
import {
  autoStructure,
  closeTab,
  cycleProject,
  cycleTab,
  handleDrop,
  loadDir,
  newChat,
  newTerminal,
  openFolderDialog,
  openSettings,
  refreshAccounts,
  refreshExpanded,
  refreshRules,
  refreshSkillUsage,
  refreshSkills,
  refreshTemplates,
  saveCurrent,
  setActivity,
  switchProject,
  toggleSidebar,
  togglePanel,
} from "./actions";
import { applyTerminalSettings, initTerminalEvents } from "./terminals";
import { initChatEvents } from "./chat";
import { rebuildAllStates } from "./docs";
import { applyTheme } from "./themes";
import { hotkey } from "./util";
import { focusPane as focusMultiPane, toggleMulti, useMulti } from "./multi";
import { MultiPicker, MultiView } from "./components/MultiView";
import { TitleBar } from "./components/TitleBar";
import { ActivityBar } from "./components/ActivityBar";
import { Sidebar } from "./components/Sidebar";
import { EditorArea } from "./components/EditorArea";
import { TerminalPanel } from "./components/TerminalPanel";
import { StatusBar } from "./components/StatusBar";
import { Palette } from "./components/Palette";
import { Overlays } from "./components/Overlays";
import { Resizer } from "./components/Resizer";

let booted = false;

async function boot() {
  if (booted) return;
  booted = true;
  const info = await api.appInfo();
  set({ info });
  const restored = await loadPersisted();
  if (!restored && info.terminalImage) {
    set((s) => ({ settings: { ...s.settings, terminalImage: info.terminalImage, terminalImageOpacity: info.terminalImageOpacity ?? 0.38 } }));
  }
  await initTerminalEvents();
  await initChatEvents();
  set({ ready: true });
  const state = get();
  for (const ws of state.workspaces) {
    if (!ws.root) continue;
    loadDir(ws.root);
    ws.expanded.forEach((p) => loadDir(p));
    api.gitBranch(ws.root).then((branch) => set((s) => ({ branches: { ...s.branches, [ws.id]: branch } })));
  }
  refreshAccounts();
  refreshRules();
  refreshTemplates().then(() => get().workspaces.forEach((w) => autoStructure(w)));
  refreshSkills();
  window.setTimeout(() => refreshSkillUsage(), 2500);
  api.accountsSync().catch(() => {});
}

function useGlobalKeys() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = hotkey(event);
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && !event.shiftKey && !event.altKey && key === "m") {
        event.preventDefault();
        event.stopPropagation();
        toggleMulti();
        return;
      }
      if (useMulti.getState().open) {
        if (event.altKey && !ctrl && /^[1-9]$/.test(key)) {
          event.preventDefault();
          focusMultiPane(Number(key));
          return;
        }
        if (!ctrl || !(key === "p" || key === "," || key === "s" || key === "o")) return;
      }
      if (ctrl && !event.shiftKey && key === "p") {
        event.preventDefault();
        set({ palette: { mode: "files", query: "" } });
      } else if (ctrl && event.shiftKey && key === "p") {
        event.preventDefault();
        set({ palette: { mode: "commands", query: "" } });
      } else if (ctrl && event.shiftKey && key === "f") {
        event.preventDefault();
        set({ activity: "search", sidebarVisible: true });
      } else if (ctrl && event.shiftKey && key === "e") {
        event.preventDefault();
        setActivity("files");
      } else if (ctrl && key === "o" && !event.shiftKey) {
        event.preventDefault();
        openFolderDialog();
      } else if (ctrl && key === "s" && !event.shiftKey) {
        event.preventDefault();
        saveCurrent();
      } else if (ctrl && key === "w" && !event.shiftKey) {
        event.preventDefault();
        const ws = activeWorkspace();
        if (ws.activeTabId) closeTab(ws.activeTabId);
      } else if (ctrl && key === "b" && !event.shiftKey) {
        event.preventDefault();
        toggleSidebar();
      } else if (ctrl && (key === "`" || key === "j") && !event.shiftKey) {
        event.preventDefault();
        togglePanel();
      } else if (ctrl && event.shiftKey && (key === "`" || key === "~")) {
        event.preventDefault();
        newTerminal();
      } else if (ctrl && event.shiftKey && key === "l") {
        event.preventDefault();
        newChat();
      } else if (ctrl && key === "tab") {
        event.preventDefault();
        cycleTab(event.shiftKey ? -1 : 1);
      } else if (ctrl && key === ",") {
        event.preventDefault();
        openSettings();
      } else if (event.altKey && /^[0-9]$/.test(key)) {
        event.preventDefault();
        const index = Number(key);
        if (index === 0) switchProject(null);
        else {
          const ws = get().workspaces[index - 1];
          if (ws) switchProject(ws.id);
        }
      } else if (event.altKey && (key === "arrowright" || key === "arrowleft") && event.shiftKey) {
        event.preventDefault();
        cycleProject(key === "arrowright" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

function useWindowHooks() {
  useEffect(() => {
    const unlisteners: Promise<() => void>[] = [];
    unlisteners.push(
      getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") set({ dragOver: true });
        else if (payload.type === "leave") set({ dragOver: false });
        else if (payload.type === "drop") {
          set({ dragOver: false });
          handleDrop(payload.paths);
        }
      }),
    );
    unlisteners.push(
      getCurrentWindow().onCloseRequested(async (event) => {
        flushSave();
        const dirty = Object.keys(get().dirty);
        if (dirty.length === 0 || !get().settings.confirmClose) return;
        event.preventDefault();
        const ok = await confirm("Вийти з Mavix?", `Незбережених файлів: ${dirty.length}. Зміни буде втрачено.`, true, "Вийти");
        if (ok) await getCurrentWindow().destroy();
      }),
    );
    const timer = window.setInterval(() => {
      if (document.hasFocus()) refreshExpanded();
    }, 2500);
    const branchTimer = window.setInterval(() => {
      for (const ws of get().workspaces) {
        if (ws.root) api.gitBranch(ws.root).then((branch) => {
          if (get().branches[ws.id] !== branch) set((s) => ({ branches: { ...s.branches, [ws.id]: branch } }));
        });
      }
    }, 6000);
    const onFocus = () => refreshAccounts();
    window.addEventListener("focus", onFocus);
    return () => {
      unlisteners.forEach((p) => p.then((off) => off()));
      window.clearInterval(timer);
      window.clearInterval(branchTimer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
}

function useThemeVars() {
  const uiTheme = useStore((s) => (s.workspaces.find((w) => w.id === s.activeId) ?? s.home).themeId ?? s.settings.uiTheme);
  const uiSize = useStore((s) => s.settings.uiFontSize);
  const settings = useStore((s) => s.settings);
  const editorKey = `${settings.editorFontSize}|${settings.editorWrap}`;
  const terminalKey = `${settings.terminalFont}|${settings.terminalFontSize}|${settings.terminalTheme}|${uiTheme}`;
  useEffect(() => {
    applyTheme(uiTheme);
  }, [uiTheme]);
  useEffect(() => {
    document.documentElement.style.setProperty("--ui-size", `${uiSize}px`);
  }, [uiSize]);
  useEffect(() => {
    applyTerminalSettings(get().settings);
  }, [terminalKey]);
  useEffect(() => {
    rebuildAllStates();
    set((s) => ({ editorEpoch: s.editorEpoch + 1 }));
  }, [editorKey]);
  useEffect(() => {
    const path = settings.terminalImage;
    if (!path) {
      set({ terminalImageUrl: null });
      return;
    }
    api.imageDataUrl(path).then((url) => set({ terminalImageUrl: url })).catch(() => set({ terminalImageUrl: null }));
  }, [settings.terminalImage]);
}

export function App() {
  const ready = useStore((s) => s.ready);
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const panelMaximized = useStore((s) => s.panelMaximized);
  const panelVisible = useStore((s) => s.panelVisible);
  const multiOpen = useMulti((s) => s.open);
  useEffect(() => {
    boot();
  }, []);
  useGlobalKeys();
  useWindowHooks();
  useThemeVars();
  if (!ready) {
    return (
      <div className="boot">
        <div className="boot-mark">M</div>
      </div>
    );
  }
  return (
    <div className="app">
      <TitleBar />
      {multiOpen ? (
        <MultiView />
      ) : (
        <div className="body">
          <ActivityBar />
          {sidebarVisible && (
            <>
              <Sidebar />
              <Resizer kind="sidebar" />
            </>
          )}
          <div className="main">
            <div className={`editor-zone${panelMaximized && panelVisible ? " hidden" : ""}`}>
              <EditorArea />
            </div>
            {panelVisible && !panelMaximized && <Resizer kind="panel" />}
            <TerminalPanel />
          </div>
        </div>
      )}
      <StatusBar />
      <Palette />
      <MultiPicker />
      <Overlays />
    </div>
  );
}
