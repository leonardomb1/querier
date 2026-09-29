<script lang="ts">
  import { params, setParam } from "./runtime.svelte";

  // A PARAM's control inside the template: a text box, or a dropdown of `options`.
  let { param, label, options }: { param: string; label?: string; options?: (string | number)[] } = $props();
  const value = $derived(params[param]);
</script>

<label class="control">
  <span>{label ?? param}</span>
  {#if options}
    <select {value} onchange={(e) => setParam(param, e.currentTarget.value)}>
      <option value="">All</option>
      {#each options as o}<option value={String(o)}>{o}</option>{/each}
    </select>
  {:else}
    <input {value} onchange={(e) => setParam(param, e.currentTarget.value)} spellcheck="false" />
  {/if}
</label>

<style>
  .control {
    display: inline-flex;
    align-items: center;
    height: 1.875rem;
    border: 1px solid var(--hair);
    border-radius: 6px;
    background: var(--surface);
    overflow: hidden;
  }
  .control > span {
    align-self: stretch;
    display: flex;
    align-items: center;
    padding: 0 0.5rem;
    font: 0.75rem var(--mono);
    color: var(--muted);
    background: var(--select-band);
    border-right: 1px solid var(--hair);
  }
  input,
  select {
    border: 0;
    border-radius: 0;
    height: 100%;
    font: 0.8125rem var(--mono);
    padding: 0 0.5rem;
    background: none;
    color: var(--ink);
  }
</style>
