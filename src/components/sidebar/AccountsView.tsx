import { useState } from "react";
import { ChevronDown, Ellipsis, Link2, LogIn, Pencil, Play, Plus, RefreshCw, Star, Trash2, TriangleAlert, UserRoundPen } from "lucide-react";
import { api, errorText, type Account } from "../../ipc";
import { openMenu, toast, useActiveWorkspace, useStore, type Workspace } from "../../store";
import {
  accountMenuItems,
  changeAccountEmail,
  connectAccount,
  duplicatesOf,
  removeAccount,
  renameAccount,
  focusProjectAccount,
  focusedAccountId,
  globalAccountId,
  loginAccount,
  newClaudeSession,
  refreshAccounts,
  refreshSessions,
  setDefaultAccount,
  switchProject,
} from "../../actions";
import { Section, SubLoad, SubscriptionRow, UsageBar, useUsageRefresh } from "./SessionsView";
import { themeById } from "../../themes";
import { relativeTime } from "../../util";

const COLORS = ["#ff8a3d", "#6fd3b8", "#6aa9ff", "#a98bff", "#e5c07b", "#ff7a90", "#b5d65a", "#8fb3c9"];

function menuUnder(event: React.MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return { clientX: rect.left, clientY: rect.bottom + 4 };
}

function tabColor(ws: Workspace) {
  return ws.themeId ? themeById(ws.themeId).swatches[3] : ws.color;
}

function DefaultRow({ selected, fallback, onPick }: { selected: boolean; fallback: Account | undefined; onPick: () => void }) {
  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      className={`cc-sub${selected ? " on" : ""}`}
      style={{ "--sub": fallback?.color ?? "var(--fg-4)" } as React.CSSProperties}
      onClick={onPick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onPick();
        }
      }}
      title="Вкладка бере підписку за замовчуванням"
    >
      <span className="cc-sub-mark" />
      <span className="cc-sub-main">
        <span className="cc-sub-name">
          <span className="cc-sub-label">За замовчуванням</span>
        </span>
        <span className="cc-sub-mail">{fallback ? `зараз «${fallback.label}»` : "основна підписка"}</span>
      </span>
    </div>
  );
}

function DuplicateNote({ account, accounts }: { account: Account; accounts: Account[] }) {
  const twins = duplicatesOf(account, accounts);
  if (twins.length === 0) return null;
  return (
    <div className="cc-dup">
      <TriangleAlert size={14} className="cc-dup-icon" />
      <span>
        «{account.label}» і {twins.map((t) => `«${t.label}»`).join(", ")} увійшли в одну пошту
        <b>{account.email}</b>
        Це та сама підписка й ті самі ліміти.
        {!account.main && " Зміни акаунт або видали зайву."}
      </span>
    </div>
  );
}

function AccountEdit({ account, accounts }: { account: Account; accounts: Account[] }) {
  return (
    <>
      <DuplicateNote account={account} accounts={accounts} />
      <div className="cc-acc-edit">
        {account.main ? (
          <button className="btn small" onClick={() => loginAccount(account.id)} title="Відкрити вхід у Claude для основної підписки">
            <LogIn size={12} /> {account.loggedIn ? "Увійти заново" : "Увійти"}
          </button>
        ) : (
          <button className="btn small" onClick={() => changeAccountEmail(account.id)} title="Вийти з поточної пошти й увійти іншою">
            <UserRoundPen size={12} /> Змінити акаунт
          </button>
        )}
        <button className="btn small" onClick={() => renameAccount(account)}>
          <Pencil size={12} /> Перейменувати
        </button>
        {!account.main && (
          <button className="btn small danger" onClick={() => removeAccount(account)}>
            <Trash2 size={12} /> Видалити
          </button>
        )}
      </div>
    </>
  );
}

