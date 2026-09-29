<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { Notebook } from "../../lib/api";
  import { NotebookCtl } from "../../lib/notebook.svelte";
  import { TemplateCtl } from "../../lib/template.svelte";
  import { Workbench } from "../../lib/workbench.svelte";
  import AiDialog from "../AiDialog.svelte";
  import CommitDialog from "../CommitDialog.svelte";
  import GitDialog from "../GitDialog.svelte";
  import Help from "../Help.svelte";
  import Icon from "../Icon.svelte";
  import GitGraph from "../GitGraph.svelte";
  import Palette from "../Palette.svelte";
  import SandboxDialog from "../SandboxDialog.svelte";
  import SecretsDialog from "../SecretsDialog.svelte";
  import Sidebar from "../Sidebar.svelte";
  import SourceControl from "../SourceControl.svelte";
  import ActivityBar from "./ActivityBar.svelte";
  import EditorGroup from "./EditorGroup.svelte";
  import ExplorerView from "./ExplorerView.svelte";
  import Panel from "./Panel.svelte";
  import SearchView from "./SearchView.svelte";
  import StatusBar from "./StatusBar.svelte";
  import TitleBar from "./TitleBar.svelte";

  // A notebook's workbench, VS Code's: activity bar, side bar, editors in tabs
  // (the notebook, each cell as a file, the report, report.svelte), a panel with
  // results and problems, a status bar.
  let { name, initial, open }: { name: string; initial?: Notebook; open?: "report" } = $props();

  // keyed by notebook (App.svelte): the props never change under us
  // svelte-ignore state_referenced_locally
  const ctl = new NotebookCtl(name, initial);
  const tpl = new TemplateCtl(ctl);
  // svelte-ignore state_referenced_locally
  const wb = new Workbench(name);
  onDestroy(() => ctl.close());
  onMount(() => {
    if (open === "report") wb.open({ kind: "report" });
    document.documentElement.classList.add("workbench");
    return () => document.documentElement.classList.remove("workbench");
  });

  $effect(() => tpl.sync(ctl.book?.template));
  // check every SQL cell once the page knows the notebook, and whenever what it defines or holds changes
  $effect(() => {
    void ctl.conn.tables;
    void ctl.conn.deps;
    if (ctl.conn.synced) ctl.checkAll();
  });
  // a cell that's gone closes its tab
  $effect(() => {
    if (ctl.book) wb.prune(new Set(ctl.book.cells.map((c) => c.name)));
  });

  let gitSettings = $state(false);
  let scmOpen = $state({ changes: true, history: true });

  // -- sashes: the side bar's width, the groups' split, the panel's height
  let dragging = $state<"side" | "split" | "panel" | null>(null);
  let editorsEl = $state<HTMLDivElement>();
  function drag(e: PointerEvent, what: "side" | "split" | "panel") {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = what;
    const box = editorsEl!.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      if (what === "side") wb.sideWidth = Math.min(600, Math.max(170, ev.clientX - 48));
      else if (what === "split") wb.split = Math.min(0.8, Math.max(0.2, (ev.clientX - box.left) / box.width));
      else wb.panelHeight = Math.min(box.bottom - box.top - 120, Math.max(90, box.bottom - ev.clientY));
    };
    const up = () => {
      dragging = null;
      wb.save();
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  }

  // -- keys that work anywhere in the workbench
  function onkeydown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    const act = (fn: () => void) => (e.preventDefault(), e.stopPropagation(), fn());
    if (k === "k" || (e.shiftKey && k === "p")) return act(() => (ctl.palette = !ctl.palette));
    if (e.shiftKey && e.key === "Enter") return act(() => ctl.runAll());
    if (e.shiftKey && k === "e") return act(() => wb.showView("explorer"));
    if (e.shiftKey && k === "f") return act(() => (wb.view = "search"));
    if (e.shiftKey && k === "g") return act(() => wb.showView("scm"));
    if (!e.shiftKey && k === "b") return act(() => ((wb.view = wb.view ? null : "explorer"), wb.save()));
    if (!e.shiftKey && k === "j") return act(() => wb.togglePanel());
    if (e.key === "\\") return act(() => wb.splitRight());
  }
</script>

<svelte:window {onkeydown} />

