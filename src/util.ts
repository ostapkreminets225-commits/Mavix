export function uid(prefix = "id"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function basename(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] || clean;
}

export function dirname(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  const index = Math.max(clean.lastIndexOf("\\"), clean.lastIndexOf("/"));
  return index > 0 ? clean.slice(0, index) : clean;
}

export function joinPath(base: string, ...parts: string[]): string {
  let result = base.replace(/[\\/]+$/, "");
  for (const part of parts) {
    const clean = part.replace(/^[\\/]+|[\\/]+$/g, "").replace(/\//g, "\\");
    if (clean) result += "\\" + clean;
  }
  return result;
}

export function relativePath(root: string, path: string): string {
  const a = root.replace(/[\\/]+$/, "").toLowerCase();
  if (path.toLowerCase().startsWith(a)) return path.slice(a.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
  return path;
}

export function pathKey(path: string): string {
  return path.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
}

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return pathKey(a) === pathKey(b);
}

export function isInside(root: string, path: string): boolean {
  const r = root.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  const p = path.replace(/\//g, "\\").toLowerCase();
  return p === r || p.startsWith(r + "\\");
}

export function extname(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toLowerCase() : "";
}

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh", з: "z", и: "y", і: "i", ї: "i", й: "i",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch",
  ш: "sh", щ: "shch", ь: "", ю: "iu", я: "ia", ы: "y", э: "e", ъ: "", ё: "io", "'": "", "’": "", "ʼ": "",
};

export function slugify(text: string, max = 64): string {
  const latin = text
    .toLowerCase()
    .split("")
    .map((ch) => (ch in TRANSLIT ? TRANSLIT[ch] : ch))
    .join("")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
  return latin
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "щойно";
  if (diff < hour) return `${Math.floor(diff / minute)} хв тому`;
  if (diff < day) return `${Math.floor(diff / hour)} год тому`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} дн тому`;
  return new Date(ms).toLocaleDateString("uk-UA", { day: "numeric", month: "short", year: diff > 300 * day ? "numeric" : undefined });
}

export function dateGroup(ms: number): string {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  if (ms >= startToday) return "Сьогодні";
  if (ms >= startToday - day) return "Вчора";
  if (ms >= startToday - 6 * day) return "Цього тижня";
  if (ms >= startToday - 29 * day) return "Цього місяця";
  return "Раніше";
}

export function resetText(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return "Скидання " + date.toLocaleString("uk-UA", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function resetLine(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
  const hoursAway = (date.getTime() - Date.now()) / 3_600_000;
  if (hoursAway < 20) return `Скидання о ${time}`;
  const day = date.toLocaleDateString("uk-UA", { weekday: "short", day: "numeric", month: "short" });
  return `Скидання ${day} о ${time}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

export function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const base = t.slice(Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\")) + 1);
  if (base === q) return 1000;
  if (base.startsWith(q)) return 800 - base.length;
  const direct = t.indexOf(q);
  if (direct >= 0) return 600 - direct - t.length * 0.1;
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 6 - Math.min(found - ti, 10);
    ti = found + 1;
  }
  return score - t.length * 0.2;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function hotkey(event: KeyboardEvent): string {
  const code = event.code;
  if (code.startsWith("Key")) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit")) return code.slice(5);
  if (code === "Backquote") return "`";
  if (code === "Comma") return ",";
  return event.key.toLowerCase();
}

const BAD_NAME = /[<>:"/\\|?*\u0000-\u001f]/;

export function badFileName(name: string): string | null {
  if (!name.trim()) return "Назва не може бути порожньою";
  if (BAD_NAME.test(name)) return "У назві не можна використовувати < > : \" / \\ | ? *";
  if (/[. ]$/.test(name)) return "Назва не може закінчуватися крапкою чи пробілом";
  return null;
}

export function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number) {
  let timer: number | undefined;
  return (...args: T) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), ms);
  };
}

export const PROJECT_COLORS = ["#ff8a3d", "#6fd3b8", "#6aa9ff", "#a98bff", "#e5c07b", "#ff7a90", "#b5d65a", "#8fb3c9"];
