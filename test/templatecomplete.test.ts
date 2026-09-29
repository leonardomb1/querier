import { expect, test } from "bun:test";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { templateCompletion, templateHover, type TemplateData } from "../web/src/lib/templatecomplete";

const data: TemplateData = {
  cells: [
    { name: "kpis", rows: 2, columns: [{ name: "revenue", type: "Float64" }, { name: "orders", type: "Int64" }] },
    { name: "top_products", rows: 10, columns: [{ name: "product", type: "String" }, { name: "revenue", type: "Float64" }] },
  ],
  params: [{ name: "focus", type: "STRING", value: "West" }],
};
const complete = templateCompletion(() => data);
/** What is offered where `|` is. */
function at(text: string) {
  const pos = text.indexOf("|");
  const doc = text.replace("|", "");
  const r = complete(new CompletionContext(EditorState.create({ doc }), pos, true));
  return r ? r.options.map((o) => o.label) : null;
}

test("cells, their view, their columns", () => {
  expect(at("{cells.|}")).toEqual(["kpis", "top_products"]);
  expect(at("{cells.kpis.|}")).toContain("rows");
  expect(at("{cells.kpis.rows[0].|}")).toEqual(["revenue", "orders"]);
  expect(at("{#each cells.top_products.rows as p}{p.|}{/each}")).toEqual(["product", "revenue"]);
  expect(at("<script>const best = $derived(cells.kpis.rows[0]);</script>{best.|}")).toEqual(["revenue", "orders"]);
  expect(at("<script>const ps = $derived(cells.top_products.rows);</script>{#each ps as p}{p.|}{/each}")).toEqual(["product", "revenue"]);
  expect(at("{params.|}")).toEqual(["focus"]);
});

test("in a hook's tag: its name, attributes, and their values", () => {
  expect(at("<|")).toEqual(["Output", "Chart", "Table", "Value", "Control"]);
  expect(at('<Value |')).toContain("column");
  expect(at('<Value cell="kpis" |')).not.toContain("cell");
  expect(at('<Value cell="|')).toEqual(["kpis", "top_products"]);
  expect(at('<Value cell="kpis" column="|')).toEqual(["revenue", "orders"]);
  expect(at('<Table cell="top_products" columns={["product", "|')).toEqual(["product", "revenue"]);
  expect(at('<Value format="|')).toEqual(["number", "currency", "percent", "compact"]);
  expect(at('<Output parts={["|')).toEqual(["chart", "table", "text"]);
  expect(at('<Control param="|')).toEqual(["focus"]);
  expect(at('<div class="|')).toBeNull(); // HTML's own
});

test("Svelte blocks, runes in the script, hooks in the import", () => {
  expect(at("{#|")).toContain("#each");
  expect(at("<script>let x = $|</script>")).toContain("$derived");
  expect(at("<p>$|</p>")).toBeNull();
  expect(at('<script>import { Va| } from "querier";</script>')).toContain("Value");
});

test("hover: a hook's use, a cell's columns, a PARAM's value", () => {
  expect(templateHover("Value", data)?.rows?.map((r) => r[0])).toContain("compare");
  expect(templateHover("kpis", data)).toMatchObject({ title: "kpis", sub: "2 rows", rows: [["revenue", "float64"], ["orders", "int64"]] });
  expect(templateHover("focus", data)).toMatchObject({ title: "$focus", sub: "STRING = West" });
  expect(templateHover("nothing", data)).toBeNull();
});
