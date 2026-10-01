// A Session over any transport that carries the kernel's frames. The local
// runner hands it a process's pipes; the microVM runner will hand it a vsock.

import { encodeFrame, type Frame } from "./protocol";
import type { CellEvent, CellSpec, CodeLang, Completion, Diagnostic, ExportFormat, Inspection, Namespace, Session, Shell, ShellEvents } from "./types";

export interface Transport {
  send(frame: Uint8Array): void;
  frames: AsyncIterable<Frame>;
  /** Resolves when the kernel is gone, with a reason if it died unexpectedly. */
  exited: Promise<string | undefined>;
  kill(): void;
}

class Chan<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private wake?: () => void;
  private ended = false;

  push(v: T) {
    this.items.push(v);
    this.wake?.();
  }

  end() {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.items.length) yield this.items.shift()!;
      else if (this.ended) return;
      else await new Promise<void>((r) => (this.wake = r));
    }
  }
}

let nextId = 1;

// The message that ends each kind of request.
const FINAL = new Set(["ready", "done", "tables", "complete", "reset", "inspect", "renamed", "forgot", "exported", "checked", "filtered", "metrics", "profile"]);

export class KernelSession implements Session {
  readonly id: string;
  readonly closed: Promise<void>;
  private pending = new Map<number, Chan<any>>();
  private shells = new Map<string, ShellEvents>();
  private dead?: string;
  /** Versions the kernel reported at start. */
  info: Record<string, string> = {};

  static async start(id: string, t: Transport, timeoutMs = 30_000): Promise<KernelSession> {
    const s = new KernelSession(id, t);
    const ready = s.pending.get(0)!;
    const timer = setTimeout(() => t.kill(), timeoutMs);
    for await (const msg of ready) {
      clearTimeout(timer);
      if (msg.type === "ready") {
        const { type: _, ...info } = msg;
        s.info = info;
        return s;
      }
      throw new Error(`kernel failed to start: ${msg.message}`);
    }
    throw new Error("kernel failed to start");
  }

  private constructor(id: string, private t: Transport) {
    this.id = id;
    this.pending.set(0, new Chan()); // the ready message carries no id
    this.closed = this.pump();
  }

  private async pump() {
    const drain = (async () => {
      for await (const { meta, data } of this.t.frames) {
        // a terminal's output isn't the answer to a request
        if (meta.type === "shell_output") {
          this.shells.get(meta.shell)?.data(data);
          continue;
        }
        if (meta.type === "shell_exit") {
          this.shells.get(meta.shell)?.exit(meta.code ?? null);
          this.shells.delete(meta.shell);
          continue;
        }
        const chan = this.pending.get(meta.id ?? 0);
        if (!chan) continue;
        const { id: _, ...ev } = meta;
        if (ev.type === "table" || ev.type === "filtered") chan.push({ ...ev, arrow: data });
        else if (ev.type === "display" || ev.type === "file" || ev.type === "chunk") chan.push({ ...ev, data });
        else chan.push(ev);
        if (FINAL.has(ev.type)) {
          chan.end();
          this.pending.delete(meta.id ?? 0);
        }
      }
    })();
    const reason = await this.t.exited;
    await drain.catch(() => {});
    this.dead = reason ?? "kernel exited";
    for (const sh of this.shells.values()) sh.exit(null);
    this.shells.clear();
    for (const chan of this.pending.values()) {
      chan.push({ type: "error", message: this.dead });
      chan.push({ type: "done", ok: false, ms: 0 });
      chan.end();
    }
    this.pending.clear();
  }

  private request(op: string, body: object = {}): Chan<any> {
    const id = nextId++;
    const chan = new Chan<any>();
    if (this.dead) {
      chan.push({ type: "error", message: this.dead });
      chan.push({ type: "done", ok: false, ms: 0 });
      chan.end();
      return chan;
    }
    this.pending.set(id, chan);
    this.t.send(encodeFrame({ op, id, ...body }));
    return chan;
  }

  run(cell: CellSpec, params: Record<string, string> = {}): AsyncIterable<CellEvent> {
    return this.request("run", { cell, params });
  }

  interrupt() {
    if (!this.dead) this.t.send(encodeFrame({ op: "interrupt" }));
  }

  async tables(): Promise<Namespace> {
    for await (const msg of this.request("tables")) {
      if (msg.type === "tables") return { tables: msg.tables, declared: msg.declared };
      if (msg.type === "error") throw new Error(msg.message);
    }
    return { tables: [], declared: [] };
  }

