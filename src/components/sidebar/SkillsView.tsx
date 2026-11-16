import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUpDown, FileUp, FolderOpen, FolderUp, Globe, Layers, Pin, Plus, Puzzle, RefreshCw, Search, Star, TriangleAlert, X, Zap } from "lucide-react";
import { openMenu, useActiveWorkspace, useStore, type MenuItem } from "../../store";
import {
  copyText,
  disableAllSkills,
  enableAllSkills,
  importSkillDialog,
  importSkillFolderDialog,
  loadProjectSkills,
  openNewSkill,
  openSkill,
  refreshSkillUsage,
  refreshSkills,
  setSkillAlways,
  setProjectSkills,
  setSkillMine,
  skillKey,
  togglePlugin,
  toggleSkill,
} from "../../actions";
import { api, type Skill, type SkillUsage } from "../../ipc";
import { SideHeader } from "../Sidebar";
import { Switch } from "../ui";
import { basename, relativeTime } from "../../util";

type View = "used" | "mine" | "all";
type Scope = "everywhere" | "project";
type Filter = "any" | "on" | "off" | "always" | "project" | "plugin" | "issues" | "unused";
type Sort = "usage" | "recent" | "name" | "added";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "on", label: "Увімкнені" },
  { id: "off", label: "Вимкнені" },
  { id: "always", label: "Завжди" },
  { id: "project", label: "Проект" },
  { id: "plugin", label: "Плагіни" },
  { id: "unused", label: "Не використовувались" },
  { id: "issues", label: "З помилками" },
];

const SORTS: { id: Sort; label: string }[] = [
  { id: "usage", label: "Найчастіше використовувані" },
  { id: "recent", label: "Нещодавно використані" },
  { id: "name", label: "За назвою А → Я" },
  { id: "added", label: "Нещодавно додані" },
];

let rememberedView: View = "used";
let rememberedScope: Scope = "everywhere";
let rememberedSort: Sort = "usage";

const ROW_HEIGHT = 50;
const ROW_STRIDE = ROW_HEIGHT + 2;
const OVERSCAN_ROWS = 8;

type Row = { skill: Skill; usage: SkillUsage | null; active: boolean };

type ProjectControl = { name: string; on: boolean; toggle: (skill: Skill) => void };

function matchesFilter(row: Row, filter: Filter): boolean {
  const { skill, usage } = row;
  switch (filter) {
    case "any":
      return true;
    case "on":
      return row.active;
    case "off":
      return !row.active;
    case "always":
      return skill.always;
    case "project":
      return skill.scope === "project";
    case "plugin":
      return skill.scope === "plugin" || skill.scope === "synced";
    case "issues":
      return skill.issues.length > 0;
    case "unused":
      return !usage;
  }
}

function matchesView(row: Row, view: View): boolean {
  if (view === "used") return !!row.usage;
  if (view === "mine") return row.skill.mine;
  return true;
}

function compare(sort: Sort) {
  return (a: Row, b: Row) => {
    const byName = a.skill.name.localeCompare(b.skill.name);
    switch (sort) {
      case "usage":
        return (b.usage?.total ?? 0) - (a.usage?.total ?? 0) || Number(b.skill.always) - Number(a.skill.always) || Number(b.active) - Number(a.active) || byName;
      case "recent":
        return (b.usage?.last ?? "").localeCompare(a.usage?.last ?? "") || byName;
      case "added":
        return b.skill.created - a.skill.created || byName;
      case "name":
        return byName;
    }
  };
}

function usageTooltip(skill: Skill, usage: SkillUsage | null): string {
  const lines = [skill.description || "Без опису", ""];
  if (!usage) {
    lines.push("Claude ще не викликав цей скіл");
    return lines.join("\n");
  }
  if (usage.auto) lines.push(`Claude сам викликав ${usage.auto} раз`);
  if (usage.manual) lines.push(`Вручну ${usage.manual} раз`);
  if (usage.sessions) lines.push(`У ${usage.sessions} ${usage.sessions === 1 ? "сесії" : "сесіях"}`);
  const last = Date.parse(usage.last);
  if (last) lines.push(`Востаннє ${relativeTime(last)}`);
  return lines.join("\n");
}

function skillsWord(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return "скілів";
  if (ones === 1) return "скіл";
  if (ones >= 2 && ones <= 4) return "скіли";
  return "скілів";
}

