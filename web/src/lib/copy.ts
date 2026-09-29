// A table selection as text for the clipboard: tab-separated (what a
// spreadsheet pastes into cells), with headers, CSV, Markdown, JSON, or one
// column's values as a SQL list.

export type Format = "tsv" | "tsv-head" | "csv" | "markdown" | "json" | "sql";

export interface CopyColumn {
  name: string;
  /** numeric: right-aligned, unquoted in SQL, a number in JSON */
  right: boolean;
  /** the value as a machine reads it (format.ts plainText) */
  plain: (v: any) => string;
  /** the value as shown (Markdown keeps the table's formatting) */
  fmt: (v: any) => string | null;
  vec: { get(i: number): any };
}

// a field holding the separator, a newline or a quote is quoted, as spreadsheets do
const quoted = (sep: RegExp) => (t: string) => (sep.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
const tsvField = quoted(/[\t\n\r"]/);
const csvField = quoted(/[,\n\r"]/);
const mdField = (t: string) => t.replace(/\|/g, "\\|").replace(/\s+/g, " ");

export function copyText(format: Format, cols: CopyColumn[], rows: number[]): string {
  const cell = (c: CopyColumn, r: number) => c.plain(c.vec.get(r));
  switch (format) {
    case "tsv":
    case "tsv-head": {
      const body = rows.map((r) => cols.map((c) => tsvField(cell(c, r))).join("\t"));
      return (format === "tsv-head" ? [cols.map((c) => tsvField(c.name)).join("\t"), ...body] : body).join("\n");
    }
    case "csv":
      return [cols.map((c) => csvField(c.name)).join(","), ...rows.map((r) => cols.map((c) => csvField(cell(c, r))).join(","))].join("\n");
    case "markdown":
      return [
        `| ${cols.map((c) => mdField(c.name)).join(" | ")} |`,
        `|${cols.map((c) => (c.right ? " ---: " : " --- ")).join("|")}|`,
        ...rows.map((r) => `| ${cols.map((c) => mdField(c.fmt(c.vec.get(r)) ?? "")).join(" | ")} |`),
      ].join("\n");
    case "json":
      return JSON.stringify(
        rows.map((r) =>
          Object.fromEntries(
            cols.map((c) => {
              const v = c.vec.get(r);
              if (v == null) return [c.name, null];
              const t = c.plain(v);
              const n = c.right ? Number(t) : NaN;
              // a number JSON can hold exactly; anything bigger stays a string
              return [c.name, Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER && String(n) === t ? n : t];
            }),
          ),
        ),
        null,
        2,
      );
    case "sql": {
      // the first column's distinct values, ready for WHERE x IN (...)
      const c = cols[0];
      const seen = [...new Set(rows.map((r) => c.vec.get(r)).filter((v) => v != null).map((v) => c.plain(v)))];
      return `(${seen.map((v) => (c.right ? v : `'${v.replace(/'/g, "''")}'`)).join(", ")})`;
    }
  }
}

/** To the clipboard. navigator.clipboard needs a secure page (https or
 *  localhost); Querier reached at a LAN address over http falls back to the
 *  older copy command. */
export async function writeClipboard(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) return navigator.clipboard.writeText(text);
  const area = Object.assign(document.createElement("textarea"), { value: text, readOnly: true });
  area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  const back = document.activeElement as HTMLElement | null;
  document.body.append(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  back?.focus({ preventScroll: true });
  if (!ok) throw new Error("the browser refused to copy");
}
