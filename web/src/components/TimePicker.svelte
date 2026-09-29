<script lang="ts">
  import { describe, paramText, PRESETS, resolve, type Range } from "../lib/timerange";
  import Icon from "./Icon.svelte";

  // Grafana's time picker: presets on the left, an absolute range on the right.
  let { range, onchange }: { range: Range; onchange: (r: Range) => void } = $props();

  const id = `time-${Math.random().toString(36).slice(2, 8)}`;
  let button: HTMLButtonElement;
  let pop: HTMLDivElement;
  let from = $state("");
  let to = $state("");

  // the <input type=datetime-local> spelling of an end
  const local = (spec: string, end: boolean) => paramText(resolve(spec, new Date(), end), "TIMESTAMP").replace(" ", "T").slice(0, 16);

  function ontoggle(e: ToggleEvent) {
    if (e.newState !== "open") return;
    from = local(range.from, false);
    to = local(range.to, true);
    const b = button.getBoundingClientRect();
    pop.style.top = `${b.bottom + 4}px`;
    pop.style.left = `${Math.max(8, Math.min(b.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 8))}px`;
  }

  function pick(r: Range) {
    pop.hidePopover();
    onchange(r);
  }

  function apply(e: SubmitEvent) {
    e.preventDefault();
    if (!from || !to) return;
    pick({ from: from.replace("T", " ") + ":00", to: to.replace("T", " ") + ":59" });
  }
</script>

<button class="picker" popovertarget={id} bind:this={button} title="Time range">
  <Icon name="clock" size={14} />
  <span>{describe(range)}</span>
</button>
<div class="pop" {id} popover="auto" bind:this={pop} {ontoggle}>
  <ul>
    {#each PRESETS as [label, r]}
      <li>
        <button class:on={r.from === range.from && r.to === range.to} onclick={() => pick(r)}>{label}</button>
      </li>
    {/each}
  </ul>
  <form onsubmit={apply}>
    <h4>Absolute range</h4>
    <label>From <input type="datetime-local" bind:value={from} /></label>
    <label>To <input type="datetime-local" bind:value={to} /></label>
    <button type="submit" class="apply">Apply</button>
    <p>Drag across a time series to zoom into a range.</p>
  </form>
</div>

<style>
  .picker {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    height: 1.875rem;
    padding: 0 0.625rem;
    font-size: 0.8125rem;
    color: var(--ink);
    border: 1px solid var(--hair);
    border-radius: 6px;
    background: var(--surface);
  }
  .pop {
    position: fixed;
    inset: auto;
    margin: 0;
    padding: 0.5rem;
    border: 1px solid var(--hair);
    border-radius: 8px;
    background: var(--surface);
    color: var(--ink);
    box-shadow: var(--shadow-lg);
  }
  .pop:popover-open {
    display: flex;
    gap: 0.75rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0 0.5rem 0 0;
    border-right: 1px solid var(--hair);
    min-width: 11rem;
  }
  li button {
    width: 100%;
    text-align: left;
    font-size: 0.8125rem;
    padding: 0.3rem 0.5rem;
    color: var(--ink-2);
  }
  li button.on {
    color: var(--ink);
    background: var(--pressed);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.25rem 0.25rem 0.25rem 0;
    min-width: 14rem;
  }
  h4 {
    margin: 0;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--ink-2);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.72rem;
    color: var(--muted);
  }
  label input {
    height: 1.875rem;
    font-size: 0.8125rem;
  }
  .apply {
    align-self: flex-start;
    font-size: 0.8125rem;
    padding: 0.3rem 0.875rem;
    border-radius: 6px;
    color: var(--page);
    background: var(--ink);
  }
  .apply:hover {
    color: var(--page);
    background: var(--ink-2);
  }
  p {
    margin: 0.25rem 0 0;
    font-size: 0.72rem;
    color: var(--muted);
    max-width: 14rem;
  }
</style>
