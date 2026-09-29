// What the editor knows about basalt SQL without asking the kernel: its words
// for highlighting (basalt-grammar.ts), and its functions with signatures and a
// line of docs (from basalt's language.md) for completion, hover and parameter hints.

const KEYWORD_TEXT = `select from where group by order having limit offset as and or not in is null like between case when then else end
join inner left right full cross semi anti on using with distinct union all asc desc nulls first last over partition rows range
preceding following current row unbounded exists true false cast try_cast load into append replace upsert partial cols split jobs
param let throw create connection function resource options type default body header endpoint doc accept buffer at segment
retain until loaded hours flush every seconds explain analyze describe show tables print for each of parallel sequential continue
stop error call return pushdown paginate page cursor retry except exclude rename anchor schema identifier query http get post
unnest empty interval`;

const TYPE_TEXT = "bool boolean int integer bigint smallint float double real decimal numeric string text varchar char bytes date time timestamp datetime json";

export interface FnDoc {
  name: string;
  /** Parameter names, in order; `...` marks a variadic tail, `?` an optional one. */
  params: string[];
  returns?: string;
  doc: string;
  kind: "scalar" | "aggregate" | "window" | "table";
}

const f = (kind: FnDoc["kind"], name: string, params: string, doc: string, returns?: string): FnDoc => ({
  kind,
  name,
  params: params ? params.split(",").map((p) => p.trim()) : [],
  returns,
  doc,
});

