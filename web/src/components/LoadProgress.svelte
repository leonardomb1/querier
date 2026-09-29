<script lang="ts">
  import type { Progress } from "../lib/conn.svelte";
  import { clock, rate, thousands } from "../lib/loadtext";

  // basalt's CLI line: `⠹ [3/12] erp.dbo.SC5010 → sr.bronze.sc5010  1,204,112 rows  48.3k rows/s  0:24`
  let { progress, onstop }: { progress: Progress; onstop?: () => void } = $props();

  // The CLI's braille frames, drawn as dots: fonts without braille glyphs
  // (most UI and code faces) would fall back to something tiny.
  const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  // braille dot n → bit n-1; dots 1-3 run down the left column, 4-6 the right.
  // The frames are six-dot braille, so the cell is two columns by three rows.
  const DOTS: [number, number][] = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]];
  const dotsOf = (ch: string) => DOTS.filter((_, i) => (ch.charCodeAt(0) - 0x2800) & (1 << i));

  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 100);
    return () => clearInterval(t);
  });

  const lit = $derived(dotsOf(FRAMES[Math.floor(now / 100) % FRAMES.length]));
  const elapsed = $derived(progress.elapsed_ms + Math.max(0, now - progress.at));
  const loop = $derived(progress.loop_total ? `[${Math.min((progress.loop_done ?? 0) + 1, progress.loop_total)}/${progress.loop_total}]` : "");
</script>

<div class="line" role="status" aria-live="off">
  <svg class="spin" viewBox="0 0 8 11" aria-hidden="true">
    {#each DOTS as [x, y]}
      <circle cx={2 + x * 4} cy={2 + y * 3.5} r="1.2" class:on={lit.some(([a, b]) => a === x && b === y)} />
    {/each}
  </svg>
  {#if loop}<b>{loop}</b>{/if}
  <span class="label" title={progress.target}>{progress.target}</span>
  <span class="rows num">{thousands(progress.rows)} rows</span>
  <span class="dim num">{rate(progress.rows_per_sec)} rows/s</span>
  <span class="dim num">{clock(elapsed)}</span>
  {#if onstop}<button class="stop" onclick={onstop} title="Stop  (i i)">Stop</button>{/if}
</div>

<style>
  .line {
    display: flex;
    align-items: center;
    gap: 1.25rem;
    min-height: 2rem;
    padding: 0.25rem 0;
    font: 0.8125rem/1.5 var(--mono);
    color: var(--ink);
    white-space: nowrap;
  }
  .spin {
    flex: none;
    width: 0.625rem;
    height: 0.86rem;
    margin-right: -0.5rem;
  }
  circle {
    fill: var(--accent);
    opacity: 0.18;
  }
  circle.on {
    opacity: 1;
  }
  b {
    font-weight: 600;
    margin-right: -0.5rem;
  }
  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rows {
    color: var(--good);
  }
  .dim {
    color: var(--muted);
  }
  .stop {
    margin-left: auto;
    font: 0.75rem var(--sans);
    color: var(--ink);
    border: 1px solid var(--hair);
    border-radius: 5px;
    padding: 0.125rem 0.625rem;
  }
</style>
