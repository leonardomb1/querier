import { expect, test } from "bun:test";
import { layout } from "../web/src/lib/gitgraph";

test("a straight history is one lane", () => {
  const { rows, width } = layout([
    { hash: "c", parents: ["b"] },
    { hash: "b", parents: ["a"] },
    { hash: "a", parents: [] },
  ]);
  expect(width).toBe(1);
  expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
  expect(rows[0].top).toEqual([]); // the tip: nothing above it
  expect(rows[2].bottom).toEqual([]); // the root: nothing below
});

test("a branch and its merge: two lanes, joined at both ends", () => {
  //  m   merge of f into main
  //  |\\
  //  | f feature work
  //  c | main work
  //  |/
  //  b   where they forked
  const { rows, width } = layout([
    { hash: "m", parents: ["c", "f"] },
    { hash: "f", parents: ["b"] },
    { hash: "c", parents: ["b"] },
    { hash: "b", parents: [] },
  ]);
  expect(width).toBe(2);
  expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 0]);
  // the merge sends a line to lane 1
  expect(rows[0].bottom.map((s) => [s.from, s.to])).toEqual([[0, 0], [0, 1]]);
  // at the fork, lane 1 comes back into lane 0
  expect(rows[3].top.map((s) => [s.from, s.to])).toEqual([[0, 0], [1, 0]]);
  // a line runs past c on lane 1
  expect(rows[2].top.map((s) => [s.from, s.to])).toContainEqual([1, 1]);
  // lanes keep their colours top to bottom
  expect(rows[1].color).toBe(rows[0].bottom[1].color);
});

test("two branch tips side by side", () => {
  const { rows, width } = layout([
    { hash: "x", parents: ["a"] },
    { hash: "y", parents: ["a"] },
    { hash: "a", parents: [] },
  ]);
  expect(width).toBe(2);
  expect(rows.map((r) => r.lane)).toEqual([0, 1, 0]);
});
