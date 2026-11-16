import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Eye, EyeOff, FilePen, Hand, ListChecks, Paperclip, ShieldOff, Square, X, Zap } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  FALLBACK_MODELS,
  interruptChat,
  prettyModel,
  sendMessage,
  setChatEffort,
  setChatModel,
  setChatMode,
  type Chat,
  type PermissionMode,
} from "../../chat";
import { api } from "../../ipc";
import { activeWorkspace, allWorkspaces, get, openMenu, toast, useStore, type MenuItem, type Tab } from "../../store";
import { chatTitleFrom, isUntitledChat, updateChatTab } from "../../actions";
import { FileIcon } from "../FileIcon";
import { imageFromBlob, isImagePath, prepareImage, type ChatImage } from "../../images";
import { basename, joinPath, samePath } from "../../util";

type ChatTab = Extract<Tab, { kind: "chat" }>;

const drafts = new Map<string, string>();

const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export const MODES: { id: PermissionMode; label: string; hint: string; icon: typeof Hand }[] = [
  { id: "default", label: "Питати дозвіл", hint: "Claude питає перед правками й командами", icon: Hand },
  { id: "acceptEdits", label: "Приймати правки", hint: "Правки файлів без питань, команди — з питанням", icon: FilePen },
  { id: "plan", label: "Режим плану", hint: "Спершу план, нічого не змінює", icon: ListChecks },
  { id: "auto", label: "Авто", hint: "Claude сам вирішує, що безпечно", icon: Zap },
  { id: "bypassPermissions", label: "Без обмежень", hint: "Усе без питань", icon: ShieldOff },
];

const MODE_CYCLE: PermissionMode[] = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];

let defaultEffort: Promise<string | null> | null = null;

function loadDefaultEffort(): Promise<string | null> {
  if (!defaultEffort) {
    const dir = get().info?.claudeDir;
    defaultEffort = dir
      ? api
          .readText(joinPath(dir, "settings.json"))
          .then((file) => {
            const value = JSON.parse(file.content)?.effortLevel;
            return typeof value === "string" ? value : null;
          })
          .catch(() => null)
      : Promise.resolve(null);
  }
  return defaultEffort;
}

function rankCommands(chat: Chat, query: string) {
  const q = query.toLowerCase();
  return chat.commands
    .filter((c) => c.name.toLowerCase().includes(q))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.length - b.name.length)
    .slice(0, 8);
}

