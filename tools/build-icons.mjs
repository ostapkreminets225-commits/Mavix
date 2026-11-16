import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const themeDir = join(root, "node_modules", "material-icon-theme");
const manifest = JSON.parse(readFileSync(join(themeDir, "dist", "material-icons.json"), "utf8"));
const iconsOut = join(root, "public", "icons");
const mapOut = join(root, "src", "iconTheme.ts");

const LANGUAGE_BY_EXTENSION = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  rs: "rust",
  py: "python",
  pyw: "python",
  md: "markdown",
  markdown: "markdown",
  json: "json",
  jsonc: "jsonc",
  gd: "gdscript",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  cs: "csharp",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  txt: "plaintext",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  lua: "lua",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  xml: "xml",
  bat: "bat",
  cmd: "bat",
  ini: "ini",
  glsl: "glsl",
  frag: "glsl",
  vert: "glsl",
  hlsl: "hlsl",
  wgsl: "wgsl",
  sql: "sql",
  php: "php",
  rb: "ruby",
  vue: "vue",
  svelte: "svelte",
  dart: "dart",
};

const EXTRA_FOLDERS = {
  scenes: "folder-layout",
  scene: "folder-layout",
  levels: "folder-layout",
  level: "folder-layout",
  maps: "folder-layout",
  worlds: "folder-layout",
  rooms: "folder-layout",
  art: "folder-images",
  concepts: "folder-images",
  concept: "folder-images",
  sprites: "folder-images",
  textures: "folder-images",
  renders: "folder-images",
  portraits: "folder-images",
  steam: "folder-export",
  release: "folder-export",
  releases: "folder-export",
  _raw: "folder-temp",
  raw: "folder-temp",
  "real-assets": "folder-resource",
  models: "folder-resource",
  meshes: "folder-resource",
  references: "folder-review",
  refs: "folder-review",
  characters: "folder-admin",
  character: "folder-admin",
  player: "folder-admin",
  players: "folder-admin",
  heroes: "folder-admin",
  enemies: "folder-robot",
  enemy: "folder-robot",
  bosses: "folder-robot",
  boss: "folder-robot",
  npc: "folder-robot",
  npcs: "folder-robot",
  ai: "folder-robot",
  vfx: "folder-animation",
  fx: "folder-animation",
  effects: "folder-animation",
  particles: "folder-animation",
  autoload: "folder-global",
  autoloads: "folder-global",
  globals: "folder-global",
  singletons: "folder-global",
  camera: "folder-video",
  cameras: "folder-video",
  cutscenes: "folder-video",
  cinematics: "folder-video",
  dialogue: "folder-messages",
  dialogues: "folder-messages",
  conversations: "folder-messages",
  net: "folder-connection",
  network: "folder-connection",
  networking: "folder-connection",
  multiplayer: "folder-connection",
  online: "folder-connection",
  weapons: "folder-target",
  weapon: "folder-target",
  arms: "folder-target",
  combat: "folder-target",
  conquest: "folder-target",
  missions: "folder-tasks",
  quests: "folder-tasks",
  objectives: "folder-tasks",
  achievements: "folder-tasks",
  pickups: "folder-store",
  items: "folder-store",
  loot: "folder-store",
  shop: "folder-store",
  entities: "folder-container",
  prefabs: "folder-container",
  systems: "folder-core",
  materials: "folder-shader",
  sfx: "folder-audio",
  state: "folder-flow",
  states: "folder-flow",
  fsm: "folder-flow",
  save: "folder-database",
  saves: "folder-database",
};

const EXTRA_FILES = {
  "project.godot": "godot",
  "export_presets.cfg": "godot-assets",
  "default_bus_layout.tres": "godot-assets",
  "cargo.toml": "rust",
  "cargo.lock": "rust",
};

const available = new Set(Object.keys(manifest.iconDefinitions));
const lowerKeys = (record) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]));

const folders = lowerKeys(manifest.folderNames);
for (const [name, icon] of Object.entries(EXTRA_FOLDERS)) {
  if (!folders[name] && available.has(icon)) folders[name] = icon;
}

const files = lowerKeys(manifest.fileNames);
for (const [name, icon] of Object.entries(EXTRA_FILES)) {
  if (!files[name] && available.has(icon)) files[name] = icon;
}

const extensions = lowerKeys(manifest.fileExtensions);
for (const [extension, language] of Object.entries(LANGUAGE_BY_EXTENSION)) {
  const icon = manifest.languageIds[language];
  if (!extensions[extension] && icon && available.has(icon)) extensions[extension] = icon;
}

const used = new Set([manifest.file, manifest.folder, manifest.folderExpanded]);
for (const icon of Object.values(folders)) {
  used.add(icon);
  if (available.has(`${icon}-open`)) used.add(`${icon}-open`);
}
for (const icon of [...Object.values(files), ...Object.values(extensions)]) used.add(icon);

rmSync(iconsOut, { recursive: true, force: true });
mkdirSync(iconsOut, { recursive: true });
let copied = 0;
for (const icon of used) {
  const definition = manifest.iconDefinitions[icon];
  if (!definition) continue;
  const source = join(themeDir, "dist", definition.iconPath);
  if (!existsSync(source)) continue;
  copyFileSync(source, join(iconsOut, `${icon}.svg`));
  copied += 1;
}
copyFileSync(join(themeDir, "LICENSE"), join(iconsOut, "LICENSE.txt"));

const withOpen = [...used].filter((icon) => icon.startsWith("folder") && !icon.endsWith("-open") && available.has(`${icon}-open`));
const source = [
  `export const ICON_DEFAULTS = ${JSON.stringify({ file: manifest.file, folder: manifest.folder, folderOpen: manifest.folderExpanded })};`,
  `export const ICON_FOLDERS: Record<string, string> = ${JSON.stringify(folders)};`,
  `export const ICON_FOLDERS_WITH_OPEN = new Set<string>(${JSON.stringify(withOpen)});`,
  `export const ICON_FILES: Record<string, string> = ${JSON.stringify(files)};`,
  `export const ICON_EXTENSIONS: Record<string, string> = ${JSON.stringify(extensions)};`,
  "",
].join("\n");
writeFileSync(mapOut, source);
console.log(`icons: ${copied}, folders: ${Object.keys(folders).length}, files: ${Object.keys(files).length}, extensions: ${Object.keys(extensions).length}`);
