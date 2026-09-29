import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tableFromIPC } from "apache-arrow";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadNotebook, sqlParams } from "../server/notebook";
import { LocalRunner } from "../server/runner/local";
import type { CellEvent, CodeLang, Session } from "../server/runner/types";

// a frozen copy of the demo: notebooks/demo is yours to edit
const demo = resolve(import.meta.dir, "fixtures/demo");
const runner = new LocalRunner();

async function run(s: Session, name: string, lang: CodeLang, source: string, params?: Record<string, string>) {
  const evs: CellEvent[] = [];
  for await (const ev of s.run({ name, lang, source }, params)) evs.push(ev);
  return evs;
}
const of = <T extends CellEvent["type"]>(evs: CellEvent[], type: T) =>
  evs.filter((e): e is Extract<CellEvent, { type: T }> => e.type === type);
const done = (evs: CellEvent[]) => of(evs, "done")[0];
const rows = (ev: Extract<CellEvent, { type: "table" }>) => tableFromIPC(ev.arrow).toArray().map((r) => r.toJSON());
const text = (ev: Extract<CellEvent, { type: "display" }>) => new TextDecoder().decode(ev.data);

describe("notebook folder", () => {
  test("cells in filename order, named by their files", async () => {
    const nb = await loadNotebook(demo);
    expect(nb.title).toBe("Demo");
    expect(nb.cells.map((c) => [c.name, c.lang])).toEqual([
      ["sales", "sql"],
      ["enrich", "python"],
      ["by_region", "sql"],
      ["notes", "md"],
      ["plot", "python"],
    ]);
    expect(nb.params).toEqual([{ name: "days", type: "INT", default: "90", cell: "sales" }]);
  });

  test("PARAM declarations, comments ignored", () => {
    const src = `PARAM a INT DEFAULT 7;\nPARAM b STRING FROM HEADER('X-B');\n-- PARAM c INT;\nparam d DECIMAL(10,2) DEFAULT 1.5; SELECT 1;`;
    expect(sqlParams(src)).toEqual([
      { name: "a", type: "INT", default: "7" },
      { name: "b", type: "STRING", default: undefined },
      { name: "d", type: "DECIMAL(10,2)", default: "1.5" },
    ]);
  });

  test("two cells with one name are refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "querier-nb-"));
    await Bun.write(join(dir, "01_x.sql"), "SELECT 1 AS a;");
    await Bun.write(join(dir, "02_x.py"), "1");
    expect(loadNotebook(dir)).rejects.toThrow("both named `x`");
    await rm(dir, { recursive: true });
  });
});

