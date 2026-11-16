import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Ellipsis, Funnel, Globe, Monitor, Play, Plus, Search, SquareTerminal, X, Zap } from "lucide-react";
import { confirm, get, openMenu, set, useActiveWorkspace, useStore, type MenuItem, type SessionsPrefs } from "../../store";
import {
  chooseAccount,
  connectAccount,
  copyText,
  defaultAccountFor,
  loginAccount,
  newChat,
  newClaudeSession,
  openChatSession,
  openSession,
  refreshAccounts,
  refreshSessions,
  resumeSession,
  setActivity,
} from "../../actions";
import { api, type Account, type Limit, type SessionInfo } from "../../ipc";
import { basename, clamp, isInside, relativeTime, resetLine, uid } from "../../util";

const UNGROUPED = "ungrouped";
const ARCHIVED = "archived";
const PAGE = 100;
const USAGE_STALE_MS = 5 * 60_000;
const SESSIONS_POLL_MS = 12_000;
const WEB_SESSIONS_URL = "https://claude.ai/code";
const NEW_GROUP_NAME = "Нова група";

type GroupSlot = { id: string; name: string; custom: boolean };

function updatePrefs(fn: (prefs: SessionsPrefs) => Partial<SessionsPrefs>) {
  set((s) => ({ sessionsPrefs: { ...s.sessionsPrefs, ...fn(s.sessionsPrefs) } }));
}

function menuBelow(event: React.MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return { clientX: rect.left, clientY: rect.bottom + 4 };
}

function checked(on: boolean, label: string) {
  return `${on ? "✓" : " "}  ${label}`;
}

export function Section({ id, title, extra, grow, children }: { id: string; title: string; extra?: React.ReactNode; grow?: boolean; children: React.ReactNode }) {
  const collapsed = useStore((s) => !!s.sessionsPrefs.collapsed[id]);
  const toggle = () => updatePrefs((p) => ({ collapsed: { ...p.collapsed, [id]: !collapsed } }));
  return (
    <section className={`cc-section${collapsed ? " closed" : ""}${grow ? " grow" : ""}`}>
      <div className="cc-section-head" onClick={toggle}>
        <ChevronDown size={15} strokeWidth={1.8} className="cc-chevron" />
        <span className="cc-section-title">{title}</span>
        {extra && (
          <span className="cc-section-extra" onClick={(e) => e.stopPropagation()}>
            {extra}
          </span>
        )}
      </div>
      {!collapsed && children}
    </section>
  );
}

export function UsageBar({ limit }: { limit: Limit }) {
  const percent = clamp(limit.percent, 0, 100);
  return (
    <div className="cc-usage">
      <div className="cc-usage-head">
        <span>{limit.label}</span>
        <span>{Math.round(percent)}%</span>
      </div>
      <div className={`cc-bar${percent >= 90 ? " hot" : ""}`}>
        <i style={{ width: `${percent}%` }} />
      </div>
      {limit.resetsAt && <div className="cc-usage-reset">{resetLine(limit.resetsAt)}</div>}
    </div>
  );
}

export function useUsageRefresh(account: Account | undefined) {
  const [busy, setBusy] = useState(false);
  const id = account?.id;
  const loggedIn = !!account?.loggedIn;
  useEffect(() => {
    if (!id || !loggedIn) return;
    let alive = true;
    const refresh = async () => {
      const current = get().accounts.find((a) => a.id === id);
      const age = Date.now() - (current?.usage?.live ? current.usage.fetchedAt : 0);
      if (age < USAGE_STALE_MS || !document.hasFocus()) return;
      setBusy(true);
      await api
        .accountsRefreshUsage(id)
        .then(refreshAccounts)
        .catch(() => undefined);
      if (alive) setBusy(false);
    };
    refresh();
    const timer = window.setInterval(refresh, USAGE_STALE_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [id, loggedIn]);
  return busy;
}

export function SubLoad({ account }: { account: Account }) {
  const session = account.usage?.limits.find((l) => l.kind === "session" || l.kind === "five_hour");
  if (!session) return null;
  const percent = clamp(session.percent, 0, 100);
  return (
    <span className={`cc-sub-load${percent >= 90 ? " hot" : ""}`} title={`${session.label}: ${Math.round(percent)}%`}>
      <span>{Math.round(percent)}%</span>
      <i>
        <b style={{ width: `${percent}%` }} />
      </i>
    </span>
  );
}

export function SubscriptionRow({ account, selected, onPick, hint }: { account: Account; selected: boolean; onPick?: () => void; hint?: string }) {
  const pick = onPick ?? (() => chooseAccount(account.id));
  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      className={`cc-sub${selected ? " on" : ""}${account.loggedIn ? "" : " out"}`}
      style={{ "--sub": account.color } as React.CSSProperties}
      onClick={pick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          pick();
        }
      }}
      title={hint ?? (selected ? "Нові чати йдуть на цю підписку" : "Нові чати йтимуть на цю підписку")}
    >
      <span className="cc-sub-mark" />
      <span className="cc-sub-main">
        <span className="cc-sub-name">
          <span className="cc-sub-label">{account.label}</span>
          {account.plan && <span className="cc-sub-plan">{account.plan}</span>}
        </span>
        <span className="cc-sub-mail">{account.loggedIn ? (account.email ?? "Пошта невідома") : "Вхід не виконано"}</span>
      </span>
      {account.loggedIn ? (
        <SubLoad account={account} />
      ) : (
        <button
          className="cc-link"
          onClick={(event) => {
            event.stopPropagation();
            loginAccount(account.id);
          }}
        >
          Увійти
        </button>
      )}
    </div>
  );
}

