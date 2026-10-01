// A column at a glance (the table's profile header and hover card): how full it is,
// how many distinct values, and by type a histogram with its range, mean and sum, or
// its most frequent values. Worked out here over the rows the page holds; for a longer
// result the kernel works it out over all of it (kernel.py column_profile, the same shape).

import { isNumeric, isTemporal, type Kind } from "./format";

export const PROFILE_BINS = 10;

export interface ColumnProfile {
  /** the rows it covers */
  rows: number;
  nulls: number;
  distinct?: number;
  /** numbers and dates: counts in equal-width bins from min to max */
  hist?: number[];
  min?: string;
  max?: string;
  /** numbers */
  mean?: number;
  sum?: number;
  /** text and true/false: the most frequent values */
  top?: { value: string; count: number }[];
}

export interface ProfileCol {
  kind: Kind;
  vec: { get(i: number): any };
  fmt: (v: any) => string | null;
  num: (v: any) => number | null;
  plain: (v: any) => string;
}

export function profileOf(c: ProfileCol, rows: number): ColumnProfile {
  const ranged = isNumeric(c.kind) || isTemporal(c.kind);
  let nulls = 0;
  const seen = new Map<string, number>();
  const xs: number[] = [];
  let min: [number, any] | null = null;
  let max: [number, any] | null = null;
  let sum = 0;
  for (let r = 0; r < rows; r++) {
    const v = c.vec.get(r);
    if (v == null) {
      nulls++;
      continue;
    }
    const key = c.plain(v);
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (!ranged) continue;
    const x = c.num(v);
    if (x == null || !Number.isFinite(x)) continue;
    xs.push(x);
    if (!min || x < min[0]) min = [x, v];
    if (!max || x > max[0]) max = [x, v];
    sum += x;
  }
  const p: ColumnProfile = { rows, nulls, distinct: seen.size };
  if (ranged && min && max) {
    const [lo, hi] = [min[0], max[0]];
    if (hi > lo) {
      p.hist = new Array(PROFILE_BINS).fill(0);
      for (const x of xs) p.hist[Math.min(PROFILE_BINS - 1, Math.floor(((x - lo) / (hi - lo)) * PROFILE_BINS))]++;
    } else p.hist = [xs.length];
    p.min = c.fmt(min[1]) ?? String(lo);
    p.max = c.fmt(max[1]) ?? String(hi);
    if (isNumeric(c.kind) && xs.length) {
      p.mean = sum / xs.length;
      p.sum = sum;
    }
  } else if (!ranged) {
    p.top = [...seen].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([value, count]) => ({ value, count }));
  }
  return p;
}
