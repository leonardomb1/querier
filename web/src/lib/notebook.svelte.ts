// Everything a notebook view does, in one place: the cells and their unsaved
// edits, selection and mode, what is stale, and every action a button, key or
// palette entry can take.

import { api, type Action, type ConnectionInfo, type GitStatus, type Lang, type Notebook, type Report } from "./api";
import { hash } from "../../../shared/hash";
import { nbHref } from "./href";
import { Collab } from "./collab.svelte";
import { writeClipboard } from "./copy";
import { session } from "./session.svelte";
import { NotebookConn, type Diagnostic } from "./conn.svelte";
import type { HoverInfo } from "./editor";
import { downstream, edges, freshness, plan, type Ran } from "../../../shared/graph";
import { reportBlocks, type Block } from "../../../shared/report";

export interface EditorApi {
  focus(): void;
  insert(text: string): void;
}

interface Fold {
  code?: boolean;
  output?: boolean;
}

function stored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

/** A problem in a cell: 1-based line and column (Editor.svelte's Mark). */
export interface Mark {
  line: number;
  col?: number;
  end_col?: number;
  message: string;
  severity?: "error" | "warning";
}

/** A password or token written into a cell ends up in the file and in git:
 *  point at it, and at the variable basalt would read instead. */
function credentialMarks(src: string): Mark[] {
  const out: Mark[] = [];
  const re = /\b(password|passwd|pass|token|client_secret|secret|api_key|header_value)\s*=\s*'[^']*'/gi;
  for (const m of src.matchAll(re)) {
    const at = m.index!;
    const conn = [...src.slice(0, at).matchAll(/CONNECTION\s+([A-Za-z_]\w*)/gi)].at(-1)?.[1];
    const key = m[1].toLowerCase();
    const env = conn ? `${conn.toUpperCase()}_${key.startsWith("pass") ? "PASS" : key.toUpperCase()}` : key.toUpperCase();
    const hint =
      key.startsWith("pass") && conn
        ? `Put it in a connection giving ${env} and drop this option: connection ${conn} reads it by itself.`
        : `Put it in a connection giving ${env} and write ${m[1]} = env('${env}').`;
    const line = src.slice(0, at).split("\n").length;
    const col = at - src.lastIndexOf("\n", at - 1);
    out.push({ line, col, end_col: col + m[0].length, severity: "warning", message: `A credential in a cell ends up in its file and in git. ${hint}` });
  }
  return out;
}

