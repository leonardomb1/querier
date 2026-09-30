<script lang="ts">
  import { backdrop } from "../../lib/backdrop";
  import { onMount, type Snippet } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { fade, scale } from "svelte/transition";
  import Icon from "../Icon.svelte";

  // A panel over the editors, as VS Code's modal editors (Settings, Keyboard
  // Shortcuts): a title bar with its icon, name and actions (open it as a tab,
  // maximize, close), and its content below. It pops in; Escape or a click
  // outside closes it.
  let {
    icon,
    title,
    onclose,
    oneditor,
    status,
    detail,
    compact = false,
    children,
  }: {
    icon: string;
    title: string;
    onclose: () => void;
    /** open the same thing as an editor tab instead */
    oneditor?: () => void;
    /** a short state on the title bar's right (saved, an error) */
    status?: Snippet;
    /** muted after the title: where it is (a path) */
    detail?: string;
    /** a dialog's size, not an editor's: as tall as its content */
    compact?: boolean;
    children: Snippet;
  } = $props();

  let max = $state(false);
  let panel = $state<HTMLDivElement>();
  onMount(() => panel?.focus());
  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") (e.stopPropagation(), onclose());
  }
  // closes on a click on the backdrop, not on a drag that ends there (lib/backdrop.ts)
  const shut = backdrop(() => onclose());
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" transition:fade={{ duration: 120 }} {...shut}>
  <div
    class="overlay"
    class:max
    class:compact
    role="dialog"
    aria-label={title}
    tabindex="-1"
    bind:this={panel}
    {onkeydown}
    onclick={(e) => e.stopPropagation()}
    transition:scale={{ start: 0.97, duration: 160, easing: cubicOut, opacity: 0 }}
  >
    <header>
      <span class="ic"><Icon name={icon} size={16} /></span>
      <span class="title">{title}</span>
      {#if detail}<span class="detail">{detail}</span>{/if}
      <span class="status">{@render status?.()}</span>
      <span class="acts">
        {#if oneditor}
          <button class="icon" title="Open in the Editor" aria-label="Open in the editor" onclick={oneditor}><Icon name="go-to-file" size={16} /></button>
        {/if}
        {#if !compact}
          <button class="icon" title={max ? "Restore" : "Maximize"} aria-label={max ? "Restore" : "Maximize"} onclick={() => (max = !max)}>
            <Icon name={max ? "screen-normal" : "screen-full"} size={16} />
          </button>
        {/if}
        <button class="icon" title="Close  (Escape)" aria-label="Close" onclick={onclose}><Icon name="close" size={16} /></button>
      </span>
    </header>
    <div class="content">{@render children()}</div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: start center;
    padding-top: 3.25rem;
    background: color-mix(in srgb, #000 18%, transparent);
  }
  .overlay {
    display: flex;
    flex-direction: column;
    width: min(64rem, calc(100vw - 4rem));
    height: min(44rem, calc(100vh - 6rem));
    color: var(--wb-fg);
    background: var(--wb-editor);
    border: 1px solid var(--wb-input-border);
    border-radius: 8px;
    box-shadow:
      0 12px 32px rgba(0, 0, 0, 0.36),
      0 2px 6px rgba(0, 0, 0, 0.2);
    overflow: hidden;
    outline: none;
    transition:
      width 0.18s var(--ease),
      height 0.18s var(--ease);
  }
  .overlay.compact {
    width: min(40rem, calc(100vw - 2rem));
    height: auto;
    max-height: min(40rem, calc(100vh - 6rem));
  }
  .overlay.max {
    width: calc(100vw - 2rem);
    height: calc(100vh - 4.25rem);
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    height: 2.25rem;
    padding: 0 0.375rem 0 0.75rem;
    flex: none;
    font-size: 0.8125rem;
    border-bottom: 1px solid var(--wb-border);
    background: var(--wb-bar);
  }
  .ic {
    display: flex;
    color: var(--wb-fg-muted);
  }
  .title {
    font-weight: 500;
    white-space: nowrap;
  }
  .detail {
    min-width: 0;
    font-size: 0.75rem;
    color: var(--wb-fg-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .status {
    margin-left: auto;
    display: flex;
    align-items: center;
  }
  .acts {
    display: flex;
    gap: 2px;
  }
  .acts button {
    width: 1.625rem;
    height: 1.625rem;
    color: var(--wb-fg-muted);
    border-radius: 5px;
  }
  .acts button:hover {
    color: var(--wb-fg);
    background: var(--wb-list-hover);
  }
  .content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
</style>
