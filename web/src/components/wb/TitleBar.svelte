<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "../Icon.svelte";

  // The title bar, the same on every page: where you are (querier › workspace ›
  // notebook), the command center (the palette), and the page's layout toggles.
  let {
    crumbs = [],
    center,
    oncenter,
    children,
  }: { crumbs?: { label: string; href?: string; title?: string }[]; center: string; oncenter: () => void; children?: Snippet } = $props();
</script>

<header class="titlebar" style:view-transition-name="wb-title">
  <nav class="crumbs" aria-label="Where you are">
    <a href="#/" title="All workspaces" class="home"><Icon name="notebook" size={16} /><span>querier</span></a>
    {#each crumbs as c, i (i)}
      <span class="sep"><Icon name="chevron-right" size={12} /></span>
      {#if c.href}<a href={c.href} title={c.title}>{c.label}</a>{:else}<span class="here" title={c.title}>{c.label}</span>{/if}
    {/each}
  </nav>
  <button class="center" onclick={oncenter} title="Commands, notebooks and workspaces  (Ctrl+K)">
    <Icon name="search" size={14} /><span>{center}</span>
  </button>
  <div class="layout">{@render children?.()}</div>
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
  .crumbs {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    min-width: 0;
    white-space: nowrap;
  }
  .sep {
    display: flex;
    color: var(--wb-fg-dim);
  }
  /* every crumb the same box, the current one too: the same space either side of each chevron */
  .here {
    display: block;
    padding: 0 0.25rem;
    line-height: 1.375rem;
    color: var(--wb-fg);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .crumbs a {
    display: inline-flex;
    line-height: 1.375rem;
    padding: 0 0.25rem;
    border-radius: 4px;
    align-items: center;
    gap: 0.375rem;
    color: var(--wb-fg-muted);
    text-decoration: none;
  }
  .crumbs a:hover {
    color: var(--wb-fg);
    background: var(--wb-list-hover);
  }
  .crumbs a.home {
    padding-left: 0;
  }
  .crumbs a.home:hover {
    background: none;
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
  .layout :global(button) {
    width: 1.625rem;
    height: 1.625rem;
    color: var(--wb-fg-muted);
    border-radius: 5px;
  }
  .layout :global(button.on) {
    color: var(--wb-fg);
  }
</style>
