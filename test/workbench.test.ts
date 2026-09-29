import { expect, test } from "bun:test";
import { evenOut, groupOrder, layoutRects, neighbour, removeFrom, sanitize, splitAt, type Node } from "../web/src/lib/layout";
import { Workbench } from "../web/src/lib/workbench.svelte";

const kinds = (wb: Workbench) => wb.order().map((id) => wb.group(id)!.tabs.map((t) => (t.kind === "cell" ? t.cell : t.kind)));

test("tabs: open, open to the side, close; an emptied side group goes away, the last one stays empty", () => {
  const wb = new Workbench("t");
  expect(kinds(wb)).toEqual([["notebook"]]);
  wb.open({ kind: "template" });
  expect(wb.group(0)!.active).toBe(1);
  wb.open({ kind: "report" }, { side: true });
  expect(wb.groups.length).toBe(2);
  const side = wb.focused;
  expect(wb.group(side)).toEqual({ id: side, tabs: [{ kind: "report" }], active: 0 }); // the one tab, and active
  wb.open({ kind: "notebook" }, { group: side });
  expect(wb.group(side)!.active).toBe(1);
  wb.close(side, 1);
  wb.close(side, 0);
  expect(wb.groups.length).toBe(1);
  expect(wb.focused).toBe(0);
  wb.close(0, 0);
  wb.close(0, 0);
  expect(wb.group(0)!.tabs).toEqual([]); // every editor closes; the group stays, empty
  wb.open({ kind: "report" });
  expect(wb.group(0)).toEqual({ id: 0, tabs: [{ kind: "report" }], active: 0 });
});

test("cell tabs follow renames and go when the cell does", () => {
  const wb = new Workbench("t2");
  wb.open({ kind: "cell", cell: "a" });
  wb.open({ kind: "cell", cell: "b" }, { side: true });
  wb.renamed("a", "z");
  expect(wb.group(0)!.tabs).toContainEqual({ kind: "cell", cell: "z" });
  wb.prune(new Set(["z"]));
  expect(wb.groups.length).toBe(1);
});

test("the grid: split right and down, drag tabs between groups and onto an edge", () => {
  const wb = new Workbench("t3");
  wb.split("right"); // group 1, beside 0, with a copy of the notebook tab
  wb.open({ kind: "report" });
  wb.split("down"); // group 2, under 1, with the report
  expect(wb.layout).toEqual({ dir: "row", children: [{ group: 0 }, { dir: "col", children: [{ group: 1 }, { group: 2 }], sizes: [1, 1] }], sizes: [1, 1] });
  expect(kinds(wb)).toEqual([["notebook"], ["notebook", "report"], ["report"]]);
  // the report of group 2 dragged into group 0's bar, first: group 2 empties and goes
  wb.drop({ group: 0, at: 0 }, { kind: "report" }, { group: 2, index: 0 });
  expect(kinds(wb)).toEqual([["report", "notebook"], ["notebook", "report"]]);
  expect(wb.layout).toEqual({ dir: "row", children: [{ group: 0 }, { group: 1 }], sizes: [1, 1] });
  // group 1's notebook dragged onto group 0's bottom edge: a new group there
  wb.drop({ group: 0, side: "down" }, { kind: "notebook" }, { group: 1, index: 0 });
  expect(kinds(wb)).toEqual([["report", "notebook"], ["notebook"], ["report"]]);
  expect(groupOrder(wb.layout)).toEqual([0, 3, 1]);
  // a group's only tab dropped beside itself goes nowhere
  wb.drop({ group: 1, side: "left" }, { kind: "report" }, { group: 1, index: 0 });
  expect(wb.groups.length).toBe(3);
  // a move inside a bar
  wb.drop({ group: 0, at: 2 }, { kind: "report" }, { group: 0, index: 0 });
  expect(wb.group(0)!.tabs.map((t) => t.kind)).toEqual(["notebook", "report"]);
  // from the side bar: opened, nothing removed anywhere
  wb.drop({ group: 1 }, { kind: "cell", cell: "q" }, null);
  expect(wb.group(1)!.tabs.map((t) => (t.kind === "cell" ? t.cell : t.kind))).toEqual(["report", "q"]);
  wb.joinAll();
  expect(wb.groups.length).toBe(1);
  expect(wb.layout).toEqual({ group: wb.focused });
});

