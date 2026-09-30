// The live side of a notebook: one WebSocket to the server's Host, holding
// each cell's run state and outputs. Frames match server/runner/protocol.ts.

import type { Deps, Ran } from "../../../shared/graph";
import { homeHref, nbHref, viewHref, wsHref } from "./href";
import { loginHref } from "./api";

export type CellState = "idle" | "queued" | "running" | "ok" | "error";

export type Output =
  | { type: "stream"; stream: "stdout" | "stderr"; text: string }
  | {
      type: "table";
      name: string | null;
      rows: number;
      truncated: boolean;
      capped: boolean;
      columns: { name: string; type: string }[];
      arrow: Uint8Array;
    }
  | { type: "display"; mime: string; data: Uint8Array }
  | { type: "error"; message: string; line?: number; col?: number; end_col?: number; traceback?: string; shown?: boolean }
  // one per LOAD as it finishes (inside a FOR EACH, one per row), then the run's totals
  | {
      type: "load";
      load: number;
      target: string;
      rows_read: number;
      rows_written: number;
      elapsed_ms: number;
      lanes: number;
      ok: boolean;
      reason?: string;
      transient?: boolean;
      line?: number;
      col?: number;
      loop_row?: number;
      loop_rows?: number;
    }
  | { type: "loads"; loads_ok: number; loads_failed: number; rows_read: number; rows_loaded: number; lanes: number; elapsed_ms: number };

export interface Progress {
  target: string;
  rows: number;
  rows_per_sec: number;
  elapsed_ms: number;
  loop_done?: number;
  loop_total?: number;
  /** When it arrived (ms), so the clock can keep running between frames. */
  at: number;
}

export interface CellRun {
  state: CellState;
  ms?: number;
  ran?: Ran;
  outputs: Output[];
  progress?: Progress;
}

export interface TableInfo {
  name: string;
  rows: number;
  columns: { name: string; type: string }[];
}

export interface Inspection {
  columns: string[];
  rows: unknown[][];
  error?: string;
}

/** A problem basalt's check found, 1-based in the cell's source. */
export interface Diagnostic {
  level: "error" | "warning";
  msg: string;
  line: number;
  col: number;
  end_line?: number;
  end_col?: number;
}

export interface Completion {
  start: number;
  end: number;
  items: { text: string; kind: string; detail?: string }[];
}

/** What the kernel uses at one moment (server/metrics.ts): CPU as a share, memory in bytes. */
export interface MetricPoint {
  t: number;
  cpu: number | null;
  mem: number;
  memTotal: number;
  rss: Record<string, number>;
}

function decode(buf: ArrayBuffer): { meta: any; data: Uint8Array } {
  const view = new DataView(buf);
  const n = view.getUint32(0);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
  const m = view.getUint32(4 + n);
  return { meta, data: new Uint8Array(buf, 8 + n, m) };
}

/** A terminal's side of the socket (TerminalView.svelte). */
export interface TerminalEvents {
  data(bytes: Uint8Array): void;
  /** it ended: the shell's exit code, or why it couldn't be (no sandbox, no permission, the kernel stopped) */
  exit(code: number | null, message?: string): void;
}

export class NotebookConn {
  runs = $state<Record<string, CellRun>>({});
  session = $state<"none" | "starting" | "ready" | "dead" | "offline">("offline");
  info = $state<Record<string, string>>({});
  /** Its connections (or who may use them) changed after the kernel started; it has the old credentials until a restart. */
  secretsStale = $state(false);
  /** Its environment's packages changed after the kernel started; it has the old ones until a restart. */
  envStale = $state(false);
  tables = $state<TableInfo[]>([]);
  declared = $state<{ kind: string; name: string }[]>([]);
  deps = $state<Record<string, Deps>>({});
  /** The kernel's CPU and memory, a point every 2 s (15 minutes kept by the server);
   *  "vm": the microVM's own numbers, "process": a local kernel's, on the host */
  metrics = $state<{ scope: "vm" | "process"; points: MetricPoint[] }>({ scope: "process", points: [] });
  /** The server has replayed this notebook's state: runs, stamps, deps. */
  synced = $state(false);
  /** Why the kernel stopped, when the server stopped it (unused too long): shown until one starts. */
  stopped = $state("");
  /** Something the page should say: a request refused (no permission), the kernel stopped. */
  onnotice?: (message: string) => void;
  /** Sent before the socket opened; delivered when it does. */
  private outbox: string[] = [];

