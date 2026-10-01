// Row search, a small language over a result's columns:
//   000600            any column contains it (case-insensitive)
//   customer:000600   that column contains it
//   state=BA          equals (state!=BA: doesn't)
//   total>1000        compares: numbers as numbers, anything else as text (ISO dates sort as text)
//   -transfer         rows that don't match
//   "north east"      a phrase with spaces
// Terms are ANDed. A name that isn't a column leaves the token as plain text.
// The browser applies it to the rows it holds; the kernel to the whole result.

export type Op = "has" | "=" | "!=" | ">" | ">=" | "<" | "<=";

export interface Term {
  /** the column, as the result names it; null for any column */
  col: string | null;
  op: Op;
  value: string;
  not: boolean;
}

const TOKEN = /(-?)(?:([A-Za-z_][\w$]*)\s*(:|>=|<=|!=|=|>|<)\s*)?(?:"([^"]*)"?|(\S+))/g;

export function parseSearch(q: string, columns: string[]): Term[] {
  const byLower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  const out: Term[] = [];
  for (const m of q.matchAll(TOKEN)) {
    const [raw, neg, name, sym, quoted, bare] = m;
    const value = quoted ?? bare ?? "";
    const col = name ? byLower.get(name.toLowerCase()) : undefined;
    if (name && !col) {
      // not a column: the whole token is text to find
      const text = raw.slice(neg.length);
      if (text) out.push({ col: null, op: "has", value: text.replace(/^"|"$/g, ""), not: !!neg });
      continue;
    }
    if (!value && !col) continue;
    out.push({ col: col ?? null, op: !sym || sym === ":" ? "has" : (sym as Op), value, not: !!neg });
  }
  return out;
}

export interface SearchCol {
  name: string;
  /** numeric: compared as a number */
  numeric: boolean;
  plain: (v: any) => string;
  fmt: (v: any) => string | null;
  num: (v: any) => number | null;
  vec: { get(i: number): any };
}

function test(t: Term, c: SearchCol, row: number): boolean {
  const v = c.vec.get(row);
  if (v == null) return false;
  const want = t.value.toLowerCase();
  const plain = c.plain(v).toLowerCase();
  switch (t.op) {
    case "has":
      return plain.includes(want) || (c.fmt(v) ?? "").toLowerCase().includes(want);
    case "=":
    case "!=": {
      const eq = plain === want || (c.fmt(v) ?? "").toLowerCase() === want;
      return t.op === "=" ? eq : !eq;
    }
    default: {
      const n = Number(t.value.replace(/,/g, ""));
      const cmp = c.numeric && Number.isFinite(n) ? (c.num(v) ?? NaN) - n : plain < want ? -1 : plain > want ? 1 : 0;
      if (Number.isNaN(cmp)) return false;
      return t.op === ">" ? cmp > 0 : t.op === ">=" ? cmp >= 0 : t.op === "<" ? cmp < 0 : cmp <= 0;
    }
  }
}

export function rowMatches(terms: Term[], cols: SearchCol[], row: number): boolean {
  return terms.every((t) => {
    const hit = t.col ? cols.some((c) => c.name === t.col && test(t, c, row)) : cols.some((c) => test(t, c, row));
    return t.not ? !hit : hit;
  });
}

/** What to mark in a column's cells: the text its matching terms look for. */
export function highlights(terms: Term[], col: string): string[] {
  return terms.filter((t) => !t.not && t.op === "has" && t.value && (t.col == null || t.col === col)).map((t) => t.value);
}

/** Split `text` around the parts to mark, case-insensitively. */
export function marked(text: string, needles: string[]): { text: string; hit: boolean }[] {
  if (!needles.length || !text) return [{ text, hit: false }];
  const re = new RegExp(needles.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) continue;
    if (m.index! > at) out.push({ text: text.slice(at, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}
