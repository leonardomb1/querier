// Cell outputs as text an AI client reads: result shapes always, rows and what
// cells print only when the notebook's access lets data out.

import { DataType, tableFromIPC, type Field } from "apache-arrow";

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const CELL_CHARS = 80;
const TEXT_CHARS = 4000;

function value(v: unknown, f: Field): string {
  if (v == null) return "NULL";
  // dates and timestamps arrive as epoch milliseconds
  if (DataType.isDate(f.type) && typeof v === "number") return new Date(v).toISOString().slice(0, 10);
  if (DataType.isTimestamp(f.type) && (typeof v === "number" || typeof v === "bigint"))
    return new Date(Number(v)).toISOString().replace(".000Z", "Z");
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const j = (v as any).toJSON?.() ?? v;
    return JSON.stringify(j, (_, x) => (typeof x === "bigint" ? x.toString() : x));
  }
  return String(v);
}

const cell = (s: string) => {
  const t = s.replace(/\s+/g, " ").replace(/\|/g, "\\|");
  return t.length > CELL_CHARS ? `${t.slice(0, CELL_CHARS - 1)}…` : t;
};

/** Columns shown in rows: a wide table (an ERP's) would bury the answer. */
const MAX_COLS = 12;

/** The first `limit` rows of an Arrow IPC stream, as a markdown table. */
export function rowsTable(arrow: Uint8Array, limit: number): string {
  const t = tableFromIPC(arrow);
  const fields = t.schema.fields.slice(0, MAX_COLS);
  const more = t.schema.fields.length - fields.length;
  const names = fields.map((f) => f.name);
  const lines = [`| ${names.map(cell).join(" | ")} |`, `|${names.map(() => "---").join("|")}|`];
  const n = Math.min(limit, t.numRows);
  const cols = fields.map((_, i) => t.getChildAt(i));
  for (let r = 0; r < n; r++) lines.push(`| ${cols.map((c, i) => cell(value(c?.get(r), fields[i]))).join(" | ")} |`);
  if (more) lines.push(`(${more} more column${more === 1 ? "" : "s"} not shown: select the ones you need with run_query)`);
  return lines.join("\n");
}

const clip = (s: string, n = TEXT_CHARS) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);

/** A Vega-Lite spec as what a reader needs: each view's title, mark and
 *  fields (the spec itself carries its data inline, often megabytes of it). */
export function chartSummary(spec: any): string {
  const views: string[] = [];
  const walk = (v: any) => {
    if (!v || typeof v !== "object") return;
    for (const k of ["vconcat", "hconcat", "concat", "layer"]) if (Array.isArray(v[k])) {
      if (k === "layer" && v.title) views.push(`“${typeof v.title === "string" ? v.title : v.title.text}”: ${v.layer.map(desc).join(" + ")}`);
      else v[k].forEach(walk);
      return;
    }
    if (v.mark) views.push(`${v.title ? `“${typeof v.title === "string" ? v.title : v.title.text}”: ` : ""}${desc(v)}`);
  };
  const desc = (v: any) => {
    const mark = typeof v.mark === "string" ? v.mark : v.mark?.type;
    const enc = Object.entries(v.encoding ?? {})
      .filter(([k]) => ["x", "y", "x2", "y2", "color", "size", "theta", "column", "row"].includes(k))
      .map(([k, e]: [string, any]) => `${k}=${e?.field ?? (e?.datum !== undefined ? JSON.stringify(e.datum) : e?.value !== undefined ? JSON.stringify(e.value) : e?.aggregate ?? "?")}${e?.scale?.type ? ` (${e.scale.type})` : ""}`);
    return `${mark}${enc.length ? ` (${enc.join(", ")})` : ""}`;
  };
  walk(spec);
  const rows = Object.values(spec.datasets ?? {}).reduce((n: number, d: any) => n + (Array.isArray(d) ? d.length : 0), 0);
  return `Chart (Vega-Lite), ${views.length} view${views.length === 1 ? "" : "s"}${rows ? `, ${rows.toLocaleString("en")} data rows` : ""}:\n${views.map((v) => `- ${v}`).join("\n")}`;
}

/** What a cell's events amount to. `rows`: how many rows to show. Without
 *  `data` (read access), no rows, printed text or visuals: they may be data. */
export function renderEvents(events: { meta: any; data?: Uint8Array }[], rows: number, data = true): Content[] {
  if (!data) rows = 0;
  const out: Content[] = [];
  const text: string[] = [];
  let printed = "";
  let hidden = 0;
  for (const { meta, data: bytes } of events) {
    const ev = meta.event ?? meta;
    switch (ev.type) {
      case "stream":
        printed += ev.text;
        break;
      case "table": {
        const shape = `${ev.rows.toLocaleString("en")} row${ev.rows === 1 ? "" : "s"}${ev.capped ? " (stopped at the row cap: a prefix)" : ""}`;
        const cols = ev.columns.map((c: any) => `${c.name} ${c.type}`).join(", ");
        text.push(`Result${ev.name ? ` \`${ev.name}\`` : ""}: ${shape}; columns: ${cols}`);
        if (rows > 0 && bytes) {
          text.push(rowsTable(bytes, rows));
          if (ev.rows > rows) text.push(`(first ${Math.min(rows, ev.rows)} of ${ev.rows.toLocaleString("en")})`);
        }
        break;
      }
      case "display": {
        const mime: string = ev.mime;
        if (!data) {
          hidden++;
          text.push(`Display: ${mime}`);
        } else if (mime === "image/png" && bytes) {
          out.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: "image/png" });
        } else if (mime === "application/vnd.vegalite+json" && bytes) {
          try {
            text.push(chartSummary(JSON.parse(new TextDecoder().decode(bytes))));
          } catch {
            text.push("Chart (Vega-Lite)");
          }
        } else if (mime === "text/html" && bytes) {
          const html = new TextDecoder().decode(bytes);
          const plain = html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n");
          text.push(`HTML output, as text:\n${clip(plain.trim(), 2000)}`);
        } else if (bytes) {
          text.push(clip(new TextDecoder().decode(bytes)));
        }
        break;
      }
      case "load":
        text.push(
          `LOAD INTO ${ev.target}: ${ev.ok ? "ok" : "failed"}, ${ev.rows_read} read, ${ev.rows_written} written, ${ev.elapsed_ms} ms${ev.reason ? ` — ${ev.reason}` : ""}`,
        );
        break;
      case "loads":
        text.push(`Loads: ${ev.loads_ok} ok, ${ev.loads_failed} failed, ${ev.rows_loaded} rows loaded in ${ev.elapsed_ms} ms`);
        break;
      case "error": {
        const at = ev.line ? ` (line ${ev.line}${ev.col ? `, col ${ev.col}${ev.end_col ? `-${ev.end_col}` : ""}` : ""})` : "";
        text.push(`Error${at}: ${ev.message}${ev.traceback ? `\n${clip(ev.traceback, 2000)}` : ""}`);
        break;
      }
    }
  }
  if (printed) text.unshift(data ? `Printed:\n${clip(printed)}` : `Printed ${printed.length} characters (not shown: this notebook's access is read).`);
  if (hidden) text.push("Rows, printed text and visuals are shown at `run` access or above.");
  if (text.length) out.unshift({ type: "text", text: text.join("\n\n") });
  return out;
}
