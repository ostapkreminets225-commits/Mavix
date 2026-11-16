import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ChevronDown, ChevronRight, Copy, Plus, RotateCw, SquareTerminal } from "lucide-react";
import { ensureChat, restartChat, switchChatAccount, useChats, type Chat, type ChatItem, type LiveBlock } from "../../chat";
import { openMenu, toast, useStore, type MenuItem, type Tab } from "../../store";
import { connectAccount, copyText, newChat, openFile, resumeSession, updateChatTab } from "../../actions";
import { errorText } from "../../ipc";
import { ClaudeIcon } from "../ClaudeIcon";
import { FileIcon } from "../FileIcon";
import { Composer } from "../chat/Composer";
import { RequestCard } from "../chat/Requests";
import { Markdown, ToolView, toolLabel } from "../chat/ToolView";
import { basename } from "../../util";

type ChatTab = Extract<Tab, { kind: "chat" }>;

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const UserBubble = memo(function UserBubble({ item }: { item: Extract<ChatItem, { kind: "user" }> }) {
  return (
    <div className="cu">
      <div className="cu-top">
        {item.files.map((file) => (
          <button key={file} className="cu-file" onClick={() => openFile(file)} title={file}>
            <FileIcon name={basename(file)} size={13} />
            {basename(file)}
          </button>
        ))}
        {item.images > 0 && !item.previews?.length && <span className="cu-file">зображень: {item.images}</span>}
        <span className="cu-time">{formatTime(item.time)}</span>
      </div>
      {!!item.previews?.length && (
        <div className="cu-images">
          {item.previews.map((url, i) => (
            <img key={i} src={url} alt="" />
          ))}
        </div>
      )}
      {item.text && <div className="cu-text">{item.text}</div>}
    </div>
  );
});

const Thinking = memo(function Thinking({ item }: { item: Extract<ChatItem, { kind: "thinking" }> }) {
  const [open, setOpen] = useState(false);
  const label = item.seconds !== null ? `Думав ${formatSeconds(item.seconds)}` : "Думав";
  const expandable = item.text.trim().length > 0;
  return (
    <div className="ci ci-thinking">
      <button className={`ci-thinking-head${expandable ? " can" : ""}`} onClick={() => expandable && setOpen(!open)}>
        {label}
        {expandable && <ChevronRight size={12} className={open ? "rot" : ""} />}
      </button>
      {open && <div className="ci-thinking-body">{item.text}</div>}
    </div>
  );
});

const ItemView = memo(function ItemView({ item, cwd }: { item: ChatItem; cwd: string }) {
  switch (item.kind) {
    case "user":
      return <UserBubble item={item} />;
    case "text":
      return (
        <div className="ci ci-text">
          <Markdown source={item.text} />
        </div>
      );
    case "thinking":
      return <Thinking item={item} />;
    case "tool":
      return <ToolView item={item} cwd={cwd} />;
    case "note":
      return <div className={`ci ci-note ${item.tone}`}>{item.text}</div>;
  }
});

function LiveView({ live }: { live: LiveBlock }) {
  if (live.kind === "text") {
    return (
      <div className="ci ci-text live">
        <Markdown source={live.text} />
      </div>
    );
  }
  if (live.kind === "thinking") {
    return (
      <div className="ci ci-thinking live">
        <span className="shimmer">Думаю…</span>
        {live.text && <div className="ci-thinking-body">{live.text.slice(-900)}</div>}
      </div>
    );
  }
  return (
    <div className="ci ci-tool run live">
      <div className="ct-head">
        <span className="ct-name">{toolLabel(live.name)}</span>
        <span className="ct-target shimmer">готую…</span>
      </div>
    </div>
  );
}

function Working({ chat }: { chat: Chat }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = chat.turnStartedAt ? (Date.now() - chat.turnStartedAt) / 1000 : 0;
  const runningTool = [...chat.items].reverse().find((i) => i.kind === "tool" && i.result === null);
  const verb =
    chat.status === "compacting"
      ? "Стискаю контекст"
      : chat.status === "retrying"
        ? "Повторюю запит"
        : chat.requests.length
          ? "Чекаю на твою відповідь"
          : chat.live?.kind === "thinking"
            ? "Думаю"
            : chat.live?.kind === "text"
              ? "Пишу"
              : chat.live?.kind === "tool"
                ? "Готую інструмент"
                : runningTool && runningTool.kind === "tool"
                  ? `Виконую ${toolLabel(runningTool.name)}`
                  : "Працюю";
  const tokens = Math.round(chat.turnChars / 4);
  return (
    <div className="chat-working">
      <ClaudeIcon size={15} className="claude-spin" />
      <span className="shimmer">{verb}…</span>
      <span className="chat-working-meta">
        {formatSeconds(seconds)}
        {tokens > 0 ? ` · ${tokens.toLocaleString()} токенів` : ""} · Esc — зупинити
      </span>
    </div>
  );
}

