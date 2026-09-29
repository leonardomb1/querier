<script lang="ts">
  import type { NotebookCtl } from "../../lib/notebook.svelte";
  import type { Workbench } from "../../lib/workbench.svelte";
  import Icon from "../Icon.svelte";

  // The title bar: where you are, the command center (the palette), the layout toggles.
  let { ctl, wb }: { ctl: NotebookCtl; wb: Workbench } = $props();
</script>

<header class="titlebar">
  <nav class="crumbs">
    <a href="#/" title="All notebooks"><Icon name="notebook" size={16} /><span>querier</span></a>
  </nav>
  <button class="center" onclick={() => (ctl.palette = true)} title="Commands, cells and notebooks  (Ctrl+K)">
    <Icon name="search" size={14} /><span>{ctl.book?.title ?? ctl.name}</span>
  </button>
  <div class="layout">
    <button class="icon" class:on={wb.view != null} title="Toggle the side bar  (Ctrl+B)" aria-label="Toggle the side bar" onclick={() => ((wb.view = wb.view ? null : "explorer"), wb.save())}>
      <Icon name={wb.view ? "layout-sidebar-left" : "layout-sidebar-left-off"} size={16} />
    </button>
    <button class="icon" class:on={wb.panel} title="Toggle the panel  (Ctrl+J)" aria-label="Toggle the panel" onclick={() => wb.togglePanel()}>
      <Icon name={wb.panel ? "layout-panel" : "layout-panel-off"} size={16} />
    </button>
  </div>
</header>

<style>
  .titlebar {
    display: grid;
    grid-template-columns: 1fr minmax(0, 38rem) 1fr;
    align-items: center;
    gap: 0.75rem;
    height: 2.1875rem;
    padding: 0 0.5rem 0 0.75rem;
    background: var(--wb-bar);
    border-bottom: 1px solid var(--wb-border);
    color: var(--wb-fg);
    font-size: 0.8125rem;
    user-select: none;
  }
  .crumbs a {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--wb-fg-muted);
    text-decoration: none;
  }
  .crumbs a:hover {
    color: var(--wb-fg);
  }
  .center {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    height: 1.5rem;
    padding: 0 0.75rem;
    border-radius: 6px;
    border: 1px solid var(--wb-border);
    background: color-mix(in srgb, var(--wb-fg) 5%, transparent);
    color: var(--wb-fg-muted);
    font-size: 0.78rem;
  }
  .center:hover {
    color: var(--wb-fg);
    background: color-mix(in srgb, var(--wb-fg) 9%, transparent);
  }
  .center:active {
    transform: none;
  }
  .layout {
    justify-self: end;
    display: flex;
    gap: 2px;
  }
  .layout button {
    width: 1.625rem;
    height: 1.625rem;
    color: var(--wb-fg-muted);
    border-radius: 5px;
  }
  .layout button.on {
    color: var(--wb-fg);
  }
</style>
