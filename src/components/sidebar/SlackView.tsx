import { useEffect, useMemo, useState } from "react";
import {
  AtSign,
  Bug,
  CalendarClock,
  ChevronDown,
  Copy,
  ExternalLink,
  Hash,
  Info,
  LoaderCircle,
  Lock,
  MessageCircleQuestion,
  Pencil,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  User,
  Users,
  X,
} from "lucide-react";
import { useStore } from "../../store";
import { buildSlackDigest, connectSlack, copyText, disconnectSlack, loadSlackChats, refreshSlack, selectSlackChats } from "../../actions";
import { api, type SlackChat, type SlackChatKind, type SlackDigest, type SlackDigestKind, type SlackRef } from "../../ipc";
import { Switch } from "../ui";
import { SlackIcon } from "../SlackIcon";

const NEW_APP_URL = "https://api.slack.com/apps?new_app=1";
const DAY_OPTIONS = [1, 3, 7];

const KIND_META: Record<SlackChatKind, { title: string; icon: React.ComponentType<{ size?: number; strokeWidth?: number }> }> = {
  channel: { title: "Канали", icon: Hash },
  private: { title: "Приватні канали", icon: Lock },
  group: { title: "Групові чати", icon: Users },
  dm: { title: "Особисті", icon: User },
};
const KIND_ORDER: SlackChatKind[] = ["channel", "private", "group", "dm"];

const DIGEST_META: Record<SlackDigestKind, { title: string; icon: React.ComponentType<{ size?: number; strokeWidth?: number }> }> = {
  edits: { title: "Правки", icon: Pencil },
  questions: { title: "Питання до тебе", icon: MessageCircleQuestion },
  bugs: { title: "Баги", icon: Bug },
  deadlines: { title: "Дедлайни й зустрічі", icon: CalendarClock },
  mentions: { title: "Згадки тебе", icon: AtSign },
  info: { title: "Важливе", icon: Info },
};

function manifest(scopes: string[]) {
  return JSON.stringify(
    {
      display_information: { name: "Mavix", description: "Mavix: Claude читає вибрані чати. Тільки читання." },
      oauth_config: { scopes: { user: scopes } },
      settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
    },
    null,
    2,
  );
}

function plural(n: number, one: string, few: string, many: string) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function Section({ title, extra, grow, children }: { title: string; extra?: React.ReactNode; grow?: boolean; children: React.ReactNode }) {
  const [closed, setClosed] = useState(false);
  return (
    <section className={`cc-section${closed ? " closed" : ""}${grow ? " grow" : ""}`}>
      <div className="cc-section-head" onClick={() => setClosed(!closed)}>
        <ChevronDown size={15} strokeWidth={1.8} className="cc-chevron" />
        <span className="cc-section-title">{title}</span>
        {extra && (
          <span className="cc-section-extra" onClick={(e) => e.stopPropagation()}>
            {extra}
          </span>
        )}
      </div>
      {!closed && children}
    </section>
  );
}

function ReadOnlyNote() {
  return (
    <div className="slack-note">
      <ShieldCheck size={15} strokeWidth={1.8} />
      <div>
        <b>Claude тільки читає.</b> Бачить лише чати з галочкою і нічого не пише, не відповідає й не ставить реакцій: токен без права запису.
      </div>
    </div>
  );
}

function Connect({ readScopes }: { readScopes: string[] }) {
  const [token, setToken] = useState("");
  const busy = useStore((s) => s.slackBusy === "connect");
  const submit = async () => {
    if (!token.trim() || busy) return;
    if (await connectSlack(token)) setToken("");
  };
  return (
    <div className="cc-body slack-connect">
      <ReadOnlyNote />
      <ol className="slack-steps">
        <li>
          <span>
            Створи Slack-апку з маніфесту: <b>Create New App → From a manifest</b>, вибери простір <b>Mana</b> і встав маніфест.
          </span>
          <span className="slack-step-actions">
            <button className="btn small" onClick={() => api.openExternal(NEW_APP_URL)}>
              <ExternalLink size={12} /> Відкрити Slack API
            </button>
            <button className="btn small" onClick={() => copyText(manifest(readScopes))}>
              <Copy size={12} /> Копіювати маніфест
            </button>
          </span>
        </li>
        <li>
          <span>
            Натисни <b>Install to Workspace</b>. Якщо Slack попросить, надішли запит адміну й дочекайся апруву.
          </span>
        </li>
        <li>
          <span>
            У розділі <b>OAuth &amp; Permissions</b> скопіюй <b>User OAuth Token</b> (починається з xoxp-) і встав нижче.
          </span>
        </li>
      </ol>
      <div className="slack-token">
        <input
          className="input"
          type="password"
          placeholder="xoxp-…"
          value={token}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button className="btn small primary" disabled={!token.trim() || busy} onClick={submit}>
          {busy ? <LoaderCircle size={13} className="spin" /> : null} Підключити
        </button>
      </div>
      <div className="cc-muted slack-fine">Токен зберігається тільки на цьому ПК. Mavix не прийме токен, який має право писати в Slack.</div>
    </div>
  );
}

