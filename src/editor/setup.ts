import { EditorState, Compartment, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
  placeholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  HighlightStyle,
  syntaxHighlighting,
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap,
  StreamLanguage,
  indentUnit,
} from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches, search } from "@codemirror/search";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { yaml } from "@codemirror/lang-yaml";
import { cpp } from "@codemirror/lang-cpp";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { go } from "@codemirror/legacy-modes/mode/go";
import { csharp, kotlin, java } from "@codemirror/legacy-modes/mode/clike";
import { sql } from "@codemirror/legacy-modes/mode/sql";
import { extname } from "../util";

export const wrapCompartment = new Compartment();
export const fontCompartment = new Compartment();

const emberHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.character], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--syn-function)" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "var(--syn-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-property)" },
  { tag: [t.variableName], color: "var(--syn-variable)" },
  { tag: [t.definition(t.variableName)], color: "var(--fg)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--syn-punct)" },
  { tag: [t.tagName], color: "var(--syn-tag)" },
  { tag: [t.regexp, t.escape], color: "var(--syn-regexp)" },
  { tag: [t.self, t.special(t.variableName)], color: "var(--syn-keyword)", fontStyle: "italic" },
  { tag: [t.heading], color: "var(--syn-heading)", fontWeight: "600" },
  { tag: [t.heading1], color: "var(--syn-heading)", fontWeight: "700" },
  { tag: [t.link, t.url], color: "var(--syn-function)", textDecoration: "underline" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "700", color: "var(--fg)" },
  { tag: [t.strikethrough], textDecoration: "line-through" },
  { tag: [t.quote], color: "var(--syn-punct)", fontStyle: "italic" },
  { tag: [t.monospace], color: "var(--syn-string)" },
  { tag: [t.meta, t.annotation, t.processingInstruction], color: "var(--syn-meta)" },
  { tag: [t.invalid], color: "var(--danger)" },
  { tag: [t.labelName], color: "var(--syn-number)" },
]);

const editorTheme = EditorView.theme(
  {
    "&": { color: "var(--fg)", backgroundColor: "var(--bg-editor)", height: "100%" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6", overflow: "auto" },
    ".cm-content": { caretColor: "var(--accent)", padding: "10px 0 40vh" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent) !important",
    },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.028)" },
    ".cm-gutters": { backgroundColor: "var(--bg-editor)", color: "var(--fg-4)", border: "none", paddingLeft: "6px" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg-2)" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 14px 0 8px", minWidth: "36px" },
    ".cm-foldGutter .cm-gutterElement": { color: "var(--fg-4)", padding: "0 4px" },
    ".cm-foldPlaceholder": { backgroundColor: "var(--bg-hover)", border: "1px solid var(--line-strong)", color: "var(--fg-3)", padding: "0 6px", borderRadius: "4px" },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "rgba(255,255,255,0.08)", outline: "1px solid var(--line-strong)" },
    ".cm-selectionMatch": { backgroundColor: "rgba(255,255,255,0.07)" },
    ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)", outline: "1px solid var(--accent-line)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--accent) 45%, transparent)" },
    ".cm-panels": { backgroundColor: "var(--bg-side)", color: "var(--fg)", borderColor: "var(--line)" },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
    ".cm-panel.cm-search": { padding: "8px 10px", fontFamily: "var(--font-ui)", fontSize: "12px" },
    ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontFamily: "var(--font-ui)", fontSize: "12px" },
    ".cm-textfield": { backgroundColor: "var(--bg-raised)", border: "1px solid var(--line-strong)", borderRadius: "5px", color: "var(--fg)", padding: "4px 8px" },
    ".cm-button": { backgroundImage: "none", backgroundColor: "var(--bg-raised)", border: "1px solid var(--line-strong)", borderRadius: "5px", color: "var(--fg-2)", padding: "4px 10px" },
    ".cm-tooltip": { backgroundColor: "var(--bg-side)", border: "1px solid var(--line-strong)", borderRadius: "6px", overflow: "hidden" },
    ".cm-tooltip-autocomplete > ul > li": { padding: "3px 10px", fontFamily: "var(--font-mono)" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent-soft)", color: "var(--fg)" },
    ".cm-specialChar": { color: "var(--danger)" },
  },
  { dark: true },
);

function legacy(mode: Parameters<typeof StreamLanguage.define>[0]): Extension {
  return StreamLanguage.define(mode);
}

