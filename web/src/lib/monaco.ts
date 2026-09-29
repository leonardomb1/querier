// Monaco, VS Code's own editor, for cells and report.svelte. Its editing features
// (monaco-features.js) without its built-in languages; Shiki's TextMate grammars
// for the colours (the grammars VS Code uses: Svelte, Python, Markdown, and
// basalt's own), in VS Code's Dark and Light Modern; and querier's help (the
// kernel's completions, basalt's functions, the template's hooks) registered
// once per language and routed to the editor it belongs to.

import "./monaco-features.js";
import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { shikiToMonaco } from "@shikijs/monaco";
import type { ThemeRegistrationRaw } from "shiki/core";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import darkPlus from "@shikijs/themes/dark-plus";
import lightPlus from "@shikijs/themes/light-plus";
import type { Lang } from "./api";
import { callAt, FUNCTIONS, fnDoc } from "./basalt";
import { basaltGrammar } from "./basalt-grammar";
import { cedarGrammar } from "./cedar-grammar";
import { cedarComplete, cedarHover, type CedarVocabulary } from "./cedarcomplete";
import type { Completion } from "./conn.svelte";
import { fnMarkdown, infoMarkdown, toSuggestion, type HoverInfo, type Suggestion } from "./editor";
import type { TemplateResult } from "./templatecomplete";
import { isDark } from "./vegatheme";

export { monaco };

(self as any).MonacoEnvironment = { getWorker: () => new EditorWorker() };

export type EditorLang = Lang | "svelte";
/** our language → Monaco's (and Shiki's) */
export const LANG_ID: Record<EditorLang, string> = { sql: "basalt", python: "python", md: "markdown", svelte: "svelte" };

// -- themes: VS Code's Dark+ and Light+ token colours, on its Modern chrome
const MODERN_DARK: Record<string, string> = {
  "editor.background": "#1f1f1f",
  "editor.foreground": "#cccccc",
  "editorGutter.background": "#1f1f1f",
  "editor.lineHighlightBackground": "#ffffff0b",
  "editor.lineHighlightBorder": "#00000000",
  "editor.selectionBackground": "#264f78",
  "editor.inactiveSelectionBackground": "#3a3d41",
  "editorLineNumber.foreground": "#6e7681",
  "editorLineNumber.activeForeground": "#cccccc",
  "editorCursor.foreground": "#aeafad",
  "editorIndentGuide.background1": "#404040",
  "editorWidget.background": "#202020",
  "editorWidget.border": "#313131",
  "editorSuggestWidget.background": "#202020",
  "editorSuggestWidget.border": "#454545",
  "editorSuggestWidget.selectedBackground": "#04395e",
  "editorSuggestWidget.highlightForeground": "#2aaaff",
  "editorHoverWidget.background": "#202020",
  "editorHoverWidget.border": "#454545",
  "focusBorder": "#0078d4",
  "input.background": "#313131",
  "input.border": "#3c3c3c",
  "scrollbarSlider.background": "#79797966",
  "diffEditor.insertedTextBackground": "#9ccc2c33",
  "diffEditor.removedTextBackground": "#ff000033",
  "diffEditor.insertedLineBackground": "#9bb95533",
  "diffEditor.removedLineBackground": "#ff000026",
};
const MODERN_LIGHT: Record<string, string> = {
  "editor.background": "#ffffff",
  "editor.foreground": "#3b3b3b",
  "editorGutter.background": "#ffffff",
  "editor.lineHighlightBackground": "#0000000a",
  "editor.lineHighlightBorder": "#00000000",
  "editor.selectionBackground": "#add6ff",
  "editor.inactiveSelectionBackground": "#e5ebf1",
  "editorLineNumber.foreground": "#6e7681",
  "editorLineNumber.activeForeground": "#171184",
  "editorCursor.foreground": "#000000",
  "editorIndentGuide.background1": "#d3d3d3",
  "editorWidget.background": "#f8f8f8",
  "editorWidget.border": "#e5e5e5",
  "editorSuggestWidget.background": "#f8f8f8",
  "editorSuggestWidget.border": "#c8c8c8",
  "editorSuggestWidget.selectedBackground": "#e8e8e8",
  "editorSuggestWidget.highlightForeground": "#0066bf",
  "editorHoverWidget.background": "#f8f8f8",
  "editorHoverWidget.border": "#c8c8c8",
  "focusBorder": "#005fb8",
  "input.background": "#ffffff",
  "input.border": "#cecece",
  "scrollbarSlider.background": "#64646466",
  "diffEditor.insertedTextBackground": "#9ccc2c40",
  "diffEditor.removedTextBackground": "#ff000033",
  "diffEditor.insertedLineBackground": "#9bb95533",
  "diffEditor.removedLineBackground": "#ff000026",
};
const theme = (base: ThemeRegistrationRaw, name: string, colors: Record<string, string>): ThemeRegistrationRaw => ({
  ...base,
  name,
  colors: { ...(base.colors ?? {}), ...colors },
});
export const themeName = () => (isDark() ? "querier-dark" : "querier-light");

