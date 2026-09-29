<script lang="ts" module>
  export interface MenuItem {
    label: string;
    hint?: string;
    danger?: boolean;
    disabled?: boolean;
    run: () => void;
  }
  let nextId = 0;
</script>

<script lang="ts">
  import Icon, { type IconName } from "./Icon.svelte";

  let {
    items,
    title = "More",
    label,
    icon = "more",
    trigger = true,
  }: {
    items: (MenuItem | "-")[];
    title?: string;
    label?: string;
    icon?: IconName;
    /** false: no button; the menu opens where `openAt` says (a context menu) */
    trigger?: boolean;
  } = $props();

  // A native popover lives in the top layer: no ancestor's overflow can clip it.
  // It is placed under its button by hand, flipping up when there is no room.
  const id = `menu-${nextId++}`;
  let button = $state<HTMLButtonElement>();
  let pop: HTMLDivElement;
  /** where a context menu was asked for */
  let point: { x: number; y: number } | null = null;

  /** Open at a point on the screen (a right click), as VS Code's context menus. */
  export function openAt(x: number, y: number) {
    point = { x, y };
    pop.showPopover();
  }

  function place() {
    if (point || !button) {
      const { x, y } = point ?? { x: 0, y: 0 };
      pop.style.top = `${Math.max(8, Math.min(y, innerHeight - pop.offsetHeight - 8))}px`;
      pop.style.left = `${Math.max(8, Math.min(x, innerWidth - pop.offsetWidth - 8))}px`;
      return;
    }
    const b = button.getBoundingClientRect();
    const h = pop.offsetHeight;
    const w = pop.offsetWidth;
    const below = b.bottom + 4 + h <= innerHeight - 8;
    pop.style.top = `${below ? b.bottom + 4 : Math.max(8, b.top - 4 - h)}px`;
    pop.style.left = `${Math.max(8, Math.min(b.right - w, innerWidth - w - 8))}px`;
  }

  function ontoggle(e: ToggleEvent) {
    if (e.newState !== "open") return;
    place();
    pop.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = [...pop.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
  }
</script>

<svelte:window onscroll={() => pop?.matches(":popover-open") && pop.hidePopover()} onresize={() => pop?.matches(":popover-open") && place()} />

{#if trigger}
  <button class={label ? "text" : "icon"} {title} aria-label={title} popovertarget={id} bind:this={button} onclick={() => (point = null)}>
    {#if label}{label}{:else}<Icon name={icon} size={icon === "more" ? 16 : 14} />{/if}
  </button>
{/if}
<div class="pop" {id} popover="auto" role="menu" tabindex="-1" bind:this={pop} {ontoggle} {onkeydown}>
  {#each items as item}
    {#if item === "-"}
      <hr />
    {:else}
      <button
        role="menuitem"
        class:danger={item.danger}
        disabled={item.disabled}
        onclick={() => {
          pop.hidePopover();
          item.run();
        }}
      >
        <span>{item.label}</span>
        {#if item.hint}<kbd>{item.hint}</kbd>{/if}
      </button>
    {/if}
  {/each}
</div>

<style>
  .text {
    font-size: 0.8125rem;
    padding: 0.25rem 0.5rem;
    color: var(--ink);
  }
  .pop {
    position: fixed;
    inset: auto;
    margin: 0;
    min-width: 11.75rem;
    /* VS Code's context menu */
    color: var(--wb-fg);
    background: var(--wb-editor);
    border: 1px solid var(--wb-input-border);
    border-radius: 5px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.36);
    padding: 0.25rem;
    /* here, not only while open: closing, it stays shown (as flex) for the fade,
       and a column only while open would lay the items out in a row meanwhile */
    flex-direction: column;
    opacity: 0;
    transform: translateY(-0.25rem) scale(0.98);
    transform-origin: top right;
    transition:
      opacity 0.12s var(--ease),
      transform 0.12s var(--ease),
      overlay 0.12s allow-discrete,
      display 0.12s allow-discrete;
  }
  .pop:popover-open {
    display: flex;
    opacity: 1;
    transform: none;
  }
  @starting-style {
    .pop:popover-open {
      opacity: 0;
      transform: translateY(-0.25rem) scale(0.98);
    }
  }
  .pop button {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1.5rem;
    white-space: nowrap;
    text-align: left;
    min-height: 1.625rem;
    padding: 0 0.75rem;
    font-size: 0.8125rem;
    color: var(--wb-fg);
    border-radius: 3px;
  }
  .pop button:hover,
  .pop button:focus-visible {
    outline: none;
    color: #fff;
    background: var(--wb-accent);
  }
  .pop button:active {
    transform: none;
  }
  .pop button.danger {
    color: var(--critical);
  }
  .pop button:disabled {
    display: none;
  }
  kbd {
    font: 0.72rem var(--sans);
    color: inherit;
    opacity: 0.7;
    background: none;
    border: 0;
    padding: 0;
  }
  hr {
    border: 0;
    border-top: 1px solid var(--wb-input-border);
    margin: 0.25rem 0.5rem;
  }
</style>
