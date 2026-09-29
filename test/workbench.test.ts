import { expect, test } from "bun:test";
import { Workbench } from "../web/src/lib/workbench.svelte";

test("tabs: open, open to the side, close; an emptied side group goes away", () => {
  const wb = new Workbench("t");
  expect(wb.groups.map((g) => g.tabs.map((t) => t.kind))).toEqual([["notebook"]]);
  wb.open({ kind: "template" });
  expect(wb.groups[0].active).toBe(1);
  wb.open({ kind: "report" }, { side: true });
  expect(wb.groups.length).toBe(2);
  expect(wb.groups[1]).toEqual({ tabs: [{ kind: "report" }], active: 0 }); // the one tab, and active
  expect(wb.focused).toBe(1);
  wb.open({ kind: "notebook" }, { group: 1 });
  expect(wb.groups[1].active).toBe(1);
  wb.close(1, 1);
  wb.close(1, 0);
  expect(wb.groups.length).toBe(1);
  wb.close(0, 0);
  wb.close(0, 0);
  expect(wb.groups[0].tabs).toEqual([{ kind: "notebook" }]); // the last group keeps the notebook
});

test("cell tabs follow renames and go when the cell does", () => {
  const wb = new Workbench("t2");
  wb.open({ kind: "cell", cell: "a" });
  wb.open({ kind: "cell", cell: "b" }, { side: true });
  wb.renamed("a", "z");
  expect(wb.groups[0].tabs).toContainEqual({ kind: "cell", cell: "z" });
  wb.prune(new Set(["z"]));
  expect(wb.groups.length).toBe(1);
});