test("tab menu: close others, to the right, all", () => {
  const wb = new Workbench("t4");
  for (const c of ["a", "b", "c"]) wb.open({ kind: "cell", cell: c });
  wb.closeToRight(0, 1);
  expect(kinds(wb)).toEqual([["notebook", "a"]]);
  wb.closeOthers(0, 1);
  expect(kinds(wb)).toEqual([["a"]]);
  wb.split("right");
  wb.closeAll(wb.focused);
  expect(wb.groups.length).toBe(1);
});

test("layout: rectangles and sashes, neighbours, removal melts splits, sanitizing a stored tree", () => {
  const tree: Node = { dir: "row", children: [{ group: 0 }, { dir: "col", children: [{ group: 1 }, { group: 2 }], sizes: [1, 3] }], sizes: [1, 1] };
  const { groups, sashes } = layoutRects(tree);
  expect(groups.get(0)).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
  expect(groups.get(2)).toEqual({ x: 0.5, y: 0.25, w: 0.5, h: 0.75 });
  expect(sashes.map((s) => [s.node.dir, s.rect.x, s.rect.y, s.extent])).toEqual([
    ["row", 0.5, 0, 1],
    ["col", 0.5, 0.25, 1],
  ]);
  expect(neighbour(tree, 0, "right")).toBe(2); // shares more of the edge than group 1
  expect(neighbour(tree, 1, "down")).toBe(2);
  expect(neighbour(tree, 0, "left")).toBeNull();
  // a split along the same axis gains a sibling instead of nesting
  expect(splitAt(tree, 0, 3, "right")).toEqual({
    dir: "row",
    children: [{ group: 0 }, { group: 3 }, { dir: "col", children: [{ group: 1 }, { group: 2 }], sizes: [1, 3] }],
    sizes: [0.5, 0.5, 1],
  });
  // without group 1, the column melts into the row it was in
  expect(removeFrom(tree, 1)).toEqual({ dir: "row", children: [{ group: 0 }, { group: 2 }], sizes: [1, 1] });
  expect(removeFrom({ group: 0 }, 0)).toBeNull();
  expect(evenOut(tree)).toEqual({ dir: "row", children: [{ group: 0 }, { dir: "col", children: [{ group: 1 }, { group: 2 }], sizes: [1, 1] }], sizes: [1, 1] });
  // a stored tree: unknown groups dropped, a forgotten one kept, bad sizes fixed
  expect(sanitize({ dir: "row", children: [{ group: 0 }, { group: 9 }, { group: 0 }], sizes: [2, 1, "x"] }, new Set([0, 1]))).toEqual({
    dir: "row",
    children: [{ group: 0 }, { group: 1 }],
    sizes: [1, 1],
  });
});

test("a layout stored before the grid (two groups, a split fraction) is read", () => {
  // the browser's storage, as far as the workbench uses it
  const store = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
  localStorage.setItem("querier:wb:old", JSON.stringify({ groups: [{ tabs: [{ kind: "notebook" }], active: 0 }, { tabs: [{ kind: "report" }], active: 0 }], focused: 1, split: 0.3 }));
  const wb = new Workbench("old");
  expect(wb.layout).toEqual({ dir: "row", children: [{ group: 0 }, { group: 1 }], sizes: [0.3, 0.7] });
  expect(wb.focused).toBe(1);
  wb.split("down");
  expect(wb.focused).toBe(2); // new ids after the old ones
  delete (globalThis as any).localStorage;
});