export const FUNCTIONS: FnDoc[] = [
  // strings
  f("scalar", "lower", "s", "The string in lower case.", "string"),
  f("scalar", "upper", "s", "The string in upper case.", "string"),
  f("scalar", "length", "s", "Number of characters. `strlen` is the same.", "int"),
  f("scalar", "strlen", "s", "Number of characters; an alias of `length`.", "int"),
  f("scalar", "trim", "s", "Whitespace removed from both ends.", "string"),
  f("scalar", "substr", "s, start, len?", "Part of `s` from 1-based `start`, `len` characters long.", "string"),
  f("scalar", "replace", "s, from, to", "Every `from` in `s` replaced by `to`.", "string"),
  f("scalar", "concat", "a, ...", "The arguments joined as text; `a || b` is the same.", "string"),
  f("scalar", "starts_with", "s, prefix", "Whether `s` begins with `prefix`.", "bool"),
  f("scalar", "ends_with", "s, suffix", "Whether `s` ends with `suffix`.", "bool"),
  f("scalar", "contains", "s, part", "Whether `part` occurs in `s`.", "bool"),
  f("scalar", "like", "s, pattern", "SQL LIKE as a function: `%` any run, `_` one character.", "bool"),
  f("scalar", "regexp_replace", "s, pattern, replacement", "The first match replaced; `\\1`…`\\9` insert captured groups.", "string"),
  f("scalar", "lpad", "s, n, fill?", "`s` padded on the left to `n` characters.", "string"),
  f("scalar", "rpad", "s, n, fill?", "`s` padded on the right to `n` characters.", "string"),
  f("scalar", "left", "s, n", "The first `n` characters.", "string"),
  f("scalar", "right", "s, n", "The last `n` characters.", "string"),
  f("scalar", "split_part", "s, sep, n", "The `n`-th piece of `s` split on `sep` (1-based).", "string"),
  f("scalar", "strpos", "s, part", "1-based position of `part` in `s`, 0 when absent.", "int"),
  f("scalar", "repeat", "s, n", "`s` repeated `n` times.", "string"),
  f("scalar", "reverse", "s", "The characters of `s` in reverse order.", "string"),
  // nulls and choice
  f("scalar", "coalesce", "a, ...", "The first argument that is not null; `a ?? b` is the same."),
  f("scalar", "nullif", "a, b", "Null when `a = b`, else `a`."),
  f("scalar", "greatest", "a, ...", "The largest argument, nulls ignored."),
  f("scalar", "least", "a, ...", "The smallest argument, nulls ignored."),
  f("scalar", "if", "cond, then, else", "`then` when `cond` holds, else `else`; sugar for CASE."),
  // math
  f("scalar", "abs", "x", "Absolute value."),
  f("scalar", "floor", "x", "Largest integer not above `x`."),
  f("scalar", "ceil", "x", "Smallest integer not below `x`."),
  f("scalar", "round", "x, digits?", "Rounded half away from zero, to `digits` decimals (default 0)."),
  f("scalar", "mod", "a, b", "Remainder of `a / b`; `a % b` is the same."),
  f("scalar", "power", "x, y", "`x` to the power `y`.", "float"),
  f("scalar", "sqrt", "x", "Square root.", "float"),
  f("scalar", "sign", "x", "-1, 0 or 1."),
  f("scalar", "bit_count", "n", "Number of set bits in an integer.", "int"),
  f("scalar", "to_hex", "n", "An integer as hexadecimal text.", "string"),
  f("scalar", "from_hex", "s", "Hexadecimal text as an integer.", "int"),
  // dates
  f("scalar", "now", "", "The current timestamp, fixed for the whole statement.", "timestamp"),
  f("scalar", "today", "", "The current date.", "date"),
  f("scalar", "date_trunc", "unit, ts", "`ts` cut down to `unit`: year, month, day, hour, minute or second.", "timestamp"),
  f("scalar", "extract", "unit, ts", "One field of `ts`; also written `EXTRACT(unit FROM ts)`.", "int"),
  f("scalar", "date_add", "unit, n, ts", "`ts` moved by `n` units; month and year steps clamp the day.", "timestamp"),
  f("scalar", "date_diff", "unit, a, b", "Whole `unit`s from `a` to `b`.", "int"),
  f("scalar", "make_date", "year, month, day", "A date from its parts.", "date"),
  f("scalar", "epoch", "ts", "Seconds since 1970-01-01 UTC.", "int"),
  f("scalar", "to_timestamp", "seconds", "Seconds since the epoch as a timestamp.", "timestamp"),
  f("scalar", "strftime", "ts, format", "`ts` as text: %Y %m %d %H %M %S %y %%.", "string"),
  // json
  f("scalar", "json_get", "doc, path", "One value out of a JSON document as text; `path` like `a.b[0].c`.", "string"),
  // aggregates
  f("aggregate", "count", "x", "Rows (`COUNT(*)`) or non-null values; `COUNT(DISTINCT x)` counts distinct ones.", "int"),
  f("aggregate", "sum", "x", "Total of the group. Exact over INT and DECIMAL.", ""),
  f("aggregate", "avg", "x", "Mean of the group.", "float"),
  f("aggregate", "min", "x", "Smallest value of the group."),
  f("aggregate", "max", "x", "Largest value of the group."),
  f("aggregate", "median", "x", "Middle value of the group (mean of the two middle ones on an even count).", "float"),
  // window
  f("window", "row_number", "", "1, 2, 3… within the partition, in `OVER (ORDER BY …)` order.", "int"),
  f("window", "rank", "", "Rank with gaps after ties.", "int"),
  f("window", "dense_rank", "", "Rank without gaps after ties.", "int"),
  f("window", "lag", "col, n?", "`col` from `n` rows earlier in the partition (default 1); null past the edge."),
  f("window", "lead", "col, n?", "`col` from `n` rows later in the partition (default 1); null past the edge."),
  // sources and names
  f("table", "range", "lo, hi?", "Integers `lo..hi-1` (or `0..lo-1`) as a `range` column."),
  f("table", "json_each", "doc", "One row per element of a JSON array; use with CROSS JOIN UNNEST."),
  f("table", "unnest", "list", "One row per element: `CROSS JOIN UNNEST(SPLIT(tags, ',')) AS tag`."),
  f("table", "split", "s, sep", "`s` split on `sep`, for UNNEST."),
  f("table", "identifier", "name", "A computed string used as a table, file or column name."),
  f("table", "http", "url", "Read a URL exactly as written."),
];

const byName = new Map(FUNCTIONS.map((fn) => [fn.name, fn]));
export const fnDoc = (name: string) => byName.get(name.toLowerCase());

export const signature = (fn: FnDoc) => `${fn.name}(${fn.params.join(", ")})${fn.returns ? ` → ${fn.returns}` : ""}`;

export const KEYWORDS = KEYWORD_TEXT.split(/\s+/).filter(Boolean);
export const TYPES = TYPE_TEXT.split(/\s+/).filter(Boolean);

/** The basalt function call `pos` is inside, which argument it is at, and where its name starts. */
export function callAt(text: string, pos: number): { fn: FnDoc; arg: number; at: number } | null {
  const from = Math.max(0, pos - 2000);
  const before = text.slice(from, pos);
  let depth = 0;
  let arg = 0;
  let quote = false;
  for (let i = before.length - 1; i >= 0; i--) {
    const c = before[i];
    if (c === "'") quote = !quote;
    if (quote) continue;
    if (c === ";") return null;
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth === 0) {
        const m = /([A-Za-z_]\w*)\s*$/.exec(before.slice(0, i));
        const fn = m && fnDoc(m[1]);
        return fn ? { fn, arg, at: from + i - m[0].length } : null;
      }
      depth--;
    } else if (c === "," && depth === 0) arg++;
  }
  return null;
}