const SkillRow = memo(function SkillRow({ row, top, project }: { row: Row; top: number; project: ProjectControl | null }) {
  const { skill, usage } = row;
  const menu = (event: React.MouseEvent) => {
    const items: MenuItem[] = [
      { label: "Відкрити", action: () => openSkill(skill) },
      project
        ? { label: row.active ? `Вимкнути в «${project.name}»` : `Увімкнути в «${project.name}»`, disabled: !skill.enabled, action: () => project.toggle(skill) }
        : { label: skill.enabled ? "Вимкнути" : "Увімкнути", disabled: skill.scope === "synced", action: () => toggleSkill(skill) },
      { label: skill.always ? "Не тримати завжди активним" : "Завжди активний", disabled: skill.scope === "plugin" || skill.scope === "synced", action: () => setSkillAlways(skill, !skill.always) },
      "separator",
      skill.mine
        ? { label: "Прибрати з «Мої»", action: () => setSkillMine(skill, false) }
        : { label: "Позначити як мій", disabled: skill.scope === "plugin" || skill.scope === "synced", action: () => setSkillMine(skill, true) },
      "separator",
      { label: "Копіювати назву", action: () => copyText(skill.name) },
      { label: "Показати в Провіднику", action: () => api.reveal(skill.skillFile ?? skill.path) },
    ];
    openMenu(event, items);
  };
  return (
    <div
      className={`sk-row${row.active ? "" : " off"}`}
      style={{ transform: `translateY(${top}px)` }}
      onClick={() => openSkill(skill)}
      onContextMenu={menu}
      title={usageTooltip(skill, usage)}
    >
      <div className="sk-main">
        <div className="sk-name">
          <span className="sk-title">{skill.name}</span>
          {skill.mine && <Star size={11} className="sk-star" aria-label="Мій скіл" />}
          {skill.always && <Pin size={11} className="sk-pin" aria-label="Завжди активний" />}
          {skill.scope === "project" && <span className="sk-tag">{skill.project ? basename(skill.project) : "проект"}</span>}
          {(skill.scope === "plugin" || skill.scope === "synced") && <span className="sk-tag">{skill.plugin}</span>}
          {skill.issues.length > 0 && (
            <span className="sk-issue" title={skill.issues.join("\n")}>
              <TriangleAlert size={11} />
            </span>
          )}
        </div>
        <div className="sk-desc">{skill.description || "Без опису"}</div>
      </div>
      <div className="sk-side">
        {usage && <span className="sk-count">{usage.total}×</span>}
        {project ? (
          <Switch
            on={row.active}
            small
            disabled={!skill.enabled}
            title={!skill.enabled ? "Вимкнений скрізь. Спершу увімкни його у вкладці «Скрізь»" : row.active ? `Вимкнути в «${project.name}»` : `Увімкнути в «${project.name}»`}
            onChange={() => project.toggle(skill)}
          />
        ) : (
          <Switch
            on={skill.enabled}
            small
            disabled={skill.scope === "synced"}
            title={skill.scope === "synced" ? "Синхронізується з claude.ai" : skill.enabled ? "Вимкнути" : "Увімкнути"}
            onChange={() => toggleSkill(skill)}
          />
        )}
      </div>
    </div>
  );
});

function VirtualRows({ rows, resetKey, empty, project }: { rows: Row[]; resetKey: string; empty: React.ReactNode; project: ProjectControl | null }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 900 });
  const frame = useRef(0);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = 0;
    setViewport((v) => ({ ...v, top: 0 }));
  }, [resetKey]);

  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = scroller.current;
      if (el) setViewport({ top: el.scrollTop, height: el.clientHeight });
    });
  };

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const first = Math.max(0, Math.floor(viewport.top / ROW_STRIDE) - OVERSCAN_ROWS);
  const last = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / ROW_STRIDE) + OVERSCAN_ROWS);

  return (
    <div className="side-scroll sk-list" ref={scroller} onScroll={onScroll}>
      <div className="sk-canvas" style={{ height: rows.length * ROW_STRIDE }}>
        {rows.slice(first, last).map((row, offset) => (
          <SkillRow key={row.skill.id} row={row} top={(first + offset) * ROW_STRIDE} project={project} />
        ))}
      </div>
      {rows.length === 0 && empty}
    </div>
  );
}