let ready: Promise<typeof monaco> | null = null;

/** Monaco, with the grammars, themes and providers in place: once, on first use. */
export function loadMonaco(): Promise<typeof monaco> {
  ready ??= (async () => {
    const [svelte, python, markdown] = await Promise.all([import("@shikijs/langs/svelte"), import("@shikijs/langs/python"), import("@shikijs/langs/markdown")]);
    const highlighter = await createHighlighterCore({
      themes: [theme(darkPlus as ThemeRegistrationRaw, "querier-dark", MODERN_DARK), theme(lightPlus as ThemeRegistrationRaw, "querier-light", MODERN_LIGHT)],
      langs: [basaltGrammar as any, cedarGrammar as any, python.default, markdown.default, svelte.default],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
    for (const id of [...Object.values(LANG_ID), "cedar"]) monaco.languages.register({ id });
    configureLanguages();
    registerProviders();
    shikiToMonaco(highlighter, monaco);
    monaco.editor.setTheme(themeName());
    // the page's theme changes: so do the editors'
    const follow = () => monaco.editor.setTheme(themeName());
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", follow);
    new MutationObserver(follow).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return monaco;
  })();
  return ready;
}

// -- brackets, comments, indentation (what Monaco's own languages would say)
function configureLanguages() {
  const brackets: [string, string][] = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ];
  const pairs = [
    { open: "(", close: ")" },
    { open: "[", close: "]" },
    { open: "{", close: "}" },
    { open: "'", close: "'", notIn: ["string", "comment"] },
    { open: '"', close: '"', notIn: ["string", "comment"] },
  ];
  monaco.languages.setLanguageConfiguration("basalt", {
    comments: { lineComment: "--", blockComment: ["/*", "*/"] },
    brackets,
    autoClosingPairs: pairs,
    surroundingPairs: pairs,
    wordPattern: /(-?\d*\.\d\w*)|(\$?[A-Za-z_][\w]*)/g,
  });
  monaco.languages.setLanguageConfiguration("python", {
    comments: { lineComment: "#", blockComment: ['"""', '"""'] },
    brackets,
    autoClosingPairs: pairs,
    surroundingPairs: pairs,
    indentationRules: { increaseIndentPattern: /^\s*(?:def|class|for|if|elif|else|while|try|with|finally|except|async).*?:\s*(?:#.*)?$/, decreaseIndentPattern: /^\s*(?:elif|else|except|finally)\b.*:/ },
    onEnterRules: [{ beforeText: /:\s*(?:#.*)?$/, action: { indentAction: monaco.languages.IndentAction.Indent } }],
  });
  monaco.languages.setLanguageConfiguration("markdown", {
    brackets: [
      ["(", ")"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: "`", close: "`" },
    ],
  });
  monaco.languages.setLanguageConfiguration("cedar", {
    comments: { lineComment: "//" },
    brackets,
    autoClosingPairs: pairs.filter((p) => p.open !== "'"),
    surroundingPairs: pairs.filter((p) => p.open !== "'"),
    wordPattern: /(-?\d*\.\d\w*)|([A-Za-z_]\w*)/g,
  });
  monaco.languages.setLanguageConfiguration("svelte", {
    comments: { blockComment: ["<!--", "-->"] },
    brackets: [...brackets, ["<", ">"]],
    autoClosingPairs: [...pairs, { open: "`", close: "`", notIn: ["string", "comment"] }, { open: "<!--", close: "-->" }],
    surroundingPairs: [...pairs, { open: "<", close: ">" }],
    wordPattern: /(-?\d*\.\d\w*)|(\$?[\w-]+)/g,
  });
}

// -- what each editor asks the notebook for, by its model

export interface EditorHooks {
  lang: EditorLang | "cedar";
  /** the kernel's completions (cells) */
  complete?: (lang: EditorLang, source: string, pos: number) => Promise<Completion>;
  /** what hovering a name shows */
  hover?: (lang: EditorLang, word: string) => HoverInfo | null;
  /** a report template's completions */
  template?: (doc: string, pos: number) => TemplateResult;
  /** a Cedar condition's: what people and resources are tagged with */
  cedar?: () => CedarVocabulary;
}
const hooks = new Map<string, EditorHooks>();

/** Route the providers' questions about `model` to `h`; returns the undo. */
export function attachHooks(model: monaco.editor.ITextModel, h: EditorHooks): () => void {
  const key = model.uri.toString();
  hooks.set(key, h);
  return () => hooks.delete(key);
}

const KIND: Record<Suggestion["kind"], monaco.languages.CompletionItemKind> = {
  keyword: monaco.languages.CompletionItemKind.Keyword,
  function: monaco.languages.CompletionItemKind.Function,
  method: monaco.languages.CompletionItemKind.Method,
  variable: monaco.languages.CompletionItemKind.Variable,
  property: monaco.languages.CompletionItemKind.Field,
  class: monaco.languages.CompletionItemKind.Class,
  namespace: monaco.languages.CompletionItemKind.Module,
  constant: monaco.languages.CompletionItemKind.Constant,
  text: monaco.languages.CompletionItemKind.Text,
  snippet: monaco.languages.CompletionItemKind.Snippet,
};

function toItem(s: Suggestion, range: monaco.IRange): monaco.languages.CompletionItem {
  return {
    label: s.detail ? { label: s.label, description: s.detail } : s.label,
    kind: KIND[s.kind],
    detail: s.detail,
    documentation: s.doc ? { value: s.doc } : undefined,
    insertText: s.insert ?? s.label,
    insertTextRules: s.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    // higher boost first, then by name
    sortText: `${String(50 - (s.boost ?? 0)).padStart(3, "0")}${s.label}`,
    filterText: s.label,
    range,
  };
}

const rangeOf = (model: monaco.editor.ITextModel, from: number, to: number): monaco.IRange => {
  const a = model.getPositionAt(from);
  const b = model.getPositionAt(to);
  return { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column };
};

/** The word under `position`, with a leading `$` (a PARAM, a rune). */
function wordAt(model: monaco.editor.ITextModel, position: monaco.Position) {
  const line = model.getLineContent(position.lineNumber);
  const re = /\$?[A-Za-z_]\w*/g;
  for (const m of line.matchAll(re)) {
    const from = m.index! + 1;
    const to = from + m[0].length;
    if (position.column >= from && position.column <= to) return { word: m[0], from, to, after: line.slice(to - 1) };
  }
  return null;
}

function registerProviders() {
  // cells: the kernel's completions; basalt's functions too in SQL
  for (const lang of ["sql", "python"] as const) {
    monaco.languages.registerCompletionItemProvider(LANG_ID[lang], {
      triggerCharacters: ["."],
      async provideCompletionItems(model, position, _ctx, token) {
        const h = hooks.get(model.uri.toString());
        if (!h?.complete) return { suggestions: [] };
        const offset = model.getOffsetAt(position);
        const got = await h.complete(lang, model.getValue(), offset).catch(() => null);
        if (!got || token.isCancellationRequested) return { suggestions: [] };
        const items = got.items.map((i) => toSuggestion(i, lang));
        if (lang === "sql") {
          const typed = model.getValue().slice(got.start, offset).toLowerCase();
          const have = new Set(items.map((o) => o.label.toLowerCase()));
          for (const fn of FUNCTIONS) if (fn.name.startsWith(typed) && !have.has(fn.name)) items.push(toSuggestion({ text: fn.name, kind: "function" }, lang));
        }
        const range = rangeOf(model, got.start, Math.max(got.end, offset));
        return { suggestions: items.map((s) => toItem(s, range)) };
      },
    });
  }

  // report.svelte: the notebook's cells, columns, PARAMs and hooks; Svelte's blocks and runes
  monaco.languages.registerCompletionItemProvider("svelte", {
    triggerCharacters: ["<", "{", ".", "$", '"', "'", " ", "#", "@", ":", "/", "["],
    provideCompletionItems(model, position) {
      const h = hooks.get(model.uri.toString());
      const offset = model.getOffsetAt(position);
      const got = h?.template?.(model.getValue(), offset);
      if (!got) return { suggestions: [] };
      const range = rangeOf(model, got.from, offset);
      return { suggestions: got.items.map((s) => toItem(s, range)) };
    },
  });

  // Cedar (access conditions and policies): tags, their values, groups; what each word means
  monaco.languages.registerCompletionItemProvider("cedar", {
    triggerCharacters: [".", '"', " ", ":", "(", "["],
    provideCompletionItems(model, position) {
      const vocab = hooks.get(model.uri.toString())?.cedar?.();
      if (!vocab) return { suggestions: [] };
      const offset = model.getOffsetAt(position);
      const got = cedarComplete(model.getValue(), offset, vocab);
      if (!got) return { suggestions: [] };
      const range = rangeOf(model, got.from, offset);
      return { suggestions: got.items.map((s) => toItem(s, range)) };
    },
  });
  monaco.languages.registerHoverProvider("cedar", {
    provideHover(model, position) {
      const w = model.getWordAtPosition(position);
      const doc = w && cedarHover(w.word);
      return doc ? { range: { startLineNumber: position.lineNumber, startColumn: w.startColumn, endLineNumber: position.lineNumber, endColumn: w.endColumn }, contents: [{ value: doc }] } : null;
    },
  });

  // hovers: a basalt function where it is called, else what the notebook knows of the name
  for (const lang of ["sql", "python", "svelte"] as const) {
    monaco.languages.registerHoverProvider(LANG_ID[lang], {
      provideHover(model, position) {
        const w = wordAt(model, position);
        if (!w) return null;
        const range = { startLineNumber: position.lineNumber, startColumn: w.from, endLineNumber: position.lineNumber, endColumn: w.to };
        const fn = lang === "sql" && /^\s*\(/.test(w.after) ? fnDoc(w.word) : undefined;
        if (fn) return { range, contents: [{ value: fnMarkdown(fn) }] };
        const info = hooks.get(model.uri.toString())?.hover?.(lang, w.word);
        return info ? { range, contents: [{ value: infoMarkdown(info) }] } : null;
      },
    });
  }

  // parameter hints: the basalt function call the cursor is in
  monaco.languages.registerSignatureHelpProvider("basalt", {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [","],
    provideSignatureHelp(model, position) {
      const call = callAt(model.getValue(), model.getOffsetAt(position));
      if (!call || !call.fn.params.length) return null;
      const fn = call.fn;
      return {
        value: {
          signatures: [
            {
              label: `${fn.name}(${fn.params.join(", ")})${fn.returns ? ` → ${fn.returns}` : ""}`,
              documentation: { value: `${fn.doc}\n\n*${fn.kind} function*` },
              parameters: fn.params.map((p) => ({ label: p })),
            },
          ],
          activeSignature: 0,
          activeParameter: Math.min(call.arg, fn.params.length - 1),
        },
        dispose() {},
      };
    },
  });
}
