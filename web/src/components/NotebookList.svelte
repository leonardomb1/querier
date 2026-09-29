<script lang="ts">
  import { api, type NotebookIndex, type NotebookSummary } from "../lib/api";
  import Icon from "./Icon.svelte";

  let { index }: { index: NotebookIndex } = $props();

  let query = $state("");
  let creating = $state(false);
  let title = $state("");
  let error = $state("");
  let busy = $state(false);
  let search: HTMLInputElement;
  let list: HTMLUListElement;

  const books = $derived(index.notebooks);
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return books;
    return books.filter((b) => [b.title, b.name, b.description ?? ""].some((s) => s.toLowerCase().includes(q)));
  });

  /** The folder a title becomes: lowercase, accents dropped, dashes between words. */
  const slug = $derived(
    title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60),
  );

  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (!slug || busy) return;
    busy = true;
    try {
      await api.create(slug, title.trim());
      location.hash = `#/nb/${encodeURIComponent(slug)}`;
    } catch (err: any) {
      error = err.message;
      busy = false;
    }
  }

  function cancel() {
    creating = false;
    title = "";
    error = "";
  }

  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" }); // the UI's language
  function edited(ms: number): string {
    if (!ms) return "";
    const s = (ms - Date.now()) / 1000;
    const units: [Intl.RelativeTimeFormatUnit, number][] = [
      ["year", 31536000],
      ["month", 2592000],
      ["week", 604800],
      ["day", 86400],
      ["hour", 3600],
      ["minute", 60],
    ];
    for (const [unit, size] of units) if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit);
    return "just now";
  }

  function contents(b: NotebookSummary): string {
    const parts = [b.sql && `${b.sql} SQL`, b.python && `${b.python} Python`, b.text && `${b.text} text`].filter(Boolean);
    return parts.join(" · ") || "empty";
  }

  function onkeydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
    const rows = [...list.querySelectorAll<HTMLAnchorElement>("a.row")];
    const i = rows.indexOf(document.activeElement as HTMLAnchorElement);
    const go = (k: number) => rows[Math.max(0, Math.min(rows.length - 1, k))]?.focus();
    if (e.key === "/") search.focus();
    else if (e.key === "n") creating = true;
    else if (e.key === "j" || e.key === "ArrowDown") go(i + 1);
    else if (e.key === "k" || e.key === "ArrowUp") go(i < 0 ? 0 : i - 1);
    else return;
    e.preventDefault();
  }
</script>

<svelte:window {onkeydown} />

