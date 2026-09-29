<script lang="ts">
  import type { Output } from "../lib/conn.svelte";
  import { arrowTable } from "../lib/format";
  import Grid from "../components/Table.svelte";
  import Spinner from "../components/Spinner.svelte";
  import { store } from "./runtime.svelte";

  // A cell's result table: sortable, selectable, copyable; `columns` picks and orders them.
  let { cell, columns }: { cell: string; columns?: string[] } = $props();
  const run = $derived(store.cells[cell]);
  const result = $derived(run?.outputs.findLast((o): o is Extract<Output, { type: "table" }> => o.type === "table" && o.name === cell));
  const table = $derived.by(() => {
    if (!result) return null;
    const t = arrowTable(result.arrow);
    const keep = columns?.filter((c) => t.schema.fields.some((f) => f.name === c));
    return keep?.length ? t.select(keep) : t;
  });
</script>

{#if table}
  <Grid {table} />
{:else if !run || run.state === "running" || run.state === "queued"}
  <div class="waiting"><Spinner size={16} /></div>
{/if}

<style>
  .waiting {
    display: grid;
    place-items: center;
    min-height: 4rem;
  }
</style>
