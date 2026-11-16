import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ImagePlus, X } from "lucide-react";
import { set, useStore, type Settings } from "../../store";
import { Switch } from "../ui";
import { ThemeRows, setGlobalTheme } from "../ThemePicker";
import { terminalSurface } from "../../terminals";

function update(patch: Partial<Settings>) {
  set((s) => ({ settings: { ...s.settings, ...patch } }));
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-text">
        <div className="row-title">{title}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      <div className="settings-control">{children}</div>
    </div>
  );
}

function NumberInput({ value, min, max, step = 0.5, onChange }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <div className="stepper">
      <button onClick={() => onChange(Math.max(min, +(value - step).toFixed(1)))}>−</button>
      <span>{value}</span>
      <button onClick={() => onChange(Math.min(max, +(value + step).toFixed(1)))}>+</button>
    </div>
  );
}

const FONTS = [
  { label: "JetBrains Mono", value: "'JetBrains Mono Variable', 'Cascadia Mono', Consolas, monospace" },
  { label: "Cascadia Mono", value: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace" },
  { label: "Cascadia Code", value: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace" },
  { label: "Consolas", value: "Consolas, 'Courier New', monospace" },
];

export function SettingsView() {
  const settings = useStore((s) => s.settings);
  const info = useStore((s) => s.info);
  const accounts = useStore((s) => s.accounts);
  const imageUrl = useStore((s) => s.terminalImageUrl);
  const pickImage = async () => {
    const picked = await openDialog({ multiple: false, title: "Фон терміналу", filters: [{ name: "Зображення", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }] });
    if (typeof picked === "string") update({ terminalImage: picked });
  };
  return (
    <div className="settings-page">
      <div className="settings-inner">
        <h1 className="settings-title">Налаштування</h1>

        <div className="settings-section">
          <div className="section-label">Кольорова гамма</div>
          <div className="hint" style={{ marginBottom: 12 }}>
            Гамма фарбує весь Mavix: фон, панелі, кнопки, підсвітку коду й термінал. Окремому проекту можна дати свою — кнопка з палітрою вгорі.
          </div>
          <ThemeRows value={settings.uiTheme} onPick={setGlobalTheme} />
        </div>

        <div className="settings-section">
          <div className="section-label">Вигляд</div>
          <Row title="Розмір інтерфейсу">
            <NumberInput value={settings.uiFontSize} min={11} max={16} onChange={(v) => update({ uiFontSize: v })} />
          </Row>
        </div>

        <div className="settings-section">
          <div className="section-label">Редактор</div>
          <Row title="Розмір шрифту коду">
            <NumberInput value={settings.editorFontSize} min={10} max={22} onChange={(v) => update({ editorFontSize: v })} />
          </Row>
          <Row title="Перенос довгих рядків">
            <Switch on={settings.editorWrap} onChange={(on) => update({ editorWrap: on })} />
          </Row>
          <Row title="Питати перед виходом" hint="Якщо є незбережені файли">
            <Switch on={settings.confirmClose} onChange={(on) => update({ confirmClose: on })} />
          </Row>
        </div>

        <div className="settings-section">
          <div className="section-label">Термінал</div>
          <Row title="Тема">
            <div className="theme-picks">
              {(
                [
                  { id: "ide", label: "Як гамма" },
                  { id: "ember", label: "Invoker Ember" },
                  { id: "graphite", label: "Graphite" },
                  { id: "zed", label: "One" },
                ] as const
              ).map((t) => (
                <button key={t.id} className={`theme-pick${settings.terminalTheme === t.id ? " active" : ""}`} onClick={() => update({ terminalTheme: t.id })}>
                  <span className="theme-chip" style={{ background: terminalSurface({ ...settings, terminalTheme: t.id }) }} />
                  {t.label}
                </button>
              ))}
            </div>
          </Row>
          <Row title="Шрифт">
            <select className="input" value={settings.terminalFont} onChange={(e) => update({ terminalFont: e.target.value })}>
              {FONTS.map((f) => (
                <option key={f.label} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </Row>
          <Row title="Розмір шрифту">
            <NumberInput value={settings.terminalFontSize} min={10} max={22} onChange={(v) => update({ terminalFontSize: v })} />
          </Row>
          <Row title="Оболонка за замовчуванням">
            <select className="input" value={settings.defaultShell} onChange={(e) => update({ defaultShell: e.target.value })}>
              {info?.shells.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Row>
          <Row title="Фонове зображення" hint={settings.terminalImage ?? "Як у Windows Terminal — картинка під текстом"}>
            <div className="bg-picker">
              <button className="bg-thumb" onClick={pickImage} style={imageUrl ? { backgroundImage: `url(${imageUrl})` } : undefined}>
                {!imageUrl && <ImagePlus size={16} />}
              </button>
              {settings.terminalImage && (
                <button className="icon-btn" title="Прибрати фон" onClick={() => update({ terminalImage: null })}>
                  <X size={14} />
                </button>
              )}
            </div>
          </Row>
          {settings.terminalImage && (
            <>
              <Row title="Видимість фону">
                <input
                  type="range"
                  min={0.05}
                  max={0.9}
                  step={0.01}
                  value={settings.terminalImageOpacity}
                  onChange={(e) => update({ terminalImageOpacity: Number(e.target.value) })}
                />
                <span className="range-value">{Math.round(settings.terminalImageOpacity * 100)}%</span>
              </Row>
              <Row title="Розмиття фону">
                <input type="range" min={0} max={16} step={1} value={settings.terminalBlur} onChange={(e) => update({ terminalBlur: Number(e.target.value) })} />
                <span className="range-value">{settings.terminalBlur}px</span>
              </Row>
            </>
          )}
        </div>

        <div className="settings-section">
          <div className="section-label">Claude</div>
          <Row title="Акаунт за замовчуванням" hint="Для нових сесій, якщо в проекту не вибрано свій">
            <select className="input" value={settings.defaultAccountId} onChange={(e) => update({ defaultAccountId: e.target.value })}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                  {a.email ? ` · ${a.email}` : ""}
                </option>
              ))}
            </select>
          </Row>
          <Row title="Claude Code" hint={info?.claudePath ?? "Не знайдено в PATH — встанови Claude Code"}>
            <span className={info?.claudePath ? "ok-text small" : "warn-text small"}>{info?.claudePath ? "знайдено" : "немає"}</span>
          </Row>
          <Row title="Дані Mavix" hint={info?.dataDir}>
            <span className="muted small">робочі простори, акаунти, шаблони</span>
          </Row>
        </div>
      </div>
    </div>
  );
}
