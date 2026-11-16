import { marked, type Tokens } from "marked";
import { api } from "./ipc";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(token.text);
    },
    image(token: Tokens.Image) {
      const href = token.href ?? "";
      const alt = escapeHtml(token.text ?? "");
      if (/^(https?:|data:|blob:)/i.test(href)) return `<img class="md-img" src="${escapeHtml(href)}" alt="${alt}">`;
      return `<img class="md-img pending" data-local="${escapeHtml(href)}" alt="${alt}">`;
    },
  },
});

export type FrontmatterField = { key: string; value: string };

export function splitFrontmatter(text: string): { fields: FrontmatterField[]; body: string } {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { fields: [], body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return { fields: [], body: normalized };
  const header = normalized.slice(4, end);
  const afterLine = normalized.indexOf("\n", end + 4);
  const body = afterLine < 0 ? "" : normalized.slice(afterLine + 1);
  return { fields: parseFields(header.split("\n")), body };
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function parseFields(lines: string[]): FrontmatterField[] {
  const fields: FrontmatterField[] = [];
  let index = 0;
  const indented = (l: string) => /^[ \t]/.test(l) || l.trim() === "";
  while (index < lines.length) {
    const line = lines[index++];
    if (indented(line) || line.trim().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    const continuation: string[] = [];
    while (index < lines.length && indented(lines[index])) continuation.push(lines[index++]);
    let value: string;
    if (raw.startsWith(">") || raw.startsWith("|")) {
      const parts = continuation.map((l) => l.trim());
      value = raw.startsWith(">") ? parts.filter(Boolean).join(" ") : parts.join("\n");
    } else if (raw === "") {
      const nested = continuation.some((l) => l.trim().endsWith(":") || l.includes(": ") || l.trim().startsWith("- "));
      value = nested ? continuation.map((l) => l.trim()).filter(Boolean).join(" · ") : continuation.map((l) => l.trim()).filter(Boolean).join(" ");
    } else {
      value = unquote([raw, ...continuation.map((l) => l.trim()).filter(Boolean)].join(" "));
    }
    fields.push({ key, value: value.trim() });
  }
  return fields;
}

export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

export function handleMarkdownClick(event: React.MouseEvent) {
  const anchor = (event.target as HTMLElement).closest("a");
  if (!anchor) return;
  event.preventDefault();
  const href = anchor.getAttribute("href") ?? "";
  if (/^https?:\/\//i.test(href)) api.openExternal(href).catch(() => {});
}
