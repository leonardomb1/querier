// What part of a report block a cell's output is (shared/report.ts `Part`).

import type { Part } from "../../../shared/report";
import type { Output } from "./conn.svelte";

/** Charts (Altair, matplotlib), tables (results, Great Tables), text (what it printed); null: always shown. */
export function partOf(o: Output): Part | null {
  if (o.type === "table") return "table";
  if (o.type === "stream") return "text";
  if (o.type === "display") {
    if (o.mime === "application/vnd.vegalite+json" || o.mime.startsWith("image/")) return "chart";
    if (o.mime === "text/html") return "table";
    return "text";
  }
  return null; // errors, loads: whatever the block shows, these do too
}

/** The parts a cell's output has, in the order they are offered. */
export function partsIn(outputs: Output[]): Part[] {
  const have = new Set(outputs.map(partOf).filter((p): p is Part => p != null));
  return (["chart", "table", "text"] as Part[]).filter((p) => have.has(p));
}

/** The cells a template names: <Output cell="x">, cells.x, cells["x"]. */
export function templateCells(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/\bcell\s*=\s*["'{]\s*["']?([A-Za-z_]\w*)/g)) out.add(m[1]);
  for (const m of source.matchAll(/\bcells\s*(?:\.\s*([A-Za-z_]\w*)|\[\s*["']([A-Za-z_]\w*)["']\s*\])/g)) out.add(m[1] ?? m[2]);
  return [...out];
}

/** A report's blocks as a Svelte template to start from: the same layout, as code. */
export function blocksToTemplate(
  blocks: import("../../../shared/report").Block[],
  md: (cell: string) => string | null,
  render: (markdown: string) => string,
): string {
  // markdown becomes HTML, where Svelte reads { } as code
  const html = (m: string) => render(m).trim().replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");
  const indent = (t: string, n: number) => t.split("\n").map((l) => (l ? " ".repeat(n) + l : l)).join("\n");
  const body = blocks.map((b) => {
    const inner: string[] = [];
    if (b.title) inner.push(`<h3>${esc(b.title)}</h3>`);
    const prose = b.cell == null ? (b.text ?? "") : md(b.cell);
    if (prose != null) inner.push(`<div class="prose">\n${indent(html(prose), 2)}\n</div>`);
    else inner.push(b.parts?.length ? `<Output cell="${b.cell}" parts={${JSON.stringify(b.parts)}} />` : `<Output cell="${b.cell}" />`);
    if (b.caption) inner.push(`<p class="caption">${esc(b.caption)}</p>`);
    const span = b.width && b.width !== 12 ? ` style="grid-column: span ${b.width}"` : "";
    return `  <section${span}>\n${indent(inner.join("\n"), 4)}\n  </section>`;
  });
  return `<script>
  // The report as a Svelte template. The hooks from "querier":
  //   <Output cell="x" parts={["chart"]} />   a cell's output (all, or chart / table / text)
  //   <Chart cell="x" />  <Table cell="x" columns={["a", "b"]} />
  //   <Value cell="x" column="revenue" label="Revenue" format="currency" />
  //   <Control param="region" options={[...]} />   setParam("region", "north")
  // and the data: cells.x.rows (plain objects, up to 5,000), cells.x.state, params.region.
  import { Output } from "querier";
  let { cells, params } = $props();
</script>

<div class="report">
${body.join("\n\n")}
</div>

<style>
  .report {
    display: grid;
    grid-template-columns: repeat(12, minmax(0, 1fr));
    gap: 2rem 2.5rem;
  }
  section {
    grid-column: span 12;
    min-width: 0;
  }
  @media (max-width: 56rem) {
    section {
      grid-column: span 12 !important;
    }
  }
  h3 {
    margin: 0 0 0.5rem;
    font-size: 1rem;
  }
  .caption {
    margin: 0.5rem 0 0;
    font-size: 0.78rem;
    color: var(--muted);
  }
  .prose {
    line-height: 1.65;
    max-width: 68ch;
    color: var(--ink-2);
  }
</style>
`;
}
