export type ThemeId = "navy" | "emerald" | "lavender" | "warm" | "teal" | "gold";

export type Theme = {
  id: ThemeId;
  name: string;
  mood: string;
  swatches: [string, string, string, string, string];
  vars: Record<string, string>;
  terminal: { surface: string; foreground: string; cursor: string; selection: string };
};

type Base = {
  app: string;
  side: string;
  editor: string;
  raised: string;
  hover: string;
  active: string;
  line: string;
  lineStrong: string;
  fg: string;
  fg2: string;
  fg3: string;
  fg4: string;
  accent: string;
  solid: string;
  onSolid: string;
};

type Syntax = {
  keyword: string;
  string: string;
  number: string;
  fn: string;
  type: string;
  property: string;
  variable: string;
  comment: string;
  punct: string;
  tag: string;
  regexp: string;
  heading: string;
  meta: string;
};

function build(id: ThemeId, name: string, mood: string, swatches: Theme["swatches"], b: Base, s: Syntax): Theme {
  return {
    id,
    name,
    mood,
    swatches,
    vars: {
      "--bg-app": b.app,
      "--bg-side": b.side,
      "--bg-editor": b.editor,
      "--bg-raised": b.raised,
      "--bg-hover": b.hover,
      "--bg-active": b.active,
      "--line": b.line,
      "--line-strong": b.lineStrong,
      "--fg": b.fg,
      "--fg-2": b.fg2,
      "--fg-3": b.fg3,
      "--fg-4": b.fg4,
      "--accent": b.accent,
      "--accent-solid": b.solid,
      "--accent-fg": b.onSolid,
      "--syn-keyword": s.keyword,
      "--syn-string": s.string,
      "--syn-number": s.number,
      "--syn-function": s.fn,
      "--syn-type": s.type,
      "--syn-property": s.property,
      "--syn-variable": s.variable,
      "--syn-comment": s.comment,
      "--syn-punct": s.punct,
      "--syn-tag": s.tag,
      "--syn-regexp": s.regexp,
      "--syn-heading": s.heading,
      "--syn-meta": s.meta,
    },
    terminal: { surface: b.app, foreground: b.fg2, cursor: b.accent, selection: `${b.solid}66` },
  };
}

