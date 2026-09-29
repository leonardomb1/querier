// Git for notebooks: each notebook folder may be its own repository, opted into
// per notebook. Changes are reported per cell (a cell is its name, whatever
// its number or language), commits cover the whole notebook, and outputs are
// never tracked — they are not files.
//
// git runs with argv (never a shell), without a terminal, and without prompts:
// HTTPS remotes authenticate with a GIT_TOKEN secret through GIT_ASKPASS, SSH
// remotes with the server user's keys in batch mode.

import { chmod, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { UserError } from "./store";

const CELL = /^(\d+)_([A-Za-z_]\w*)\.(sql|py|md)$/;
const cellName = (file: string) => CELL.exec(file)?.[2];


export type CellChange = "added" | "modified" | "deleted" | "moved";

export interface GitStatus {
  tracked: boolean;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  remote?: string;
  identity: { name?: string; email?: string };
  head?: { hash: string; subject: string };
  /** What changed since the last commit, cell by cell. */
  cells: { name: string; change: CellChange; file?: string; was?: string }[];
  /** Other changed files: notebook.json, data. */
  files: { path: string; change: "added" | "modified" | "deleted" }[];
  /** Each cell's source at HEAD, for the editor's change markers. */
  original: Record<string, string>;
  /** A merge or rebase stopped half way. */
  conflict?: string;
}

export interface Ref {
  name: string;
  /** head: the branch checked out; branch, remote (origin/main), tag */
  kind: "head" | "branch" | "remote" | "tag";
}

export interface Commit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: number;
  cells: string[];
  /** first parent first; two or more for a merge */
  parents: string[];
  refs: Ref[];
  /** HEAD points here (detached or not) */
  head: boolean;
}

/** `%D`: "HEAD -> main, origin/main, tag: v1" */
function parseRefs(d: string): { refs: Ref[]; head: boolean } {
  const refs: Ref[] = [];
  let head = false;
  for (const raw of d.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (raw === "HEAD") head = true;
    else if (raw.startsWith("HEAD -> ")) {
      head = true;
      refs.push({ name: raw.slice(8), kind: "head" });
    } else if (raw.startsWith("tag: ")) refs.push({ name: raw.slice(5), kind: "tag" });
    else if (raw.endsWith("/HEAD")) continue; // origin/HEAD: an alias
    else refs.push({ name: raw, kind: raw.includes("/") ? "remote" : "branch" });
  }
  return { refs, head };
}

const IGNORE = `# Querier: outputs are never files, so only code and settings are tracked.
# Columnar and archived data are left out by default; delete a line to track them.
*.parquet
*.arrow
*.arrows
*.feather
*.ipc
*.zip
*.gz
*.zst
.DS_Store
`;

/** Answers git's credential prompts from the environment: a token for HTTPS. */
async function askpass(): Promise<string> {
  const path = join(homedir(), ".config/querier/git-askpass.sh");
  if (!(await Bun.file(path).exists())) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Bun.write(
      path,
      `#!/bin/sh\ncase "$1" in\n  Username*) printf '%s' "\${QUERIER_GIT_USER:-x-access-token}" ;;\n  *) printf '%s' "$QUERIER_GIT_TOKEN" ;;\nesac\n`,
    );
    await chmod(path, 0o700);
  }
  return path;
}

export class Git {
  constructor(
    readonly dir: string,
    /** The notebook's secrets: GIT_TOKEN (and GIT_USER) authenticate HTTPS remotes. */
    private secrets: () => Promise<Record<string, string>>,
  ) {}

