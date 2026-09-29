// Completion and hover for a report template (report.svelte): what the notebook
// gives it (cells and their columns, PARAMs, the "querier" hooks) at the places
// they go, and Svelte's own blocks and runes. Plain text in, suggestions out:
// the editor (lib/monaco.ts) draws them.

import { vsSnippet, type HoverInfo, type Suggestion } from "./editor";

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

const snip = (template: string, s: Omit<Suggestion, "insert" | "snippet">): Suggestion => ({ ...s, insert: vsSnippet(template), snippet: true });

// Svelte's blocks and tags, after "{"
const BLOCKS: Suggestion[] = [
  snip("#if ${condition}}\n\t${}\n{/if}", { label: "#if", kind: "keyword", detail: "block", doc: "Show the markup while the condition holds." }),
  snip("#each ${items} as ${item}}\n\t${}\n{/each}", { label: "#each", kind: "keyword", detail: "block", doc: "Repeat the markup for every item." }),
  snip("#await ${promise}}\n\t${}\n{:then ${value}}\n\t\n{/await}", { label: "#await", kind: "keyword", detail: "block", doc: "Markup while a promise is pending, and when it resolves." }),
  snip("#key ${value}}\n\t${}\n{/key}", { label: "#key", kind: "keyword", detail: "block", doc: "Rebuild the markup whenever the value changes." }),
  snip("#snippet ${name}(${args})}\n\t${}\n{/snippet}", { label: "#snippet", kind: "keyword", detail: "block", doc: "A reusable piece of markup, shown with `{@render name()}`." }),
  snip("@render ${name}()}", { label: "@render", kind: "keyword", detail: "tag", doc: "Show a snippet." }),
  snip("@const ${name} = ${value}}", { label: "@const", kind: "keyword", detail: "tag", doc: "A name inside a block: `{@const total = a + b}`." }),
  snip("@html ${html}}", { label: "@html", kind: "keyword", detail: "tag", doc: "Raw HTML, not escaped: only for markup you trust." }),
  snip("@debug ${names}}", { label: "@debug", kind: "keyword", detail: "tag", doc: "Pause in the devtools when these values change." }),
  snip("@attach ${fn}}", { label: "@attach", kind: "keyword", detail: "tag", doc: "Run a function on the element when it mounts." }),
];
const BRANCHES: Record<string, Suggestion[]> = {
  if: [snip(":else if ${condition}}", { label: ":else if", kind: "keyword", detail: "branch" }), { label: ":else", insert: ":else}", kind: "keyword", detail: "branch" }],
  each: [{ label: ":else", insert: ":else}", kind: "keyword", detail: "when there are none" }],
  await: [snip(":then ${value}}", { label: ":then", kind: "keyword", detail: "branch" }), snip(":catch ${error}}", { label: ":catch", kind: "keyword", detail: "branch" })],
};

