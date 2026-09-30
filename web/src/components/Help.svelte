<script lang="ts">
  import { backdrop } from "../lib/backdrop";
  import { fade, scale } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  let { onclose }: { onclose: () => void } = $props();

  const groups: [string, [string, string][]][] = [
    [
      "Anywhere",
      [
        ["ctrl+k", "command palette"],
        ["ctrl+b", "sidebar"],
        ["ctrl+shift+enter", "run all"],
        ["shift+enter", "run with what it needs, next cell"],
        ["ctrl+enter", "run, stay"],
        ["ctrl+= / ctrl+- / ctrl+0", "zoom in / out / reset"],
      ],
    ],
    [
      "In the editor",
      [
        ["tab / ctrl+space", "suggest, accept a suggestion"],
        ["ctrl+/", "comment lines"],
        ["ctrl+f", "find and replace"],
        ["alt+click, ctrl+d", "more cursors, select next match"],
        ["ctrl+shift+[ / ]", "fold / unfold"],
      ],
    ],
    [
      "Command mode (esc)",
      [
        ["j / k  ↓ / ↑", "next / previous cell"],
        ["enter", "edit the cell"],
        ["a / b", "new cell above / below"],
        ["y / p / m", "make it SQL / Python / Markdown"],
        ["J / K", "move cell down / up"],
        ["h / o", "hide code / output"],
        ["d d", "delete"],
        ["i i", "stop"],
        ["0 0", "restart kernel"],
        ["?", "this list"],
      ],
    ],
  ];
  // closes on a click on the backdrop, not on a drag that ends there (lib/backdrop.ts)
  const shut = backdrop(() => onclose());
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" transition:fade={{ duration: 140 }} {...shut}>
  <div class="help" transition:scale={{ start: 0.97, duration: 160, easing: cubicOut }} role="dialog" aria-label="keyboard shortcuts">
    {#each groups as [title, keys]}
      <h4>{title}</h4>
      {#each keys as [k, what]}
        <div class="row"><span>{what}</span><kbd>{k}</kbd></div>
      {/each}
    {/each}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: var(--scrim);
    display: grid;
    place-items: center;
  }
  .help {
    width: min(26.25rem, calc(100vw - 2rem));
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: 12px;
    box-shadow: var(--shadow-lg);
    padding: 0.75rem 1.125rem 1rem;
  }
  h4 {
    margin: 0.625rem 0 0.375rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--muted);
  }
  .row {
    display: flex;
    justify-content: space-between;
    padding: 0.1875rem 0;
    font-size: 0.8125rem;
    color: var(--ink-2);
  }
</style>
