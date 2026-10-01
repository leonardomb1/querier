#!/usr/bin/env python3
"""querier kernel: runs basalt SQL and Python cells against one shared namespace.

Every DataFrame in the namespace is a table. A SQL cell may read any of them by
name (`FROM sales`), and a cell's result is bound under the cell's own name.
Tables cross into basalt as Arrow IPC files, exported lazily when a SQL cell
names them. SQL runs in one long-lived `basalt kernel`, so a CREATE CONNECTION,
PARAM or LET in one cell is visible to every later one.

The host speaks framed messages over a byte stream — stdin/stdout here, vsock
inside a microVM:

    frame = u32be json_len | json | u32be bin_len | bin
"""

import ast
import io
import json
import linecache
import os
import queue
import re
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import traceback

os.environ.setdefault("MPLBACKEND", "Agg")

import polars as pl  # noqa: E402

# A printed DataFrame (print(df)), readable by whoever reads it, a person or an AI client: a
# markdown table, a row a line (nothing wrapped inside its cells), more of its columns and text
# shown than polars' terminal defaults. A cell can still change any of it with pl.Config.
pl.Config.set_tbl_formatting("ASCII_MARKDOWN")
pl.Config.set_tbl_width_chars(1000)
pl.Config.set_tbl_cols(20)
pl.Config.set_tbl_rows(25)
pl.Config.set_fmt_str_lengths(60)

from sqlrefs import apply_edits, map_col, rewrite_refs  # noqa: E402

PREVIEW_ROWS = 5000  # rows of a table sent to the host
MAX_ROWS = int(os.environ.get("QUERIER_MAX_ROWS", 1_000_000))  # a SQL result is cut here
CHUNK = 4 << 20  # bytes per frame when a file travels to the host
OUTPUT = "output"  # the notebook folder cells may write to; everything else is read-only
OUTPUT_MAX = int(os.environ.get("QUERIER_OUTPUT_MAX", 2 << 30))  # a larger file stays in the sandbox


# --- wire -------------------------------------------------------------------


class Wire:
    def __init__(self, rfile, wfile):
        self.r, self.w = rfile, wfile
        self.lock = threading.Lock()

    def _exact(self, n):
        buf = bytearray()
        while len(buf) < n:
            chunk = self.r.read(n - len(buf))
            if not chunk:
                raise EOFError
            buf += chunk
        return bytes(buf)

    def read(self):
        (n,) = struct.unpack(">I", self._exact(4))
        meta = json.loads(self._exact(n))
        (m,) = struct.unpack(">I", self._exact(4))
        return meta, self._exact(m) if m else b""

    def send(self, meta, data=b""):
        head = json.dumps(meta, default=str).encode()
        with self.lock:
            self.w.write(struct.pack(">I", len(head)) + head + struct.pack(">I", len(data)))
            self.w.write(data)
            self.w.flush()


# --- terminals --------------------------------------------------------------


class Shells:
    """Terminals in the sandbox (the host allows them only in a microVM): a shell in
    a pseudo-terminal each, with the session's environment and the notebook as its
    folder. Handled beside the job queue, so a running cell never holds one up."""

    def __init__(self, wire, cwd):
        self.wire, self.cwd = wire, cwd
        self.open_ = {}  # id -> (pid, fd)

    def handle(self, meta, data):
        op, sid = meta["op"], meta.get("shell")
        if op == "shell_open":
            # a terminal that can't open says why; the kernel goes on
            try:
                self.start(sid, meta.get("cols") or 80, meta.get("rows") or 24)
            except Exception as e:
                self.wire.send({"type": "shell_output", "shell": sid}, f"The terminal couldn't start: {e}\r\n".encode())
                self.wire.send({"type": "shell_exit", "shell": sid, "code": None})
        elif sid in self.open_:
            pid, fd = self.open_[sid]
            try:
                if op == "shell_input":
                    os.write(fd, data)
                elif op == "shell_resize":
                    self.resize(fd, meta.get("cols") or 80, meta.get("rows") or 24)
                elif op == "shell_close":
                    os.kill(pid, signal.SIGHUP)
            except OSError:
                pass

    @staticmethod
    def resize(fd, cols, rows):
        import fcntl
        import termios

        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", int(rows), int(cols), 0, 0))

    def start(self, sid, cols, rows):
        import pty

        shell = "/bin/bash" if os.path.exists("/bin/bash") else "/bin/sh"
        pid, fd = pty.fork()
        if pid == 0:
            try:
                os.chdir(self.cwd)
                env = {**os.environ, "TERM": "xterm-256color", "SHELL": shell, "PS1": r"\[\e[32m\]sandbox\[\e[0m\]:\[\e[34m\]\w\[\e[0m\]\$ "}
                os.execve(shell, [shell, "--norc", "--noprofile"] if shell.endswith("bash") else [shell], env)
            finally:
                os._exit(127)
        self.resize(fd, cols, rows)
        self.open_[sid] = (pid, fd)
        threading.Thread(target=self.pump, args=(sid, pid, fd), daemon=True).start()

    def pump(self, sid, pid, fd):
        try:
            while True:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                self.wire.send({"type": "shell_output", "shell": sid}, chunk)
        finally:
            self.open_.pop(sid, None)
            try:
                os.close(fd)
            except OSError:
                pass
            try:
                _, status = os.waitpid(pid, 0)
                code = os.waitstatus_to_exitcode(status)
            except ChildProcessError:
                code = None
            self.wire.send({"type": "shell_exit", "shell": sid, "code": code})


