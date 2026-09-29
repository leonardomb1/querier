// The runtime of a report template, inside its sandboxed frame. The report page
// sends what the template may know — its cells' outputs, the PARAM values, the
// theme — as messages; the template can ask back for one thing: to set a PARAM.
// It never reaches Querier itself: the frame has no origin of its own.

import type { CellRun, Output } from "../lib/conn.svelte";
import { arrowTable, kindOf, numeric } from "../lib/format";
import { zoom } from "../lib/zoom.svelte";

export interface CellView {
  /** idle, queued, running, ok, error */
  state: string;
  /** the cell's result table as plain objects (numbers, strings, Dates), up to the first 5,000 rows */
  rows: Record<string, unknown>[];
  columns: { name: string; type: string }[];
  /** rows in the whole result; more than `rows.length` when the page holds a preview */
  rowCount: number;
  /** what the cell printed */
  text: string;
  error: string | null;
  outputs: Output[];
}

class Store {
  cells = $state<Record<string, CellRun>>({});
  params = $state<Record<string, string>>({});
  /** the notebook's PARAMs: chart selections named after one set it */
  paramNames = $state<string[]>([]);
}
export const store = new Store();

const EMPTY: CellView = { state: "idle", rows: [], columns: [], rowCount: 0, text: "", error: null, outputs: [] };
const views = new WeakMap<object, CellView>();

function rowsOf(bytes: Uint8Array): Record<string, unknown>[] {
  const t = arrowTable(bytes);
  const fields = t.schema.fields.map((f) => {
    const k = kindOf(f.type);
    const num = numeric(f);
    const conv =
      k === "date" || k === "timestamp"
        ? (v: any) => (v == null ? null : new Date(Number(v)))
        : k === "decimal"
          ? num
          : k === "int"
            ? (v: any) => (typeof v === "bigint" && v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v)
            : (v: any) => v;
    return { name: f.name, vec: t.getChild(f.name)!, conv };
  });
  const out = new Array(t.numRows);
  for (let i = 0; i < t.numRows; i++) {
    const row: Record<string, unknown> = {};
    for (const f of fields) row[f.name] = f.conv(f.vec.get(i));
    out[i] = row;
  }
  return out;
}

function viewOf(name: string): CellView {
  const run = store.cells[name];
  if (!run) return EMPTY;
  let v = views.get(run);
  if (!v) {
    const outputs = run.outputs;
    const result = outputs.findLast((o) => o.type === "table" && o.name === name) ?? outputs.findLast((o) => o.type === "table");
    let rows: Record<string, unknown>[] | undefined;
    v = {
      state: run.state,
      // decoded on first use, once per run
      get rows() {
        return (rows ??= result?.type === "table" ? rowsOf(result.arrow) : []);
      },
      columns: result?.type === "table" ? result.columns : [],
      rowCount: result?.type === "table" ? result.rows : 0,
      text: outputs.flatMap((o) => (o.type === "stream" ? [o.text] : [])).join(""),
      error: outputs.flatMap((o) => (o.type === "error" ? [o.message] : [])).join("\n") || null,
      outputs,
    };
    views.set(run, v);
  }
  return v;
}

/** `cells.monthly.rows`: every cell by name; one that hasn't run reads as empty. */
export const cells: Record<string, CellView> = new Proxy({} as Record<string, CellView>, {
  get: (_, name) => (typeof name === "string" ? viewOf(name) : undefined),
  has: (_, name) => typeof name === "string" && name in store.cells,
  ownKeys: () => Object.keys(store.cells),
  getOwnPropertyDescriptor: (_, name) => (typeof name === "string" && name in store.cells ? { enumerable: true, configurable: true, value: viewOf(name) } : undefined),
});

/** `params.region`: the PARAM values the report runs with. */
export const params: Record<string, string> = new Proxy({} as Record<string, string>, {
  get: (_, name) => (typeof name === "string" ? (store.params[name] ?? "") : undefined),
  ownKeys: () => Object.keys(store.params),
  getOwnPropertyDescriptor: (_, name) => (typeof name === "string" && name in store.params ? { enumerable: true, configurable: true, value: store.params[name] } : undefined),
});

/** Ask the report to set a PARAM (clearing it with ""): the cells that read it run again. */
export function setParam(name: string, value: unknown) {
  parent.postMessage({ type: "param", name, value: value == null ? "" : String(value) }, "*");
}

/** Wait for the report page's first message, then mount the template. */
export function start(mount: (target: Element, props: { cells: typeof cells; params: typeof params }) => unknown) {
  let mounted = false;
  addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    switch (m?.type) {
      case "init": {
        document.documentElement.dataset.theme = m.theme;
        zoom.set(m.zoom);
        const style = document.createElement("style");
        style.textContent = m.css;
        document.head.prepend(style);
        store.paramNames = m.paramNames ?? [];
        store.params = m.params ?? {};
        if (!mounted) {
          mounted = true;
          mount(document.getElementById("app")!, { cells, params });
        }
        break;
      }
      case "cell":
        store.cells[m.cell] = m.run;
        break;
      case "params":
        store.params = m.params ?? {};
        break;
      case "theme":
        document.documentElement.dataset.theme = m.theme;
        break;
    }
  });
  // the frame is as tall as the template
  const report = () => parent.postMessage({ type: "height", px: Math.ceil(document.documentElement.getBoundingClientRect().height) }, "*");
  new ResizeObserver(report).observe(document.documentElement);
  addEventListener("error", (e) => parent.postMessage({ type: "error", message: String(e.message) }, "*"));
  parent.postMessage({ type: "ready" }, "*");
}
