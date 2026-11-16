import { useEffect, useMemo, useState } from "react";
import { FolderOpen, PencilLine, Trash2, Check, X as XIcon, TriangleAlert, Pin, Globe2, FolderGit2, Puzzle, FileText } from "lucide-react";
import { api, type Skill } from "../../ipc";
import { get, updateWorkspace, activeWorkspace, useStore, type Tab } from "../../store";
import { closeTab, deleteSkill, openFile, setSkillAlways, setSkillMine, toggleSkill } from "../../actions";
import { Switch } from "../ui";
import { handleMarkdownClick, renderMarkdown, splitFrontmatter } from "../../markdown";
import { basename, relativeTime } from "../../util";

type SkillTab = Extract<Tab, { kind: "skill" }>;

function scopeLabel(skill: Skill) {
  if (skill.scope === "plugin") return { icon: Puzzle, text: `Плагін ${skill.plugin}` };
  if (skill.scope === "synced") return { icon: Puzzle, text: "claude.ai · синхронізується з акаунтом" };
  if (skill.scope === "project") return { icon: FolderGit2, text: `Лише проект ${skill.project ? basename(skill.project) : ""}` };
  return { icon: Globe2, text: "Весь ПК · усі акаунти й проекти" };
}

function Check2({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <div className={`check-item${ok ? " ok" : " bad"}`}>
      {ok ? <Check size={13} /> : <XIcon size={13} />}
      <span>{children}</span>
    </div>
  );
}