# --- metrics ----------------------------------------------------------------


def metrics_text(basalt_pid=None):
    """What this machine and the kernel's processes use, in Prometheus's text
    exposition format with node_exporter's names: the host scrapes it. Inside a
    microVM the machine is the VM; run locally, it is the host's."""
    tck = os.sysconf("SC_CLK_TCK")
    page = os.sysconf("SC_PAGE_SIZE")
    lines = []

    def metric(name, kind, help_, samples):
        lines.append(f"# HELP {name} {help_}")
        lines.append(f"# TYPE {name} {kind}")
        for labels, value in samples:
            lab = ",".join(f'{k}="{v}"' for k, v in labels.items())
            lines.append(f"{name}{{{lab}}} {value}" if lab else f"{name} {value}")

    modes = ("user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal")
    cpu = []
    with open("/proc/stat") as f:
        for line in f:
            if line.startswith("cpu") and line[3:4].isdigit():
                parts = line.split()
                cpu += [({"cpu": parts[0][3:], "mode": m}, int(v) / tck) for m, v in zip(modes, parts[1:9])]
    metric("node_cpu_seconds_total", "counter", "Seconds the CPUs spent in each mode.", cpu)

    mem = {}
    with open("/proc/meminfo") as f:
        for line in f:
            key, _, rest = line.partition(":")
            mem[key] = int(rest.split()[0]) * 1024
    for key in ("MemTotal", "MemAvailable", "MemFree", "Buffers", "Cached"):
        metric(f"node_memory_{key}_bytes", "gauge", f"{key} in /proc/meminfo.", [({}, mem.get(key, 0))])

    cpu_p, rss = [], []
    for name, pid in (("kernel", os.getpid()), ("basalt", basalt_pid)):
        if not pid:
            continue
        try:
            with open(f"/proc/{pid}/stat") as f:
                fields = f.read().rsplit(")", 1)[1].split()
            cpu_p.append(({"process": name}, (int(fields[11]) + int(fields[12])) / tck))
            rss.append(({"process": name}, int(fields[21]) * page))
        except (OSError, IndexError, ValueError):
            pass
    metric("process_cpu_seconds_total", "counter", "CPU time of the kernel's processes.", cpu_p)
    metric("process_resident_memory_bytes", "gauge", "Resident memory of the kernel's processes.", rss)
    return "\n".join(lines) + "\n"


# --- tables -----------------------------------------------------------------


def short_type(dtype):
    """A polars dtype as a short label: Int64 → int64, Datetime(...) → datetime."""
    return str(dtype).split("(")[0].lower()


def search_expr(df, terms):
    """A search's terms as one polars filter; the rules of web/src/lib/search.ts."""
    searchable = [c for c, t in df.schema.items() if not t.is_nested()]
    numeric = {c for c, t in df.schema.items() if t.is_numeric()}
    text = lambda c: pl.col(c).cast(pl.String).str.to_lowercase()
    exprs = []
    for t in terms:
        cols = [t["col"]] if t.get("col") in df.columns else searchable
        want, op = str(t.get("value", "")), t.get("op", "has")
        low = want.lower()
        if op == "has":
            e = pl.any_horizontal([text(c).str.contains(low, literal=True).fill_null(False) for c in cols])
        elif op in ("=", "!="):
            eq = pl.any_horizontal([(text(c) == low).fill_null(False) for c in cols])
            e = eq if op == "=" else ~eq
        else:
            parts = []
            for c in cols:
                try:
                    lhs, rhs = (pl.col(c), float(want.replace(",", ""))) if c in numeric else (text(c), low)
                except ValueError:
                    lhs, rhs = text(c), low
                cmp = {">": lhs > rhs, ">=": lhs >= rhs, "<": lhs < rhs, "<=": lhs <= rhs}[op]
                parts.append(cmp.fill_null(False))
            e = pl.any_horizontal(parts) if parts else pl.lit(False)
        exprs.append(~e if t.get("not") else e)
    return pl.all_horizontal(exprs) if exprs else pl.lit(True)


PROFILE_BINS = 10
PROFILE_COLUMNS = 500


