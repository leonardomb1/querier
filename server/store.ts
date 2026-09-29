// Edits to notebook folders. Order lives in the filenames, so every structural
// change renumbers the folder: `01_a.sql 02_b.py ...` always matches what the
// UI shows.
//
// Notebooks live in workspaces: <root>/<workspace>/<notebook>/, and a notebook's
// id is "workspace/notebook". A workspace is a folder with a workspace.json
// (title, description, attributes, sandbox defaults): the unit settings are
// shared by, and that access rules will attach to.

import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renameRefs } from "./analyze";
import { loadNotebook, type Cell, type Lang, type Notebook } from "./notebook";
import { PARTS, WIDTHS, type Block } from "../shared/report";

const NOTEBOOK = /^[A-Za-z0-9][\w-]*$/;
/** Where notebooks that predate workspaces go. */
export const DEFAULT_WORKSPACE = "default";
export const CELL_NAME = /^[A-Za-z_]\w*$/;
const EXT: Record<Lang, string> = { sql: "sql", python: "py", md: "md" };

export class Store {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** A notebook's folder, from its id "workspace/notebook". */
  dir(id: string): string {
    const [ws, nb, extra] = String(id).split("/");
    if (extra != null || !NOTEBOOK.test(ws ?? "") || !NOTEBOOK.test(nb ?? "")) throw new UserError(`bad notebook id \`${id}\` (workspace/notebook)`);
    return join(this.root, ws, nb);
  }

  wsDir(ws: string): string {
    if (!NOTEBOOK.test(ws)) throw new UserError(`bad workspace name \`${ws}\``);
    return join(this.root, ws);
  }

  /** Notebooks from before workspaces (folders right under the root) move into
   *  "default". Returns their old names, for their secrets and settings to follow. */
  async migrate(): Promise<string[]> {
    await mkdir(this.root, { recursive: true });
    const moved: string[] = [];
    // a notebook called "default" moves first, or the others would land inside it
    const entries = (await readdir(this.root, { withFileTypes: true })).sort((a, b) => +(b.name === DEFAULT_WORKSPACE) - +(a.name === DEFAULT_WORKSPACE));
    for (const e of entries) {
      if (!e.isDirectory() || !NOTEBOOK.test(e.name)) continue;
      const files = await readdir(join(this.root, e.name)).catch(() => [] as string[]);
      const isNotebook = files.includes("notebook.json") || files.some((f) => CELL_FILE.test(f));
      if (!isNotebook || files.includes("workspace.json")) continue;
      let to = e.name;
      if (e.name === DEFAULT_WORKSPACE) to = `${e.name}-notebook`; // a notebook called "default"
      await rename(join(this.root, e.name), join(this.root, `.migrating-${e.name}`));
      await mkdir(join(this.root, DEFAULT_WORKSPACE), { recursive: true });
      await rename(join(this.root, `.migrating-${e.name}`), join(this.root, DEFAULT_WORKSPACE, to));
      moved.push(e.name);
    }
    if (!(await readdir(this.root)).some((f) => !f.startsWith("."))) await this.createWorkspace(DEFAULT_WORKSPACE, "Default");
    else if (moved.length && !(await Bun.file(join(this.root, DEFAULT_WORKSPACE, "workspace.json")).exists()))
      await Bun.write(join(this.root, DEFAULT_WORKSPACE, "workspace.json"), JSON.stringify({ title: "Default" }, null, 2) + "\n");
    return moved;
  }

  // -- workspaces

  async readWorkspace(ws: string): Promise<WorkspaceSettings> {
    const f = Bun.file(join(this.wsDir(ws), "workspace.json"));
    return (await f.exists()) ? f.json() : {};
  }

  async workspaces(): Promise<WorkspaceSummary[]> {
    await mkdir(this.root, { recursive: true });
    const out: WorkspaceSummary[] = [];
    for (const e of await readdir(this.root, { withFileTypes: true })) {
      if (!e.isDirectory() || !NOTEBOOK.test(e.name)) continue;
      const settings = await this.readWorkspace(e.name).catch(() => ({}) as WorkspaceSettings);
      const notebooks = await this.list(e.name);
      out.push({
        name: e.name,
        title: settings.title ?? e.name,
        description: settings.description,
        attributes: settings.attributes ?? {},
        sandbox: settings.sandbox,
        notebooks,
        modified: Math.max(0, ...notebooks.map((n) => n.modified)),
      });
    }
    return out.sort((a, b) => (a.name === DEFAULT_WORKSPACE ? -1 : b.name === DEFAULT_WORKSPACE ? 1 : a.title.localeCompare(b.title)));
  }

