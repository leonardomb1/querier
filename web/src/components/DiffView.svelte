<script lang="ts">
  import { markdown } from "@codemirror/lang-markdown";
  import { python } from "@codemirror/lang-python";
  import { sql } from "@codemirror/lang-sql";
  import { syntaxHighlighting } from "@codemirror/language";
  import { MergeView } from "@codemirror/merge";
  import { EditorState } from "@codemirror/state";
  import { EditorView, lineNumbers } from "@codemirror/view";
  import { onMount } from "svelte";
  import type { Lang } from "../lib/api";
  import { basaltDialect } from "../lib/basalt";
  import { highlight, theme } from "../lib/editor";

  // A read-only side-by-side diff of one cell: before on the left, after on the right.
  let { before, after, lang }: { before: string; after: string; lang: Lang } = $props();
  let host: HTMLDivElement;

  onMount(() => {
    const language = { sql: () => sql({ dialect: basaltDialect }), python: () => python(), md: () => markdown() }[lang];
    const base = [
      lineNumbers(),
      language(),
      syntaxHighlighting(highlight),
      theme,
      EditorView.lineWrapping,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.theme({
        ".cm-changedLine": { background: "var(--git-added-bg)" },
        ".cm-changedText": { background: "var(--git-added-text)" },
        ".cm-deletedChunk, .cm-merge-a .cm-changedLine": { background: "var(--git-deleted-bg)" },
        ".cm-merge-a .cm-changedText": { background: "var(--git-deleted-text)" },
        ".cm-collapsedLines": { background: "var(--surface-2)", color: "var(--muted)", fontFamily: "var(--sans)" },
      }),
    ];
    const view = new MergeView({
      a: { doc: before, extensions: base },
      b: { doc: after, extensions: base },
      parent: host,
      gutter: true,
      highlightChanges: true,
      collapseUnchanged: { margin: 3, minSize: 4 },
    });
    return () => view.destroy();
  });
</script>

<div class="diff" bind:this={host}></div>

<style>
  .diff {
    border: 1px solid var(--hair);
    border-radius: 6px;
    overflow: hidden;
    background: var(--code-bg);
  }
  .diff :global(.cm-mergeView) {
    max-height: 26rem;
    overflow: auto;
  }
  .diff :global(.cm-merge-a) {
    border-right: 1px solid var(--hair);
  }
</style>