  async inspect(script: string): Promise<Inspection> {
    for await (const msg of this.request("inspect", { script })) {
      if (msg.type === "inspect") return { columns: msg.columns, rows: msg.rows, error: msg.error };
      if (msg.type === "error") return { columns: [], rows: [], error: msg.message };
    }
    return { columns: [], rows: [], error: "no answer" };
  }

  async complete(lang: CodeLang, source: string, pos: number): Promise<Completion> {
    for await (const msg of this.request("complete", { lang, source, pos })) {
      if (msg.type === "complete") return { start: msg.start, end: msg.end, items: msg.items };
      if (msg.type === "error") throw new Error(msg.message);
    }
    return { start: pos, end: pos, items: [] };
  }

  async filter(name: string, terms: unknown[]) {
    let failed = "";
    for await (const msg of this.request("filter", { name, terms })) {
      if (msg.type === "error") failed = msg.message;
      else if (msg.type === "filtered") {
        if (failed) throw new Error(failed);
        return { rows: msg.rows, of: msg.of, truncated: msg.truncated, columns: msg.columns, arrow: msg.arrow };
      }
    }
    throw new Error(failed || "no answer");
  }

  /** Each column of a whole result, profiled (web/src/lib/profile.ts). */
  async profile(name: string): Promise<{ rows: number; columns: Record<string, unknown> }> {
    let failed = "";
    for await (const msg of this.request("profile", { name })) {
      if (msg.type === "error") failed = msg.message;
      else if (msg.type === "profile") {
        if (failed) throw new Error(failed);
        return { rows: msg.rows, columns: msg.columns };
      }
    }
    throw new Error(failed || "no answer");
  }

  async check(source: string, known: string[]): Promise<Diagnostic[]> {
    for await (const msg of this.request("check", { source, known })) {
      if (msg.type === "checked") return msg.diagnostics;
      if (msg.type === "error") throw new Error(msg.message);
    }
    return [];
  }

  async export(name: string, format: ExportFormat): Promise<AsyncIterable<Uint8Array>> {
    const it = this.request("export", { name, format })[Symbol.asyncIterator]();
    // the first message says whether there is anything to send
    const first = await it.next();
    if (first.done || first.value.type === "error") throw new Error(first.done ? "no answer" : first.value.message);
    return (async function* () {
      let msg: IteratorResult<any> = first;
      while (!msg.done) {
        if (msg.value.type === "chunk" && msg.value.data?.length) yield msg.value.data as Uint8Array;
        else if (msg.value.type === "error") throw new Error(msg.value.message);
        msg = await it.next();
      }
    })();
  }

  /** The kernel's scrape: Prometheus text exposition, answered even while a cell runs. */
  async metrics(): Promise<string> {
    for await (const msg of this.request("metrics")) {
      if (msg.type === "metrics") {
        if (msg.error) throw new Error(msg.error);
        return msg.text;
      }
      if (msg.type === "error") throw new Error(msg.message);
    }
    throw new Error("no answer");
  }

  async forget(name: string) {
    for await (const msg of this.request("forget", { name })) if (msg.type === "error") throw new Error(msg.message);
  }

  async rename(from: string, to: string) {
    for await (const msg of this.request("rename", { from, to })) if (msg.type === "error") throw new Error(msg.message);
  }

  async reset() {
    for await (const msg of this.request("reset")) if (msg.type === "error") throw new Error(msg.message);
  }

  shell(cols: number, rows: number, on: ShellEvents): Shell {
    const shell = `sh${nextId++}`;
    const send = (meta: object, data?: Uint8Array) => !this.dead && this.t.send(encodeFrame({ ...meta, shell }, data));
    if (this.dead) queueMicrotask(() => on.exit(null));
    else {
      this.shells.set(shell, on);
      send({ op: "shell_open", cols, rows });
    }
    return {
      write: (bytes) => send({ op: "shell_input" }, bytes),
      resize: (c, r) => send({ op: "shell_resize", cols: c, rows: r }),
      close: () => send({ op: "shell_close" }),
    };
  }

  async close() {
    if (!this.dead) {
      this.t.send(encodeFrame({ op: "shutdown" }));
      const timer = setTimeout(() => this.t.kill(), 3000);
      await this.closed;
      clearTimeout(timer);
    }
  }
}