def column_profile(s, dtype):
    """One column's profile (web/src/lib/profile.ts): min and max as text, as the table shows them."""
    n, nulls = s.len(), s.null_count()
    p = {"rows": n, "nulls": nulls}
    if dtype.is_nested():
        return p
    vals = s.drop_nulls()
    p["distinct"] = vals.n_unique()
    if not len(vals):
        return p
    numeric = dtype.is_numeric() and dtype != pl.Boolean
    temporal = dtype.is_temporal()
    if numeric or temporal:
        x = vals.to_physical().cast(pl.Float64)
        lo, hi = x.min(), x.max()
        if hi > lo:
            idx = ((x - lo) / (hi - lo) * PROFILE_BINS).floor().clip(0, PROFILE_BINS - 1).cast(pl.Int32)
            counts = idx.value_counts()
            hist = [0] * PROFILE_BINS
            for i, k in zip(counts[idx.name].to_list(), counts["count"].to_list()):
                hist[i] = k
        else:
            hist = [len(x)]
        p["hist"] = hist
        p["min"], p["max"] = str(vals.min()), str(vals.max())
        if numeric:
            p["mean"], p["sum"] = float(vals.mean()), float(vals.sum())
    else:
        top = vals.cast(pl.String).value_counts(sort=True).head(3)
        p["top"] = [{"value": v, "count": k} for v, k in zip(top[top.columns[0]].to_list(), top["count"].to_list())]
    return p


def basalt_type(dtype):
    """A polars dtype as a type basalt's check takes (what a PARAM takes), or None."""
    if dtype == pl.Boolean:
        return "bool"
    if dtype.is_integer():
        return "int"
    if dtype.is_float():
        return "float"
    if isinstance(dtype, pl.Decimal):
        return f"decimal({dtype.precision or 38},{dtype.scale or 0})"
    if dtype in (pl.String, pl.Categorical, pl.Enum) or isinstance(dtype, (pl.Categorical, pl.Enum)):
        return "string"
    if dtype == pl.Date:
        return "date"
    if isinstance(dtype, pl.Datetime):
        return "timestamp"
    if dtype == pl.Time:
        return "time"
    if dtype == pl.Binary:
        return "bytes"
    return None


def signature_of(fn):
    import inspect

    try:
        sig = str(inspect.signature(fn))
    except (TypeError, ValueError):
        return "function"
    return sig if len(sig) <= 60 else sig[:57] + "…)"


def vegalite_spec(value):
    """An Altair chart (polars' df.plot makes one) as its Vega-Lite spec, which
    the browser draws itself; Altair's own HTML would fetch scripts from a CDN."""
    if not type(value).__module__.startswith("altair") or not hasattr(value, "to_dict"):
        return None
    import altair as alt

    # a notebook's tables are routinely past Altair's 5,000-row guard
    alt.data_transformers.disable_max_rows()
    return value.to_dict()


def to_polars(value):
    """A DataFrame-like value as a polars DataFrame, or None."""
    if isinstance(value, pl.DataFrame):
        return value
    if isinstance(value, pl.LazyFrame):
        return value.collect()
    if type(value).__module__.startswith("pandas") and type(value).__name__ == "DataFrame":
        return pl.from_pandas(value)
    return None


# --- basalt -----------------------------------------------------------------