function Empty({ chat }: { chat: Chat }) {
  return (
    <div className="chat-empty">
      <ClaudeIcon size={44} />
      <div className="chat-empty-title">Що робимо?</div>
      <div className="chat-empty-sub">
        Claude працює в <b>{chat.cwd}</b>
        {chat.email ? ` · ${chat.email}` : ""}
      </div>
      <div className="chat-empty-hints">
        <span>
          <kbd className="kbd">Enter</kbd> надіслати
        </span>
        <span>
          <kbd className="kbd">Shift Enter</kbd> новий рядок
        </span>
        <span>
          <kbd className="kbd">/</kbd> команди і скіли
        </span>
        <span>
          <kbd className="kbd">Shift Tab</kbd> режим
        </span>
      </div>
    </div>
  );
}

type Group = { kind: "user"; item: ChatItem } | { kind: "run"; key: string; items: ChatItem[] };

function groupItems(items: ChatItem[]): Group[] {
  const groups: Group[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      groups.push({ kind: "user", item });
      continue;
    }
    const last = groups[groups.length - 1];
    if (last?.kind === "run") last.items.push(item);
    else groups.push({ kind: "run", key: item.id, items: [item] });
  }
  return groups;
}

const FIRST_WINDOW = 120;
const EARLIER_STEP = 100;
const EARLIER_TRIGGER_PX = 160;

function Timeline({ chat }: { chat: Chat }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const anchor = useRef<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [from, setFrom] = useState<number | null>(null);
  const start = from ?? Math.max(0, chat.items.length - FIRST_WINDOW);
  const visible = useMemo(() => (start > 0 ? chat.items.slice(start) : chat.items), [chat.items, start]);
  const groups = useMemo(() => groupItems(visible), [visible]);
  const tailIsRun = groups[groups.length - 1]?.kind === "run";
  const showTail = !!chat.live || chat.busy;

  useEffect(() => {
    if (from === null && chat.historyLoaded) setFrom(Math.max(0, chat.items.length - FIRST_WINDOW));
  }, [from, chat.historyLoaded, chat.items.length]);

  const showEarlier = () => {
    const el = scroller.current;
    if (!el || start === 0 || anchor.current !== null) return;
    anchor.current = el.scrollHeight - el.scrollTop;
    setFrom(Math.max(0, start - EARLIER_STEP));
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && anchor.current !== null) {
      el.scrollTop = el.scrollHeight - anchor.current;
      anchor.current = null;
    }
  }, [start]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat.items, chat.live, chat.busy, chat.requests, chat.historyLoaded]);

  const tail = showTail && (
    <>
      {chat.live && <LiveView live={chat.live} />}
      {chat.busy && <Working chat={chat} />}
    </>
  );

  return (
    <div className="chat-scroll-wrap">
      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stick.current = near;
          if (near !== atBottom) setAtBottom(near);
          if (el.scrollTop < EARLIER_TRIGGER_PX && start > 0) showEarlier();
        }}
      >
        <div className="chat-thread">
          {!chat.historyLoaded && <div className="chat-loading">Відкриваю розмову…</div>}
          {start > 0 && (
            <button className="chat-earlier" onClick={showEarlier}>
              Показати попередні · ще {start}
            </button>
          )}
          {chat.historyLoaded && chat.items.length === 0 && !chat.busy && <Empty chat={chat} />}
          {groups.map((group, index) =>
            group.kind === "user" ? (
              <ItemView key={group.item.id} item={group.item} cwd={chat.cwd} />
            ) : (
              <div key={group.key} className="chat-run">
                {group.items.map((item) => (
                  <ItemView key={item.id} item={item} cwd={chat.cwd} />
                ))}
                {index === groups.length - 1 && tail}
              </div>
            ),
          )}
          {showTail && !tailIsRun && <div className="chat-run">{tail}</div>}
        </div>
      </div>
      {!atBottom && (
        <button
          className="chat-jump"
          onClick={() => {
            stick.current = true;
            setAtBottom(true);
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
          }}
        >
          <ArrowDown size={14} />
        </button>
      )}
    </div>
  );
}

