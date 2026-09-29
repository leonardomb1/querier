<script lang="ts">
  import type { NotebookCtl } from "../../lib/notebook.svelte";
  import type { Workbench } from "../../lib/workbench.svelte";
  import Editor from "../Editor.svelte";

  // Code mode: one cell as a file, the whole editor. Its results show in the panel below.
  let { ctl, wb, cell, focused }: { ctl: NotebookCtl; wb: Workbench; cell: string; focused: boolean } = $props();

  const spec = $derived(ctl.cell(cell));
  const source = $derived(ctl.sources[cell] ?? spec?.source ?? "");
  const busy = $derived(["running", "queued"].includes(ctl.conn.runs[cell]?.state ?? ""));
  const LANG = { sql: "SQL", python: "Python", md: "Markdown" } as const;
  let editor = $state<ReturnType<typeof Editor>>();

  function run(withDeps = true) {
    ctl.run([cell], { withDeps });
    if (spec?.lang !== "md" && (!wb.panel || wb.panelTab !== "results")) wb.togglePanel("results");
  }

  $effect(() => {
    wb.actions[`cell:${cell}`] = spec?.lang === "md"
      ? [{ icon: "notebook", title: "Show in the notebook", run: () => showInNotebook() }]
      : [
          busy
            ? { icon: "debug-stop", title: "Stop", run: () => ctl.interrupt() }
            : { icon: "play", title: "Run, after what it needs  (Ctrl+Enter)", run: () => run() },
          { icon: "run-below", title: "Run just this cell", run: () => run(false), disabled: busy },
          { icon: "notebook", title: "Show in the notebook", run: () => showInNotebook() },
        ];
  });
  $effect(() => () => delete wb.actions[`cell:${cell}`]);

  function showInNotebook() {
    wb.open({ kind: "notebook" });
    ctl.select(cell);
    requestAnimationFrame(() => document.getElementById(`cell-${cell}`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  }

  // a line to show, from search or problems
  $effect(() => {
    const r = wb.reveal;
    if (r?.cell === cell && editor) {
      wb.reveal = null;
      requestAnimationFrame(() => editor?.goto(r.line, r.col));
    }
  });
  $effect(() => {
    if (focused && spec) wb.cursor = { line: 1, col: 1, lang: LANG[spec.lang] };
  });
</script>

{#if spec}
  {#key cell}
    <Editor
      bind:this={editor}
      value={source}
      lang={spec.lang}
      marks={ctl.marksFor(cell)}
      onchange={(s) => ctl.edit(cell, s)}
      onrun={() => run()}
      onfocus={() => {
        ctl.selected = cell;
        ctl.lastEditor = cell;
      }}
      oncursor={(line, col) => (wb.cursor = { line, col, lang: LANG[spec.lang] })}
      complete={(lang, src, pos) => ctl.conn.complete(lang, src, pos)}
      hover={(_, word) => ctl.hoverInfo(word)}
      fill
      wrap={spec.lang === "md"}
    />
  {/key}
{:else}
  <p class="gone">There's no cell <code>{cell}</code> any more.</p>
{/if}

<style>
  .gone {
    padding: 1rem 1.5rem;
    color: var(--wb-fg-muted);
  }
</style>
