// One Host per notebook and person (their own kernel, as in Microsoft Fabric):
// its session, a run queue, the last output of every cell, and what each cell
// last ran with — broadcast to each of that person's tabs on it. A tab that
// connects late gets all of it replayed.

import type { ServerWebSocket } from "bun";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { hash } from "../shared/hash";
import { edges, freshness, plan } from "../shared/graph";
import { analyze, type Deps } from "./analyze";
import { encodeFrame } from "./runner/protocol";
import { checkCli } from "./check";
import type { CellEvent, CodeLang, Diagnostic, ExportFormat, Inspection, Namespace, Runner, Sandbox, Session } from "./runner/types";
import { Monitor, parseExposition, type Scope } from "./metrics";
import { redactor } from "./connections";
import { cpus, totalmem } from "node:os";
import type { Store } from "./store";
import type { Kernels } from "./kernels";
import type { Principal } from "./auth/principal";

/** Where a kernel's environment comes from: the connections its owner may use (app.ts). */
export interface EnvSource {
  env(nb: string, owner?: Principal): Promise<Record<string, string>>;
}

export type CellState = "idle" | "queued" | "running" | "ok" | "error";

/** What a cell last ran with, so the browser can tell when it went stale. */
export interface Ran {
  hash: string;
  seq: number;
  params: Record<string, string>;
  ok: boolean;
}

export interface CellOutput {
  state: CellState;
  ms?: number;
  ran?: Ran;
  events: { meta: any; data?: Uint8Array }[];
}

interface Job {
  cell: string;
  params: Record<string, string>;
  batch: number;
}

export type Client = ServerWebSocket<{
  nb: string;
  sid: string;
  principal: import("./auth/principal").Principal;
  /** may see what cells output (their results are data): those who may run the notebook */
  outputs: boolean;
  /** a published report's viewer: their report kernel, not the notebook's */
  report?: boolean;
}>;

let batches = 0;
let seq = 0;

export class Host {
  readonly clients = new Set<Client>();
  private outputs = new Map<string, CellOutput>();
  private session?: Session;
  private opening?: Promise<Session>;
  private queue: Job[] = [];
  private runningJob?: Job;
  private deps: Record<string, Deps> = {};
  private namespace: Namespace = { tables: [], declared: [] };
  private analyzing?: ReturnType<typeof setTimeout>;
  /** Masks secret values in what cells print. */
  private redact = (t: string) => t;
  /** Its connections changed since the kernel started: it still has the old credentials. */
  private secretsStale = false;
  /** Batches someone is waiting on (an AI client's run), by batch. */
  private waiting = new Map<number, () => void>();
  /** The kernel's CPU and memory, scraped every 2 s while it runs; 15 minutes of it kept. */
  readonly monitor = new Monitor();
  private scraping?: ReturnType<typeof setInterval>;
  /** Last asked to do something (run, complete, inspect…) or looked at: for the idle stop. */
  lastUsed = Date.now();
  /** The kernel's place under the caps, while it has one. */
  private release?: () => void;
  /** The environment the running kernel started with: a variable its owner may no longer have stops it;
   *  another change makes it stale; no change is no news. */
  private startedWith: Record<string, string> = {};
  /** A restart's old kernel, still closing. */
  private restarting?: Promise<void>;

  constructor(
    readonly nb: string,
    private store: Store,
    private runner: Runner,
    private envs: EnvSource,
    private opts: {
      /** whose kernel it is (none: a test's) */
      owner?: Principal;
      /** the caps it counts against (none: no caps) */
      kernels?: Kernels;
      /** whose connections it runs with, when not its owner's (a report run as its publisher) */
      runAs?: Principal;
      /** its cells, when not the folder's (a published report's, frozen) */
      cells?: () => Promise<Pick<import("./notebook").Cell, "name" | "lang" | "source">[]>;
      /** what cells write to output/ is kept in the folder (not for a report's viewers) */
      keepFiles?: boolean;
      /** a notebook's own kernel, a report viewer's, or a scheduled run */
      kind?: "live" | "report" | "schedule";
      /** the Python packages its kernel gets (the environments applied, or a published report's pinned ones) */
      packages?: () => Promise<import("./runner/types").OpenOptions["packages"]>;
    } = {},
  ) {
    this.analyzeNow();
  }

