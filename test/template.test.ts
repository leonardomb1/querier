import { expect, test } from "bun:test";
import { marked } from "marked";
import { buildTemplate } from "../server/template";
import { blocksToTemplate, templateCells } from "../web/src/lib/report";

test("the cells a template names", () => {
  expect(templateCells(`<Output cell="a" /><Chart cell='b'/><Table cell={"c"} />{#each cells.d.rows as r}{/each}{cells["e"].state}`)).toEqual(["a", "b", "c", "d", "e"]);
});

test("a layout becomes a template that builds", async () => {
  const src = blocksToTemplate(
    [
      { id: "1", cell: "notes" },
      { id: "2", cell: "plot", width: 8, parts: ["chart"], title: "Revenue {by} region" },
      { id: "3", cell: "by_region", width: 4 },
      { id: "4", text: "Uses `{curly}` braces", caption: "a <b> caption" },
    ],
    (c) => (c === "notes" ? "# Demo\n\nSome {text}." : null),
    (m) => marked.parse(m) as string,
  );
  expect(src).toContain(`<Output cell="plot" parts={["chart"]} />`);
  expect(src).toContain(`style="grid-column: span 8"`);
  expect(src).toContain("Revenue &#123;by&#125; region");
  const built = await buildTemplate(src);
  expect(built.error).toBeUndefined();
  expect(built.js!.length).toBeGreaterThan(1000);
}, 60_000);

test("a template may import only svelte and querier; nothing runs at bundle time", async () => {
  for (const [src, msg] of [
    [`<script>import fs from "node:fs";</script>`, "only"],
    [`<script>import x from "./x.json";</script>`, "only"],
    [`<script>import { a } from "querier" with { type: "macro" };</script>`, "import attributes"],
    [`<script>import("querier");</script>`, "run time"],
  ]) {
    expect((await buildTemplate(src)).error?.message).toContain(msg);
  }
  const bad = await buildTemplate(`<p>{oops</p>`);
  expect(bad.error?.line).toBe(1);
});
