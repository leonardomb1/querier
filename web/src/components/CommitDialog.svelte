<script lang="ts">
  import { backdrop } from "../lib/backdrop";
  import { cubicOut } from "svelte/easing";
  import { fade, scale } from "svelte/transition";
  import { api, type CommitDetail, type Lang } from "../lib/api";
  import type { NotebookCtl } from "../lib/notebook.svelte";
  import DiffView from "./DiffView.svelte";

  let { ctl, hash, onclose }: { ctl: NotebookCtl; hash: string; onclose: () => void } = $props();

  let detail = $state<CommitDetail | null>(null);
  let error = $state("");
  // svelte-ignore state_referenced_locally
  api.git.show(ctl.name, hash).then((d) => (detail = d)).catch((e) => (error = e.message));

  const langOf = (cell: string, src: string): Lang => {
    const now = ctl.cell(cell)?.lang;
    if (now) return now;
    return /^\s*(import|from|def|print|#)/m.test(src) && !/\bSELECT\b/i.test(src) ? "python" : "sql";
  };

  async function restore(cells?: string[]) {
    const what = cells ? cells.join(", ") : "the whole notebook";
    const ok = await ctl.gitDo("Restoring", () => api.git.restore(ctl.name, hash, cells), { reload: true });
    if (ok) {
      ctl.say(`Restored ${what} from “${detail?.subject}”. Commit to keep it, or discard to undo.`);
      onclose();
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") (e.stopPropagation(), onclose());
  }
  // closes on a click on the backdrop, not on a drag that ends there (lib/backdrop.ts)
  const shut = backdrop(() => onclose());
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" transition:fade={{ duration: 140 }} {...shut} {onkeydown}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="dialog"
    role="dialog"
    aria-label="Commit"
    tabindex="-1"
    transition:scale={{ start: 0.98, duration: 160, easing: cubicOut }}
    onclick={(e) => e.stopPropagation()}
  >
    {#if error}
      <p class="error">{error}</p>
    {:else if !detail}
      <p class="muted">Reading the commit…</p>
    {:else}
      <header>
        <div>
          <h2>{detail.subject}</h2>
          <p class="meta">
            {detail.author} · {new Date(detail.date).toLocaleString()} · <code>{detail.hash.slice(0, 10)}</code>
          </p>
          {#if detail.body}<p class="body">{detail.body}</p>{/if}
        </div>
        <button class="outline" onclick={() => restore()} title="Every cell back as it was in this commit, as uncommitted changes">
          Restore notebook to this commit
        </button>
      </header>

      {#if !detail.cells.length}
        <p class="muted">No cell changed in this commit.</p>
      {/if}
      {#each detail.cells as c (c.name)}
        <section>
          <div class="cell-head">
            <code class="name">{c.name}</code>
            <span class="change {c.change}">{c.change}</span>
            <span class="spacer"></span>
            {#if c.change !== "deleted"}
              <button class="small" onclick={() => restore([c.name])}>Restore this cell</button>
            {/if}
          </div>
          <div class="sides"><span>Before</span><span>After</span></div>
          <DiffView before={c.before} after={c.after} lang={langOf(c.name, c.after || c.before)} />
        </section>
      {/each}
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: var(--scrim);
    display: grid;
    place-items: start center;
    padding: 6vh 1rem;
    overflow: auto;
  }
  .dialog {
    width: min(64rem, 100%);
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: 12px;
    box-shadow: var(--shadow-lg);
    padding: 1.5rem 1.75rem 1.75rem;
  }
  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1.5rem;
    margin-bottom: 1.25rem;
  }
  h2 {
    margin: 0;
    font-size: 1.0625rem;
    font-weight: 600;
  }
  .meta {
    margin: 0.375rem 0 0;
    font-size: 0.8125rem;
    color: var(--muted);
  }
  .body {
    margin: 0.625rem 0 0;
    font-size: 0.8125rem;
    color: var(--ink-2);
    white-space: pre-wrap;
  }
  .outline,
  .small {
    flex: none;
    border: 1px solid var(--hair);
    border-radius: 6px;
    color: var(--ink);
  }
  .outline {
    font-size: 0.8125rem;
    padding: 0.375rem 0.75rem;
  }
  .small {
    font-size: 0.75rem;
    padding: 0.2rem 0.6rem;
  }
  section {
    margin-top: 1.25rem;
  }
  .cell-head {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    margin-bottom: 0.375rem;
  }
  .name {
    font-weight: 600;
    font-size: 0.8125rem;
  }
  .change {
    font-size: 0.75rem;
  }
  .change.modified {
    color: var(--git-letter-modified);
  }
  .change.added {
    color: var(--git-letter-added);
  }
  .change.deleted {
    color: var(--git-letter-deleted);
  }
  .spacer {
    flex: 1;
  }
  .sides {
    display: grid;
    grid-template-columns: 1fr 1fr;
    font-size: 0.72rem;
    color: var(--muted);
    margin-bottom: 0.25rem;
  }
  .muted {
    color: var(--muted);
    font-size: 0.875rem;
  }
  .error {
    color: var(--critical);
  }
  code {
    font-size: 0.75rem;
  }
</style>
