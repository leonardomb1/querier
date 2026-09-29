// The CLI's words for a load, so a notebook reads like `basalt run`:
// `Loaded 20,000,000 rows into sr.bronze.orders in 8.2s (2.4M rows/s, 12 lanes)`.
// Mirrors basalt's runtime/obs.zig (writeDuration, writeRate, Summary.renderText).

export const thousands = (n: number) => Math.round(n).toLocaleString("en-US");

/** `412ms`, `8.2s`, `3m 12s`: the precision a person reads at each scale. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}.${Math.floor((ms % 1000) / 100)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

export function rate(r: number): string {
  if (r >= 1_000_000) return `${Math.floor(r / 1_000_000)}.${Math.floor((r % 1_000_000) / 100_000)}M`;
  if (r >= 10_000) return `${Math.floor(r / 1000)}.${Math.floor((r % 1000) / 100)}k`;
  return thousands(r);
}

/** `0:24`, the progress line's clock. */
export function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export interface LoadTotals {
  loads_ok: number;
  loads_failed: number;
  rows_read: number;
  rows_loaded: number;
  lanes: number;
  elapsed_ms: number;
}

/** The closing sentence, and `N failed` when any did. */
export function sentence(t: LoadTotals, target?: string): { text: string; failed?: string } {
  const total = t.loads_ok + t.loads_failed;
  let text: string;
  if (total > 1 || t.loads_failed > 0) {
    text = `Loaded ${t.loads_failed ? `${t.loads_ok} of ${total}` : total} targets, ${thousands(t.rows_loaded)} rows`;
  } else if (t.rows_read > 0 && t.rows_read !== t.rows_loaded) {
    text = `Read ${thousands(t.rows_read)} rows, loaded ${thousands(t.rows_loaded)} into ${target}`;
  } else {
    text = `Loaded ${thousands(t.rows_loaded)} rows into ${target}`;
  }
  const rows = t.rows_read > 0 ? t.rows_read : t.rows_loaded;
  const perSec = t.elapsed_ms ? (rows * 1000) / t.elapsed_ms : rows;
  text += ` in ${duration(t.elapsed_ms)} (${rate(perSec)} rows/s${t.lanes > 1 ? `, ${t.lanes} lanes` : ""})`;
  return { text, failed: t.loads_failed ? `${t.loads_failed} failed` : undefined };
}
