<script lang="ts">
  import Icon from "./Icon.svelte";

  // A side bar section's header, VS Code's: a chevron that folds it, an icon, what it
  // holds, and a count (or a warning) on the right.
  let {
    label,
    icon,
    open,
    ontoggle,
    count = "",
    warn = false,
  }: { label: string; icon: string; open: boolean; ontoggle: () => void; count?: string | number; warn?: boolean } = $props();
</script>

<button class="head" onclick={ontoggle} aria-expanded={open}>
  <span class="chev" class:open><Icon name="chevron-right" size={14} /></span>
  <Icon name={icon} size={14} />
  <span class="label">{label}</span>
  {#if count !== ""}<span class="count" class:warn>{count}</span>{/if}
</button>

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    width: 100%;
    height: 1.625rem;
    margin: 0 0 0.125rem;
    padding: 0 0.25rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--wb-fg, var(--ink));
  }
  .head:active {
    transform: none;
  }
  .head :global(i) {
    color: var(--wb-fg-muted, var(--muted));
  }
  .chev {
    display: flex;
    transition: transform 0.12s var(--ease);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .label {
    flex: 1;
    text-align: left;
  }
  .count {
    font-weight: 400;
    font-size: 0.72rem;
    color: var(--wb-fg-muted, var(--muted));
  }
  .count.warn {
    color: var(--stale);
  }
</style>
