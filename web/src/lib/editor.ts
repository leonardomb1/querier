// CodeMirror pieces that make a cell feel like VS Code: its token colors, its
// gutter and widgets, completion kinds with icons and docs, and parameter
// hints while typing a basalt function call.

import type { Completion as CMCompletion } from "@codemirror/autocomplete";
import { HighlightStyle } from "@codemirror/language";
import { StateField, type EditorState } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { fnDoc, signature, type FnDoc } from "./basalt";

// -- colors (the values live in app.css, light and dark, after VS Code's Modern themes)

export const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.bool, t.null], color: "var(--c-keyword)" },
  { tag: [t.controlKeyword, t.moduleKeyword], color: "var(--c-control)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--c-string)" },
  { tag: [t.number], color: "var(--c-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--c-comment)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.standard(t.name)], color: "var(--c-function)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--c-type)" },
  { tag: [t.special(t.name), t.variableName, t.propertyName, t.name, t.definition(t.variableName)], color: "var(--c-variable)" },
  { tag: [t.self, t.atom], color: "var(--c-keyword)" },
  { tag: t.heading, fontWeight: "600", color: "var(--c-keyword)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: [t.link, t.url], color: "var(--c-string)", textDecoration: "underline" },
  { tag: t.invalid, color: "var(--critical)" },
]);

