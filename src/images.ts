export type ChatImage = { id: string; mediaType: string; data: string; url: string; name: string };

const SUPPORTED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_SIDE = 2000;
const MAX_DATA_CHARS = 4_800_000;
const JPEG_QUALITY = 0.88;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

let counter = 0;

export function isImagePath(path: string): boolean {
  return IMAGE_EXT.test(path);
}

function split(url: string): { mediaType: string; data: string } {
  const match = url.match(/^data:([^;,]+);base64,(.*)$/);
  return match ? { mediaType: match[1], data: match[2] } : { mediaType: "", data: "" };
}

function load(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Не вдалося прочитати картинку"));
    img.src = url;
  });
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Не вдалося прочитати картинку"));
    reader.readAsDataURL(blob);
  });
}

async function shrink(url: string, mediaType: string): Promise<string> {
  const img = await load(url);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return url;
  ctx.drawImage(img, 0, 0, width, height);
  const png = mediaType === "image/jpeg" ? "" : canvas.toDataURL("image/png");
  if (png && png.length <= MAX_DATA_CHARS) return png;
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

export async function prepareImage(url: string, name: string): Promise<ChatImage> {
  let { mediaType, data } = split(url);
  let finalUrl = url;
  const supported = SUPPORTED.has(mediaType);
  const heavy = data.length > MAX_DATA_CHARS;
  let large = false;
  if (supported && !heavy && mediaType !== "image/gif") {
    const img = await load(url);
    large = Math.max(img.naturalWidth, img.naturalHeight) > MAX_SIDE;
  }
  if (!supported || heavy || large) {
    finalUrl = await shrink(url, mediaType);
    ({ mediaType, data } = split(finalUrl));
  }
  counter += 1;
  return { id: `img-${Date.now()}-${counter}`, mediaType, data, url: finalUrl, name };
}

export async function imageFromBlob(blob: Blob, name: string): Promise<ChatImage> {
  return prepareImage(await readBlob(blob), name);
}

export function imageBlock(image: ChatImage) {
  return { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } };
}
