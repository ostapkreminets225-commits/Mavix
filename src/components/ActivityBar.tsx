import { Files, Search, Blocks, Users, FolderTree, Settings, SquareTerminal, ScrollText } from "lucide-react";
import { useStore, type Activity } from "../store";
import { openSettings, setActivity, togglePanel } from "../actions";
import { ClaudeIcon } from "./ClaudeIcon";
import { SlackIcon } from "./SlackIcon";

function ClaudeGlyph({ size }: { size?: number; strokeWidth?: number }) {
  return <ClaudeIcon size={(size ?? 19) + 2} className="activity-claude" />;
}

function SlackGlyph({ size }: { size?: number; strokeWidth?: number }) {
  return <SlackIcon size={(size ?? 19) - 2} className="activity-slack" />;
}

const ITEMS: { id: Activity; label: string; icon: React.ComponentType<{ size?: number; strokeWidth?: number }>; keys?: string }[] = [
  { id: "files", label: "Файли", icon: Files, keys: "Ctrl Shift E" },
  { id: "search", label: "Пошук у проекті", icon: Search, keys: "Ctrl Shift F" },
  { id: "claude", label: "Claude — чати і сесії", icon: ClaudeGlyph },
  { id: "rules", label: "Правила для Claude — діють завжди і всюди", icon: ScrollText },
  { id: "slack", label: "Slack — чати, які читає Claude", icon: SlackGlyph },
  { id: "skills", label: "Скіли Claude", icon: Blocks },
  { id: "accounts", label: "Акаунти Claude", icon: Users },
  { id: "structure", label: "Структура папок", icon: FolderTree },
];

export function ActivityBar() {
  const activity = useStore((s) => s.activity);
  const visible = useStore((s) => s.sidebarVisible);
  const panelVisible = useStore((s) => s.panelVisible);
  const skills = useStore((s) => s.skills);
  const issues = skills?.skills.filter((s) => s.enabled && s.scope !== "plugin" && s.issues.some((i) => i.startsWith("Немає"))).length ?? 0;
  return (
    <nav className="activity">
      {ITEMS.map(({ id, label, icon: Icon, keys }) => (
        <button
          key={id}
          className={`activity-item${activity === id && visible ? " active" : ""}`}
          onClick={() => setActivity(id)}
          title={keys ? `${label} (${keys})` : label}
        >
          <Icon size={19} strokeWidth={1.55} />
          {id === "skills" && issues > 0 && <span className="activity-badge">{issues}</span>}
        </button>
      ))}
      <div className="activity-spacer" />
      <button className={`activity-item${panelVisible ? " lit" : ""}`} onClick={togglePanel} title="Термінал (Ctrl `)">
        <SquareTerminal size={19} strokeWidth={1.55} />
      </button>
      <button className="activity-item" onClick={openSettings} title="Налаштування (Ctrl ,)">
        <Settings size={19} strokeWidth={1.55} />
      </button>
    </nav>
  );
}
