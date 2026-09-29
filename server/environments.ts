// Environments: the packages a workspace's notebooks get, as Fabric's. Python
// packages reach kernels (pyproject.toml + uv.lock); npm packages reach report
// templates (package.json + bun.lock). A workspace has one, and a notebook may
// add its own on top (its packages shadow the workspace's, which shadow the
// base image's: polars, altair, great_tables, matplotlib).
//
// The files live in the folders, so they travel with git. What is in force is
// what an Admin or Member last applied (environment.manage), kept here: a pull
// that changes the files shows as "changed since applied" and changes nothing
// until someone who may applies it. Packages are code that runs in everyone's
// kernel, and in reports run with their owner's connections.
//
// Applying locks (uv lock, bun install) and builds, on the server and never in
// a sandbox, into a cache keyed by the lock's hash: Python packages installed
// for the guest (Python 3.13, manylinux wheels only, no build scripts) and made
// a read-only disk the microVM mounts; npm packages installed with their
// install scripts off, for the template bundler to resolve from.

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./auth/config";
import { UserError } from "./store";

export type EnvKind = "python" | "js";

export interface Applied {
  /** the lock file's hash: where its build is */
  hash: string;
  dependencies: string[];
  at: number;
  by: string;
}

interface Row {
  applied?: Applied;
  status: "ready" | "building" | "failed";
  /** a failed build's output (its end) */
  log?: string;
  started?: number;
}

export interface EnvState {
  kind: EnvKind;
  /** what the folder's file declares */
  dependencies: string[];
  applied: Applied | null;
  status: "none" | "ready" | "building" | "failed";
  log?: string;
  /** the folder's files differ from what is in force (edited, pulled): applying them takes an Admin or Member */
  changed: boolean;
}

/** Where builds are kept: readable by the microVMs' user (public packages, no secrets). */
export const envsDir = () => process.env.QUERIER_ENVS ?? (process.env.QUERIER_RUNNER === "firecracker" ? "/var/lib/querier/envs" : join(configDir, "envs"));

const FILES: Record<EnvKind, [spec: string, lock: string]> = { python: ["pyproject.toml", "uv.lock"], js: ["package.json", "bun.lock"] };

// what a dependency may be: a name from the index, with a version constraint. No URLs, paths or git:
// what is installed is what the index serves under a name, and nothing a lock can't pin
const PY_DEP = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[[A-Za-z0-9._,-]+\])?(?:\s*(?:===|==|>=|<=|~=|!=|<|>)\s*[A-Za-z0-9.*+!_-]+(?:\s*,\s*(?:===|==|>=|<=|~=|!=|<|>)\s*[A-Za-z0-9.*+!_-]+)*)?$/;
const JS_DEP = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@(?:[\^~]?\d[\w.+-]*|[<>=]{1,2}\s*\d[\w.+-]*|\*|latest))?$/;

/** A dependency as typed, checked: `polars>=1.40`, `d3@^7`. */
export function checkDependency(kind: EnvKind, dep: string): string {
  const d = dep.trim();
  if (!(kind === "python" ? PY_DEP : JS_DEP).test(d))
    throw new UserError(
      kind === "python"
        ? `\`${d}\` isn't a package: a name from PyPI, and a version if you want one (pyarrow, pyarrow>=17, scikit-learn==1.5.2).`
        : `\`${d}\` isn't a package: a name from npm, and a version if you want one (d3, d3@^7, @observablehq/plot@0.6).`,
    );
  return d;
}

/** A JS dependency's name and range: `d3@^7` → ["d3", "^7"]; `@scope/x` → ["@scope/x", "*"]. */
const jsSplit = (d: string): [string, string] => {
  const at = d.indexOf("@", 1);
  return at < 0 ? [d, "latest"] : [d.slice(0, at), d.slice(at + 1)];
};

async function run(cmd: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => p.kill(), 15 * 60_000);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  const log = `${out}${err}`.trim();
  if (code !== 0) throw new Error(`${cmd.slice(0, 2).join(" ")} failed:\n${log.slice(-6000)}`);
  return log;
}

const sha = async (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 24);

export class Environments {
  private building = new Set<string>();

  constructor(
    private db: Database,
    private opts: {
      root?: string;
      /** for microVMs: the guest's Python (3.13, manylinux), made disk images; else the local kernels' interpreter */
      images: boolean;
      /** the local kernels' Python (not for microVMs) */
      python?: string;
      uv?: string;
      onApplied?: (target: string, kind: EnvKind) => void;
    },
  ) {}

  private get root() {
    return this.opts.root ?? envsDir();
  }
  private get uv() {
    return this.opts.uv ?? process.env.QUERIER_UV ?? Bun.which("uv") ?? "uv";
  }

