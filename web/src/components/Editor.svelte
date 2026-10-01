<script lang="ts" module>
  export interface Mark {
    line: number;
    col?: number;
    end_col?: number;
    message: string;
    severity?: "error" | "warning";
  }
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import type { Lang } from "../lib/api";
  import type { Collab } from "../lib/collab.svelte";
  import type { Completion } from "../lib/conn.svelte";
  import type { HoverInfo } from "../lib/editor";
  import { fonts } from "../lib/fonts.svelte";
  import { lineChanges } from "../lib/linediff";
  import type { TemplateResult } from "../lib/templatecomplete";
  import { zoom } from "../lib/zoom.svelte";

  // A code editor: Monaco, VS Code's own (lib/monaco.ts), loaded on first use.
  // For a cell it grows with its text inside the page; as a file editor (`fill`)
  // it takes its parent's height and scrolls. Beside the lines, marks of what
  // changed since the last commit; on demand, the inline diff against it.

  interface Props {
    value: string;
    /** a cell's language, or "svelte": a report template */
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
    /** A report template's completions (lib/templatecomplete.ts). */
    templateCompletion?: (doc: string, pos: number) => TemplateResult;
    /** They may read it, not change it. */
    readOnly?: boolean;
    /** Edited together (lib/collab.svelte.ts): the cell's shared text. Edits go into it, not `onchange`. */
    shared?: { text: import("yjs").Text; collab: Collab; cell: string };
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
    readOnly = false,
    shared,
  }: Props = $props();

  type Monaco = typeof import("monaco-editor/editor/editor.api");
  type Code = import("monaco-editor/editor/editor.api").editor.IStandaloneCodeEditor;

  let host: HTMLDivElement;
  let mounted = $state(false);
  let M: Monaco | null = null;
  let lib: typeof import("../lib/monaco") | null = null;
  let model: import("monaco-editor/editor/editor.api").editor.ITextModel | null = null;
  let base: import("monaco-editor/editor/editor.api").editor.ITextModel | null = null;
  /** the editor typed into: the plain one, or the diff's changed side */
  let editor: Code | null = null;
  let diff: import("monaco-editor/editor/editor.api").editor.IStandaloneDiffEditor | null = null;
  let plain: import("monaco-editor/editor/editor.api").editor.IStandaloneCodeEditor | null = null;
  const subs: { dispose(): void }[] = [];
  const modelSubs: { dispose(): void }[] = [];
  let gitMarks: import("monaco-editor/editor/editor.api").editor.IEditorDecorationsCollection | null = null;
  let destroyed = false;
  /** the binding to the shared text, while edited together */
  let bound: { paint(): void; dispose(): void } | null = null;
  let boundTo: unknown = null;
  let cobind: typeof import("../lib/cobind") | null = null;

  /** Bind to the shared text (or let go of it): after the editor is built, and when it arrives. */
  function rebind() {
    bound?.dispose();
    bound = null;
    boundTo = null;
    if (!shared || !editor || !model || !M || !cobind) return;
    bound = cobind.bindShared(M, editor, model, shared.text, shared.collab, shared.cell);
    boundTo = shared.text;
  }

  const mono = () => getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "monospace";
  const fontSize = () => Math.round(13 * zoom.value * 10) / 10;
  // svelte-ignore state_referenced_locally
  const PLACEHOLDER = { sql: "SELECT …", python: "# python", md: "Write in markdown", svelte: "" }[lang];

  function options() {
    const cell = !fill;
    return {
      theme: lib!.themeName(),
      readOnly,
      readOnlyMessage: { value: "You may view this notebook, not change it." },
      fontFamily: mono(),
      fontSize: fontSize(),
      lineHeight: Math.round(fontSize() * 1.6),
      fontLigatures: false,
      minimap: { enabled: fill && lang === "svelte" },
      scrollBeyondLastLine: false,
      wordWrap: wrap ? ("on" as const) : ("off" as const),
      lineNumbers: lang === "md" ? ("off" as const) : ("on" as const),
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 10,
      glyphMargin: false,
      folding: lang !== "md",
      showFoldingControls: "mouseover" as const,
      renderLineHighlight: "line" as const,
      renderLineHighlightOnlyWhenFocus: cell,
      overviewRulerLanes: cell ? 0 : 2,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: cell,
      // a cell grows with its text: the page scrolls, not the cell
      scrollbar: cell
        ? { vertical: "hidden" as const, horizontal: wrap ? ("hidden" as const) : ("auto" as const), alwaysConsumeMouseWheel: false, useShadows: false }
        : { useShadows: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      padding: { top: 6, bottom: 6 },
      // suggestions and hovers are not cut off by the cell around the editor
      fixedOverflowWidgets: true,
      placeholder: PLACEHOLDER,
      tabSize: lang === "python" ? 4 : 2,
      insertSpaces: true,
      detectIndentation: false,
      quickSuggestions: lang === "md" ? false : { other: true, comments: false, strings: lang !== "sql" },
      suggestOnTriggerCharacters: lang !== "md",
      wordBasedSuggestions: "off" as const,
      suggest: { showIcons: true, preview: false, showStatusBar: false },
      parameterHints: { enabled: lang === "sql" },
      bracketPairColorization: { enabled: lang !== "md" },
      guides: { indentation: fill, bracketPairs: false },
      stickyScroll: { enabled: false },
      smoothScrolling: true,
      cursorSmoothCaretAnimation: "on" as const,
      automaticLayout: false,
    };
  }

  /** The editor's height: its content's, for a cell; its parent's, as a file. */
  function layout() {
    const e = diff ?? plain;
    if (!e || !editor) return;
    if (fill) e.layout({ width: host.clientWidth, height: host.clientHeight });
    else {
      const h = Math.max(34, editor.getContentHeight());
      host.style.height = `${h}px`;
      e.layout({ width: host.clientWidth, height: h });
    }
  }

  function wire(e: Code) {
    const monaco = M!;
    editor = e;
    subs.push(
      e.onDidContentSizeChange((ev) => ev.contentHeightChanged && !fill && layout()),
      e.onDidChangeCursorPosition((ev) => oncursor?.(ev.position.lineNumber, ev.position.column)),
      e.onDidFocusEditorWidget(() => onfocus?.()),
      e.onDidBlurEditorWidget(() => onblur?.()),
    );
    const K = monaco.KeyCode;
    const Mod = monaco.KeyMod;
    // the notebook's keys, unless a widget of the editor's own is open
    const free = "!suggestWidgetVisible && !parameterHintsVisible && !inSnippetMode";
    if (onrun) {
      e.addAction({ id: "querier.run.next", label: "Run the Cell and Go to the Next", keybindings: [Mod.Shift | K.Enter], precondition: free, run: () => onrun(true) });
      e.addAction({ id: "querier.run", label: "Run the Cell", keybindings: [Mod.CtrlCmd | K.Enter], precondition: free, run: () => onrun(false) });
    }
    if (onsave) e.addAction({ id: "querier.save", label: "Save", keybindings: [Mod.CtrlCmd | K.KeyS], run: () => onsave() });
    // Escape leaves the editor (a cell's command mode), once its own widgets are closed
    e.addAction({
      id: "querier.leave",
      label: "Leave the Editor",
      keybindings: [K.Escape],
      precondition: `${free} && !findWidgetVisible && !editorHasMultipleSelections && !markersNavigationVisible`,
      run: () => (document.activeElement as HTMLElement | null)?.blur(),
    });
  }

  /** The plain editor, or the inline diff against the last commit. */
  function build(withDiff: boolean) {
    const monaco = M!;
    bound?.dispose();
    bound = null;
    for (const s of subs.splice(0)) s.dispose();
    const hadFocus = editor?.hasTextFocus() ?? false;
    const at = editor?.getPosition();
    plain?.dispose();
    diff?.dispose();
    plain = diff = null;
    gitMarks = null;
    if (withDiff && original != null) {
      base ??= monaco.editor.createModel(original, lib!.LANG_ID[lang]);
      base.setValue(original);
      diff = monaco.editor.createDiffEditor(host, {
        ...options(),
        renderSideBySide: false,
        useInlineViewWhenSpaceIsLimited: true,
        originalEditable: false,
        renderMarginRevertIcon: true,
        renderIndicators: true,
        renderOverviewRuler: false,
        ignoreTrimWhitespace: false,
      });
      diff.setModel({ original: base, modified: model! });
      wire(diff.getModifiedEditor());
    } else {
      plain = monaco.editor.create(host, { ...options(), model: model! });
      wire(plain);
      gitMarks = plain.createDecorationsCollection();
      paintGit();
    }
    layout();
    if (at) editor!.setPosition(at);
    if (hadFocus) editor!.focus();
    rebind();
  }

  // -- change marks beside the lines, against the last commit (VS Code's dirty diff)
  let gitTimer: ReturnType<typeof setTimeout>;
  function paintGit() {
    if (!gitMarks || !model || !M) return;
    if (original == null) return void gitMarks.clear();
    const c = lineChanges(original, model.getValue());
    const last = model.getLineCount();
    const deco = (line: number, cls: string) => ({ range: new M!.Range(line, 1, line, 1), options: { isWholeLine: true, linesDecorationsClassName: cls } });
    gitMarks.set([
      ...c.added.map((l) => deco(l, "q-git q-git-added")),
      ...c.modified.map((l) => deco(l, "q-git q-git-modified")),
      ...c.deleted.map((l) => deco(Math.min(l, last), l > last ? "q-git q-git-deleted-below" : "q-git q-git-deleted")),
    ]);
  }

  onMount(() => {
    let resize: ResizeObserver | undefined;
    (async () => {
      lib = await import("../lib/monaco");
      if (shared) cobind = await import("../lib/cobind");
      M = await lib.loadMonaco();
      if (destroyed) return;
      model = M.editor.createModel(value, lib.LANG_ID[lang]);
      // the model's own: its completion and hover (lib/monaco.ts) and its change listener. Apart from `subs`,
      // which go with the editor build() makes (again, for the inline diff): these last as long as the model
      modelSubs.push({ dispose: lib.attachHooks(model, { lang, complete, hover, template: templateCompletion }) });
      const modelSub = model.onDidChangeContent(() => {
        const v = model!.getValue();
        // shared: the text goes to the room (cobind.ts), which tells the notebook; never saved from here
        if (!shared && v !== value) onchange(v);
        clearTimeout(gitTimer);
        gitTimer = setTimeout(paintGit, 150);
      });
      host.replaceChildren();
      mounted = true;
      build(showDiff);
      resize = new ResizeObserver(() => layout());
      resize.observe(host);
      document.fonts?.ready.then(() => M?.editor.remeasureFonts());
      if (autofocus) {
        editor!.focus();
        const end = model.getFullModelRange().getEndPosition();
        editor!.setPosition(end);
      }
      modelSubs.push(modelSub);
    })();
    return () => {
      destroyed = true;
      bound?.dispose();
      resize?.disconnect();
      clearTimeout(gitTimer);
      for (const s of subs.splice(0)) s.dispose();
      plain?.dispose();
      diff?.dispose();
      // the model's go last, with it
      for (const s of modelSubs.splice(0)) s.dispose();
      model?.dispose();
      base?.dispose();
    };
  });

  // Take outside changes (a reload, another tab, a rename) unless the user is typing here;
  // edited together, the shared text brings them
  $effect(() => {
    const v = value;
    if (mounted && model && !bound && !shared && !editor?.hasTextFocus() && v !== model.getValue()) model.setValue(v);
  });

  // the shared text arrives (or goes), and the others move
  $effect(() => {
    const text = shared?.text;
    void shared?.collab.peers;
    if (!mounted) return;
    if (text !== boundTo) {
      if (text && !cobind) import("../lib/cobind").then((m) => ((cobind = m), rebind()));
      else rebind();
    } else bound?.paint();
  });

  // the last commit: change marks always, the inline diff when asked for
  let inDiff = false;
  $effect(() => {
    const want = showDiff && original != null;
    void original;
    if (!mounted) return;
    if (want !== inDiff) {
      inDiff = want;
      build(want);
    } else if (want && base && original != null && base.getValue() !== original) base.setValue(original);
    else paintGit();
  });

  // problems, as the editor's markers
  $effect(() => {
    const list = marks;
    if (!mounted || !model || !M) return;
    const lines = model.getLineCount();
    M.editor.setModelMarkers(
      model,
      "querier",
      list
        .filter((m) => m.line >= 1 && m.line <= lines)
        .map((m) => {
          const text = model!.getLineContent(m.line);
          const col = m.col ?? 1;
          const end = m.end_col ?? (m.col ? col + (/^\w+/.exec(text.slice(col - 1))?.[0].length || 1) : text.length + 1);
          return {
            severity: m.severity === "warning" ? M!.MarkerSeverity.Warning : M!.MarkerSeverity.Error,
            message: m.message,
            startLineNumber: m.line,
            startColumn: col,
            endLineNumber: m.line,
            endColumn: Math.max(end, col + 1),
          };
        }),
    );
  });

  // permissions can change under an open editor (a share given or taken)
  $effect(() => {
    const ro = readOnly;
    if (mounted) (diff ?? plain)?.updateOptions({ readOnly: ro });
  });

  // the code font and the zoom
  $effect(() => {
    void fonts.code;
    void zoom.value;
    if (!mounted || !editor) return;
    queueMicrotask(() => {
      (diff ?? plain)?.updateOptions({ fontFamily: mono(), fontSize: fontSize(), lineHeight: Math.round(fontSize() * 1.6) });
      document.fonts?.ready.then(() => M?.editor.remeasureFonts());
      layout();
    });
  });

  /** Put the cursor at a line (and column), 1-based, scrolled into the middle. */
  export function goto(line: number, col = 1) {
    if (!editor || !model) return;
    const l = Math.max(1, Math.min(line, model.getLineCount()));
    editor.setPosition({ lineNumber: l, column: Math.max(1, col) });
    editor.revealLineInCenter(l);
    editor.focus();
  }

  export function focus() {
    editor?.focus();
  }

  /** Replace the selection with `text` and focus: what the sidebar inserts. */
  export function insert(text: string) {
    if (!editor) return;
    const sel = editor.getSelection();
    if (sel) editor.executeEdits("insert", [{ range: sel, text, forceMoveMarkers: true }]);
    editor.focus();
  }
</script>

<div class="editor" class:fill bind:this={host}>
  {#if !mounted}<pre class="boot">{value || PLACEHOLDER}</pre>{/if}
</div>

<style>
  .editor {
    position: relative;
    background: var(--code-bg);
    min-height: 2.125rem;
  }
  .editor.fill {
    height: 100%;
  }
  /* until Monaco is here: the code as it will stand, so nothing jumps */
  .boot {
    margin: 0;
    padding: 6px 0.75rem 6px 3.4rem;
    font: 0.8125rem/1.6 var(--mono);
    color: var(--code-ink);
    white-space: pre-wrap;
    overflow: hidden;
  }
  /* the change marks beside the lines */
  .editor :global(.q-git) {
    margin-left: 3px;
    width: 3px !important;
  }
  .editor :global(.q-git-added) {
    background: var(--git-added);
  }
  .editor :global(.q-git-modified) {
    background: var(--git-modified);
  }
  .editor :global(.q-git-deleted),
  .editor :global(.q-git-deleted-below) {
    width: 0 !important;
    height: 0 !important;
    border-left: 5px solid var(--git-deleted);
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
  }
  .editor :global(.q-git-deleted) {
    transform: translateY(-4px);
  }
  .editor :global(.q-git-deleted-below) {
    transform: translateY(calc(1lh - 4px));
  }
</style>
