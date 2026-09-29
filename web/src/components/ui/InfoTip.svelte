<script lang="ts">
  import type { Snippet } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { fly } from "svelte/transition";
  import Icon from "../Icon.svelte";

  // An ⓘ that tells more on hover or focus: the fine print (a format, where a
  // thing is kept) out of the way until it is wanted. The tip is put on <body>,
  // so no scrolling panel cuts it off.
  let { text, children, label = "More information" }: { text?: string; children?: Snippet; label?: string } = $props();

  let open = $state(false);
  let button = $state<HTMLButtonElement>();
  let pos = $state({ left: 0, top: 0, above: false });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const id = `tip-${Math.random().toString(36).slice(2, 8)}`;

  function show(now = false) {
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        const r = button!.getBoundingClientRect();
        const above = r.bottom + 120 > innerHeight;
        pos = { left: Math.max(8, Math.min(r.left + r.width / 2 - 140, innerWidth - 288)), top: above ? r.top - 6 : r.bottom + 6, above };
        open = true;
      },
      now ? 0 : 250,
    );
  }
  function hide() {
    clearTimeout(timer);
    open = false;
  }
  const portal = (node: HTMLElement) => {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  };
</script>

<button
  bind:this={button}
  type="button"
  class="info"
  aria-label={label}
  aria-describedby={open ? id : undefined}
  onpointerenter={() => show()}
  onpointerleave={hide}
  onfocus={() => show(true)}
  onblur={hide}
  onclick={() => (open ? hide() : show(true))}
  onkeydown={(e) => e.key === "Escape" && open && (e.stopPropagation(), hide())}
>
  <Icon name="info" size={14} />
</button>

{#if open}
  <div use:portal {id} role="tooltip" class="tip" class:above={pos.above} style:left="{pos.left}px" style:top="{pos.top}px" transition:fly={{ y: pos.above ? 3 : -3, duration: 110, easing: cubicOut }}>
    {#if children}{@render children()}{:else}{text}{/if}
  </div>
{/if}

<style>
  .info {
    display: inline-grid;
    place-items: center;
    width: 1.125rem;
    height: 1.125rem;
    padding: 0;
    vertical-align: -0.1875rem;
    color: var(--wb-fg-dim);
    border-radius: 3px;
  }
  .info:hover,
  .info:focus-visible {
    color: var(--wb-fg);
    background: var(--wb-list-hover);
    outline: none;
  }
  .info:active {
    transform: none;
  }
  .tip {
    position: fixed;
    z-index: 1100;
    width: max-content;
    max-width: 17.5rem;
    padding: 0.4375rem 0.625rem;
    font-size: 0.75rem;
    line-height: 1.45;
    color: var(--wb-fg);
    background: var(--wb-editor);
    border: 1px solid var(--wb-input-border);
    border-radius: 5px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22);
    pointer-events: none;
  }
  .tip.above {
    transform: translateY(-100%);
  }
  .tip :global(code) {
    font-size: 0.7rem;
  }
</style>
