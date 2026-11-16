import type { Limit } from "../ipc";
import { resetText } from "../util";

export function Switch({ on, onChange, title, small, disabled }: { on: boolean; onChange: (next: boolean) => void; title?: string; small?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={title}
      disabled={disabled}
      className={`switch${on ? " on" : ""}${small ? " small" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!on);
      }}
    >
      <i />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; disabled?: boolean }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} disabled={o.disabled} className={o.value === value ? "active" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Meter({ limit }: { limit: Limit }) {
  const percent = Math.max(0, Math.min(100, limit.percent));
  const tone = percent >= 90 || limit.severity === "critical" ? "danger" : percent >= 70 || limit.severity === "warning" ? "warn" : "ok";
  return (
    <div className="meter-block">
      <div className="meter-head">
        <span>{limit.label}</span>
        <span className="meter-value">{Math.round(percent)}%</span>
      </div>
      <div className={`meter ${tone}`}>
        <i style={{ width: `${percent}%` }} />
      </div>
      {limit.resetsAt && <div className="meter-reset">{resetText(limit.resetsAt)}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}