export const theme = EditorView.theme({
  "&": { fontSize: "0.8125rem", background: "var(--code-bg)", color: "var(--code-ink)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6", fontVariantNumeric: "slashed-zero" },
  ".cm-content": { padding: "0.375rem 0", caretColor: "var(--code-cursor)" },
  ".cm-line": { padding: "0 0.75rem 0 0.25rem" },
  ".cm-cursor": { borderLeftColor: "var(--code-cursor)", borderLeftWidth: "2px" },
  // CodeMirror draws the selection in its own layer under the text and hides the
  // native one; the current-line wash is translucent so that layer shows through
  // (!important: CodeMirror's base theme styles this layer with a more specific selector)
  ".cm-selectionLayer .cm-selectionBackground": { background: "var(--code-selection-blur) !important" },
  "&.cm-focused .cm-selectionLayer .cm-selectionBackground": { background: "var(--code-selection) !important" },
  ".cm-activeLine": { background: "transparent" },
  "&.cm-focused .cm-activeLine": { background: "var(--code-line)" },
  ".cm-gutters": { background: "var(--code-bg)", border: "0", color: "var(--code-gutter)", paddingLeft: "0.25rem" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 0.5rem 0 0.25rem", minWidth: "1.75rem" },
  ".cm-activeLineGutter": { background: "transparent", color: "var(--code-gutter-active)" },
  ".cm-foldGutter .cm-gutterElement": { color: "transparent", transition: "color 0.12s", cursor: "pointer" },
  ".cm-gutters:hover .cm-foldGutter .cm-gutterElement": { color: "var(--code-gutter)" },
  ".cm-foldPlaceholder": { background: "var(--code-selection)", border: "0", color: "var(--code-ink)", padding: "0 0.25rem" },
  ".cm-matchingBracket": { background: "transparent", outline: "1px solid var(--code-bracket)", borderRadius: "2px" },
  ".cm-selectionMatch": { background: "var(--code-match)" },
  ".cm-searchMatch": { background: "var(--code-find)", outline: "1px solid var(--code-find-edge)" },
  ".cm-searchMatch-selected": { background: "var(--code-find-current)" },
  ".cm-placeholder": { color: "var(--muted)", fontStyle: "normal" },

  // widgets: suggestions (after VS Code's suggest widget), docs, hover, hints, search
  ".cm-tooltip": {
    background: "var(--surface)",
    color: "var(--ink)",
    border: "1px solid var(--hair)",
    borderRadius: "6px",
    boxShadow: "var(--shadow-lg)",
    fontFamily: "var(--sans)",
    fontSize: "0.8125rem",
  },
  ".cm-tooltip.cm-tooltip-autocomplete": {
    background: "var(--suggest-bg)",
    border: "1px solid var(--suggest-border)",
    borderRadius: "5px",
    padding: "0",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--mono)",
    fontSize: "0.8125rem",
    minWidth: "17rem",
    maxWidth: "30rem",
    maxHeight: "calc(12 * 1.5rem)",
    padding: "0",
    scrollbarWidth: "thin",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    display: "flex",
    alignItems: "center",
    height: "1.5rem",
    padding: "0 0.5rem 0 0.375rem",
    lineHeight: "1.5rem",
    color: "var(--suggest-ink)",
    cursor: "default",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li:hover": { background: "var(--suggest-hover)" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    background: "var(--suggest-sel)",
    color: "var(--suggest-sel-ink)",
    outline: "1px solid var(--suggest-focus)",
    outlineOffset: "-1px",
  },
  ".cm-completionLabel": { flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "700", color: "var(--suggest-match)" },
  ".cm-completionDetail": {
    marginLeft: "1.25em",
    fontStyle: "normal",
    color: "var(--suggest-detail)",
    fontSize: "0.75rem",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "50%",
  },
  "li[aria-selected] .cm-completionDetail": { color: "inherit", opacity: "0.85" },
  // icons: VS Code's own, the codicon font (symbol-variable, symbol-method, …), in its suggest colours
  ".cm-completionIcon": {
    flex: "none",
    width: "1rem",
    margin: "0 0.375rem 0 0",
    padding: "0",
    opacity: "1",
    fontFamily: "codicon",
    fontSize: "1rem",
    lineHeight: "1",
    textAlign: "center",
    color: "var(--icon-plain)",
  },
  ".cm-completionIcon:after": { content: '"\\eb63"' },
  ".cm-completionIcon-variable": { color: "var(--icon-var)" },
  ".cm-completionIcon-variable:after": { content: '"\\ea88"' },
  ".cm-completionIcon-property": { color: "var(--icon-var)" },
  ".cm-completionIcon-property:after": { content: '"\\eb5f"' },
  ".cm-completionIcon-method, .cm-completionIcon-function": { color: "var(--icon-fn)" },
  ".cm-completionIcon-method:after, .cm-completionIcon-function:after": { content: '"\\ea8c"' },
  ".cm-completionIcon-class, .cm-completionIcon-type": { color: "var(--icon-class)" },
  ".cm-completionIcon-class:after, .cm-completionIcon-type:after": { content: '"\\eb5b"' },
  ".cm-completionIcon-keyword": { color: "var(--icon-plain)" },
  ".cm-completionIcon-keyword:after": { content: '"\\eb62"' },
  ".cm-completionIcon-namespace": { color: "var(--icon-plain)" },
  ".cm-completionIcon-namespace:after": { content: '"\\ea8b"' },
  ".cm-completionIcon-constant": { color: "var(--icon-plain)" },
  ".cm-completionIcon-constant:after": { content: '"\\eb5d"' },
  ".cm-completionIcon-enum": { color: "var(--icon-class)" },
  ".cm-completionIcon-enum:after": { content: '"\\ea95"' },
  ".cm-completionIcon-text": { color: "var(--icon-plain)" },
  ".cm-completionIcon-text:after": { content: '"\\ea93"' },
  // the docs flyout sits against the list, same frame
  ".cm-tooltip.cm-completionInfo": {
    background: "var(--suggest-bg)",
    border: "1px solid var(--suggest-border)",
    borderRadius: "5px",
    padding: "0.5rem 0.75rem",
    maxWidth: "26rem",
    margin: "0 0 0 -1px",
  },
  ".cm-tooltip-hover, .cm-tooltip-signature": { padding: "0.5rem 0.75rem", maxWidth: "30rem" },
  ".cm-tooltip-signature": { padding: "0.25rem 0.625rem" },
  "&:not(.cm-focused) .cm-tooltip-signature": { display: "none" },
  ".cm-tooltip-lint": { padding: "0" },
  ".cm-diagnostic": { padding: "0.375rem 0.625rem", fontFamily: "var(--sans)" },
  ".cm-diagnostic-error": { borderLeft: "0" },
  ".cm-panels": { background: "var(--surface)", color: "var(--ink)", borderColor: "var(--hair)" },
  ".cm-panel.cm-search": { padding: "0.375rem 0.5rem", fontFamily: "var(--sans)", fontSize: "0.78rem" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontSize: "0.78rem" },
  ".cm-panel.cm-search [name=close]": { color: "var(--muted)" },
});

// -- doc cards (completion info, hover, parameter hints)

