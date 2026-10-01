import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Host } from "../server/host";
import { Access } from "../server/mcp/access";
import { mcpServer } from "../server/mcp/server";
import { LocalRunner } from "../server/runner/local";
import { Store } from "../server/store";

let dir: string;
let access: Access;
let client: Client;
/** What the token's owner may do (their roles and policies): everything, unless a test says otherwise. */
let ownerMay: (action: string) => boolean = () => true;
const hosts = new Map<string, Host>();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "querier-mcp-"));
  await cp(resolve(import.meta.dir, "fixtures/demo"), join(dir, "nb/default/demo"), { recursive: true });
  const store = new Store(join(dir, "nb"));
  // the kernel's environment: a connection's credential
  const secrets = { env: async () => ({ API_KEY: "hunter2-very-secret" }) };
  access = new Access(join(dir, "mcp.json"));
  const runner = new LocalRunner();
  const host = (nb: string) => hosts.get(nb) ?? (hosts.set(nb, new Host(nb, store, runner, secrets)), hosts.get(nb)!);
  const server = mcpServer({ store, access, host, hosts: (nb) => [host(nb)], changed: () => {}, may: async (_nb, a) => ownerMay(a) }, { id: "t", name: "test", created: 0 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "test", version: "1" });
  await client.connect(b);
});

