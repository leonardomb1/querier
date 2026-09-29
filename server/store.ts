// Edits to notebook folders. Order lives in the filenames, so every structural
// change renumbers the folder: `01_a.sql 02_b.py ...` always matches what the
// UI shows.

import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renameRefs } from "./analyze";
import { loadNotebook, type Cell, type Lang, type Notebook } from "./notebook";
import { PARTS, WIDTHS, type Block } from "../shared/report";

const NOTEBOOK = /^[A-Za-z0-9][\w-]*$/;
export const CELL_NAME = /^[A-Za-z_]\w*$/;
const EXT: Record<Lang, string> = { sql: "sql", python: "py", md: "md" };

export class Store {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  dir(nb: string): string {
    if (!NOTEBOOK.test(nb)) throw new UserError(`bad notebook name \`${nb}\``);
    return join(this.root, nb);
  }

  // -- the report template: report.svelte in the folder

  async template(nb: string): Promise<string | null> {
    const f = Bun.file(join(this.dir(nb), "report.svelte"));
    return (await f.exists()) ? f.text() : null;
  }

  async saveTemplate(nb: string, source: string) {
    if (source.length > 500_000) throw new UserError("A template is limited to 500 KB.");
    await Bun.write(join(this.dir(nb), "report.svelte"), source);
  }

  async removeTemplate(nb: string) {
    await rm(join(this.dir(nb), "report.svelte"), { force: true });
  }

  /** A notebook's notebook.json, as stored. */
  async readSettings(nb: string): Promise<Record<string, unknown>> {
    const file = Bun.file(join(this.dir(nb), "notebook.json"));
    return (await file.exists()) ? file.json() : {};
  }

  /** Every notebook, most recently edited first, with what the index shows. */
  async list(): Promise<NotebookSummary[]> {
    await mkdir(this.root, { recursive: true });
    const out: NotebookSummary[] = [];
    for (const e of await readdir(this.root, { withFileTypes: true })) {
      if (!e.isDirectory() || !NOTEBOOK.test(e.name)) continue;
      const dir = join(this.root, e.name);
      const files = (await readdir(dir)).filter((f) => !f.startsWith(".")); // not .git, .gitignore
      const modified = Math.max(0, ...(await Promise.all(files.map((f) => stat(join(dir, f)).then((s) => s.mtimeMs, () => 0)))));
      try {
        const nb = await loadNotebook(dir);
        const count = (lang: Lang) => nb.cells.filter((c) => c.lang === lang).length;
        out.push({
          name: nb.name,
          title: nb.title,
          description: nb.description ?? describe(nb.cells),
          sql: count("sql"),
          python: count("python"),
          text: count("md"),
          modified,
        });
      } catch (err: any) {
        // a folder that fails to load still lists, so it can be opened and fixed
        out.push({ name: e.name, title: e.name, sql: 0, python: 0, text: 0, modified, problem: err.message });
      }
    }
    return out.sort((a, b) => b.modified - a.modified);
  }

  async load(nb: string): Promise<Notebook> {
    const dir = this.dir(nb);
    if (!(await readdir(dir).catch(() => null))) throw new NotFound(`no notebook \`${nb}\``);
    return loadNotebook(dir);
  }

  async create(nb: string, title?: string) {
    const dir = this.dir(nb);
    if (await readdir(dir).catch(() => null)) throw new UserError(`A notebook named \`${nb}\` already exists.`);
    await mkdir(dir, { recursive: true });
    if (title) await Bun.write(join(dir, "notebook.json"), JSON.stringify({ title }, null, 2) + "\n");
    await Bun.write(join(dir, "01_notes.md"), `# ${title || nb}\n\nWhat this notebook answers.\n`);
    await Bun.write(join(dir, "02_query.sql"), "SELECT 1 AS one;\n");
  }

