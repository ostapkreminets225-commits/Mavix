# Mavix

IDE для роботи з Claude: кілька проектів в одному вікні, справжній термінал, скіли Claude для всього ПК, кілька підписок Claude, структура папок за шаблоном і шість кольорових гам.

## Запуск

- Готова програма: ярлик **Mavix** на робочому столі → `src-tauri\target\release\mavix.exe`
- Розробка: `cargo tauri dev` (Vite на порту 1430 + Rust)
- Збірка exe: `cargo tauri build --no-bundle`
- Перевірка типів: `npm run typecheck`

## Архітектура папок

```text
Mavix/
  index.html                 вхід Vite
  package.json               React 19, xterm 6, CodeMirror 6, zustand
  design/icon.svg            вихідник іконки
  tools/build-icons.mjs      копіює іконки папок і файлів, будує src/iconTheme.ts
  public/icons/              1131 SVG з Material Icon Theme
  src/                       інтерфейс (TypeScript + React)
    main.tsx                 старт, шрифти, стилі
    App.tsx                  запуск, гарячі клавіші, drag & drop, вихід
    store.ts                 увесь стан і його збереження між запусками
    actions.ts               дії: проекти, вкладки, файли, термінали, Claude, скіли
    terminals.ts             реєстр xterm, теми терміналу, запуск Claude
    docs.ts                  відкриті файли, збереження, «не збережено»
    themes.ts                6 кольорових гам
    ipc.ts                   типи і виклики Rust
    markdown.ts              безпечний рендер Markdown
    editor/setup.ts          CodeMirror: мови, підсвітка, гамма
    components/
      TitleBar.tsx           вкладки проектів, пошук, гамма, акаунт, вікно
      ActivityBar.tsx        ліва смуга розділів
      Sidebar.tsx
      sidebar/               Explorer, Search, Sessions, Skills, Accounts, Structure
      EditorArea.tsx         вкладки редактора
      editor/                CodeEditor, Welcome, SessionView, SkillDetail,
                             NewSkill, StructureEditor, SettingsView
      TerminalPanel.tsx      панель терміналів, спліти, Claude-сесії
      StatusBar.tsx
      Palette.tsx            Ctrl P файли, Ctrl Shift P команди
      Overlays.tsx           меню, діалоги, новий проект, сповіщення
      ThemePicker.tsx        вибір гами для Mavix або проекту
    styles/                  base, layout, panels, views
  src-tauri/                 бекенд (Rust, Tauri 2)
    src/
      lib.rs                 реєстрація команд
      pty.rs                 справжній термінал через ConPTY
      files.rs               файли, пошук, гілка git, кошик
      skills.rs              скіли: список, вкл/викл, створення, імпорт, CLAUDE.md
      accounts.rs            підписки Claude, ліміти, спільні скіли
      sessions.rs            сесії Claude і їхні розмови
      structure.rs           шаблони структури папок
      store.rs               збереження робочого простору
      system.rs              оболонки, фон Windows Terminal
    capabilities/default.json
    tauri.conf.json
```

## Як це працює

**Скіли.** Увімкнений скіл лежить у `~\.claude\skills` — його бачать усі акаунти й усі проекти. Вимкнений переїжджає в `%APPDATA%\Mavix\disabled-skills`, і Claude його не бачить. «Завжди активний» дописує в `~\.claude\CLAUDE.md` розділ `## Always-on skills (Mavix)` з правилом вантажити скіл перед кожною задачею. Новий скіл з Markdown: Mavix сам дає назву (транслітерація), опис і SKILL.md, а потім перечитує його й показує перевірку. Імпорт: `.md`, `.zip`, `.skill`, папка, або просто перетягнути у вікно.

**Акаунти.** Кожна підписка — своя папка `CLAUDE_CONFIG_DIR` у `%APPDATA%\Mavix\accounts\<id>` зі своїм входом, сесіями й лімітами. Папки `skills`, `agents`, `commands`, `plugins`, `hooks` — з'єднання (junction) на основний `~\.claude`, а `CLAUDE.md` синхронізується, тож правила однакові всюди. Нова сесія сама підставляє потрібний акаунт.

**Сесії.** Список читається з `projects\*.jsonl` кожного акаунта. Нова сесія стартує як `claude --session-id <uuid>`, тому після перезапуску Mavix її можна продовжити кнопкою (`claude --resume`).

**Структура папок.** Шаблон — це дерево з відступами (можна вставити вивід `tree`). Mavix показує, чого бракує, створює відсутнє (нічого не перезаписує), записує правило в `CLAUDE.md` проекту і, якщо увімкнено, добудовує структуру при кожному відкритті.

**Іконки.** Папки й файли показуються іконками з Material Icon Theme (MIT, ліцензія в `public/icons/LICENSE.txt`): понад 4700 назв папок і 1300 типів файлів, плюс ігрові папки (characters, enemies, vfx, weapons, dialogue, levels, scenes, steam…). Набір не малюється кодом — це готові SVG. Додати свою відповідність назва → іконка: `EXTRA_FOLDERS` / `EXTRA_FILES` у `tools/build-icons.mjs`, потім `npm run icons`.

**Дані Mavix.** `%APPDATA%\Mavix`: `workspace.json` (проекти, вкладки, термінали, налаштування), `accounts.json`, `structures.json`, `disabled-skills\`, `usage\`.

## Гарячі клавіші

| Дія | Клавіші |
| --- | --- |
| Файл у проекті | Ctrl P |
| Команди | Ctrl Shift P |
| Відкрити папку | Ctrl O |
| Зберегти | Ctrl S |
| Термінал показати/сховати | Ctrl ` |
| Новий термінал | Ctrl Shift ` |
| Нова сесія Claude | Ctrl Shift L |
| Пошук у проекті | Ctrl Shift F |
| Бічна панель | Ctrl B |
| Проект 1–9 / Головна | Alt 1–9 / Alt 0 |
| Налаштування | Ctrl , |
