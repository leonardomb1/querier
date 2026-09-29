// Cells as a graph. A cell depends on the nearest earlier cell defining each
// name it reads. It is fresh when it last ran successfully with the source now
// in its editor, with the params it reads unchanged, and after every cell it
// depends on — which must be fresh too. Running a cell runs its stale
// ancestors first.

import { hash } from "./hash";

export interface Deps {
  defines: string[];
  reads: string[];
}

export interface Ran {
  hash: string;
  seq: number;
  params: Record<string, string>;
  ok: boolean;
}

export type Freshness = "fresh" | "stale" | "never";

/** Direct upstream cells of each cell, in notebook order. */
export function edges(order: string[], deps: Record<string, Deps>): Record<string, string[]> {
  const up: Record<string, string[]> = {};
  const definer = new Map<string, string>();
  for (const name of order) {
    const d = deps[name];
    const mine = new Set<string>();
    for (const r of d?.reads ?? []) {
      const from = definer.get(r);
      if (from && from !== name) mine.add(from);
    }
    up[name] = order.filter((n) => mine.has(n));
    for (const def of d?.defines ?? []) definer.set(def, name);
  }
  return up;
}

export function freshness(
  order: string[],
  up: Record<string, string[]>,
  deps: Record<string, Deps>,
  ran: Record<string, Ran | undefined>,
  sources: Record<string, string>,
  params: Record<string, string>,
  code: Set<string>,
): Record<string, Freshness> {
  const out: Record<string, Freshness> = {};
  for (const name of order) {
    if (!code.has(name)) {
      out[name] = "fresh";
      continue;
    }
    const r = ran[name];
    if (!r) {
      out[name] = "never";
      continue;
    }
    const reads = deps[name]?.reads ?? [];
    const readsParams = reads.includes("params")
      ? Object.keys({ ...params, ...r.params })
      : reads.filter((x) => x.startsWith("$")).map((x) => x.slice(1));
    const stale =
      !r.ok ||
      r.hash !== hash(sources[name] ?? "") ||
      readsParams.some((p) => (params[p] ?? "") !== (r.params[p] ?? "")) ||
      up[name].some((u) => out[u] !== "fresh" || (ran[u]?.seq ?? Infinity) > r.seq);
    out[name] = stale ? "stale" : "fresh";
  }
  return out;
}

/** What to run for `targets`: their not-fresh ancestors, then themselves. */
export function plan(targets: string[], order: string[], up: Record<string, string[]>, fresh: Record<string, Freshness>): string[] {
  const want = new Set(targets);
  const visit = (n: string) => {
    for (const u of up[n] ?? []) {
      if (fresh[u] !== "fresh" && !want.has(u)) {
        want.add(u);
        visit(u);
      }
    }
  };
  targets.forEach(visit);
  return order.filter((n) => want.has(n));
}

/** Every cell that depends on `name`, directly or not. */
export function downstream(name: string, order: string[], up: Record<string, string[]>): string[] {
  const hit = new Set([name]);
  for (const n of order) if (up[n]?.some((u) => hit.has(u))) hit.add(n);
  hit.delete(name);
  return order.filter((n) => hit.has(n));
}
