// Completion and hover for a report template (report.svelte): what the notebook
// gives it — cells and their columns, PARAMs, the "querier" hooks — at the places
// they go. HTML tags and attributes, and the script's own names, come from the
// HTML and JavaScript modes alongside.

import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import type { HoverInfo } from "./editor";

export interface TemplateData {
  cells: { name: string; rows?: number; columns: { name: string; type: string }[] }[];
  params: { name: string; type: string; value: string }[];
}

interface Hook {
  name: string;
  what: string;
  snippet: string;
  props: { name: string; what: string; snippet: string }[];
}

export const HOOKS: Hook[] = [
  {
    name: "Output",
    what: "a cell's output, as the notebook shows it",
    snippet: 'Output cell="${}" />',
    props: [
      { name: "cell", what: "the cell", snippet: 'cell="${}"' },
      { name: "parts", what: "chart, table, text: what of the output (default all)", snippet: 'parts={["${chart}"]}' },
    ],
  },
  { name: "Chart", what: "a cell's chart (Altair, df.plot, matplotlib)", snippet: 'Chart cell="${}" />', props: [{ name: "cell", what: "the cell", snippet: 'cell="${}"' }] },
  {
    name: "Table",
    what: "a cell's result table: sort, select, copy",
    snippet: 'Table cell="${}" />',
    props: [
      { name: "cell", what: "the cell", snippet: 'cell="${}"' },
      { name: "columns", what: "which columns, in this order", snippet: 'columns={["${}"]}' },
    ],
  },
  {
    name: "Value",
    what: "one number from a cell's result, as a KPI",
    snippet: 'Value cell="${}" column="${}" label="${}" />',
    props: [
      { name: "cell", what: "the cell", snippet: 'cell="${}"' },
      { name: "column", what: "its column (default: the first numeric one)", snippet: 'column="${}"' },
      { name: "row", what: "its row (default 0)", snippet: "row={${0}}" },
      { name: "label", what: "the caption above it", snippet: 'label="${}"' },
      { name: "format", what: "number, currency, percent, compact", snippet: 'format="${compact}"' },
      { name: "currency", what: "for format currency: BRL, USD, EUR…", snippet: 'currency="${BRL}"' },
      { name: "decimals", what: "decimal places", snippet: "decimals={${0}}" },
      { name: "compare", what: "a row to compare with: shows the change", snippet: "compare={${1}}" },
    ],
  },
  {
    name: "Control",
    what: "a PARAM's control: a text box, or a dropdown",
    snippet: 'Control param="${}" />',
    props: [
      { name: "param", what: "the PARAM", snippet: 'param="${}"' },
      { name: "label", what: "its caption (default: its name)", snippet: 'label="${}"' },
      { name: "options", what: "a dropdown's values", snippet: "options={[${}]}" },
    ],
  },
];

const VIEW: [string, string, string][] = [
  ["rows", "the result as plain objects, up to 5,000", "object[]"],
  ["columns", "{ name, type } of each column", "array"],
  ["rowCount", "rows in the whole result", "number"],
  ["state", "idle, queued, running, ok, error", "string"],
  ["text", "what the cell printed", "string"],
  ["error", "its error, or null", "string | null"],
  ["outputs", "everything it showed", "array"],
];

const FORMATS = ["number", "currency", "percent", "compact"];
const PARTS = ["chart", "table", "text"];

const BLOCKS: Completion[] = [
  snippetCompletion("#each ${items} as ${item}}\n\t${}\n{/each}", { label: "#each", detail: "loop", type: "keyword" }),
  snippetCompletion("#if ${condition}}\n\t${}\n{/if}", { label: "#if", detail: "condition", type: "keyword" }),
  snippetCompletion(":else}", { label: ":else", type: "keyword" }),
  snippetCompletion(":else if ${condition}}", { label: ":else if", type: "keyword" }),
  snippetCompletion("@const ${name} = ${value}}", { label: "@const", detail: "a name in markup", type: "keyword" }),
  snippetCompletion("@html ${html}}", { label: "@html", detail: "raw HTML", type: "keyword" }),
  snippetCompletion("/each}", { label: "/each", type: "keyword" }),
  snippetCompletion("/if}", { label: "/if", type: "keyword" }),
];

