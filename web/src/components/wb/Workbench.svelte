<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { Notebook } from "../../lib/api";
  import { NotebookCtl } from "../../lib/notebook.svelte";
  import { TemplateCtl } from "../../lib/template.svelte";
  import { adminHref, wsHref } from "../../lib/href";
  import { session } from "../../lib/session.svelte";
  import { Workbench, type View } from "../../lib/workbench.svelte";
  import CommitDialog from "../CommitDialog.svelte";
  import GitDialog from "../GitDialog.svelte";
  import Help from "../Help.svelte";
  import Icon from "../Icon.svelte";
  import GitGraph from "../GitGraph.svelte";
  import Palette from "../Palette.svelte";
  import Sidebar from "../Sidebar.svelte";
  import SourceControl from "../SourceControl.svelte";
  import ActivityBar from "./ActivityBar.svelte";
  import EditorGrid from "./EditorGrid.svelte";
  import SandboxPanel from "./SandboxPanel.svelte";
  import { sidebar } from "../../lib/sidebar.svelte";
  import ExplorerView from "./ExplorerView.svelte";
  import Panel from "./Panel.svelte";
  import SearchView from "./SearchView.svelte";
  import StatusBar from "./StatusBar.svelte";
  import TitleBar from "./TitleBar.svelte";
  import Avatars, { people } from "../Avatars.svelte";
  import ManageAccess from "../auth/ManageAccess.svelte";
  import CredentialsDialog from "../connections/CredentialsDialog.svelte";

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
  const workspace = $derived(name.split("/")[0]);
  const changes = $derived((ctl.git?.cells.length ?? 0) + (ctl.git?.files.length ?? 0));
  onDestroy(() => ctl.close());
  onMount(() => {
    if (open === "report") wb.open({ kind: "report" });
    document.documentElement.classList.add("workbench");
    return () => document.documentElement.classList.remove("workbench");
  });

  $effect(() => tpl.sync(ctl.book?.template));
  // "open the settings there", asked from anywhere (a cell, the status bar, the palette)
  $effect(() => {
    const s = ctl.settings;
    if (!s) return;
    ctl.settings = null;
    wb.openSettings(s.scope, s.section ?? null);
  });
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

  // -- sashes: the side bar's width, the panel's size (the groups' are the grid's own).
  // Dragged small enough, the side bar and the panel snap closed, as in VS Code;
  // dragged back out, they open again.
  let dragging = $state<"side" | "panel" | "grid" | null>(null);
  let editorsEl = $state<HTMLDivElement>();
  const SNAP = 100;
  function drag(e: PointerEvent, what: "side" | "panel") {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = what;
    const box = editorsEl!.getBoundingClientRect();
    const lastView = wb.view ?? "explorer";
    const move = (ev: PointerEvent) => {
      if (what === "side") {
        const w = ev.clientX - 48;
        if (w < SNAP) wb.view = null;
        else {
          wb.view ??= lastView;
          sidebar.set(w);
        }
        return;
      }
      const right = wb.panelPosition === "right";
      const size = right ? box.right - ev.clientX : box.bottom - ev.clientY;
      const room = (right ? box.width : box.height) - 160;
      if (size < SNAP) wb.panel = false;
      else {
        wb.panel = true;
        if (right) wb.panelWidth = Math.min(room, Math.max(220, size));
        else wb.panelHeight = Math.min(room, Math.max(90, size));
      }
    };
    const up = () => {
      dragging = null;
      wb.save();
      sidebar.save();
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
    // Ctrl+` (or Ctrl+', as VS Code on layouts where ` is a dead key: Brazilian ABNT2 and others): the terminal
    const terminalKey = e.key === "`" || e.key === "'" || e.code === "Backquote" || (e.key === "Dead" && (e.code === "BracketLeft" || e.code === "Quote"));
    if (terminalKey && !e.shiftKey && ctl.may("notebook.shell")) return act(() => wb.togglePanel("terminal"));
    // in a terminal, the keys are the shell's (Ctrl+K, Ctrl+B, Ctrl+E…), but for the palette and the panel
    if ((e.target as HTMLElement | null)?.closest?.(".xterm")) {
      if (e.shiftKey && k === "p") return act(() => (ctl.palette = !ctl.palette));
      if (!e.shiftKey && k === "j") return act(() => wb.togglePanel());
      return;
    }
    if (k === "k" || (e.shiftKey && k === "p")) return act(() => (ctl.palette = !ctl.palette));
    if (e.shiftKey && e.key === "Enter") return act(() => ctl.runAll());
    if (e.shiftKey && k === "e") return act(() => wb.showView("explorer"));
    if (e.shiftKey && k === "f") return act(() => (wb.view = "search"));
    if (e.shiftKey && k === "g") return act(() => wb.showView("scm"));
    if (!e.shiftKey && k === "b") return act(() => ((wb.view = wb.view ? null : "explorer"), wb.save()));
    if (!e.shiftKey && k === "j") return act(() => wb.togglePanel());
    if (e.key === "\\") return act(() => wb.split(e.altKey ? "down" : "right"));
    if (e.key === ",") return act(() => wb.openSettings());
  }
</script>

<!-- in the capture phase: before an editor (Monaco) takes the keys it also binds, as Ctrl+K -->
<svelte:window onkeydowncapture={onkeydown} />

<div class="workbench" class:dragging={!!dragging || !!wb.drag} style:--side="{sidebar.width}px">
  <TitleBar
    crumbs={[
      { label: workspace, href: wsHref(workspace), title: `The workspace ${workspace}` },
      { label: ctl.book?.title ?? ctl.name, title: ctl.name },
    ]}
    center={ctl.book?.title ?? ctl.name}
    oncenter={() => (ctl.palette = true)}
  >
    {#if ctl.others.length}
      <span class="present"><Avatars users={people(ctl.others.map((p) => p.user))} label="has this notebook open" /></span>
    {/if}
    {#if ctl.may("notebook.share")}
      <button class="icon" title="Share this notebook" aria-label="Share this notebook" onclick={() => (ctl.sharing = true)}>
        <Icon name="person-add" size={16} />
      </button>
    {/if}
    <button class="icon" class:on={wb.view != null} title="Toggle the side bar  (Ctrl+B)" aria-label="Toggle the side bar" onclick={() => ((wb.view = wb.view ? null : "explorer"), wb.save())}>
      <Icon name={wb.view ? "layout-sidebar-left" : "layout-sidebar-left-off"} size={16} />
    </button>
    <button class="icon" class:on={wb.panel} title="Toggle the panel  (Ctrl+J)" aria-label="Toggle the panel" onclick={() => wb.togglePanel()}>
      <Icon name={wb.panel ? "layout-panel" : "layout-panel-off"} size={16} />
    </button>
  </TitleBar>
  <div class="main">
    <ActivityBar
      views={[
        { id: "explorer", icon: "files", title: "Explorer  (Ctrl+Shift+E)" },
        { id: "search", icon: "search", title: "Search  (Ctrl+Shift+F)" },
        { id: "scm", icon: "source-control", title: "Source control  (Ctrl+Shift+G)", badge: changes },
        { id: "data", icon: "database", title: "Data: tables, files, connections" },
      ]}
      active={wb.view}
      onpick={(v) => wb.showView(v as View)}
      menu={[
        { label: "Command Palette…", hint: "Ctrl+K", run: () => (ctl.palette = true) },
        "-",
        { label: "Settings", hint: "Ctrl+,", run: () => wb.openSettings() },
        { label: "Keyboard Shortcuts", hint: "?", run: () => (ctl.help = true) },
        "-",
        { label: "AI Clients (MCP)", run: () => wb.openSettings("user", "clients") },
        ...(session.can("admin.manage") ? ["-" as const, { label: "Administration", run: () => (location.hash = adminHref()) }] : []),
      ]}
    />
    {#if wb.view}
      <aside class="sidebar" style:view-transition-name="wb-side">
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
      <div class="sash v" onpointerdown={(e) => drag(e, "side")} ondblclick={() => sidebar.reset()}></div>
    {/if}
    <div class="editors" class:right={wb.panelPosition === "right"} class:max={wb.panel && wb.panelMax} bind:this={editorsEl}>
      <div class="grid-wrap">
        <EditorGrid {ctl} {wb} {tpl} ondragging={(on) => (dragging = on ? "grid" : null)} />
      </div>
      {#if wb.panel}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="sash {wb.panelPosition === 'right' ? 'v' : 'h'}" onpointerdown={(e) => drag(e, "panel")}></div>
        <div class="panel" style:height={wb.panelPosition === "bottom" && !wb.panelMax ? `${wb.panelHeight}px` : null} style:width={wb.panelPosition === "right" && !wb.panelMax ? `${wb.panelWidth}px` : null}>
          <Panel {ctl} {wb} {tpl} />
        </div>
      {/if}
    </div>
  </div>
  <StatusBar {ctl} {wb} {tpl} />
</div>

{#if ctl.palette}<Palette {ctl} {wb} onclose={() => (ctl.palette = false)} />{/if}
{#if ctl.help}<Help onclose={() => (ctl.help = false)} />{/if}
{#if ctl.sandboxPanel}<SandboxPanel {ctl} {wb} onclose={() => (ctl.sandboxPanel = false)} />{/if}
{#if ctl.gitPrompt || gitSettings}
  <GitDialog {ctl} onclose={() => ((ctl.gitPrompt = false), (gitSettings = false))} />
{/if}
{#if ctl.sharing}
  <ManageAccess what={{ scope: "notebook", target: ctl.name, title: ctl.book?.title ?? ctl.name }} onclose={() => (ctl.sharing = false)} />
{/if}
{#if ctl.enteringCredentials}
  <CredentialsDialog
    connection={ctl.enteringCredentials}
    onsaved={() => {
      ctl.enteringCredentials = null;
      ctl.refreshConnections();
      ctl.say(ctl.conn.session === "ready" ? "Saved. Restart the kernel for it to get them." : "Saved: your kernel gets them when it starts.");
    }}
    onclose={() => (ctl.enteringCredentials = null)}
  />
{/if}
{#if wb.commit}<CommitDialog {ctl} hash={wb.commit} onclose={() => (wb.commit = null)} />{/if}

<style>
  /* who else has the notebook open, beside the title bar's buttons */
  .present {
    display: inline-flex;
    align-items: center;
    margin-right: 0.375rem;
  }
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
  .editors {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .editors.right {
    flex-direction: row;
  }
  .grid-wrap {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
  }
  /* the panel maximized: the editors stay mounted, out of sight */
  .editors.max .grid-wrap,
  .editors.max > .sash {
    display: none;
  }
  .editors.max .panel {
    flex: 1;
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
  /* the header shares its row with its action: it takes what is left, not all of it */
  .section-row .section {
    flex: 1;
    width: auto;
    min-width: 0;
  }
  .section-row .icon {
    flex: none;
    color: var(--wb-fg);
    width: 1.375rem;
    height: 1.375rem;
  }
</style>