export const newBlockId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export class NotebookCtl {
  book = $state<Notebook | null>(null);
  error = $state("");
  /** A short confirmation, cleared after a few seconds, maybe with a link. */
  notice = $state("");
  noticeLink = $state<{ href: string; label: string } | null>(null);
  private noticeTimer?: ReturnType<typeof setTimeout>;
  sources = $state<Record<string, string>>({});
  selected = $state<string | null>(null);
  mode = $state<"command" | "edit">("command");
  /** A cell that should take focus once it mounts (just added). */
  focusOnMount = $state<string | null>(null);
  params = $state<Record<string, string>>({});
  folds = $state<Record<string, Fold>>({});
  palette = $state(false);
  help = $state(false);
  /** The Share dialog: who else has this notebook. */
  sharing = $state(false);
  /** The connections this notebook's kernel gets, for the signed-in person (what they may use here). */
  connections = $state<ConnectionInfo[]>([]);
  /** A connection whose credentials are being entered (from the notebook's prompt). */
  enteringCredentials = $state<ConnectionInfo | null>(null);
  /** The sandbox panel (the status bar's): usage, kernel, size and network. */
  sandboxPanel = $state(false);
  /** A request to open the Settings editor: which scope, and which of its groups. */
  settings = $state<{ scope: "user" | "workspace" | "notebook"; section?: string } | null>(null);
  openSettings(section?: string, scope: "user" | "workspace" | "notebook" = "notebook") {
    this.settings = { scope, section };
  }
  /** Git for this notebook: null until first asked. */
  git = $state<GitStatus | null>(null);
  gitBusy = $state<string | null>(null);
  /** Offer to start tracking (once per visit, unless declined for good). */
  gitPrompt = $state(false);
  /** Cells whose editor shows the inline diff against the last commit. */
  diffs = $state<Record<string, boolean>>({});
  private gitTimer?: ReturnType<typeof setTimeout>;

  readonly conn: NotebookConn;
  /** editing together: the cells' shared text and who is where (not in a published report) */
  readonly collab: Collab | null = null;
  readonly editors: Record<string, EditorApi> = {};
  /** The editor text from the sidebar goes into. */
  lastEditor: string | null = null;

  private dirty = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private saving = new Map<string, Promise<unknown>>();

  constructor(
    readonly name: string,
    initial?: Notebook,
    /** the published report, as its viewers see it: its frozen cells, run in their report kernel */
    readonly reportMode = false,
    /** a public link's page: no socket and no kernel, its last run given (conn.feed) */
    readonly offline = false,
  ) {
    this.conn = new NotebookConn(name, () => this.refresh(), reportMode, offline);
    this.conn.onnotice = (m) => this.say(m);
    this.params = stored(`querier:params:${name}`, {});
    this.folds = stored(`querier:folds:${name}`, {});
    if (initial) this.take(initial);
    else this.refresh();
    if (reportMode) return;
    this.collab = new Collab(name, (cell, text) => {
      if (this.sources[cell] === text) return;
      this.sources[cell] = text;
      this.checkSoon(cell);
      this.refreshGitSoon(1500);
    });
    this.refreshConnections();
    this.refreshGit().then(() => {
      if (this.git && !this.git.tracked && !this.git.declined && this.mayEdit) this.gitPrompt = true;
    });
  }

  // -- derived

  order = $derived(this.book?.cells.map((c) => c.name) ?? []);
  code = $derived(new Set(this.book?.cells.filter((c) => c.lang !== "md").map((c) => c.name) ?? []));
  up = $derived.by(() => edges(this.order, this.conn.deps));
  // (a published report's bound PARAMs: what the server sets them to for this viewer)
  bound = $derived({ ...Object.fromEntries(Object.entries(this.params).filter(([, v]) => v !== "")), ...(this.book?.boundValues ?? {}) });
  fresh = $derived.by(() =>
    freshness(
      this.order,
      this.up,
      this.conn.deps,
      Object.fromEntries(this.order.map((n) => [n, this.conn.runs[n]?.ran])) as Record<string, Ran | undefined>,
      this.sources,
      this.bound,
      this.code,
      // a published report seen without its code: its cells' hashes
      Object.fromEntries((this.book?.cells ?? []).filter((c) => c.hash && !c.source).map((c) => [c.name, c.hash!])),
    ),
  );
  // what the signed-in person may do here: the rest isn't offered (and the server refuses it)
  // (a published report's viewer runs its frozen cells: viewing it is enough; they change nothing)
  mayRun = $derived.by(() => !!this.book?.permissions?.includes(this.reportMode ? "report.view" : "notebook.run"));
  mayEdit = $derived.by(() => !this.reportMode && !!this.book?.permissions?.includes("notebook.edit"));
  may = (action: Action) => !!this.book?.permissions?.includes(action);
  busy = $derived.by(() => Object.values(this.conn.runs).some((r) => r.state === "running" || r.state === "queued"));
  staleCount = $derived(this.order.filter((n) => this.fresh[n] === "stale").length);

  cell(name: string) {
    return this.book?.cells.find((c) => c.name === name);
  }

  /** The cell that defines table/variable `name` last, if any. */
  definer(name: string): string | undefined {
    return this.order.findLast((n) => this.conn.deps[n]?.defines.includes(name));
  }

  // -- the report: the notebook read top to bottom, code hidden

  report = $derived<Report>(this.book?.report ?? {});

  /** The report's blocks: its saved layout, else the default. */
  blocks = $derived(reportBlocks(this.report, this.book?.cells ?? [], this.up));

  /** Some block of the report shows this cell. */
  inReport(cell: string): boolean {
    return this.blocks.some((b) => b.cell === cell);
  }

  /** Change the layout: from here on it is saved as blocks. */
  setBlocks(change: (blocks: Block[]) => Block[]) {
    const next = change(structuredClone($state.snapshot(this.blocks)) as Block[]);
    return this.setReport((r) => {
      r.blocks = next;
      delete r.show;
      delete r.half;
    });
  }

  /** Change the report's settings: applied here at once, saved behind. */
  async setReport(change: (r: Report) => void) {
    if (!this.book || !this.mayEdit) return;
    const next = structuredClone($state.snapshot(this.report)) as Report;
    change(next);
    this.book.report = next;
    await api.settings(this.name, { report: next }).catch((e) => (this.error = e.message));
  }

  toggleInReport(cell: string) {
    const on = !this.inReport(cell);
    return this.setBlocks((bs) => {
      if (!on) return bs.filter((b) => b.cell !== cell);
      // where it sits in the notebook: after the last block of a cell above it
      const at = this.order.indexOf(cell);
      const after = bs.findLastIndex((b) => b.cell != null && this.order.indexOf(b.cell) < at);
      bs.splice(after + 1, 0, { id: newBlockId(), cell });
      return bs;
    }).then(() =>
      this.say(on ? `${cell} shows in the report.` : `${cell} is hidden from the report.`, {
        href: nbHref(this.name, true),
        label: "Open report",
      }),
    );
  }

  /** Each connection's type, read from its CREATE CONNECTION (the session only knows names). */
  connectionTypes = $derived.by(() => {
    const out = new Map<string, string>();
    for (const c of this.book?.cells ?? []) {
      if (c.lang !== "sql") continue;
      const src = this.sources[c.name] ?? c.source;
      for (const m of src.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?CONNECTION\s+(\w+)\s+TYPE\s+(\w+)/gi)) out.set(m[1], m[2].toLowerCase());
    }
    return out;
  });

  /** Destinations the cells name, as host:port: what the sandbox settings suggest allowing. */
  sandboxRefs = $derived.by(() => {
    const PORTS: Record<string, number> = { sqlserver: 1433, postgres: 5432, mysql: 3306, starrocks: 9030, doris: 9030, sftp: 22 };
    const out = new Map<string, string>();
    for (const c of this.book?.cells ?? []) {
      const src = this.sources[c.name] ?? c.source;
      for (const m of src.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?CONNECTION\s+(\w+)\s+TYPE\s+(\w+)\s+OPTIONS\s*\(([^;]*?)\)/gis)) {
        const [, name, type, opts] = m;
        const opt = (k: string) => new RegExp(`\\b${k}\\s*=\\s*'([^']*)'`, "i").exec(opts)?.[1] ?? new RegExp(`\\b${k}\\s*=\\s*(\\d+)`, "i").exec(opts)?.[1];
        const host = opt("host") ?? opt("fe_host");
        const port = opt("port") ?? opt("fe_port") ?? PORTS[type.toLowerCase()];
        if (host && port) out.set(`${host.split("\\")[0]}:${port}`, `connection ${name}`);
        for (const url of [opt("be_url"), opt("base_url")]) {
          const u = url && /^(https?):\/\/([^/:]+)(?::(\d+))?/.exec(url);
          if (u) out.set(`${u[2]}:${u[3] ?? (u[1] === "https" ? 443 : 80)}`, `connection ${name}`);
        }
      }
      for (const m of src.matchAll(/'(https?):\/\/([^/:']+)(?::(\d+))?[^']*'/g)) out.set(`${m[2]}:${m[3] ?? (m[1] === "https" ? 443 : 80)}`, `a URL in ${c.name}`);
      // sftp://user@host[:port]/path (without a user, sftp://name/… is a connection's)
      for (const m of src.matchAll(/'sftp:\/\/[^@/']+@([^/:']+)(?::(\d+))?[^']*'/g)) out.set(`${m[1]}:${m[2] ?? 22}`, `a URL in ${c.name}`);
    }
    return out;
  });

  /** Environment variables the cells ask for: a connection `sr` reads SR_USER
   *  and SR_PASS (basalt's convention), `env('X')` in OPTIONS, os.environ in Python. */
  secretRefs = $derived.by(() => {
    const refs = new Map<string, string>();
    for (const c of this.book?.cells ?? []) {
      const src = this.sources[c.name] ?? c.source;
      if (c.lang === "sql") {
        for (const m of src.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?CONNECTION\s+([A-Za-z_]\w*)/gi)) {
          const n = m[1].toUpperCase();
          refs.set(`${n}_USER`, `connection ${m[1]} in ${c.name}`);
          refs.set(`${n}_PASS`, `connection ${m[1]} in ${c.name}`);
        }
        for (const m of src.matchAll(/\benv\(\s*'([A-Za-z_]\w*)'\s*\)/g)) refs.set(m[1], `env('${m[1]}') in ${c.name}`);
      } else if (c.lang === "python") {
        for (const m of src.matchAll(/os\.(?:environ(?:\.get)?|getenv)\s*[\[(]\s*["']([A-Za-z_]\w*)["']/g)) refs.set(m[1], `os.environ in ${c.name}`);
      }
    }
    return refs;
  });

  async refreshConnections() {
    try {
      this.connections = (await api.connections.forNotebook(this.name)).connections;
    } catch {
      this.connections = [];
    }
  }

  /** Per-person connections the cells read that the signed-in person hasn't set their own credentials for. */
  needsCredentials = $derived(
    this.connections.filter((c) => c.credentials === "per-user" && c.permissions.includes("connection.use") && c.variables.some((v) => this.secretRefs.has(v) && !c.mine.includes(v))),
  );

  /** Variables the cells read that no connection they may use gives. */
  unprovided = $derived([...this.secretRefs].filter(([v]) => !this.connections.some((c) => c.permissions.includes("connection.use") && c.variables.includes(v))));

  /** What hovering `word` in a cell shows: a table, a param, a declaration. */
  hoverInfo(word: string): HoverInfo | null {
    const table = this.conn.tables.find((t) => t.name === word);
    if (table) {
      const from = this.definer(word);
      const shown = table.columns.slice(0, 12);
      return {
        title: `${word}  ${table.rows.toLocaleString()} rows × ${table.columns.length}`,
        sub: from && from !== word ? `DataFrame, defined in ${from}` : "a DataFrame in this notebook",
        rows: shown.map((c) => [c.name, c.type.split("(")[0].toLowerCase()]),
        more: table.columns.length - shown.length,
      };
    }
    if (word.startsWith("$")) {
      const name = word.slice(1);
      const decl = this.book?.params.find((p) => p.name === name);
      const value = this.bound[name];
      if (decl) {
        return {
          title: `${word}: ${decl.type}`,
          sub: value != null ? `bound to ${value}` : decl.default != null ? `default ${decl.default}` : "required, no value set",
        };
      }
      const d = this.conn.declared.find((d) => d.name === name);
      if (d) return { title: word, sub: `a ${d.kind} declared in this session` };
      return null;
    }
    const d = this.conn.declared.find((d) => d.name === word && (d.kind === "connection" || d.kind === "function"));
    if (d) {
      const type = this.connectionTypes.get(word);
      return { title: word, sub: d.kind === "connection" ? `a basalt connection${type ? ` (${type})` : ""}` : "a function declared in this notebook" };
    }
    return null;
  }

  dependents(name: string) {
    return downstream(name, this.order, this.up);
  }

  // -- files

  async refresh() {
    try {
      this.take(await (this.reportMode ? api.report.get(this.name) : api.load(this.name)));
      this.error = "";
    } catch (e: any) {
      this.error = e.message;
    }
    if (!this.reportMode) this.refreshGitSoon();
  }

  // -- git

  async refreshGit() {
    try {
      this.git = await api.git.status(this.name);
    } catch {}
  }

  refreshGitSoon(ms = 500) {
    clearTimeout(this.gitTimer);
    this.gitTimer = setTimeout(() => this.refreshGit(), ms);
  }

  /** Run a git action: saves first, reports failure, reloads files it may have rewritten. */
  async gitDo(label: string, fn: () => Promise<unknown>, { reload = false } = {}): Promise<boolean> {
    this.gitBusy = label;
    try {
      await this.flush();
      await fn();
      if (reload) await this.refresh();
      await this.refreshGit();
      return true;
    } catch (e: any) {
      this.error = e.message;
      await this.refreshGit();
      return false;
    } finally {
      this.gitBusy = null;
    }
  }

  /** How a cell differs from the last commit, if it does. */
  changeOf(cell: string) {
    return this.git?.cells.find((c) => c.name === cell)?.change;
  }

  private take(next: Notebook) {
    // edited together, the shared text is ahead of the files
    for (const c of next.cells) if (!this.dirty.has(c.name)) this.sources[c.name] = this.collab?.text(c.name)?.toString() ?? c.source;
    this.book = next;
    if (this.selected && !next.cells.some((c) => c.name === this.selected)) this.selected = null;
  }

  // -- problems: what a cell's editor underlines, and the Problems panel lists

  /** The live check (for the source now in the editor), the last run's errors while
   *  they describe this code, and credentials written into a SQL cell. */
  marksFor(name: string): Mark[] {
    const c = this.cell(name);
    if (!c) return [];
    const source = this.sources[name] ?? c.source;
    const run = this.conn.runs[name];
    const checked = this.checks[name]?.source === source ? this.checks[name].diagnostics : null;
    const live: Mark[] = (checked ?? []).map((d) => ({
      line: d.line,
      col: d.col,
      end_col: !d.end_line || d.end_line === d.line ? d.end_col : undefined,
      message: d.msg,
      severity: d.level === "warning" ? "warning" : "error",
    }));
    // after an edit, the live check speaks for the code; a run's errors, for what ran
    const current = !checked || run?.ran?.hash === hash(source);
    const ran: Mark[] = current
      ? (run?.outputs ?? []).flatMap((o) =>
          o.type === "error" && o.line && !live.some((m) => m.line === o.line && m.col === o.col)
            ? [{ line: o.line, col: o.col, end_col: o.end_col, message: o.message, severity: "error" as const }]
            : [],
        )
      : [];
    return [...live, ...ran, ...(c.lang === "sql" ? credentialMarks(source) : [])];
  }

  /** Every cell's problems, in notebook order. */
  problems = $derived.by(() => this.order.flatMap((cell) => this.marksFor(cell).map((m) => ({ cell, ...m }))));

  // -- live checks: basalt's check of each SQL cell as it is typed

  /** The last check of each SQL cell, with the source it checked. */
  checks = $state<Record<string, { source: string; diagnostics: Diagnostic[] }>>({});
  private checkTimers = new Map<string, ReturnType<typeof setTimeout>>();

  checkSoon(cell: string, ms = 400) {
    if (this.cell(cell)?.lang !== "sql") return;
    clearTimeout(this.checkTimers.get(cell));
    this.checkTimers.set(
      cell,
      setTimeout(async () => {
        const source = this.sources[cell] ?? this.cell(cell)?.source ?? "";
        const diagnostics = await this.conn.check(source, cell).catch(() => null);
        // a later keystroke has its own check coming
        if (diagnostics && (this.sources[cell] ?? source) === source) this.checks[cell] = { source, diagnostics };
      }, ms),
    );
  }

  /** Every SQL cell again: what the notebook defines, or knows of it, changed. */
  checkAll(ms = 600) {
    for (const c of this.book?.cells ?? []) if (c.lang === "sql") this.checkSoon(c.name, ms);
  }

  edit(cell: string, source: string) {
    if (!this.mayEdit) return;
    this.checkSoon(cell);
    this.sources[cell] = source;
    this.dirty.add(cell);
    clearTimeout(this.timers.get(cell));
    this.timers.set(cell, setTimeout(() => this.save(cell), 400));
  }

  save(cell: string): Promise<unknown> {
    clearTimeout(this.timers.get(cell));
    this.timers.delete(cell);
    if (!this.dirty.has(cell)) return this.saving.get(cell) ?? Promise.resolve();
    this.dirty.delete(cell);
    const p = api
      .save(this.name, cell, this.sources[cell])
      .then(() => this.refreshGitSoon())
      .catch((e) => {
        this.dirty.add(cell);
        this.error = `saving ${cell}: ${e.message}`;
      });
    this.saving.set(cell, p);
    return p;
  }

  /** Everything typed is in the files: before a run, git or a change of cells reads them. */
  flush() {
    return Promise.all([...[...new Set([...this.dirty, ...this.saving.keys()])].map((c) => this.save(c)), this.collab?.flush()]);
  }

  /** The cell's shared text, when edited together: its editors bind to it. */
  shared(cell: string) {
    const text = this.collab?.text(cell);
    return text && this.collab ? { text, collab: this.collab, cell } : undefined;
  }

  /** Edited together but the room hasn't sent the text yet: the editor waits (a moment). */
  waitingFor(cell: string) {
    return !!this.collab && !this.collab.text(cell);
  }

  /** Who else is here: other people (one's own other tabs aren't someone else). */
  others = $derived((this.collab?.peers ?? []).filter((p) => p.user.id !== session.me?.id));

  /** Who else is in each cell. */
  peersIn(cell: string) {
    return this.others.filter((p) => p.cell === cell);
  }

  private async structural(fn: () => Promise<unknown>) {
    if (!this.mayEdit) return void this.say("You may view this notebook, not change it.");
    try {
      await this.flush();
      await fn();
      await this.refresh();
    } catch (e: any) {
      this.error = e.message;
    }
  }

  // -- running

  /** Run cells, preceded by whatever they depend on that is not fresh. */
  async run(cells: string[], { withDeps = true } = {}) {
    if (!this.mayRun) return void this.say("You may view this notebook, not run it.");
    await this.flush();
    const code = cells.filter((c) => this.code.has(c));
    const list = withDeps ? plan(code, this.order, this.up, this.fresh) : code;
    if (list.length) this.conn.runCells(list, this.bound);
  }

  runAll() {
    return this.run([...this.code], { withDeps: false });
  }

  runStale() {
    return this.run(this.order.filter((n) => this.fresh[n] !== "fresh"));
  }

  runAbove(cell: string) {
    return this.run(this.order.slice(0, this.order.indexOf(cell)), { withDeps: false });
  }

  runBelow(cell: string) {
    return this.run(this.order.slice(this.order.indexOf(cell)));
  }

  /** shift+enter: run, then move to the next cell (making one at the end). */
  async runAndAdvance(cell: string) {
    if (!this.mayRun) return void this.say("You may view this notebook, not run it.");
    await this.run([cell]);
    const i = this.order.indexOf(cell);
    const next = this.order[i + 1];
    if (next) this.select(next, this.mode === "edit" ? "edit" : "command");
    else if (this.mode === "edit") await this.add(this.cell(cell)?.lang === "md" ? "sql" : this.cell(cell)!.lang, cell);
  }

  interrupt() {
    if (this.mayRun) this.conn.interrupt();
  }

  restart() {
    if (this.mayRun) this.conn.restart();
  }

  // -- selection

  select(name: string | null, mode: "command" | "edit" = "command") {
    this.selected = name;
    this.mode = mode;
    if (!name) return;
    document.getElementById(`cell-${name}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (mode === "edit") this.editors[name]?.focus();
  }

  step(by: number) {
    if (!this.order.length) return;
    const i = this.selected ? this.order.indexOf(this.selected) : -1;
    this.select(this.order[Math.max(0, Math.min(this.order.length - 1, i + by))]);
  }

  insert(text: string) {
    const target = this.lastEditor && this.editors[this.lastEditor];
    if (target) target.insert(text);
    else void writeClipboard(text).catch(() => {});
  }

  // -- structure

  add(lang: Lang, after: string | null) {
    return this.structural(async () => {
      const { name } = await api.addCell(this.name, lang, after);
      this.focusOnMount = name;
      this.selected = name;
      this.mode = "edit";
    });
  }

  addAbove(cell: string, lang: Lang) {
    const i = this.order.indexOf(cell);
    return this.add(lang, i > 0 ? this.order[i - 1] : null);
  }

  remove(cell: string) {
    const i = this.order.indexOf(cell);
    const next = this.order[i + 1] ?? this.order[i - 1] ?? null;
    return this.structural(async () => {
      await api.remove(this.name, cell);
      this.selected = next;
    });
  }

  move(cell: string, by: number) {
    return this.structural(() => api.move(this.name, cell, by));
  }

  setLang(cell: string, lang: Lang) {
    if (this.cell(cell)?.lang === lang) return;
    return this.structural(() => api.setLang(this.name, cell, lang));
  }

  say(text: string, link: { href: string; label: string } | null = null) {
    this.notice = text;
    this.noticeLink = link;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => (this.notice = ""), 5000);
  }

  async rename(cell: string, to: string) {
    if (!this.mayEdit) return;
    await this.flush();
    const { updated } = await api.rename(this.name, cell, to);
    this.say(
      updated.length
        ? `Renamed ${cell} to ${to} and updated ${updated.join(", ")}.`
        : `Renamed ${cell} to ${to}. No other cell read it.`,
    );
    this.sources[to] = this.sources[cell];
    if (this.selected === cell) this.selected = to;
    if (this.folds[cell]) {
      this.folds[to] = this.folds[cell];
      delete this.folds[cell];
    }
    await this.refresh();
  }

  setTitle(title: string) {
    if (this.book && title && title !== this.book.title) return this.structural(() => api.settings(this.name, { title }));
  }

  // -- view state (this browser only)

  fold(cell: string, part: keyof Fold) {
    const f = { ...this.folds[cell] };
    f[part] = !f[part];
    this.folds[cell] = f;
    store(`querier:folds:${this.name}`, this.folds);
  }

  setParam(name: string, value: string) {
    this.params[name] = value;
    store(`querier:params:${this.name}`, this.params);
  }

  close() {
    this.flush();
    this.collab?.close();
    this.conn.close();
  }
}