afterAll(async () => {
  await client.close();
  await Promise.all([...hosts.values()].map((h) => h.close()));
  await rm(dir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const r: any = await client.callTool({ name, arguments: args });
  return { error: !!r.isError, text: r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n"), content: r.content };
}

describe("access", () => {
  test("tokens: shown once, verified by hash, revoked at once", async () => {
    const { client: c, token } = await access.create("laptop", "sysadmin:root");
    expect((await access.verify(token))?.id).toBe(c.id);
    expect(await access.verify(token + "x")).toBeNull();
    expect(await Bun.file(access.file).text()).not.toContain(token);
    await access.revoke(c.id);
    expect(await access.verify(token)).toBeNull();
  });

  test("read by default: code and shapes, no rows, no running", async () => {
    expect(await access.level("default/demo")).toBe("read");
    const nb = await call("read_notebook", { notebook: "default/demo" });
    expect(nb.text).toContain("## by_region (sql");
    expect(nb.text).toContain("FROM enrich");
    const run = await call("run_cells", { notebook: "default/demo", cells: ["by_region"] });
    expect(run.error).toBe(true);
    expect(run.text).toContain("needs run access");
  });

  test("a token reaches no further than its owner: a Viewer's token can't run, even at run level", async () => {
    await access.setLevel("default/demo", "run");
    ownerMay = (a) => a === "notebook.view" || a === "notebook.readCode";
    try {
      expect((await call("list_notebooks")).text).toContain("default/demo");
      expect((await call("list_notebooks")).text).toContain("access: read");
      const run = await call("run_cells", { notebook: "default/demo", cells: ["by_region"] });
      expect(run.error).toBe(true);
      expect(run.text).toContain("this token's owner has read");
      // an owner who can't see it: the notebook isn't there at all
      ownerMay = () => false;
      expect((await call("list_notebooks")).text).not.toContain("demo");
      expect((await call("read_notebook", { notebook: "default/demo" })).text).toContain("no notebook");
    } finally {
      ownerMay = () => true;
      await access.setLevel("default/demo", "read");
    }
  });

  test("off hides the notebook", async () => {
    await access.setLevel("default/demo", "off");
    expect((await call("list_notebooks")).text).not.toContain("demo");
    expect((await call("read_notebook", { notebook: "default/demo" })).error).toBe(true);
    await access.setLevel("default/demo", "read");
  });
});

describe("run", () => {
  beforeAll(() => access.setLevel("default/demo", "run"));

  test("runs a cell after what it needs, with rows", async () => {
    const r = await call("run_cells", { notebook: "default/demo", cells: ["by_region"], rows: 2 });
    expect(r.error).toBe(false);
    expect(r.text).toContain("Ran sales, enrich, by_region.");
    expect(r.text).toContain("| region | orders | revenue |");
    expect(r.text).toContain("(first 2 of 4)");
    // read_notebook still shows shapes only
    const nb = await call("read_notebook", { notebook: "default/demo" });
    expect(nb.text).toContain("by_region (sql, 03_by_region.sql) — fresh");
    expect(nb.text).not.toContain("| region |");
  });

  test("list_cells: each cell in a line, its state and what it reads, no sources", async () => {
    const r = await call("list_cells", { notebook: "default/demo" });
    expect(r.error).toBe(false);
    expect(r.text).toMatch(/^4\. notes \(md, \d+ lines\)$/m);
    expect(r.text).toMatch(/^3\. by_region \(sql, 7 lines, (fresh|stale|never)\); defines by_region; reads enrich$/m);
    expect(r.text).not.toContain("SELECT");
  });

  test("scratch queries see the notebook's tables; secrets are masked", async () => {
    const q = await call("run_query", { notebook: "default/demo", lang: "sql", source: "SELECT COUNT(*) AS n FROM enrich;" });
    expect(q.text).toContain("| 5000 |");
    const p = await call("run_query", { notebook: "default/demo", lang: "python", source: "import os\nprint(os.environ['API_KEY'])" });
    expect(p.text).toContain("••••••");
    expect(p.text).not.toContain("hunter2");
  });

  test("editing needs edit", async () => {
    const w = await call("write_cell", { notebook: "default/demo", cell: "x", lang: "sql", source: "SELECT 1;" });
    expect(w.error).toBe(true);
  });
});

describe("edit", () => {
  beforeAll(() => access.setLevel("default/demo", "edit"));

  test("adds, renames and deletes a cell", async () => {
    expect((await call("write_cell", { notebook: "default/demo", cell: "top", lang: "sql", after: "by_region", source: "SELECT * FROM by_region LIMIT 1;" })).error).toBe(false);
    expect(await readdir(join(dir, "nb/default/demo"))).toContain("04_top.sql");
    expect((await call("rename_cell", { notebook: "default/demo", cell: "top", to: "best" })).error).toBe(false);
    expect(await readdir(join(dir, "nb/default/demo"))).toContain("04_best.sql");
    expect((await call("delete_cell", { notebook: "default/demo", cell: "best" })).error).toBe(false);
    expect(await readdir(join(dir, "nb/default/demo"))).not.toContain("04_best.sql");
  });

  test("edit_cell: exact, unique, all or nothing", async () => {
    const before = (await Bun.file(join(dir, "nb/default/demo/03_by_region.sql")).text());
    const amb = await call("edit_cell", { notebook: "default/demo", cell: "by_region", edits: [{ old: "AS", new: "as" }] });
    expect(amb.error).toBe(true);
    expect(amb.text).toContain("occurs");
    // the second edit fails: the first mustn't stick
    const half = await call("edit_cell", { notebook: "default/demo", cell: "by_region", edits: [{ old: "DESC", new: "ASC" }, { old: "nope", new: "x" }] });
    expect(half.error).toBe(true);
    expect(await Bun.file(join(dir, "nb/default/demo/03_by_region.sql")).text()).toBe(before);
    const ok = await call("edit_cell", { notebook: "default/demo", cell: "by_region", edits: [{ old: "ORDER BY revenue DESC", new: "ORDER BY revenue DESC\nLIMIT 2" }] });
    expect(ok.error).toBe(false);
    expect(ok.text).toMatch(/\d+  LIMIT 2/);
    expect(await Bun.file(join(dir, "nb/default/demo/03_by_region.sql")).text()).toContain("DESC\nLIMIT 2");
    const all = await call("edit_cell", { notebook: "default/demo", cell: "by_region", edits: [{ old: "AS", new: "as", all: true }] });
    expect(all.error).toBe(false);
    await Bun.write(join(dir, "nb/default/demo/03_by_region.sql"), before);
  });

    test("set_report: blocks in any order, widths, parts; read_notebook says so", async () => {
    let nb = await call("read_notebook", { notebook: "default/demo" });
    // by default: markdown, and what nothing reads (plot reads by_region, so by_region isn't shown)
    expect(nb.text).toContain("Report (default layout): notes, plot");
    expect((await call("set_report", { notebook: "default/demo", blocks: [{ id: "a", cell: "nope" }] })).error).toBe(true);
    expect((await call("set_report", { notebook: "default/demo", blocks: [{ id: "a", cell: "plot", width: 5 }] })).error).toBe(true);
    const ok = await call("set_report", {
      notebook: "default/demo",
      blocks: [
        { id: "t", text: "## Revenue by region" },
        { id: "a", cell: "plot", width: 8, parts: ["chart"], title: "Revenue" },
        { id: "b", cell: "by_region", width: 4, parts: ["table"] },
      ],
      refresh: "5m",
    });
    expect(ok.error).toBe(false);
    nb = await call("read_notebook", { notebook: "default/demo" });
    expect(nb.text).toContain("Report: text, plot 8/12 [chart] “Revenue”, by_region 4/12 [table]; refreshes every 5m");
    await call("set_report", { notebook: "default/demo", blocks: null, refresh: null });
    expect((await call("read_notebook", { notebook: "default/demo" })).text).toContain("Report (default layout): notes, plot\n");
  });
});

describe("render", () => {
  test("a Vega-Lite chart reads as its views, not its inline data", async () => {
    const { chartSummary } = await import("../server/mcp/render");
    const spec = {
      vconcat: [
        { hconcat: [
          { title: "Invoice value", layer: [
            { mark: { type: "bar" }, encoding: { x: { field: "from", scale: { type: "log" } }, y: { field: "invoices" } } },
            { mark: "rule", encoding: { x: { field: "value" } } },
          ] },
          { title: "Monthly", mark: "line", encoding: { x: { field: "month" }, y: { field: "revenue" } } },
        ] },
      ],
      datasets: { a: Array(5000).fill({}), b: [{}, {}] },
    };
    expect(chartSummary(spec)).toBe(
      "Chart (Vega-Lite), 2 views, 5,002 data rows:\n- “Invoice value”: bar (x=from (log), y=invoices) + rule (x=value)\n- “Monthly”: line (x=month, y=revenue)",
    );
  });
});

describe("report template", () => {
  beforeAll(() => access.setLevel("default/demo", "edit"));
  test("write, build errors back, read", async () => {
    const bad = await call("write_report_template", { notebook: "default/demo", source: `<script>import x from "node:fs";</script>` });
    expect(bad.error).toBe(true);
    expect(bad.text).toContain(`only "svelte" and "querier"`);
    const ok = await call("write_report_template", {
      notebook: "default/demo",
      source: `<script>\n  import { Value, Chart } from "querier";\n  let { cells } = $props();\n</script>\n<Value cell="by_region" column="revenue" label="Top region" />\n<Chart cell="plot" />\n<p>{cells.by_region.rowCount} regions</p>`,
    });
    expect(ok.error).toBe(false);
    expect((await call("read_notebook", { notebook: "default/demo" })).text).toContain("Report template: report.svelte");
    expect((await call("read_report_template", { notebook: "default/demo" })).text).toContain(`<Value cell="by_region"`);
  }, 60_000);

  test("edit_report_template: part of it, as edit_cell; all or nothing; the build's errors back", async () => {
    const file = join(dir, "nb/default/demo/report.svelte");
    const before = await Bun.file(file).text();
    // ambiguous, or half of the edits failing: nothing changes
    expect((await call("edit_report_template", { notebook: "default/demo", edits: [{ old: "cell=", new: "cell =" }] })).text).toContain("occurs");
    const half = await call("edit_report_template", { notebook: "default/demo", edits: [{ old: "Top region", new: "Best" }, { old: "nope", new: "x" }] });
    expect(half.error).toBe(true);
    expect(await Bun.file(file).text()).toBe(before);
    // a part changed: the lines around it, numbered, and it still builds
    const ok = await call("edit_report_template", { notebook: "default/demo", edits: [{ old: `label="Top region"`, new: `label="Best region"` }] });
    expect(ok.error).toBe(false);
    expect(ok.text).toMatch(/\d+  <Value cell="by_region" column="revenue" label="Best region" \/>/);
    expect(ok.text).toContain("It builds");
    // one that breaks the build is saved, and says where
    const broken = await call("edit_report_template", { notebook: "default/demo", edits: [{ old: "<p>{cells", new: "<p>{cells." }] });
    expect(broken.error).toBe(true);
    expect(broken.text).toContain("doesn't build");
    await Bun.write(file, before);
  }, 60_000);
});
