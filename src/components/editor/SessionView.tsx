import { useEffect, useMemo, useState } from "react";
import { Play, Copy, FolderOpen, RefreshCw, Wrench, User, TerminalSquare } from "lucide-react";
import { api, errorText, type Transcript } from "../../ipc";
import { useStore, type Tab } from "../../store";
import { copyText, openChatSession, resumeSession } from "../../actions";
import { ClaudeIcon } from "../ClaudeIcon";
import { handleMarkdownClick, renderMarkdown } from "../../markdown";

type SessionTab = Extract<Tab, { kind: "session" }>;

function MessageBody({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="md" onClick={handleMarkdownClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function SessionView({ tab }: { tab: SessionTab }) {
  const [data, setData] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessions = useStore((s) => s.sessions);
  const accounts = useStore((s) => s.accounts);
  const info = sessions.find((s) => s.id === tab.sessionId && s.accountId === tab.accountId);
  const account = accounts.find((a) => a.id === tab.accountId);
  const load = () => {
    setError(null);
    api
      .sessionRead(tab.file)
      .then(setData)
      .catch((e) => setError(errorText(e)));
  };
  useEffect(load, [tab.file]);
  const target = info ?? { id: tab.sessionId, accountId: tab.accountId, title: tab.title, firstPrompt: "", cwd: tab.cwd, gitBranch: "", modified: 0, size: 0, file: tab.file };
  const resume = () => resumeSession(target);
  return (
    <div className="session-view">
      <div className="session-header">
        <div className="session-header-main">
          <div className="session-header-title">{tab.title}</div>
          <div className="session-header-meta">
            {account && (
              <span className="meta-pill">
                <span className="dot" style={{ background: account.color }} />
                {account.label}
              </span>
            )}
            {tab.cwd && <span className="meta-pill mono">{tab.cwd}</span>}
            {info?.gitBranch && <span className="meta-pill mono">{info.gitBranch}</span>}
            {data && <span className="meta-pill">{data.total} повідомлень</span>}
          </div>
        </div>
        <div className="session-header-actions">
          <button className="icon-btn" title="Оновити" onClick={load}>
            <RefreshCw size={14} />
          </button>
          <button className="icon-btn" title="Копіювати команду" onClick={() => copyText(`claude --resume ${tab.sessionId}`)}>
            <Copy size={14} />
          </button>
          <button className="icon-btn" title="Показати файл сесії" onClick={() => api.reveal(tab.file)}>
            <FolderOpen size={14} />
          </button>
          <button className="btn" onClick={resume}>
            <Play size={13} /> У терміналі
          </button>
          <button className="btn primary" onClick={() => openChatSession(target)}>
            <ClaudeIcon size={13} color="currentColor" /> Продовжити в чаті
          </button>
        </div>
      </div>
      <div className="transcript">
        {error && <div className="file-message error">{error}</div>}
        {!data && !error && <div className="file-message">Читаю розмову…</div>}
        {data && data.total > data.messages.length && <div className="transcript-note">Показано останні {data.messages.length} з {data.total}</div>}
        {data?.messages.map((m, index) => {
          if (m.role === "command") {
            return (
              <div key={index} className="msg-command">
                <TerminalSquare size={12} /> {m.text}
              </div>
            );
          }
          if (m.role === "user") {
            return (
              <div key={index} className="msg msg-user">
                <div className="msg-avatar">
                  <User size={13} />
                </div>
                <div className="msg-bubble">
                  <div className="msg-text">{m.text}</div>
                </div>
              </div>
            );
          }
          return (
            <div key={index} className="msg msg-assistant">
              <div className="msg-avatar claude">C</div>
              <div className="msg-content">
                {m.text && <MessageBody text={m.text} />}
                {m.tools.length > 0 && (
                  <div className="tool-chips">
                    {m.tools.slice(0, 24).map((t, i) => (
                      <span key={i} className="tool-chip" title={t.detail}>
                        <Wrench size={10} />
                        <b>{t.name}</b>
                        {t.detail && <span className="tool-detail">{t.detail}</span>}
                      </span>
                    ))}
                    {m.tools.length > 24 && <span className="tool-chip">+{m.tools.length - 24}</span>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