type PaneProps = { paneSlot?: ReactNode; onNewChat?: () => void };

function Header({ tab, chat, paneSlot, onNewChat }: { tab: ChatTab; chat: Chat } & PaneProps) {
  const accounts = useStore((s) => s.accounts);
  const account = accounts.find((a) => a.id === chat.accountId);
  const state = chat.busy ? "busy" : chat.running ? "on" : chat.starting ? "wait" : "off";
  const stateLabel = chat.busy ? "Працює" : chat.running ? "Готовий" : chat.starting ? "Запускаю…" : "Запуститься з першим повідомленням";
  const pickAccount = (event: React.MouseEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = accounts.map((a) => ({
      label: `${a.label}${a.email ? ` · ${a.email}` : a.loggedIn ? "" : " · вхід не виконано"}`,
      disabled: chat.busy || !a.loggedIn,
      shortcut: a.id === chat.accountId ? "✓" : undefined,
      action: async () => {
        try {
          await switchChatAccount(tab.id, a.id, a.label);
          updateChatTab(tab.id, { accountId: a.id });
        } catch (error) {
          toast(errorText(error), "error");
        }
      },
    }));
    items.push("separator", { label: "Підключити ще одну підписку…", action: () => connectAccount() });
    openMenu({ clientX: rect.right - 260, clientY: rect.bottom + 4 }, items);
  };
  const continueInTerminal = () =>
    resumeSession({ id: chat.sessionId, accountId: chat.accountId, title: tab.title, firstPrompt: "", cwd: chat.cwd, gitBranch: "", modified: 0, size: 0, file: "" });
  return (
    <div className="chat-head">
      {paneSlot ?? <ClaudeIcon size={15} />}
      <span className="chat-head-title" title={tab.title}>
        {tab.title}
      </span>
      <span className={`chat-state ${state}`} title={stateLabel}>
        <span className="chat-state-dot" />
        {stateLabel}
      </span>
      <div className="grow" />
      {account && (
        <button className="meta-pill clickable" onClick={pickAccount} title={`Підписка для цього чату${chat.email ?? account.email ? `: ${chat.email ?? account.email}` : ""}. Натисни, щоб змінити`}>
          <span className="dot" style={{ background: account.color }} />
          {account.label}
          {chat.plan ? ` · ${chat.plan.replace(/^Claude /, "")}` : ""}
          <ChevronDown size={11} />
        </button>
      )}
      {!paneSlot && (
        <span className="meta-pill mono" title={chat.cwd}>
          {basename(chat.cwd)}
        </span>
      )}
      <button
        className="icon-btn"
        title={onNewChat ? "Новий чат у цьому вікні" : "Новий чат (Ctrl Shift L)"}
        onClick={() => (onNewChat ? onNewChat() : newChat({ accountId: chat.accountId, cwd: chat.cwd }))}
      >
        <Plus size={15} />
      </button>
      <button className="icon-btn" title="Продовжити в терміналі" disabled={chat.items.length === 0} onClick={continueInTerminal}>
        <SquareTerminal size={14} />
      </button>
      <button className="icon-btn" title="Копіювати ID сесії" onClick={() => copyText(chat.sessionId, "ID сесії скопійовано")}>
        <Copy size={14} />
      </button>
      <button className="icon-btn" title="Перезапустити Claude" disabled={chat.busy} onClick={() => restartChat(tab.id)}>
        <RotateCw size={14} />
      </button>
    </div>
  );
}

export function ChatView({ tab, paneSlot, onNewChat }: { tab: ChatTab } & PaneProps) {
  useEffect(() => {
    ensureChat({ key: tab.id, sessionId: tab.sessionId, accountId: tab.accountId, cwd: tab.cwd, model: tab.model, effort: tab.effort, mode: tab.mode });
  }, [tab.id]);
  const chat = useChats((s) => s[tab.id]);
  if (!chat) return null;
  return (
    <div className="chat-view">
      <Header tab={tab} chat={chat} paneSlot={paneSlot} onNewChat={onNewChat} />
      <Timeline chat={chat} />
      <div className="chat-bottom">
        {chat.requests.slice(0, 1).map((request) => (
          <RequestCard key={request.requestId} chatKey={tab.id} request={request} cwd={chat.cwd} />
        ))}
        {chat.requests.length > 1 && <div className="req-more">Ще запитів: {chat.requests.length - 1}</div>}
        <Composer tab={tab} chat={chat} />
      </div>
    </div>
  );
}