const RUNES: Completion[] = [
  snippetCompletion("$derived(${})", { label: "$derived", detail: "a value computed from others", type: "function" }),
  snippetCompletion("$derived.by(() => {\n\t${}\n})", { label: "$derived.by", detail: "computed, in a function", type: "function" }),
  snippetCompletion("$state(${})", { label: "$state", detail: "a value that changes", type: "function" }),
  snippetCompletion("$effect(() => {\n\t${}\n})", { label: "$effect", detail: "runs when what it reads changes", type: "function" }),
  snippetCompletion("$props()", { label: "$props", detail: "{ cells, params }", type: "function" }),
];

/** Which cell each name stands for: `{#each cells.x.rows as row}`, `r = $derived(cells.x.rows[0])`. */
function aliases(doc: string): { rows: Map<string, string>; lists: Map<string, string> } {
  const rows = new Map<string, string>();
  const lists = new Map<string, string>();
  for (const m of doc.matchAll(/(\w+)\s*=\s*\$derived\(\s*cells\.(\w+)\.rows\s*\)/g)) lists.set(m[1], m[2]);
  for (const m of doc.matchAll(/(\w+)\s*=\s*\$derived\(\s*cells\.(\w+)\.rows\s*\[[^\]]*\]\s*\)/g)) rows.set(m[1], m[2]);
  for (const m of doc.matchAll(/\{#each\s+cells\.(\w+)\.rows\s+as\s+(\w+)/g)) rows.set(m[2], m[1]);
  for (const m of doc.matchAll(/\{#each\s+(\w+)\s+as\s+(\w+)/g)) if (lists.has(m[1])) rows.set(m[2], lists.get(m[1])!);
  return { rows, lists };
}

export function templateCompletion(data: () => TemplateData) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const d = data();
    const pos = ctx.pos;
    const before = ctx.state.sliceDoc(Math.max(0, pos - 3000), pos);
    const doc = ctx.state.doc.toString();
    const cell = (name: string) => d.cells.find((c) => c.name === name);
    const columns = (name: string, from: number): CompletionResult | null => {
      const c = cell(name);
      if (!c) return null;
      return { from, options: c.columns.map((col) => ({ label: col.name, type: "property", detail: col.type.replace(/\(.*\)$/, "").toLowerCase() })), validFor: /^\w*$/ };
    };
    const cellOptions = (from: number): CompletionResult => ({
      from,
      options: d.cells.map((c) => ({ label: c.name, type: "class", detail: c.rows != null ? `${c.rows.toLocaleString()} rows` : "not run" })),
      validFor: /^\w*$/,
    });
    let m: RegExpExecArray | null;

    // cells.x.rows[0].col  and  row.col
    if ((m = /\bcells\.(\w+)\.rows\s*\[[^\]]*\]\.(\w*)$/.exec(before))) return columns(m[1], pos - m[2].length);
    if ((m = /(?<![\w.$])(\w+)\.(\w*)$/.exec(before))) {
      const { rows, lists } = aliases(doc);
      if (rows.has(m[1])) return columns(rows.get(m[1])!, pos - m[2].length);
      if (lists.has(m[1])) return { from: pos - m[2].length, options: [{ label: "length", type: "property" }, { label: "map", type: "method" }, { label: "filter", type: "method" }] };
    }
    // cells.x.<view>  and  cells.<cell>
    if ((m = /\bcells\.(\w+)\.(\w*)$/.exec(before)))
      return { from: pos - m[2].length, options: VIEW.map(([label, what, type]) => ({ label, type: "property", detail: type, info: what })), validFor: /^\w*$/ };
    if ((m = /\bcells\.(\w*)$/.exec(before))) return cellOptions(pos - m[1].length);
    if ((m = /\bparams\.(\w*)$/.exec(before)))
      return { from: pos - m[1].length, options: d.params.map((p) => ({ label: p.name, type: "variable", detail: p.value ? `= ${p.value}` : p.type })), validFor: /^\w*$/ };

    // inside a hook's tag: the tag as typed so far
    // (closed quotes and braces, then maybe one still open: the value being typed)
    const tag = /<([A-Z]\w*)\b((?:[^<>"'{]|"[^"]*"|'[^']*'|\{[^}]*\})*(?:"[^"]*|'[^']*|\{[^}]*)?)$/.exec(before);
    if (tag) {
      const hook = HOOKS.find((h) => h.name === tag[1]);
      const attrs = tag[2];
      if ((m = /\bcell=["'](\w*)$/.exec(attrs))) return cellOptions(pos - m[1].length);
      if ((m = /\bcolumn=["'](\w*)$/.exec(attrs))) {
        const of = /\bcell=["'](\w+)["']/.exec(attrs);
        return of ? columns(of[1], pos - m[1].length) : null;
      }
      if ((m = /\bcolumns=\{\[(?:[^\]]*,\s*)?["'](\w*)$/.exec(attrs))) {
        const of = /\bcell=["'](\w+)["']/.exec(attrs);
        return of ? columns(of[1], pos - m[1].length) : null;
      }
      if ((m = /\bparam=["'](\w*)$/.exec(attrs)))
        return { from: pos - m[1].length, options: d.params.map((p) => ({ label: p.name, type: "variable", detail: p.type })), validFor: /^\w*$/ };
      if ((m = /\bformat=["'](\w*)$/.exec(attrs))) return { from: pos - m[1].length, options: FORMATS.map((f) => ({ label: f, type: "constant" })) };
      if ((m = /\bparts=\{\[(?:[^\]]*,\s*)?["'](\w*)$/.exec(attrs))) return { from: pos - m[1].length, options: PARTS.map((p) => ({ label: p, type: "constant" })) };
      // an attribute name, after a space and outside any value
      if (hook && (m = /\s(\w*)$/.exec(attrs)) && !/=\s*$/.test(attrs.slice(0, attrs.length - m[1].length))) {
        const used = new Set([...attrs.matchAll(/\b(\w+)=/g)].map((x) => x[1]));
        return {
          from: pos - m[1].length,
          options: hook.props.filter((p) => !used.has(p.name)).map((p) => snippetCompletion(p.snippet, { label: p.name, type: "property", info: p.what })),
          validFor: /^\w*$/,
        };
      }
      // somewhere else in a tag: nothing of ours
      if (tag[2] !== "") return null;
    }
    if ((m = /<([A-Z]?\w*)$/.exec(before)) && (!m[1] || /^[A-Z]/.test(m[1])))
      return {
        from: pos - m[1].length,
        options: HOOKS.map((h) => snippetCompletion(h.snippet, { label: h.name, type: "class", detail: "querier", info: h.what })),
        validFor: /^\w*$/,
      };

    // Svelte's blocks, and runes in the script
    if ((m = /\{([#:@/][\w ]*)$/.exec(before))) return { from: pos - m[1].length, options: BLOCKS };
    const inScript = before.lastIndexOf("<script") > before.lastIndexOf("</script>");
    if (inScript && (m = /(?<![\w.])\$(\w*(?:\.\w*)?)$/.exec(before))) return { from: pos - m[0].length, options: RUNES, validFor: /^\$?[\w.]*$/ };
    // the hooks' names, inside import { … }
    if (inScript && (m = /import\s*\{[^}]*?(\w*)$/.exec(before)))
      return {
        from: pos - m[1].length,
        options: [...HOOKS.map((h) => ({ label: h.name, type: "class", info: h.what })), { label: "setParam", type: "function", info: "set a PARAM" }],
        validFor: /^\w*$/,
      };
    return null;
  };
}

/** What hovering a word shows: a hook's use, a cell's columns, a PARAM's value. */
export function templateHover(word: string, data: TemplateData): HoverInfo | null {
  const hook = HOOKS.find((h) => h.name === word);
  if (hook) return { title: `<${hook.snippet.replace(/\$\{([^}]*)\}/g, "$1")}`, sub: hook.what, rows: hook.props.map((p) => [p.name, p.what]) };
  const c = data.cells.find((x) => x.name === word);
  if (c)
    return {
      title: c.name,
      sub: c.rows != null ? `${c.rows.toLocaleString()} rows` : "hasn't run",
      rows: c.columns.slice(0, 12).map((col) => [col.name, col.type.replace(/\(.*\)$/, "").toLowerCase()]),
      more: Math.max(0, c.columns.length - 12),
    };
  const p = data.params.find((x) => x.name === word);
  if (p) return { title: `$${p.name}`, sub: `${p.type}${p.value ? ` = ${p.value}` : ""}` };
  return null;
}
