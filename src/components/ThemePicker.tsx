import { useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import { THEMES, type ThemeId } from "../themes";
import { set, updateWorkspace, useActiveWorkspace, useStore } from "../store";
import { Segmented } from "./ui";

export function ThemeRows({ value, onPick, compact }: { value: ThemeId | null; onPick: (id: ThemeId) => void; compact?: boolean }) {
  return (
    <div className={`theme-rows${compact ? " compact" : ""}`}>
      {THEMES.map((theme, index) => (
        <button key={theme.id} className={`theme-row${value === theme.id ? " active" : ""}`} onClick={() => onPick(theme.id)}>
          <div className="theme-row-head">
            <span className="theme-row-name">
              {index + 1}. {theme.name}
            </span>
            {value === theme.id && <Check size={13} className="theme-check" />}
          </div>
          <div className="theme-swatches">
            {theme.swatches.map((color) => (
              <span key={color} style={{ background: color }} />
            ))}
          </div>
          {!compact && <div className="theme-mood">{theme.mood}</div>}
        </button>
      ))}
    </div>
  );
}

export function setGlobalTheme(id: ThemeId) {
  set((s) => ({ settings: { ...s.settings, uiTheme: id } }));
}

export function ThemePopover({ onClose }: { onClose: () => void }) {
  const ws = useActiveWorkspace();
  const globalTheme = useStore((s) => s.settings.uiTheme);
  const [mode, setMode] = useState<"global" | "project">(ws.root && ws.themeId ? "project" : "global");
  const projectMode = mode === "project" && !!ws.root;
  const value = projectMode ? (ws.themeId ?? globalTheme) : globalTheme;
  const pick = (id: ThemeId) => {
    if (projectMode) updateWorkspace(ws.id, (w) => ({ ...w, themeId: id }));
    else setGlobalTheme(id);
  };
  return (
    <div className="popover-backdrop" onMouseDown={onClose}>
      <div className="theme-popover" onMouseDown={(e) => e.stopPropagation()}>
        <div className="popover-title">Кольорова гамма</div>
        <Segmented
          value={projectMode ? "project" : "global"}
          onChange={setMode}
          options={[
            { value: "global", label: "Весь Mavix" },
            { value: "project", label: ws.root ? `Лише ${ws.name}` : "Проект", disabled: !ws.root },
          ]}
        />
        <div className="hint">{projectMode ? "Ця гамма вмикається, коли відкрита вкладка цього проекту" : "Гамма для всіх проектів без власної"}</div>
        <ThemeRows value={value} onPick={pick} compact />
        {projectMode && ws.themeId && (
          <button className="btn small wide" onClick={() => updateWorkspace(ws.id, (w) => ({ ...w, themeId: null }))}>
            <RotateCcw size={12} /> Як у всього Mavix
          </button>
        )}
      </div>
    </div>
  );
}
