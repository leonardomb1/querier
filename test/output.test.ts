import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tableFromIPC } from "apache-arrow";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Host } from "../server/host";
import { LocalRunner } from "../server/runner/local";
import { Store } from "../server/store";

// the microVM's file handling without a VM: the kernel runs on a copy of the
// notebook, as in the sandbox, and output/ comes back through the host
let dir: string;
let store: Store;
let host: Host;
const out = () => join(dir, "nb/default/demo/output");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "querier-out-"));
  await cp(resolve(import.meta.dir, "fixtures/demo"), join(dir, "nb/default/demo"), { recursive: true });
  store = new Store(join(dir, "nb"));
  host = new Host("default/demo", store, new LocalRunner({ copy: true }), { env: async () => ({}) });
});

afterAll(async () => {
  await host.close();
  await rm(dir, { recursive: true, force: true });
});

async function bytes(it: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const p of it) parts.push(p);
  return Buffer.concat(parts);
}

describe("export", () => {
  test("a cell's whole result, as Parquet and as CSV", async () => {
    await host.runAndWait(["enrich"], {}, 60_000);
    const pq = await bytes(await host.export("enrich", "parquet"));
    expect(pq.subarray(0, 4).toString()).toBe("PAR1");
    // the full 5,000 rows, read back through the kernel's own polars
    const back = await host.scratch("python", `import io\npl.read_parquet(io.BytesIO(bytes.fromhex("${pq.toString("hex")}"))).height`, {});
    expect(back.events.some((e) => e.meta.event.type === "display" && new TextDecoder().decode(e.data) === "5000")).toBe(true);
    const csv = (await bytes(await host.export("enrich", "csv"))).toString();
    expect(csv.split("\n")[0]).toBe("id,region,day,amount,amount_tax,month");
    expect(csv.trim().split("\n").length).toBe(5001);
  });

  test("no result, no file", async () => {
    await expect(host.export("nope", "parquet")).rejects.toThrow("run it first");
  });
});

describe("output/", () => {
  test("what a sandboxed cell writes there lands in the notebook folder", async () => {
    const r = await host.scratch("python", `sales.write_parquet("output/sales.parquet")\nimport os\nos.makedirs("output/sub", exist_ok=True)\nopen("output/sub/note.txt", "w").write("hello")`, {});
    expect(r.ok).toBe(true);
    expect(await readdir(out())).toContain("sales.parquet");
    expect(await Bun.file(join(out(), "sub/note.txt")).text()).toBe("hello");
    // basalt reads it back from where the cell wrote it
    const q = await host.scratch("sql", "SELECT COUNT(*) AS n FROM 'output/sales.parquet';", {});
    const t = tableFromIPC(q.events.find((e) => e.meta.event.type === "table")!.data!);
    expect(Number(t.getChild("n")!.get(0))).toBe(5000);
    const notes = r.events.filter((e) => e.meta.event.type === "stream").map((e) => e.meta.event.text).join("");
    expect(notes).toContain("saved output/sales.parquet");
    expect(notes).toContain("saved output/sub/note.txt (5 B)");
  });

  test("a rewrite replaces the file; a delete deletes it", async () => {
    await host.scratch("python", `open("output/sub/note.txt", "w").write("bye")`, {});
    expect(await Bun.file(join(out(), "sub/note.txt")).text()).toBe("bye");
    await host.scratch("python", `import os\nos.remove("output/sub/note.txt")`, {});
    expect(await Bun.file(join(out(), "sub/note.txt")).exists()).toBe(false);
  });

  test("a large file comes back in chunks, intact", async () => {
    await host.scratch("python", `import os\nopen("output/big.bin", "wb").write(bytes(range(256)) * (48 * 1024))`, {});
    const f = Bun.file(join(out(), "big.bin"));
    expect(f.size).toBe(256 * 48 * 1024); // 12 MB: three chunks
    const b = new Uint8Array(await f.arrayBuffer());
    expect(b[0]).toBe(0);
    expect(b[255]).toBe(255);
    expect(b[b.length - 1]).toBe(255);
  });

  test("the host refuses a path that leaves output/, whatever the kernel says", async () => {
    const keep = (path: string) =>
      (host as any).keepFile({ type: "file", path, offset: 0, size: 4, data: new TextEncoder().encode("evil") });
    for (const p of ["../01_sales.sql", "../../../etc/x", "/etc/passwd", "sub/../../notebook.json"]) {
      expect(await keep(p)).toContain("refused");
    }
    expect(await Bun.file(join(dir, "nb/default/demo/01_sales.sql")).text()).not.toBe("evil");
    expect(await Bun.file(join(dir, "nb/default/demo/notebook.json")).text()).not.toBe("evil");
  });

  test("nothing outside output/ comes back", async () => {
    await host.scratch("python", `open("01_sales.sql", "w").write("DROP")\nopen("/tmp/x", "w").write("x")`, {});
    expect(await Bun.file(join(dir, "nb/default/demo/01_sales.sql")).text()).not.toBe("DROP");
  });
});
