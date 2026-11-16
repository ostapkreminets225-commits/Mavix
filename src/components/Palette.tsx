import { useEffect, useMemo, useRef, useState } from "react";
import { Search, CornerDownLeft, ChevronRight } from "lucide-react";
import { api } from "../ipc";
import { activeWorkspace, get, set, useStore } from "../store";
import {
  closeProject,
  collapseAll,
  importSkillDialog,
  newChat,
  newClaudeSession,
  newTerminal,
  openFile,
  openFolderDialog,
  openNewSkill,
  openSettings,
  openStructure,
  refreshAccounts,
  refreshSkills,
  saveCurrent,
  setActivity,
  splitTerminal,
  switchProject,
  toggleSidebar,
  togglePanel,
} from "../actions";
import { saveAll } from "../docs";
import { THEMES } from "../themes";
import { setGlobalTheme } from "./ThemePicker";
import { FileIcon } from "./FileIcon";
import { basename, fuzzyScore, joinPath } from "../util";

type Command = { id: string; label: string; hint?: string; keys?: string; run: () => void };

function commands(): Command[] {
  const state = get();
  const list: Command[] = [
    { id: "open", label: "Відкрити папку проекту", keys: "Ctrl O", run: openFolderDialog },
    { id: "new-project", label: "Новий проект зі структурою", run: () => window.dispatchEvent(new CustomEvent("mavix:new-project")) },
    { id: "claude-chat", label: "Claude: новий чат", keys: "Ctrl Shift L", run: () => newChat() },
    { id: "claude", label: "Claude: нова сесія в терміналі", run: () => newClaudeSession() },
    { id: "sessions", label: "Claude: усі сесії", run: () => setActivity("claude") },
    { id: "terminal", label: "Термінал: новий", keys: "Ctrl Shift `", run: () => newTerminal() },
    { id: "split", label: "Термінал: розділити", run: splitTerminal },
    { id: "panel", label: "Термінал: показати / сховати", keys: "Ctrl `", run: togglePanel },
    { id: "sidebar", label: "Бічна панель: показати / сховати", keys: "Ctrl B", run: toggleSidebar },
    { id: "save", label: "Зберегти файл", keys: "Ctrl S", run: saveCurrent },
    { id: "save-all", label: "Зберегти всі файли", run: () => saveAll() },
    { id: "skill-new", label: "Скіли: новий з Markdown", run: () => openNewSkill() },
    { id: "skill-import", label: "Скіли: завантажити з файлу", run: importSkillDialog },
    { id: "skills", label: "Скіли: показати всі", run: () => setActivity("skills") },
    { id: "skills-refresh", label: "Скіли: перечитати", run: refreshSkills },
    { id: "accounts", label: "Акаунти Claude", run: () => setActivity("accounts") },
    { id: "accounts-refresh", label: "Акаунти: оновити", run: refreshAccounts },
    { id: "structure", label: "Структура папок: редактор шаблонів", run: () => openStructure() },
    { id: "search", label: "Пошук у проекті", keys: "Ctrl Shift F", run: () => setActivity("search") },
    { id: "collapse", label: "Файли: згорнути все", run: collapseAll },
    { id: "settings", label: "Налаштування", keys: "Ctrl ,", run: openSettings },
    { id: "home", label: "Перейти на Головну", keys: "Alt 0", run: () => switchProject(null) },
  ];
  THEMES.forEach((t) => list.push({ id: `theme-${t.id}`, label: `Гамма: ${t.name}`, hint: t.mood, run: () => setGlobalTheme(t.id) }));
  state.workspaces.forEach((w, i) => list.push({ id: `p-${w.id}`, label: `Проект: ${w.name}`, hint: w.root ?? "", keys: i < 9 ? `Alt ${i + 1}` : undefined, run: () => switchProject(w.id) }));
  const current = activeWorkspace(state);
  if (current.root) list.push({ id: "close-project", label: `Закрити проект ${current.name}`, run: () => closeProject(current.id) });
  return list;
}

const fileCache = new Map<string, { at: number; files: string[] }>();

export function Palette() {
  const palette = useStore((s) => s.palette);
  if (!palette) return null;
  return <PaletteInner initialMode={palette.mode} initialQuery={palette.query} />;
}

function PaletteInner({ initialMode, initialQuery }: { initialMode: "files" | "commands"; initialQuery: string }) {
  const [query, setQuery] = useState(initialMode === "commands" ? ">" + initialQuery : initialQuery);
  const [files, setFiles] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const ws = activeWorkspace();
  const commandMode = query.startsWith(">");

  useEffect(() => {
    input.current?.focus();
    if (!ws.root) return;
    const cached = fileCache.get(ws.root);
    if (cached) setFiles(cached.files);
    if (!cached || Date.now() - cached.at > 15000) {
      api.walk(ws.root).then((f) => {
        fileCache.set(ws.root!, { at: Date.now(), files: f });
        setFiles(f);
      });
    }
  }, [ws.root]);

  const close = () => set({ palette: null });

  const items = useMemo(() => {
    if (commandMode) {
      const q = query.slice(1).trim();
      return commands()
        .map((c) => ({ c, score: fuzzyScore(q, c.label) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 60)
        .map((x) => ({ kind: "command" as const, command: x.c }));
    }
    const q = query.trim();
    const scored = q
      ? files
          .map((f) => ({ f, score: fuzzyScore(q, f) }))
          .filter((x) => x.score >= 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 80)
      : files.slice(0, 80).map((f) => ({ f, score: 0 }));
    return scored.map((x) => ({ kind: "file" as const, file: x.f }));
  }, [query, files, commandMode]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector(".pal-item.active")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (i: number) => {
    const item = items[i];
    if (!item) return;
    close();
    if (item.kind === "command") item.command.run();
    else if (ws.root) openFile(joinPath(ws.root, item.file));
  };

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pal-input">
          {commandMode ? <ChevronRight size={15} className="accent" /> : <Search size={15} />}
          <input
            ref={input}
            value={query}
            placeholder={ws.root ? `Файл у ${ws.name}…  (> для команд)` : "Введи > для команд, або відкрий проект для пошуку файлів"}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(index);
              }
            }}
          />
        </div>
        <div className="pal-list" ref={list}>
          {items.length === 0 && <div className="pal-empty">{commandMode ? "Немає такої команди" : ws.root ? "Файлів не знайдено" : "Відкрий проект, щоб шукати файли"}</div>}
          {items.map((item, i) =>
            item.kind === "command" ? (
              <div key={item.command.id} className={`pal-item${i === index ? " active" : ""}`} onMouseEnter={() => setIndex(i)} onMouseDown={() => run(i)}>
                <span className="pal-label">{item.command.label}</span>
                {item.command.hint && <span className="pal-hint">{item.command.hint}</span>}
                {item.command.keys && <kbd className="kbd">{item.command.keys}</kbd>}
              </div>
            ) : (
              <div key={item.file} className={`pal-item${i === index ? " active" : ""}`} onMouseEnter={() => setIndex(i)} onMouseDown={() => run(i)}>
                <FileIcon name={basename(item.file)} size={14} />
                <span className="pal-label">{basename(item.file)}</span>
                <span className="pal-hint">{item.file}</span>
                {i === index && <CornerDownLeft size={12} className="muted" />}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
