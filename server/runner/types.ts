// A Runner hosts kernels; a Session is one kernel bound to one notebook.
// LocalRunner spawns the kernel as a process; the microVM runner will boot it
// in a guest. Both speak the same framed protocol (see protocol.ts).

export type CodeLang = "sql" | "python";

export interface CellSpec {
  name: string;
  lang: CodeLang;
  source: string;
}

export interface Column {
  name: string;
  type: string;
}

export type CellEvent =
  | { type: "stream"; stream: "stdout" | "stderr"; text: string }
  // `arrow` is an Arrow IPC stream of at most the first 5000 rows (`truncated`
  // when that is fewer than `rows`). `capped`: basalt stopped the query at its
  // row cap, so `rows` — and the table later cells see — is a prefix.
  | { type: "table"; name: string | null; rows: number; truncated: boolean; capped: boolean; columns: Column[]; arrow: Uint8Array }
  | { type: "display"; mime: string; data: Uint8Array }
  | { type: "progress"; target: string; rows: number; rows_per_sec: number; elapsed_ms: number; loop_done?: number; loop_total?: number }
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
  | { type: "loads"; loads_ok: number; loads_failed: number; rows_read: number; rows_loaded: number; lanes: number; elapsed_ms: number }

  // line/col/end_col are 1-based, in the cell's source as written.
  // `shown`: a failed load's line already says it; the error only places it in the source
  | { type: "error"; message: string; line?: number; col?: number; end_col?: number; traceback?: string; transient?: boolean; shown?: boolean }
  // what the cell wrote to output/ in a sandbox, for the host to keep: a chunk of
  // `path` (relative to output/) at `offset`, of `size` bytes in all
  | { type: "file"; path: string; offset: number; size: number; data: Uint8Array }
  | { type: "file_removed"; path: string }
  | { type: "done"; ok: boolean; ms: number };

export interface TableInfo {
  name: string;
  rows: number;
  columns: Column[];
}

export interface Namespace {
  /** Every DataFrame: what SQL cells can read by name. */
  tables: TableInfo[];
  /** basalt declarations the session holds: connections, params, lets, functions. */
  declared: { kind: string; name: string }[];
}

export interface Inspection {
  columns: string[];
  rows: unknown[][];
  error?: string;
}

/** A problem basalt's check found, placed in the script as sent (1-based). */
export interface Diagnostic {
  level: "error" | "warning";
  msg: string;
  line: number;
  col: number;
  end_line?: number;
  end_col?: number;
  /** "session" when it lies in a declaration an earlier cell made */
  file?: string;
}

export interface Completion {
  /** UTF-16 offsets: the items replace source[start..end]. */
  start: number;
  end: number;
  items: { text: string; kind: string; detail?: string }[];
}

export interface Session {
  readonly id: string;
  /** Runs are serialized by the kernel; events for this run only, ending with `done`. */
  run(cell: CellSpec, params?: Record<string, string>): AsyncIterable<CellEvent>;
  /** Stops the running cell: cancels the basalt script, or raises KeyboardInterrupt in Python. */
  interrupt(): void;
  tables(): Promise<Namespace>;
  /** Run a script outside any cell (SHOW TABLES, DESCRIBE) and get its last result. */
  inspect(script: string): Promise<Inspection>;
  /** What Tab offers at UTF-16 offset `pos`; waits behind a running cell. */
  complete(lang: CodeLang, source: string, pos: number): Promise<Completion>;
  /** A cell was deleted: its table leaves the namespace. */
  forget(name: string): Promise<void>;
  /** A cell was renamed: its table in the namespace follows. */
  rename(from: string, to: string): Promise<void>;
  /** The rows of a result matching a search (web/src/lib/search.ts), over the whole
   *  table: the first of them as Arrow IPC, and how many there are. */
  filter(name: string, terms: unknown[]): Promise<{ rows: number; of: number; truncated: boolean; columns: Column[]; arrow: Uint8Array }>;
  /** Every problem in a SQL script, without running it: against the session,
   *  with `known` as tables other cells will make (checked by name). */
  check(source: string, known: string[]): Promise<Diagnostic[]>;
  /** A cell's result in full, as a file: Parquet or CSV bytes, in chunks.
   *  Throws before the first chunk when there is no such result. */
  export(name: string, format: ExportFormat): Promise<AsyncIterable<Uint8Array>>;
  /** What the kernel's machine and processes use: Prometheus text exposition
   *  (node_cpu_seconds_total, node_memory_*_bytes, process_*), answered even
   *  while a cell runs. */
  metrics(): Promise<string>;
  /** Forget every table and declaration, keeping the process. */
  reset(): Promise<void>;
  /** A terminal in the kernel's sandbox: a shell with the session's environment. */
  shell(cols: number, rows: number, on: ShellEvents): Shell;
  close(): Promise<void>;
  readonly closed: Promise<void>;
  /** What the kernel reported at start: python, polars and basalt versions. */
  readonly info: Record<string, string>;
}

export interface ShellEvents {
  data(bytes: Uint8Array): void;
  /** the shell ended (exit, or the kernel went): its exit code, if known */
  exit(code: number | null): void;
}

export interface Shell {
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/** A notebook's sandbox (notebook.json `sandbox`): used by the microVM runner. */
export type ExportFormat = "parquet" | "csv";

export interface Sandbox {
  vcpus?: number;
  /** MiB */
  memory?: number;
  /** `host:port` the VM may reach over TCP; none means no network at all. */
  egress?: string[];
}

/** A built environment's Python packages (environments.ts): the folder for a local kernel, the disk for a microVM. */
export interface PackageSet {
  dir: string;
  image: string;
}

export interface OpenOptions {
  notebookDir: string;
  env?: Record<string, string>;
  sandbox?: Sandbox;
  /** Python packages on top of the base image's: the notebook's shadow the workspace's */
  packages?: { workspace?: PackageSet | null; notebook?: PackageSet | null };
}

export interface Runner {
  open(opts: OpenOptions): Promise<Session>;
}
