<script lang="ts">
  import type { Lang } from "../../lib/api";
  import type { NotebookCtl } from "../../lib/notebook.svelte";
  import { tabKey, type Tab, type Workbench } from "../../lib/workbench.svelte";
  import Icon from "../Icon.svelte";
  import Menu from "../Menu.svelte";
  import TemplateExplorer from "../TemplateExplorer.svelte";

  // The notebook's folder as files: its cells, the report and its template, what
  // cells wrote to output/. A click opens a file as a tab; the notebook opens all.
  let { ctl, wb }: { ctl: NotebookCtl; wb: Workbench } = $props();

  let open = $state({ files: true, output: false, template: true });
  const cells = $derived(ctl.book?.cells ?? []);
  const outputs = $derived((ctl.book?.files ?? []).filter((f) => f.startsWith("output/")).map((f) => f.slice(7)));
  const activeKey = $derived.by(() => {
    const t = wb.activeTab();
    return t ? tabKey(t) : "";
  });
  const templateOpen = $derived(activeKey === "template");

  const LANG_ICON: Record<Lang, [string, string]> = {
    sql: ["database", "var(--wb-lang-sql)"],
    python: ["symbol-method", "var(--wb-lang-py)"],
    md: ["markdown", "var(--wb-fg-muted)"],
  };
  const openTab = (t: Tab) => wb.open(t);
  // a row dragged into the editor area opens there: in a group, or beside one
  const drag = (t: Tab) => ({
    draggable: true,
    ondragstart: (e: DragEvent) => {
      wb.drag = { tab: t, from: null, index: -1 };
      e.dataTransfer!.setData("application/x-querier-tab", tabKey(t));
      e.dataTransfer!.effectAllowed = "copyMove";
    },
    ondragend: () => (wb.drag = null),
  });
  const running = (c: string) => ["running", "queued"].includes(ctl.conn.runs[c]?.state ?? "");

  async function add(lang: Lang) {
    const after = ctl.selected ?? ctl.order.at(-1) ?? null;
    await ctl.add(lang, after);
    // the new cell is the selected one
    if (ctl.selected) wb.open({ kind: "cell", cell: ctl.selected });
  }
</script>