class BasaltKernel:
    """One `basalt kernel` process: NDJSON requests in; JSON header lines out,
    a `data` header followed by `len` raw bytes. Its stderr (logs, PRINT) is
    handed to `on_log` line by line."""

    def __init__(self, binary, cwd, on_log):
        self.proc = subprocess.Popen(
            [binary, "kernel", "--format", "arrow"],
            cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.lock = threading.Lock()
        self.logs = queue.Queue()
        self.tail = []
        threading.Thread(target=self._stderr, args=(on_log,), daemon=True).start()

    def _stderr(self, on_log):
        for raw in self.proc.stderr:
            line = raw.decode(errors="replace")
            self.tail = (self.tail + [line])[-5:]
            on_log(line)
            self.logs.put(None)

    def send(self, obj):
        with self.lock:
            self.proc.stdin.write((json.dumps(obj) + "\n").encode())
            self.proc.stdin.flush()

    def request(self, obj):
        """Yields (header, data) up to and including the request's status."""
        self.send(obj)
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise EOFError("".join(self.tail).strip() or f"exit code {self.proc.wait()}")
            head = json.loads(line)
            data = self.proc.stdout.read(head["len"]) if head["type"] == "data" else b""
            yield head, data
            if head["type"] == "status":
                self.settle()
                return

    def settle(self, quiet=0.01):
        """Let log lines written just before the status reach on_log first."""
        try:
            while True:
                self.logs.get(timeout=quiet)
        except queue.Empty:
            pass

    def alive(self):
        return self.proc.poll() is None

    def close(self):
        if self.alive():
            try:
                self.send({"op": "close"})
                self.proc.wait(timeout=3)
            except Exception:
                self.proc.kill()


# --- kernel -------------------------------------------------------------------


class Interrupted(Exception):
    pass


class Capture(io.TextIOBase):
    def __init__(self, kernel, stream):
        self.k, self.stream, self.buf = kernel, stream, ""

    def writable(self):
        return True

    def write(self, s):
        self.buf += s
        if "\n" in s or len(self.buf) > 8192:
            self.flush()
        return len(s)

    def flush(self):
        if self.buf:
            self.k.emit({"type": "stream", "stream": self.stream, "text": self.buf})
            self.buf = ""


class Kernel:
    def __init__(self, wire, work, cwd, basalt, sync_output=False):
        self.wire, self.work, self.cwd, self.basalt_bin = wire, work, cwd, basalt
        # in a microVM the notebook is a throwaway copy: what cells write to output/
        # is sent to the host after each run. A local kernel writes the real folder.
        self.sync_output = sync_output
        if sync_output:  # the host makes the real one; the sandbox's copy may predate it
            os.makedirs(os.path.join(cwd, OUTPUT), exist_ok=True)
        self.output_seen = self.output_files()
        self.tables_dir = os.path.join(work, "tables")
        os.makedirs(self.tables_dir, exist_ok=True)
        self.jobs = queue.Queue()
        self.rid = None
        self.bk = None  # the basalt kernel, started on the first SQL cell
        self.sql_rid = None  # the basalt request in flight, for cancel
        self.in_python = False
        self.main_thread = threading.main_thread().ident
        self.shells = Shells(wire, cwd)
        self.reset_state()

    def reset_state(self):
        self.declared = {}  # basalt session declarations: (kind, name) -> True, in order
        self.exported = {}  # name -> the DataFrame object last written to its Arrow file
        self.ns = {"__name__": "__main__", "pl": pl, "display": self.display, "params": {}}

    # -- plumbing

    def emit(self, meta, data=b""):
        self.wire.send({"id": self.rid, **meta}, data)

    def emit_table(self, name, df, capped=False):
        preview = df.head(PREVIEW_ROWS)
        buf = io.BytesIO()
        preview.write_ipc_stream(buf, compat_level=pl.CompatLevel.oldest())
        self.emit(
            {
                "type": "table",
                "name": name,
                "rows": df.height,
                "truncated": df.height > preview.height,
                "capped": capped,
                "columns": [{"name": c, "type": str(t)} for c, t in df.schema.items()],
            },
            buf.getvalue(),
        )

    def emit_value(self, value, name=None):
        if value is None:
            return
        df = to_polars(value)
        if df is not None:
            if name:
                self.ns[name] = df
            self.emit_table(name, df)
        elif (spec := vegalite_spec(value)) is not None:
            self.emit({"type": "display", "mime": "application/vnd.vegalite+json"}, json.dumps(spec, default=str).encode())
        elif hasattr(value, "_repr_html_"):
            self.emit({"type": "display", "mime": "text/html"}, value._repr_html_().encode())
        elif not type(value).__module__.startswith("matplotlib"):
            self.emit({"type": "display", "mime": "text/plain"}, repr(value).encode())

    def display(self, *values):
        for v in values:
            self.emit_value(v)

    def flush_figures(self):
        plt = sys.modules.get("matplotlib.pyplot")
        if not plt:
            return
        for num in plt.get_fignums():
            buf = io.BytesIO()
            plt.figure(num).savefig(buf, format="png", bbox_inches="tight", dpi=110)
            self.emit({"type": "display", "mime": "image/png"}, buf.getvalue())
        plt.close("all")

    def table(self, name):
        return to_polars(self.ns.get(name)) if name in self.ns else None

    def table_path(self, name):
        df = self.table(name)
        path = os.path.join(self.tables_dir, name + ".arrow")
        if self.exported.get(name) is not df:
            df.write_ipc(path)
            self.exported[name] = df
        return path

    def basalt(self):
        if self.bk is None or not self.bk.alive():
            if self.bk is not None:
                self.emit({"type": "stream", "stream": "stderr",
                           "text": "basalt restarted: declarations from earlier cells are gone\n"})
            log = lambda line: self.emit({"type": "stream", "stream": "stderr", "text": line})
            self.bk = BasaltKernel(self.basalt_bin, self.cwd, log)
        return self.bk

    # -- cells

    def run_sql(self, name, source, params):
        edits = rewrite_refs(source, lambda n: self.table(n) is not None)
        script, applied = apply_edits(source, edits, self.table_path)
        bk = self.basalt()
        self.sql_rid = str(self.rid)
        results, buf, status = [], bytearray(), {}
        try:
            req = {"op": "run", "id": self.sql_rid, "script": script, "params": params, "max_rows": MAX_ROWS}
            for head, data in bk.request(req):
                kind = head["type"]
                if kind == "data":
                    buf += data
                elif kind == "result":
                    results.append((head, pl.read_ipc_stream(io.BytesIO(bytes(buf)))))
                    buf.clear()
                elif kind == "progress":
                    keep = ("type", "target", "rows", "rows_per_sec", "elapsed_ms", "loop_done", "loop_total")
                    self.emit({k: head[k] for k in keep if k in head})
                elif kind == "load":
                    load = {k: v for k, v in head.items() if k not in ("id", "col", "line")}
                    if "line" in head:
                        load.update(line=head["line"], col=map_col(applied, head["line"], head.get("col", 1)))
                    self.emit(load)
                elif kind == "status":
                    status = head
        except EOFError as e:
            self.emit({"type": "error", "message": f"basalt kernel exited: {e}"})
            return False
        finally:
            self.sql_rid = None
        for d in status.get("declared") or []:
            self.declared[(d["kind"], d["name"])] = True

        last_select = max((i for i, (h, _) in enumerate(results) if h["kind"] == "select"), default=None)
        for i, (head, df) in enumerate(results):
            if head["kind"] == "explain":
                self.emit({"type": "display", "mime": "text/plain"}, "\n".join(df["plan"]).encode())
            elif i == last_select:
                self.ns[name] = df
                self.emit_table(name, df, capped=head["truncated"])
            else:
                self.emit_table(None, df, capped=head["truncated"])

        if status.get("loads"):
            keep = ("loads_ok", "loads_failed", "rows_read", "rows_loaded", "lanes", "elapsed_ms")
            self.emit({"type": "loads", **{k: status[k] for k in keep if k in status}})

        if status.get("cancelled"):
            raise Interrupted
        if err := status.get("error"):
            msg = {"type": "error", "message": err["msg"], "transient": err.get("transient", False)}
            # a failed load already says why on its own line; the error only places it
            if any(not l["ok"] and l.get("reason") == err["msg"] for l in status.get("loads") or []):
                msg["shown"] = True
            if err.get("file") == "script" and "line" in err:
                msg.update(line=err["line"], col=map_col(applied, err["line"], err.get("col", 1)))
                if "end_line" in err and err["end_line"] == err["line"]:
                    msg["end_col"] = map_col(applied, err["line"], err["end_col"])
            elif err.get("file") == "session":
                msg["message"] = f"in a declaration from an earlier cell: {err['msg']}"
            elif err.get("file"):
                msg["message"] = f"{err['file']}:{err.get('line', '?')}: {err['msg']}"
            self.emit(msg)
            return False
        return True

    def run_python(self, name, source, params):
        fname = f"<cell {name}>"
        linecache.cache[fname] = (len(source), None, source.splitlines(True), fname)
        self.ns["params"] = dict(params)
        try:
            tree = ast.parse(source, filename=fname)
        except SyntaxError as e:
            self.emit({"type": "error", "message": f"SyntaxError: {e.msg}", "line": e.lineno, "col": e.offset})
            return False
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        out, err = Capture(self, "stdout"), Capture(self, "stderr")
        sys.stdout, sys.stderr = out, err
        self.in_python = True
        try:
            exec(compile(tree, fname, "exec"), self.ns)
            value = eval(compile(last, fname, "eval"), self.ns) if last else None
        except KeyboardInterrupt:
            raise Interrupted
        except BaseException as e:
            self.in_python = False
            out.flush()
            err.flush()
            frames = [f for f in traceback.extract_tb(e.__traceback__) if f.filename == fname]
            tb = traceback.TracebackException.from_exception(e)
            tb.stack = traceback.StackSummary.from_list(frames)
            msg = {"type": "error", "message": f"{type(e).__name__}: {e}", "traceback": "".join(tb.format())}
            if frames:
                msg["line"] = frames[-1].lineno
            self.emit(msg)
            return False
        finally:
            self.in_python = False
            sys.stdout, sys.stderr = sys.__stdout__, sys.__stderr__
        out.flush()
        err.flush()
        self.flush_figures()
        self.emit_value(value, name)
        return True

    def run(self, meta):
        cell, params = meta["cell"], {k: str(v) for k, v in (meta.get("params") or {}).items()}
        t0 = time.monotonic()
        ok = False
        try:
            run = self.run_sql if cell["lang"] == "sql" else self.run_python
            ok = run(cell["name"], cell["source"], params)
        except (Interrupted, KeyboardInterrupt):
            self.emit({"type": "error", "message": "interrupted"})
        except Exception as e:
            self.emit({"type": "error", "message": f"kernel: {type(e).__name__}: {e}", "traceback": traceback.format_exc()})
        self.send_output()
        self.emit({"type": "done", "ok": ok, "ms": round((time.monotonic() - t0) * 1000)})

    # -- files

    def send_file(self, path, meta):
        """A file to the host, in chunks: each frame says where its bytes go."""
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            offset = 0
            while True:
                data = f.read(CHUNK)
                self.emit({**meta, "offset": offset, "size": size}, data)
                offset += len(data)
                if offset >= size:
                    break

    def output_files(self):
        """output/, as relative path -> (size, mtime): regular files only, no links."""
        root = os.path.join(self.cwd, OUTPUT)
        out = {}
        for d, dirs, files in os.walk(root):
            dirs[:] = [x for x in dirs if not os.path.islink(os.path.join(d, x))]
            for name in files:
                p = os.path.join(d, name)
                if os.path.islink(p) or not os.path.isfile(p):
                    continue
                st = os.stat(p)
                out[os.path.relpath(p, root)] = (st.st_size, st.st_mtime_ns)
        return out

    def send_output(self):
        """What cells added, changed or deleted in output/ since the last look."""
        if not self.sync_output:
            return
        now = self.output_files()
        for rel, stamp in now.items():
            if self.output_seen.get(rel) == stamp:
                continue
            if stamp[0] > OUTPUT_MAX:
                self.emit({"type": "stream", "stream": "stderr",
                           "text": f"{OUTPUT}/{rel} is over {OUTPUT_MAX >> 20} MB: not saved\n"})
                continue
            self.send_file(os.path.join(self.cwd, OUTPUT, rel), {"type": "file", "path": rel})
        for rel in self.output_seen.keys() - now.keys():
            self.emit({"type": "file_removed", "path": rel})
        self.output_seen = now

    def export(self, meta):
        """A table in full, as a Parquet or CSV file streamed to the host."""
        name, fmt = meta["name"], meta.get("format", "parquet")
        df = self.table(name)
        path = os.path.join(self.work, f"export-{self.rid}.{fmt}")
        try:
            if df is None:
                raise LookupError(f"`{name}` has no result in the kernel: run it first")
            if fmt == "parquet":
                df.write_parquet(path)
            elif fmt == "csv":
                df.write_csv(path)
            else:
                raise ValueError(f"can't export as {fmt}")
            self.send_file(path, {"type": "chunk"})
            self.emit({"type": "exported", "ok": True, "rows": df.height})
        except Exception as e:
            self.emit({"type": "error", "message": str(e)})
            self.emit({"type": "exported", "ok": False})
        finally:
            if os.path.exists(path):
                os.remove(path)

    def list_tables(self):
        tables = []
        for name, value in self.ns.items():
            if isinstance(value, pl.DataFrame) and not name.startswith("_"):
                cols = [{"name": c, "type": str(t)} for c, t in value.schema.items()]
                tables.append({"name": name, "rows": value.height, "columns": cols})
        declared = [{"kind": k, "name": n} for k, n in self.declared]
        self.emit({"type": "tables", "tables": tables, "declared": declared})

    def inspect(self, meta):
        """Run a script outside any cell and answer its last result as rows:
        what the sidebar asks (SHOW TABLES FROM erp, DESCRIBE 'x.csv')."""
        out = {"type": "inspect", "columns": [], "rows": []}
        try:
            edits = rewrite_refs(meta["script"], lambda n: self.table(n) is not None)
            script, _ = apply_edits(meta["script"], edits, self.table_path)
            req = {"op": "run", "id": str(self.rid), "script": script, "max_rows": meta.get("max_rows", 500)}
            buf, last, status = bytearray(), None, {}
            for head, data in self.basalt().request(req):
                if head["type"] == "data":
                    buf += data
                elif head["type"] == "result":
                    last = bytes(buf)
                    buf.clear()
                elif head["type"] == "status":
                    status = head
            if err := status.get("error"):
                out["error"] = err["msg"]
            elif last is not None:
                df = pl.read_ipc_stream(io.BytesIO(last))
                out["columns"] = df.columns
                out["rows"] = [[None if v is None else v if isinstance(v, (int, float, bool)) else str(v) for v in r]
                               for r in df.rows()]
        except EOFError as e:
            out["error"] = f"basalt kernel exited: {e}"
        self.emit(out)

    def filter(self, meta):
        """The rows of a result that match a search (web/src/lib/search.ts, same
        rules), over the whole table rather than the preview the page holds."""
        name = meta["name"]
        df = self.table(name)
        if df is None:
            self.emit({"type": "error", "message": f"`{name}` has no result in the kernel: run it first"})
            self.emit({"type": "filtered", "rows": 0, "columns": [], "truncated": False})
            return
        try:
            hits = df.filter(search_expr(df, meta.get("terms") or []))
        except Exception as e:
            self.emit({"type": "error", "message": f"search: {e}"})
            self.emit({"type": "filtered", "rows": 0, "columns": [], "truncated": False})
            return
        preview = hits.head(PREVIEW_ROWS)
        buf = io.BytesIO()
        preview.write_ipc_stream(buf, compat_level=pl.CompatLevel.oldest())
        self.emit(
            {"type": "filtered", "rows": hits.height, "of": df.height, "truncated": hits.height > preview.height,
             "columns": [{"name": c, "type": str(t)} for c, t in hits.schema.items()]},
            buf.getvalue(),
        )

    def profile(self, meta):
        """Each column of a whole result, for the table's profile and hover card
        (web/src/lib/profile.ts, the same shape): how full, how many distinct, and
        by type a histogram with its range, mean and sum, or the most frequent values."""
        name = meta["name"]
        df = self.table(name)
        if df is None:
            self.emit({"type": "error", "message": f"`{name}` has no result in the kernel: run it first"})
            self.emit({"type": "profile", "rows": 0, "columns": {}})
            return
        out = {}
        for c, t in list(df.schema.items())[:PROFILE_COLUMNS]:
            try:
                out[c] = column_profile(df[c], t)
            except Exception as e:  # a column it can't profile: left out, the others still come
                out[c] = {"rows": df.height, "nulls": df[c].null_count(), "error": str(e)}
        self.emit({"type": "profile", "rows": df.height, "columns": out})

    def check(self, meta):
        """Every problem in a SQL cell, without running it: against the session's
        connections, params and LETs, and the notebook's tables — typed for the
        ones this kernel holds, by name for `known` ones not computed yet."""
        tables = []
        for n in self.ns:
            df = self.table(n) if not n.startswith("_") else None
            if df is None:
                continue
            cols = [{"name": c, "type": t} for c, dt in df.schema.items() if (t := basalt_type(dt))]
            # a column basalt has no type for: the table is checked by name, columns unknown
            tables.append({"name": n, "columns": cols} if len(cols) == df.width else n)
        held = {t if isinstance(t, str) else t["name"] for t in tables}
        tables += [n for n in meta.get("known") or [] if n not in held]
        status = {}
        try:
            req = {"op": "check", "id": str(self.rid), "script": meta["source"], "tables": tables}
            for head, _ in self.basalt().request(req):
                status = head
        except EOFError as e:
            self.emit({"type": "error", "message": f"basalt: {e}"})
        self.emit({"type": "checked", "diagnostics": status.get("diagnostics") or []})

    def complete(self, meta):
        """Completions at UTF-16 offset `pos`, as {text, kind, detail}: basalt's own
        for SQL plus the columns of notebook tables the query reads; the
        namespace for Python, and column names inside col("…") / df["…"]."""
        source, pos = meta["source"], meta["pos"]
        before = source.encode("utf-16-le")[: pos * 2].decode("utf-16-le")
        if meta["lang"] == "sql":
            got = self.complete_sql(source, pos, before)
        else:
            got = self.complete_python(before, pos)
        # one item per text; a keyword gives way to anything more specific
        seen = {}
        for item in got["items"]:
            prev = seen.get(item["text"])
            if prev is None or (prev["kind"] == "keyword" and item["kind"] != "keyword"):
                seen[item["text"]] = item
        got["items"] = list(seen.values())
        self.emit({"type": "complete", **got})

    def frame_detail(self, df):
        return f"{df.height:,} × {df.width}"

    def complete_sql(self, source, pos, before):
        status = {}
        try:
            req = {"op": "complete", "id": str(self.rid), "script": source, "pos": pos, "utf16": True}
            for head, _ in self.basalt().request(req):
                status = head
        except EOFError:
            pass
        got = status.get("complete") or {"start": pos, "end": pos, "items": []}
        prefix = source.encode("utf-16-le")[got["start"] * 2 : pos * 2].decode("utf-16-le").lower()
        tables = {n: self.table(n) for n in self.ns if not n.startswith("_") and self.table(n) is not None}
        items = got["items"]
        for item in items:
            if item["kind"] == "table" and item["text"] in tables:
                item["detail"] = self.frame_detail(tables[item["text"]])
        items += [{"text": n, "kind": "table", "detail": self.frame_detail(df)}
                  for n, df in tables.items() if n.lower().startswith(prefix)]
        # columns of the notebook tables this script reads
        read = {name for _, _, name in rewrite_refs(source, lambda n: n in tables)}
        for n in read:
            for col, dtype in tables[n].schema.items():
                if col.lower().startswith(prefix):
                    items.append({"text": col, "kind": "column", "detail": f"{short_type(dtype)} · {n}"})
        got["items"] = items
        return got

    def complete_python(self, before, pos):
        import rlcompleter

        # inside col("…") or df["…"]: column names of every table
        if m := re.search(r"""(?:\bcol\(\s*|\[\s*)(["'])([^"']*)$""", before):
            typed = m.group(2)
            items = []
            for n in self.ns:
                df = self.table(n) if not n.startswith("_") else None
                if df is None:
                    continue
                for col, dtype in df.schema.items():
                    if col.startswith(typed):
                        items.append({"text": col, "kind": "column", "detail": f"{short_type(dtype)} · {n}"})
            return {"start": pos - len(typed.encode("utf-16-le")) // 2, "end": pos, "items": items}

        word = re.search(r"[\w.]*$", before).group(0)
        c = rlcompleter.Completer(self.ns)
        items, i = [], 0
        while (m := c.complete(word, i)) is not None and i < 200:
            i += 1
            text = m.rstrip("(")
            items.append({"text": text.rsplit(".", 1)[-1], "kind": "", "detail": ""})
            try:
                obj = eval(text, self.ns) if "." in text else self.ns.get(text, getattr(__builtins__, text, None))
            except Exception:
                obj = None
            item = items[-1]
            df = to_polars(obj) if obj is not None and not callable(obj) else None
            if df is not None:
                item["kind"], item["detail"] = "table", f"{type(obj).__name__} {self.frame_detail(df)}"
            elif isinstance(obj, type):
                item["kind"], item["detail"] = "class", "class"
            elif type(obj).__name__ == "module":
                item["kind"], item["detail"] = "module", "module"
            elif callable(obj):
                item["kind"] = "method" if "." in text else "function"
                item["detail"] = signature_of(obj)
            else:
                item["kind"], item["detail"] = "variable", type(obj).__name__ if obj is not None else ""
        start = pos - len(word.rsplit(".", 1)[-1].encode("utf-16-le")) // 2
        return {"start": start, "end": pos, "items": items}

    def forget(self, name):
        """A cell was deleted: its result leaves the namespace."""
        self.ns.pop(name, None)
        self.exported.pop(name, None)
        self.emit({"type": "forgot"})

    def rename(self, old, new):
        """A cell was renamed: its result moves to the new name."""
        if old in self.ns:
            self.ns[new] = self.ns.pop(old)
        if old in self.exported:
            self.exported[new] = self.exported.pop(old)
        self.emit({"type": "renamed"})

    def reset(self):
        self.reset_state()
        if self.bk is not None and self.bk.alive():
            for _ in self.bk.request({"op": "reset"}):
                pass
        self.emit({"type": "reset"})

    # -- loops

    def interrupt(self):
        if self.sql_rid is not None and self.bk is not None:
            self.bk.send({"op": "cancel", "id": self.sql_rid})
        elif self.in_python:
            # A real signal, aimed at the main thread: it also breaks a blocking
            # call (sleep, socket read), which interrupt_main's flag would not.
            signal.pthread_kill(self.main_thread, signal.SIGINT)

    def reader(self):
        try:
            while True:
                meta, data = self.wire.read()
                if meta["op"].startswith("shell_"):
                    self.shells.handle(meta, data)
                elif meta["op"] == "interrupt":
                    self.interrupt()
                elif meta["op"] == "metrics":
                    # answered here, not queued: a scrape must not wait behind a running cell
                    bk = self.bk.proc.pid if self.bk is not None and self.bk.alive() else None
                    try:
                        self.wire.send({"type": "metrics", "id": meta.get("id"), "text": metrics_text(bk)})
                    except Exception as e:
                        self.wire.send({"type": "metrics", "id": meta.get("id"), "text": "", "error": str(e)})
                else:
                    self.jobs.put(meta)
        except (EOFError, OSError):
            pass
        self.jobs.put({"op": "shutdown"})

    def serve(self):
        threading.Thread(target=self.reader, daemon=True).start()
        version = subprocess.run([self.basalt_bin, "version"], capture_output=True, text=True).stdout.split()[-1:]
        self.wire.send({"type": "ready", "python": sys.version.split()[0], "polars": pl.__version__,
                        "basalt": version[0] if version else None})
        try:
            while True:
                try:
                    meta = self.jobs.get()
                    op = meta["op"]
                    if op == "shutdown":
                        return
                    self.rid = meta.get("id")
                    if op == "run":
                        self.run(meta)
                    elif op == "tables":
                        self.list_tables()
                    elif op == "complete":
                        self.complete(meta)
                    elif op == "check":
                        self.check(meta)
                    elif op == "filter":
                        self.filter(meta)
                    elif op == "profile":
                        self.profile(meta)
                    elif op == "reset":
                        self.reset()
                    elif op == "inspect":
                        self.inspect(meta)
                    elif op == "rename":
                        self.rename(meta["from"], meta["to"])
                    elif op == "forget":
                        self.forget(meta["name"])
                    elif op == "export":
                        self.export(meta)
                    self.rid = None
                except KeyboardInterrupt:  # an interrupt that landed between cells
                    continue
        finally:
            if self.bk is not None:
                self.bk.close()


def main():
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True, help="scratch dir for tables exported to basalt")
    ap.add_argument("--cwd", required=True, help="notebook dir; relative paths in cells resolve here")
    ap.add_argument("--basalt", default=os.environ.get("BASALT_BIN", "basalt"))
    ap.add_argument("--vsock", type=int, help="connect to the host on this vsock port (inside a microVM)")
    ap.add_argument("--sync-output", action="store_true", help="send what cells write to output/ to the host")
    args = ap.parse_args()

    if args.vsock:
        # the microVM: dial the host over vsock (it listens before the VM boots); its
        # first frame is the session's environment (secrets travel here, never on a
        # disk) and the hosts the sandbox may reach
        deadline = time.monotonic() + 30
        while True:
            conn = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
            try:
                conn.connect((socket.VMADDR_CID_HOST, args.vsock))
                break
            except OSError:
                conn.close()
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.05)
        wire = Wire(conn.makefile("rb", buffering=0), conn.makefile("wb"))
        hello, _ = wire.read()
        os.environ.update({k: str(v) for k, v in (hello.get("env") or {}).items()})
        if hello.get("hosts"):
            with open("/etc/hosts", "a") as f:
                f.write("".join(f"{ip} {name}\n" for name, ip in hello["hosts"].items()))
        devnull = os.open(os.devnull, os.O_RDONLY)
        os.dup2(devnull, 0)
        sys.stdin = open(os.devnull)
    else:
        # a local process: the protocol owns the original stdin/stdout; cell code sees /dev/null and stderr
        proto_in = os.fdopen(os.dup(0), "rb", buffering=0)
        proto_out = os.fdopen(os.dup(1), "wb")
        devnull = os.open(os.devnull, os.O_RDONLY)
        os.dup2(devnull, 0)
        os.dup2(2, 1)
        sys.stdin = open(os.devnull)
        sys.stdout = sys.__stdout__ = os.fdopen(1, "w", buffering=1)
        wire = Wire(proto_in, proto_out)

    os.chdir(args.cwd)
    Kernel(wire, args.work, args.cwd, args.basalt, args.sync_output).serve()


if __name__ == "__main__":
    main()
