<script lang="ts">
  import { cubicOut } from "svelte/easing";
  import { scale } from "svelte/transition";
  import type { ColumnProfile } from "../lib/profile";
  import ColumnChart from "./ColumnChart.svelte";
  import Icon from "./Icon.svelte";

  // A column's card (hovering its header in a table): its profile as a larger
  // chart, how full it is, and its figures; whether they cover the whole result or
  // the rows the page holds. Clicked, it stays until Escape or a click elsewhere.
  let {
    name,
    type,
    icon,
    profile,
    whole,
    sortHint,
    pinned = false,
    onpin,
  }: {
    name: string;
    type: string;
    icon: string;
    profile: ColumnProfile;
    /** what the figures cover: "all 75,252 rows", "the first 5,000 rows" */
    whole: string;
    sortHint: string;
    pinned?: boolean;
    onpin?: () => void;
  } = $props();

  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const filled = $derived(profile.rows ? (profile.rows - profile.nulls) / profile.rows : 0);
  const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.01 ? 1 : 0)}%`;
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="card" class:pinned transition:scale={{ start: 0.97, duration: 120, easing: cubicOut, opacity: 0 }} onclick={(e) => (e.stopPropagation(), onpin?.())}>
  <header>
    <Icon name={icon} size={14} />
    <b title={name}>{name}</b>
    <span class="type">{type}</span>
  </header>
  <ColumnChart {profile} large />
  <div class="fill">
    <span>{pct(filled)} filled</span>
    <span class="muted">{profile.nulls ? `${profile.nulls.toLocaleString()} empty (${pct(1 - filled)})` : "none empty"}</span>
  </div>
  <dl>
    {#if profile.distinct != null}<dt>Distinct</dt><dd>{profile.distinct.toLocaleString()}</dd>{/if}
    {#if profile.min != null}<dt>Min</dt><dd title={profile.min}>{profile.min}</dd><dt>Max</dt><dd title={profile.max}>{profile.max}</dd>{/if}
    {#if profile.mean != null}<dt>Average</dt><dd>{nf.format(profile.mean)}</dd>{/if}
    {#if profile.sum != null}<dt>Sum</dt><dd>{nf.format(profile.sum)}</dd>{/if}
  </dl>
  <footer>
    <span>Of {whole}</span>
    <span class="muted">{sortHint}</span>
  </footer>
</div>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 15rem;
    padding: 0.75rem;
    font-size: 0.75rem;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: 8px;
    box-shadow: var(--shadow-lg);
    transform-origin: top left;
    cursor: default;
  }
  .card.pinned {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--hair));
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--muted);
  }
  header b {
    min-width: 0;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .type {
    margin-left: auto;
    font-size: 0.6875rem;
  }
  .fill {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }
  dl {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 0.25rem 0.75rem;
    margin: 0;
    padding-top: 0.5rem;
    border-top: 1px solid var(--hair);
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
    text-align: right;
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  footer {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    font-size: 0.6875rem;
    color: var(--ink);
  }
  .muted {
    color: var(--muted);
  }
</style>
