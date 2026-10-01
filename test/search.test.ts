import { expect, test } from "bun:test";
import { marked, parseSearch, rowMatches, type SearchCol, type Term } from "../web/src/lib/search";

const cols = ["customer", "state", "total", "issued"];
test("parse: columns, operators, negation, phrases; unknown names stay text", () => {
  expect(parseSearch('000600 customer:061 state=BA total>1000 -"north east" nope:x', cols)).toEqual([
    { col: null, op: "has", value: "000600", not: false },
    { col: "customer", op: "has", value: "061", not: false },
    { col: "state", op: "=", value: "BA", not: false },
    { col: "total", op: ">", value: "1000", not: false },
    { col: null, op: "has", value: "north east", not: true },
    { col: null, op: "has", value: "nope:x", not: false },
  ]);
  expect(parseSearch("Issued>=2025-01 STATE!=sp", cols)).toEqual([
    { col: "issued", op: ">=", value: "2025-01", not: false },
    { col: "state", op: "!=", value: "sp", not: false },
  ]);
});

const data: Record<string, any[]> = {
  customer: ["000600", "000061", null],
  state: ["BA", "SP", "BA"],
  total: [1500, 20, 9000],
  issued: ["2024-09-02", "2025-02-01", "2026-01-01"],
};
const sc: SearchCol[] = cols.map((name) => ({
  name,
  numeric: name === "total",
  plain: (v) => String(v),
  fmt: (v) => (name === "total" ? Number(v).toLocaleString("en") : String(v)),
  num: (v) => Number(v),
  vec: { get: (i) => data[name][i] },
}));
const hits = (q: string) => [0, 1, 2].filter((r) => rowMatches(parseSearch(q, cols), sc, r));

test("match: anywhere, per column, compare, exclude", () => {
  expect(hits("000600")).toEqual([0]);
  expect(hits("customer:06")).toEqual([0, 1]);
  expect(hits("state=ba")).toEqual([0, 2]);
  expect(hits("total>1000")).toEqual([0, 2]);
  expect(hits("total>1,000 state=BA")).toEqual([0, 2]);
  expect(hits("issued>=2025-01")).toEqual([1, 2]);
  expect(hits("-BA")).toEqual([1]);
  expect(hits("9,000")).toEqual([2]); // the number as shown
});

test("marks the found text", () => {
  expect(marked("000600", ["06"])).toEqual([
    { text: "00", hit: false },
    { text: "06", hit: true },
    { text: "00", hit: false },
  ]);
});

import { tableFromIPC } from "apache-arrow";
import { resolve } from "node:path";
import { LocalRunner } from "../server/runner/local";

const gen = (n: number) =>
  `SELECT range AS id, CASE range % 3 WHEN 0 THEN 'north' WHEN 1 THEN 'south' ELSE 'east' END AS region, CAST(range % 50 AS FLOAT) * 1.5 AS amount, date_add('day', range % 40, CAST('2025-01-01' AS DATE)) AS day FROM RANGE(${n});`;
const QUERIES = ["north", "region=SOUTH amount>60", "-north day>=2025-02", "id<10 -east", 'region:"ou"', "amount>=73.5", "2025-01-1"];

test("the kernel's search and the browser's find the same rows", async () => {
  const { formatter, numeric, plainText } = await import("../web/src/lib/format");
  const s = await new LocalRunner().open({ notebookDir: resolve(import.meta.dir, "fixtures/demo") });
  try {
    // small enough that the page holds every row: both sides see the same table
    for await (const _ of s.run({ name: "small", lang: "sql", source: gen(3000) }));
    const all = tableFromIPC((await s.filter("small", [])).arrow);
    expect(all.numRows).toBe(3000);
    const cols: SearchCol[] = all.schema.fields.map((f) => ({
      name: f.name, numeric: /Int|Float/.test(String(f.type)), plain: plainText(f), fmt: formatter(f), num: numeric(f), vec: all.getChild(f.name)!,
    }));
    const names = cols.map((c) => c.name);
    for (const q of QUERIES) {
      const browser = [...Array(all.numRows).keys()].filter((i) => rowMatches(parseSearch(q, names), cols, i)).map((i) => Number(all.getChild("id")!.get(i)));
      const got = tableFromIPC((await s.filter("small", parseSearch(q, names))).arrow);
      const kernel = [...Array(got.numRows).keys()].map((i) => Number(got.getChild("id")!.get(i)));
      expect({ q, n: kernel.length, ids: kernel }).toEqual({ q, n: browser.length, ids: browser });
    }
    // the columns' filters (Table.svelte): a checklist of values, and ranges of numbers and dates
    const FILTERS: Term[][] = [
      [{ col: "region", op: "in", value: "", values: ["north", "EAST"], not: false }],
      [{ col: "amount", op: ">=", value: "30", not: false }, { col: "amount", op: "<=", value: "45", not: false }],
      [{ col: "day", op: ">=", value: "2025-01-20", not: false }, { col: "day", op: "<=", value: "2025-02-01", not: false }],
      [{ col: "region", op: "in", value: "", values: ["south"], not: false }, { col: "amount", op: ">=", value: "60", not: false }],
    ];
    for (const terms of FILTERS) {
      const browser = [...Array(all.numRows).keys()].filter((i) => rowMatches(terms, cols, i)).map((i) => Number(all.getChild("id")!.get(i)));
      const got = tableFromIPC((await s.filter("small", terms)).arrow);
      const kernel = [...Array(got.numRows).keys()].map((i) => Number(got.getChild("id")!.get(i)));
      expect(browser.length).toBeGreaterThan(0);
      expect({ terms, ids: kernel }).toEqual({ terms, ids: browser });
    }
  } finally {
    await s.close();
  }
}, 60_000);

test("over a result longer than the page holds, the kernel finds matches past the preview", async () => {
  const s = await new LocalRunner().open({ notebookDir: resolve(import.meta.dir, "fixtures/demo") });
  try {
    for await (const _ of s.run({ name: "big", lang: "sql", source: gen(12000) }));
    const r = await s.filter("big", parseSearch("id>=11990", ["id"]));
    expect([r.rows, r.of, r.truncated]).toEqual([10, 12000, false]);
    expect(Number(tableFromIPC(r.arrow).getChild("id")!.get(0))).toBe(11990);
    const many = await s.filter("big", parseSearch("north", ["region"]));
    expect([many.rows, many.truncated, tableFromIPC(many.arrow).numRows]).toEqual([4000, false, 4000]);
    await expect(s.filter("nope", [])).rejects.toThrow("run it first");
  } finally {
    await s.close();
  }
}, 60_000);
