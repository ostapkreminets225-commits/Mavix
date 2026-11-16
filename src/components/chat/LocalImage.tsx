import { useEffect, useState } from "react";
import { create } from "zustand";
import { ImageOff, Maximize2, X } from "lucide-react";
import { api, errorText } from "../../ipc";

export type ImageRef = { alt: string; path: string };

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g;
const BARE_PATH = /(?:^|[\s(])((?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"'<>|*?]+\.(?:png|jpe?g|gif|webp|bmp))(?=$|[\s),.;:!?])/gim;
const REMOTE = /^(https?:|data:|blob:)/i;

const cache = new Map<string, Promise<string>>();

export function cleanImagePath(raw: string): string {
  let path = raw.trim();
  try {
    path = decodeURI(path);
  } catch {
    path = raw.trim();
  }
  return path.replace(/^file:\/\/\/?/i, "");
}

export function isRemoteImage(path: string): boolean {
  return REMOTE.test(path);
}

export function looksLikeImage(path: string): boolean {
  return isRemoteImage(path) || IMAGE_EXT.test(path);
}

export function imageUrl(path: string): Promise<string> {
  if (isRemoteImage(path)) return Promise.resolve(path);
  const key = cleanImagePath(path);
  let job = cache.get(key);
  if (!job) {
    job = api.readDataUrl(key);
    job.catch(() => cache.delete(key));
    cache.set(key, job);
  }
  return job;
}

export function findImages(text: string): ImageRef[] {
  if (!text) return [];
  const found: ImageRef[] = [];
  const seen = new Set<string>();
  const add = (alt: string, raw: string) => {
    const path = cleanImagePath(raw);
    if (!looksLikeImage(path) || seen.has(path)) return;
    seen.add(path);
    found.push({ alt: alt.trim(), path });
  };
  for (const match of text.matchAll(MARKDOWN_IMAGE)) add(match[1], match[2] ?? match[3] ?? "");
  const rest = text.replace(MARKDOWN_IMAGE, " ");
  for (const match of rest.matchAll(BARE_PATH)) add("", match[1]);
  return found;
}

export function withoutImages(text: string): string {
  if (!text) return "";
  return text
    .replace(MARKDOWN_IMAGE, " ")
    .replace(BARE_PATH, (whole, path: string) => whole.slice(0, whole.length - path.length))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type Zoom = { src: string | null; alt: string };

export const useZoom = create<Zoom>(() => ({ src: null, alt: "" }));

export function zoomImage(src: string, alt = "") {
  useZoom.setState({ src, alt });
}

export function useImageUrl(path: string): { url: string | null; error: string | null } {
  const [state, setState] = useState<{ url: string | null; error: string | null }>({ url: null, error: null });
  useEffect(() => {
    let alive = true;
    setState({ url: null, error: null });
    imageUrl(path).then(
      (url) => alive && setState({ url, error: null }),
      (error) => alive && setState({ url: null, error: errorText(error) }),
    );
    return () => {
      alive = false;
    };
  }, [path]);
  return state;
}

export function LocalImage({ image, className = "", zoomable = true }: { image: ImageRef; className?: string; zoomable?: boolean }) {
  const { url, error } = useImageUrl(image.path);
  const name = image.alt || image.path.split(/[\\/]/).pop() || image.path;
  if (error) {
    return (
      <div className={`limg missing ${className}`} title={`${image.path}\n${error}`}>
        <ImageOff size={16} strokeWidth={1.6} />
        <span>Не вдалося відкрити {name}</span>
      </div>
    );
  }
  return (
    <div className={`limg ${url ? "" : "loading"} ${className}`} title={image.path}>
      {url && <img src={url} alt={name} draggable={false} />}
      {url && zoomable && (
        <button
          className="limg-zoom"
          title="Відкрити на весь екран"
          onClick={(event) => {
            event.stopPropagation();
            zoomImage(url, name);
          }}
        >
          <Maximize2 size={13} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

export function ImageZoom() {
  const { src, alt } = useZoom();
  useEffect(() => {
    if (!src) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      useZoom.setState({ src: null, alt: "" });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [src]);
  if (!src) return null;
  const close = () => useZoom.setState({ src: null, alt: "" });
  return (
    <div className="zoom-backdrop" onMouseDown={close}>
      <img className="zoom-img" src={src} alt={alt} onMouseDown={(event) => event.stopPropagation()} />
      <div className="zoom-bar" onMouseDown={(event) => event.stopPropagation()}>
        {alt && <span className="zoom-name">{alt}</span>}
        <button className="icon-btn" title="Закрити (Esc)" onClick={close}>
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