  private row(target: string, kind: EnvKind): Row | null {
    const r = this.db.query("SELECT data FROM environments WHERE target = ? AND kind = ?").get(target, kind) as { data: string } | null;
    return r ? JSON.parse(r.data) : null;
  }
  private save(target: string, kind: EnvKind, row: Row | null) {
    if (!row) this.db.query("DELETE FROM environments WHERE target = ? AND kind = ?").run(target, kind);
    else this.db.query("INSERT INTO environments (target, kind, data) VALUES (?, ?, ?) ON CONFLICT(target, kind) DO UPDATE SET data = excluded.data").run(target, kind, JSON.stringify(row));
  }

  /** What the folder's file declares. */
  async declared(dir: string, kind: EnvKind): Promise<string[]> {
    const f = Bun.file(join(dir, FILES[kind][0]));
    if (!(await f.exists())) return [];
    try {
      if (kind === "python") return ((Bun.TOML.parse(await f.text()) as any)?.project?.dependencies ?? []).map(String);
      const deps = ((await f.json()) as any)?.dependencies ?? {};
      return Object.entries(deps).map(([n, v]) => (v === "latest" || v === "*" ? n : `${n}@${v}`));
    } catch {
      return [];
    }
  }

  async lockHash(dir: string, kind: EnvKind): Promise<string | null> {
    const f = Bun.file(join(dir, FILES[kind][1]));
    return (await f.exists()) ? sha(`${kind}:${await f.text()}`) : null;
  }

  async state(dir: string, target: string, kind: EnvKind): Promise<EnvState> {
    const row = this.row(target, kind);
    const dependencies = await this.declared(dir, kind);
    const lock = await this.lockHash(dir, kind);
    const applied = row?.applied ?? null;
    const changed = applied ? lock !== applied.hash : dependencies.length > 0 || lock != null;
    return { kind, dependencies, applied, status: row?.status === "building" ? "building" : row?.status === "failed" ? "failed" : applied ? "ready" : "none", log: row?.log, changed };
  }

  /** Lock `dependencies` into the folder's files and build them; in force once built. Runs on: the state says how it goes. */
  apply(dir: string, target: string, kind: EnvKind, dependencies: string[], by: string) {
    const key = `${target}\u0000${kind}`;
    if (this.building.has(key)) throw new UserError("It is being built already: wait for it to finish.");
    const deps = [...new Set(dependencies.map((d) => checkDependency(kind, d)))];
    const prev = this.row(target, kind);
    this.building.add(key);
    this.save(target, kind, { applied: prev?.applied, status: "building", started: Date.now() });
    (async () => {
      try {
        if (!deps.length) {
          // nothing: no environment, and no files for it
          for (const f of FILES[kind]) await rm(join(dir, f), { force: true });
          this.save(target, kind, null);
        } else {
          const hash = kind === "python" ? await this.buildPython(dir, deps) : await this.buildJs(dir, deps);
          this.save(target, kind, { applied: { hash, dependencies: deps, at: Date.now(), by }, status: "ready" });
        }
        this.opts.onApplied?.(target, kind);
      } catch (e: any) {
        this.save(target, kind, { applied: prev?.applied, status: "failed", log: String(e?.message ?? e).slice(-8000) });
      } finally {
        this.building.delete(key);
      }
    })();
  }

  // -- Python: pyproject.toml and uv.lock in the folder; the build a read-only disk for the guest

  private async buildPython(dir: string, deps: string[]): Promise<string> {
    const pyproject = `# The Python packages this folder's notebooks get: managed in Querier (Settings → Environment).
[project]
name = "querier-environment"
version = "0"
requires-python = ">=3.13"
dependencies = [
${deps.map((d) => `  ${JSON.stringify(d)},`).join("\n")}
]
`;
    await Bun.write(join(dir, "pyproject.toml"), pyproject);
    const cache = { UV_CACHE_DIR: join(this.root, ".uv-cache"), UV_NO_PROGRESS: "1" };
    await mkdir(this.root, { recursive: true, mode: 0o755 });
    await run([this.uv, "lock", "-q"], dir, cache);
    const hash = (await this.lockHash(dir, "python"))!;
    await this.installPython(dir, hash);
    return hash;
  }