  async settings(nb: string, patch: { title?: string; description?: string | null; git?: boolean | null; sandbox?: unknown; report?: unknown }) {
    if (patch.sandbox !== undefined && patch.sandbox !== null) patch.sandbox = checkSandbox(patch.sandbox);
    if (patch.report !== undefined && patch.report !== null) patch.report = checkReport(patch.report);
    const file = Bun.file(join(this.dir(nb), "notebook.json"));
    const cur = (await file.exists()) ? await file.json() : {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") delete cur[k];
      else if (v !== undefined) cur[k] = v;
    }
    await Bun.write(file, JSON.stringify(cur, null, 2) + "\n");
  }

  private async cell(nb: string, name: string): Promise<[Notebook, Cell]> {
    const book = await this.load(nb);
    const cell = book.cells.find((c) => c.name === name);
    if (!cell) throw new NotFound(`no cell \`${name}\` in \`${nb}\``);
    return [book, cell];
  }

  async save(nb: string, name: string, source: string) {
    const [book, cell] = await this.cell(nb, name);
    await Bun.write(join(book.dir, cell.file), source);
  }

  /** A new cell after `after` (or at the top), named `want` or a fresh name. */
  async add(nb: string, lang: Lang, after: string | null, source = "", want?: string): Promise<string> {
    const book = await this.load(nb);
    const taken = new Set(book.cells.map((c) => c.name));
    if (want != null && !CELL_NAME.test(want)) throw new UserError(`\`${want}\` is not a name: letters, digits and _`);
    if (want != null && taken.has(want)) throw new UserError(`a cell is already named \`${want}\``);
    const base = want ?? { sql: "query", python: "py", md: "notes" }[lang];
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
    const at = after == null ? 0 : book.cells.findIndex((c) => c.name === after) + 1;
    const file = `new_${name}.${EXT[lang]}`; // renumbered below
    await Bun.write(join(book.dir, file), source);
    const order = book.cells.map((c) => c.file);
    order.splice(at, 0, file);
    await renumber(book.dir, order);
    return name;
  }

  /** Rename a cell and the reads of it in the cells below; returns the cells rewritten. */
  async rename(nb: string, name: string, to: string): Promise<string[]> {
    if (!CELL_NAME.test(to)) throw new UserError(`\`${to}\` is not a name: letters, digits and _`);
    const [book, cell] = await this.cell(nb, name);
    if (book.cells.some((c) => c.name === to)) throw new UserError(`a cell is already named \`${to}\``);
    const file = cell.file.replace(/^(\d+)_\w+/, `$1_${to}`);
    await move(book.dir, cell.file, file);
    const after = await this.load(nb);
    const rewritten = await renameRefs(after.cells, name, to);
    for (const [cellName, source] of Object.entries(rewritten)) {
      const c = after.cells.find((c) => c.name === cellName)!;
      await Bun.write(join(after.dir, c.file), source);
    }
    await this.renameInReport(nb, name, to);
    return Object.keys(rewritten);
  }

  /** The report names cells: they follow a rename. */
  private async renameInReport(nb: string, from: string, to: string) {
    const r = (await this.readSettings(nb)).report as Report | undefined;
    if (!r) return;
    if (r.show && from in r.show) {
      r.show[to] = r.show[from];
      delete r.show[from];
    }
    if (r.half) r.half = r.half.map((c) => (c === from ? to : c));
    for (const b of r.blocks ?? []) if (b.cell === from) b.cell = to;
    for (const v of Object.values(r.variables ?? {})) if (v.source && "cell" in v.source && v.source.cell === from) v.source.cell = to;
    await this.settings(nb, { report: r });
  }

  /** Turn a cell into another language: its extension changes, nothing else. */
  async setLang(nb: string, name: string, lang: Lang) {
    const [book, cell] = await this.cell(nb, name);
    await move(book.dir, cell.file, cell.file.replace(/\.\w+$/, `.${EXT[lang]}`));
  }

  async remove(nb: string, name: string) {
    const [book, cell] = await this.cell(nb, name);
    await rm(join(book.dir, cell.file));
    await renumber(book.dir, book.cells.filter((c) => c !== cell).map((c) => c.file));
  }

