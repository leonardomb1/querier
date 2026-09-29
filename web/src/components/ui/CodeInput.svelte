<script lang="ts" module>
  /** Something wrong with the text, at offsets in it (none: the whole of it). */
  export interface Problem {
    message: string;
    help?: string;
    start?: number;
    end?: number;
    /** likely a mistake, not an error: underlined as a warning */
    warning?: boolean;
  }
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import type { CedarVocabulary } from "../../lib/cedarcomplete";
  import { zoom } from "../../lib/zoom.svelte";

  // A small code editor in a form, as VS Code's settings editor edits a value
  // that is code: Monaco without its chrome (no line numbers, no minimap), as
  // tall as its text (between `minLines` and `maxLines`), with the language's
  // colours, IntelliSense and problems underlined. Ctrl+Enter submits; Escape,
  // when no suggestion list is open, is `onescape`'s.

  let {
    value,
    lang = "cedar",
    onchange,
    onsubmit,
    onescape,
    placeholder = "",
    label,
    problems = [],
    vocabulary,
    minLines = 2,
    maxLines = 8,
    autofocus = false,
    fill = false,
    readOnly = false,
  }: {
    value: string;
    lang?: "cedar";
    onchange: (value: string) => void;
    onsubmit?: () => void;
    onescape?: () => void;
    placeholder?: string;
    label?: string;
    problems?: Problem[];
    /** Cedar: what people and resources are tagged with, for completions */
    vocabulary?: CedarVocabulary | null;
    minLines?: number;
    maxLines?: number;
    autofocus?: boolean;
    /** a whole editor (a modal one): its parent's size, line numbers, the minimap */
    fill?: boolean;
    /** shown, not edited (a preview) */
    readOnly?: boolean;
  } = $props();

  type Monaco = typeof import("monaco-editor/editor/editor.api");
  let host: HTMLDivElement;
  let M: Monaco | null = null;
  let editor: import("monaco-editor/editor/editor.api").editor.IStandaloneCodeEditor | null = null;
  let model: import("monaco-editor/editor/editor.api").editor.ITextModel | null = null;
  let focused = $state(false);
  let ready = $state(false);

  const mono = () => getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "monospace";
  const fontSize = () => Math.round(12.5 * zoom.value * 10) / 10;
  const lineHeight = () => Math.round(fontSize() * 1.55);
  const PAD = 6;

  onMount(() => {
    let dead = false;
    const subs: { dispose(): void }[] = [];
    let unhook = () => {};
    (async () => {
      const lib = await import("../../lib/monaco");
      M = await lib.loadMonaco();
      if (dead) return;
      model = M.editor.createModel(value, lang, M.Uri.parse(`inmemory://input/${Math.random().toString(36).slice(2)}.${lang}`));
      editor = M.editor.create(host, {
        model,
        theme: lib.themeName(),
        placeholder,
        ariaLabel: label,
        fontFamily: mono(),
        fontSize: fontSize(),
        lineHeight: lineHeight(),
        fontLigatures: false,
        readOnly,
        domReadOnly: readOnly,
        lineNumbers: fill ? "on" : "off",
        glyphMargin: false,
        folding: fill,
        lineDecorationsWidth: fill ? 12 : 8,
        lineNumbersMinChars: fill ? 4 : 0,
        minimap: { enabled: fill, renderCharacters: false, scale: 1 },
        overviewRulerLanes: fill ? 3 : 0,
        overviewRulerBorder: false,
        hideCursorInOverviewRuler: !fill,
        renderLineHighlight: fill ? "line" : "none",
        matchBrackets: readOnly ? "never" : "always",
        cursorStyle: "line",
        cursorWidth: readOnly ? 1 : 2,
        scrollBeyondLastLine: false,
        wordWrap: "on",
        wrappingIndent: "indent",
        padding: { top: PAD, bottom: PAD },
        scrollbar: fill
          ? { verticalScrollbarSize: 12, horizontal: "hidden", useShadows: false }
          : { vertical: "auto", horizontal: "hidden", verticalScrollbarSize: 8, useShadows: false, alwaysConsumeMouseWheel: false },
        // the suggestion list and hovers may leave the box (and the dialog it is in)
        fixedOverflowWidgets: true,
        quickSuggestions: { other: true, strings: true, comments: false },
        suggestOnTriggerCharacters: true,
        wordBasedSuggestions: "off",
        suggest: { showWords: false, preview: true },
        tabSize: 2,
        contextmenu: false,
        automaticLayout: true,
        guides: { indentation: false },
        stickyScroll: { enabled: false },
        occurrencesHighlight: "off",
        selectionHighlight: false,
      });
      unhook = lib.attachHooks(model, { lang, cedar: () => vocabulary ?? { tags: {}, groups: [], resourceTags: {} } });
      subs.push(model.onDidChangeContent(() => onchange(model!.getValue())));
      subs.push(editor.onDidFocusEditorText(() => (focused = true)));
      subs.push(editor.onDidBlurEditorText(() => (focused = false)));
      subs.push(editor.onDidContentSizeChange(fit));
      editor.addCommand(M.KeyMod.CtrlCmd | M.KeyCode.Enter, () => onsubmit?.());
      editor.addCommand(M.KeyCode.Escape, () => onescape?.(), "!suggestWidgetVisible && !parameterHintsVisible && !findWidgetVisible && !editorHasSelection");
      fit();
      ready = true;
      if (autofocus) editor.focus();
    })();
    return () => {
      dead = true;
      unhook();
      for (const s of subs) s.dispose();
      editor?.dispose();
      model?.dispose();
    };
  });

  /** As tall as the text, between the limits. */
  function fit() {
    if (!editor || fill) return;
    const lh = lineHeight();
    const h = Math.max(minLines * lh + 2 * PAD, Math.min(maxLines * lh + 2 * PAD, editor.getContentHeight()));
    host.style.height = `${h}px`;
    editor.layout();
  }

  // a value set from outside (cleared after adding): the editor follows
  $effect(() => {
    const v = value;
    if (model && v !== model.getValue()) model.setValue(v);
  });

  // problems: underlined where they are, their message on hover
  $effect(() => {
    const list = problems;
    if (!M || !model || !ready) return;
    const len = model.getValueLength();
    M.editor.setModelMarkers(
      model,
      "querier",
      list.map((p) => {
        const s = model!.getPositionAt(Math.min(p.start ?? 0, len));
        const e = model!.getPositionAt(Math.min(p.end != null && p.end > (p.start ?? 0) ? p.end : p.start != null ? p.start + 1 : len, len));
        return {
          severity: p.warning ? M!.MarkerSeverity.Warning : M!.MarkerSeverity.Error,
          message: p.help ? `${p.message}\n${p.help}` : p.message,
          startLineNumber: s.lineNumber,
          startColumn: s.column,
          endLineNumber: e.lineNumber,
          endColumn: e.column === s.column && e.lineNumber === s.lineNumber ? s.column + 1 : e.column,
        };
      }),
    );
  });

  // zoom and the code font
  $effect(() => {
    void zoom.value;
    if (!ready) return;
    editor?.updateOptions({ fontSize: fontSize(), lineHeight: lineHeight(), fontFamily: mono() });
    fit();
  });

  export const focus = () => editor?.focus();
</script>

<div class="code-input" class:focused class:fill class:readonly={readOnly} class:bad={problems.some((p) => !p.warning)}>
  <div class="host" bind:this={host} style:height={fill ? "100%" : `${minLines * 20 + 2 * PAD}px`}></div>
</div>

<style>
  .code-input {
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
    background: var(--wb-input);
    overflow: hidden;
    transition: border-color 0.12s;
  }
  .code-input.focused {
    border-color: var(--wb-accent);
  }
  .code-input.bad:not(.focused) {
    border-color: color-mix(in srgb, var(--critical) 70%, var(--wb-input-border));
  }
  .host {
    width: 100%;
  }
  /* a whole editor: no box, the editor's own colours */
  .code-input.fill {
    height: 100%;
    border: 0;
    border-radius: 0;
    background: none;
  }
  /* an input: the editor on the input's colour, not the editor's */
  .code-input:not(.fill) :global(.monaco-editor),
  .code-input:not(.fill) :global(.monaco-editor .margin),
  .code-input:not(.fill) :global(.monaco-editor-background) {
    background-color: var(--wb-input) !important;
  }
  .code-input.readonly :global(.cursors-layer) {
    display: none;
  }
</style>
