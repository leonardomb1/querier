<script lang="ts">
  import type { Snippet } from "svelte";
  import { writeClipboard } from "../../lib/copy";
  import Menu from "../Menu.svelte";
  import InfoTip from "../ui/InfoTip.svelte";
  import { matches, useSettings } from "./context";

  // One setting, as VS Code draws it: "Category: Name", what it does, its control.
  // Changed from its default: a bar on the left, and Reset in its gear menu.
  let {
    id,
    category,
    label,
    description,
    info,
    modified = false,
    onreset,
    children,
  }: {
    /** e.g. "sandbox.memory": what @id: finds, and Copy Setting ID copies */
    id: string;
    category: string;
    label: string;
    description?: string;
    /** the fine print (a format, where it is kept): behind an ⓘ by the title */
    info?: string | Snippet;
    modified?: boolean;
    /** back to the default; absent when there is nothing to reset to */
    onreset?: () => void;
    children: Snippet;
  } = $props();

  const settings = useSettings();
  const shown = $derived(matches(settings.query, { id, category, label, description, modified }));

  // a change is felt: the setting flashes as it applies
  let pulse = $state(false);
  let timer: ReturnType<typeof setTimeout>;
  function changed() {
    pulse = false;
    requestAnimationFrame(() => (pulse = true));
    clearTimeout(timer);
    timer = setTimeout(() => (pulse = false), 700);
  }
</script>

<div class="setting" class:modified class:pulse class:hidden={!shown} data-setting={id} onchangecapture={changed}>
  <div class="gear">
    <Menu
      icon="gear"
      title="More actions"
      items={[
        { label: "Reset Setting", disabled: !modified || !onreset, run: () => onreset?.() },
        "-",
        { label: "Copy Setting ID", run: () => writeClipboard(id) },
      ]}
    />
  </div>
  <div class="title">
    <span class="cat">{category}:</span> <span class="name">{label}</span>
    {#if typeof info === "string"}<InfoTip text={info} label="About {label}" />{:else if info}<InfoTip label="About {label}">{@render info()}</InfoTip>{/if}
  </div>
  {#if description}<p class="what">{description}</p>{/if}
  <div class="control">{@render children()}</div>
</div>

<style>
  .setting {
    position: relative;
    padding: 0.625rem 2.25rem 0.875rem 1.25rem;
    border-radius: 0;
  }
  .setting.hidden {
    display: none;
  }
  .setting.pulse {
    animation: pulse 0.7s var(--ease);
  }
  @keyframes pulse {
    from {
      background: color-mix(in srgb, var(--wb-accent) 16%, transparent);
    }
  }
  .setting:hover,
  .setting:focus-within {
    background: color-mix(in srgb, var(--wb-fg) 4%, transparent);
  }
  /* VS Code's mark for a setting changed from its default */
  .setting.modified::before {
    content: "";
    position: absolute;
    left: 0.375rem;
    top: 0.625rem;
    bottom: 0.875rem;
    width: 2px;
    background: var(--wb-accent);
  }
  .gear {
    position: absolute;
    top: 0.375rem;
    left: -1.375rem;
    opacity: 0;
  }
  .setting:hover .gear,
  .setting:focus-within .gear,
  .setting:has(:global(:popover-open)) .gear {
    opacity: 1;
  }
  .gear :global(button.icon) {
    width: 1.375rem;
    height: 1.375rem;
    color: var(--wb-fg-muted);
  }
  .title {
    font-size: 0.8125rem;
    color: var(--wb-fg);
  }
  .cat {
    color: var(--wb-fg-muted);
  }
  .name {
    font-weight: 600;
  }
  .what {
    margin: 0.25rem 0 0;
    max-width: 52rem;
    font-size: 0.8125rem;
    line-height: 1.45;
    color: var(--wb-fg-muted);
  }
  .control {
    margin-top: 0.5rem;
  }
</style>