  private async run(args: string[], opts: { ok?: number[]; remote?: boolean } = {}): Promise<string> {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
      LC_ALL: "C",
    };
    if (opts.remote) {
      const s = await this.secrets();
      if (s.GIT_TOKEN) {
        env.GIT_ASKPASS = await askpass();
        env.QUERIER_GIT_TOKEN = s.GIT_TOKEN;
        if (s.GIT_USER) env.QUERIER_GIT_USER = s.GIT_USER;
      }
    }
    const proc = Bun.spawn(["git", ...args], { cwd: this.dir, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (!(opts.ok ?? [0]).includes(code)) {
      const msg = (err || out).trim().split("\n").filter((l) => !l.startsWith("hint:")).join("\n");
      throw new UserError(msg || `git ${args[0]} failed (${code})`);
    }
    return out;
  }

  /** Is this folder the top of its own repository (not inside some parent's)? */
  async tracked(): Promise<boolean> {
    return Bun.file(join(this.dir, ".git/HEAD")).exists();
  }

  /** What cells write (output/) is never tracked. In .git/info/exclude, which
   *  isn't committed, so it holds for repos made before output/ existed without
   *  touching the notebook's own .gitignore. */
  private async excludeOutput() {
    const file = join(this.dir, ".git/info/exclude");
    const cur = await Bun.file(file).text().catch(() => "");
    if (cur.split("\n").some((l) => l.trim() === "/output/")) return;
    await mkdir(dirname(file), { recursive: true });
    await Bun.write(file, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}# Querier: files cells write\n/output/\n`);
  }

  async init(identity: { name?: string; email?: string }, remote?: string) {
    if (await this.tracked()) throw new UserError("This notebook is already tracked.");
    await this.run(["init", "-b", "main"]);
    if (identity.name) await this.run(["config", "user.name", identity.name]);
    if (identity.email) await this.run(["config", "user.email", identity.email]);
    const who = await this.identity();
    if (!who.name || !who.email) {
      await rm(join(this.dir, ".git"), { recursive: true, force: true });
      throw new UserError("Git needs an author name and email for commits.");
    }
    if (!(await Bun.file(join(this.dir, ".gitignore")).exists())) await Bun.write(join(this.dir, ".gitignore"), IGNORE);
    await this.excludeOutput();
    if (remote) await this.run(["remote", "add", "origin", remote]);
    await this.run(["add", "-A"]);
    await this.run(["commit", "-m", "Start tracking this notebook"]);
  }

  async identity(): Promise<{ name?: string; email?: string }> {
    const get = async (k: string) => (await this.run(["config", "--get", k], { ok: [0, 1] }).catch(() => "")).trim() || undefined;
    return { name: await get("user.name"), email: await get("user.email") };
  }

  /** Every file at HEAD, with its content. */
  private async headFiles(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const has = await this.run(["rev-parse", "--verify", "-q", "HEAD"], { ok: [0, 1] });
    if (!has.trim()) return out;
    return this.filesAt("HEAD");
  }

  private async filesAt(rev: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const list = (await this.run(["ls-tree", "-r", "-z", "--name-only", rev])).split("\0").filter(Boolean);
    for (const path of list) out.set(path, await this.run(["show", `${rev}:${path}`]));
    return out;
  }

  private async workFiles(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    // what git would commit: tracked files plus untracked ones not ignored
    const list = (await this.run(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
    for (const path of new Set(list)) {
      const f = Bun.file(join(this.dir, path));
      if (await f.exists()) out.set(path, await f.text());
    }
    return out;
  }

  async status(): Promise<GitStatus> {
    const empty: GitStatus = { tracked: false, ahead: 0, behind: 0, identity: {}, cells: [], files: [], original: {} };
    if (!(await this.tracked())) return { ...empty, identity: await this.identity() }; // the global one, if any
    await this.excludeOutput();
    const [head, work, identity] = await Promise.all([this.headFiles(), this.workFiles(), this.identity()]);

    // cells are matched by name: a renumbered cell is "moved", not deleted + added
    const byName = (files: Map<string, string>) => {
      const m = new Map<string, { file: string; source: string }>();
      for (const [file, source] of files) {
        const n = cellName(file);
        if (n) m.set(n, { file, source });
      }
      return m;
    };
    const hc = byName(head);
    const wc = byName(work);
    const cells: GitStatus["cells"] = [];
    for (const [name, w] of wc) {
      const h = hc.get(name);
      if (!h) cells.push({ name, change: "added", file: w.file });
      else if (h.source !== w.source || extOf(h.file) !== extOf(w.file)) cells.push({ name, change: "modified", file: w.file, was: h.file });
      else if (h.file !== w.file) cells.push({ name, change: "moved", file: w.file, was: h.file });
    }
    for (const [name, h] of hc) if (!wc.has(name)) cells.push({ name, change: "deleted", was: h.file });

    const files: GitStatus["files"] = [];
    for (const [path, src] of work) {
      if (cellName(path)) continue;
      if (!head.has(path)) files.push({ path, change: "added" });
      else if (head.get(path) !== src) files.push({ path, change: "modified" });
    }
    for (const path of head.keys()) if (!cellName(path) && !work.has(path)) files.push({ path, change: "deleted" });

    const branch = (await this.run(["branch", "--show-current"])).trim() || undefined;
    const upstream = (await this.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { ok: [0, 128] })).trim() || undefined;
    let ahead = 0;
    let behind = 0;
    if (upstream) {
      const counts = (await this.run(["rev-list", "--left-right", "--count", "HEAD...@{u}"])).trim().split(/\s+/);
      ahead = Number(counts[0]) || 0;
      behind = Number(counts[1]) || 0;
    }
    const remote = (await this.run(["remote", "get-url", "origin"], { ok: [0, 2] })).trim() || undefined;
    const log = head.size ? (await this.run(["log", "-1", "--format=%H%x00%s"])).trim().split("\0") : [];
    const original: Record<string, string> = {};
    for (const [name, h] of hc) original[name] = h.source;
    const conflict = (await Bun.file(join(this.dir, ".git/MERGE_HEAD")).exists())
      ? "merge"
      : (await Bun.file(join(this.dir, ".git/rebase-merge")).exists()) || (await Bun.file(join(this.dir, ".git/rebase-apply")).exists())
        ? "rebase"
        : undefined;

    return {
      tracked: true,
      branch,
      upstream,
      ahead,
      behind,
      remote,
      identity,
      head: log.length ? { hash: log[0], subject: log[1] } : undefined,
      cells: cells.sort((a, b) => a.name.localeCompare(b.name)),
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
      original,
      conflict,
    };
  }

  async commit(message: string) {
    if (!message.trim()) throw new UserError("A commit needs a message.");
    await this.run(["add", "-A"]);
    if (!(await this.run(["diff", "--cached", "--name-only"])).trim()) {
      throw new UserError("Nothing to commit: this notebook matches its last commit.");
    }
    await this.run(["commit", "-m", message.trim()]);
  }

  /** Put cells (or the whole notebook) back as they were at `rev` (default HEAD).
   *  Nothing is committed: the result shows up as changes. */
  async restore(rev = "HEAD", cells?: string[]) {
    const then = await this.filesAt(rev);
    const now = await this.workFiles();
    const write = async (path: string, content: string) => {
      await mkdir(dirname(join(this.dir, path)), { recursive: true });
      await Bun.write(join(this.dir, path), content);
    };
    if (!cells) {
      // the whole notebook: its files become exactly those of `rev`
      for (const path of now.keys()) if (!then.has(path)) await rm(join(this.dir, path), { force: true });
      for (const [path, content] of then) await write(path, content);
      return;
    }
    // some cells: each one's code, by name, at the place it had then
    const want = new Set(cells);
    for (const path of now.keys()) {
      const owner = cellName(path);
      if (owner && want.has(owner) && !then.has(path)) await rm(join(this.dir, path), { force: true });
    }
    for (const [path, content] of then) if (want.has(cellName(path) ?? "")) await write(path, content);
  }

  /** Every branch's history (remotes and tags too), newest first, parents before
   *  children never: git's topological order, what a graph is drawn from. */
  async log(limit = 300): Promise<Commit[]> {
    const has = await this.run(["rev-parse", "--verify", "-q", "HEAD"], { ok: [0, 1] });
    if (!has.trim()) return [];
    const out = await this.run(["log", "--all", "--topo-order", `-${limit}`, "--format=%x1e%H%x00%h%x00%s%x00%an%x00%at%x00%P%x00%D", "--name-only"]);
    return out
      .split("\x1e")
      .filter((s) => s.trim())
      .map((rec) => {
        const [first, ...rest] = rec.split("\n");
        const [hash, short, subject, author, at, parents, decorations] = first.split("\0");
        const cells = [...new Set(rest.map((p) => cellName(p.trim())).filter((n): n is string => !!n))];
        return { hash, short, subject, author, date: Number(at) * 1000, cells, parents: parents ? parents.split(" ") : [], ...parseRefs(decorations ?? "") };
      });
  }

  /** One commit, cell by cell: the source before and after. */
  async show(rev: string) {
    if (!/^[0-9a-f]{4,40}$/.test(rev)) throw new UserError("Not a commit id.");
    const [hash, subject, body, author, at, parent] = (await this.run(["show", "-s", "--format=%H%x00%s%x00%b%x00%an%x00%at%x00%P", rev]))
      .trimEnd()
      .split("\0");
    const after = await this.filesAt(hash);
    const before = parent ? await this.filesAt(parent.split(" ")[0]) : new Map<string, string>();
    const name = (m: Map<string, string>) => new Map([...m].filter(([p]) => cellName(p)).map(([p, s]) => [cellName(p)!, s]));
    const a = name(before);
    const b = name(after);
    const cells = [];
    for (const n of new Set([...a.keys(), ...b.keys()])) {
      if (a.get(n) === b.get(n)) continue;
      cells.push({ name: n, change: !a.has(n) ? "added" : !b.has(n) ? "deleted" : "modified", before: a.get(n) ?? "", after: b.get(n) ?? "" });
    }
    return { hash, subject, body: body.trim(), author, date: Number(at) * 1000, cells };
  }

  async branches(): Promise<{ name: string; current: boolean }[]> {
    const out = await this.run(["branch", "--format=%(HEAD)%00%(refname:short)"]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [h, name] = l.split("\0");
        return { name, current: h === "*" };
      });
  }

  private async requireClean(what: string) {
    const s = await this.status();
    if (s.cells.length || s.files.length) throw new UserError(`Commit or discard this notebook's changes before ${what}.`);
  }

  async createBranch(name: string) {
    await this.run(["check-ref-format", "--branch", name]).catch(() => {
      throw new UserError(`\`${name}\` is not a valid branch name.`);
    });
    await this.run(["switch", "-c", name]);
  }

  async switchBranch(name: string) {
    await this.requireClean("switching branches");
    await this.run(["switch", name]);
  }

  async setRemote(url: string) {
    const has = (await this.run(["remote"])).split("\n").includes("origin");
    if (!url) {
      if (has) await this.run(["remote", "remove", "origin"]);
      return;
    }
    await this.run(has ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url]);
  }

