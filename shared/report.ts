// A notebook's report: a list of blocks, each a cell's output (or text of the
// report's own) on a 12-column grid. Without a saved list, the default: the
// markdown, and the code cells no other cell reads — what the notebook arrives
// at, not the steps on the way.

/** What of a cell's output a block shows; errors and load reports always show. */
export type Part = "chart" | "table" | "text";
export const PARTS: Part[] = ["chart", "table", "text"];
/** Widths in twelfths: ¼ ⅓ ½ ⅔ ¾ and the full row. */
export const WIDTHS = [3, 4, 6, 8, 9, 12] as const;

export interface Block {
  id: string;
  /** the cell whose output it shows; absent for a text block */
  cell?: string;
  /** a text block's markdown */
  text?: string;
  /** twelfths of the row (default 12) */
  width?: number;
  /** parts of the output to show (default all) */
  parts?: Part[];
  title?: string;
  caption?: string;
}

export interface ReportLike {
  blocks?: Block[];
  /** before blocks: shown or hidden against the default, and half-width cells */
  show?: Record<string, boolean>;
  half?: string[];
}

export function shownInReport(cell: string, lang: string, order: string[], up: Record<string, string[]>, show?: Record<string, boolean>): boolean {
  const own = show?.[cell];
  if (own != null) return own;
  if (lang === "md") return true;
  return !order.some((n) => up[n]?.includes(cell));
}

/** The report's blocks: saved ones, else the default (honouring an older show/half). */
export function reportBlocks(report: ReportLike | undefined, cells: { name: string; lang: string }[], up: Record<string, string[]>): Block[] {
  if (report?.blocks) return report.blocks;
  const order = cells.map((c) => c.name);
  return cells
    .filter((c) => shownInReport(c.name, c.lang, order, up, report?.show))
    .map((c) => ({ id: c.name, cell: c.name, width: report?.half?.includes(c.name) ? 6 : 12 }));
}