  get owner(): Principal | undefined {
    return this.opts.owner;
  }
  /** Whose connections its kernel has. */
  get runAs(): Principal | undefined {
    return this.opts.runAs ?? this.opts.owner;
  }
  get kind() {
    return this.opts.kind ?? "live";
  }

  /** Its cells: the folder's, or the published ones. */
  private async cells() {
    return this.opts.cells ? await this.opts.cells() : (await this.store.load(this.nb)).cells;
  }

  // -- a scheduled run's outputs, given to a viewer's report host before it runs anything
  private order: string[] = [];
  /** outputs came from a scheduled run, not this kernel: the first real run runs everything it needs */
  private seeded = false;
  /** When the outputs it was given were made. */
  seededAt?: number;

  /** Take a scheduled run's outputs, as if this kernel had run them (only before it has run anything). */
  seed(outputs: Map<string, CellOutput>, at: number) {
    if (this.session || this.opening || this.runningJob || this.queue.length) return;
    this.outputs = new Map([...outputs].map(([k, o]) => [k, { ...o, events: [...o.events] }]));
    this.seeded = true;
    this.seededAt = at;
    for (const [cell, out] of this.outputs) {
      this.broadcast({ type: "state", cell, state: out.state, ms: out.ms, ran: out.ran });
      for (const ev of out.events) this.broadcastOutput(ev.meta, ev.data);
    }
  }

  /** What it holds now: a scheduled run's result, for viewers. */
  results(): Map<string, CellOutput> {
    return this.outputs;
  }

  private touch() {
    this.lastUsed = Date.now();
  }

  /** A kernel is running, or starting. */
  get running(): boolean {
    return !!this.session || !!this.opening;
  }

  /** Something is queued or running: not idle, however long ago it started. */
  get busy(): boolean {
    return !!this.runningJob || this.queue.length > 0;
  }

  /** Stop the kernel because nobody used it for a while: the tabs are told why, and what it held is gone. */
  async stopIdle(idleMs: number) {
    if (!this.session || this.busy) return;
    const m = Math.round(idleMs / 60_000);
    const unused = m >= 1 ? `${m} minute${m === 1 ? "" : "s"}` : `${Math.round(idleMs / 1000)} seconds`;
    await this.stop(`The kernel stopped after ${unused} unused. Run a cell to start it again.`);
  }

  /** Stop the kernel, telling its tabs why: what it held is gone, and the next run starts a new one. */
  private async stop(why: string) {
    const s = this.session;
    if (!s) return;
    this.interrupt();
    this.session = undefined;
    this.freePlace();
    this.stopScraping();
    await s.close();
    this.forget();
    this.broadcast({ ...this.sessionMsg(), stopped: why });
  }

  // -- clients

  private send(to: Iterable<Client>, meta: object, data?: Uint8Array) {
    const frame = encodeFrame(meta, data);
    for (const c of to) c.send(frame);
  }

  broadcast(meta: object, data?: Uint8Array) {
    this.send(this.clients, meta, data);
  }

  /** A cell's output: only to the tabs of those who may see results. */
  private broadcastOutput(meta: object, data?: Uint8Array) {
    this.send([...this.clients].filter((c) => c.data.outputs !== false), meta, data);
  }

  private sessionMsg() {
    return { type: "session", state: this.session ? "ready" : "none", info: this.session?.info ?? {}, secretsStale: this.secretsStale, envStale: this.envStale };
  }

  /** Its environment's packages changed since the kernel started: it has the old ones until a restart. */
  private envStale = false;
  environmentChanged() {
    if (!this.session) return;
    this.envStale = true;
    this.broadcast(this.sessionMsg());
  }

