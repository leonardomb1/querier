<script lang="ts">
  import type { ColumnProfile } from "../lib/profile";

  // A column's profile as a small chart: a histogram for numbers and dates (its
  // range under it), the most frequent values as bars for text and true/false.
  // The table's profile header draws it small, the hover card large.
  let { profile, large = false }: { profile: ColumnProfile; large?: boolean } = $props();

  const filled = $derived(profile.rows ? (profile.rows - profile.nulls) / profile.rows : 0);
  const peak = $derived(Math.max(1, ...(profile.hist ?? [])));
  const pct = (k: number) => `${profile.rows ? Math.round((k / profile.rows) * 100) : 0}%`;
  const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
</script>

<div class="chart" class:large>
  {#if profile.hist}
    <svg viewBox="0 0 {profile.hist.length * 10} 40" preserveAspectRatio="none" aria-hidden="true">
      {#each profile.hist as k, i (i)}
        {@const h = k ? Math.max(1.5, (k / peak) * 40) : 0}
        <rect x={i * 10 + 0.6} y={40 - h} width="8.8" height={h} rx="0.8"><title>{k.toLocaleString()}</title></rect>
      {/each}
    </svg>
    <div class="range"><span title={profile.min}>{profile.min}</span><span title={profile.max}>{profile.max}</span></div>
  {:else if profile.top?.length}
    <div class="top">
      {#each profile.top.slice(0, large ? 3 : 2) as t (t.value)}
        <div class="bar" title="{t.value}: {t.count.toLocaleString()} ({pct(t.count)})">
          <span class="fill" style:width={pct(t.count)}></span>
          <span class="v">{short(t.value === "" ? "(blank)" : t.value, large ? 24 : 14)}</span>
          <span class="p">{pct(t.count)}</span>
        </div>
      {/each}
      {#if !large && profile.distinct != null && profile.distinct > 2}<span class="more">{profile.distinct.toLocaleString()} distinct</span>{/if}
    </div>
  {:else}
    <div class="none">{profile.rows - profile.nulls ? "" : "all empty"}</div>
  {/if}
  <div class="filled" title="{Math.round(filled * 100)}% filled, {profile.nulls.toLocaleString()} empty"><span style:width="{filled * 100}%"></span></div>
</div>

<style>
  .chart {
    display: flex;
    flex-direction: column;
    gap: 0.1875rem;
    width: 100%;
    min-width: 0;
  }
  svg {
    display: block;
    width: 100%;
    height: 1.75rem;
  }
  .large svg {
    height: 4.5rem;
  }
  rect {
    fill: var(--accent);
    opacity: 0.85;
  }
  .range {
    display: flex;
    justify-content: space-between;
    gap: 0.375rem;
    font-size: 0.625rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .large .range {
    font-size: 0.6875rem;
  }
  .range span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .top {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .bar {
    position: relative;
    display: flex;
    justify-content: space-between;
    gap: 0.375rem;
    height: 0.875rem;
    padding: 0 0.25rem;
    font-size: 0.625rem;
    line-height: 0.875rem;
    border-radius: 2px;
    overflow: hidden;
  }
  .large .bar {
    height: 1.125rem;
    font-size: 0.72rem;
    line-height: 1.125rem;
  }
  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: color-mix(in srgb, var(--accent) 22%, transparent);
  }
  .v,
  .p {
    position: relative;
    white-space: nowrap;
  }
  .v {
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--ink);
  }
  .p {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .more,
  .none {
    font-size: 0.625rem;
    color: var(--muted);
  }
  /* how full: the share of cells with a value */
  .filled {
    height: 2px;
    background: color-mix(in srgb, var(--muted) 25%, transparent);
    border-radius: 1px;
    overflow: hidden;
  }
  .filled span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
</style>