function RefLine({ item }: { item: SlackRef }) {
  return (
    <button className="slack-ref" title="Відкрити в Slack" onClick={() => api.openExternal(item.link)}>
      <span className="slack-ref-chat">{item.chat}</span>
      <span className="slack-ref-meta">
        {item.user} · {item.time}
      </span>
      <ExternalLink size={11} className="slack-ref-go" />
    </button>
  );
}

function DigestView({ digest }: { digest: SlackDigest }) {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const at = new Date(digest.createdAt).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  return (
    <div className="slack-digest">
      <div className="cc-muted">
        {at} · {digest.count} {plural(digest.count, "повідомлення", "повідомлення", "повідомлень")} за {digest.days} {plural(digest.days, "день", "дні", "днів")}
      </div>
      {digest.summary && <div className="slack-summary">{digest.summary}</div>}
      {digest.groups.map((group) => {
        const meta = DIGEST_META[group.kind];
        const Icon = meta.icon;
        const isClosed = !!closed[group.kind];
        return (
          <div key={group.kind} className={`slack-group kind-${group.kind}`}>
            <button className={`slack-group-head${isClosed ? " closed" : ""}`} onClick={() => setClosed((c) => ({ ...c, [group.kind]: !isClosed }))}>
              <ChevronDown size={13} strokeWidth={1.8} className="slack-group-chevron" />
              <Icon size={14} strokeWidth={1.8} />
              <span className="slack-group-title">{meta.title}</span>
              <span className="cc-badge">{group.items.length}</span>
            </button>
            {!isClosed &&
              group.items.map((item, index) => (
                <div key={index} className="slack-item">
                  <div className="slack-item-text">{item.text}</div>
                  {item.refs.map((ref, n) => (
                    <RefLine key={n} item={ref} />
                  ))}
                </div>
              ))}
          </div>
        );
      })}
      {digest.failed.map((line) => (
        <div key={line} className="slack-warn">
          <TriangleAlert size={13} /> Не прочитано: {line}
        </div>
      ))}
    </div>
  );
}

function ChatList({ selected }: { selected: SlackChat[] }) {
  const chats = useStore((s) => s.slackChats);
  const loading = useStore((s) => s.slackBusy === "chats");
  const [query, setQuery] = useState("");
  const [onlyPicked, setOnlyPicked] = useState(false);
  const picked = useMemo(() => new Set(selected.map((c) => c.id)), [selected]);
  const all = useMemo(() => {
    const known = new Map((chats ?? []).map((c) => [c.id, c]));
    for (const c of selected) if (!known.has(c.id)) known.set(c.id, c);
    return [...known.values()];
  }, [chats, selected]);
  const q = query.trim().toLowerCase();
  const visible = all.filter((c) => (!onlyPicked || picked.has(c.id)) && (!q || c.name.toLowerCase().includes(q)));
  const toggle = (chat: SlackChat, on: boolean) => {
    const next = on ? [...selected, chat] : selected.filter((c) => c.id !== chat.id);
    selectSlackChats(next);
  };
  return (
    <>
      <div className="cc-seg">
        <button className={!onlyPicked ? "on" : ""} onClick={() => setOnlyPicked(false)}>
          Усі · {all.length}
        </button>
        <button className={onlyPicked ? "on" : ""} onClick={() => setOnlyPicked(true)}>
          З галочкою · {selected.length}
        </button>
      </div>
      <div className="cc-search">
        <Search size={13} />
        <input placeholder="Знайти чат" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} />
        {query && (
          <button className="icon-btn tiny" onClick={() => setQuery("")}>
            <X size={12} />
          </button>
        )}
      </div>
      <div className="cc-list">
        {!chats && loading && (
          <div className="cc-empty slack-loading">
            <LoaderCircle size={13} className="spin" /> Завантажую чати…
          </div>
        )}
        {KIND_ORDER.map((kind) => {
          const list = visible.filter((c) => c.kind === kind);
          if (!list.length) return null;
          const Icon = KIND_META[kind].icon;
          return (
            <div key={kind}>
              <div className="slack-kind">{KIND_META[kind].title}</div>
              {list.map((chat) => {
                const on = picked.has(chat.id);
                return (
                  <div key={chat.id} className={`cc-row slack-chat${on ? " on" : ""}`} onClick={() => toggle(chat, !on)}>
                    <Icon size={13} strokeWidth={1.8} />
                    <span className="cc-row-title">{chat.name}</span>
                    <Switch small on={on} title={on ? "Claude читає цей чат" : "Дозволити Claude читати"} onChange={(next) => toggle(chat, next)} />
                  </div>
                );
              })}
            </div>
          );
        })}
        {chats && visible.length === 0 && <div className="cc-empty">{onlyPicked ? "Ще немає чатів з галочкою." : "Нічого не знайдено."}</div>}
      </div>
    </>
  );
}