export function fnCard(fn: FnDoc, active = -1): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "doc-card";
  const sig = document.createElement("code");
  sig.className = "doc-sig";
  sig.append(`${fn.name}(`);
  fn.params.forEach((p, i) => {
    if (i) sig.append(", ");
    const span = document.createElement("span");
    span.textContent = p;
    if (i === active || (active >= fn.params.length && p === "..." && i === fn.params.length - 1)) span.className = "doc-active";
    sig.append(span);
  });
  sig.append(")");
  if (fn.returns) sig.append(` → ${fn.returns}`);
  dom.append(sig);
  const doc = document.createElement("div");
  doc.className = "doc-text";
  doc.innerHTML = fn.doc.replace(/`([^`]+)`/g, "<code>$1</code>");
  dom.append(doc);
  const kind = document.createElement("div");
  kind.className = "doc-kind";
  kind.textContent = `${fn.kind} function`;
  dom.append(kind);
  return dom;
}

export interface HoverInfo {
  title: string;
  sub?: string;
  rows?: [string, string][];
  more?: number;
}

export function infoCard(info: HoverInfo): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "doc-card";
  const title = document.createElement("code");
  title.className = "doc-sig";
  title.textContent = info.title;
  dom.append(title);
  if (info.sub) {
    const sub = document.createElement("div");
    sub.className = "doc-text";
    sub.textContent = info.sub;
    dom.append(sub);
  }
  if (info.rows?.length) {
    const table = document.createElement("div");
    table.className = "doc-rows";
    for (const [k, v] of info.rows) {
      const a = document.createElement("span");
      a.textContent = k;
      const b = document.createElement("span");
      b.textContent = v;
      table.append(a, b);
    }
    dom.append(table);
    if (info.more) {
      const more = document.createElement("div");
      more.className = "doc-kind";
      more.textContent = `and ${info.more} more`;
      dom.append(more);
    }
  }
  return dom;
}

// -- completion kinds: what the kernel says → CodeMirror's type, and ordering

const TYPE: Record<string, string> = {
  keyword: "keyword",
  function: "function",
  method: "method",
  param: "variable",
  variable: "variable",
  column: "property",
  table: "class",
  cte: "class",
  class: "class",
  connection: "namespace",
  module: "namespace",
  path: "text",
};
const BOOST: Record<string, number> = { column: 4, table: 3, cte: 3, param: 3, variable: 2, function: 1, method: 1, keyword: -1 };

export function toOption(item: { text: string; kind: string; detail?: string }, lang: string): CMCompletion {
  const fn = lang === "sql" && (item.kind === "function" || item.kind === "keyword") ? fnDoc(item.text) : undefined;
  return {
    label: item.text,
    type: fn ? "function" : (TYPE[item.kind] ?? "variable"),
    detail: item.detail || (fn ? `${fn.kind}` : item.kind === "keyword" ? "" : item.kind),
    boost: fn ? 1 : (BOOST[item.kind] ?? 0),
    info: fn ? () => fnCard(fn) : undefined,
  };
}

// -- parameter hints: the basalt function call the cursor is inside

function callAt(state: EditorState, pos: number): { fn: FnDoc; arg: number; at: number } | null {
  const from = Math.max(0, pos - 2000);
  const text = state.sliceDoc(from, pos);
  let depth = 0;
  let arg = 0;
  let quote = false;
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if (c === "'") quote = !quote;
    if (quote) continue;
    if (c === ";") return null;
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth === 0) {
        const m = /([A-Za-z_]\w*)\s*$/.exec(text.slice(0, i));
        const fn = m && fnDoc(m[1]);
        return fn ? { fn, arg, at: from + i - m[0].length } : null;
      }
      depth--;
    } else if (c === "," && depth === 0) arg++;
  }
  return null;
}

function hint(state: EditorState): readonly Tooltip[] {
  const sel = state.selection.main;
  if (!sel.empty) return [];
  const call = callAt(state, sel.head);
  if (!call || !call.fn.params.length) return [];
  return [
    {
      pos: call.at,
      above: true,
      strictSide: false,
      arrow: false,
      create: () => {
        const dom = fnCard(call.fn, call.arg);
        dom.classList.add("doc-hint");
        return { dom };
      },
    },
  ];
}

export const parameterHints = StateField.define<readonly Tooltip[]>({
  create: hint,
  update: (value, tr) => (tr.docChanged || tr.selection ? hint(tr.state) : value),
  provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
});

export function signatureOf(name: string) {
  const fn = fnDoc(name);
  return fn && signature(fn);
}