  async createWorkspace(ws: string, title?: string) {
    const dir = this.wsDir(ws);
    if (await readdir(dir).catch(() => null)) throw new UserError(`A workspace named \`${ws}\` already exists.`);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "workspace.json"), JSON.stringify({ title: title || ws }, null, 2) + "\n");
  }

  async workspaceSettings(ws: string, patch: { title?: string; description?: string | null; attributes?: unknown; sandbox?: unknown }) {
    const out: Record<string, unknown> = {};
    if (patch.title !== undefined) out.title = String(patch.title).trim() || ws;
    if (patch.description !== undefined) out.description = patch.description;
    if (patch.attributes !== undefined) out.attributes = patch.attributes === null ? null : checkAttributes(patch.attributes);
    if (patch.sandbox !== undefined) out.sandbox = patch.sandbox === null ? null : checkSandbox(patch.sandbox);
    const file = Bun.file(join(this.wsDir(ws), "workspace.json"));
    if (!(await readdir(this.wsDir(ws)).catch(() => null))) throw new NotFound(`no workspace \`${ws}\``);
    const cur = (await file.exists()) ? await file.json() : {};
    for (const [k, v] of Object.entries(out)) {
      if (v === null || v === "") delete cur[k];
      else cur[k] = v;
    }
    await Bun.write(file, JSON.stringify(cur, null, 2) + "\n");
  }

  /** `check`: only whether it would work, so callers can refuse before closing anything. */
  async renameWorkspace(ws: string, to: string, check = false) {
    const from = this.wsDir(ws);
    const dest = this.wsDir(to);
    if (!(await readdir(from).catch(() => null))) throw new NotFound(`no workspace \`${ws}\``);
    if (to === ws) return;
    if (await readdir(dest).catch(() => null)) throw new UserError(`A workspace named \`${to}\` already exists.`);
    if (!check) await rename(from, dest);
  }

  /** Delete a workspace: only an empty one, unless `force` (then its notebooks go too). */
  async removeWorkspace(ws: string, force = false) {
    const dir = this.wsDir(ws);
    if (!(await readdir(dir).catch(() => null))) throw new NotFound(`no workspace \`${ws}\``);
    const nbs = await this.list(ws);
    if (nbs.length && !force) throw new UserError(`\`${ws}\` still holds ${nbs.length} notebook${nbs.length === 1 ? "" : "s"}: move or delete them first.`);
    await rm(dir, { recursive: true, force: true });
  }

  /** A notebook's sandbox: its workspace's defaults, then its own (sizes replace, egress adds up). */
  async sandboxOf(id: string): Promise<{ vcpus?: number; memory?: number; egress?: string[] } | undefined> {
    const own = ((await this.readSettings(id)).sandbox ?? {}) as { vcpus?: number; memory?: number; egress?: string[] };
    const ws = (await this.readWorkspace(id.split("/")[0])).sandbox ?? {};
    const egress = [...new Set([...(ws.egress ?? []), ...(own.egress ?? [])])];
    const out = { vcpus: own.vcpus ?? ws.vcpus, memory: own.memory ?? ws.memory, ...(egress.length ? { egress } : {}) };
    return out.vcpus == null && out.memory == null && !egress.length ? undefined : out;
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

  /** A workspace's notebooks (every workspace's, without one), most recently edited first. */
  async list(ws?: string): Promise<NotebookSummary[]> {
    await mkdir(this.root, { recursive: true });
    if (ws == null) return (await Promise.all((await this.workspaceNames()).map((w) => this.list(w)))).flat().sort((a, b) => b.modified - a.modified);
    const out: NotebookSummary[] = [];
    for (const e of await readdir(this.wsDir(ws), { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || !NOTEBOOK.test(e.name)) continue;
      const dir = join(this.wsDir(ws), e.name);
      const files = (await readdir(dir)).filter((f) => !f.startsWith(".")); // not .git, .gitignore
      const modified = Math.max(0, ...(await Promise.all(files.map((f) => stat(join(dir, f)).then((s) => s.mtimeMs, () => 0)))));
      try {
        const nb = await loadNotebook(dir);
        const count = (lang: Lang) => nb.cells.filter((c) => c.lang === lang).length;
        out.push({
          id: `${ws}/${e.name}`,
          workspace: ws,
          name: e.name,
          title: nb.title,
          description: nb.description ?? describe(nb.cells),
          sql: count("sql"),
          python: count("python"),
          text: count("md"),
          modified,
        });
      } catch (err: any) {
        // a folder that fails to load still lists, so it can be opened and fixed
        out.push({ id: `${ws}/${e.name}`, workspace: ws, name: e.name, title: e.name, sql: 0, python: 0, text: 0, modified, problem: err.message });
      }
    }
    return out.sort((a, b) => b.modified - a.modified);
  }

  private async workspaceNames(): Promise<string[]> {
    return (await readdir(this.root, { withFileTypes: true })).filter((e) => e.isDirectory() && NOTEBOOK.test(e.name)).map((e) => e.name);
  }

  async load(id: string): Promise<Notebook> {
    const dir = this.dir(id);
    if (!(await readdir(dir).catch(() => null))) throw new NotFound(`no notebook \`${id}\``);
    const nb = await loadNotebook(dir);
    return { ...nb, name: id, workspace: id.split("/")[0] };
  }

  async create(nb: string, title?: string) {
    const dir = this.dir(nb);
    if (!(await readdir(join(dir, "..")).catch(() => null))) throw new NotFound(`no workspace \`${nb.split("/")[0]}\``);
    if (await readdir(dir).catch(() => null)) throw new UserError(`A notebook named \`${nb}\` already exists.`);
    await mkdir(dir, { recursive: true });
    if (title) await Bun.write(join(dir, "notebook.json"), JSON.stringify({ title }, null, 2) + "\n");
    await Bun.write(join(dir, "01_notes.md"), `# ${title || nb}\n\nWhat this notebook answers.\n`);
    await Bun.write(join(dir, "02_query.sql"), "SELECT 1 AS one;\n");
  }

  /** Delete a notebook: its folder, and everything in it. */
  async removeNotebook(nb: string) {
    const dir = this.dir(nb);
    if (!(await readdir(dir).catch(() => null))) throw new NotFound(`no notebook \`${nb}\``);
    await rm(dir, { recursive: true, force: true });
  }

  /** Give a notebook's folder a new id: a new name, or another workspace; the title stays. */
  async renameNotebook(nb: string, to: string, check = false) {
    const from = this.dir(nb);
    const dest = this.dir(to);
    if (!(await readdir(from).catch(() => null))) throw new NotFound(`no notebook \`${nb}\``);
    if (to === nb) return;
    if (await readdir(dest).catch(() => null)) throw new UserError(`A notebook named \`${to}\` already exists.`);
    if (!(await readdir(join(dest, "..")).catch(() => null))) throw new NotFound(`no workspace \`${to.split("/")[0]}\``);
    if (!check) await rename(from, dest);
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

/** workspace.json */
export interface WorkspaceSettings {
  title?: string;
  description?: string;
  /** free tags (owner, team, sensitivity…): shown now, for access policies later */
  attributes?: Record<string, string>;
  /** defaults for its notebooks' sandboxes */
  sandbox?: { vcpus?: number; memory?: number; egress?: string[] };
}

export interface WorkspaceSummary {
  name: string;
  title: string;
  description?: string;
  attributes: Record<string, string>;
  sandbox?: WorkspaceSettings["sandbox"];
  notebooks: NotebookSummary[];
  modified: number;
}

export interface NotebookSummary {
  /** "workspace/notebook" */
  id: string;
  workspace: string;
  /** the folder's name */
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

const CELL_FILE = /^\d+_[A-Za-z_]\w*\.(sql|py|md)$/;

/** Attributes, checked: short keys, text values. */
export function checkAttributes(raw: any): Record<string, string> {
  if (typeof raw !== "object" || Array.isArray(raw)) throw new UserError("Attributes are key: value pairs.");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!/^[A-Za-z][\w.-]{0,39}$/.test(k)) throw new UserError(`\`${k}\` can't be an attribute name: a letter, then letters, digits, _ . -`);
    if (typeof v !== "string" || v.length > 200) throw new UserError(`Attribute \`${k}\`: a text of up to 200 characters.`);
    out[k] = v;
  }
  return out;
}

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
