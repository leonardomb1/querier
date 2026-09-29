// Each person's own kernel of a notebook: what one runs isn't another's, the
// caps say no plainly, and a kernel nobody uses stops, telling its tabs why.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../server/auth/db";
import type { Principal } from "../server/auth/principal";
import { Sessions } from "../server/auth/sessions";

const PORT = 4010 + Math.floor(Math.random() * 20);
let dir: string;
let server: ReturnType<typeof Bun.spawn>;
const cookies: Record<string, string> = {};
const person = (id: string): Principal => ({ id: `corp:${id}`, provider: "corp", subject: id, username: id, groups: ["analysts"], attrs: {} });

/** A tab: a socket kept open, every frame it got. */
class Tab {
  frames: any[] = [];
  private ws!: WebSocket;
  static async open(who: string, nb: string) {
    const t = new Tab();
    t.ws = new WebSocket(`ws://localhost:${PORT}/ws/${nb}`, { headers: { cookie: cookies[who] } } as any);
    t.ws.binaryType = "arraybuffer";
    t.ws.onmessage = (e) => {
      const buf = new Uint8Array(e.data as ArrayBuffer);
      t.frames.push(JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + new DataView(buf.buffer).getUint32(0)))));
    };
    await new Promise((r, j) => ((t.ws.onopen = r), (t.ws.onerror = j)));
    return t;
  }
  send(msg: object) {
    this.ws.send(JSON.stringify(msg));
  }
  /** Wait for a frame matching `fn`. */
  async until(fn: (f: any) => boolean, ms = 30_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const f = this.frames.find(fn);
      if (f) return f;
      await Bun.sleep(50);
    }
    throw new Error(`no such frame in ${ms} ms; got ${JSON.stringify(this.frames.filter((f) => f.type !== "metrics").map((f) => (f.type === "session" ? `session:${f.state}:${f.secretsStale}:${f.stopped ?? ""}` : f.type === "state" ? `state:${f.cell}:${f.state}` : f.type === "event" ? `event:${f.cell}:${f.event.type}:${(f.event.message ?? f.event.text ?? "").slice(0, 80)}` : f.type)))}`);
  }
  close() {
    this.ws.close();
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "querier-kernels-"));
  for (const nb of ["one", "two"]) {
    await mkdir(join(dir, "nb/w", nb), { recursive: true });
    await Bun.write(join(dir, "nb/w", nb, "01_q.sql"), "SELECT 1 AS one;\n");
    // how long the kernel's TOKEN is (its value would be masked)
    await Bun.write(join(dir, "nb/w", nb, "02_tok.py"), 'import os\nprint("token length", len(os.environ.get("TOKEN", "")))\n');
  }
  await Bun.write(join(dir, "nb/w/workspace.json"), JSON.stringify({ title: "w" }));
  server = Bun.spawn(["bun", resolve(import.meta.dir, "../server/app.ts"), "--port", String(PORT), "--notebooks", join(dir, "nb")], {
    cwd: dir, // not the repository's .env
    env: {
      ...process.env,
      QUERIER_CONFIG_DIR: join(dir, "config"),
      QUERIER_ADMIN_USER: "root",
      QUERIER_ADMIN_PASSWORD_HASH: await Bun.password.hash("root-pass"),
      QUERIER_ADMIN_PASSWORD: "",
      QUERIER_RUNNER: "",
      QUERIER_MAX_KERNELS_PER_USER: "1",
      QUERIER_KERNEL_IDLE_MINUTES: "0.1", // 6 s
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let i = 0; i < 100 && !(await fetch(`http://localhost:${PORT}/api/auth/providers`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
  const login = await fetch(`http://localhost:${PORT}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "sysadmin", username: "root", password: "root-pass" }) });
  cookies.root = /querier_session=[^;]+/.exec(login.headers.get("set-cookie") ?? "")![0];
  const grant = await fetch(`http://localhost:${PORT}/api/workspaces/w/access`, { method: "POST", headers: { cookie: cookies.root, "content-type": "application/json" }, body: JSON.stringify({ subject: { kind: "group", name: "analysts" }, role: "Contributor" }) });
  expect(grant.status).toBe(200);
  const sessions = new Sessions(openDb(join(dir, "config/querier.db")), () => ({ absoluteHours: 1, idleMinutes: 60, refreshMinutes: 60 }));
  for (const n of ["ana", "bob"]) cookies[n] = `querier_session=${sessions.create(person(n)).id}`;
});

afterAll(async () => {
  server?.kill();
  await rm(dir, { recursive: true, force: true });
});

test("each person runs in their own kernel: one's run and output never reach another's tab", async () => {
  const ana = await Tab.open("ana", "w/one");
  const bob = await Tab.open("bob", "w/one");
  await ana.until((f) => f.type === "replayed");
  await bob.until((f) => f.type === "replayed");
  ana.send({ op: "run", cells: ["q"], params: {} });
  await ana.until((f) => f.type === "state" && f.cell === "q" && f.state === "ok");
  expect(ana.frames.some((f) => f.type === "event" && f.cell === "q")).toBe(true);
  await Bun.sleep(300);
  expect(bob.frames.filter((f) => f.type === "state" && f.state !== "idle")).toEqual([]);
  expect(bob.frames.some((f) => f.type === "event")).toBe(false);
  expect(bob.frames.some((f) => f.type === "session" && f.state === "ready")).toBe(false);
  // a second tab of ana's gets her kernel's state replayed
  const ana2 = await Tab.open("ana", "w/one");
  await ana2.until((f) => f.type === "state" && f.cell === "q" && f.state === "ok");
  for (const t of [ana, bob, ana2]) t.close();
}, 60_000);

test("over the per-person cap, a run says so; the kernel's idle stop tells the tab", async () => {
  const one = await Tab.open("ana", "w/one");
  const two = await Tab.open("ana", "w/two");
  await two.until((f) => f.type === "replayed");
  // ana's kernel of `one` still runs (from the test above): a second is over her cap of 1
  two.send({ op: "run", cells: ["q"], params: {} });
  await two.until((f) => f.type === "state" && f.cell === "q" && f.state === "error");
  const err = two.frames.find((f) => f.type === "event" && f.cell === "q" && f.event.type === "error");
  expect(err.event.message).toContain("the most one person may");
  // unused for 6 s: `one`'s kernel stops, and its tab is told why
  const stopped = await one.until((f) => f.type === "session" && f.stopped, 20_000);
  expect(stopped.stopped).toContain("6 seconds unused");
  // its place is free again: `two` runs now
  two.frames = [];
  two.send({ op: "run", cells: ["q"], params: {} });
  await two.until((f) => f.type === "state" && f.cell === "q" && f.state === "ok");
  one.close();
  two.close();
}, 60_000);

/** What a cell printed. */
const printed = (t: Tab, cell: string) => t.frames.filter((f) => f.type === "event" && f.cell === cell && f.event.type === "stream").map((f) => f.event.text).join("");

test("each kernel runs with its owner's own credentials; changing them marks only their kernels stale", async () => {
  const api = (who: string, method: string, path: string, body?: unknown) =>
    fetch(`http://localhost:${PORT}/api${path}`, { method, headers: { cookie: cookies[who], "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as any }));
  const tok = (await api("root", "POST", "/connections", { workspace: "w", name: "tok", variables: ["TOKEN"], credentials: "per-user" })).body;
  const ana = await Tab.open("ana", "w/two");
  const bob = await Tab.open("bob", "w/two");
  await ana.until((f) => f.type === "replayed");
  await bob.until((f) => f.type === "replayed");
  // ana's kernel of `two` runs (the test above): her own token arrives, and it is stale for her alone
  expect((await api("ana", "PUT", `/connections/${tok.id}/mine`, { values: { TOKEN: "ana-secret-token" } })).status).toBe(200);
  await ana.until((f) => f.type === "session" && f.secretsStale === true);
  await Bun.sleep(200);
  expect(bob.frames.some((f) => f.type === "session" && f.secretsStale)).toBe(false);
  ana.send({ op: "restart" });
  await ana.until((f) => f.type === "session" && f.state === "ready" && !f.secretsStale);
  ana.send({ op: "run", cells: ["tok"], params: {} });
  bob.send({ op: "run", cells: ["tok"], params: {} });
  await ana.until((f) => f.type === "state" && f.cell === "tok" && f.state === "ok");
  await bob.until((f) => f.type === "state" && f.cell === "tok" && f.state === "ok");
  expect(printed(ana, "tok")).toContain("token length 16");
  expect(printed(bob, "tok")).toContain("token length 0");
  // a policy about something else: no kernel is told it's stale
  const mark = ana.frames.length;
  expect((await api("root", "PUT", "/admin/policies/unrelated", { text: 'permit (principal, action == Action::"report.view", resource == Notebook::"w/one");' })).status).toBe(200);
  await Bun.sleep(500);
  expect(ana.frames.slice(mark).some((f) => f.type === "session" && f.secretsStale)).toBe(false);
  // access taken away: the running kernel that has it stops, and says why; bob's goes on
  expect((await api("ana", "DELETE", `/connections/${tok.id}/mine`)).status).toBe(200);
  const stopped = await ana.until((f) => f.type === "session" && f.stopped?.includes("no longer gets TOKEN"));
  expect(stopped.state).toBe("none");
  await Bun.sleep(200);
  expect(bob.frames.some((f) => f.type === "session" && f.stopped)).toBe(false);
  ana.close();
  bob.close();
}, 60_000);
