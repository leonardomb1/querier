<script lang="ts">
  import { cubicOut } from "svelte/easing";
  import { fade, scale } from "svelte/transition";
  import type { Report } from "../lib/api";
  import { session } from "../lib/session.svelte";
  import Icon from "./Icon.svelte";

  // Another site beside the report (a chat, a form): a button at the report's
  // corner opens it in a panel. It is framed here, outside the report's sandbox,
  // so it keeps its own origin, cookies and storage — hence only sites an
  // administrator allows. One that isn't allowed shows nothing to viewers, and
  // tells those who may change the report why.
  let { panel, editor = false }: { panel: NonNullable<Report["panel"]>; editor?: boolean } = $props();

  let open = $state(false);
  const allowed = $derived(session.embeddable(panel.url));
  const origin = $derived.by(() => {
    try {
      return new URL(panel.url).origin;
    } catch {
      return panel.url;
    }
  });
  const title = $derived(panel.title || new URL(origin).host);

  function onkeydown(e: KeyboardEvent) {
    if (open && e.key === "Escape") (e.stopPropagation(), (open = false));
  }
</script>

{#if allowed || editor}
  <div class="side" role="presentation" {onkeydown}>
    {#if open}
      <aside class="panel" class:short={!allowed} aria-label={title} transition:scale={{ start: 0.96, duration: 140, easing: cubicOut, opacity: 0 }}>
        <header>
          <b title={panel.url}>{title}</b>
          {#if allowed}
            <a class="icon" href={panel.url} target="_blank" rel="noopener noreferrer" title="Open in a new tab" aria-label="Open in a new tab"><Icon name="link-external" size={14} /></a>
          {/if}
          <button class="icon" onclick={() => (open = false)} title="Close (Esc)" aria-label="Close"><Icon name="x" size={14} /></button>
        </header>
        {#if allowed}
          <iframe
            src={panel.url}
            {title}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
            allow="clipboard-write"
            referrerpolicy="strict-origin-when-cross-origin"
          ></iframe>
        {:else}
          <p class="blocked">
            <Icon name="warning" size={16} />
            <span
              >An administrator has to allow <code>{origin}</code> before the report can show it (Administration → Sign-in → Sites reports may
              show). Until then its viewers don't see this button.</span
            >
          </p>
        {/if}
      </aside>
    {/if}
    <button class="bubble" class:off={!allowed} onclick={() => (open = !open)} title={open ? "Close" : title} aria-label={title} aria-expanded={open}>
      <span transition:fade={{ duration: 100 }}><Icon name={open ? "x" : "comment-discussion"} size={20} /></span>
    </button>
  </div>
{/if}

<style>
  /* the report's height, so the panel never runs past its top */
  .side {
    position: absolute;
    top: 1rem;
    right: 1.25rem;
    bottom: 1.25rem;
    z-index: 20;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    align-items: flex-end;
    gap: 0.75rem;
    pointer-events: none;
  }
  .side > * {
    pointer-events: auto;
  }
  .bubble {
    flex: none;
    display: grid;
    place-items: center;
    width: 3rem;
    height: 3rem;
    padding: 0;
    color: #fff;
    background: var(--accent);
    border-radius: 50%;
    box-shadow: var(--shadow-lg);
    transition: transform 0.12s ease;
  }
  .bubble:hover {
    transform: scale(1.06);
  }
  .bubble.off {
    color: var(--ink-2);
    background: var(--surface);
    border: 1px dashed var(--hair);
  }
  .panel {
    display: flex;
    flex-direction: column;
    flex: 0 1 40rem;
    min-height: 0;
    width: min(26rem, calc(100vw - 2.5rem));
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: 12px;
    box-shadow: var(--shadow-lg);
    overflow: hidden;
    transform-origin: bottom right;
  }
  .panel.short {
    flex: none;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    height: 2.5rem;
    padding: 0 0.5rem 0 0.875rem;
    flex: none;
    border-bottom: 1px solid var(--hair);
  }
  header b {
    flex: 1;
    min-width: 0;
    font-size: 0.8125rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  header .icon {
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
    color: var(--ink-2);
    border-radius: 4px;
  }
  header .icon:hover {
    color: var(--ink);
    background: var(--hover);
  }
  iframe {
    flex: 1;
    width: 100%;
    border: 0;
    background: var(--surface);
  }
  .blocked {
    display: flex;
    gap: 0.5rem;
    margin: 1rem;
    font-size: 0.8125rem;
    line-height: 1.5;
    color: var(--ink-2);
  }
  .blocked :global(svg),
  .blocked :global(.codicon) {
    flex: none;
    color: var(--warning);
  }
</style>
