<script lang="ts">
  import type { Output } from "../lib/conn.svelte";
  import { duration, sentence, thousands } from "../lib/loadtext";

  type Load = Extract<Output, { type: "load" }>;
  type Totals = Extract<Output, { type: "loads" }>;
  let { loads, totals }: { loads: Load[]; totals?: Totals } = $props();

  const SHOWN = 20;
  // like the CLI: a line per load only when there are several, or one failed
  const itemized = $derived(loads.length > 1 || loads.some((l) => !l.ok));
  // every failure, and the first successes, when a FOR EACH loads hundreds
  const visible = $derived.by(() => {
    const failed = loads.filter((l) => !l.ok);
    const ok = loads.filter((l) => l.ok).slice(0, Math.max(0, SHOWN - failed.length));
    const keep = new Set([...failed, ...ok]);
    return loads.filter((l) => keep.has(l));
  });
  const hidden = $derived(loads.length - visible.length);
  const pad = $derived(Math.min(40, Math.max(...visible.map((l) => [...l.target].length))));
  const closing = $derived(totals ? sentence(totals, loads.length === 1 ? loads[0].target : undefined) : null);
</script>

<div class="report">
  {#if itemized}
    {#each visible as l (l.load)}
      {#if l.ok}
        <div><span class="ok">+</span> {l.target.padEnd(pad)}  <span class="num">{thousands(l.rows_written).padStart(13)} rows  {duration(l.elapsed_ms).padStart(7)}</span></div>
      {:else}
        <div><span class="bad">x</span> {l.target}  <span class="why">{l.reason}</span></div>
      {/if}
    {/each}
    {#if hidden}<div class="dim">  … and {hidden.toLocaleString()} more loaded</div>{/if}
  {/if}
  {#if closing}
    <div class="closing">{closing.text}</div>
    {#if closing.failed}<div class="bad">{closing.failed}</div>{/if}
  {/if}
</div>

<style>
  .report {
    font: 0.78rem/1.6 var(--mono);
    white-space: pre;
    overflow-x: auto;
    color: var(--ink);
  }
  .ok {
    color: var(--good);
  }
  .bad {
    color: var(--critical);
  }
  .why,
  .dim {
    color: var(--muted);
  }
  .why {
    white-space: normal;
  }
  .closing {
    color: var(--ink-2);
  }
</style>