export function SlackView() {
  const slack = useStore((s) => s.slack);
  const busy = useStore((s) => s.slackBusy);
  const [days, setDays] = useState(3);

  useEffect(() => {
    refreshSlack();
  }, []);

  if (!slack) {
    return (
      <div className="cc slack">
        <div className="cc-title slack-title">
          <SlackIcon size={15} /> Slack
        </div>
        <div className="cc-body cc-muted slack-loading">
          <LoaderCircle size={13} className="spin" /> Завантажую…
        </div>
      </div>
    );
  }

  if (!slack.connected) {
    return (
      <div className="cc slack">
        <div className="cc-title slack-title">
          <SlackIcon size={15} /> Slack
        </div>
        <Section title="Підключення">
          <Connect readScopes={slack.readScopes} />
        </Section>
      </div>
    );
  }

  const broken = slack.targets.filter((t) => !t.ok);
  const linked = slack.targets.filter((t) => t.ok);

  return (
    <div className="cc slack">
      <div className="cc-title slack-title">
        <SlackIcon size={15} /> Slack
      </div>
      <Section
        title="Підключення"
        extra={
          <button className="cc-link" disabled={busy === "disconnect"} onClick={disconnectSlack}>
            Відключити
          </button>
        }
      >
        <div className="cc-body">
          <div className="cc-kv">
            <span>Простір</span>
            <span className="cc-kv-val">{slack.team}</span>
          </div>
          <div className="cc-kv">
            <span>Ти</span>
            <span className="cc-kv-val">{slack.user}</span>
          </div>
          <ReadOnlyNote />
          {linked.length > 0 && (
            <div className="slack-status ok">
              <ShieldCheck size={13} /> Доступ у Claude: {linked.map((t) => t.label).join(", ")}
            </div>
          )}
          {broken.map((t) => (
            <div key={t.label} className="slack-status bad">
              <TriangleAlert size={13} /> {t.label}: {t.error}
            </div>
          ))}
        </div>
      </Section>
      <Section
        title="Що нового"
        extra={
          <span className="slack-days">
            {DAY_OPTIONS.map((d) => (
              <button key={d} className={d === days ? "on" : ""} onClick={() => setDays(d)} title={`За ${d} ${plural(d, "день", "дні", "днів")}`}>
                {d}д
              </button>
            ))}
          </span>
        }
      >
        <div className="cc-body">
          <button className="btn small wide slack-build" disabled={busy === "digest" || slack.selected.length === 0} onClick={() => buildSlackDigest(days)}>
            {busy === "digest" ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />}
            {busy === "digest" ? "Claude читає чати…" : "Оновити зведення"}
          </button>
          {slack.selected.length === 0 && <div className="cc-muted slack-fine">Постав галочки на чатах нижче, і Claude зможе їх читати.</div>}
          {slack.digest && <DigestView digest={slack.digest} />}
        </div>
      </Section>
      <Section
        title={`Чати для Claude · ${slack.selected.length}`}
        grow
        extra={
          <button className="cc-tool" title="Оновити список чатів" disabled={busy === "chats"} onClick={() => loadSlackChats()}>
            <RefreshCw size={13} className={busy === "chats" ? "spin" : undefined} />
          </button>
        }
      >
        <ChatList selected={slack.selected} />
      </Section>
    </div>
  );
}
