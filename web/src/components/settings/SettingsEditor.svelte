<script lang="ts">
  import { onMount, tick, type Snippet } from "svelte";
  import Icon from "../Icon.svelte";
  import Menu from "../Menu.svelte";
  import { provideSettings } from "./context";

  // The settings editor, as VS Code's: a search box (with @modified and @id:
  // filters) over scope tabs, the scope's groups listed on the left, its settings
  // on the right. The groups and settings are the scope's own (children); a group
  // is a <section class="group" id="set-…"> with an <h2>, and hides when none of
  // its settings match the search.
  let {
    scopes,
    scope,
    onscope,
    toc,
    reveal = null,
    children,
  }: {
    scopes: { id: string; label: string; hint?: string }[];
    scope: string;
    onscope: (id: string) => void;
    /** the groups of the scope shown, in order */
    toc: { id: string; label: string }[];
    /** a group to bring into view (set by whoever opened the editor) */
    reveal?: string | null;
    children: Snippet;
  } = $props();

  let query = $state("");
  let status = $state<{ kind: "saved" | "error"; text: string } | null>(null);
  let timer: ReturnType<typeof setTimeout>;
  provideSettings({
    get query() {
      return query.toLowerCase();
    },
    report(kind, text) {
      status = { kind, text };
      clearTimeout(timer);
      if (kind === "saved") timer = setTimeout(() => (status = null), 2500);
    },
  });

  let body = $state<HTMLDivElement>();
  let search = $state<HTMLInputElement>();
  let count = $state(0);
  let current = $state("");
  // how many settings the search leaves, once they have hidden themselves
  $effect(() => {
    void query;
    void scope;
    tick().then(() => (count = body?.querySelectorAll(".setting:not(.hidden)").length ?? 0));
  });

  function go(id: string, smooth = true) {
    body?.querySelector(`#set-${id}`)?.scrollIntoView({ behavior: smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto", block: "start" });
  }
  // another scope: from its top, unless a group of it was asked for
  $effect(() => {
    void scope;
    const to = reveal;
    tick().then(() => {
      if (to) go(to, false);
      else body?.scrollTo(0, 0);
      onscroll();
    });
  });

  // the group at the top of the list is the one lit in the contents
  function onscroll() {
    const top = body!.getBoundingClientRect().top + 8;
    let at = toc[0]?.id ?? "";
    for (const t of toc) {
      const el = body!.querySelector<HTMLElement>(`#set-${t.id}`);
      if (el && el.offsetParent && el.getBoundingClientRect().top <= top) at = t.id;
    }
    current = at;
  }
  onMount(() => {
    onscroll();
    search?.focus();
  });

  const FILTERS = [
    { label: "Modified", hint: "@modified", insert: "@modified" },
    { label: "Setting ID", hint: "@id:", insert: "@id:" },
  ];
  function addFilter(f: string) {
    query = `${query.trim()} ${f}`.trimStart() + (f.endsWith(":") ? "" : " ");
    search?.focus();
  }
</script>

<div class="settings-editor">
  <header class="top">
    <div class="search">
      <input bind:this={search} bind:value={query} placeholder="Search settings" spellcheck="false" onkeydown={(e) => e.key === "Escape" && (query = "")} aria-label="Search settings" />
      <span class="tools">
        {#if query}<span class="count">{count === 0 ? "No settings found" : `${count} setting${count === 1 ? "" : "s"} found`}</span>{/if}
        {#if query}
          <button class="icon" title="Clear settings search input" aria-label="Clear the search" onclick={() => ((query = ""), search?.focus())}><Icon name="clear-all" size={16} /></button>
        {/if}
        <Menu icon="filter" title="Filter settings" items={FILTERS.map((f) => ({ label: f.label, hint: f.hint, run: () => addFilter(f.insert) }))} />
      </span>
    </div>
    <div class="scopes" role="tablist">
      {#each scopes as s (s.id)}
        <button role="tab" class:on={scope === s.id} aria-selected={scope === s.id} onclick={() => onscope(s.id)} title={s.hint}>
          {s.label}{#if s.hint}<span class="hint">{s.hint}</span>{/if}
        </button>
      {/each}
      {#if status}
        <span class="status" class:bad={status.kind === "error"} role="status">
          <Icon name={status.kind === "error" ? "error" : "check"} size={14} />{status.text}
        </span>
      {/if}
    </div>
  </header>

  <div class="split">
    <nav class="toc" aria-label="Contents">
      {#each toc as t (t.id)}
        <button class:on={current === t.id} onclick={() => go(t.id)}>{t.label}</button>
      {/each}
    </nav>
    <div class="body settings-controls" bind:this={body} {onscroll}>
      {@render children()}
      {#if query && count === 0}<p class="none">No settings match “{query}”.</p>{/if}
    </div>
  </div>
</div>

<style>
  .settings-editor {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    color: var(--wb-fg);
    background: var(--wb-editor);
    font-size: 0.8125rem;
  }
  .top {
    flex: none;
    padding: 0.75rem 1.5rem 0;
    max-width: 72rem;
    width: 100%;
    margin: 0 auto;
  }
  .search {
    position: relative;
    display: flex;
  }
  .search input {
    flex: 1;
    height: 1.875rem;
    padding: 0 12rem 0 0.5rem;
    font-size: 0.875rem;
    color: var(--wb-fg);
    background: var(--wb-input);
    border: 1px solid var(--wb-input-border);
    border-radius: 2px;
  }
  .search input:focus {
    outline: 1px solid var(--wb-accent);
    outline-offset: -1px;
    border-color: var(--wb-accent);
  }
  .tools {
    position: absolute;
    right: 0.25rem;
    top: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .tools :global(button.icon) {
    width: 1.5rem;
    height: 1.5rem;
    color: var(--wb-fg-muted);
  }
  .count {
    padding: 0 0.375rem;
    font-size: 0.75rem;
    color: var(--wb-fg-muted);
    white-space: nowrap;
  }
  .scopes {
    display: flex;
    align-items: stretch;
    gap: 1.25rem;
    margin-top: 0.75rem;
    border-bottom: 1px solid var(--wb-border);
  }
  .scopes button {
    display: flex;
    align-items: baseline;
    gap: 0.375rem;
    padding: 0.375rem 0 0.4375rem;
    border-radius: 0;
    color: var(--wb-fg-muted);
    border-bottom: 1px solid transparent;
    margin-bottom: -1px;
    font-size: 0.8125rem;
  }
  .scopes button:hover {
    background: none;
    color: var(--wb-fg);
  }
  .scopes button:active {
    transform: none;
  }
  .scopes button.on {
    color: var(--wb-fg);
    border-bottom-color: var(--wb-accent);
  }
  .scopes .hint {
    font-size: 0.72rem;
    color: var(--wb-fg-dim);
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    margin-left: auto;
    font-size: 0.75rem;
    color: var(--good);
  }
  .status.bad {
    color: var(--critical);
  }
  .split {
    display: flex;
    flex: 1;
    min-height: 0;
    width: 100%;
    max-width: 72rem;
    margin: 0 auto;
  }
  .toc {
    flex: none;
    width: 11rem;
    padding: 0.75rem 0 0 1.5rem;
    overflow-y: auto;
  }
  .toc button {
    display: block;
    width: 100%;
    padding: 0.1875rem 0.5rem;
    border-radius: 0;
    text-align: left;
    color: var(--wb-fg-muted);
    font-size: 0.8125rem;
  }
  .toc button:hover {
    background: var(--wb-list-hover);
    color: var(--wb-fg);
  }
  .toc button:active {
    transform: none;
  }
  .toc button.on {
    color: var(--wb-fg);
    font-weight: 600;
  }
  .body {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: 0 1.5rem 50vh 2rem;
  }
  .none {
    padding: 1rem 1.25rem;
    color: var(--wb-fg-muted);
  }

  @media (max-width: 760px) {
    .toc {
      display: none;
    }
    .body {
      padding-left: 1rem;
    }
  }
</style>