  attach(ws: Client) {
    this.touch();
    this.clients.add(ws);
    this.send([ws], this.sessionMsg());
    this.send([ws], { type: "deps", deps: this.deps });
    this.send([ws], { type: "tables", ...this.namespace });
    for (const [cell, out] of this.outputs) {
      this.send([ws], { type: "state", cell, state: out.state, ms: out.ms, ran: out.ran });
      if (ws.data.outputs !== false) for (const ev of out.events) this.send([ws], ev.meta, ev.data);
    }
    this.send([ws], { type: "metrics-history", scope: this.scope(), points: this.monitor.points });
    // the tab now knows everything there was to know
    this.send([ws], { type: "replayed" });
  }

  detach(ws: Client) {
    this.clients.delete(ws);
  }

  private setState(cell: string, state: CellState, ms?: number) {
    const out = this.outputs.get(cell) ?? { state, events: [] };
    out.state = state;
    out.ms = ms;
    this.outputs.set(cell, out);
    this.broadcast({ type: "state", cell, state, ms, ran: out.ran });
  }

  /** A cell was deleted: its output, run stamp and table go with it, so a new
   *  cell that gets the same name starts clean. */
  async removed(cell: string) {
    this.outputs.delete(cell);
    this.broadcast({ type: "forget", cell });
    if (this.session) {
      await this.session.forget(cell);
      this.namespace = await this.session.tables();
      this.broadcast({ type: "tables", ...this.namespace });
    }
  }

  /** Follow a cell rename: its outputs, and its table in the running kernel. */
  async renamed(from: string, to: string) {
    if (this.outputs.has(to)) {
      this.outputs.delete(to); // leftovers of a deleted cell of that name
      this.broadcast({ type: "forget", cell: to });
    }
    const out = this.outputs.get(from);
    if (out) {
      this.outputs.delete(from);
      this.outputs.set(to, out);
      for (const ev of out.events) ev.meta = { ...ev.meta, cell: to, event: { ...ev.meta.event, name: ev.meta.event.name === from ? to : ev.meta.event.name } };
    }
    if (this.session) {
      await this.session.rename(from, to);
      this.namespace = await this.session.tables();
      this.broadcast({ type: "tables", ...this.namespace });
    }
  }

  // -- dependencies

  /** Re-read the folder's cells and what they define and read. */
  analyzeSoon() {
    clearTimeout(this.analyzing);
    this.analyzing = setTimeout(() => this.analyzeNow(), 150);
  }

  async analyzeNow() {
    try {
      const cells = await this.cells();
      this.order = cells.map((c) => c.name);
      this.deps = await analyze(cells as any);
      this.broadcast({ type: "deps", deps: this.deps });
    } catch (e) {
      console.error(`analyze ${this.nb}:`, e);
    }
  }

  // -- session

  private async ensureSession(): Promise<Session> {
    if (this.restarting) await this.restarting;
    if (this.session) return this.session;
    this.opening ??= (async () => {
      // a place under the caps first: a refusal says which, and nothing starts
      // (each session gives back its own place: an old one closing late can't free a new one's)
      const release = this.opts.kernels?.acquire(this.opts.owner?.id ?? "", this.nb) ?? (() => {});
      this.release = release;
      this.broadcast({ type: "session", state: "starting", info: {} });
      const env = await this.envs.env(this.nb, this.runAs);
      this.startedWith = env;
      this.redact = redactor(Object.values(env));
      this.secretsStale = false;
      // the workspace's defaults, then the notebook's own
      const sandbox = (await this.store.sandboxOf(this.nb)) as Sandbox | undefined;
      // where cells may write (LOAD INTO 'output/x.parquet', df.write_parquet): there before they run
      await mkdir(join(this.store.dir(this.nb), "output"), { recursive: true });
      let s: Session;
      try {
        const packages = await this.opts.packages?.();
        this.envStale = false;
        s = await this.runner.open({ notebookDir: this.store.dir(this.nb), env, sandbox, packages });
      } catch (e) {
        release();
        this.broadcast(this.sessionMsg());
        throw e;
      }
      this.session = s;
      s.closed.then(() => {
        release();
        if (this.session === s) this.stopScraping();
        if (this.session !== s) return;
        this.session = undefined;
        this.forget();
        this.broadcast({ type: "session", state: "dead", info: {} });
      });
      this.broadcast(this.sessionMsg());
      this.startScraping(s);
      return s;
    })()
      .catch((e) => {
        // refused a place (or failed before one): nothing is starting any more
        if (!this.session) this.broadcast(this.sessionMsg());
        throw e;
      })
      .finally(() => (this.opening = undefined));
    return this.opening;
  }