function Subscriptions({ accounts, target }: { accounts: Account[]; target: Account | undefined }) {
  const busy = useUsageRefresh(target);
  return (
    <div className="cc-body cc-subs-body">
      <div className="cc-subs" role="radiogroup" aria-label="Підписка для нових чатів">
        {accounts.map((a) => (
          <SubscriptionRow key={a.id} account={a} selected={a.id === target?.id} />
        ))}
        <button className="cc-sub-add" onClick={() => connectAccount()}>
          <Plus size={14} strokeWidth={1.8} /> Підключити підписку
        </button>
      </div>
      {accounts.length < 2 && <div className="cc-muted cc-subs-note">Підключи кілька підписок, і всі працюватимуть одночасно: кожен чат на своїй.</div>}
      {target?.loggedIn && (
        <>
          <div className="cc-label">Ліміти «{target.label}»</div>
          {target.usage ? (
            target.usage.limits.map((l) => <UsageBar key={l.kind + l.label} limit={l} />)
          ) : (
            <div className="cc-muted">{busy ? "Оновлюю ліміти…" : "Ліміти з'являться після першої сесії."}</div>
          )}
        </>
      )}
    </div>
  );
}

function RenameInput({ value, onDone }: { value: string; onDone: (next: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const [text, setText] = useState(value);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(next);
  };
  return (
    <input
      ref={ref}
      className="cc-rename"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(text);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(text)}
    />
  );
}

function SessionRow({ session, live, showProject, onMenu }: { session: SessionInfo; live: boolean; showProject: boolean; onMenu: (event: React.MouseEvent, s: SessionInfo) => void }) {
  return (
    <div
      className={`cc-row${live ? " live" : ""}`}
      onClick={() => openSession(session)}
      onDoubleClick={() => openChatSession(session)}
      onContextMenu={(e) => onMenu(e, session)}
      title={`${session.title}\n${session.cwd || ""}`}
    >
      <span className="cc-row-dot" />
      <span className="cc-row-title">{session.title}</span>
      <span className="cc-row-time">
        {showProject && session.cwd ? `${basename(session.cwd)} · ` : ""}
        {relativeTime(session.modified)}
      </span>
      <span className="cc-row-actions">
        <button
          className="icon-btn tiny"
          title="Продовжити в чаті"
          onClick={(e) => {
            e.stopPropagation();
            openChatSession(session);
          }}
        >
          <Play size={12} />
        </button>
        <button
          className="icon-btn tiny"
          title="Дії"
          onClick={(e) => {
            e.stopPropagation();
            onMenu(e, session);
          }}
        >
          <Ellipsis size={13} />
        </button>
      </span>
    </div>
  );
}

function WebSessions() {
  return (
    <div className="cc-web">
      <div className="cc-web-title">Веб-сесії Claude Code</div>
      <p>Хмарні сесії живуть на claude.ai/code. Mavix відкриє їх у браузері.</p>
      <button className="btn small" onClick={() => api.openExternal(WEB_SESSIONS_URL)}>
        <Globe size={13} /> Відкрити claude.ai/code
      </button>
    </div>
  );
}

