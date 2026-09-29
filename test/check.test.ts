import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkCli } from "../server/check";
import { LocalRunner } from "../server/runner/local";
import type { Session } from "../server/runner/types";

let s: Session;
beforeAll(async () => {
  s = await new LocalRunner().open({ notebookDir: resolve(import.meta.dir, "fixtures/demo") });
  for await (const _ of s.run({ name: "orders", lang: "python", source: 'pl.DataFrame({"id": [1, 2], "region": ["n", "s"]})' }));
  for await (const _ of s.run({ name: "setup", lang: "sql", source: "PARAM days INT DEFAULT 7;" }));
});
afterAll(() => s.close());

test("against the session: a held table's real columns, and every problem at once", async () => {
  const d = await s.check("SELECT id, nope FROM orders;\nSELEC 1;\nSELECT x FROM nowhere;", []);
  expect(d.map((x) => [x.line, x.msg.split(":")[0]])).toEqual([
    [1, "unknown field `nope`"],
    [2, "expected a statement (CREATE / PARAM / LET / PRINT / THROW / EXPLAIN / DESCRIBE / SHOW / LOAD INTO / SELECT / FOR / CASE / CALL), found identifier"],
    [3, "unknown source `nowhere`"],
  ]);
  expect(d[0].col).toBe(12);
});

test("a PARAM from another cell is known; a cell not run yet is a table by name", async () => {
  expect(await s.check("SELECT region FROM orders WHERE id > $days;", [])).toEqual([]);
  expect(await s.check("SELECT anything FROM later;", ["later"])).toEqual([]);
});

test("checking leaves the session as it was", async () => {
  await s.check("PARAM fresh INT DEFAULT 1;", []);
  const ns = await s.tables();
  expect(ns.declared.map((d) => d.name)).not.toContain("fresh");
});

test("without a kernel: the CLI, with the notebook's names, and connections declared elsewhere let through", async () => {
  const d = await checkCli("SELECT * FROM enrich;\nSELECT * FROM pg.public.t;\nSELEC 1;", ["enrich"], new Set(["pg"]));
  expect(d.map((x) => x.line)).toEqual([3]);
});
