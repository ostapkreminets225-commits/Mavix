import { GitBranch, SquareTerminal, Blocks, CircleDot, Bell } from "lucide-react";
import { set, useActiveWorkspace, useStore } from "../store";
import { defaultAccountFor, setActivity, togglePanel } from "../actions";
import { themeById } from "../themes";

export function StatusBar() {
  const ws = useActiveWorkspace();
  const branch = useStore((s) => s.branches[ws.id]);
  const cursor = useStore((s) => s.cursor);
  const language = useStore((s) => s.language);
  const dirtyCount = useStore((s) => Object.keys(s.dirty).length);
  const accounts = useStore((s) => s.accounts);
  useStore((s) => s.settings.defaultAccountId);
  const skills = useStore((s) => s.skills);
  const terminals = useStore((s) => [s.home, ...s.workspaces].reduce((n, w) => n + w.termTabs.reduce((m, t) => m + t.panes.length, 0), 0));
  const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
  const account = accounts.find((a) => a.id === defaultAccountFor(ws)) ?? accounts[0];
  const session = account?.usage?.limits.find((l) => l.kind === "session" || l.kind === "five_hour");
  const weekly = account?.usage?.limits.find((l) => l.kind === "weekly_all" || l.kind === "seven_day");
  const enabled = skills?.skills.filter((s) => s.enabled).length ?? 0;
  return (
    <footer className="statusbar">
      <div className="status-left">
        {ws.root ? (
          <span className="status-item strong">
            <span className="status-dot" style={{ background: ws.themeId ? themeById(ws.themeId).swatches[3] : ws.color }} />
            {ws.name}
          </span>
        ) : (
          <span className="status-item strong">Mavix</span>
        )}
        {branch && (
          <span className="status-item">
            <GitBranch size={12} /> {branch}
          </span>
        )}
        {dirtyCount > 0 && (
          <span className="status-item warn">
            <CircleDot size={11} /> {dirtyCount} не збережено
          </span>
        )}
      </div>
      <div className="status-right">
        {tab?.kind === "file" && cursor && (
          <span className="status-item">
            Рд {cursor.line}, Ст {cursor.col}
            {cursor.selected > 0 ? ` (${cursor.selected} виділено)` : ""}
          </span>
        )}
        {tab?.kind === "file" && language && <span className="status-item">{language}</span>}
        <button className="status-item btnish" onClick={() => setActivity("skills")} title="Скіли Claude">
          <Blocks size={12} /> {enabled}
        </button>
        <button className="status-item btnish" onClick={togglePanel} title="Термінали">
          <SquareTerminal size={12} /> {terminals}
        </button>
        {account && (
          <button className="status-item btnish" onClick={() => setActivity("accounts")} title={account.email ?? account.label}>
            <span className="status-dot" style={{ background: account.color }} />
            {account.label}
            {session && <span className="status-usage">5г {Math.round(session.percent)}%</span>}
            {weekly && <span className="status-usage">7д {Math.round(weekly.percent)}%</span>}
          </button>
        )}
        <button className="status-item btnish" onClick={() => set({ palette: { mode: "commands", query: "" } })} title="Команди (Ctrl Shift P)">
          <Bell size={12} />
        </button>
      </div>
    </footer>
  );
}