export const THEMES: Theme[] = [
  build(
    "navy",
    "Navy + Electric Blue",
    "Преміальність, технологічність, професійний AAA UI",
    ["#0b1120", "#1a2654", "#2563eb", "#60a5fa", "#f8fafc"],
    {
      app: "#090e1a",
      side: "#0c1322",
      editor: "#0f1729",
      raised: "#141e35",
      hover: "#18243f",
      active: "#1f2d4f",
      line: "#182238",
      lineStrong: "#24324f",
      fg: "#f1f5fb",
      fg2: "#c0cbdd",
      fg3: "#8392ad",
      fg4: "#56637c",
      accent: "#60a5fa",
      solid: "#2563eb",
      onSolid: "#ffffff",
    },
    {
      keyword: "#6ea8fe",
      string: "#9ad1a0",
      number: "#f2c27b",
      fn: "#7dd3fc",
      type: "#a5b4fc",
      property: "#c7d2fe",
      variable: "#e2e8f0",
      comment: "#56637c",
      punct: "#8392ad",
      tag: "#f78c8c",
      regexp: "#f0abfc",
      heading: "#93c5fd",
      meta: "#a5b4fc",
    },
  ),
  build(
    "emerald",
    "Charcoal + Emerald",
    "Спокій, природність, комфорт на довгі сесії",
    ["#111827", "#1f2937", "#059669", "#34d399", "#f7faf5"],
    {
      app: "#0c111b",
      side: "#0f1520",
      editor: "#121a26",
      raised: "#18212f",
      hover: "#1d2837",
      active: "#253243",
      line: "#1b2431",
      lineStrong: "#283445",
      fg: "#f3f7f2",
      fg2: "#c6cfca",
      fg3: "#87928d",
      fg4: "#59635f",
      accent: "#34d399",
      solid: "#059669",
      onSolid: "#ffffff",
    },
    {
      keyword: "#34d399",
      string: "#e6c07b",
      number: "#f59e8b",
      fn: "#7dd3fc",
      type: "#5eead4",
      property: "#d1fae5",
      variable: "#e5ece7",
      comment: "#5d6b66",
      punct: "#8a9690",
      tag: "#f87171",
      regexp: "#f9a8d4",
      heading: "#6ee7b7",
      meta: "#a7f3d0",
    },
  ),
  build(
    "lavender",
    "Deep Purple + Lavender",
    "Преміальний вигляд, креативність, ігрові інтерфейси",
    ["#1a1530", "#312459", "#7c3aed", "#c4b5fd", "#faf8ff"],
    {
      app: "#110d1f",
      side: "#151027",
      editor: "#18132d",
      raised: "#1f1838",
      hover: "#261e44",
      active: "#302656",
      line: "#221a3a",
      lineStrong: "#30264f",
      fg: "#f7f5ff",
      fg2: "#cbc4e3",
      fg3: "#8e86ab",
      fg4: "#5f587a",
      accent: "#c4b5fd",
      solid: "#7c3aed",
      onSolid: "#ffffff",
    },
    {
      keyword: "#c4b5fd",
      string: "#86efac",
      number: "#fdba74",
      fn: "#93c5fd",
      type: "#f0abfc",
      property: "#ddd6fe",
      variable: "#ede9fe",
      comment: "#645c80",
      punct: "#918aad",
      tag: "#fb7185",
      regexp: "#f9a8d4",
      heading: "#d8b4fe",
      meta: "#a78bfa",
    },
  ),
  build(
    "warm",
    "Warm Gray + Orange",
    "Тепло, дружність, енергія, комфорт",
    ["#2a2725", "#5a5550", "#ea580c", "#fdba74", "#fff7ed"],
    {
      app: "#141210",
      side: "#191715",
      editor: "#1d1a18",
      raised: "#24211e",
      hover: "#2b2724",
      active: "#35302c",
      line: "#2a2623",
      lineStrong: "#3a3530",
      fg: "#fff7ed",
      fg2: "#d8cfc4",
      fg3: "#9a9087",
      fg4: "#6a625b",
      accent: "#fdba74",
      solid: "#ea580c",
      onSolid: "#ffffff",
    },
    {
      keyword: "#f2946a",
      string: "#b9cf7f",
      number: "#e9b96e",
      fn: "#86b8d8",
      type: "#8fd1c4",
      property: "#dcc9a9",
      variable: "#efe6da",
      comment: "#71685f",
      punct: "#a59d91",
      tag: "#ff8366",
      regexp: "#d2a3e0",
      heading: "#ffb26b",
      meta: "#c49bff",
    },
  ),
  build(
    "teal",
    "Dark Teal + Cyan",
    "Чистота, технологічність, кіберпанк без агресії",
    ["#062b29", "#115e59", "#0d9488", "#67e8f9", "#ecfeff"],
    {
      app: "#061514",
      side: "#081b1a",
      editor: "#0a201f",
      raised: "#0e2a28",
      hover: "#123331",
      active: "#183f3c",
      line: "#12302d",
      lineStrong: "#1b403c",
      fg: "#ecfeff",
      fg2: "#bfdcdc",
      fg3: "#7fa3a2",
      fg4: "#4f7271",
      accent: "#67e8f9",
      solid: "#0d9488",
      onSolid: "#ffffff",
    },
    {
      keyword: "#67e8f9",
      string: "#bbf7d0",
      number: "#fcd34d",
      fn: "#93c5fd",
      type: "#5eead4",
      property: "#cffafe",
      variable: "#e0f7f7",
      comment: "#4f7271",
      punct: "#7fa3a2",
      tag: "#fca5a5",
      regexp: "#f0abfc",
      heading: "#67e8f9",
      meta: "#99f6e4",
    },
  ),
  build(
    "gold",
    "Black + Gold",
    "Люксовість, статусність, преміальний дизайн",
    ["#0a0a0a", "#262626", "#a16207", "#eab308", "#fffbeb"],
    {
      app: "#080808",
      side: "#0e0e0e",
      editor: "#121212",
      raised: "#1a1a1a",
      hover: "#202020",
      active: "#2a2a2a",
      line: "#1f1f1f",
      lineStrong: "#2e2e2e",
      fg: "#fffbeb",
      fg2: "#d6d0bf",
      fg3: "#948e80",
      fg4: "#625d54",
      accent: "#eab308",
      solid: "#eab308",
      onSolid: "#1c1503",
    },
    {
      keyword: "#f5c542",
      string: "#c8d98a",
      number: "#fb923c",
      fn: "#93c5fd",
      type: "#fde68a",
      property: "#e7dfc6",
      variable: "#f5f0e1",
      comment: "#67625a",
      punct: "#9a9384",
      tag: "#f87171",
      regexp: "#f0abfc",
      heading: "#facc15",
      meta: "#d6c08a",
    },
  ),
];

export function themeById(id: string | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

export function applyTheme(id: string) {
  const theme = themeById(id);
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.vars)) root.style.setProperty(key, value);
  root.dataset.theme = theme.id;
}