  async move(nb: string, name: string, by: number) {
    const book = await this.load(nb);
    const order = book.cells.map((c) => c.file);
    const i = book.cells.findIndex((c) => c.name === name);
    if (i < 0) throw new NotFound(`no cell \`${name}\``);
    const j = Math.max(0, Math.min(order.length - 1, i + by));
    const [f] = order.splice(i, 1);
    order.splice(j, 0, f);
    await renumber(book.dir, order);
  }
}

/** How a PARAM shows in the report: a text box, a dropdown fed by a cell or a list, or (from/to) the time picker. */
export interface VarSpec {
  control: "text" | "select" | "time";
  source?: { cell: string; column?: string } | { values: string[] };
}

/** How a notebook reads as a report: its cells in order, code hidden. Kept in
 *  notebook.json (`report`), so it travels with the notebook in git. */
export interface Report {
  /** What shows, in order (shared/report.ts); absent: the default. */
  blocks?: Block[];
  /** Before blocks: shown (true) or hidden (false) against the default, and half-width cells. */
  show?: Record<string, boolean>;
  half?: string[];
  /** Grafana's relative range (`now-7d` … `now`), bound to the `from` / `to` PARAMs. */
  time?: { from: string; to: string };
  /** Re-run the report's cells this often while it is open: "30s", "1m", "5m", "15m", "1h". */
  refresh?: string;
  /** Shown as its blocks or as report.svelte (default: the template when there is one). */
  view?: "blocks" | "template";
  /** How each PARAM shows: a text box (default), a dropdown, or the time picker. */
  variables?: Record<string, VarSpec>;
}

export interface NotebookSummary {
  name: string;
  title: string;
  description?: string;
  sql: number;
  python: number;
  text: number;
  /** Last change to any file in the folder, epoch ms. */
  modified: number;
  /** Set when the folder does not load (e.g. two cells with one name). */
  problem?: string;
}

/** The first paragraph of prose: a markdown cell's first line that is not a heading. */
function describe(cells: Cell[]): string | undefined {
  for (const c of cells) {
    if (c.lang !== "md") continue;
    const line = c.source
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#") && !l.startsWith("```"));
    if (line) return line.replace(/[*_`]/g, "").slice(0, 160);
  }
}

export class UserError extends Error {}

const INTERVALS = ["30s", "1m", "5m", "15m", "1h"];

/** A report's settings, checked: cell names as names, known intervals and controls. */
function checkReport(raw: any): Report {
  if (typeof raw !== "object" || Array.isArray(raw)) throw new UserError("A report's settings are an object.");
  const out: Report = {};
  if (raw.show != null) {
    out.show = {};
    for (const [k, v] of Object.entries(raw.show)) {
      if (!CELL_NAME.test(k) || typeof v !== "boolean") throw new UserError(`report.show: \`${k}\` must be a cell name set to true or false.`);
      out.show[k] = v;
    }
  }
  if (raw.blocks != null) {
    if (!Array.isArray(raw.blocks)) throw new UserError("report.blocks is a list.");
    const ids = new Set<string>();
    out.blocks = raw.blocks.map((b: any, i: number): Block => {
      const at = `report.blocks[${i}]`;
      if (typeof b?.id !== "string" || !b.id || ids.has(b.id)) throw new UserError(`${at}: each block needs its own id.`);
      ids.add(b.id);
      if (b.cell != null && (typeof b.cell !== "string" || !CELL_NAME.test(b.cell))) throw new UserError(`${at}: cell is a cell name.`);
      if (b.cell == null && typeof b.text !== "string") throw new UserError(`${at}: a block shows a cell, or text.`);
      if (b.width != null && !WIDTHS.includes(b.width)) throw new UserError(`${at}: width is one of ${WIDTHS.join(", ")} (twelfths).`);
      if (b.parts != null && (!Array.isArray(b.parts) || b.parts.some((p: string) => !PARTS.includes(p as any))))
        throw new UserError(`${at}: parts are some of ${PARTS.join(", ")}.`);
      const str = (k: string) => (typeof b[k] === "string" && b[k] ? { [k]: b[k].slice(0, 20_000) } : {});
      return {
        id: b.id,
        ...(b.cell ? { cell: b.cell } : { text: String(b.text) }),
        ...(b.width != null && b.width !== 12 ? { width: b.width } : {}),
        ...(b.parts?.length ? { parts: [...new Set<string>(b.parts)] as Block["parts"] } : {}),
        ...str("title"),
        ...str("caption"),
      };
    });
  }
  if (raw.half != null) {
    if (!Array.isArray(raw.half) || raw.half.some((c: unknown) => typeof c !== "string" || !CELL_NAME.test(c))) throw new UserError("report.half is a list of cell names.");
    out.half = [...new Set<string>(raw.half)];
  }
  if (raw.time != null) {
    if (typeof raw.time.from !== "string" || typeof raw.time.to !== "string") throw new UserError("report.time is { from, to }, e.g. now-7d / now.");
    out.time = { from: raw.time.from, to: raw.time.to };
  }
  if (raw.view != null) {
    if (raw.view !== "blocks" && raw.view !== "template") throw new UserError("report.view is blocks or template.");
    out.view = raw.view;
  }
  if (raw.refresh != null) {
    if (!INTERVALS.includes(raw.refresh)) throw new UserError(`report.refresh is one of ${INTERVALS.join(", ")}.`);
    out.refresh = raw.refresh;
  }
  if (raw.variables != null) {
    out.variables = {};
    for (const [k, v] of Object.entries<any>(raw.variables)) {
      if (!["text", "select", "time"].includes(v?.control)) throw new UserError(`report.variables.${k}: control is text, select or time.`);
      const src = v.source;
      if (src != null && !(Array.isArray(src.values) || (typeof src.cell === "string" && CELL_NAME.test(src.cell))))
        throw new UserError(`report.variables.${k}: source is { cell, column? } or { values: [...] }.`);
      out.variables[k] = { control: v.control, ...(src ? { source: src } : {}) };
    }
  }
  return out;
}

