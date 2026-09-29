<script lang="ts">
  import { cells } from "./runtime.svelte";

  // One number from a cell's result, as a KPI: `column` of row `row` (default: the first
  // numeric column of the first row), formatted.
  interface Props {
    cell: string;
    column?: string;
    row?: number;
    label?: string;
    format?: "number" | "currency" | "percent" | "compact";
    currency?: string;
    decimals?: number;
    /** a row's value to compare with (e.g. the previous period): shows the change */
    compare?: number;
  }
  let { cell, column, row = 0, label, format = "number", currency = "BRL", decimals, compare }: Props = $props();

  const view = $derived(cells[cell]);
  const col = $derived(column ?? view.columns.find((c) => /int|float|decimal|double/i.test(c.type))?.name);
  const value = $derived(col != null ? view.rows[row]?.[col] : undefined);
  const prev = $derived(col != null && compare != null ? view.rows[compare]?.[col] : undefined);

  function fmt(v: unknown): string {
    if (v == null) return "—";
    if (typeof v !== "number" && typeof v !== "bigint") return v instanceof Date ? v.toLocaleDateString() : String(v);
    const n = Number(v);
    const digits = decimals != null ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals } : {};
    if (format === "currency") return new Intl.NumberFormat(undefined, { style: "currency", currency, ...digits }).format(n);
    if (format === "percent") return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: decimals ?? 1 }).format(n);
    if (format === "compact") return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: decimals ?? 1 }).format(n);
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: decimals ?? 2, ...digits }).format(n);
  }
  const delta = $derived(typeof value === "number" && typeof prev === "number" && prev !== 0 ? (value - prev) / Math.abs(prev) : null);
</script>

<div class="value">
  {#if label}<span class="label">{label}</span>{/if}
  <span class="number" class:pending={view.state === "running" || view.state === "queued"}>{fmt(value)}</span>
  {#if delta != null}
    <span class="delta" class:up={delta > 0} class:down={delta < 0}>{delta > 0 ? "▲" : delta < 0 ? "▼" : ""} {Math.abs(delta * 100).toFixed(1)}%</span>
  {/if}
</div>

<style>
  .value {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .label {
    font-size: 0.78rem;
    color: var(--muted);
  }
  .number {
    font-size: 1.75rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
    color: var(--ink);
    transition: opacity 0.2s;
  }
  .number.pending {
    opacity: 0.5;
  }
  .delta {
    font-size: 0.78rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .delta.up {
    color: var(--good, #1baf7a);
  }
  .delta.down {
    color: var(--critical, #e34948);
  }
</style>