describe("demo notebook", () => {
  test("sql → python → sql → plot", async () => {
    const nb = await loadNotebook(demo);
    const s = await runner.open({ notebookDir: nb.dir });
    try {
      const out: Record<string, CellEvent[]> = {};
      for (const { name, lang, source } of nb.cells) {
        if (lang !== "md") out[name] = await run(s, name, lang, source);
      }
      for (const [name, evs] of Object.entries(out)) expect({ name, ok: done(evs).ok }).toEqual({ name, ok: true });

      const [byRegion] = of(out.by_region, "table");
      expect(byRegion.name).toBe("by_region");
      const agg = rows(byRegion);
      expect(agg.map((r) => r.region).sort()).toEqual(["east", "north", "south", "west"]);
      expect(agg.reduce((n, r) => n + Number(r.orders), 0)).toBe(5000);

      const [png] = of(out.plot, "display");
      expect(png.mime).toBe("image/png");
      expect([...png.data.subarray(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");

      const ns = await s.tables();
      expect(ns.tables.map((t) => t.name).sort()).toEqual(["by_region", "enrich", "sales"]);
      expect(ns.declared).toEqual([{ kind: "param", name: "days" }]);
      expect(s.info.basalt).toMatch(/^\d+\.\d+/);
    } finally {
      await s.close();
    }
  });
});

describe("session", () => {
  let dir: string;
  let s: Session;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "querier-nb-"));
    s = await runner.open({ notebookDir: dir });
    await run(s, "sales", "sql", "SELECT range AS id, range % 3 AS g FROM RANGE(10);");
  });
  afterAll(async () => {
    await s.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("params bind per run", async () => {
    const src = "PARAM days INT DEFAULT 90;\nSELECT $days AS d;";
    expect(rows(of(await run(s, "p", "sql", src), "table")[0])).toEqual([{ d: 90n }]);
    expect(rows(of(await run(s, "p", "sql", src, { days: "7" }), "table")[0])).toEqual([{ d: 7n }]);
    const py = await run(s, "pp", "python", "params['days']", { days: "7" });
    expect(text(of(py, "display")[0])).toBe("'7'");
  });

  test("declarations carry across cells", async () => {
    const decl = await run(s, "decl", "sql", "LET k = 41;\nCREATE FUNCTION inc(x) AS x + 1;");
    expect(done(decl).ok).toBe(true);
    expect(rows(of(await run(s, "use", "sql", "SELECT inc($k) AS v;"), "table")[0])).toEqual([{ v: 42n }]);
  });

  test("an error is placed in the source as written, past a rewritten table name", async () => {
    const evs = await run(s, "bad", "sql", "SELECT * FROM sales WHERE nope > 1;");
    const [err] = of(evs, "error");
    expect(err).toMatchObject({ message: "unknown field `nope`", line: 1, col: 27, end_col: 31 });
    expect(done(evs).ok).toBe(false);
  });

  test("strings, comments and a same-named CTE are not rewritten", async () => {
    const src = "-- FROM sales\nWITH sales AS (SELECT 'FROM sales' AS x)\nSELECT * FROM sales;";
    const [t] = of(await run(s, "cte", "sql", src), "table");
    expect(rows(t)).toEqual([{ x: "FROM sales" }]);
  });

  test("every result is shown; the last SELECT takes the cell's name", async () => {
    const evs = await run(s, "multi", "sql", "DESCRIBE sales;\nSELECT COUNT(*) AS n FROM sales;\nEXPLAIN SELECT 1 AS a;");
    const tables = of(evs, "table");
    expect(tables.map((t) => t.name)).toEqual([null, "multi"]);
    expect(rows(tables[0]).map((r) => r.column)).toEqual(["id", "g"]);
    expect(text(of(evs, "display")[0])).toContain("scan");
  });

  test("a LOAD cell writes relative to the notebook and binds nothing", async () => {
    const evs = await run(s, "export", "sql", "LOAD INTO 'out.csv' AS SELECT * FROM sales;");
    expect(done(evs).ok).toBe(true);
    expect(of(evs, "table")).toEqual([]);
    expect((await Bun.file(join(dir, "out.csv")).text()).trim().split("\n")).toHaveLength(11);
  });

  test("a LOAD cell reports each load, the totals, and a failed one once", async () => {
    const src = [
      "LOAD INTO 'a.parquet' AS SELECT * FROM sales;",
      "LOAD INTO 'b.csv' AS SELECT g, COUNT(*) AS n FROM sales GROUP BY g;",
      "LOAD INTO '/nonexistent/x.csv' AS SELECT 1 AS x;",
    ].join("\n");
    const evs = await run(s, "loads", "sql", src);
    const loads = of(evs, "load");
    expect(loads.map((l) => [l.target, l.ok, l.rows_written])).toEqual([
      ["a.parquet", true, 10],
      ["b.csv", true, 3],
      ["/nonexistent/x.csv", false, 0],
    ]);
    expect(loads[2]).toMatchObject({ line: 3, col: 1 });
    expect(of(evs, "loads")[0]).toMatchObject({ loads_ok: 2, loads_failed: 1, rows_loaded: 13 });
    expect(of(evs, "error")[0]).toMatchObject({ shown: true, line: 3 });
    expect(done(evs).ok).toBe(false);
  });

  test("python dtypes reach basalt typed", async () => {
    const py = `import datetime as dt\nev = pl.DataFrame({"ts": [dt.datetime(2026, 1, 1, 12, 30)], "tags": [["a", "b"]]})`;
    expect(done(await run(s, "mk", "python", py)).ok).toBe(true);
    const sql = "SELECT date_trunc('hour', ts) AS h, json_get(tags, '[1]') AS second FROM ev;";
    const evs = await run(s, "typed", "sql", sql);
    expect(of(evs, "error")).toEqual([]);
    const [t] = of(evs, "table");
    expect(t.columns.map((c) => c.type)).toEqual(["Datetime(time_unit='us', time_zone=None)", "String"]);
    expect(rows(t)[0].second).toBe("b");
  });

  test("an Altair chart (df.plot) comes out as its Vega-Lite spec", async () => {
    const evs = await run(s, "plot", "python", "sales.plot.bar(x='g', y='id')");
    const [d] = of(evs, "display");
    expect(d.mime).toBe("application/vnd.vegalite+json");
    const spec = JSON.parse(text(d));
    expect(spec.$schema).toContain("vega-lite");
    expect(spec.mark).toMatchObject({ type: "bar" });
  });

  test("python: last expression, stdout, error line, syntax error", async () => {
    const ok = await run(s, "py", "python", "print('hi')\nx = 2\nx * 21");
    expect(of(ok, "stream")).toEqual([{ type: "stream", stream: "stdout", text: "hi\n" }]);
    expect(text(of(ok, "display")[0])).toBe("42");

    const bad = await run(s, "py", "python", "def f():\n    return 1 / 0\n\nf()");
    const [err] = of(bad, "error");
    expect(err.message).toBe("ZeroDivisionError: division by zero");
    expect(err.line).toBe(2);
    expect(err.traceback).not.toContain("kernel.py");

    const syn = await run(s, "py", "python", "x = (\n");
    expect(of(syn, "error")[0]).toMatchObject({ line: 1 });
  });

  test("interrupt stops python and sql; the session survives", async () => {
    const t0 = Date.now();
    const py = run(s, "slow", "python", "import time\ntime.sleep(30)");
    await Bun.sleep(300);
    s.interrupt();
    expect(of(await py, "error")[0].message).toBe("interrupted");

    const sql = run(s, "slow", "sql", "SELECT COUNT(DISTINCT range % 100000007) AS n FROM RANGE(2000000000);");
    await Bun.sleep(500);
    s.interrupt();
    expect(of(await sql, "error")[0].message).toBe("interrupted");
    expect(Date.now() - t0).toBeLessThan(5000);

    expect(rows(of(await run(s, "after", "sql", "SELECT $k AS k;"), "table")[0])).toEqual([{ k: 41n }]);
  });

  test("completion: basalt's for sql plus notebook tables and their columns; typed python names", async () => {
    const sql = await s.complete("sql", "SELECT * FROM sal", 17);
    expect(sql.start).toBe(14);
    expect(sql.items).toContainEqual({ text: "sales", kind: "table", detail: "10 × 2" });

    const cols = await s.complete("sql", "SELECT g FROM sales", 8);
    expect(cols.items).toContainEqual({ text: "g", kind: "column", detail: "int64 · sales" });
    expect(cols.items.filter((i) => i.text === "g")).toHaveLength(1); // no keyword twin

    const py = await s.complete("python", "sal", 3);
    expect(py.items).toContainEqual({ text: "sales", kind: "table", detail: "DataFrame 10 × 2" });
    const method = await s.complete("python", "sales.he", 8);
    expect(method.start).toBe(6);
    expect(method.items.find((i) => i.text === "head")).toMatchObject({ kind: "method" });
    const col = await s.complete("python", 'pl.col("', 8);
    expect(col.items).toContainEqual({ text: "id", kind: "column", detail: "int64 · sales" });
  });

  test("inspect runs a script outside any cell", async () => {
    const got = await s.inspect("DESCRIBE sales;");
    expect(got.error).toBeUndefined();
    expect(got.columns).toEqual(["column", "type", "nullable"]);
    const bad = await s.inspect("SELECT nope FROM RANGE(1);");
    expect(bad.error).toBe("unknown field `nope`");
  });

  test("reset forgets tables and declarations", async () => {
    await s.reset();
    expect(await s.tables()).toEqual({ tables: [], declared: [] });
    expect(of(await run(s, "gone", "sql", "SELECT $k AS k;"), "error")).toHaveLength(1);
    await run(s, "sales", "sql", "SELECT range AS id, range % 3 AS g FROM RANGE(10);");
  });
});

test("a capped result says so", async () => {
  const s = await runner.open({ notebookDir: tmpdir(), env: { QUERIER_MAX_ROWS: "100" } });
  try {
    const [t] = of(await run(s, "big", "sql", "SELECT * FROM RANGE(1000);"), "table");
    expect(t).toMatchObject({ rows: 100, capped: true });
  } finally {
    await s.close();
  }
});

test("a dead kernel fails its run and every later one", async () => {
  const s = await runner.open({ notebookDir: tmpdir() });
  const evs = await run(s, "die", "python", "import os\nos._exit(3)");
  expect(of(evs, "error")[0].message).toContain("code 3");
  expect(done(evs).ok).toBe(false);
  expect(done(await run(s, "later", "python", "1")).ok).toBe(false);
  await s.close();
});

describe("analysis and store", () => {
  test("cells know what they define and read", async () => {
    const { analyze } = await import("../server/analyze");
    const deps = await analyze((await loadNotebook(demo)).cells);
    const tables = (name: string) => deps[name].reads.filter((r) => !r.startsWith("fn:"));
    expect(deps.sales.defines).toEqual(["$days", "sales"]);
    expect(tables("sales")).toEqual([]);
    expect(tables("enrich")).toEqual(["sales"]);
    expect(tables("by_region")).toEqual(["enrich"]);
    expect(tables("plot")).toEqual(["by_region"]);
    expect(deps.notes).toEqual({ defines: [], reads: [] });
  });

  test("add, move, set language and remove keep files numbered", async () => {
    const { Store } = await import("../server/store");
    const root = await mkdtemp(join(tmpdir(), "querier-store-"));
    const store = new Store(root);
    await store.createWorkspace("w");
    await store.create("w/nb", "My notebook"); // starts as 01_notes.md, 02_query.sql
    await store.add("w/nb", "python", "query");
    await store.add("w/nb", "md", null);
    await store.move("w/nb", "notes", 2);
    await store.setLang("w/nb", "py", "sql");
    const files = async () => (await Array.fromAsync(new Bun.Glob("*").scan(join(root, "w", "nb")))).sort();
    expect(await files()).toEqual(["01_notes2.md", "02_query.sql", "03_py.sql", "04_notes.md", "notebook.json"]);
    await store.remove("w/nb", "query");
    expect(await files()).toEqual(["01_notes2.md", "02_py.sql", "03_notes.md", "notebook.json"]);
    const [summary] = await store.list();
    expect(summary).toMatchObject({ id: "w/nb", workspace: "w", name: "nb", title: "My notebook", description: "What this notebook answers.", sql: 1, text: 2 });
    await rm(root, { recursive: true });
  });
});

test("a rename rewrites the reads below it and moves the kernel's table", async () => {
  const { Store } = await import("../server/store");
  const root = await mkdtemp(join(tmpdir(), "querier-rename-"));
  const store = new Store(root);
  await store.createWorkspace("w");
  await store.create("w/nb");
  const dir = join(root, "w", "nb");
  await Bun.write(join(dir, "02_query.sql"), "SELECT range AS id FROM RANGE(3);");
  await Bun.write(join(dir, "03_py.py"), "n = query.height  # query\nquery.select('id')");
  await Bun.write(join(dir, "04_agg.sql"), "SELECT COUNT(*) AS n FROM query WHERE 'query' <> '';");

  const s = await runner.open({ notebookDir: dir });
  try {
    for (const [name, lang, src] of [["query", "sql", "SELECT range AS id FROM RANGE(3);"]] as const) await run(s, name, lang, src);
    expect(await store.rename("w/nb", "query", "ids")).toEqual(["py", "agg"]);
    expect(await Bun.file(join(dir, "03_py.py")).text()).toBe("n = ids.height  # query\nids.select('id')");
    expect(await Bun.file(join(dir, "04_agg.sql")).text()).toBe("SELECT COUNT(*) AS n FROM ids WHERE 'query' <> '';");

    await s.rename("query", "ids");
    expect((await s.tables()).tables.map((t) => t.name)).toEqual(["ids"]);
    const [t] = of(await run(s, "agg", "sql", "SELECT COUNT(*) AS n FROM ids;"), "table");
    expect(rows(t)).toEqual([{ n: 3n }]);
  } finally {
    await s.close();
    await rm(root, { recursive: true });
  }
});

test("forgetting a deleted cell's table", async () => {
  const s = await runner.open({ notebookDir: tmpdir() });
  try {
    await run(s, "gone", "sql", "SELECT 1 AS x;");
    expect((await s.tables()).tables.map((t) => t.name)).toEqual(["gone"]);
    await s.forget("gone");
    expect((await s.tables()).tables).toEqual([]);
    expect(of(await run(s, "reader", "python", "gone"), "error")[0].message).toContain("NameError");
  } finally {
    await s.close();
  }
});

test("report settings: checked, and they follow a rename", async () => {
  const { Store } = await import("../server/store");
  const root = await mkdtemp(join(tmpdir(), "querier-report-"));
  const store = new Store(root);
  await store.createWorkspace("w");
  await store.create("w/nb");
  await store.settings("w/nb", {
    report: { show: { query: true, notes: false }, half: ["query"], refresh: "5m", variables: { region: { control: "select", source: { cell: "query", column: "one" } } } },
  });
  expect((await store.load("w/nb")).report?.half).toEqual(["query"]);
  expect(store.settings("w/nb", { report: { refresh: "7m" } })).rejects.toThrow("report.refresh");
  expect(store.settings("w/nb", { report: { show: { "../x": true } } })).rejects.toThrow("report.show");
  await store.rename("w/nb", "query", "totals");
  const r = (await store.load("w/nb")).report!;
  expect(r.show).toEqual({ totals: true, notes: false });
  expect(r.half).toEqual(["totals"]);
  expect(r.variables?.region.source).toEqual({ cell: "totals", column: "one" });
  await store.settings("w/nb", { report: { blocks: [{ id: "a", cell: "totals", width: 6, parts: ["table"] }, { id: "b", text: "hi" }] } });
  expect(store.settings("w/nb", { report: { blocks: [{ id: "a", cell: "totals" }, { id: "a", text: "x" }] } })).rejects.toThrow("its own id");
  expect(store.settings("w/nb", { report: { blocks: [{ id: "a", cell: "totals", parts: ["pie"] }] } })).rejects.toThrow("parts");
  await store.rename("w/nb", "totals", "sums");
  expect((await store.load("w/nb")).report?.blocks?.[0]).toEqual({ id: "a", cell: "sums", width: 6, parts: ["table"] });
  await rm(root, { recursive: true });
});

test("notebooks: renamed (the folder; AI access follows), deleted (with it)", async () => {
  const { Store } = await import("../server/store");
  const { Access } = await import("../server/mcp/access");
  const root = await mkdtemp(join(tmpdir(), "querier-nb-"));
  const store = new Store(join(root, "nbs"));
  const access = new Access(join(root, "mcp.json"));
  await store.createWorkspace("w");
  await store.create("w/sales", "Sales");
  await store.create("w/other");
  await access.setLevel("w/sales", "edit");

  expect(store.renameNotebook("w/sales", "w/other")).rejects.toThrow("already exists");
  expect(() => store.dir("../x")).toThrow("bad notebook id");
  await store.renameNotebook("w/sales", "w/revenue");
  await access.moveNotebook("w/sales", "w/revenue");
  expect((await store.load("w/revenue")).title).toBe("Sales");
  expect(store.load("w/sales")).rejects.toThrow("no notebook");
  expect(await access.level("w/revenue")).toBe("edit");
  expect(await access.level("w/sales")).toBe("read"); // the default again

  await store.removeNotebook("w/revenue");
  await access.moveNotebook("w/revenue", null);
  expect((await store.list()).map((n) => n.name)).toEqual(["other"]);
  expect(store.removeNotebook("w/revenue")).rejects.toThrow("no notebook");
  await rm(root, { recursive: true });
});

test("workspaces: old notebooks move into default; AI access and sandbox inherit", async () => {
  const { Store } = await import("../server/store");
  const { Access } = await import("../server/mcp/access");
  const root = await mkdtemp(join(tmpdir(), "querier-ws-"));
  const nbs = join(root, "nbs");
  // the old layout: notebooks at the top, one of them called "default"
  for (const nb of ["a", "default", "z"]) await Bun.write(join(nbs, nb, "01_q.sql"), "SELECT 1;");
  const store = new Store(nbs);
  const access = new Access(join(root, "mcp.json"));
  await access.setLevel("a", "run");
  const moved = await store.migrate();
  await access.migrate(moved, "default");
  expect((await store.list()).map((n) => n.id).sort()).toEqual(["default/a", "default/default-notebook", "default/z"]);
  expect(await store.migrate()).toEqual([]); // once only
  expect((await store.workspaces())[0]).toMatchObject({ name: "default", title: "Default" });
  expect(await access.level("default/a")).toBe("run");

  await store.createWorkspace("team");
  expect(store.createWorkspace("team")).rejects.toThrow("already exists");
  await store.create("team/q");
  // AI access: the notebook's own, else the workspace's
  await access.setWorkspaceLevel("team", "edit");
  expect(await access.level("team/q")).toBe("edit");
  await access.setLevel("team/q", "off");
  expect(await access.level("team/q")).toBe("off");
  await access.setLevel("team/q", null);
  expect(await access.level("team/q")).toBe("edit");
  // sandbox: the notebook's size over the workspace's; egress from both
  await store.workspaceSettings("team", { sandbox: { vcpus: 2, memory: 1024, egress: ["db.internal:5432"] }, attributes: { team: "finance" } });
  await store.settings("team/q", { sandbox: { memory: 2048, egress: ["api.example.com:443"] } });
  expect(await store.sandboxOf("team/q")).toEqual({ vcpus: 2, memory: 2048, egress: ["db.internal:5432", "api.example.com:443"] });
  expect(store.workspaceSettings("team", { attributes: { "bad key!": "x" } })).rejects.toThrow();
  // moving a notebook across workspaces; a workspace with notebooks is not deleted by accident
  await store.renameNotebook("default/z", "team/z");
  expect((await store.list("team")).map((n) => n.name).sort()).toEqual(["q", "z"]);
  expect(store.removeWorkspace("team")).rejects.toThrow("still holds 2 notebooks");
  await store.renameWorkspace("team", "finance");
  await access.moveWorkspace("team", "finance");
  expect(await access.level("finance/z")).toBe("edit");
  await store.removeWorkspace("finance", true);
  expect((await store.workspaces()).map((w) => w.name)).toEqual(["default"]);
  await rm(root, { recursive: true });
});
