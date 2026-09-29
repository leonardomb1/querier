<script lang="ts">
  import {
    acceptCompletion,
    autocompletion,
    closeBrackets,
    closeBracketsKeymap,
    completionKeymap,
    completionStatus,
    startCompletion,
    type CompletionContext,
    type CompletionResult,
  } from "@codemirror/autocomplete";
  import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from "@codemirror/commands";
  import { html } from "@codemirror/lang-html";
  import { markdown } from "@codemirror/lang-markdown";
  import { python } from "@codemirror/lang-python";
  import { sql } from "@codemirror/lang-sql";
  import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
  import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
  import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
  import { Compartment, EditorState, Prec } from "@codemirror/state";
  import {
    crosshairCursor,
    drawSelection,
    dropCursor,
    EditorView,
    highlightActiveLine,
    highlightActiveLineGutter,
    hoverTooltip,
    keymap,
    lineNumbers,
    placeholder,
    rectangularSelection,
  } from "@codemirror/view";
  import { onMount } from "svelte";
  import type { Lang } from "../lib/api";
  import { basaltDialect, FUNCTIONS, fnDoc } from "../lib/basalt";
  import type { Completion } from "../lib/conn.svelte";
  import { fnCard, highlight, infoCard, parameterHints, theme, toOption, type HoverInfo } from "../lib/editor";
  import { gitGutter, inlineDiff, setOriginal } from "../lib/gitdiff";

  export interface Mark {
    line: number;
    col?: number;
    end_col?: number;
    message: string;
    severity?: "error" | "warning";
  }

  interface Props {
    value: string;
    /** a cell's language, or "svelte": a report template (HTML, with its script and style) */
    lang: Lang | "svelte";
    marks?: Mark[];
    autofocus?: boolean;
    onchange: (v: string) => void;
    onrun?: (advance: boolean) => void;
    onblur?: () => void;
    onfocus?: () => void;
    complete?: (lang: Lang | "svelte", source: string, pos: number) => Promise<Completion>;
    /** What hovering a name shows: a table's columns, a param's value. */
    hover?: (lang: Lang | "svelte", word: string) => HoverInfo | null;
    /** The cell at its last commit (git), for change marks; null when new or untracked. */
    original?: string | null;
    /** Show the inline diff against `original`. */
    showDiff?: boolean;
    /** Take the parent's height and scroll inside it (a file editor), instead of growing with the text. */
    fill?: boolean;
    /** Wrap long lines (a cell); off, lines scroll sideways (code keeps its shape). */
    wrap?: boolean;
    /** Ctrl+S / Cmd+S */
    onsave?: () => void;
    /** The cursor moved: its line and column, 1-based. */
    oncursor?: (line: number, col: number) => void;
    /** A report template's completions (lib/templatecomplete.ts), beside HTML's and JavaScript's own. */
    templateCompletion?: (ctx: CompletionContext) => CompletionResult | null;
  }
  let {
    value,
    lang,
    marks = [],
    autofocus = false,
    onchange,
    onrun,
    onblur,
    onfocus,
    complete,
    hover,
    original = null,
    showDiff = false,
    fill = false,
    wrap = true,
    onsave,
    oncursor,
    templateCompletion,
  }: Props = $props();

  const diffSlot = new Compartment();

  let host: HTMLDivElement;
  let view: EditorView;

  // svelte-ignore state_referenced_locally
  const language = {
    sql: () => sql({ dialect: basaltDialect }),
    python: () => python(),
    md: () => markdown(),
    svelte: () => html({ selfClosingTags: true }),
  }[lang];

  async function source(ctx: CompletionContext) {
    if (!complete) return null;
    const word = ctx.matchBefore(/[\w$.]+/);
    const inString = lang === "python" && ctx.matchBefore(/(?:col\(|\[)\s*["'][^"']*/);
    if (!ctx.explicit && !word && !inString) return null;
    const got = await complete(lang, ctx.state.doc.toString(), ctx.pos);
    if (ctx.aborted) return null;
    const options = got.items.map((i) => toOption(i, lang));
    if (lang === "sql") {
      // basalt's functions, with their docs, when the kernel did not offer them
      const typed = ctx.state.sliceDoc(got.start, ctx.pos).toLowerCase();
      const have = new Set(options.map((o) => o.label.toLowerCase()));
      for (const fn of FUNCTIONS) {
        if (fn.name.startsWith(typed) && !have.has(fn.name)) options.push(toOption({ text: fn.name, kind: "function" }, lang));
      }
    }
    if (!options.length) return null;
    return { from: got.start, to: got.end, options, validFor: /^[\w$]*$/ };
  }

  /** Tab completes: accept an open list, wait for one on its way, ask for one
   *  after a word; indent only at the start of a line or after whitespace. */
  function tab(v: EditorView): boolean {
    const status = completionStatus(v.state);
    if (status === "active") return acceptCompletion(v);
    if (status === "pending") return true;
    const sel = v.state.selection.main;
    if (lang === "md" || !sel.empty) return false;
    const before = v.state.sliceDoc(Math.max(0, sel.head - 1), sel.head);
    return /[\w$.]/.test(before) ? startCompletion(v) : false;
  }

  const hovering = hoverTooltip((v, pos) => {
    const range = v.state.wordAt(pos);
    if (!range) return null;
    let from = range.from;
    if (v.state.sliceDoc(from - 1, from) === "$") from--;
    const word = v.state.sliceDoc(from, range.to);
    const called = /^\s*\(/.test(v.state.sliceDoc(range.to, range.to + 8));
    const fn = lang === "sql" && called ? fnDoc(word) : undefined;
    const info = fn ? null : hover?.(lang, word);
    if (!fn && !info) return null;
    return { pos: from, end: range.to, above: true, create: () => ({ dom: fn ? fnCard(fn) : infoCard(info!) }) };
  });

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          Prec.highest(
            keymap.of([
              { key: "Shift-Enter", run: () => (onrun?.(true), true) },
              { key: "Mod-Enter", run: () => (onrun?.(false), true) },
              // an open completion list closes first; the next Esc leaves the editor
              { key: "Escape", run: (v) => completionStatus(v.state) == null && (v.contentDOM.blur(), true) },
              { key: "Mod-/", run: toggleComment },
            ]),
          ),
          Prec.high(keymap.of([{ key: "Tab", run: tab }])),
          lineNumbers(),
          gitGutter,
          diffSlot.of([]),
          highlightActiveLineGutter(),
          foldGutter({ openText: "⌄", closedText: "›" }),
          highlightActiveLine(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          rectangularSelection(),
          crosshairCursor(),
          indentOnInput(),
          indentUnit.of(lang === "python" ? "    " : "  "),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches({ wholeWords: true, minSelectionLength: 2 }),
          search({ top: true }),
          lang === "md"
            ? []
            : lang === "svelte"
              ? [
                  // no override: the HTML and JavaScript modes offer their own, and ours join them
                  autocompletion({ icons: true, maxRenderedOptions: 80 }),
                  templateCompletion ? EditorState.languageData.of(() => [{ autocomplete: templateCompletion }]) : [],
                  hovering,
                ]
              : [autocompletion({ override: [source], icons: true, maxRenderedOptions: 80 }), hovering],
          lang === "sql" ? parameterHints : [],
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
          language(),
          syntaxHighlighting(highlight),
          theme,
          wrap ? EditorView.lineWrapping : [],
          onsave ? Prec.high(keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (onsave(), true) }])) : [],
          placeholder(lang === "sql" ? "SELECT …" : lang === "python" ? "# python" : "Write in markdown"),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onchange(u.state.doc.toString());
            if (oncursor && (u.selectionSet || u.docChanged)) {
              const at = u.state.selection.main.head;
              const line = u.state.doc.lineAt(at);
              oncursor(line.number, at - line.from + 1);
            }
            if (u.focusChanged) (u.view.hasFocus ? onfocus : onblur)?.();
          }),
        ],
      }),
    });
    if (autofocus) {
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    }
    return () => view.destroy();
  });

  // Take outside changes (a reload, another tab, a rename) unless the user is typing here.
  $effect(() => {
    const v = value;
    if (view && !view.hasFocus && v !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
    }
  });

  // the last commit: change marks always, the inline diff when asked for
  $effect(() => {
    const base = original;
    const diff = showDiff && base != null;
    if (!view) return;
    view.dispatch({ effects: [setOriginal.of(base), diffSlot.reconfigure(diff ? inlineDiff(base!) : [])] });
  });

  $effect(() => {
    if (!view) return;
    const doc = view.state.doc;
    const diagnostics: Diagnostic[] = marks
      .filter((m) => m.line >= 1 && m.line <= doc.lines)
      .map((m) => {
        const line = doc.line(m.line);
        const from = m.col ? Math.min(line.from + m.col - 1, line.to) : line.from;
        let to = m.end_col ? Math.min(line.from + m.end_col - 1, line.to) : line.to;
        if (m.col && !m.end_col) to = from + (/^\w+/.exec(doc.sliceString(from, line.to))?.[0].length || 1);
        return { from, to: Math.max(to, Math.min(from + 1, line.to)), severity: m.severity ?? "error", message: m.message };
      });
    view.dispatch(setDiagnostics(view.state, diagnostics));
  });

  /** Put the cursor at a line (and column), 1-based, scrolled into the middle. */
  export function goto(line: number, col = 1) {
    if (!view) return;
    const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
    const pos = Math.min(l.from + Math.max(0, col - 1), l.to);
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    view.focus();
  }

  export function focus() {
    view?.focus();
  }

  /** Replace the selection with `text` and focus: what the sidebar inserts. */
  export function insert(text: string) {
    if (!view) return;
    view.dispatch(view.state.replaceSelection(text));
    view.focus();
  }
</script>

<div class="editor" class:fill bind:this={host}></div>

<style>
  .editor {
    background: var(--code-bg);
    min-height: 2.125rem;
  }
  .editor.fill {
    height: 100%;
  }
  .editor.fill :global(.cm-editor) {
    height: 100%;
  }
  .editor.fill :global(.cm-scroller) {
    overflow: auto;
  }
</style>