/** The blocks still open in `text`, innermost last. */
function openBlocks(text: string): string[] {
  const stack: string[] = [];
  for (const m of text.matchAll(/\{([#/])(if|each|await|key|snippet)\b/g)) {
    if (m[1] === "#") stack.push(m[2]);
    else {
      const i = stack.lastIndexOf(m[2]);
      if (i >= 0) stack.splice(i);
    }
  }
  return stack;
}

// runes, in the script and in markup expressions
const RUNES: Suggestion[] = (
  [
    ["$state", "$state(${})", "Reactive state: `let count = $state(0)`."],
    ["$state.raw", "$state.raw(${})", "State that changes only when reassigned, not deeply."],
    ["$state.snapshot", "$state.snapshot(${})", "A plain copy of reactive state."],
    ["$derived", "$derived(${})", "A value computed from others, kept up to date."],
    ["$derived.by", "$derived.by(() => {\n\t${}\n})", "A derived value computed by a function."],
    ["$effect", "$effect(() => {\n\t${}\n})", "Run code when the values it reads change."],
    ["$effect.pre", "$effect.pre(() => {\n\t${}\n})", "An effect that runs before the DOM updates."],
    ["$props", "$props()", "The template's props: `let { cells, params } = $props()`."],
    ["$bindable", "$bindable(${})", "A prop the parent may bind to."],
    ["$inspect", "$inspect(${})", "Log values whenever they change (development only)."],
  ] as [string, string, string][]
).map(([label, tpl, doc]) => snip(tpl, { label, kind: "function", detail: "rune", doc, boost: 2 }));

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

/** What fits at `pos` in `doc`: where the typed word began, and the suggestions. */
export type TemplateResult = { from: number; items: Suggestion[] } | null;

export function templateCompletion(data: () => TemplateData) {
  return (doc: string, pos: number): TemplateResult => {
    const d = data();
    const before = doc.slice(Math.max(0, pos - 3000), pos);
    const cell = (name: string) => d.cells.find((c) => c.name === name);
    const columns = (name: string, from: number): TemplateResult => {
      const c = cell(name);
      if (!c) return null;
      return { from, items: c.columns.map((col) => ({ label: col.name, kind: "property", detail: col.type.replace(/\(.*\)$/, "").toLowerCase() })) };
    };
    const cellOptions = (from: number): TemplateResult => ({
      from,
      items: d.cells.map((c) => ({ label: c.name, kind: "class", detail: c.rows != null ? `${c.rows.toLocaleString()} rows` : "not run" })),
    });
    let m: RegExpExecArray | null;

    // cells.x.rows[0].col  and  row.col
    if ((m = /\bcells\.(\w+)\.rows\s*\[[^\]]*\]\.(\w*)$/.exec(before))) return columns(m[1], pos - m[2].length);
    if ((m = /(?<![\w.$])(\w+)\.(\w*)$/.exec(before))) {
      const { rows, lists } = aliases(doc);
      if (rows.has(m[1])) return columns(rows.get(m[1])!, pos - m[2].length);
      if (lists.has(m[1])) return { from: pos - m[2].length, items: [{ label: "length", kind: "property" }, { label: "map", kind: "method" }, { label: "filter", kind: "method" }] };
    }
    // cells.x.<view>  and  cells.<cell>
    if ((m = /\bcells\.(\w+)\.(\w*)$/.exec(before)))
      return { from: pos - m[2].length, items: VIEW.map(([label, what, type]) => ({ label, kind: "property", detail: type, doc: what })) };
    if ((m = /\bcells\.(\w*)$/.exec(before))) return cellOptions(pos - m[1].length);
    if ((m = /\bparams\.(\w*)$/.exec(before)))
      return { from: pos - m[1].length, items: d.params.map((p) => ({ label: p.name, kind: "variable", detail: p.value ? `= ${p.value}` : p.type })) };

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
        return { from: pos - m[1].length, items: d.params.map((p) => ({ label: p.name, kind: "variable", detail: p.type })) };
      if ((m = /\bformat=["'](\w*)$/.exec(attrs))) return { from: pos - m[1].length, items: FORMATS.map((f) => ({ label: f, kind: "constant" })) };
      if ((m = /\bparts=\{\[(?:[^\]]*,\s*)?["'](\w*)$/.exec(attrs))) return { from: pos - m[1].length, items: PARTS.map((p) => ({ label: p, kind: "constant" })) };
      // an attribute name, after a space and outside any value
      if (hook && (m = /\s(\w*)$/.exec(attrs)) && !/=\s*$/.test(attrs.slice(0, attrs.length - m[1].length))) {
        const used = new Set([...attrs.matchAll(/\b(\w+)=/g)].map((x) => x[1]));
        return {
          from: pos - m[1].length,
          items: hook.props.filter((p) => !used.has(p.name)).map((p) => snip(p.snippet, { label: p.name, kind: "property", doc: p.what })),
        };
      }
      // somewhere else in a tag: nothing of ours
      if (tag[2] !== "") return null;
    }
    if ((m = /<([A-Z]?\w*)$/.exec(before)) && (!m[1] || /^[A-Z]/.test(m[1])))
      return {
        from: pos - m[1].length,
        items: HOOKS.map((h) => snip(h.snippet, { label: h.name, kind: "class", detail: "querier", doc: h.what })),
      };

    // Svelte's blocks and tags after "{" in the markup: the closer of the innermost open block first
    const inScript = before.lastIndexOf("<script") > before.lastIndexOf("</script>");
    if (!inScript && (m = /\{([#:@/]?[\w ]*)$/.exec(before)) && !/\{[^}]*\{[^}]*$/.test(before.slice(-200))) {
      const inner = openBlocks(doc.slice(0, pos - m[0].length)).at(-1);
      const items = [...BLOCKS, ...(inner ? [...(BRANCHES[inner] ?? []), { label: `/${inner}`, insert: `/${inner}}`, kind: "keyword" as const, detail: "close", boost: 3 }] : [])];
      return { from: pos - m[1].length, items };
    }
    // runes: in the script, or in a {…} of the markup
    const inExpr = before.lastIndexOf("{") > before.lastIndexOf("}");
    if ((inScript || inExpr) && (m = /(?<![\w.])\$(\w*(?:\.\w*)?)$/.exec(before))) return { from: pos - m[0].length, items: RUNES };
    // the hooks' names, inside import { … }
    if (inScript && (m = /import\s*\{[^}]*?(\w*)$/.exec(before)))
      return {
        from: pos - m[1].length,
        items: [...HOOKS.map((h) => ({ label: h.name, kind: "class" as const, doc: h.what })), { label: "setParam", kind: "function" as const, doc: "set a PARAM" }],
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