export function languageFor(path: string): { ext: Extension | null; label: string } {
  const ext = extname(path);
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return { ext: javascript({ typescript: true }), label: "TypeScript" };
    case "tsx":
      return { ext: javascript({ typescript: true, jsx: true }), label: "TypeScript JSX" };
    case "js":
    case "mjs":
    case "cjs":
      return { ext: javascript(), label: "JavaScript" };
    case "jsx":
      return { ext: javascript({ jsx: true }), label: "JavaScript JSX" };
    case "rs":
      return { ext: rust(), label: "Rust" };
    case "py":
    case "pyw":
      return { ext: python(), label: "Python" };
    case "gd":
      return { ext: python(), label: "GDScript" };
    case "json":
    case "jsonc":
    case "webmanifest":
      return { ext: json(), label: "JSON" };
    case "md":
    case "mdx":
    case "markdown":
      return { ext: markdown(), label: "Markdown" };
    case "html":
    case "htm":
    case "svg":
    case "xml":
    case "vue":
    case "svelte":
      return { ext: html(), label: ext.toUpperCase() };
    case "css":
    case "scss":
    case "less":
      return { ext: css(), label: "CSS" };
    case "yml":
    case "yaml":
      return { ext: yaml(), label: "YAML" };
    case "c":
    case "h":
    case "cpp":
    case "hpp":
    case "cc":
    case "glsl":
    case "frag":
    case "vert":
    case "gdshader":
    case "shader":
    case "wgsl":
    case "hlsl":
      return { ext: cpp(), label: ext === "c" || ext === "h" ? "C" : ext === "cpp" || ext === "hpp" || ext === "cc" ? "C++" : "Shader" };
    case "toml":
      return { ext: legacy(toml), label: "TOML" };
    case "sh":
    case "bash":
    case "zsh":
      return { ext: legacy(shell), label: "Shell" };
    case "ps1":
    case "psm1":
    case "psd1":
      return { ext: legacy(powerShell), label: "PowerShell" };
    case "lua":
      return { ext: legacy(lua), label: "Lua" };
    case "go":
      return { ext: legacy(go), label: "Go" };
    case "cs":
      return { ext: legacy(csharp), label: "C#" };
    case "java":
      return { ext: legacy(java), label: "Java" };
    case "kt":
      return { ext: legacy(kotlin), label: "Kotlin" };
    case "sql":
      return { ext: legacy(sql({})), label: "SQL" };
    case "tscn":
    case "tres":
    case "godot":
    case "cfg":
    case "ini":
      return { ext: legacy(toml), label: ext.toUpperCase() };
    default:
      if (name === "dockerfile" || name === "makefile") return { ext: legacy(shell), label: name };
      return { ext: null, label: ext ? ext.toUpperCase() : "Текст" };
  }
}

export function createMarkdownState(content: string, onChange: (text: string) => void, placeholderText: string): EditorState {
  return EditorState.create({
    doc: content,
    extensions: [
      history(),
      drawSelection(),
      highlightActiveLine(),
      highlightSpecialChars(),
      bracketMatching(),
      closeBrackets(),
      syntaxHighlighting(emberHighlight, { fallback: true }),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      markdown(),
      editorTheme,
      fontTheme(13.5),
      EditorView.lineWrapping,
      placeholder(placeholderText),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange(update.state.doc.toString());
      }),
    ],
  });
}

export function fontTheme(size: number): Extension {
  return EditorView.theme({ ".cm-scroller": { fontSize: `${size}px` } });
}

export function createState(
  path: string,
  content: string,
  options: { wrap: boolean; fontSize: number; onChange: (state: EditorState) => void; onSave: () => void; onCursor: (state: EditorState) => void },
): EditorState {
  const language = languageFor(path).ext;
  return EditorState.create({
    doc: content,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter({ openText: "▾", closedText: "▸" }),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      indentUnit.of(content.includes("\n\t") ? "\t" : "  "),
      syntaxHighlighting(emberHighlight, { fallback: true }),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => (options.onSave(), true) },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      editorTheme,
      fontCompartment.of(fontTheme(options.fontSize)),
      wrapCompartment.of(options.wrap ? EditorView.lineWrapping : []),
      language ?? [],
      EditorView.updateListener.of((update) => {
        if (update.docChanged) options.onChange(update.state);
        if (update.selectionSet || update.docChanged) options.onCursor(update.state);
      }),
    ],
  });
}
