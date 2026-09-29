<script lang="ts">
  import type { NotebookCtl } from "../../lib/notebook.svelte";
  import type { View, Workbench } from "../../lib/workbench.svelte";
  import Icon from "../Icon.svelte";
  import Menu from "../Menu.svelte";

  // The activity bar: which view the side bar shows; settings at the bottom.
  let { ctl, wb }: { ctl: NotebookCtl; wb: Workbench } = $props();

  const changes = $derived((ctl.git?.cells.length ?? 0) + (ctl.git?.files.length ?? 0));
  const VIEWS: [View, string, string][] = [
    ["explorer", "files", "Explorer  (Ctrl+Shift+E)"],
    ["search", "search", "Search  (Ctrl+Shift+F)"],
    ["scm", "source-control", "Source control  (Ctrl+Shift+G)"],
    ["data", "database", "Data: tables, files, connections"],
  ];
</script>

<nav class="activity" aria-label="Views">
  {#each VIEWS as [id, icon, title] (id)}
    <button class:on={wb.view === id} {title} aria-label={title} aria-pressed={wb.view === id} onclick={() => wb.showView(id)}>
      <Icon name={icon} size={24} />
      {#if id === "scm" && changes}<span class="badge">{changes}</span>{/if}
    </button>
  {/each}
  <span class="spacer"></span>
  <div class="gear">
    <Menu
      icon="settings-gear"
      title="Settings"
      items={[
        { label: "Command palette", hint: "Ctrl+K", run: () => (ctl.palette = true) },
        "-",
        { label: "Secrets", run: () => (ctl.secrets = true) },
        { label: "Sandbox: size and network", run: () => (ctl.sandbox = true) },
        { label: "AI clients and access (MCP)", run: () => (ctl.ai = true) },
        "-",
        { label: "Keyboard shortcuts", hint: "?", run: () => (ctl.help = true) },
      ]}
    />
  </div>
</nav>

<style>
  .activity {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 3rem;
    background: var(--wb-bar);
    border-right: 1px solid var(--wb-border);
  }
  .activity > button {
    position: relative;
    display: grid;
    place-items: center;
    width: 3rem;
    height: 3rem;
    padding: 0;
    border-radius: 0;
    color: var(--wb-fg-dim);
  }
  .activity > button:hover {
    background: none;
    color: var(--wb-fg);
  }
  .activity > button:active {
    transform: none;
  }
  .activity > button.on {
    color: var(--wb-fg);
  }
  .activity > button.on::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--wb-accent);
  }
  .badge {
    position: absolute;
    right: 0.375rem;
    bottom: 0.4rem;
    min-width: 1rem;
    height: 1rem;
    padding: 0 0.25rem;
    border-radius: 999px;
    font-size: 0.625rem;
    line-height: 1rem;
    text-align: center;
    color: #fff;
    background: var(--wb-badge);
  }
  .spacer {
    flex: 1;
  }
  .gear {
    padding-bottom: 0.5rem;
  }
  .gear :global(button.icon) {
    width: 3rem;
    height: 3rem;
    color: var(--wb-fg-dim);
    border-radius: 0;
  }
  .gear :global(button.icon:hover) {
    background: none;
    color: var(--wb-fg);
  }
  .gear :global(button.icon i) {
    font-size: 1.5rem !important;
  }
</style>
