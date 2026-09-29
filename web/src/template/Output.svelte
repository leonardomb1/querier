<script lang="ts">
  import type { Part } from "../../../shared/report";
  import Outputs from "../components/Outputs.svelte";
  import Spinner from "../components/Spinner.svelte";
  import { setParam, store } from "./runtime.svelte";

  // A cell's output, as the notebook shows it: all of it, or some parts (chart, table, text).
  let { cell, parts }: { cell: string; parts?: Part[] } = $props();
  const run = $derived(store.cells[cell]);
</script>

{#if run?.outputs.length}
  <Outputs {run} {cell} show={parts} params={store.paramNames} onparam={setParam} />
{:else if run?.state === "running" || run?.state === "queued" || !run}
  <div class="waiting"><Spinner size={16} /></div>
{/if}

<style>
  .waiting {
    display: grid;
    place-items: center;
    min-height: 4rem;
  }
</style>