  /** The folder's uv.lock (it must be `hash`'s) installed for the kernels' Python, unless it is already. */
  async installPython(dir: string, hash: string) {
    const out = join(this.root, `py-${this.pyTag}-${hash}`);
    if (existsSync(out)) return; // built before
    if ((await this.lockHash(dir, "python")) !== hash) throw new Error("The folder's uv.lock isn't the one applied any more.");
    const cache = { UV_CACHE_DIR: join(this.root, ".uv-cache"), UV_NO_PROGRESS: "1" };
    const tmp = `${out}.tmp-${crypto.randomUUID().slice(0, 6)}`;
    await mkdir(tmp, { recursive: true });
    try {
      await run([this.uv, "export", "--frozen", "--no-hashes", "--no-header", "--no-emit-project", "-q", "-o", join(tmp, "requirements.txt")], dir, cache);
      // for the guest's Python (3.13, glibc 2.36), or the local kernels': wheels only, so nothing is built (no setup.py runs here)
      const target = this.opts.images ? ["--python-version", "3.13", "--python-platform", "x86_64-manylinux_2_36"] : ["--python", this.opts.python ?? "python3"];
      await run([this.uv, "pip", "install", "-q", ...target, "--only-binary", ":all:", "--target", join(tmp, "site"), "-r", join(tmp, "requirements.txt")], tmp, cache);
      if (this.opts.images) {
        const size = Math.ceil(((await du(join(tmp, "site"))) * 1.2) / 2 ** 20) + 32;
        await run(["mkfs.ext4", "-q", "-L", "env", "-d", join(tmp, "site"), join(tmp, "site.ext4"), `${size}M`], tmp);
        await chmod(join(tmp, "site.ext4"), 0o644);
      }
      await rename(tmp, out);
    } catch (e) {
      await rm(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  // -- npm, for report templates: package.json and bun.lock in the folder; the build a node_modules

  private async buildJs(dir: string, deps: string[]): Promise<string> {
    const dependencies = Object.fromEntries(deps.map(jsSplit));
    await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "querier-environment", private: true, description: "The npm packages report templates here may import: managed in Querier (Settings → Environment).", dependencies }, null, 2) + "\n");
    await mkdir(this.root, { recursive: true, mode: 0o755 });
    const tmp = join(this.root, `js-tmp-${crypto.randomUUID().slice(0, 6)}`);
    await mkdir(tmp, { recursive: true });
    try {
      await Bun.write(join(tmp, "package.json"), await Bun.file(join(dir, "package.json")).text());
      if (existsSync(join(dir, "bun.lock"))) await Bun.write(join(tmp, "bun.lock"), await Bun.file(join(dir, "bun.lock")).text());
      // locked, then installed from the lock; install scripts never run: they would run as the server
      const cache = { BUN_INSTALL_CACHE_DIR: join(this.root, ".bun-cache") };
      await run([process.execPath, "install", "--lockfile-only", "--ignore-scripts", "--no-progress"], tmp, cache);
      await run([process.execPath, "install", "--frozen-lockfile", "--production", "--ignore-scripts", "--no-progress"], tmp, cache);
      await Bun.write(join(dir, "bun.lock"), await Bun.file(join(tmp, "bun.lock")).text());
      const hash = (await this.lockHash(dir, "js"))!;
      const out = join(this.root, `js-${hash}`);
      if (existsSync(out)) await rm(tmp, { recursive: true, force: true });
      else await rename(tmp, out);
      return hash;
    } catch (e) {
      await rm(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  // -- what runs with them

  /** The applied hash of a target's environment, if any. */
  hashOf(target: string, kind: EnvKind): string | undefined {
    return this.row(target, kind)?.applied?.hash;
  }

  /** Builds are for one Python: the guest's, or the local kernels' (another interpreter, another build). */
  private get pyTag() {
    return this.opts.images ? "vm313" : `local-${Bun.hash(this.opts.python ?? "python3").toString(36)}`;
  }

  /** A Python build's site-packages and disk image, by hash (both exist once built). A lock applied for
   *  one Python and run with another (a server moved from local kernels to microVMs) is built again. */
  python(hash: string | undefined): { dir: string; image: string } | null {
    if (!hash) return null;
    const dir = join(this.root, `py-${this.pyTag}-${hash}`);
    return existsSync(join(dir, "site")) ? { dir: join(dir, "site"), image: join(dir, "site.ext4") } : null;
  }

  /** An npm build's node_modules, by hash. */
  js(hash: string | undefined): string | null {
    if (!hash) return null;
    const dir = join(this.root, `js-${hash}`);
    return existsSync(join(dir, "node_modules")) ? dir : null;
  }

  /** A workspace renamed (to) or deleted (null): its and its notebooks' applied environments follow or go. */
  moveWorkspace(from: string, to: string | null) {
    if (to == null) this.db.query("DELETE FROM environments WHERE target = ? OR target LIKE ?").run(`ws:${from}`, `nb:${from}/%`);
    else {
      this.db.query("UPDATE environments SET target = ? WHERE target = ?").run(`ws:${to}`, `ws:${from}`);
      this.db.query("UPDATE environments SET target = 'nb:' || ? || substr(target, ?) WHERE target LIKE ?").run(to, `nb:${from}`.length + 1, `nb:${from}/%`);
    }
  }
  moveNotebook(from: string, to: string | null) {
    if (to == null) this.db.query("DELETE FROM environments WHERE target = ?").run(`nb:${from}`);
    else this.db.query("UPDATE environments SET target = ? WHERE target = ?").run(`nb:${to}`, `nb:${from}`);
  }
}

/** A folder's size, in bytes. */
async function du(dir: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) n += (await stat(join(e.parentPath ?? (e as any).path, e.name))).size;
  }
  return n;
}