export function Composer({ tab, chat }: { tab: ChatTab; chat: Chat }) {
  const ws = useStore((s) => allWorkspaces(s).find((w) => w.tabs.some((t) => t.id === tab.id)) ?? activeWorkspace(s));
  const recentFile = useStore((s) => s.recentFile[ws.id] ?? null);
  const fileOpen = !!recentFile && ws.tabs.some((t) => t.kind === "file" && samePath(t.path, recentFile));
  const [includeFile, setIncludeFile] = useState(true);
  const [text, setText] = useState(() => drafts.get(tab.id) ?? "");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [images, setImages] = useState<ChatImage[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [fallbackEffort, setFallbackEffort] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    loadDefaultEffort().then(setFallbackEffort);
    area.current?.focus();
  }, []);

  useEffect(() => {
    drafts.set(tab.id, text);
  }, [tab.id, text]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [text]);

  const slashQuery = /^\/[^\s]*$/.test(text) ? text.slice(1) : null;
  const slash = useMemo(() => (slashQuery === null ? [] : rankCommands(chat, slashQuery)), [slashQuery, chat.commands]);
  useEffect(() => setSlashIndex(0), [slashQuery]);

  const models = chat.models.length ? chat.models : FALLBACK_MODELS;
  const currentModel = chat.model ?? "default";
  const modelOption = models.find((m) => m.value === currentModel);
  const modelName = currentModel === "default" || !modelOption ? prettyModel(chat.resolvedModel) || modelOption?.displayName || "Модель" : modelOption.displayName;
  const effortLevels = (modelOption ?? models[0])?.supportedEffortLevels ?? ["low", "medium", "high", "xhigh", "max"];
  const effort = chat.effort ?? fallbackEffort;
  const mode = chat.currentMode ?? chat.mode ?? "default";
  const modeInfo = MODES.find((m) => m.id === mode) ?? MODES[0];
  const ModeIcon = modeInfo.icon;

  const pickModel = (value: string) => {
    setChatModel(tab.id, value);
    updateChatTab(tab.id, { model: value });
  };
  const pickEffort = (value: string) => {
    setChatEffort(tab.id, value);
    updateChatTab(tab.id, { effort: value });
  };
  const pickMode = (value: PermissionMode) => {
    setChatMode(tab.id, value);
    updateChatTab(tab.id, { mode: value });
  };

  const modelMenu = (event: React.MouseEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const items: MenuItem[] = models.map((m) => ({
      label: m.value === "default" ? `${m.displayName}${chat.resolvedModel ? ` · ${prettyModel(chat.resolvedModel)}` : ""}` : m.displayName,
      shortcut: m.value === currentModel ? "✓" : undefined,
      action: () => pickModel(m.value),
    }));
    items.push("separator");
    effortLevels.forEach((level) =>
      items.push({ label: `Зусилля: ${EFFORT_LABELS[level] ?? level}`, shortcut: level === effort ? "✓" : undefined, action: () => pickEffort(level) }),
    );
    openMenu({ clientX: rect.left, clientY: rect.top - 16 - items.length * 28 }, items);
  };

  const modeMenu = (event: React.MouseEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const items: MenuItem[] = MODES.map((m) => ({ label: `${m.label} — ${m.hint}`, shortcut: m.id === mode ? "✓" : undefined, action: () => pickMode(m.id) }));
    openMenu({ clientX: rect.left, clientY: rect.top - 16 - items.length * 28 }, items);
  };

  const attach = async () => {
    const picked = await openDialog({ multiple: true, title: "Прикріпити файли до повідомлення", defaultPath: chat.cwd });
    const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
    const files = paths.filter((p) => !isImagePath(p));
    if (files.length) setAttachments((current) => [...current, ...files.filter((p) => !current.some((c) => samePath(c, p)))]);
    for (const path of paths.filter(isImagePath)) {
      try {
        const image = await prepareImage(await api.readDataUrl(path), basename(path));
        setImages((current) => [...current, image]);
      } catch (error) {
        toast(`Картинка «${basename(path)}»: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
    area.current?.focus();
  };

  const onPaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const blobs = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (blobs.length === 0) return;
    event.preventDefault();
    for (const blob of blobs) {
      try {
        const image = await imageFromBlob(blob, blob.name && blob.name !== "image.png" ? blob.name : `Скрін ${images.length + 1}`);
        setImages((current) => [...current, image]);
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), "error");
      }
    }
  };

  const submit = () => {
    if (!text.trim() && attachments.length === 0 && images.length === 0) return;
    const file = includeFile && fileOpen && !attachments.some((a) => samePath(a, recentFile)) ? recentFile : null;
    if (isUntitledChat(tab.title) && text.trim()) updateChatTab(tab.id, { title: chatTitleFrom(text) });
    sendMessage(tab.id, text, file, attachments, images);
    setText("");
    setAttachments([]);
    setImages([]);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (slash.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((i) => (i + (event.key === "ArrowDown" ? 1 : -1) + slash.length) % slash.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        setText(`/${slash[slashIndex].name} `);
        return;
      }
    }
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      const index = MODE_CYCLE.indexOf(mode);
      pickMode(MODE_CYCLE[(index + 1) % MODE_CYCLE.length]);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "Escape" && chat.busy) {
      event.preventDefault();
      interruptChat(tab.id);
      return;
    }
    if (event.key === "ArrowUp" && !text) {
      const last = [...chat.items].reverse().find((i) => i.kind === "user");
      if (last && last.kind === "user") {
        event.preventDefault();
        setText(last.text);
      }
    }
  };

  const fiveHour = chat.limits?.fiveHour;
  const showStop = chat.busy && !text.trim() && attachments.length === 0 && images.length === 0;

  return (
    <div className="composer-wrap">
      {slash.length > 0 && (
        <div className="slash-menu">
          {slash.map((command, i) => (
            <button
              key={command.name}
              className={`slash-item${i === slashIndex ? " on" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                setText(`/${command.name} `);
                area.current?.focus();
              }}
            >
              <span className="slash-name">/{command.name}</span>
              <span className="slash-desc">{command.description}</span>
            </button>
          ))}
        </div>
      )}
      <div className={`composer${chat.busy ? " busy" : ""}`} onClick={() => area.current?.focus()}>
        {images.length > 0 && (
          <div className="composer-images">
            {images.map((image) => (
              <span key={image.id} className="composer-image" title={image.name}>
                <img src={image.url} alt={image.name} />
                <button
                  className="composer-image-x"
                  title="Прибрати картинку"
                  onClick={(e) => {
                    e.stopPropagation();
                    setImages((current) => current.filter((i) => i.id !== image.id));
                  }}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        {(attachments.length > 0 || (fileOpen && recentFile)) && (
          <div className="composer-files">
            {fileOpen && recentFile && (
              <button
                className={`composer-file${includeFile ? "" : " off"}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setIncludeFile(!includeFile);
                }}
                title={includeFile ? "Claude побачить, що цей файл відкритий. Натисни, щоб не додавати" : "Файл не додається. Натисни, щоб додати"}
              >
                {includeFile ? <Eye size={12} /> : <EyeOff size={12} />}
                <FileIcon name={basename(recentFile)} size={13} />
                {basename(recentFile)}
              </button>
            )}
            {attachments.map((path) => (
              <span key={path} className="composer-file" title={path}>
                <FileIcon name={basename(path)} size={13} />
                {basename(path)}
                <button
                  className="composer-file-x"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAttachments((current) => current.filter((p) => p !== path));
                  }}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          className="composer-input"
          rows={1}
          value={text}
          spellCheck={false}
          placeholder={chat.busy ? "Додати ще повідомлення в чергу…" : "Напиши Claude…   / — команди · Shift Tab — режим · Ctrl V — картинка"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="composer-bar" onClick={(e) => e.stopPropagation()}>
          <button className="composer-pill icon" title="Прикріпити файли або картинки (картинку можна просто вставити: Ctrl V)" onClick={attach}>
            <Paperclip size={14} />
          </button>
          <button className="composer-pill" onClick={modelMenu} title="Модель і зусилля">
            <span className="composer-model">{modelName}</span>
            {effort && <span className="composer-effort">{EFFORT_LABELS[effort] ?? effort}</span>}
            <ChevronDown size={12} />
          </button>
          <button className={`composer-pill mode-${mode}`} onClick={modeMenu} title={`${modeInfo.hint} (Shift Tab)`}>
            <ModeIcon size={13} />
            {modeInfo.label}
          </button>
          <div className="grow" />
          {typeof fiveHour === "number" && (
            <span className={`composer-limit${fiveHour >= 0.8 ? " warn" : ""}`} title="Використано з 5-годинного ліміту">
              5 год · {Math.round(fiveHour * 100)}%
            </span>
          )}
          {showStop ? (
            <button className="composer-send stop" title="Зупинити (Esc)" onClick={() => interruptChat(tab.id)}>
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button className="composer-send" title="Надіслати (Enter)" disabled={!text.trim() && attachments.length === 0 && images.length === 0} onClick={submit}>
              <ArrowUp size={15} strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
