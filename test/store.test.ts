// The notebook folder's files, changed by several callers at once (an AI client adding
// cells in parallel): every change lands, and the folder stays numbered in order.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";

test("cells added, moved and removed at the same time: none lost, the files numbered without gaps", async () => {
  const root = await mkdtemp(join(tmpdir(), "querier-store-"));
  try {
    await mkdir(join(root, "w/n"), { recursive: true });
    await Bun.write(join(root, "w/workspace.json"), "{}");
    await Bun.write(join(root, "w/n/01_first.sql"), "SELECT 1;\n");
    const store = new Store(root);

    const names = await Promise.all(Array.from({ length: 10 }, (_, i) => store.add("w/n", i % 2 ? "python" : "sql", "first", `-- ${i}\n`, `c${i}`)));
    expect(names.sort()).toEqual(Array.from({ length: 10 }, (_, i) => `c${i}`).sort());
    let book = await store.load("w/n");
    expect(book.cells.length).toBe(11);
    for (const c of book.cells.filter((c) => c.name.startsWith("c"))) expect(c.source).toBe(`-- ${c.name.slice(1)}\n`);

    // and mixed with moves, saves and a removal
    await Promise.all([store.move("w/n", "c3", -1), store.save("w/n", "c5", "-- saved\n"), store.remove("w/n", "c7"), store.add("w/n", "md", null, "# top", "intro")]);
    book = await store.load("w/n");
    expect(book.cells.map((c) => c.name)).toContain("intro");
    expect(book.cells.map((c) => c.name)).not.toContain("c7");
    expect(book.cells.find((c) => c.name === "c5")!.source).toBe("-- saved\n");
    const files = (await readdir(join(root, "w/n"))).filter((f) => /^\d+_/.test(f)).sort();
    expect(files.map((f) => Number(f.split("_")[0]))).toEqual(files.map((_, i) => i + 1));
    expect((await readdir(join(root, "w/n"))).some((f) => f.startsWith(".renumber"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