export function SkillDetail({ tab }: { tab: SkillTab }) {
  const skill = useStore((s) => s.skills?.skills.find((k) => k.id === tab.skillId) ?? null);
  const usage = useStore((s) => {
    if (!skill || !s.skillUsage) return null;
    const keys = [skill.name, skill.folder, skill.plugin ? `${skill.plugin}:${skill.name}` : ""].filter(Boolean).map((k) => k.toLowerCase());
    return s.skillUsage.skills.find((u) => keys.includes(u.skill.toLowerCase())) ?? null;
  });
  const [content, setContent] = useState<string>("");
  const [files, setFiles] = useState<string[]>([]);

  useEffect(() => {
    if (!skill?.skillFile) return;
    api.readText(skill.skillFile).then((f) => setContent(f.content)).catch(() => setContent(""));
    api.skillFiles(skill.path).then(setFiles).catch(() => setFiles([]));
  }, [skill?.skillFile, skill?.path, skill?.modified]);

  useEffect(() => {
    if (skill && skill.name !== tab.title) {
      updateWorkspace(activeWorkspace().id, (w) => ({ ...w, tabs: w.tabs.map((t) => (t.id === tab.id ? { ...t, title: skill.name } : t)) }));
    }
  }, [skill?.name, tab.id, tab.title, skill]);

  const rendered = useMemo(() => {
    const { body } = splitFrontmatter(content);
    return renderMarkdown(body);
  }, [content]);

  if (!skill) {
    return (
      <div className="detail-page">
        <div className="file-message">Скіл не знайдено — можливо, його видалили або перейменували.</div>
      </div>
    );
  }

  const scope = scopeLabel(skill);
  const ScopeIcon = scope.icon;
  const plugin = skill.scope === "plugin" ? get().skills?.plugins.find((p) => p.name === skill.plugin) : null;
  const nameOk = !skill.issues.some((i) => i.startsWith("Назва") || i.startsWith("Немає поля name"));
  const descOk = !skill.issues.some((i) => i.includes("опис") || i.includes("Опис"));

  return (
    <div className="detail-page">
      <div className="detail-inner">
        <div className="detail-head">
          <div className="detail-title-row">
            <h1 className="detail-title mono">{skill.name}</h1>
            <span className={`status-pill${skill.enabled ? " on" : ""}`}>{skill.enabled ? "Увімкнено" : "Вимкнено"}</span>
            {skill.always && (
              <span className="status-pill accent">
                <Pin size={11} /> Завжди
              </span>
            )}
            {skill.mine && <span className="status-pill mine">мій</span>}
          </div>
          <div className="detail-usage">
            {usage
              ? `Використано ${usage.total}×: Claude сам ${usage.auto}×, вручну ${usage.manual}× · у ${usage.sessions} сесіях · востаннє ${relativeTime(Date.parse(usage.last))}`
              : "Claude ще жодного разу не викликав цей скіл"}
          </div>
          <div className="detail-scope">
            <ScopeIcon size={13} /> {scope.text}
            <span className="sep">·</span>
            <span className="mono muted">{skill.path}</span>
          </div>
          <p className="detail-desc">{skill.description || "Опису немає. Додай поле description у SKILL.md — за ним Claude вирішує, коли вмикати скіл."}</p>
        </div>

        <div className="control-grid">
          <div className="control-card">
            <div>
              <div className="row-title">{skill.scope === "plugin" ? "Плагін увімкнено" : "Увімкнено"}</div>
              <div className="hint">
                {skill.scope === "plugin"
                  ? "Вмикає або вимикає весь плагін у settings.json кожного акаунта"
                  : skill.enabled
                    ? "Claude бачить цей скіл і вмикає його, коли задача підходить під опис"
                    : "Скіл лежить у сховищі Mavix — Claude його не бачить"}
              </div>
            </div>
            <Switch on={skill.scope === "plugin" ? !!plugin?.enabled : skill.enabled} disabled={skill.scope === "synced"} onChange={() => toggleSkill(skill)} />
          </div>
          {skill.scope !== "plugin" && skill.scope !== "synced" && (
            <div className="control-card">
              <div>
                <div className="row-title">Завжди активний</div>
                <div className="hint">Додає правило в CLAUDE.md: завантажувати цей скіл перед кожною задачею</div>
              </div>
              <Switch on={skill.always} onChange={(on) => setSkillAlways(skill, on)} />
            </div>
          )}
          {skill.scope !== "plugin" && skill.scope !== "synced" && (
            <div className="control-card">
              <div>
                <div className="row-title">Мій скіл</div>
                <div className="hint">Показувати у вкладці «Мої» — твої власні скіли, не з паків</div>
              </div>
              <Switch on={skill.mine} onChange={(on) => setSkillMine(skill, on)} />
            </div>
          )}
        </div>

        <div className="detail-actions">
          {skill.skillFile && (
            <button className="btn" onClick={() => openFile(skill.skillFile!)}>
              <PencilLine size={13} /> Редагувати SKILL.md
            </button>
          )}
          <button className="btn" onClick={() => api.reveal(skill.path)}>
            <FolderOpen size={13} /> Відкрити папку
          </button>
          {skill.scope !== "plugin" && skill.scope !== "synced" && (
            <button
              className="btn danger"
              onClick={async () => {
                if (await deleteSkill(skill)) closeTab(tab.id);
              }}
            >
              <Trash2 size={13} /> Видалити
            </button>
          )}
        </div>

        <div className="detail-columns">
          <div className="detail-col">
            <div className="section-label">Перевірка</div>
            <div className="check-list">
              <Check2 ok={!!skill.skillFile}>Є файл SKILL.md</Check2>
              <Check2 ok={nameOk}>Назва коректна і збігається з папкою</Check2>
              <Check2 ok={descOk}>Є опис, за яким Claude вмикає скіл</Check2>
              <Check2 ok={skill.enabled}>
                {skill.scope === "project" ? "Лежить у .claude/skills проекту" : skill.scope === "plugin" ? "Плагін увімкнено" : "Лежить у ~/.claude/skills — активний для всіх акаунтів"}
              </Check2>
              {skill.always && <Check2 ok>Записаний у CLAUDE.md як «завжди активний»</Check2>}
            </div>
            {skill.issues.length > 0 && (
              <div className="issue-box">
                {skill.issues.map((issue) => (
                  <div key={issue} className="issue-line">
                    <TriangleAlert size={12} /> {issue}
                  </div>
                ))}
              </div>
            )}
            <div className="section-label spaced">Файли · {skill.files}</div>
            <div className="file-list">
              {files.map((f) => (
                <button key={f} className="file-list-item" onClick={() => openFile(`${skill.path}\\${f.replace(/\//g, "\\")}`)}>
                  <FileText size={12} /> {f}
                </button>
              ))}
            </div>
            {skill.modified > 0 && <div className="hint spaced">Змінено {relativeTime(skill.modified)}</div>}
          </div>
          <div className="detail-col wide">
            <div className="section-label">SKILL.md</div>
            <div className="md skill-md" onClick={handleMarkdownClick} dangerouslySetInnerHTML={{ __html: rendered }} />
          </div>
        </div>
      </div>
    </div>
  );
}
