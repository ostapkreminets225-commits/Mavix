import { EditorState, Text } from "@codemirror/state";
import { api, errorText } from "./ipc";
import { createState } from "./editor/setup";
import { get, set, toast } from "./store";
import { extname, basename } from "./util";

export type DocStatus = "loading" | "text" | "image" | "binary" | "large" | "error";

export type Doc = {
  path: string;
  status: DocStatus;
  state: EditorState | null;
  saved: Text | null;
  dataUrl: string | null;
  error: string | null;
  size: number;
};

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);
const docs = new Map<string, Doc>();
const pending = new Map<string, Promise<Doc>>();
export const revealLine = new Map<string, number>();

function key(path: string) {
  return path.toLowerCase();
}

function markDirty(path: string, dirty: boolean) {
  const current = get().dirty[path] ?? false;
  if (current === dirty) return;
  set((s) => {
    const next = { ...s.dirty };
    if (dirty) next[path] = true;
    else delete next[path];
    return { dirty: next };
  });
}

function cursorFrom(state: EditorState) {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const selected = state.selection.ranges.reduce((sum, r) => sum + (r.to - r.from), 0);
  set({ cursor: { line: line.number, col: head - line.from + 1, selected } });
}

function buildState(path: string, content: string) {
  const settings = get().settings;
  return createState(path, content, {
    wrap: settings.editorWrap,
    fontSize: settings.editorFontSize,
    onChange: (state) => {
      const doc = docs.get(key(path));
      if (!doc || !doc.saved) return;
      doc.state = state;
      markDirty(path, !state.doc.eq(doc.saved));
    },
    onSave: () => {
      saveDoc(path);
    },
    onCursor: cursorFrom,
  });
}

export function getDoc(path: string): Doc | undefined {
  return docs.get(key(path));
}

export function loadDoc(path: string): Promise<Doc> {
  const existing = docs.get(key(path));
  if (existing && existing.status !== "loading") return Promise.resolve(existing);
  const inflight = pending.get(key(path));
  if (inflight) return inflight;
  const job = (async () => {
    const doc: Doc = { path, status: "loading", state: null, saved: null, dataUrl: null, error: null, size: 0 };
    docs.set(key(path), doc);
    try {
      if (IMAGE_EXT.has(extname(path))) {
        doc.dataUrl = await api.readDataUrl(path);
        doc.status = "image";
      } else {
        const file = await api.readText(path);
        doc.size = file.size;
        if (file.tooLarge) doc.status = "large";
        else if (file.binary) doc.status = "binary";
        else {
          doc.state = buildState(path, file.content);
          doc.saved = doc.state.doc;
          doc.status = "text";
        }
      }
    } catch (error) {
      doc.status = "error";
      doc.error = errorText(error);
    }
    pending.delete(key(path));
    return doc;
  })();
  pending.set(key(path), job);
  return job;
}

export function storeState(path: string, state: EditorState) {
  const doc = docs.get(key(path));
  if (doc) doc.state = state;
}

export async function saveDoc(path: string): Promise<boolean> {
  const doc = docs.get(key(path));
  if (!doc || !doc.state) return false;
  const text = doc.state.doc.toString();
  try {
    await api.writeText(path, text);
    doc.saved = doc.state.doc;
    markDirty(path, false);
    return true;
  } catch (error) {
    toast(`Не вдалося зберегти ${basename(path)}: ${errorText(error)}`, "error");
    return false;
  }
}

export async function saveAll(): Promise<number> {
  let count = 0;
  for (const path of Object.keys(get().dirty)) {
    if (await saveDoc(path)) count += 1;
  }
  return count;
}

export function closeDoc(path: string) {
  docs.delete(key(path));
  markDirty(path, false);
}

export async function reloadDoc(path: string) {
  docs.delete(key(path));
  markDirty(path, false);
  return loadDoc(path);
}

export function renameDoc(from: string, to: string) {
  const doc = docs.get(key(from));
  if (!doc) return;
  docs.delete(key(from));
  doc.path = to;
  if (doc.state) {
    const content = doc.state.doc.toString();
    const wasDirty = doc.saved ? !doc.state.doc.eq(doc.saved) : false;
    doc.state = buildState(to, content);
    if (!wasDirty) doc.saved = doc.state.doc;
  }
  docs.set(key(to), doc);
  const dirty = get().dirty[from];
  markDirty(from, false);
  if (dirty) markDirty(to, true);
}

export function rebuildAllStates() {
  for (const doc of docs.values()) {
    if (doc.status !== "text" || !doc.state) continue;
    const wasClean = doc.saved ? doc.state.doc.eq(doc.saved) : true;
    const content = doc.state.doc.toString();
    const selection = doc.state.selection;
    const fresh = buildState(doc.path, content);
    doc.state = selection.main.to <= fresh.doc.length ? fresh.update({ selection }).state : fresh;
    if (wasClean) doc.saved = doc.state.doc;
  }
}
