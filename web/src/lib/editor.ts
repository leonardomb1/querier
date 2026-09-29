// What makes a cell feel like VS Code, whichever editor draws it: the docs of a
// basalt function or of a name (as Markdown, for hovers and completion details),
// and the kinds of what the kernel suggests, with their order.

import { fnDoc, signature, type FnDoc } from "./basalt";

/** What hovering a name shows: a table's columns, a param's value. */
export interface HoverInfo {
  title: string;
  sub?: string;
  rows?: [string, string][];
  more?: number;
}

const code = (s: string) => "`" + s.replace(/`/g, "") + "`";

/** A basalt function: its signature (with the argument at `active` in bold), its doc, its kind. */
export function fnMarkdown(fn: FnDoc, active = -1): string {
  const params = fn.params.map((p, i) => (i === active || (active >= fn.params.length && p === "..." && i === fn.params.length - 1) ? `**${p}**` : p));
  return [`\`\`\`sql\n${fn.name}(${fn.params.join(", ")})${fn.returns ? ` → ${fn.returns}` : ""}\n\`\`\``, active >= 0 ? `${fn.name}(${params.join(", ")})` : "", fn.doc, `*${fn.kind} function*`]
    .filter(Boolean)
    .join("\n\n");
}

/** A name: its title, a line under it, and a small table of its parts. */
export function infoMarkdown(info: HoverInfo): string {
  const parts = [code(info.title)];
  if (info.sub) parts.push(info.sub);
  if (info.rows?.length) {
    parts.push(["| | |", "|:--|:--|", ...info.rows.map(([k, v]) => `| ${code(k)} | ${v.replace(/\|/g, "\\|")} |`)].join("\n"));
    if (info.more) parts.push(`*and ${info.more} more*`);
  }
  return parts.join("\n\n");
}

/** A completion, as any editor can show it. */
export interface Suggestion {
  label: string;
  kind: "keyword" | "function" | "method" | "variable" | "property" | "class" | "namespace" | "constant" | "text" | "snippet";
  detail?: string;
  /** Markdown */
  doc?: string;
  /** text inserted instead of the label; a snippet when `snippet` is set (VS Code's $1, ${2:name}) */
  insert?: string;
  snippet?: boolean;
  /** higher comes first */
  boost?: number;
}

// what the kernel says a name is → its kind in the list, and how early it comes
const KIND: Record<string, Suggestion["kind"]> = {
  keyword: "keyword",
  function: "function",
  method: "method",
  param: "variable",
  variable: "variable",
  column: "property",
  table: "class",
  cte: "class",
  class: "class",
  connection: "namespace",
  module: "namespace",
  path: "text",
};
const BOOST: Record<string, number> = { column: 4, table: 3, cte: 3, param: 3, variable: 2, function: 1, method: 1, keyword: -1 };

export function toSuggestion(item: { text: string; kind: string; detail?: string }, lang: string): Suggestion {
  const fn = lang === "sql" && (item.kind === "function" || item.kind === "keyword") ? fnDoc(item.text) : undefined;
  return {
    label: item.text,
    kind: fn ? "function" : (KIND[item.kind] ?? "variable"),
    detail: item.detail || (fn ? `${fn.kind}` : item.kind === "keyword" ? "" : item.kind),
    boost: fn ? 1 : (BOOST[item.kind] ?? 0),
    doc: fn ? fnMarkdown(fn) : undefined,
  };
}

export function signatureOf(name: string) {
  const fn = fnDoc(name);
  return fn && signature(fn);
}

/** A CodeMirror-style snippet ("${}", "${name}") as VS Code's ("$1", "${1:name}", "$0" last). */
export function vsSnippet(template: string): string {
  let n = 0;
  return template.replace(/\$\{([^}]*)\}/g, (_, name: string) => (++n, name ? `\${${n}:${name}}` : `$${n}`));
}
