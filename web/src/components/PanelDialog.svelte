<script lang="ts">
  import { untrack } from "svelte";
  import { backdrop } from "../lib/backdrop";
  import { cubicOut } from "svelte/easing";
  import { fade, scale } from "svelte/transition";
  import type { Report } from "../lib/api";
  import { session } from "../lib/session.svelte";
  import Icon from "./Icon.svelte";

  // The report's side panel: another site (a chat, a form) a button at the
  // report's corner opens beside it.
  let {
    panel,
    onchange,
    onclose,
  }: { panel: Report["panel"]; onchange: (panel: Report["panel"] | null) => void; onclose: () => void } = $props();

  // the form starts from the panel as it is
  let url = $state(untrack(() => panel?.url ?? ""));
  let title = $state(untrack(() => panel?.title ?? ""));
  const origin = $derived.by(() => {
    try {
      const u = new URL(url.trim());
      return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
    } catch {
      return null;
    }
  });
  const allowed = $derived(origin != null && session.embedSites.includes(origin));

  function save(e: SubmitEvent) {
    e.preventDefault();
    if (!origin) return;
    onchange({ url: url.trim(), ...(title.trim() ? { title: title.trim() } : {}) });
    onclose();
  }
  function remove() {
    onchange(null);
    onclose();
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
  <div class="dialog" role="dialog" aria-label="Side panel" tabindex="-1" transition:scale={{ start: 0.97, duration: 160, easing: cubicOut }} onclick={(e) => e.stopPropagation()}>
  <form onsubmit={save}>
    <header>
      <h2>Side panel</h2>
      <button type="button" class="icon" aria-label="Close" onclick={onclose}><Icon name="x" /></button>
    </header>
    <p class="lede">Another site beside the report, such as a chat or a form, opened from a button at its corner. It shows on public links too.</p>

    <label>
      <span>Address</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input bind:value={url} placeholder="https://chat.example.com/embed" spellcheck="false" autofocus />
    </label>
    <label>
      <span>Title <span class="muted">(optional)</span></span>
      <input bind:value={title} maxlength="60" placeholder={origin ? new URL(origin).host : "Chat"} />
    </label>

    {#if url.trim() && !origin}
      <p class="note bad">An http or https address.</p>
    {:else if origin && !allowed}
      <p class="note warn">
        <Icon name="warning" size={14} /><span
          >An administrator has to allow <code>{origin}</code> (Administration → Sign-in → Sites reports may show). Until then only those who can change
          the report see the button.</span
        >
      </p>
    {/if}
    {#if origin}
      <p class="note muted"><span>The site has to allow being framed by Querier ({location.origin}): its <code>Content-Security-Policy: frame-ancestors</code>.</span></p>
    {/if}

    <footer>
      {#if panel}<button type="button" class="danger" onclick={remove}>Remove</button>{/if}
      <span class="grow"></span>
      <button type="button" onclick={onclose}>Cancel</button>
      <button class="primary" type="submit" disabled={!origin}>Save</button>
    </footer>
  </form>
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
    padding-top: 10vh;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .dialog {
    width: min(32rem, calc(100vw - 2rem));
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: 12px;
    box-shadow: var(--shadow-lg);
    padding: 1.25rem 1.5rem 1.25rem;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h2 {
    margin: 0;
    font-size: 1.0625rem;
    font-weight: 600;
  }
  .lede {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--ink-2);
    line-height: 1.55;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: var(--ink-2);
  }
  input {
    height: 2rem;
    padding: 0 0.625rem;
    font: 0.8125rem var(--sans);
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: 6px;
  }
  input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .note {
    display: flex;
    gap: 0.375rem;
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.5;
  }
  .note :global(.codicon) {
    flex: none;
    margin-top: 0.125rem;
  }
  .warn {
    color: var(--warning);
  }
  .bad {
    color: var(--danger, #d14);
  }
  .muted {
    color: var(--muted);
  }
  code {
    font-size: 0.72rem;
  }
  footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }
  .grow {
    flex: 1;
  }
  footer button {
    height: 1.875rem;
    padding: 0 0.875rem;
  }
  .danger {
    color: var(--danger, #d14);
  }
</style>