  async fetch() {
    await this.run(["fetch", "--prune", "origin"], { remote: true });
  }

  /** Fast-forward when possible; with `rebase`, replay local commits on top.
   *  A conflict is undone and reported, leaving the notebook as it was. */
  async pull(rebase = false) {
    await this.requireClean("pulling");
    await this.fetch();
    const branch = (await this.run(["branch", "--show-current"])).trim();
    const remoteRef = `origin/${branch}`;
    const exists = await this.run(["rev-parse", "--verify", "-q", remoteRef], { ok: [0, 1] });
    if (!exists.trim()) throw new UserError(`origin has no branch \`${branch}\` yet: push first.`);
    if (!rebase) {
      await this.run(["merge", "--ff-only", remoteRef]).catch(() => {
        throw new UserError("This branch and origin have both moved on. Pull with rebase to put your commits on top of theirs.");
      });
    } else {
      try {
        await this.run(["rebase", remoteRef]);
      } catch (e: any) {
        await this.run(["rebase", "--abort"], { ok: [0, 128] });
        throw new UserError(`Your commits and origin's change the same lines, so nothing was changed. ${e.message}`);
      }
    }
    await this.run(["branch", "--set-upstream-to", remoteRef], { ok: [0, 128] });
  }

  async push() {
    const branch = (await this.run(["branch", "--show-current"])).trim();
    if (!branch) throw new UserError("Not on a branch.");
    await this.run(["push", "-u", "origin", branch], { remote: true });
  }
}

const extOf = (file: string) => file.slice(file.lastIndexOf("."));

