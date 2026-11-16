import { ICON_DEFAULTS, ICON_EXTENSIONS, ICON_FILES, ICON_FOLDERS, ICON_FOLDERS_WITH_OPEN } from "../iconTheme";

function folderIcon(name: string, open: boolean): string {
  const icon = ICON_FOLDERS[name.toLowerCase()];
  if (!icon) return open ? ICON_DEFAULTS.folderOpen : ICON_DEFAULTS.folder;
  return open && ICON_FOLDERS_WITH_OPEN.has(icon) ? `${icon}-open` : icon;
}

function fileIcon(name: string): string {
  const lower = name.toLowerCase();
  const byName = ICON_FILES[lower];
  if (byName) return byName;
  const parts = lower.split(".");
  for (let index = 1; index < parts.length; index += 1) {
    const icon = ICON_EXTENSIONS[parts.slice(index).join(".")];
    if (icon) return icon;
  }
  return ICON_DEFAULTS.file;
}

export function iconUrl(name: string, dir = false, open = false): string {
  return `/icons/${dir ? folderIcon(name, open) : fileIcon(name)}.svg`;
}

export function FileIcon({ name, dir, open, size = 16 }: { name: string; dir?: boolean; open?: boolean; size?: number }) {
  return <img className="file-icon" src={iconUrl(name, !!dir, !!open)} width={size} height={size} alt="" draggable={false} decoding="async" />;
}