<div class="view">
  <header class="title">
    <span>Explorer</span>
    {#if ctl.mayEdit}
      <span class="tools">
        <Menu
          icon="new-file"
          title="New cell"
          items={[
            { label: "New SQL cell", run: () => add("sql") },
            { label: "New Python cell", run: () => add("python") },
            { label: "New Markdown cell", run: () => add("md") },
          ]}
        />
      </span>
    {/if}
  </header>

  <button class="section" onclick={() => (open.files = !open.files)} aria-expanded={open.files}>
    <span class="twist" class:open={open.files}><Icon name="chevron-right" size={16} /></span>
    {ctl.book?.title ?? ctl.name}
  </button>
  {#if open.files}
    <div class="tree" role="tree">
      <button class="row" {...drag({ kind: "notebook" })} class:active={activeKey === "notebook"} onclick={() => openTab({ kind: "notebook" })} role="treeitem" aria-selected={activeKey === "notebook"}>
        <span class="ic" style:color="var(--wb-accent)"><Icon name="notebook" size={16} /></span>
        <span class="name">Notebook</span><span class="hint">all cells</span>
      </button>
      <button class="row" {...drag({ kind: "report" })} class:active={activeKey === "report"} onclick={() => openTab({ kind: "report" })} role="treeitem" aria-selected={activeKey === "report"}>
        <span class="ic" style:color="var(--wb-accent)"><Icon name="preview" size={16} /></span>
        <span class="name">Report</span>
      </button>
      {#if ctl.book?.template != null}
        <button class="row" {...drag({ kind: "template" })} class:active={activeKey === "template"} onclick={() => openTab({ kind: "template" })} role="treeitem" aria-selected={activeKey === "template"}>
          <span class="ic" style:color="var(--wb-lang-svelte)"><Icon name="file-code" size={16} /></span>
          <span class="name">report.svelte</span>
        </button>
      {/if}
      <div class="sep"></div>
      {#each cells as c (c.name)}
        {@const [icon, color] = LANG_ICON[c.lang]}
        {@const key = `cell:${c.name}`}
        {@const problems = ctl.marksFor(c.name).filter((m) => m.severity !== "warning").length}
        <div class="row cell" class:active={activeKey === key} role="treeitem" aria-selected={activeKey === key}>
          <button class="open" {...drag({ kind: "cell", cell: c.name })} onclick={() => openTab({ kind: "cell", cell: c.name })} title="{c.file} — open">
            <span class="ic" style:color={color}><Icon name={icon} size={16} /></span>
            <span class="name" class:bad={problems > 0}>{c.file}</span>
            {#if ctl.fresh[c.name] === "stale" && c.lang !== "md"}<span class="stale" title="Outdated: its code or what it reads changed">●</span>{/if}
          </button>
          {#if c.lang !== "md" && ctl.mayRun}
            <button class="inline" title={running(c.name) ? "Running…" : `Run ${c.name}`} aria-label="Run {c.name}" onclick={() => ctl.run([c.name])}>
              <Icon name={running(c.name) ? "loading" : "play"} size={15} spin={running(c.name)} />
            </button>
          {/if}
        </div>
      {/each}
      {#if outputs.length}
        <button class="row" onclick={() => (open.output = !open.output)} aria-expanded={open.output}>
          <span class="ic"><Icon name={open.output ? "folder-opened" : "folder"} size={16} /></span>
          <span class="name">output</span><span class="hint">{outputs.length}</span>
        </button>
        {#if open.output}
          {#each outputs as f (f)}
            <div class="row nested" title="output/{f}: written by a cell">
              <span class="ic"><Icon name="file" size={16} /></span><span class="name">{f}</span>
            </div>
          {/each}
        {/if}
      {/if}
    </div>
  {/if}

  {#if templateOpen}
    <button class="section" onclick={() => (open.template = !open.template)} aria-expanded={open.template}>
      <span class="twist" class:open={open.template}><Icon name="chevron-right" size={16} /></span>
      Template
    </button>
    {#if open.template}
      <div class="template"><TemplateExplorer {ctl} oninsert={(t) => wb.inserter?.(t)} /></div>
    {/if}
  {/if}
</div>

<style>
  .view {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    overflow-y: auto;
    font-size: 0.8125rem;
  }
  .title {
    display: flex;
    align-items: center;
    height: 2.1875rem;
    padding: 0 0.5rem 0 1.25rem;
    font-size: 0.6875rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--wb-fg-muted);
    flex: none;
  }
  .tools {
    margin-left: auto;
    display: flex;
  }
  .section {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    width: 100%;
    height: 1.375rem;
    padding: 0 0.25rem;
    border-radius: 0;
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    color: var(--wb-fg);
    flex: none;
  }
  .section:hover {
    background: none;
  }
  .twist {
    display: flex;
    transition: transform 0.1s;
  }
  .twist.open {
    transform: rotate(90deg);
  }
  .tree {
    display: flex;
    flex-direction: column;
    padding-bottom: 0.5rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    width: 100%;
    height: 1.375rem;
    padding: 0 0.5rem 0 1.25rem;
    border-radius: 0;
    color: var(--wb-fg);
    text-align: left;
  }
  .row:hover {
    background: var(--wb-list-hover);
  }
  .row.active {
    background: var(--wb-list-active);
  }
  .row.cell {
    padding: 0;
  }
  .row .open {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0 0.25rem 0 1.25rem;
    border-radius: 0;
    color: inherit;
    text-align: left;
  }
  .row .open:hover {
    background: none;
  }
  .nested {
    padding-left: 2.5rem;
    color: var(--wb-fg-muted);
  }
  .ic {
    display: flex;
    flex: none;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name.bad {
    color: var(--critical);
  }
  .hint {
    margin-left: auto;
    font-size: 0.72rem;
    color: var(--wb-fg-dim);
  }
  .stale {
    margin-left: auto;
    font-size: 0.6rem;
    color: var(--stale);
  }
  .inline {
    display: grid;
    place-items: center;
    width: 1.375rem;
    height: 1.375rem;
    padding: 0;
    margin-right: 0.375rem;
    color: var(--wb-fg);
    visibility: hidden;
  }
  .row:hover .inline,
  .row.active .inline {
    visibility: visible;
  }
  .sep {
    height: 1px;
    margin: 0.25rem 0.75rem;
    background: var(--wb-border);
  }
  .template {
    min-height: 12rem;
  }
  .template :global(.explorer) {
    background: none;
    border: 0;
    padding-top: 0;
  }
</style>
