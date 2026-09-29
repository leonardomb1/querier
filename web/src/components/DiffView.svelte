<script lang="ts">
  import { onMount } from "svelte";
  import type { Lang } from "../lib/api";
  import { zoom } from "../lib/zoom.svelte";

  // A read-only side-by-side diff of one cell: before on the left, after on the
  // right, unchanged stretches folded away. Monaco's diff editor (lib/monaco.ts).
  let { before, after, lang }: { before: string; after: string; lang: Lang } = $props();
  let host: HTMLDivElement;
  let height = $state(160);

  onMount(() => {
    let dispose = () => {};
    let gone = false;
    (async () => {
      const lib = await import("../lib/monaco");
      const monaco = await lib.loadMonaco();
      if (gone) return;
      const a = monaco.editor.createModel(before, lib.LANG_ID[lang]);
      const b = monaco.editor.createModel(after, lib.LANG_ID[lang]);
      const size = Math.round(13 * zoom.value * 10) / 10;
      const diff = monaco.editor.createDiffEditor(host, {
        theme: lib.themeName(),
        readOnly: true,
        originalEditable: false,
        renderSideBySide: true,
        useInlineViewWhenSpaceIsLimited: true,
        hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 4 },
        renderOverviewRuler: false,
        scrollBeyondLastLine: false,
        minimap: { enabled: false },
        wordWrap: "on",
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim(),
        fontSize: size,
        lineHeight: Math.round(size * 1.6),
        lineNumbersMinChars: 3,
        padding: { top: 4, bottom: 4 },
        scrollbar: { alwaysConsumeMouseWheel: false, useShadows: false },
        automaticLayout: true,
      });
      diff.setModel({ original: a, modified: b });
      // as tall as the diff, up to a limit: the dialog scrolls beyond it
      const fit = () => (height = Math.min(416, Math.max(80, diff.getModifiedEditor().getContentHeight())));
      const sub = diff.getModifiedEditor().onDidContentSizeChange(fit);
      diff.onDidUpdateDiff(fit);
      dispose = () => {
        sub.dispose();
        diff.dispose();
        a.dispose();
        b.dispose();
      };
    })();
    return () => {
      gone = true;
      dispose();
    };
  });
</script>

<div class="diff" bind:this={host} style:height="{height}px"></div>

<style>
  .diff {
    border: 1px solid var(--hair);
    border-radius: 6px;
    overflow: hidden;
    background: var(--code-bg);
  }
</style>