function TabFocus({ ws, accounts }: { ws: Workspace; accounts: Account[] }) {
  const focused = focusedAccountId(ws);
  const fallback = accounts.find((a) => a.id === globalAccountId());
  const target = accounts.find((a) => a.id === (focused ?? fallback?.id)) ?? accounts[0];
  const busy = useUsageRefresh(target);
  const root = ws.root;
  return (
    <div className="cc-body cc-subs-body">
      <div className="cc-subs" role="radiogroup" aria-label={root ? `Підписка вкладки ${ws.name}` : "Підписка за замовчуванням"}>
        {root && <DefaultRow selected={!focused} fallback={fallback} onPick={() => focusProjectAccount(root, null)} />}
        {accounts.map((a) => (
          <SubscriptionRow
            key={a.id}
            account={a}
            selected={root ? a.id === focused : a.id === fallback?.id}
            onPick={() => (root ? focusProjectAccount(root, a.id) : setDefaultAccount(a.id))}
            hint={root ? `Закріпити «${a.label}» за вкладкою «${ws.name}»` : `Зробити «${a.label}» підпискою за замовчуванням`}
          />
        ))}
      </div>
      <div className="cc-muted cc-subs-note">
        {root && target
          ? `Нові чати й термінали вкладки «${ws.name}» ідуть на «${target.label}».`
          : "Цю підписку беруть Головна і вкладки без своєї підписки."}
      </div>
      {target && <AccountEdit account={target} accounts={accounts} />}
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

function TabRow({ ws, active, accounts }: { ws: Workspace; active: boolean; accounts: Account[] }) {
  const focused = focusedAccountId(ws);
  const account = accounts.find((a) => a.id === (focused ?? globalAccountId())) ?? accounts[0];
  return (
    <div className={`cc-ptab${active ? " on" : ""}`} onClick={() => switchProject(ws.id)} title={ws.root ?? ws.name}>
      <span className="ptab-dot" style={{ background: tabColor(ws) }} />
      <span className="cc-ptab-name">{ws.name}</span>
      {account && (
        <button
          className={`cc-ptab-sub${focused ? "" : " inherit"}`}
          style={{ "--sub": account.color } as React.CSSProperties}
          title={focused ? `Підписка вкладки: ${account.label}` : `За замовчуванням: ${account.label}`}
          onClick={(event) => {
            event.stopPropagation();
            openMenu(menuUnder(event), accountMenuItems(ws));
          }}
        >
          <span className="cc-ptab-dot" />
          <span className="cc-ptab-label">{account.label}</span>
          <ChevronDown size={12} />
        </button>
      )}
    </div>
  );
}

function AccountRow({ account, open, onToggle, sessions, tabs }: { account: Account; open: boolean; onToggle: () => void; sessions: number; tabs: Workspace[] }) {
  const ws = useActiveWorkspace();
  const accounts = useStore((s) => s.accounts);
  const [busy, setBusy] = useState(false);
  const refreshUsage = async () => {
    setBusy(true);
    try {
      await api.accountsRefreshUsage(account.id);
      await refreshAccounts();
      toast(`Ліміти «${account.label}» оновлено`, "ok");
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      setBusy(false);
    }
  };
  const menu = (event: React.MouseEvent) => {
    event.stopPropagation();
    const root = ws.root;
    openMenu(menuUnder(event), [
      ...(root ? [{ label: `Закріпити за вкладкою «${ws.name}»`, action: () => focusProjectAccount(root, account.id) }, "separator" as const] : []),
      ...(account.main ? [] : [{ label: "Змінити акаунт (іншу пошту)…", action: () => changeAccountEmail(account.id) }]),
      { label: "Перейменувати…", action: () => renameAccount(account) },
      {
        label: "Змінити колір",
        action: async () => {
          const next = COLORS[(COLORS.indexOf(account.color) + 1) % COLORS.length];
          await api.accountsUpdate(account.id, null, next);
          refreshAccounts();
        },
      },
      { label: "Зробити підпискою за замовчуванням", disabled: account.id === globalAccountId(), action: () => setDefaultAccount(account.id) },
      { label: account.loggedIn ? "Увійти заново" : "Увійти", action: () => loginAccount(account.id) },
      "separator",
      { label: "Відкрити папку підписки", action: () => api.reveal(account.configDir) },
      ...(account.main ? [] : ["separator" as const, { label: "Видалити підписку…", danger: true, action: () => removeAccount(account) }]),
    ]);
  };
  const usage = account.usage;
  return (
    <div className={`cc-acc${open ? " open" : ""}`}>
      <div
        className={`cc-sub${account.loggedIn ? "" : " out"}`}
        style={{ "--sub": account.color } as React.CSSProperties}
        onClick={onToggle}
        onContextMenu={(event) => {
          event.preventDefault();
          menu(event);
        }}
      >
        <span className="avatar" style={{ background: account.color }}>
          {account.label.slice(0, 1).toUpperCase()}
        </span>
        <span className="cc-sub-main">
          <span className="cc-sub-name">
            <span className="cc-sub-label">{account.label}</span>
            {account.id === globalAccountId() && <Star size={11} className="cc-star" fill="currentColor" />}
            {duplicatesOf(account, accounts).length > 0 && (
              <span className="cc-dup-tag" title={`Та сама пошта, що й у ${duplicatesOf(account, accounts).map((a) => `«${a.label}»`).join(", ")}`}>
                дублікат
              </span>
            )}
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
        <button className="icon-btn tiny" title="Дії" onClick={menu}>
          <Ellipsis size={14} />
        </button>
      </div>
      {open && (
        <div className="cc-acc-body">
          <AccountEdit account={account} accounts={accounts} />
          {tabs.length > 0 && (
            <div className="cc-acc-tabs">
              {tabs.map((t) => (
                <span key={t.id} className="cc-acc-chip" onClick={() => switchProject(t.id)} title={t.root ?? t.name}>
                  <span className="ptab-dot" style={{ background: tabColor(t) }} />
                  {t.name}
                </span>
              ))}
            </div>
          )}
          {!account.loggedIn ? (
            <div className="cc-muted">Ця підписка ще не увійшла в Claude.</div>
          ) : usage ? (
            usage.limits.map((l) => <UsageBar key={l.kind + l.label} limit={l} />)
          ) : (
            <div className="cc-muted">Ліміти з'являться після першої сесії або кнопки «Оновити».</div>
          )}
          <div className="cc-acc-foot">
            <span className="cc-muted">
              {sessions} сесій{usage ? ` · дані ${relativeTime(usage.fetchedAt)}` : ""}
              {!account.main && account.shared && (
                <span className="cc-acc-shared" title="Скіли, агенти, команди, плагіни й CLAUDE.md спільні з основною підпискою">
                  <Link2 size={11} /> спільні скіли
                </span>
              )}
            </span>
            <span className="cc-acc-actions">
              {account.loggedIn && (
                <button className="icon-btn tiny" onClick={refreshUsage} title="Оновити ліміти">
                  <RefreshCw size={13} className={busy ? "spin" : ""} />
                </button>
              )}
              <button className="btn small" onClick={() => newClaudeSession(account.id)} disabled={!account.loggedIn}>
                <Play size={12} /> Сесія
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function AccountsView() {
  const ws = useActiveWorkspace();
  const accounts = useStore((s) => s.accounts);
  const sessions = useStore((s) => s.sessions);
  const workspaces = useStore((s) => s.workspaces);
  const activeId = useStore((s) => s.activeId);
  useStore((s) => s.settings.defaultAccountId);
  const [openId, setOpenId] = useState<string | null>(null);
  const active = accounts.filter((a) => a.loggedIn).length;
  return (
    <div className="cc scroll">
      <div className="cc-head">
        <span className="cc-title">Підписки</span>
        <span className="cc-head-sub">
          {active} з {accounts.length} активні
        </span>
        <button
          className="icon-btn"
          title="Оновити"
          onClick={() => {
            refreshAccounts();
            refreshSessions();
          }}
        >
          <RefreshCw size={14} strokeWidth={1.6} />
        </button>
      </div>
      <Section id="acc-focus" title={ws.root ? `Вкладка · ${ws.name}` : "Головна · за замовчуванням"}>
        <TabFocus ws={ws} accounts={accounts} />
      </Section>
      <Section id="acc-tabs" title={`Вкладки проектів · ${workspaces.length}`}>
        <div className="cc-body">
          {workspaces.length ? (
            <div className="cc-ptabs">
              {workspaces.map((w) => (
                <TabRow key={w.id} ws={w} active={w.id === activeId} accounts={accounts} />
              ))}
            </div>
          ) : (
            <div className="cc-muted">Відкрий проект угорі, і тут з'явиться його вкладка з підпискою.</div>
          )}
        </div>
      </Section>
      <Section id="acc-all" title={`Усі підписки · ${accounts.length}`}>
        <div className="cc-body cc-subs-body">
          <div className="cc-subs">
            {accounts.map((a) => (
              <AccountRow
                key={a.id}
                account={a}
                open={openId === a.id}
                onToggle={() => setOpenId(openId === a.id ? null : a.id)}
                sessions={sessions.filter((s) => s.accountId === a.id).length}
                tabs={workspaces.filter((w) => focusedAccountId(w) === a.id)}
              />
            ))}
            <button className="cc-sub-add" onClick={() => connectAccount()}>
              <Plus size={14} strokeWidth={1.8} /> Підключити підписку
            </button>
          </div>
          <div className="cc-muted cc-subs-note">Усі підписки працюють одночасно. ★ — підписка за замовчуванням для Головної і вкладок без своєї.</div>
        </div>
      </Section>
    </div>
  );
}
