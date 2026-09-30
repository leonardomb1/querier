<script lang="ts">
  import { nbUrl } from "../../lib/api";
  import type { NotebookCtl } from "../../lib/notebook.svelte";
  import type { TemplateCtl } from "../../lib/template.svelte";
  import type { Workbench } from "../../lib/workbench.svelte";
  import Icon from "../Icon.svelte";
  import Menu from "../Menu.svelte";
  import Outputs from "../Outputs.svelte";
  import TerminalView from "./TerminalView.svelte";

  // The panel under the editors: Results (the output of the cell you are on),
  // Problems (every cell's, and the template's) and Terminal (a shell in one's kernel).
  let { ctl, wb, tpl }: { ctl: NotebookCtl; wb: Workbench; tpl: TemplateCtl } = $props();

  // the terminal: for who may open one; once opened it lives on behind the other tabs
  const mayShell = $derived(ctl.may("notebook.shell") && !ctl.reportMode);
  let terminalOpened = $state(false);
  let terminal = $state<ReturnType<typeof TerminalView>>();
  $effect(() => {
    if (wb.panelTab === "terminal" && mayShell) terminalOpened = true;
  });
  const tab = $derived(wb.panelTab === "terminal" && !mayShell ? "results" : wb.panelTab);

  // the cell whose results show: the active editor's, else the notebook's selected cell
  const cell = $derived.by(() => {
    const t = wb.activeTab();
    if (t?.kind === "cell") return t.cell;
    return ctl.selected ?? null;
  });
  const run = $derived(cell ? ctl.conn.runs[cell] : undefined);
  const exportUrl = $derived(cell ? `${nbUrl(ctl.name)}/cells/${encodeURIComponent(cell)}/export` : "");

  const templateProblem = $derived(tpl.built?.error ?? (tpl.frameError ? { message: tpl.frameError } : null));
  const problems = $derived(ctl.problems);
  const errors = $derived(problems.filter((p) => p.severity !== "warning").length + (templateProblem ? 1 : 0));
  const warnings = $derived(problems.filter((p) => p.severity === "warning").length);
  const byCell = $derived.by(() => {
    const out = new Map<string, typeof problems>();
    for (const p of problems) out.set(p.cell, [...(out.get(p.cell) ?? []), p]);
    return [...out];
  });

  function go(c: string, line: number, col?: number) {
    wb.open({ kind: "cell", cell: c });
    wb.reveal = { cell: c, line, col };
  }
  const fileOf = (c: string) => ctl.cell(c)?.file ?? c;
  const status = $derived(run?.state === "running" ? "running…" : run?.state === "queued" ? "queued" : run?.ms != null ? `${run.ms} ms` : "");
</script>

