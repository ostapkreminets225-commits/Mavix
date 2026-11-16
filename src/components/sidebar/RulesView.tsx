import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Ellipsis, GripVertical, Pencil, Plus, ShieldCheck, TriangleAlert } from "lucide-react";
import { confirm, openMenu, useStore, type MenuItem } from "../../store";
import { copyText, refreshRules, saveRules } from "../../actions";
import type { Rule } from "../../ipc";
import { SideHeader } from "../Sidebar";
import { Switch } from "../ui";
import { uid } from "../../util";

function useAutosize(ref: React.RefObject<HTMLTextAreaElement | null>, value: string, max = 260) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [ref, value, max]);
}

function RuleEditor({ initial, onSave, onCancel }: { initial: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  const area = useRef<HTMLTextAreaElement>(null);
  useAutosize(area, text);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <div className="rule-editor">
      <textarea
        ref={area}
        className="rule-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSave(text);
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="rule-editor-actions">
        <span className="muted small">Enter — зберегти · Esc — скасувати</span>
        <button className="btn small" onClick={onCancel}>
          Скасувати
        </button>
        <button className="btn small primary" disabled={!text.trim()} onClick={() => onSave(text)}>
          Зберегти
        </button>
      </div>
    </div>
  );
}

export function RulesView() {
  const state = useStore((s) => s.rules);
  const rules = state?.rules ?? [];
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useAutosize(input, draft, 180);

  useEffect(() => {
    refreshRules();
  }, []);

  const active = rules.filter((r) => r.enabled).length;
  const targets = state?.targets ?? [];
  const broken = targets.filter((t) => !t.ok);

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    saveRules([...rules, { id: uid("rule"), text, enabled: true, created: Date.now() }]);
    setDraft("");
    input.current?.focus();
  };

  const update = (id: string, fields: Partial<Rule>) => saveRules(rules.map((r) => (r.id === id ? { ...r, ...fields } : r)));

  const move = (id: string, to: number) => {
    const from = rules.findIndex((r) => r.id === id);
    if (from < 0) return;
    const next = [...rules];
    const [rule] = next.splice(from, 1);
    next.splice(Math.max(0, Math.min(to > from ? to - 1 : to, next.length)), 0, rule);
    if (next.some((r, i) => r.id !== rules[i].id)) saveRules(next);
  };

  const remove = async (rule: Rule) => {
    const ok = await confirm("Видалити правило?", rule.text.length > 160 ? `${rule.text.slice(0, 160)}…` : rule.text, true, "Видалити");
    if (ok) saveRules(rules.filter((r) => r.id !== rule.id));
  };

  const ruleMenu = (event: React.MouseEvent, rule: Rule, index: number) => {
    const items: MenuItem[] = [
      { label: "Редагувати", action: () => setEditing(rule.id) },
      { label: rule.enabled ? "Вимкнути" : "Увімкнути", action: () => update(rule.id, { enabled: !rule.enabled }) },
      { label: folded[rule.id] ? "Розгорнути" : "Згорнути", action: () => setFolded((f) => ({ ...f, [rule.id]: !f[rule.id] })) },
      "separator",
      { label: "Вгору", disabled: index === 0, action: () => move(rule.id, index - 1) },
      { label: "Вниз", disabled: index === rules.length - 1, action: () => move(rule.id, index + 2) },
      { label: "На початок", disabled: index === 0, action: () => move(rule.id, 0) },
      "separator",
      { label: "Дублювати", action: () => saveRules([...rules.slice(0, index + 1), { ...rule, id: uid("rule"), created: Date.now() }, ...rules.slice(index + 1)]) },
      { label: "Копіювати текст", action: () => copyText(rule.text) },
      "separator",
      { label: "Видалити", danger: true, action: () => remove(rule) },
    ];
    openMenu(event, items);
  };

  const listMenu = (event: React.MouseEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    openMenu({ clientX: rect.left, clientY: rect.bottom + 4 }, [
      { label: "Увімкнути всі", disabled: active === rules.length, action: () => saveRules(rules.map((r) => ({ ...r, enabled: true }))) },
      { label: "Вимкнути всі", disabled: active === 0, action: () => saveRules(rules.map((r) => ({ ...r, enabled: false }))) },
      "separator",
      { label: "Сортувати: увімкнені спочатку", action: () => saveRules([...rules].sort((a, b) => Number(b.enabled) - Number(a.enabled))) },
      { label: "Сортувати: А → Я", action: () => saveRules([...rules].sort((a, b) => a.text.localeCompare(b.text, "uk"))) },
      { label: "Сортувати: новіші спочатку", action: () => saveRules([...rules].sort((a, b) => b.created - a.created)) },
      "separator",
      { label: "Згорнути всі", action: () => setFolded(Object.fromEntries(rules.map((r) => [r.id, true]))) },
      { label: "Розгорнути всі", action: () => setFolded({}) },
      "separator",
      { label: "Копіювати всі правила", disabled: rules.length === 0, action: () => copyText(rules.map((r, i) => `${i + 1}. ${r.text}`).join("\n")) },
      { label: "Перевшити в Claude зараз", action: () => refreshRules() },
    ]);
  };

  return (
    <div className="side-view rules-view">
      <SideHeader title="Правила" sub={rules.length ? `${active} з ${rules.length} діють` : undefined}>
        <button className="icon-btn" title="Нове правило" onClick={() => input.current?.focus()}>
          <Plus size={15} />
        </button>
        <button className="icon-btn" title="Дії" onClick={listMenu}>
          <Ellipsis size={15} />
        </button>
      </SideHeader>
      <div className="rules-scroll">
        <div className="rules-intro">
          <ShieldCheck size={16} strokeWidth={1.8} />
          <div>
            <b>Свята святиня.</b> Claude виконує ці правила завжди: у кожному проекті, сесії, субагенті й на кожному акаунті — у чатах Mavix, терміналі, VS Code.
          </div>
        </div>

        <div className="rules-add">
          <textarea
            ref={input}
            className="rule-input"
            rows={1}
            value={draft}
            placeholder="Нове правило… наприклад: «Відповідай українською»"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                add();
              }
            }}
          />
          <button className="btn small primary" disabled={!draft.trim()} onClick={add} title="Додати (Enter)">
            <Plus size={13} /> Додати
          </button>
        </div>

        {rules.length === 0 && state && (
          <div className="rules-empty">
            Поки немає правил. Напиши перше — і воно одразу запрацює в усіх Claude на цьому ПК.
          </div>
        )}

        <div className="rules-list" onDragOver={(e) => e.preventDefault()}>
          {rules.map((rule, index) => {
            const isFolded = folded[rule.id];
            const isEditing = editing === rule.id;
            return (
              <div
                key={rule.id}
                className={`rule${rule.enabled ? "" : " off"}${dragging === rule.id ? " dragging" : ""}${dropAt === index ? " drop-before" : ""}${dropAt === index + 1 && index === rules.length - 1 ? " drop-after" : ""}`}
                onDragOver={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setDropAt(e.clientY < rect.top + rect.height / 2 ? index : index + 1);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragging && dropAt !== null) move(dragging, dropAt);
                  setDragging(null);
                  setDropAt(null);
                }}
                onContextMenu={(e) => ruleMenu(e, rule, index)}
              >
                <div className="rule-head">
                  <span
                    className="rule-grip"
                    draggable
                    title="Перетягни, щоб змінити порядок"
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", rule.id);
                      setDragging(rule.id);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropAt(null);
                    }}
                  >
                    <GripVertical size={13} />
                  </span>
                  <span className="rule-num">{index + 1}</span>
                  <button className="rule-fold" title={isFolded ? "Розгорнути" : "Згорнути"} onClick={() => setFolded((f) => ({ ...f, [rule.id]: !f[rule.id] }))}>
                    {isFolded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  </button>
                  {isFolded && !isEditing && (
                    <span className="rule-title" onDoubleClick={() => setEditing(rule.id)}>
                      {rule.text.split("\n")[0]}
                    </span>
                  )}
                  <div className="grow" />
                  <span className="rule-actions">
                    <button className="icon-btn tiny" title="Редагувати" onClick={() => setEditing(rule.id)}>
                      <Pencil size={12} />
                    </button>
                    <button className="icon-btn tiny" title="Дії" onClick={(e) => ruleMenu(e, rule, index)}>
                      <Ellipsis size={13} />
                    </button>
                  </span>
                  <Switch small on={rule.enabled} title={rule.enabled ? "Діє — натисни, щоб вимкнути" : "Вимкнено — натисни, щоб увімкнути"} onChange={(on) => update(rule.id, { enabled: on })} />
                </div>
                {isEditing ? (
                  <RuleEditor
                    initial={rule.text}
                    onCancel={() => setEditing(null)}
                    onSave={(text) => {
                      setEditing(null);
                      if (text.trim() && text.trim() !== rule.text) update(rule.id, { text: text.trim() });
                    }}
                  />
                ) : (
                  !isFolded && (
                    <div className="rule-text" onDoubleClick={() => setEditing(rule.id)} title="Подвійний клік — редагувати">
                      {rule.text}
                    </div>
                  )
                )}
              </div>
            );
          })}
        </div>

        {state && (
          <div className="rules-status">
            {active === 0 ? (
              <div className="rules-status-line muted">Немає активних правил — у Claude нічого не вшито.</div>
            ) : broken.length === 0 ? (
              <div className="rules-status-line ok">
                <ShieldCheck size={13} /> Вшито в {targets.length} {targets.length === 1 ? "акаунт" : "акаунти"}: {targets.map((t) => t.label).join(", ")}
              </div>
            ) : (
              broken.map((t) => (
                <div key={t.path} className="rules-status-line bad" title={t.path}>
                  <TriangleAlert size={13} /> {t.label}: {t.error}
                </div>
              ))
            )}
            {state.prompt && (
              <>
                <button className="link-btn" onClick={() => setShowPrompt(!showPrompt)}>
                  {showPrompt ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Що саме бачить Claude
                </button>
                {showPrompt && <pre className="rules-prompt">{state.prompt}</pre>}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
