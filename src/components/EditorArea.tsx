import { useRef } from "react";
import { X, Settings, MessagesSquare, Blocks, Sparkles, FolderTree } from "lucide-react";
import { openMenu, useActiveWorkspace, useStore, type Tab } from "../store";
import { activateTab, closeOtherTabs, closeTab, copyText, moveTab } from "../actions";
import { api } from "../ipc";
import { FileIcon } from "./FileIcon";
import { CodeEditor } from "./editor/CodeEditor";
import { Welcome } from "./editor/Welcome";
import { SessionView } from "./editor/SessionView";
import { SkillDetail } from "./editor/SkillDetail";
import { NewSkill } from "./editor/NewSkill";
import { StructureEditor } from "./editor/StructureEditor";
import { SettingsView } from "./editor/SettingsView";
import { ChatView } from "./editor/ChatView";
import { ClaudeIcon } from "./ClaudeIcon";
import { useChats } from "../chat";
import { relativePath } from "../util";

function TabIcon({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case "file":
      return <FileIcon name={tab.title} size={14} />;
    case "chat":
      return <ChatTabIcon tabId={tab.id} />;
    case "settings":
      return <Settings size={14} strokeWidth={1.6} className="tab-glyph" />;
    case "session":
      return <MessagesSquare size={14} strokeWidth={1.6} className="tab-glyph accent" />;
    case "skill":
      return <Blocks size={14} strokeWidth={1.6} className="tab-glyph accent" />;
    case "new-skill":
      return <Sparkles size={14} strokeWidth={1.6} className="tab-glyph accent" />;
    case "structure":
      return <FolderTree size={14} strokeWidth={1.6} className="tab-glyph" />;
  }
}

function ChatTabIcon({ tabId }: { tabId: string }) {
  const busy = useChats((s) => s[tabId]?.busy ?? false);
  const waiting = useChats((s) => (s[tabId]?.requests.length ?? 0) > 0);
  return <ClaudeIcon size={14} className={`tab-claude${busy ? " claude-spin" : ""}${waiting ? " waiting" : ""}`} />;
}

function TabBar() {
  const ws = useActiveWorkspace();
  const dirty = useStore((s) => s.dirty);
  const dragId = useRef<string | null>(null);
  if (ws.tabs.length === 0) return null;
  return (
    <div className="tabbar" onWheel={(e) => (e.currentTarget.scrollLeft += e.deltaY)}>
      {ws.tabs.map((tab, index) => {
        const isDirty = tab.kind === "file" && dirty[tab.path];
        return (
          <div
            key={tab.id}
            className={`tab${tab.id === ws.activeTabId ? " active" : ""}${isDirty ? " dirty" : ""}`}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(tab.id);
              } else if (e.button === 0) activateTab(tab.id);
            }}
            draggable
            onDragStart={() => (dragId.current = tab.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragId.current && dragId.current !== tab.id) moveTab(dragId.current, index);
              dragId.current = null;
            }}
            onContextMenu={(e) =>
              openMenu(e, [
                { label: "Закрити", shortcut: "Ctrl W", action: () => closeTab(tab.id) },
                { label: "Закрити інші", action: () => closeOtherTabs(tab.id) },
                ...(tab.kind === "file"
                  ? [
                      "separator" as const,
                      { label: "Копіювати шлях", action: () => copyText(tab.path) },
                      { label: "Копіювати відносний шлях", action: () => copyText(ws.root ? relativePath(ws.root, tab.path) : tab.path) },
                      { label: "Показати в Провіднику", action: () => api.reveal(tab.path) },
                    ]
                  : []),
              ])
            }
            title={tab.kind === "file" ? tab.path : tab.title}
          >
            <TabIcon tab={tab} />
            <span className="tab-title">{tab.title}</span>
            <button
              className="tab-close"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
            >
              <span className="tab-dot" />
              <X size={13} className="tab-x" />
            </button>
          </div>
        );
      })}
      <div className="tabbar-fill" />
    </div>
  );
}

export function EditorArea() {
  const ws = useActiveWorkspace();
  const tab = ws.tabs.find((t) => t.id === ws.activeTabId) ?? null;
  return (
    <div className="editor-area">
      <TabBar />
      <div className="editor-body">
        {!tab && <Welcome />}
        {tab?.kind === "file" && <CodeEditor key={ws.id} tab={tab} root={ws.root} />}
        {tab?.kind === "chat" && <ChatView key={tab.id} tab={tab} />}
        {tab?.kind === "session" && <SessionView key={tab.id} tab={tab} />}
        {tab?.kind === "skill" && <SkillDetail key={tab.id} tab={tab} />}
        {tab?.kind === "new-skill" && <NewSkill key={tab.id} tab={tab} />}
        {tab?.kind === "structure" && <StructureEditor key={tab.id} tab={tab} />}
        {tab?.kind === "settings" && <SettingsView />}
      </div>
    </div>
  );
}
