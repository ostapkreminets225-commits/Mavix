import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { CircleCheck, CircleAlert, Info, Download, FolderPlus, X } from "lucide-react";
import { api, errorText, type PlanItem } from "../ipc";
import { set, toast, updateWorkspace, useStore } from "../store";
import { openProject, refreshExpanded } from "../actions";
import { Switch } from "./ui";
import { FileIcon } from "./FileIcon";
import { ImageZoom } from "./chat/LocalImage";
import { joinPath } from "../util";

function ContextMenu() {
  const menu = useStore((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setPos({ x: Math.max(6, Math.min(menu.x, window.innerWidth - rect.width - 6)), y: Math.max(6, Math.min(menu.y, window.innerHeight - rect.height - 6)) });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = () => set({ menu: null });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu]);
  if (!menu) return null;
  return (
    <div className="menu-backdrop" onMouseDown={() => set({ menu: null })} onContextMenu={(e) => e.preventDefault()}>
      <div ref={ref} className="menu" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
        {menu.items.map((item, i) =>
          item === "separator" ? (
            <div key={i} className="menu-sep" />
          ) : (
            <button
              key={i}
              className={`menu-item${item.danger ? " danger" : ""}`}
              disabled={item.disabled}
              onClick={() => {
                set({ menu: null });
                item.action();
              }}
            >
              <span className="menu-label">{item.label}</span>
              {item.shortcut && <span className="menu-keys">{item.shortcut}</span>}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

function DialogHost() {
  const dialog = useStore((s) => s.dialog);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!dialog) return;
    setValue(dialog.input?.value ?? "");
    requestAnimationFrame(() => {
      if (!input.current) return;
      input.current.focus();
      const sel = dialog.input?.select;
      if (sel) input.current.setSelectionRange(sel[0], sel[1]);
      else input.current.select();
    });
  }, [dialog]);
  if (!dialog) return null;
  const finish = (result: string | boolean | null) => {
    set({ dialog: null });
    dialog.resolve(result);
  };
  const confirmNow = () => finish(dialog.input ? value : true);
  return (
    <div className="modal-backdrop" onMouseDown={() => finish(null)}>
      <div
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") finish(null);
          if (e.key === "Enter" && !dialog.choices) {
            e.preventDefault();
            confirmNow();
          }
        }}
      >
        <div className="modal-title">{dialog.title}</div>
        {dialog.message && <div className="modal-message">{dialog.message}</div>}
        {dialog.input && <input ref={input} className="input" value={value} placeholder={dialog.input.placeholder} onChange={(e) => setValue(e.target.value)} />}
        <div className="modal-actions">
          <button className="btn" onClick={() => finish(null)} autoFocus={!dialog.input && !!dialog.danger}>
            {dialog.cancel ?? "Скасувати"}
          </button>
          {dialog.choices ? (
            dialog.choices.map((c, i) => (
              <button key={c.value} className={`btn${i === dialog.choices!.length - 1 ? " primary" : ""}`} onClick={() => finish(c.value)}>
                {c.label}
              </button>
            ))
          ) : (
            <button className={`btn ${dialog.danger ? "danger-solid" : "primary"}`} onClick={confirmNow} autoFocus={!dialog.input && !dialog.danger}>
              {dialog.confirm ?? "Гаразд"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === "ok" ? <CircleCheck size={14} /> : t.kind === "error" ? <CircleAlert size={14} /> : <Info size={14} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

function DropOverlay() {
  const dragOver = useStore((s) => s.dragOver);
  const skills = useStore((s) => s.activity === "skills" && s.sidebarVisible);
  if (!dragOver) return null;
  return (
    <div className="drop-overlay">
      <div className="drop-card">
        <Download size={22} />
        <div className="drop-title">{skills ? "Відпусти, щоб встановити скіл" : "Відпусти, щоб відкрити"}</div>
        <div className="drop-sub">{skills ? ".md стане новим скілом · .zip / .skill / папка встановляться на весь ПК" : "Папка відкриється як проект, файл — у редакторі, .skill — як скіл"}</div>
      </div>
    </div>
  );
}

function NewProjectModal() {
  const open = useStore((s) => s.newProjectOpen);
  const templates = useStore((s) => s.templates);
  const info = useStore((s) => s.info);
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [templateId, setTemplateId] = useState<string>("");
  const [writeClaude, setWriteClaude] = useState(true);
  const [keep, setKeep] = useState(true);
  const [plan, setPlan] = useState<PlanItem[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onOpen = () => set({ newProjectOpen: true });
    window.addEventListener("mavix:new-project", onOpen);
    return () => window.removeEventListener("mavix:new-project", onOpen);
  }, []);
  useEffect(() => {
    if (open) {
      setName("");
      setParent((p) => p || (info ? joinPath(info.home, "Desktop") : ""));
      setTemplateId((t) => t || templates[0]?.id || "");
    }
  }, [open, info, templates]);
  const template = templates.find((t) => t.id === templateId);
  useEffect(() => {
    if (!template || !info) {
      setPlan([]);
      return;
    }
    api.structurePlan(joinPath(info.dataDir, "__preview__"), template.tree).then(setPlan).catch(() => setPlan([]));
  }, [template, info]);
  if (!open) return null;
  const close = () => set({ newProjectOpen: false });
  const pickParent = async () => {
    const picked = await openDialog({ directory: true, multiple: false, title: "Де створити проект" });
    if (typeof picked === "string") setParent(picked);
  };
  const create = async () => {
    if (!name.trim() || !parent) return;
    setBusy(true);
    try {
      const root = await api.projectCreate(parent, name.trim(), template?.tree ?? null);
      if (template && writeClaude) await api.structureWriteClaudeMd(root, template.tree);
      const ws = await openProject(root);
      if (ws) updateWorkspace(ws.id, (w) => ({ ...w, structureId: template?.id ?? null, autoStructure: !!template && keep }));
      close();
      refreshExpanded();
      toast(`Проект «${name.trim()}» створено${template ? ` зі структурою «${template.name}»` : ""}`, "ok");
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && close()}>
        <div className="modal-head">
          <FolderPlus size={16} className="accent" />
          <div className="modal-title">Новий проект</div>
          <div className="grow" />
          <button className="icon-btn" onClick={close}>
            <X size={15} />
          </button>
        </div>
        <div className="np-grid">
          <div className="np-form">
            <label className="field-label">Назва</label>
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="my-new-game" onKeyDown={(e) => e.key === "Enter" && create()} />
            <label className="field-label">Де створити</label>
            <div className="input-row">
              <input className="input mono" value={parent} onChange={(e) => setParent(e.target.value)} />
              <button className="btn" onClick={pickParent}>
                Змінити…
              </button>
            </div>
            {name.trim() && parent && <div className="hint mono">{joinPath(parent, name.trim())}</div>}
            <label className="field-label">Структура папок</label>
            <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Порожня папка</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            {template && (
              <>
                <div className="row-between">
                  <div>
                    <div className="row-title">Записати в CLAUDE.md</div>
                    <div className="hint">Claude триматиметься цієї структури</div>
                  </div>
                  <Switch on={writeClaude} onChange={setWriteClaude} />
                </div>
                <div className="row-between">
                  <div>
                    <div className="row-title">Підтримувати автоматично</div>
                    <div className="hint">Створювати відсутні папки при відкритті</div>
                  </div>
                  <Switch on={keep} onChange={setKeep} />
                </div>
              </>
            )}
          </div>
          <div className="np-preview">
            <div className="section-label flat">Що буде створено</div>
            <div className="preview-tree compact">
              {!template && <div className="hint">Тільки папка проекту.</div>}
              {plan.map((item) => (
                <div key={item.path} className="plan-item" style={{ paddingLeft: 6 + item.depth * 14 }}>
                  <FileIcon name={item.name} dir={item.dir} size={13} open={item.dir} />
                  <span>{item.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={close}>
            Скасувати
          </button>
          <button className="btn primary" disabled={!name.trim() || !parent || busy} onClick={create}>
            {busy ? "Створюю…" : "Створити й відкрити"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Overlays() {
  return (
    <>
      <ContextMenu />
      <DialogHost />
      <NewProjectModal />
      <DropOverlay />
      <Toasts />
      <ImageZoom />
    </>
  );
}