export function SessionsView() {
  const ws = useActiveWorkspace();
  const sessions = useStore((s) => s.sessions);
  const loading = useStore((s) => s.sessionsLoading);
  const scope = useStore((s) => s.sessionsScope);
  const accountFilter = useStore((s) => s.sessionsAccount);
  const accounts = useStore((s) => s.accounts);
  const prefs = useStore((s) => s.sessionsPrefs);
  const openSessionIds = useStore((s) =>
    [s.home, ...s.workspaces].flatMap((w) => w.termTabs.flatMap((t) => t.panes.map((p) => p.sessionId))).filter(Boolean).join("|"),
  );
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [limits, setLimits] = useState<Record<string, number>>({});

  useEffect(() => {
    refreshSessions();
    const timer = window.setInterval(() => document.hasFocus() && refreshSessions(), SESSIONS_POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const liveIds = useMemo(() => new Set(openSessionIds.split("|").filter(Boolean)), [openSessionIds]);
  const effectiveScope = ws.root ? scope : "all";
  useStore((s) => s.settings.defaultAccountId);
  const target = accounts.find((a) => a.id === defaultAccountFor(ws)) ?? accounts[0];

  const scoped = useMemo(
    () =>
      sessions
        .filter((s) => {
          if (effectiveScope === "project" && ws.root && !isInside(ws.root, s.cwd)) return false;
          if (accountFilter && s.accountId !== accountFilter) return false;
          return true;
        })
        .sort((a, b) => b.modified - a.modified),
    [sessions, effectiveScope, ws.root, accountFilter],
  );

  const liveCount = useMemo(() => scoped.filter((s) => liveIds.has(s.id)).length, [scoped, liveIds]);
  const searching = query.trim().length > 0;

  const buckets = useMemo(() => {
    const q = query.trim().toLowerCase();
    const archived = new Set(prefs.archived);
    const groupIds = new Set(prefs.groups.map((g) => g.id));
    const map = new Map<string, SessionInfo[]>();
    for (const s of scoped) {
      if (prefs.activeOnly && !liveIds.has(s.id)) continue;
      if (q && !`${s.title} ${s.firstPrompt} ${s.cwd}`.toLowerCase().includes(q)) continue;
      const group = prefs.groupOf[s.id];
      const key = archived.has(s.id) ? ARCHIVED : group && groupIds.has(group) ? group : UNGROUPED;
      const list = map.get(key);
      if (list) list.push(s);
      else map.set(key, [s]);
    }
    return map;
  }, [scoped, query, prefs.archived, prefs.groups, prefs.groupOf, prefs.activeOnly, liveIds]);

  const slots: GroupSlot[] = [
    ...prefs.groups.map((g) => ({ id: g.id, name: g.name, custom: true })),
    { id: UNGROUPED, name: "Без групи", custom: false },
    { id: ARCHIVED, name: "Архів", custom: false },
  ];

  const filterMenu = (event: React.MouseEvent) => {
    const items: MenuItem[] = [
      { label: checked(effectiveScope === "project", ws.root ? `Цей проект · ${ws.name}` : "Цей проект"), disabled: !ws.root, action: () => set({ sessionsScope: "project" }) },
      { label: checked(effectiveScope === "all", "Усі проекти"), action: () => set({ sessionsScope: "all" }) },
    ];
    if (accounts.length > 1) {
      items.push("separator", { label: checked(!accountFilter, "Усі акаунти"), action: () => set({ sessionsAccount: null }) });
      for (const a of accounts) items.push({ label: checked(accountFilter === a.id, a.label), action: () => set({ sessionsAccount: a.id }) });
    }
    items.push("separator", { label: loading ? "Оновлюю…" : "Оновити список", action: () => refreshSessions() });
    openMenu(menuBelow(event), items);
  };

  const toggleGroup = (id: string, open: boolean) => updatePrefs((p) => ({ expanded: { ...p.expanded, [id]: !open } }));

  const newGroup = () => {
    const id = uid("grp");
    updatePrefs((p) => ({ groups: [...p.groups, { id, name: NEW_GROUP_NAME }], expanded: { ...p.expanded, [id]: true } }));
    setRenaming(id);
  };

  const renameGroup = (id: string, name: string | null) => {
    setRenaming(null);
    const clean = name?.trim();
    if (!clean) return;
    updatePrefs((p) => ({ groups: p.groups.map((g) => (g.id === id ? { ...g, name: clean } : g)) }));
  };

  const deleteGroup = async (slot: GroupSlot) => {
    const count = Object.values(get().sessionsPrefs.groupOf).filter((g) => g === slot.id).length;
    if (count > 0 && !(await confirm(`Видалити групу «${slot.name}»?`, "Сесії з неї повернуться в «Без групи».", true, "Видалити"))) return;
    updatePrefs((p) => ({
      groups: p.groups.filter((g) => g.id !== slot.id),
      groupOf: Object.fromEntries(Object.entries(p.groupOf).filter(([, g]) => g !== slot.id)),
    }));
  };

  const moveTo = (sessionId: string, groupId: string | null) =>
    updatePrefs((p) => {
      const groupOf = { ...p.groupOf };
      if (groupId) groupOf[sessionId] = groupId;
      else delete groupOf[sessionId];
      return { groupOf, archived: p.archived.filter((id) => id !== sessionId) };
    });

  const moveToNewGroup = (sessionId: string) => {
    const id = uid("grp");
    updatePrefs((p) => ({
      groups: [...p.groups, { id, name: NEW_GROUP_NAME }],
      groupOf: { ...p.groupOf, [sessionId]: id },
      archived: p.archived.filter((x) => x !== sessionId),
      expanded: { ...p.expanded, [id]: true },
    }));
    setRenaming(id);
  };

  const setArchived = (sessionId: string, archived: boolean) =>
    updatePrefs((p) => ({ archived: archived ? [...p.archived.filter((x) => x !== sessionId), sessionId] : p.archived.filter((x) => x !== sessionId) }));

  const groupMenu = (event: React.MouseEvent, slot: GroupSlot) => {
    event.preventDefault();
    if (slot.custom) {
      openMenu(event, [
        { label: "Перейменувати", action: () => setRenaming(slot.id) },
        { label: "Видалити групу", danger: true, action: () => deleteGroup(slot) },
      ]);
      return;
    }
    if (slot.id === ARCHIVED && prefs.archived.length > 0) {
      openMenu(event, [{ label: "Повернути все з архіву", action: () => updatePrefs(() => ({ archived: [] })) }]);
    }
  };

  const rowMenu = (event: React.MouseEvent, s: SessionInfo) => {
    const p = get().sessionsPrefs;
    const isArchived = p.archived.includes(s.id);
    const current = p.groupOf[s.id];
    const inGroup = !!current && p.groups.some((g) => g.id === current);
    const items: MenuItem[] = [
      { label: "Продовжити в чаті", action: () => openChatSession(s) },
      { label: "Продовжити в терміналі", action: () => resumeSession(s) },
      { label: "Переглянути розмову", action: () => openSession(s) },
      "separator",
      ...p.groups.filter((g) => g.id !== current || isArchived).map((g) => ({ label: `У групу «${g.name}»`, action: () => moveTo(s.id, g.id) })),
      { label: "У нову групу…", action: () => moveToNewGroup(s.id) },
      ...(inGroup && !isArchived ? [{ label: "Прибрати з групи", action: () => moveTo(s.id, null) }] : []),
      isArchived ? { label: "Повернути з архіву", action: () => setArchived(s.id, false) } : { label: "В архів", action: () => setArchived(s.id, true) },
      "separator",
      { label: "Копіювати ID сесії", action: () => copyText(s.id) },
      { label: "Копіювати команду продовження", action: () => copyText(`claude --resume ${s.id}`) },
      { label: "Показати файл сесії", action: () => api.reveal(s.file) },
    ];
    openMenu(event.type === "click" ? menuBelow(event) : event, items);
  };

  const emptyText = (slot: GroupSlot) => {
    if (searching) return "Нічого не знайдено.";
    if (prefs.activeOnly) return "Немає активних сесій.";
    if (slot.custom) return "Порожньо. ПКМ на сесії → «У групу».";
    if (slot.id === ARCHIVED) return "Архів порожній.";
    return effectiveScope === "project" ? "У цьому проекті ще немає сесій." : "Сесій не знайдено.";
  };

  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
  };

  return (
    <div className="cc">
      <div className="cc-title">Claude Code</div>
      <Section
        id="subs"
        title={accounts.length > 1 ? `Підписки · ${accounts.filter((a) => a.loggedIn).length} активні` : "Підписка"}
        extra={
          <button className="cc-link" onClick={() => setActivity("accounts")}>
            Керувати
          </button>
        }
      >
        <Subscriptions accounts={accounts} target={target} />
      </Section>
      <Section id="manager" title="Менеджер сесій" grow>
        <div className="cc-new-row">
          <button className="cc-new" onClick={() => newChat({ accountId: target?.id })} title={`Новий чат${ws.root ? ` у ${ws.name}` : ""} (Ctrl Shift L)`}>
            <Plus size={17} strokeWidth={1.8} /> Новий чат
            {target && accounts.length > 1 && (
              <span className="cc-new-sub" title={`Чат піде на підписку «${target.label}»`}>
                <span className="dot" style={{ background: target.color }} />
                {target.label}
              </span>
            )}
          </button>
          <button className="cc-new cc-new-term" onClick={() => newClaudeSession(target?.id)} title="Нова сесія Claude у терміналі">
            <SquareTerminal size={16} strokeWidth={1.7} />
          </button>
        </div>
        <div className="cc-seg">
          <button className={prefs.tab === "local" ? "on" : ""} onClick={() => updatePrefs(() => ({ tab: "local" }))}>
            <Monitor size={15} strokeWidth={1.7} /> Локальні
          </button>
          <button className={prefs.tab === "web" ? "on" : ""} onClick={() => updatePrefs(() => ({ tab: "web" }))}>
            <Globe size={15} strokeWidth={1.7} /> Веб
          </button>
        </div>
        {prefs.tab === "web" ? (
          <WebSessions />
        ) : (
          <>
            <div className="cc-tools">
              <button className={`cc-tool${(ws.root && effectiveScope === "all") || accountFilter ? " on" : ""}`} onClick={filterMenu} title="Фільтр">
                <Funnel size={15} fill="currentColor" strokeWidth={1.4} />
                <ChevronDown size={13} />
              </button>
              <button className={`cc-tool${prefs.activeOnly ? " on" : ""}`} onClick={() => updatePrefs((p) => ({ activeOnly: !p.activeOnly }))} title="Лише відкриті в терміналі">
                <Zap size={15} strokeWidth={1.7} /> Активні · {liveCount}
              </button>
              <button className={`cc-tool${searchOpen ? " on" : ""}`} onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))} title="Пошук у сесіях">
                <Search size={15} strokeWidth={1.7} />
              </button>
              <button className="cc-tool" onClick={newGroup}>
                <Plus size={15} strokeWidth={1.7} /> Нова група
              </button>
            </div>
            {searchOpen && (
              <div className="cc-search">
                <Search size={13} />
                <input autoFocus placeholder="Пошук у сесіях" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && closeSearch()} />
                <button className="icon-btn tiny" onClick={closeSearch}>
                  <X size={12} />
                </button>
              </div>
            )}
            <div className="cc-list">
              {slots.map((slot) => {
                const list = buckets.get(slot.id) ?? [];
                const open = searching ? list.length > 0 : !!prefs.expanded[slot.id];
                const limit = limits[slot.id] ?? PAGE;
                return (
                  <div key={slot.id}>
                    <div className={`cc-group${open ? " open" : ""}`} onClick={() => toggleGroup(slot.id, open)} onContextMenu={(e) => groupMenu(e, slot)}>
                      <ChevronRight size={15} strokeWidth={1.8} className="cc-group-chevron" />
                      {renaming === slot.id ? (
                        <RenameInput value={slot.name} onDone={(next) => renameGroup(slot.id, next)} />
                      ) : (
                        <span
                          className="cc-group-name"
                          onDoubleClick={(e) => {
                            if (!slot.custom) return;
                            e.stopPropagation();
                            setRenaming(slot.id);
                          }}
                        >
                          {slot.name}
                        </span>
                      )}
                      <span className="cc-badge">{list.length}</span>
                    </div>
                    {open && (
                      <div className="cc-group-body">
                        {list.length === 0 && <div className="cc-empty">{emptyText(slot)}</div>}
                        {list.slice(0, limit).map((s) => (
                          <SessionRow key={`${s.accountId}-${s.id}`} session={s} live={liveIds.has(s.id)} showProject={effectiveScope === "all"} onMenu={rowMenu} />
                        ))}
                        {list.length > limit && (
                          <button className="cc-more" onClick={() => setLimits((l) => ({ ...l, [slot.id]: limit + PAGE }))}>
                            Показати ще {Math.min(PAGE, list.length - limit)}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Section>
    </div>
  );
}
