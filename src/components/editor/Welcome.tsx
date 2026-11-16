import { useEffect } from "react";
import { FolderOpen, FolderPlus, MessageSquarePlus, Blocks, SquareTerminal, Search, Play, ArrowUpRight } from "lucide-react";
import { set, useActiveWorkspace, useStore } from "../../store";
import {
  newChat,
  newClaudeSession,
  newTerminal,
  openFolderDialog,
  openNewSkill,
  openChatSession,
  openProject,
  refreshSessions,
  setActivity,
} from "../../actions";
import { Meter } from "../ui";
import { FileIcon } from "../FileIcon";
import { basename, isInside, relativeTime } from "../../util";

export function Welcome() {
  const ws = useActiveWorkspace();
  const recent = useStore((s) => s.recent);
  const accounts = useStore((s) => s.accounts);
  const skills = useStore((s) => s.skills);
  const sessions = useStore((s) => s.sessions);
  useEffect(() => {
    if (sessions.length === 0) refreshSessions();
  }, [sessions.length]);
  const relevant = (ws.root ? sessions.filter((s) => isInside(ws.root!, s.cwd)) : sessions).slice(0, 6);
  const enabled = skills?.skills.filter((s) => s.enabled).length ?? 0;
  const always = skills?.skills.filter((s) => s.always).length ?? 0;
  const actions = [
    { icon: FolderOpen, label: "Відкрити папку", keys: "Ctrl O", run: openFolderDialog },
    { icon: FolderPlus, label: "Новий проект зі структурою", keys: "", run: () => window.dispatchEvent(new CustomEvent("mavix:new-project")) },
    { icon: MessageSquarePlus, label: ws.root ? `Новий чат з Claude у ${ws.name}` : "Новий чат з Claude", keys: "Ctrl Shift L", run: () => newChat() },
    { icon: SquareTerminal, label: "Claude у терміналі", keys: "", run: () => newClaudeSession() },
    { icon: SquareTerminal, label: "Новий термінал", keys: "Ctrl Shift `", run: () => newTerminal() },
    { icon: Search, label: "Знайти файл або команду", keys: "Ctrl P", run: () => set({ palette: { mode: "files", query: "" } }) },
    { icon: Blocks, label: "Додати скіл з Markdown", keys: "", run: () => openNewSkill() },
  ];
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-left">
          <div className="wordmark">
            <span className="wordmark-m">M</span>
            <div>
              <div className="wordmark-name">{ws.root ? ws.name : "Mavix"}</div>
              <div className="wordmark-sub">{ws.root ? ws.root : "Проекти, термінал і Claude — в одному вікні"}</div>
            </div>
          </div>
          <div className="section-label">Почати</div>
          <div className="action-list">
            {actions.map(({ icon: Icon, label, keys, run }) => (
              <button key={label} className="action-item" onClick={run}>
                <Icon size={16} strokeWidth={1.6} />
                <span className="grow">{label}</span>
                {keys && <kbd className="kbd">{keys}</kbd>}
              </button>
            ))}
          </div>
          {!ws.root && recent.length > 0 && (
            <>
              <div className="section-label">Нещодавні проекти</div>
              <div className="recent-grid">
                {recent.slice(0, 8).map((r) => (
                  <button key={r} className="recent-card" onClick={() => openProject(r)} title={r}>
                    <FileIcon name={basename(r)} dir />
                    <div className="recent-text">
                      <span className="recent-name">{basename(r)}</span>
                      <span className="recent-path">{r}</span>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="welcome-right">
          <div className="panel-card">
            <div className="panel-card-head">
              <span className="section-label flat">Акаунти Claude</span>
              <button className="link-btn" onClick={() => setActivity("accounts")}>
                Керувати <ArrowUpRight size={12} />
              </button>
            </div>
            {accounts.map((a) => (
              <div key={a.id} className="mini-account">
                <div className="mini-account-head">
                  <span className="avatar" style={{ background: a.color }}>
                    {a.label.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="grow ellipsis">
                    {a.label}
                    <span className="muted"> {a.email ?? (a.loggedIn ? "" : "· вхід не виконано")}</span>
                  </span>
                  {a.plan && <span className="plan-badge">{a.plan}</span>}
                </div>
                {a.usage?.limits.slice(0, 3).map((l) => <Meter key={l.kind + l.label} limit={l} />)}
              </div>
            ))}
          </div>
          <div className="panel-card">
            <div className="panel-card-head">
              <span className="section-label flat">Скіли</span>
              <button className="link-btn" onClick={() => setActivity("skills")}>
                Відкрити <ArrowUpRight size={12} />
              </button>
            </div>
            <div className="stat-row">
              <div className="stat">
                <span className="stat-value">{enabled}</span>
                <span className="stat-label">увімкнено</span>
              </div>
              <div className="stat">
                <span className="stat-value">{(skills?.skills.length ?? 0) - enabled}</span>
                <span className="stat-label">вимкнено</span>
              </div>
              <div className="stat">
                <span className="stat-value">{always}</span>
                <span className="stat-label">завжди</span>
              </div>
            </div>
          </div>
          {relevant.length > 0 && (
            <div className="panel-card">
              <div className="panel-card-head">
                <span className="section-label flat">{ws.root ? "Сесії цього проекту" : "Останні сесії"}</span>
                <button className="link-btn" onClick={() => setActivity("claude")}>
                  Усі <ArrowUpRight size={12} />
                </button>
              </div>
              {relevant.map((s) => (
                <button key={s.accountId + s.id} className="mini-session" onClick={() => openChatSession(s)} title="Продовжити в чаті">
                  <Play size={12} className="accent" />
                  <span className="grow ellipsis">{s.title}</span>
                  <span className="muted small">{relativeTime(s.modified)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