  private freePlace() {
    this.release?.();
    this.release = undefined;
  }

  // -- metrics

  /** Whose numbers they are: the microVM's own, or a local kernel's processes on the host. */
  scope(): Scope {
    return this.session?.info.sandbox === "firecracker" ? "vm" : "process";
  }

  /** Scrape `s` every 2 s while it is the session: each point goes to every tab. */
  private startScraping(s: Session) {
    this.stopScraping();
    this.monitor.restart();
    const host = { cpus: cpus().length, memory: totalmem() };
    let busy = false;
    const tick = async () => {
      if (busy || this.session !== s) return;
      busy = true;
      try {
        const text = await Promise.race([s.metrics(), Bun.sleep(1500).then(() => Promise.reject(new Error("scrape timed out")))]);
        if (this.session !== s) return;
        const point = this.monitor.push(parseExposition(text), Date.now(), this.scope(), host);
        this.broadcast({ type: "metrics", scope: this.scope(), point });
      } catch {
        // a missed scrape is a gap in the chart, nothing more
      } finally {
        busy = false;
      }
    };
    tick();
    this.scraping = setInterval(tick, 2000);
  }

  private stopScraping() {
    clearInterval(this.scraping);
    this.scraping = undefined;
  }

  /** The latest numbers, for /metrics; none when no kernel runs. */
  latestMetrics() {
    const point = this.monitor.points.at(-1);
    return this.session && point ? { notebook: this.nb, user: this.opts.owner?.id ?? "", scope: this.scope(), point } : null;
  }

  /** A new kernel holds nothing: every cell has to run again. */
  private forget() {
    for (const [cell, out] of this.outputs) {
      out.ran = undefined;
      this.setState(cell, out.state === "running" || out.state === "queued" ? "idle" : out.state, out.ms);
    }
    this.namespace = { tables: [], declared: [] };
    this.broadcast({ type: "tables", ...this.namespace });
  }

  async restart() {
    this.interrupt();
    const s = this.session;
    this.session = undefined;
    // its place goes to the new kernel at once; a run meanwhile waits for the old one to be gone
    this.freePlace();
    this.restarting = (async () => {
      await s?.close();
      this.forget();
    })().finally(() => (this.restarting = undefined));
    await this.restarting;
    await this.ensureSession();
  }

  // -- runs

  /** Queue cells to run in order; a failure drops the rest of the batch. */
  run(cells: string[], params: Record<string, string>): number {
    this.touch();
    // outputs from a scheduled run, and no kernel of its own yet: what the cells read isn't in it
    // (and the other cells' results aren't in it either: stale, so the report runs them again as it needs them)
    if (this.seeded && !this.session && !this.opening) {
      this.seeded = false;
      this.forget();
      cells = plan(cells, this.order, edges(this.order, this.deps), {});
    }
    const batch = ++batches;
    for (const cell of cells) {
      if (this.queue.some((j) => j.cell === cell)) continue;
      this.queue.push({ cell, params, batch });
      this.setState(cell, "queued", this.outputs.get(cell)?.ms);
    }
    if (!this.runningJob) this.pump();
    return batch;
  }

  interrupt() {
    for (const j of this.queue.splice(0)) this.setState(j.cell, "idle", this.outputs.get(j.cell)?.ms);
    if (this.runningJob) this.session?.interrupt();
    this.settle();
  }