<section class="panel" class:right={wb.panelPosition === "right"}>
  <div class="bar">
    <div class="tabs" role="tablist">
      <button role="tab" aria-selected={wb.panelTab === "results"} class:on={wb.panelTab === "results"} onclick={() => ((wb.panelTab = "results"), wb.save())}>Results</button>
      <button role="tab" aria-selected={wb.panelTab === "problems"} class:on={wb.panelTab === "problems"} onclick={() => ((wb.panelTab = "problems"), wb.save())}>
        Problems{#if errors + warnings}<span class="badge">{errors + warnings}</span>{/if}
      </button>
      {#if mayShell}
        <button role="tab" aria-selected={tab === "terminal"} class:on={tab === "terminal"} title="A shell in your kernel's sandbox  (Ctrl+`)" onclick={() => ((wb.panelTab = "terminal"), wb.save())}>Terminal</button>
      {/if}
    </div>
    {#if tab === "terminal"}<span class="context">sandbox</span>{/if}
    {#if tab === "results" && cell}<span class="context">{fileOf(cell)}{status ? ` · ${status}` : ""}</span>{/if}
    <span class="acts">
      {#if tab === "terminal" && terminal}
        <button class="icon" title="New Shell (ends this one)" aria-label="Start a new shell" onclick={() => terminal?.restart()}><Icon name="debug-restart" size={16} /></button>
      {/if}
      <Menu
        title="Views and more actions"
        items={[
          { label: "Panel Position: Bottom", hint: wb.panelPosition === "bottom" ? "✓" : "", run: () => wb.movePanel("bottom") },
          { label: "Panel Position: Right", hint: wb.panelPosition === "right" ? "✓" : "", run: () => wb.movePanel("right") },
        ]}
      />
      <button class="icon" title={wb.panelMax ? "Restore Panel Size" : "Maximize Panel Size"} aria-label={wb.panelMax ? "Restore the panel's size" : "Maximize the panel"} onclick={() => wb.toggleMaxPanel()}>
        <Icon name={wb.panelMax ? (wb.panelPosition === "right" ? "chevron-right" : "chevron-down") : wb.panelPosition === "right" ? "chevron-left" : "chevron-up"} size={16} />
      </button>
      <button class="icon" title="Close the panel  (Ctrl+J)" aria-label="Close the panel" onclick={() => wb.togglePanel()}><Icon name="close" size={16} /></button>
    </span>
  </div>

  <div class="body" class:term={tab === "terminal"}>
    {#if terminalOpened}<TerminalView bind:this={terminal} {ctl} visible={tab === "terminal"} />{/if}
    {#if tab === "terminal"}
      <!-- the terminal, above -->
    {:else if tab === "results"}
      {#if !cell}
        <p class="empty">Open a cell, or select one in the notebook, to see its results here.</p>
      {:else if run?.outputs.length}
        <div class="results">
          <Outputs {run} {cell} {exportUrl} onsearch={(terms) => ctl.conn.filter(cell, terms)} onstop={() => ctl.interrupt()} />
        </div>
      {:else}
        <p class="empty">{run?.state === "running" || run?.state === "queued" ? "Running…" : `${cell} hasn't run. Ctrl+Enter runs it.`}</p>
      {/if}
    {:else}
      {#if !errors && !warnings}
        <p class="empty">No problems have been detected in the notebook.</p>
      {/if}
      {#if templateProblem}
        <div class="file"><Icon name="file-code" size={16} /><span>report.svelte</span></div>
        <button class="problem" onclick={() => wb.open({ kind: "template" })}>
          <span class="sev err"><Icon name="error" size={16} /></span>
          <span class="msg">{templateProblem.message}</span>
          {#if "line" in templateProblem && templateProblem.line}<span class="where">[Ln {templateProblem.line}{templateProblem.col ? `, Col ${templateProblem.col}` : ""}]</span>{/if}
        </button>
      {/if}
      {#each byCell as [c, list] (c)}
        <div class="file"><span>{fileOf(c)}</span><span class="count">{list.length}</span></div>
        {#each list as p, i (i)}
          <button class="problem" onclick={() => go(c, p.line, p.col)}>
            <span class="sev" class:err={p.severity !== "warning"} class:warn={p.severity === "warning"}><Icon name={p.severity === "warning" ? "warning" : "error"} size={16} /></span>
            <span class="msg">{p.message}</span>
            <span class="where">[Ln {p.line}{p.col ? `, Col ${p.col}` : ""}]</span>
          </button>
        {/each}
      {/each}
    {/if}
  </div>
</section>

<style>
  /* the terminal fills the panel, and scrolls itself */
  .body.term {
    overflow: hidden;
    padding: 0;
  }
  .panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--wb-side);
    border-top: 1px solid var(--wb-border);
    font-size: 0.8125rem;
  }
  .panel.right {
    border-top: 0;
    border-left: 1px solid var(--wb-border);
  }
  .acts {
    display: flex;
    align-items: center;
    gap: 1px;
    margin-left: auto;
  }
  .acts :global(button.icon) {
    width: 1.625rem;
    height: 1.625rem;
    color: var(--wb-fg);
    border-radius: 5px;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 1rem;
    height: 2.1875rem;
    padding: 0 0.5rem 0 0.75rem;
    flex: none;
  }
  .tabs {
    display: flex;
    gap: 0.25rem;
    height: 100%;
  }
  .tabs button {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    height: 100%;
    padding: 0 0.5rem;
    border-radius: 0;
    font-size: 0.6875rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--wb-fg-muted);
  }
  .tabs button:hover {
    background: none;
    color: var(--wb-fg);
  }
  .tabs button.on {
    color: var(--wb-fg);
  }
  .tabs button.on::after {
    content: "";
    position: absolute;
    left: 0.5rem;
    right: 0.5rem;
    bottom: 0.25rem;
    height: 1px;
    background: var(--wb-fg);
  }
  .badge {
    min-width: 1.125rem;
    padding: 0 0.3rem;
    border-radius: 999px;
    font-size: 0.68rem;
    letter-spacing: 0;
    text-align: center;
    color: #fff;
    background: var(--wb-badge);
  }
  .context {
    font-size: 0.75rem;
    color: var(--wb-fg-muted);
    font-family: var(--mono);
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0 0.75rem 0.75rem;
  }
  .results {
    background: var(--wb-editor);
  }
  .empty {
    margin: 0.25rem 0.5rem;
    color: var(--wb-fg-muted);
  }
  .file {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    height: 1.375rem;
    margin-top: 0.125rem;
    color: var(--wb-fg);
  }
  .file .count {
    min-width: 1.125rem;
    padding: 0 0.3rem;
    border-radius: 999px;
    font-size: 0.68rem;
    text-align: center;
    background: var(--wb-list-active);
  }
  .problem {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    width: 100%;
    min-height: 1.375rem;
    padding: 0 0.5rem 0 1.25rem;
    border-radius: 0;
    text-align: left;
    color: var(--wb-fg);
  }
  .problem:hover {
    background: var(--wb-list-hover);
  }
  .sev {
    display: flex;
    flex: none;
  }
  .sev.err {
    color: #f14c4c;
  }
  .sev.warn {
    color: #cca700;
  }
  .msg {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .where {
    flex: none;
    color: var(--wb-fg-muted);
  }
</style>
