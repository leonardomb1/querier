import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git } from "../server/git";
import { Store } from "../server/store";

let root: string;
let store: Store;
let git: Git;
const who = { name: "Test Author", email: "test@example.com" };
const noSecrets = async () => ({});
const $ = (cmd: string[], cwd: string) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "querier-git-"));
  store = new Store(join(root, "notebooks"));
  await store.create("nb", "Git test"); // 01_notes.md, 02_query.sql
  git = new Git(store.dir("nb"), noSecrets);
});
afterAll(() => rm(root, { recursive: true, force: true }));

test("a notebook is untracked until it opts in; init commits it as it is", async () => {
  expect((await git.status()).tracked).toBe(false);
  await git.init(who);
  const s = await git.status();
  expect(s).toMatchObject({ tracked: true, branch: "main", cells: [], files: [], identity: who });
  expect(Object.keys(s.original).sort()).toEqual(["notes", "query"]);
  expect(await Bun.file(join(store.dir("nb"), ".gitignore")).text()).toContain("*.parquet");
});

test("changes are reported per cell: added, modified, moved, deleted", async () => {
  await store.save("nb", "query", "SELECT 2 AS two;\n");
  await store.add("nb", "python", "query"); // new cell `py`, after query
  await store.move("nb", "notes", 2); // renumbered: moved, not deleted + added
  const s = await git.status();
  expect(s.cells).toEqual([
    { name: "notes", change: "moved", file: "03_notes.md", was: "01_notes.md" },
    { name: "py", change: "added", file: "02_py.py" },
    { name: "query", change: "modified", file: "01_query.sql", was: "02_query.sql" },
  ]);
  await store.remove("nb", "py");
  expect((await git.status()).cells.map((c) => [c.name, c.change])).toEqual([
    ["notes", "moved"],
    ["query", "modified"],
  ]);
});

test("commit, log and show", async () => {
  await git.commit("Change the query");
  expect((await git.status()).cells).toEqual([]);
  expect(git.commit("again")).rejects.toThrow("Nothing to commit");
  const log = await git.log();
  expect(log.map((c) => c.subject)).toEqual(["Change the query", "Start tracking this notebook"]);
  expect(log[0].cells.sort()).toEqual(["notes", "query"]);
  const shown = await git.show(log[0].hash);
  expect(shown.cells).toEqual([{ name: "query", change: "modified", before: "SELECT 1 AS one;\n", after: "SELECT 2 AS two;\n" }]);
});

test("restore a cell, or the whole notebook, without committing", async () => {
  const [latest, first] = await git.log();
  await store.save("nb", "query", "SELECT 3 AS three;\n");
  await git.restore("HEAD", ["query"]);
  expect((await git.status()).cells).toEqual([]);

  await git.restore(first.hash);
  const s = await git.status();
  expect(s.cells.map((c) => [c.name, c.change])).toEqual([
    ["notes", "moved"],
    ["query", "modified"],
  ]);
  await git.restore(latest.hash);
  expect((await git.status()).cells).toEqual([]);
});

test("branches: create, and refuse to switch with changes", async () => {
  await git.createBranch("experiment");
  expect((await git.branches()).find((b) => b.current)?.name).toBe("experiment");
  await store.save("nb", "query", "SELECT 4;\n");
  expect(git.switchBranch("main")).rejects.toThrow("Commit or discard");
  await git.restore();
  await git.switchBranch("main");
  expect((await git.status()).branch).toBe("main");
  expect(git.createBranch("bad name..")).rejects.toThrow("not a valid branch name");
});

test("push, and pull from another clone: fast-forward, then rebase on divergence", async () => {
  const bare = join(root, "remote.git");
  $(["git", "init", "--bare", "-b", "main", bare], root);
  await git.setRemote(bare);
  await git.push();
  let s = await git.status();
  expect(s).toMatchObject({ remote: bare, upstream: "origin/main", ahead: 0, behind: 0 });

  // someone else commits
  const other = join(root, "other");
  $(["git", "clone", "-q", bare, other], root);
  await Bun.write(join(other, "01_query.sql"), "SELECT 'theirs' AS who;\n");
  $(["git", "-c", "user.name=O", "-c", "user.email=o@x", "commit", "-qam", "Their change"], other);
  $(["git", "push", "-q"], other);

  await git.pull();
  expect((await git.show((await git.log())[0].hash)).subject).toBe("Their change");

  // both move on, touching different cells: a plain pull refuses, a rebase works
  await Bun.write(join(other, "02_notes.md"), "# theirs\n");
  $(["git", "-c", "user.name=O", "-c", "user.email=o@x", "commit", "-qam", "Their notes"], other);
  $(["git", "push", "-q"], other);
  await store.save("nb", "query", "SELECT 'mine' AS who;\n");
  await git.commit("My query");
  expect(git.pull()).rejects.toThrow("both moved on");
  await git.pull(true);
  expect((await git.log(3)).map((c) => c.subject)).toEqual(["My query", "Their notes", "Their change"]);
  await git.push();
  s = await git.status();
  expect([s.ahead, s.behind]).toEqual([0, 0]);

  // both change the same cell: the rebase is undone and reported
  $(["git", "pull", "-q", "--rebase"], other);
  await Bun.write(join(other, "01_query.sql"), "SELECT 'theirs again';\n");
  $(["git", "-c", "user.name=O", "-c", "user.email=o@x", "commit", "-qam", "Theirs again"], other);
  $(["git", "push", "-q"], other);
  await store.save("nb", "query", "SELECT 'mine again';\n");
  await git.commit("Mine again");
  expect(git.pull(true)).rejects.toThrow("change the same lines");
  s = await git.status();
  expect(s.conflict).toBeUndefined();
  expect((await git.log(1))[0].subject).toBe("Mine again");
});

test("the log is a graph: every branch, parents, refs", async () => {
  // a separate repo, so the other tests' history stays as they expect it
  const dir = join(root, "graph");
  await Bun.write(join(dir, "01_q.sql"), "SELECT 1;\n");
  const g = new Git(dir, noSecrets);
  await g.init(who);
  const at = (cmd: string[]) => $(["git", ...cmd], dir);
  at(["checkout", "-q", "-b", "feature"]);
  await Bun.write(join(dir, "02_f.sql"), "SELECT 2;\n");
  at(["add", "-A"]);
  at(["commit", "-q", "-m", "Feature work"]);
  at(["checkout", "-q", "main"]);
  await Bun.write(join(dir, "01_q.sql"), "SELECT 3;\n");
  at(["add", "-A"]);
  at(["commit", "-q", "-m", "Main work"]);
  at(["merge", "-q", "--no-ff", "-m", "Merge feature", "feature"]);
  at(["tag", "v1"]);
  const log = await g.log();
  expect(log.map((c) => c.subject)).toEqual(["Merge feature", "Feature work", "Main work", "Start tracking this notebook"]);
  const [merge, feature, main, root0] = log;
  expect(merge.parents).toEqual([main.hash, feature.hash]);
  expect(merge.head).toBe(true);
  expect(merge.refs).toEqual([
    { name: "main", kind: "head" },
    { name: "v1", kind: "tag" },
  ]);
  expect(feature.refs).toEqual([{ name: "feature", kind: "branch" }]);
  expect(root0.parents).toEqual([]);
});
