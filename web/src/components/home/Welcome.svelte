<script lang="ts">
  import type { WorkspaceSummary } from "../../lib/api";
  import { ago } from "../../lib/format";
  import { wsHref } from "../../lib/href";
  import { openHref } from "../../lib/can";
  import Icon from "../Icon.svelte";

  // Home with no workspace open, as VS Code's Welcome: start something, pick up
  // where you left off, or open a workspace.
  let {
    spaces,
    root,
    onnewworkspace,
    onnewnotebook,
    onpalette,
    onai,
  }: {
    spaces: WorkspaceSummary[];
    root: string;
    /** unset: they may not create one */
    onnewworkspace?: () => void;
    onnewnotebook?: () => void;
    onpalette: () => void;
    onai: () => void;
  } = $props();

  const recent = $derived(
    spaces
      .flatMap((w) => w.notebooks.map((b) => ({ ...b, wsTitle: w.title })))
      .filter((b) => b.modified)
      .sort((a, b) => b.modified - a.modified)
      .slice(0, 8),
  );
  const total = $derived(spaces.reduce((n, w) => n + w.notebooks.length, 0));
</script>

<div class="page">
  <header>
    <h1>querier</h1>
    <p class="sub">SQL on basalt, Python and notes, in notebooks grouped by workspace.</p>
  </header>

  <div class="cols">
    <section>
      <h2>Start</h2>
      <ul class="links">
        {#if onnewnotebook}<li><button onclick={onnewnotebook}><Icon name="new-file" size={16} />New notebook…</button></li>{/if}
        {#if onnewworkspace}<li><button onclick={onnewworkspace}><Icon name="new-folder" size={16} />New workspace…</button></li>{/if}
        <li><button onclick={onpalette}><Icon name="search" size={16} />Go to anything…<kbd>Ctrl K</kbd></button></li>
        <li><button onclick={onai}><Icon name="sparkle" size={16} />Connect an AI client (MCP)…</button></li>
      </ul>

      <h2>Recent</h2>
      {#if recent.length}
        <ul class="recent">
          {#each recent as b (b.id)}
            <li>
              <a href={openHref(b)}>{b.title}</a>
              <span class="path" title={root ? `${root}/${b.id}` : b.id}>{b.wsTitle}</span>
              <span class="when">{ago(b.modified)}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted">Nothing yet: notebooks you work on show up here.</p>
      {/if}
    </section>

    <section>
      <h2>Workspaces <span class="n">{spaces.length} · {total} notebook{total === 1 ? "" : "s"}</span></h2>
      {#if !spaces.length}
        <p class="muted">
          {onnewworkspace ? "No workspaces yet: create the first one." : "Nothing has been shared with you yet. Ask a workspace's Admin or Member for a role, or someone to share a notebook with you."}
        </p>
      {/if}
      <ul class="spaces">
        {#each spaces as w (w.name)}
          <li>
            <a href={wsHref(w.name)}>
              <span class="ic"><Icon name="folder-library" size={20} /></span>
              <span class="main">
                <span class="t">{w.title}</span>
                <span class="d">{w.description || `${w.name}/`}</span>
              </span>
              <span class="count">{w.notebooks.length}</span>
            </a>
          </li>
        {/each}
      </ul>
      <p class="muted small">
        A workspace is a folder of notebooks sharing connections, sandbox defaults, AI access and attributes.{#if root}
          They live in <code>{root}</code>.{/if}
      </p>
    </section>
  </div>
</div>

<style>
  .page {
    max-width: 62rem;
    margin: 0 auto;
    padding: 4rem 2.5rem 5rem;
    color: var(--wb-fg);
  }
  h1 {
    margin: 0;
    font-size: 2.25rem;
    font-weight: 400;
    letter-spacing: -0.02em;
  }
  .sub {
    margin: 0.25rem 0 0;
    font-size: 1.05rem;
    color: var(--wb-fg-muted);
  }
  .cols {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 3.5rem;
    margin-top: 3rem;
  }
  h2 {
    margin: 0 0 0.625rem;
    font-size: 1.05rem;
    font-weight: 400;
  }
  section h2:not(:first-child) {
    margin-top: 2rem;
  }
  .n {
    margin-left: 0.375rem;
    font-size: 0.8125rem;
    color: var(--wb-fg-dim);
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .links button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0;
    color: var(--wb-accent);
    font-size: 0.875rem;
  }
  .links button:hover {
    background: none;
    text-decoration: underline;
  }
  .links button:active {
    transform: none;
  }
  .links kbd {
    margin-left: 0.25rem;
    font-size: 0.65rem;
  }
  .recent li {
    display: flex;
    align-items: baseline;
    gap: 0.625rem;
    padding: 0.1875rem 0;
    font-size: 0.875rem;
  }
  .recent a {
    color: var(--wb-accent);
    text-decoration: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .recent a:hover {
    text-decoration: underline;
  }
  .path {
    color: var(--wb-fg-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .when {
    margin-left: auto;
    font-size: 0.75rem;
    color: var(--wb-fg-dim);
    white-space: nowrap;
  }
  .spaces {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .spaces a {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--wb-border);
    border-radius: 6px;
    color: inherit;
    text-decoration: none;
    background: color-mix(in srgb, var(--wb-fg) 2%, transparent);
  }
  .spaces a:hover {
    border-color: color-mix(in srgb, var(--wb-accent) 60%, var(--wb-border));
    background: var(--wb-list-hover);
  }
  .ic {
    display: flex;
    color: var(--wb-accent);
  }
  .main {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .t {
    font-weight: 500;
  }
  .d {
    font-size: 0.78rem;
    color: var(--wb-fg-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .count {
    min-width: 1.5rem;
    padding: 0 0.375rem;
    border-radius: 999px;
    font-size: 0.72rem;
    text-align: center;
    color: var(--wb-fg-muted);
    background: color-mix(in srgb, var(--wb-fg) 10%, transparent);
  }
  .muted {
    color: var(--wb-fg-muted);
  }
  .small {
    margin-top: 1rem;
    font-size: 0.78rem;
  }
  .small code {
    font-size: 0.75rem;
  }
  @media (max-width: 760px) {
    .cols {
      grid-template-columns: 1fr;
      gap: 2rem;
    }
  }
</style>