function MasterSwitch({ on, total, restorable, cloud }: { on: number; total: number; restorable: boolean; cloud: number }) {
  const bulk = useStore((s) => s.skillsBulk);
  const allOff = on === 0;
  const shown = bulk === "off" ? 0 : bulk === "on" ? total : on;
  const percent = total ? (shown / total) * 100 : 0;

  const title = bulk === "off" ? "Вимикаю скіли" : bulk === "on" ? "Вмикаю скіли" : allOff ? "Скіли вимкнені" : "Скіли увімкнені";
  let hint: string;
  if (bulk === "off") hint = `Ховаю ${on} ${skillsWord(on)} від Claude`;
  else if (bulk === "on") hint = restorable ? "Повертаю все як було" : `Вмикаю ${total} ${skillsWord(total)}`;
  else if (allOff) hint = restorable ? "Claude працює без скілів. Увімкни, і повернеться все як було" : "Claude працює без скілів";
  else if (on === total) hint = `Claude бачить усі ${total} в кожному акаунті й проекті`;
  else hint = `Claude бачить ${on} з ${total}`;

  const cloudNote = cloud > 0 ? `\n${cloud} ${skillsWord(cloud)} з claude.ai вмикаються в налаштуваннях claude.ai` : "";

  return (
    <div className={`sk-master${allOff && !bulk ? " is-off" : ""}${bulk ? " is-busy" : ""}`}>
      <div className="sk-master-head">
        <div className="sk-master-text">
          <div className="sk-master-title">{title}</div>
          <div className="sk-master-hint">{hint}</div>
        </div>
        <Switch
          on={bulk ? bulk === "on" : !allOff}
          disabled={!!bulk || total === 0}
          title={(allOff ? "Увімкнути скіли" : "Вимкнути всі скіли для Claude") + cloudNote}
          onChange={(next) => (next ? enableAllSkills() : disableAllSkills())}
        />
      </div>
      <div className="sk-master-meter" role="meter" aria-valuemin={0} aria-valuemax={total} aria-valuenow={shown} aria-label="Увімкнені скіли">
        <i style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function ProjectSwitch({ name, on, picked, total, onChange }: { name: string; on: boolean; picked: number; total: number; onChange: (on: boolean) => void }) {
  const percent = total ? ((on ? picked : total) / total) * 100 : 0;
  const title = on ? `Лише вибрані в «${name}»` : `У «${name}» діють усі скіли`;
  const hint = on ? `Claude бачить ${picked} з ${total} ${skillsWord(total)} у цьому проекті` : "Увімкни й залиш лише ті скіли, які потрібні в цьому проекті";
  return (
    <div className={`sk-master${on && picked === 0 ? " is-off" : ""}`}>
      <div className="sk-master-head">
        <div className="sk-master-text">
          <div className="sk-master-title">{title}</div>
          <div className="sk-master-hint">{hint}</div>
        </div>
        <Switch on={on} title={on ? "Повернути всі скіли в цьому проекті" : "Вибрати скіли лише для цього проекту"} onChange={onChange} />
      </div>
      <div className="sk-master-meter" role="meter" aria-valuemin={0} aria-valuemax={total} aria-valuenow={on ? picked : total} aria-label="Скіли в проекті">
        <i style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function SkillsView() {
  const snapshot = useStore((s) => s.skills);
  const loading = useStore((s) => s.skillsLoading);
  const usage = useStore((s) => s.skillUsage);
  const usageLoading = useStore((s) => s.skillUsageLoading);
  const [view, setViewState] = useState<View>(rememberedView);
  const [sort, setSortState] = useState<Sort>(rememberedSort);
  const [filter, setFilter] = useState<Filter>("any");
  const [query, setQuery] = useState("");
  const ws = useActiveWorkspace();
  const root = ws.root;
  const [scopeState, setScopeState] = useState<Scope>(rememberedScope);
  const scope: Scope = root ? scopeState : "everywhere";
  const projectState = useStore((s) => (root ? s.projectSkills[root] : undefined));
  const setScope = (next: Scope) => {
    rememberedScope = next;
    setScopeState(next);
    setFilter("any");
  };

  useEffect(() => {
    if (root) loadProjectSkills(root);
  }, [root]);

  const setView = (next: View) => {
    rememberedView = next;
    setViewState(next);
    setFilter("any");
  };
  const setSort = (next: Sort) => {
    rememberedSort = next;
    setSortState(next);
  };

  useEffect(() => {
    refreshSkillUsage();
  }, []);

  const projectOn = scope === "project" && !!projectState?.on;
  const picked = useMemo(() => new Set((projectState?.selected ?? []).map((k) => k.toLowerCase())), [projectState]);

  const rows = useMemo<Row[]>(() => {
    const byName = new Map<string, SkillUsage>();
    for (const u of usage?.skills ?? []) byName.set(u.skill.toLowerCase(), u);
    return (snapshot?.skills ?? [])
      .filter((skill) => scope === "everywhere" || skill.scope !== "project" || (!!root && !!skill.project && skill.project.toLowerCase() === root.toLowerCase()))
      .map((skill) => ({
        skill,
        usage:
          byName.get(skill.name.toLowerCase()) ??
          (skill.plugin ? byName.get(`${skill.plugin}:${skill.name}`.toLowerCase()) : undefined) ??
          byName.get(skill.folder.toLowerCase()) ??
          null,
        active: scope === "project" ? skill.enabled && (!projectOn || picked.has(skillKey(skill).toLowerCase())) : skill.enabled,
      }));
  }, [snapshot, usage, scope, root, projectOn, picked]);

  const enabledKeys = useMemo(() => rows.filter((r) => r.skill.enabled).map((r) => skillKey(r.skill)), [rows]);
  const pickedCount = useMemo(() => rows.filter((r) => r.skill.enabled && r.active).length, [rows]);

  const project = useMemo<ProjectControl | null>(() => {
    if (scope !== "project" || !root) return null;
    return {
      name: ws.name,
      on: projectOn,
      toggle: (skill: Skill) => {
        if (!skill.enabled) return;
        const key = skillKey(skill);
        const lower = key.toLowerCase();
        if (!projectOn) {
          setProjectSkills(root, true, enabledKeys.filter((k) => k.toLowerCase() !== lower));
          return;
        }
        const current = projectState?.selected ?? [];
        const has = current.some((k) => k.toLowerCase() === lower);
        setProjectSkills(root, true, has ? current.filter((k) => k.toLowerCase() !== lower) : [...current, key]);
      },
    };
  }, [scope, root, ws.name, projectOn, enabledKeys, projectState]);

  const counts = useMemo(() => {
    const result = { used: 0, mine: 0, all: rows.length, calls: 0, switchable: 0, switchableOn: 0, cloud: 0 };
    for (const row of rows) {
      if (row.usage) {
        result.used += 1;
        result.calls += row.usage.total;
      }
      if (row.skill.mine) result.mine += 1;
      if (row.skill.scope === "synced") {
        result.cloud += 1;
      } else {
        result.switchable += 1;
        if (row.skill.enabled) result.switchableOn += 1;
      }
    }
    return result;
  }, [rows]);

  const inView = useMemo(() => rows.filter((row) => matchesView(row, view)), [rows, view]);

  const filterCounts = useMemo(() => {
    const result = {} as Record<Filter, number>;
    for (const f of FILTERS) result[f.id] = inView.filter((row) => matchesFilter(row, f.id)).length;
    return result;
  }, [inView]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return inView
      .filter((row) => matchesFilter(row, filter))
      .filter((row) => !q || row.skill.name.toLowerCase().includes(q) || row.skill.description.toLowerCase().includes(q))
      .sort(compare(sort));
  }, [inView, filter, query, sort]);

  const scanning = usageLoading && !usage;

  const sortMenu = (event: React.MouseEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    openMenu(
      { clientX: rect.left - 160, clientY: rect.bottom + 4 },
      SORTS.map((s) => ({ label: s.label, shortcut: s.id === sort ? "✓" : undefined, action: () => setSort(s.id) })),
    );
  };

  const visibleFilters = FILTERS.filter((f) => filterCounts[f.id] > 0 && filterCounts[f.id] < inView.length);

  return (
    <>
      <SideHeader title="Скіли" sub={snapshot ? undefined : "…"}>
        <button className="icon-btn" title="Новий скіл з Markdown" onClick={() => openNewSkill()}>
          <Plus size={15} />
        </button>
        <button className="icon-btn" title="Завантажити .md, .zip або .skill (або просто перетягни файл у вікно)" onClick={importSkillDialog}>
          <FileUp size={15} strokeWidth={1.6} />
        </button>
        <button className="icon-btn" title="Встановити з папки зі SKILL.md" onClick={importSkillFolderDialog}>
          <FolderUp size={15} strokeWidth={1.6} />
        </button>
        <button
          className="icon-btn"
          title="Оновити список і статистику"
          onClick={() => {
            refreshSkills();
            refreshSkillUsage();
          }}
        >
          <RefreshCw size={14} strokeWidth={1.6} className={loading || usageLoading ? "spin" : ""} />
        </button>
      </SideHeader>

      <div className="sk-top">
        {root && (
          <div className="sk-tabs sk-scope">
            <button className={scope === "everywhere" ? "on" : ""} onClick={() => setScope("everywhere")} title="Скіли для всіх проектів і акаунтів">
              <Globe size={13} /> Скрізь
            </button>
            <button className={scope === "project" ? "on" : ""} onClick={() => setScope("project")} title={`Які скіли бачить Claude лише в проекті ${root}`}>
              <FolderOpen size={13} /> Лише «{ws.name}»
            </button>
          </div>
        )}

        {snapshot && scope === "everywhere" && <MasterSwitch on={counts.switchableOn} total={counts.switchable} restorable={snapshot.restorable > 0} cloud={counts.cloud} />}
        {snapshot && project && root && (
          <ProjectSwitch name={ws.name} on={projectOn} picked={pickedCount} total={enabledKeys.length} onChange={(next) => setProjectSkills(root, next, next ? enabledKeys : [])} />
        )}
        {project && projectOn && root && (
          <div className="sk-chips">
            <button className="sk-chip" onClick={() => setProjectSkills(root, true, [])}>
              <X size={11} /> Зняти всі
            </button>
            <button className="sk-chip" onClick={() => setProjectSkills(root, true, enabledKeys)}>
              Відмітити всі
            </button>
          </div>
        )}

        <div className="sk-tabs">
          <button className={view === "used" ? "on" : ""} onClick={() => setView("used")} title="Скіли, які Claude реально викликав у твоїх сесіях">
            <Zap size={13} /> У роботі <span>{usage ? counts.used : "…"}</span>
          </button>
          <button className={view === "mine" ? "on" : ""} onClick={() => setView("mine")} title="Твої власні скіли, створені або додані тобою, не з паків">
            <Star size={13} /> Мої <span>{counts.mine}</span>
          </button>
          <button className={view === "all" ? "on" : ""} onClick={() => setView("all")} title="Усі встановлені скіли">
            <Layers size={13} /> Усі <span>{counts.all}</span>
          </button>
        </div>

        <div className="sk-search">
          <Search size={13} />
          <input placeholder={`Пошук серед ${inView.length}`} value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && (
            <button className="icon-btn tiny" onClick={() => setQuery("")} title="Очистити">
              <X size={12} />
            </button>
          )}
          <button className="icon-btn" title={`Сортування: ${SORTS.find((s) => s.id === sort)?.label}`} onClick={sortMenu}>
            <ArrowUpDown size={13} />
          </button>
        </div>

        {visibleFilters.length > 0 && (
          <div className="sk-chips">
            {filter !== "any" && (
              <button className="sk-chip" onClick={() => setFilter("any")}>
                <X size={11} /> Скинути
              </button>
            )}
            {visibleFilters.map((f) => (
              <button key={f.id} className={`sk-chip${filter === f.id ? " on" : ""}${f.id === "issues" ? " warn" : ""}`} onClick={() => setFilter(filter === f.id ? "any" : f.id)}>
                {f.label} <span>{filterCounts[f.id]}</span>
              </button>
            ))}
          </div>
        )}

        {view === "used" && (scanning || usage) && (
          <div className="sk-note">
            {scanning ? "Рахую, які скіли викликає Claude. Перший раз це до хвилини" : `${counts.calls} викликів у ${usage?.files ?? 0} сесіях усіх акаунтів`}
          </div>
        )}
        {view === "mine" && (
          <div className="sk-note">
            Створені або додані тобою. Будь-який інший скіл: ПКМ, «Позначити як мій»
            <button className="sk-new" onClick={() => openNewSkill()}>
              <Plus size={12} /> Новий скіл
            </button>
          </div>
        )}
      </div>

      {filter === "plugin" && snapshot && snapshot.plugins.length > 0 && (
        <div className="plugin-list">
          {snapshot.plugins.map((p) => (
            <div key={p.key} className="plugin-row">
              <Puzzle size={14} strokeWidth={1.6} />
              <div className="plugin-main">
                <div className="plugin-name">
                  {p.name} <span className="muted">{p.version}</span>
                </div>
                <div className="plugin-desc">
                  {p.skills} скілів, {p.key}
                </div>
              </div>
              <Switch
                on={p.enabled}
                title={p.enabled ? "Вимкнути плагін" : "Увімкнути плагін"}
                onChange={(next) => togglePlugin(p.key, next)}
              />
            </div>
          ))}
        </div>
      )}

      <VirtualRows
        rows={list}
        project={project}
        resetKey={`${view}|${filter}|${sort}|${query}|${scope}`}
        empty={
          snapshot &&
          !scanning && (
            <div className="side-note">
              {query
                ? "Нічого не знайдено."
                : view === "used"
                  ? "Claude ще не викликав жодного скіла."
                  : view === "mine"
                    ? "Тут поки порожньо. Створи скіл або познач наявний як свій."
                    : "Немає скілів."}
            </div>
          )
        }
      />
    </>
  );
}