<div class="workbench" class:dragging style:--side="{wb.sideWidth}px">
  <TitleBar {ctl} {wb} />
  <div class="main">
    <ActivityBar {ctl} {wb} />
    {#if wb.view}
      <aside class="sidebar">
        {#if wb.view === "explorer"}
          <ExplorerView {ctl} {wb} />
        {:else if wb.view === "search"}
          <SearchView {ctl} {wb} {tpl} />
        {:else if wb.view === "scm"}
          <div class="scm">
            <header class="title">Source control</header>
            <button class="section" onclick={() => (scmOpen.changes = !scmOpen.changes)}>
              <span class="twist" class:open={scmOpen.changes}><Icon name="chevron-right" size={16} /></span>Changes
            </button>
            {#if scmOpen.changes}<div class="pad"><SourceControl {ctl} onsettings={() => (gitSettings = true)} /></div>{/if}
            {#if ctl.git?.tracked}
              <div class="section-row">
                <button class="section" onclick={() => (scmOpen.history = !scmOpen.history)}>
                  <span class="twist" class:open={scmOpen.history}><Icon name="chevron-right" size={16} /></span>History
                </button>
                <button class="icon" title="Open the graph as a tab" aria-label="Open the graph as a tab" onclick={() => wb.open({ kind: "graph" })}><Icon name="git-commit" size={16} /></button>
              </div>
              {#if scmOpen.history}<div class="graph-pad"><GitGraph {ctl} onopen={(h) => (wb.commit = h)} /></div>{/if}
            {/if}
          </div>
        {:else}
          <div class="data">
            <header class="title">Data</header>
            <div class="pad"><Sidebar {ctl} /></div>
          </div>
        {/if}
      </aside>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="sash v" onpointerdown={(e) => drag(e, "side")} ondblclick={() => ((wb.sideWidth = 260), wb.save())}></div>
    {/if}
    <div class="editors" bind:this={editorsEl}>
      <div class="groups" style:grid-template-columns={wb.groups.length > 1 ? `${wb.split}fr 4px ${1 - wb.split}fr` : "1fr"}>
        {#each wb.groups as _, i (i)}
          {#if i > 0}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="sash v between" onpointerdown={(e) => drag(e, "split")} ondblclick={() => ((wb.split = 0.5), wb.save())}></div>
          {/if}
          <EditorGroup {ctl} {wb} {tpl} index={i} />
        {/each}
      </div>
      {#if wb.panel}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="sash h" onpointerdown={(e) => drag(e, "panel")}></div>
        <div class="panel" style:height="{wb.panelHeight}px"><Panel {ctl} {wb} {tpl} /></div>
      {/if}
    </div>
  </div>
  <StatusBar {ctl} {wb} {tpl} />
</div>

{#if ctl.palette}<Palette {ctl} {wb} />{/if}
{#if ctl.help}<Help onclose={() => (ctl.help = false)} />{/if}
{#if ctl.secrets}<SecretsDialog {ctl} />{/if}
{#if ctl.sandbox}<SandboxDialog {ctl} onclose={() => (ctl.sandbox = false)} />{/if}
{#if ctl.ai}<AiDialog {ctl} onclose={() => (ctl.ai = false)} />{/if}
{#if ctl.gitPrompt || gitSettings}
  <GitDialog {ctl} onclose={() => ((ctl.gitPrompt = false), (gitSettings = false))} />
{/if}
{#if wb.commit}<CommitDialog {ctl} hash={wb.commit} onclose={() => (wb.commit = null)} />{/if}

<style>
  /* the workbench is the window: nothing scrolls but its parts */
  :global(html.workbench),
  :global(html.workbench body) {
    height: 100%;
    overflow: hidden;
  }
  .workbench {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    height: 100vh;
    height: 100dvh;
    color: var(--wb-fg);
    background: var(--wb-editor);
  }
  .workbench.dragging {
    user-select: none;
  }
  .workbench.dragging :global(iframe) {
    pointer-events: none;
  }
  .main {
    display: flex;
    min-height: 0;
  }
  .sidebar {
    width: var(--side);
    flex: none;
    min-width: 0;
    background: var(--wb-side);
    overflow: hidden;
  }
  .sash {
    flex: none;
    position: relative;
    z-index: 2;
    background: var(--wb-border);
    transition: background-color 0.1s 0.15s;
  }
  .sash.v {
    width: 1px;
    cursor: col-resize;
  }
  .sash.v::after {
    content: "";
    position: absolute;
    inset: 0 -2px;
  }
  .sash.h {
    height: 1px;
    cursor: row-resize;
  }
  .sash.h::after {
    content: "";
    position: absolute;
    inset: -2px 0;
  }
  .sash:hover,
  .dragging .sash {
    background: var(--wb-accent);
  }
  .sash.v.between {
    width: 4px;
    background: var(--wb-border);
    background-clip: content-box;
    padding: 0 1.5px;
  }
  .sash.v.between:hover {
    background-color: var(--wb-accent);
  }
  .editors {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .groups {
    flex: 1;
    min-height: 0;
    display: grid;
  }
  .panel {
    flex: none;
    min-height: 0;
  }
  .scm,
  .data {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow-y: auto;
  }
  .title {
    display: flex;
    align-items: center;
    height: 2.1875rem;
    padding: 0 1.25rem;
    font-size: 0.6875rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--wb-fg-muted);
    flex: none;
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
  .pad {
    padding: 0.25rem 0.75rem 0.75rem 1.25rem;
  }
  .graph-pad {
    padding: 0 0 0.75rem 0.75rem;
  }
  .section-row {
    display: flex;
    align-items: center;
    padding-right: 0.5rem;
  }
  .section-row .icon {
    color: var(--wb-fg);
    width: 1.375rem;
    height: 1.375rem;
  }
</style>