/** A notebook's sandbox settings, checked: sizes in range, egress as host:port. */
function checkSandbox(raw: any) {
  const out: { vcpus?: number; memory?: number; egress?: string[] } = {};
  if (raw.vcpus != null) {
    const v = Number(raw.vcpus);
    if (!Number.isInteger(v) || v < 1 || v > 16) throw new UserError("vCPUs must be 1 to 16.");
    out.vcpus = v;
  }
  if (raw.memory != null) {
    const m = Number(raw.memory);
    if (!Number.isInteger(m) || m < 256 || m > 65536) throw new UserError("Memory must be 256 MB to 64 GB.");
    out.memory = m;
  }
  if (raw.egress != null) {
    if (!Array.isArray(raw.egress)) throw new UserError("Egress must be a list.");
    out.egress = raw.egress.map((e: unknown) => {
      const s = String(e).trim();
      if (!/^[A-Za-z0-9.\-]+(\/\d{1,2})?:\d{1,5}(-\d{1,5})?$/.test(s)) throw new UserError(`\`${s}\` must be host:port, e.g. db.internal:5432.`);
      return s;
    });
  }
  return out;
}
export class NotFound extends Error {}

async function move(dir: string, from: string, to: string) {
  if (from === to) return;
  await rename(join(dir, from), join(dir, to));
}

/** Rename `files` to `01_..`, `02_..` in the given order, through temp names
 *  so a swap never overwrites. */
async function renumber(dir: string, files: string[]) {
  const width = Math.max(2, String(files.length).length);
  const target = files.map((f, i) => `${String(i + 1).padStart(width, "0")}_${f.replace(/^(\d+|new)_/, "")}`);
  const tmp = files.map((f, i) => `.renumber-${i}-${f}`);
  for (let i = 0; i < files.length; i++) await move(dir, files[i], tmp[i]);
  for (let i = 0; i < files.length; i++) await move(dir, tmp[i], target[i]);
}