  private ws?: WebSocket;
  private closed = false;
  private retry = 0;
  private nextId = 1;
  private waiting = new Map<number, (reply: any) => void>();
  /** open terminals: what they print, and how they end */
  private terminals = new Map<string, TerminalEvents>();

  constructor(
    private nb: string,
    private onNotebookChanged: () => void,
    /** a published report's viewer: their report kernel, not the notebook's */
    private report = false,
  ) {
    this.connect();
  }

  private connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/${this.nb.split("/").map(encodeURIComponent).join("/")}${this.report ? "/report" : ""}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.retry = 0;
      this.runs = {};
      for (const m of this.outbox.splice(0)) ws.send(m);
    };
    ws.onmessage = (e) => this.handle(decode(e.data));
    ws.onclose = (e) => {
      this.session = "offline";
      this.synced = false;
      // a terminal lives in the kernel the socket reached: gone with it
      for (const t of this.terminals.values()) t.exit(null, "Disconnected from the server.");
      this.terminals.clear();
      // the session ended (signed out, expired, the account disabled): sign in again, then back here
      // the report isn't published any more: nothing to reconnect to
      if (e.code === 4404) {
        this.closed = true;
        this.onnotice?.("This report isn't published any more.");
        return;
      }
      if (e.code === 4401) {
        this.closed = true;
        location.hash = loginHref(location.hash);
        return;
      }
      if (!this.closed) setTimeout(() => this.connect(), Math.min(5000, 250 * 2 ** this.retry++));
    };
    this.ws = ws;
  }

  private run(cell: string): CellRun {
    return (this.runs[cell] ??= { state: "idle", outputs: [] });
  }

  private handle({ meta, data }: { meta: any; data: Uint8Array }) {
    switch (meta.type) {
      case "session":
        this.session = meta.state;
        if (meta.stopped) this.onnotice?.(meta.stopped);
        this.stopped = meta.stopped ?? (meta.state === "none" ? this.stopped : "");
        this.info = meta.info ?? {};
        this.secretsStale = !!meta.secretsStale;
        this.envStale = !!meta.envStale;
        break;
      case "metrics-history":
        this.metrics = { scope: meta.scope, points: meta.points };
        break;
      case "metrics": {
        const points = [...this.metrics.points, meta.point];
        if (points.length > 450) points.splice(0, points.length - 450);
        this.metrics = { scope: meta.scope, points };
        break;
      }
      case "state": {
        const r = this.run(meta.cell);
        r.state = meta.state;
        r.ms = meta.ms;
        r.ran = meta.ran;
        if (meta.state !== "running") r.progress = undefined;
        break;
      }
      case "forget":
        delete this.runs[meta.cell];
        break;
      case "clear":
        this.runs[meta.cell] = { state: "running", outputs: [], ran: this.runs[meta.cell]?.ran };
        break;
      case "event": {
        const ev = meta.event;
        const r = this.run(meta.cell);
        if (ev.type === "progress") r.progress = { ...ev, at: Date.now() };
        else if (ev.type === "table") r.outputs.push({ ...ev, arrow: data });
        else if (ev.type === "display") r.outputs.push({ ...ev, data });
        else if (ev.type === "stream") {
          const last = r.outputs.at(-1);
          if (last?.type === "stream" && last.stream === ev.stream) last.text += ev.text;
          else r.outputs.push(ev);
        } else r.outputs.push(ev);
        break;
      }
      case "tables":
        this.tables = meta.tables;
        this.declared = meta.declared ?? [];
        break;
      case "deps":
        this.deps = meta.deps;
        break;
      case "replayed":
        this.synced = true;
        break;
      case "filtered":
        this.waiting.get(meta.id)?.({ ...meta, arrow: data });
        this.waiting.delete(meta.id);
        break;
      case "complete":
      case "inspect":
      case "check":
        this.waiting.get(meta.id)?.(meta);
        this.waiting.delete(meta.id);
        break;
      case "notebook":
        this.onNotebookChanged();
        break;
      case "terminal-output":
        this.terminals.get(meta.term)?.data(data);
        break;
      case "terminal-exit":
        this.terminals.get(meta.term)?.exit(meta.code ?? null, meta.message);
        this.terminals.delete(meta.term);
        break;
      // (a completion, a check, a table's rows: answered empty where they were asked)
      case "denied":
        if (!["complete", "check", "inspect", "filter", "terminal-open", "terminal-input", "terminal-resize", "terminal-close"].includes(meta.op)) this.onnotice?.(meta.message);
        break;
      // renamed or deleted, here or in another tab: follow it, or go back to the list
      case "moved":
        location.hash = this.report ? viewHref(meta.to) : nbHref(meta.to);
        break;
      // its workspace, unless that went too
      case "gone":
        location.hash = meta.workspace ? homeHref() : wsHref(this.nb.split("/")[0]);
        break;
    }
  }


  // -- terminals: a shell in this person's kernel's sandbox

  openTerminal(term: string, cols: number, rows: number, on: TerminalEvents) {
    this.terminals.set(term, on);
    this.send({ op: "terminal-open", term, cols, rows });
  }

  terminalInput(term: string, data: string) {
    if (this.terminals.has(term)) this.send({ op: "terminal-input", term, data });
  }

  resizeTerminal(term: string, cols: number, rows: number) {
    if (this.terminals.has(term)) this.send({ op: "terminal-resize", term, cols, rows });
  }

  closeTerminal(term: string) {
    if (!this.terminals.delete(term)) return;
    this.send({ op: "terminal-close", term });
  }

  private send(msg: object) {
    const text = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text);
    else if (!this.closed) this.outbox.push(text);
  }

  runCells(cells: string[], params: Record<string, string>) {
    this.send({ op: "run", cells, params });
  }

  interrupt() {
    this.send({ op: "interrupt" });
  }

  restart() {
    this.send({ op: "restart" });
  }

  private ask<T>(msg: object, timeoutMs: number, fallback: T): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.send({ ...msg, id });
      setTimeout(() => {
        if (this.waiting.delete(id)) resolve(fallback);
      }, timeoutMs);
    });
  }

  complete(lang: string, source: string, pos: number): Promise<Completion> {
    return this.ask({ op: "complete", lang, source, pos }, 3000, { start: pos, end: pos, items: [] });
  }

  /** A search over a cell's whole result in the kernel: the first matching rows, and how many. */
  filter(cell: string, terms: unknown[]): Promise<{ rows: number; of: number; truncated: boolean; arrow?: Uint8Array; error?: string }> {
    return this.ask({ op: "filter", cell, terms }, 60_000, { rows: 0, of: 0, truncated: false, error: "the search timed out" });
  }

  /** Every problem basalt's check finds in a SQL cell, without running it. */
  check(source: string, cell: string): Promise<Diagnostic[]> {
    return this.ask({ op: "check", source, cell }, 10_000, { diagnostics: [] }).then((r: any) => r.diagnostics ?? []);
  }

  /** SHOW TABLES / DESCRIBE for the sidebar; waits behind a running cell. */
  inspect(script: string): Promise<Inspection> {
    return this.ask({ op: "inspect", script }, 60_000, { columns: [], rows: [], error: "timed out" });
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