<div class="page">
  <header>
    <h1>Notebooks {#if books.length}<span class="count num">{books.length}</span>{/if}</h1>
    <div class="tools">
      <label class="search">
        <Icon name="search" size={14} />
        <input
          bind:this={search}
          bind:value={query}
          placeholder="Search"
          onkeydown={(e) => {
            if (e.key === "Escape") (query = ""), e.currentTarget.blur();
            if (e.key === "ArrowDown") (e.preventDefault(), list.querySelector<HTMLAnchorElement>("a.row")?.focus());
          }}
        />
        <kbd>/</kbd>
      </label>
      <button class="new" onclick={() => (creating = true)}>New notebook</button>
    </div>
  </header>

  {#if creating}
    <form class="create" onsubmit={create}>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="title-input"
        placeholder="What will it answer? e.g. Weekly sales by region"
        bind:value={title}
        autofocus
        onkeydown={(e) => e.key === "Escape" && cancel()}
      />
      <div class="create-row">
        <span class="where">
          {#if slug}Saved as <code>{index.root.split("/").at(-1)}/{slug}/</code>{:else}Type a title{/if}
        </span>
        <span class="create-actions">
          <button type="button" onclick={cancel}>Cancel</button>
          <button type="submit" class="primary" disabled={!slug || busy}>Create</button>
        </span>
      </div>
      {#if error}<p class="error">{error}</p>{/if}
    </form>
  {/if}

  <ul bind:this={list}>
    {#each shown as b (b.name)}
      <li>
        <a class="row" href="#/nb/{encodeURIComponent(b.name)}">
          <span class="main">
            <span class="title">{b.title}</span>
            {#if b.problem}
              <span class="problem">Doesn't load: {b.problem}</span>
            {:else if b.description}
              <span class="desc">{b.description}</span>
            {/if}
          </span>
          <span class="contents">{contents(b)}</span>
          <span class="edited" title={b.modified ? new Date(b.modified).toLocaleString() : ""}>{edited(b.modified)}</span>
        </a>
      </li>
    {/each}
  </ul>

  {#if !books.length}
    <div class="empty">
      <p>No notebooks yet.</p>
      <p class="muted">A notebook mixes SQL run by basalt, Python and notes, one file per cell.</p>
      <button class="primary" onclick={() => (creating = true)}>Create the first one</button>
    </div>
  {:else if !shown.length}
    <p class="none">No notebooks match “{query}”.</p>
  {/if}

</div>

<style>
  .page {
    max-width: 55rem;
    margin: 0 auto;
    padding: 3.5rem 1.5rem 7.5rem;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1.25rem;
  }
  h1 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .count {
    font-size: 0.875rem;
    font-weight: 400;
    color: var(--muted);
    margin-left: 0.25rem;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    height: 1.875rem;
    padding: 0 0.375rem 0 0.5625rem;
    border: 1px solid var(--hair);
    border-radius: 6px;
    background: var(--surface);
    color: var(--muted);
    transition: border-color 0.12s var(--ease);
  }
  .search:focus-within {
    border-color: var(--ring);
  }
  .search input {
    border: 0;
    outline: 0;
    background: none;
    padding: 0;
    width: 11.25rem;
    font-size: 0.8125rem;
  }
  .search input:focus {
    outline: none;
  }
  .search kbd {
    opacity: 0.8;
  }
  .new,
  .primary {
    height: 1.875rem;
    padding: 0 0.75rem;
    border-radius: 6px;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--page);
    background: var(--ink);
  }
  .new:hover,
  .primary:hover {
    color: var(--page);
    background: var(--ink-2);
  }

  .create {
    margin-bottom: 1.25rem;
    padding: 0.875rem 0.875rem 0.625rem;
    border: 1px solid var(--hair);
    border-radius: 8px;
    background: var(--surface);
  }
  .title-input {
    width: 100%;
    border: 0;
    padding: 0;
    font-size: 1rem;
    background: none;
    outline: none;
  }
  .title-input:focus {
    outline: none;
  }
  .create-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.75rem;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .create-actions {
    display: flex;
    gap: 0.375rem;
  }
  .create-actions button[type="button"] {
    font-size: 0.8125rem;
  }
  .error {
    margin: 0.5rem 0 0;
    font-size: 0.8125rem;
    color: var(--critical);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--hair);
  }
  li {
    border-bottom: 1px solid var(--hair);
  }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 10.625rem 6.875rem;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 0.625rem;
    margin: 0 -0.625rem;
    border-radius: 6px;
    color: inherit;
    text-decoration: none;
    transition: background-color 0.12s var(--ease);
  }
  .row:hover,
  .row:focus-visible {
    background: var(--select-band);
    outline: none;
  }
  .row:focus-visible {
    box-shadow: inset 0 0 0 1px var(--ring);
  }
  .main {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .title {
    font-weight: 600;
  }
  .desc,
  .problem {
    font-size: 0.8125rem;
    color: var(--ink-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .problem {
    color: var(--critical);
  }
  .contents,
  .edited {
    font-size: 0.8125rem;
    color: var(--muted);
    white-space: nowrap;
  }
  .edited {
    text-align: right;
  }

  .empty {
    padding: 2.5rem 0;
  }
  .empty p {
    margin: 0 0 0.25rem;
  }
  .empty .primary {
    margin-top: 1rem;
  }
  .none {
    color: var(--muted);
    padding: 1rem 0;
  }
  @media (max-width: 720px) {
    .row {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .contents {
      display: none;
    }
    .search input {
      width: 6.875rem;
    }
  }
</style>