  /** Let go of the waits on batches with nothing left queued or running. */
  private settle() {
    for (const [b, done] of this.waiting) {
      if (this.runningJob?.batch === b || this.queue.some((j) => j.batch === b)) continue;
      this.waiting.delete(b);
      done();
    }
  }

  private async pump() {
    while (this.queue.length) {
      const job = (this.runningJob = this.queue.shift()!);
      const ok = await this.runOne(job).catch((e) => {
        this.record(job.cell, { type: "error", message: String(e?.message ?? e) });
        this.setState(job.cell, "error");
        return false;
      });
      if (!ok) {
        for (const j of this.queue.filter((j) => j.batch === job.batch)) this.setState(j.cell, "idle", this.outputs.get(j.cell)?.ms);
        this.queue = this.queue.filter((j) => j.batch !== job.batch);
      }
      this.runningJob = undefined;
      this.settle();
    }
  }

  /** A connection it may use was added, changed or removed (or who may use it). The running kernel
   *  keeps the old environment until a restart; mask both old and new values meanwhile. */
  async secretsChanged() {
    const env = await this.envs.env(this.nb, this.runAs);
    // access taken away (a grant removed, a connection deleted, a variable dropped): a running kernel
    // mustn't keep what its owner may no longer use, so it stops
    const lost = this.session ? Object.keys(this.startedWith).filter((v) => !(v in env)) : [];
    if (lost.length) {
      await this.stop(`The kernel stopped: it no longer gets ${lost.join(", ")} (access removed, or the connection changed). Run a cell to start it again.`);
      this.redact = redactor(Object.values(env));
      return;
    }
    // nothing it gets changed (a policy about something else, a role elsewhere): nothing to say
    const same = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);
    if (this.session && same(env, this.startedWith)) {
      if (this.secretsStale) (this.secretsStale = false), this.broadcast(this.sessionMsg());
      return;
    }
    const old = this.redact;
    const next = redactor(Object.values(env));
    this.redact = (t) => next(old(t));
    if (this.session) this.secretsStale = true;
    this.broadcast(this.sessionMsg());
  }

  private record(cell: string, ev: CellEvent | { type: "error"; message: string }) {
    const { meta, data } = this.scrub(cell, ev);
    if (ev.type !== "progress") this.outputs.get(cell)?.events.push({ meta, data });
    this.broadcastOutput(meta, data);
  }

  /** An event as it is kept and sent: its binary apart, what it prints masked. */
  private scrub(cell: string, ev: CellEvent | { type: "error"; message: string }) {
    let data: Uint8Array | undefined;
    let meta: any = { ...ev };
    if (ev.type === "table") ({ arrow: data, ...meta } = ev);
    else if (ev.type === "display") ({ data, ...meta } = ev);
    // whatever a cell prints passes the mask; tables are data and are left as they are
    const r = this.redact;
    for (const k of ["text", "message", "traceback", "reason"]) if (typeof meta[k] === "string") meta[k] = r(meta[k]);
    if (ev.type === "display" && data && ev.mime.startsWith("text/")) {
      data = new TextEncoder().encode(r(new TextDecoder().decode(data)));
    }
    meta = { type: "event", cell, event: meta };
    return { meta, data };
  }

  private async runOne({ cell, params }: Job): Promise<boolean> {
    const spec = (await this.cells()).find((c) => c.name === cell);
    if (!spec) throw new Error(`no cell \`${cell}\``);
    const prev = this.outputs.get(cell);
    this.outputs.set(cell, { state: "running", events: [], ran: prev?.ran });
    this.broadcast({ type: "clear", cell });
    this.setState(cell, "running");
    if (spec.lang === "md") {
      this.setState(cell, "ok", 0);
      return true;
    }
    const session = await this.ensureSession();
    let ok = false;
    let ms = 0;
    let wrote = false;
    for await (const ev of session.run({ name: cell, lang: spec.lang, source: spec.source }, params)) {
      if (ev.type === "done") ({ ok, ms } = ev);
      else if (ev.type === "file" || ev.type === "file_removed") {
        // a report's viewer doesn't write into the notebook's folder
        if (this.opts.keepFiles === false) continue;
        const note = await this.keepFile(ev);
        if (note) this.record(cell, { type: "stream", stream: "stderr", text: note });
        wrote = true;
      } else this.record(cell, ev);
    }
    if (wrote) this.broadcast({ type: "notebook" }); // the folder's file list changed
    const out = this.outputs.get(cell)!;
    out.ran = { hash: hash(spec.source), seq: ++seq, params, ok };
    this.setState(cell, ok ? "ok" : "error", ms);
    if (this.session === session) {
      this.namespace = await session.tables();
      this.broadcast({ type: "tables", ...this.namespace });
    }
    return ok;
  }

  /** Every problem in a SQL cell, without running it. The running kernel checks
   *  against the session (connections, params, the real columns of other cells'
   *  results); with none, or while it is busy with a run, the CLI checks with the
   *  notebook's names. Never starts a kernel. */
  async check(source: string, cell?: string): Promise<Diagnostic[]> {
    const known = new Set<string>();
    const connections = new Set<string>();
    for (const [name, d] of Object.entries(this.deps)) {
      if (name === cell) continue;
      for (const def of d.defines) {
        if (def.startsWith("conn:")) connections.add(def.slice(5).toLowerCase());
        else if (/^[A-Za-z_]\w*$/.test(def)) known.add(def);
      }
    }
    if (this.session && !this.runningJob) {
      const diags = await this.session.check(source, [...known]);
      // a fault in an earlier cell's declaration belongs to that cell
      return diags.filter((d) => d.file !== "session").map((d) => ({ ...d, msg: this.redact(d.msg) }));
    }
    return checkCli(source, [...known], connections);
  }

  /** A search over a cell's whole result, answered to the tab that asked. */
  async filterFor(ws: Client, id: number, cell: string, terms: unknown[]) {
    this.touch();
    try {
      if (!this.session) throw new Error("The kernel isn't running.");
      const { arrow, ...meta } = await this.session.filter(cell, terms);
      this.send([ws], { type: "filtered", id, ...meta }, arrow);
    } catch (e: any) {
      this.send([ws], { type: "filtered", id, error: e.message });
    }
  }

  async checkFor(ws: Client, id: number, source: string, cell?: string) {
    const diagnostics = await this.check(source, cell).catch(() => []);
    this.send([ws], { type: "check", id, diagnostics });
  }

  async complete(ws: Client, id: number, lang: CodeLang, source: string, pos: number) {
    this.touch();
    const result = await this.ensureSession()
      .then((s) => s.complete(lang, source, pos))
      .catch(() => ({ start: pos, end: pos, items: [] }));
    this.send([ws], { type: "complete", id, ...result });
  }

  async inspect(ws: Client, id: number, script: string) {
    this.touch();
    try {
      const s = await this.ensureSession();
      this.send([ws], { type: "inspect", id, ...(await s.inspect(script)) });
    } catch (e: any) {
      this.send([ws], { type: "inspect", id, columns: [], rows: [], error: e.message });
    }
  }

  // -- for AI clients (mcp/)

  /** What there is to know about the notebook's run state, as it stands. */
  snapshot() {
    return { deps: this.deps, namespace: this.namespace, outputs: this.outputs, session: this.session ? "ready" : "none", info: this.session?.info ?? {} };
  }

  /** Run `targets` with their stale ancestors first (as the Run button does),
   *  and wait up to `timeoutMs` for them. Returns what was run and whether it finished. */
  async runAndWait(targets: string[], params: Record<string, string>, timeoutMs: number) {
    this.touch();
    await this.analyzeNow();
    const book = { cells: await this.cells() };
    const order = book.cells.map((c) => c.name);
    const code = new Set(book.cells.filter((c) => c.lang !== "md").map((c) => c.name));
    for (const t of targets) if (!order.includes(t)) throw new Error(`no cell \`${t}\``);
    const up = edges(order, this.deps);
    const ran = Object.fromEntries([...this.outputs].map(([k, o]) => [k, o.ran]));
    const sources = Object.fromEntries(book.cells.map((c) => [c.name, c.source]));
    const fresh = freshness(order, up, this.deps, ran, sources, params, code);
    const cells = plan(targets, order, up, fresh);
    if (!cells.length) return { cells, finished: true };
    const done = new Promise<boolean>((r) => this.waiting.set(batches + 1, () => r(true)));
    this.run(cells, params);
    this.settle(); // every cell was already queued by someone else
    const finished = await Promise.race([done, Bun.sleep(timeoutMs).then(() => false)]);
    return { cells, finished };
  }

  /** Run a snippet outside any cell and collect what it shows. Its table
   *  doesn't stay; Python names it binds do, as in a scratch cell. */
  async scratch(lang: CodeLang, source: string, params: Record<string, string>) {
    this.touch();
    const s = await this.ensureSession();
    const name = "_ai_scratch";
    const events: { meta: any; data?: Uint8Array }[] = [];
    let ok = false;
    let ms = 0;
    let wrote = false;
    for await (const ev of s.run({ name, lang, source }, params)) {
      if (ev.type === "done") ({ ok, ms } = ev);
      else if (ev.type === "file" || ev.type === "file_removed") {
        const note = await this.keepFile(ev);
        if (note) events.push(this.scrub(name, { type: "stream", stream: "stderr", text: note }));
        wrote = true;
      } else if (ev.type !== "progress") events.push(this.scrub(name, ev.type === "table" ? { ...ev, name: null } : ev));
    }
    if (wrote) this.broadcast({ type: "notebook" });
    await s.forget(name).catch(() => {});
    if (this.session === s) {
      this.namespace = await s.tables();
      this.broadcast({ type: "tables", ...this.namespace });
    }
    return { ok, ms, events };
  }

  // -- files

  /** What a sandboxed cell wrote to output/, kept in the notebook's folder: the
   *  one place a sandbox can write back to. Returns a line for the cell's output
   *  once a file is complete. */
  private async keepFile(ev: Extract<CellEvent, { type: "file" | "file_removed" }>): Promise<string | null> {
    const root = join(this.store.dir(this.nb), "output");
    const dest = resolve(root, ev.path);
    // a path from the sandbox is untrusted: it must land inside output/
    if (!dest.startsWith(root + sep) || ev.path.includes("\0")) {
      return `output/${ev.path}: refused, outside the output folder\n`;
    }
    if (ev.type === "file_removed") {
      await rm(dest, { force: true });
      return `removed output/${ev.path}\n`;
    }
    await mkdir(dirname(dest), { recursive: true });
    const f = await open(dest, ev.offset === 0 ? "w" : "r+");
    try {
      if (ev.data?.length) await f.write(ev.data, 0, ev.data.length, ev.offset);
    } finally {
      await f.close();
    }
    const end = ev.offset + (ev.data?.length ?? 0);
    return end >= ev.size ? `saved output/${ev.path} (${size(ev.size)})\n` : null;
  }

  /** A cell's result in full as a file, from the running kernel. */
  async export(cell: string, format: ExportFormat): Promise<AsyncIterable<Uint8Array>> {
    this.touch();
    if (!this.session) throw new Error(`The kernel isn't running: run \`${cell}\` first.`);
    return this.session.export(cell, format);
  }

  /** A script outside any cell (DESCRIBE, SHOW TABLES), starting the kernel if need be. */
  async describe(script: string): Promise<Inspection> {
    this.touch();
    const s = await this.ensureSession();
    const r = await s.inspect(script);
    return { ...r, error: r.error && this.redact(r.error) };
  }

  async close() {
    this.interrupt();
    this.stopScraping();
    const s = this.session;
    this.session = undefined;
    await s?.close();
    this.freePlace();
  }
}

const size = (n: number) =>
  n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : n < 1 << 30 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / (1 << 30)).toFixed(2)} GB`;
