import { expect, test } from "bun:test";
import { hash } from "../shared/hash";
import { downstream, edges, freshness, plan, type Deps, type Ran } from "../shared/graph";

const order = ["a", "b", "notes", "c", "d"];
const deps: Record<string, Deps> = {
  a: { defines: ["a", "$days"], reads: [] },
  b: { defines: ["b", "x"], reads: ["a"] },
  notes: { defines: [], reads: [] },
  c: { defines: ["c"], reads: ["x", "$days", "nowhere"] },
  d: { defines: ["d"], reads: ["a"] },
};
const src: Record<string, string> = { a: "A", b: "B", notes: "", c: "C", d: "D" };
const code = new Set(["a", "b", "c", "d"]);
const ran = (seq: number, source: string, params = {}): Ran => ({ hash: hash(source), seq, params, ok: true });

test("edges point at the nearest earlier definer", () => {
  expect(edges(order, deps)).toEqual({ a: [], b: ["a"], notes: [], c: ["a", "b"], d: ["a"] });
});

test("freshness follows source, params and upstream order", () => {
  const up = edges(order, deps);
  const runs = { a: ran(1, "A"), b: ran(2, "B"), c: ran(3, "C"), d: ran(4, "D") };
  expect(freshness(order, up, deps, runs, src, {}, code)).toEqual({ a: "fresh", b: "fresh", notes: "fresh", c: "fresh", d: "fresh" });

  // editing b makes b and c stale; d does not read b
  const edited = freshness(order, up, deps, runs, { ...src, b: "B2" }, {}, code);
  expect(edited).toMatchObject({ a: "fresh", b: "stale", c: "stale", d: "fresh" });

  // a param only c reads
  expect(freshness(order, up, deps, runs, src, { days: "7" }, code)).toMatchObject({ b: "fresh", c: "stale" });

  // re-running a after c ran makes c stale even with the same source
  const rerun = { ...runs, a: ran(5, "A") };
  expect(freshness(order, up, deps, rerun, src, {}, code)).toMatchObject({ a: "fresh", b: "stale", c: "stale", d: "stale" });

  expect(freshness(order, up, deps, {}, src, {}, code).a).toBe("never");
});

test("a plan runs stale ancestors first, in notebook order", () => {
  const up = edges(order, deps);
  const f = freshness(order, up, deps, { a: ran(1, "A") }, src, {}, code);
  expect(plan(["c"], order, up, f)).toEqual(["b", "c"]);
  expect(plan(["c"], order, up, { ...f, a: "stale" })).toEqual(["a", "b", "c"]);
  expect(downstream("a", order, up)).toEqual(["b", "c", "d"]);
});
