import { useEffect, useState } from "react";
import { Check, Plus, FolderTree, FileText, ScanLine, Wand2, PencilLine, FolderPlus } from "lucide-react";
import { api, errorText, type PlanItem } from "../../ipc";
import { toast, updateWorkspace, useActiveWorkspace, useStore } from "../../store";
import { applyStructure, openFile, openStructure, saveTemplates } from "../../actions";
import { SideHeader } from "../Sidebar";
import { Switch } from "../ui";
import { FileIcon } from "../FileIcon";
import { uid } from "../../util";

export function StructureView() {
  const ws = useActiveWorkspace();
  const templates = useStore((s) => s.templates);
  const template = templates.find((t) => t.id === ws.structureId) ?? null;
  const [plan, setPlan] = useState<PlanItem[] | null>(null);

  useEffect(() => {
    if (!ws.root || !template) {
      setPlan(null);
      return;
    }
    let alive = true;
    api
      .structurePlan(ws.root, template.tree)
      .then((p) => alive && setPlan(p))
      .catch(() => alive && setPlan(null));
    return () => {
      alive = false;
    };
  }, [ws.root, template?.tree, template]);

  const missing = plan?.filter((p) => !p.exists).length ?? 0;

  const capture = async () => {
    if (!ws.root) return;
    try {
      const tree = await api.structureCapture(ws.root, 3);
      const created = { id: uid("tpl"), name: `${ws.name} · знімок`, tree, builtin: false };
      await saveTemplates([...templates, created]);
      updateWorkspace(ws.id, (w) => ({ ...w, structureId: created.id }));
      openStructure(created.id);
      toast("Поточну структуру збережено як шаблон", "ok");
    } catch (error) {
      toast(errorText(error), "error");
    }
  };

  const writeClaude = async () => {
    if (!ws.root || !template) return;
    try {
      const file = await api.structureWriteClaudeMd(ws.root, template.tree);
      toast("Правило структури записано в CLAUDE.md — Claude триматиметься цих папок", "ok");
      openFile(file);
    } catch (error) {
      toast(errorText(error), "error");
    }
  };

  const refreshPlan = async () => {
    if (!ws.root || !template) return;
    await applyStructure(ws.root, template.tree);
    setPlan(await api.structurePlan(ws.root, template.tree));
  };

  return (
    <>
      <SideHeader title="Структура папок" />
      <div className="side-scroll pad">
        {ws.root ? (
          <div className="card">
            <div className="card-title">
              <FolderTree size={14} /> {ws.name}
            </div>
            <label className="field-label">Архітектура проекту</label>
            <select
              className="input"
              value={ws.structureId ?? ""}
              onChange={(e) => updateWorkspace(ws.id, (w) => ({ ...w, structureId: e.target.value || null }))}
            >
              <option value="">— не задано —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <div className="row-between">
              <div>
                <div className="row-title">Підтримувати автоматично</div>
                <div className="hint">При кожному відкритті проекту Mavix створить відсутні папки</div>
              </div>
              <Switch on={ws.autoStructure} onChange={(on) => updateWorkspace(ws.id, (w) => ({ ...w, autoStructure: on }))} />
            </div>
            {template && plan && (
              <>
                <div className="plan-summary">
                  {missing === 0 ? (
                    <span className="ok-text">
                      <Check size={13} /> Структура повна
                    </span>
                  ) : (
                    <span className="warn-text">Бракує: {missing}</span>
                  )}
                  <span className="muted">{plan.length} елементів</span>
                </div>
                <div className="plan-list">
                  {plan.slice(0, 80).map((item) => (
                    <div key={item.path} className={`plan-item${item.exists ? " exists" : " missing"}`} style={{ paddingLeft: 6 + item.depth * 14 }}>
                      <FileIcon name={item.name} dir={item.dir} size={13} />
                      <span>{item.name}</span>
                      {!item.exists && <span className="plan-new">+</span>}
                    </div>
                  ))}
                </div>
                <div className="btn-row">
                  <button className="btn primary grow" onClick={refreshPlan} disabled={missing === 0}>
                    <Wand2 size={13} /> Створити відсутні
                  </button>
                  <button className="btn" onClick={writeClaude} title="Записати структуру як правило в CLAUDE.md проекту">
                    <FileText size={13} /> CLAUDE.md
                  </button>
                </div>
              </>
            )}
            <div className="btn-row">
              <button className="btn grow" onClick={capture}>
                <ScanLine size={13} /> Зняти з проекту
              </button>
              {template && (
                <button className="btn" onClick={() => openStructure(template.id)}>
                  <PencilLine size={13} /> Редагувати
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="side-note">Відкрий проект, щоб задати йому структуру. Або створи новий проект одразу зі структурою.</div>
        )}
        <button className="btn wide" onClick={() => window.dispatchEvent(new CustomEvent("mavix:new-project"))}>
          <FolderPlus size={14} /> Новий проект зі структурою
        </button>
        <div className="section-label spaced">Шаблони</div>
        {templates.map((t) => (
          <button key={t.id} className={`template-row${t.id === ws.structureId ? " active" : ""}`} onClick={() => openStructure(t.id)}>
            <FolderTree size={14} strokeWidth={1.6} />
            <span className="grow">{t.name}</span>
            {t.builtin && <span className="tag">вбудований</span>}
          </button>
        ))}
        <button
          className="btn wide dashed"
          onClick={async () => {
            const created = { id: uid("tpl"), name: "Мій шаблон", tree: "src/\n  components/\n  lib/\ndocs/\nREADME.md\n", builtin: false };
            await saveTemplates([...templates, created]);
            openStructure(created.id);
          }}
        >
          <Plus size={14} /> Новий шаблон
        </button>
      </div>
    </>
  );
}
