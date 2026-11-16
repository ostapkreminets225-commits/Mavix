import { useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import { Sparkles, Check, TriangleAlert, Globe2, FolderGit2, Pin, Wand2, FileUp, ChevronDown, ChevronRight } from "lucide-react";
import { createMarkdownState } from "../../editor/setup";
import { activeWorkspace, confirm, toast, updateWorkspace, useActiveWorkspace, useStore, type Tab } from "../../store";
import { createSkill, importSkillDialog, openSkill } from "../../actions";
import { splitFrontmatter } from "../../markdown";
import { basename, slugify } from "../../util";
import { Segmented, Switch } from "../ui";

type NewSkillTab = Extract<Tab, { kind: "new-skill" }>;

const PLACEHOLDER = `Встав сюди Markdown із правилами, наприклад:

# Стиль коду

- Пиши без коментарів
- Короткі функції з ясними назвами

Mavix сам зробить із цього скіл: назву, опис і SKILL.md.`;

function deriveName(markdown: string, sourceName: string | null): string {
  const { fields, body } = splitFrontmatter(markdown);
  const fromFront = fields.find((f) => f.key === "name")?.value;
  if (fromFront) return slugify(fromFront);
  const heading = body.split("\n").find((l) => /^#{1,3}\s+\S/.test(l));
  if (heading) return slugify(heading.replace(/^#+\s+/, ""));
  if (sourceName) return slugify(basename(sourceName).replace(/\.[^.]+$/, ""));
  const words = body.trim().split(/\s+/).slice(0, 5).join(" ");
  return slugify(words);
}

function deriveDescription(markdown: string): string {
  const { fields, body } = splitFrontmatter(markdown);
  const fromFront = fields.find((f) => f.key === "description")?.value;
  if (fromFront) return fromFront;
  const lines = body.split("\n");
  const paragraph: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (paragraph.length) break;
      continue;
    }
    if (/^#{1,6}\s/.test(line) || line.startsWith("```") || line.startsWith("---")) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(line.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, ""));
    if (paragraph.join(" ").length > 260) break;
  }
  const heading = lines.find((l) => /^#{1,3}\s+\S/.test(l))?.replace(/^#+\s+/, "").trim();
  const text = paragraph.join(" ").replace(/\s+/g, " ").slice(0, 400);
  if (heading && text) return `${heading}. ${text}`;
  return heading ?? text;
}

function quote(text: string): string {
  return `"${text.replace(/\s+/g, " ").trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function NewSkill({ tab }: { tab: NewSkillTab }) {
  const ws = useActiveWorkspace();
  const skills = useStore((s) => s.skills);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [markdown, setMarkdown] = useState(tab.markdown);
  const [name, setName] = useState(() => deriveName(tab.markdown, tab.sourceName));
  const [description, setDescription] = useState(() => deriveDescription(tab.markdown));
  const [nameTouched, setNameTouched] = useState(false);
  const [descTouched, setDescTouched] = useState(false);
  const [scope, setScope] = useState<"user" | "project">("user");
  const [always, setAlways] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    view.current = new EditorView({ parent: host.current!, state: createMarkdownState(tab.markdown, setMarkdown, PLACEHOLDER) });
    view.current.focus();
    return () => view.current?.destroy();
  }, []);

  useEffect(() => {
    if (!nameTouched) setName(deriveName(markdown, tab.sourceName));
    if (!descTouched) setDescription(deriveDescription(markdown));
  }, [markdown, nameTouched, descTouched, tab.sourceName]);

  useEffect(() => {
    updateWorkspace(activeWorkspace().id, (w) => ({ ...w, tabs: w.tabs.map((t) => (t.id === tab.id ? { ...t, markdown } : t)) }));
  }, [markdown, tab.id]);

  const body = splitFrontmatter(markdown).body.trim();
  const project = scope === "project" ? ws.root : null;
  const existing = skills?.skills.find((s) => s.folder === name && (scope === "user" ? s.scope === "user" : s.scope === "project" && s.project === project));
  const checks = [
    { ok: body.length > 0, text: "Є текст правил" },
    { ok: /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length <= 64, text: "Назва: малі латинські літери, цифри, дефіси" },
    { ok: description.trim().length > 0, text: "Є опис — за ним Claude вирішує, коли вмикати скіл" },
    { ok: description.length <= 1024, text: "Опис до 1024 символів" },
    { ok: scope === "user" || !!ws.root, text: "Вибрано, де активувати" },
  ];
  const ready = checks.every((c) => c.ok);

  const preview = useMemo(
    () => `---\nname: ${name}\ndescription: ${quote(description)}\n---\n\n${body}\n`,
    [name, description, body],
  );

  const submit = async () => {
    if (!ready || busy) return;
    if (existing) {
      const replace = await confirm(`Скіл «${name}» уже існує`, "Перезаписати його SKILL.md новим текстом?", true, "Перезаписати");
      if (!replace) return;
    }
    setBusy(true);
    const skill = await createSkill({ markdown, name, description, scope, project, always, overwrite: !!existing });
    setBusy(false);
    if (!skill) return;
    toast(
      scope === "user"
        ? `Скіл «${skill.name}» активний на всьому ПК — для всіх акаунтів і проектів${always ? ", і завжди вмикається" : ""}`
        : `Скіл «${skill.name}» активний у проекті ${ws.name}`,
      "ok",
    );
    updateWorkspace(activeWorkspace().id, (w) => ({ ...w, tabs: w.tabs.filter((t) => t.id !== tab.id) }));
    openSkill(skill);
  };

  return (
    <div className="new-skill">
      <div className="new-skill-editor">
        <div className="pane-head">
          <Sparkles size={14} className="accent" />
          <span>Правила скіла · Markdown</span>
          <div className="grow" />
          <button className="btn small" onClick={importSkillDialog}>
            <FileUp size={12} /> З файлу
          </button>
        </div>
        <div ref={host} className="cm-host md-input" />
      </div>
      <div className="new-skill-form">
        <div className="form-scroll">
          <h2 className="form-title">Новий скіл</h2>
          <p className="form-lead">Встав правила зліва — Mavix складе SKILL.md, покладе його куди треба й перевірить, що Claude його бачить.</p>

          <label className="field-label">Назва</label>
          <input
            className="input mono"
            value={name}
            onChange={(e) => {
              setNameTouched(true);
              setName(slugify(e.target.value.replace(/\s/g, "-"), 64) || e.target.value.toLowerCase());
            }}
            placeholder="my-skill"
          />
          {existing && <div className="hint warn-text">Такий скіл уже є — його буде перезаписано</div>}

          <label className="field-label">
            Коли вмикати <span className="muted">{description.length}/1024</span>
          </label>
          <textarea
            className="input textarea"
            rows={4}
            value={description}
            onChange={(e) => {
              setDescTouched(true);
              setDescription(e.target.value);
            }}
            placeholder="Що робить скіл і коли Claude має його вмикати"
          />
          {!descTouched && description && (
            <div className="hint">
              <Wand2 size={11} /> Опис узято з тексту. Краще допиши, у яких задачах його вмикати.
            </div>
          )}

          <label className="field-label">Де активувати</label>
          <Segmented
            value={scope}
            onChange={setScope}
            options={[
              { value: "user", label: "Весь ПК" },
              { value: "project", label: ws.root ? `Проект ${ws.name}` : "Проект", disabled: !ws.root },
            ]}
          />
          <div className="scope-note">
            {scope === "user" ? (
              <>
                <Globe2 size={12} /> ~/.claude/skills — бачать усі акаунти Claude у всіх проектах
              </>
            ) : (
              <>
                <FolderGit2 size={12} /> {ws.root}\.claude\skills — лише цей проект
              </>
            )}
          </div>

          <div className="row-between boxed">
            <div>
              <div className="row-title">
                <Pin size={12} /> Завжди активний
              </div>
              <div className="hint">Записати в CLAUDE.md правило вантажити цей скіл перед кожною задачею</div>
            </div>
            <Switch on={always} onChange={setAlways} />
          </div>

          <div className="check-list">
            {checks.map((c) => (
              <div key={c.text} className={`check-item${c.ok ? " ok" : " bad"}`}>
                {c.ok ? <Check size={13} /> : <TriangleAlert size={13} />}
                <span>{c.text}</span>
              </div>
            ))}
          </div>

          <button className="collapse-toggle" onClick={() => setShowPreview(!showPreview)}>
            {showPreview ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Що буде записано в SKILL.md
          </button>
          {showPreview && <pre className="skill-preview">{preview}</pre>}
        </div>
        <div className="form-foot">
          <button className="btn primary wide big" disabled={!ready || busy} onClick={submit}>
            <Sparkles size={14} /> {busy ? "Створюю…" : existing ? "Оновити скіл" : "Створити й активувати"}
          </button>
        </div>
      </div>
    </div>
  );
}
