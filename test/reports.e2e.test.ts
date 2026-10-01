// Published reports, end to end: viewers run the frozen code in their own report
// kernel; as its owner, with the owner's connections; bound PARAMs set by the
// server from the viewer's tags; a schedule's result given to viewers at once.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../server/auth/db";
import type { Principal } from "../server/auth/principal";
import { Sessions } from "../server/auth/sessions";

const PORT = 4040 + Math.floor(Math.random() * 20);
let dir: string;
let server: ReturnType<typeof Bun.spawn>;
const cookies: Record<string, string> = {};
const person = (id: string, groups: string[], attrs: Record<string, string[]> = {}): Principal => ({ id: `corp:${id}`, provider: "corp", subject: id, username: id, groups, attrs });

class Tab {
  frames: any[] = [];
  private ws!: WebSocket;
  static async open(who: string, path: string) {
    const t = new Tab();
    t.ws = new WebSocket(`ws://localhost:${PORT}/ws/${path}`, { headers: { cookie: cookies[who] } } as any);
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
  async until(fn: (f: any) => boolean, ms = 30_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const f = this.frames.find(fn);
      if (f) return f;
      await Bun.sleep(50);
    }
    throw new Error(`no such frame; got ${JSON.stringify(this.frames.filter((f) => f.type !== "metrics").map((f) => (f.type === "state" ? `state:${f.cell}:${f.state}` : f.type === "event" ? `event:${f.cell}:${f.event.type}:${(f.event.message ?? f.event.text ?? "").slice(0, 60)}` : f.type === "denied" ? `denied:${f.message}` : f.type)))}`);
  }
  printed(cell: string) {
    return this.frames.filter((f) => f.type === "event" && f.cell === cell).map((f) => f.event.text ?? "").join("");
  }
  close() {
    this.ws.close();
  }
}

const api = (who: string, method: string, path: string, body?: unknown) =>
  fetch(`http://localhost:${PORT}/api${path}`, { method, headers: { cookie: cookies[who], "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({
    status: r.status,
    body: (await r.json().catch(() => ({}))) as any,
  }));

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "querier-reports-"));
  const nb = join(dir, "nb/w/r");
  await mkdir(nb, { recursive: true });
  await Bun.write(join(dir, "nb/w/workspace.json"), JSON.stringify({ title: "w" }));
  await Bun.write(join(nb, "01_params.sql"), "PARAM region STRING DEFAULT 'all';\n");
  // what the report shows: the region it was run for, and how long its TOKEN is
  await Bun.write(join(nb, "02_rows.sql"), "SELECT $region AS region;\n");
  await Bun.write(join(nb, "03_tok.py"), 'import os\nprint("token length", len(os.environ.get("TOKEN", "")))\n');
  // (last in the notebook: what the environment gives)
  await Bun.write(join(nb, "09_pkg.py"), 'try:\n    import tabulate\n    print("tabulate", "yes")\nexcept ImportError:\n    print("tabulate", "no")\n');
  server = Bun.spawn(["bun", resolve(import.meta.dir, "../server/app.ts"), "--port", String(PORT), "--notebooks", join(dir, "nb")], {
    cwd: dir,
    env: { ...process.env, QUERIER_CONFIG_DIR: join(dir, "config"), QUERIER_ADMIN_USER: "root", QUERIER_ADMIN_PASSWORD_HASH: await Bun.password.hash("root-pass"), QUERIER_ADMIN_PASSWORD: "", QUERIER_RUNNER: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let i = 0; i < 100 && !(await fetch(`http://localhost:${PORT}/api/auth/providers`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
  const login = await fetch(`http://localhost:${PORT}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "sysadmin", username: "root", password: "root-pass" }) });
  cookies.root = /querier_session=[^;]+/.exec(login.headers.get("set-cookie") ?? "")![0];
  const sessions = new Sessions(openDb(join(dir, "config/querier.db")), () => ({ absoluteHours: 1, idleMinutes: 60, refreshMinutes: 60 }));
  const db = openDb(join(dir, "config/querier.db"));
  const people = { ana: person("ana", ["owners"]), vic: person("vic", ["viewers"], { region: ["EMEA"] }), carl: person("carl", ["viewers"]) };
  for (const [n, p] of Object.entries(people)) {
    cookies[n] = `querier_session=${sessions.create(p).id}`;
    db.query("INSERT INTO users (id, provider, username, principal, last_login) VALUES (?, ?, ?, ?, ?)").run(p.id, p.provider, p.username, JSON.stringify(p), Date.now());
  }
  expect((await api("root", "POST", "/workspaces/w/access", { subject: { kind: "group", name: "owners" }, role: "Member" })).status).toBe(200);
  expect((await api("root", "POST", "/workspaces/w/access", { subject: { kind: "group", name: "viewers" }, role: "Viewer" })).status).toBe(200);
  // a per-person connection: ana's own token
  const tok = (await api("root", "POST", "/connections", { workspace: "w", name: "tok", variables: ["TOKEN"], credentials: "per-user" })).body;
  expect((await api("ana", "PUT", `/connections/${tok.id}/mine`, { values: { TOKEN: "ana-secret-token" } })).status).toBe(200);
});

afterAll(async () => {
  server?.kill();
  await rm(dir, { recursive: true, force: true });
});

test("publishing: who may, what it takes, what viewers get", async () => {
  expect((await api("vic", "GET", "/workspaces/w/notebooks/r/published")).status).toBe(404);
  expect((await api("vic", "POST", "/workspaces/w/notebooks/r/published", { runAs: "viewer" })).status).toBe(403); // a Viewer doesn't publish
  // a schedule needs the owner's identity, and nothing bound
  expect((await api("ana", "POST", "/workspaces/w/notebooks/r/published", { runAs: "viewer", schedule: { every: 60 } })).status).toBe(400);
  expect((await api("ana", "POST", "/workspaces/w/notebooks/r/published", { runAs: "owner", bindings: { region: "region" }, schedule: { every: 60 } })).status).toBe(400);
  expect((await api("ana", "POST", "/workspaces/w/notebooks/r/published", { runAs: "owner", bindings: { nope: "region" } })).status).toBe(400);
  expect((await api("ana", "POST", "/workspaces/w/notebooks/r/published", { runAs: "owner", bindings: { region: "region" } })).status).toBe(200);
  const view = (await api("vic", "GET", "/workspaces/w/notebooks/r/published")).body;
  expect(view.published).toMatchObject({ runAs: "owner", owner: "ana", by: "ana" });
  expect(view.params.map((p: any) => p.name)).toEqual([]); // region is bound: not the viewer's control
  expect(view.bound).toEqual(["region"]);
  expect(view.boundValues).toEqual({ region: "EMEA" }); // vic's own, so the page knows what is fresh
  expect(view.cells.every((c: any) => typeof c.hash === "string")).toBe(true);
});

test("as its owner, bound to the viewer's tag: vic's report runs with ana's token, for EMEA whatever vic asks", async () => {
  const vic = await Tab.open("vic", "w/r/report");
  await vic.until((f) => f.type === "replayed");
  vic.send({ op: "run", cells: ["params", "rows", "tok"], params: { region: "APAC" } });
  await vic.until((f) => f.type === "state" && f.cell === "tok" && (f.state === "ok" || f.state === "error"));
  expect(vic.printed("tok")).toContain("token length 16"); // ana's, not vic's (vic has none)
  const rows = vic.frames.find((f) => f.type === "event" && f.cell === "rows" && f.event.type === "table");
  expect(rows).toBeTruthy();
  expect(vic.frames.find((f) => f.type === "state" && f.cell === "rows" && f.state === "ok")?.ran?.params).toEqual({ region: "EMEA" });
  // code questions aren't a viewer's
  vic.send({ op: "complete", id: 7, lang: "sql", source: "SEL", pos: 3 });
  await vic.until((f) => f.type === "denied" && f.op === "complete");
  vic.close();
});

test("no tag to bind: the run is refused, not run unbound", async () => {
  const carl = await Tab.open("carl", "w/r/report");
  await carl.until((f) => f.type === "replayed");
  carl.send({ op: "run", cells: ["rows"], params: {} });
  const d = await carl.until((f) => f.type === "denied");
  expect(d.message).toContain("from your region");
  expect(carl.frames.some((f) => f.type === "state" && f.state === "running")).toBe(false);
  carl.close();
});

test("the live notebook moves on; viewers get what was published until it is published again", async () => {
  expect((await api("ana", "PUT", "/workspaces/w/notebooks/r/cells/rows", { source: "SELECT 'changed' AS region;\n" })).status).toBe(200);
  expect((await api("ana", "GET", "/workspaces/w/notebooks/r")).body.published.changed).toBe(true);
  const vic = await Tab.open("vic", "w/r/report");
  await vic.until((f) => f.type === "replayed");
  vic.send({ op: "restart" });
  await vic.until((f) => f.type === "session" && f.state === "ready");
  vic.frames = [];
  vic.send({ op: "run", cells: ["params", "rows"], params: {} });
  const ok = await vic.until((f) => f.type === "state" && f.cell === "rows" && f.state === "ok");
  expect(ok.ran.params).toEqual({ region: "EMEA" }); // the published SELECT $region, not 'changed'
  vic.close();
});

test("run as each viewer: their own connections (vic has no token); republishing reloads open viewers", async () => {
  const vic = await Tab.open("vic", "w/r/report");
  await vic.until((f) => f.type === "replayed");
  expect((await api("ana", "POST", "/workspaces/w/notebooks/r/published", { runAs: "viewer" })).status).toBe(200);
  await vic.until((f) => f.type === "notebook"); // told to reload what is published
  // the same tab goes on, in the new report kernel
  vic.frames = [];
  vic.send({ op: "run", cells: ["tok"], params: {} });
  await vic.until((f) => f.type === "state" && f.cell === "tok" && f.state === "ok");
  vic.close();
  const again = await Tab.open("vic", "w/r/report");
  await again.until((f) => f.type === "replayed");
  again.send({ op: "run", cells: ["tok"], params: {} });
  await again.until((f) => f.type === "state" && f.cell === "tok" && f.state === "ok");
  expect(again.printed("tok")).toContain("token length 0");
  again.close();
});

test("scheduled as its owner: a viewer opening it gets the result already run, before running anything", async () => {
  expect((await api("ana", "POST", "/workspaces/w/notebooks/r/published", { runAs: "owner", schedule: { every: 0.05 } })).status).toBe(200);
  // the first scheduled run comes a second after publishing
  for (let i = 0; i < 100; i++) {
    const log = (await api("root", "GET", "/admin/audit?action=report.scheduled")).body.entries;
    if (log.length) {
      expect(log[0].decision).toBe("ok");
      break;
    }
    await Bun.sleep(200);
  }
  expect((await api("vic", "GET", "/workspaces/w/notebooks/r/published")).body.published.snapshotAt).toBeGreaterThan(0);
  const carl = await Tab.open("carl", "w/r/report");
  const seeded = await carl.until((f) => f.type === "state" && f.cell === "tok" && f.state === "ok");
  expect(seeded.ran).toBeTruthy();
  expect(carl.printed("tok")).toContain("token length 16"); // the owner's run
  expect(carl.frames.some((f) => f.type === "session" && f.state === "ready")).toBe(false); // no kernel of carl's
  carl.close();
  expect((await api("ana", "DELETE", "/workspaces/w/notebooks/r/published")).status).toBe(200);
  expect((await api("vic", "GET", "/workspaces/w/notebooks/r/published")).status).toBe(404);
}, 60_000);

/** An environment applied: wait for its build. */
async function applied(path: string, kind: "python" | "js", deps: string[]) {
  const put = await api("ana", "PUT", `${path}/environment/${kind}`, { dependencies: deps });
  expect(put.status).toBe(200);
  for (let i = 0; i < 600; i++) {
    const s = (await api("ana", "GET", `${path}/environment`)).body[kind];
    if (s.status !== "building") return s;
    await Bun.sleep(250);
  }
  throw new Error("still building");
}

test("environments: a Member applies packages; kernels import them; a published report keeps its own; templates import declared npm packages", async () => {
  expect((await api("vic", "PUT", "/workspaces/w/environment/python", { dependencies: ["tabulate"] })).status).toBe(403); // a Viewer
  const py = await applied("/workspaces/w", "python", ["tabulate"]);
  expect(py).toMatchObject({ status: "ready", dependencies: ["tabulate"], changed: false });
  // ana's kernel imports it
  const ana = await Tab.open("ana", "w/r");
  await ana.until((f) => f.type === "replayed");
  ana.send({ op: "run", cells: ["pkg"], params: {} });
  await ana.until((f) => f.type === "state" && f.cell === "pkg" && f.state === "ok");
  expect(ana.printed("pkg")).toContain("tabulate yes");
  ana.close();
  // published with it: the workspace dropping it later doesn't reach the report
  expect((await api("ana", "POST", "/workspaces/w/notebooks/r/published", { runAs: "owner" })).status).toBe(200);
  expect((await applied("/workspaces/w", "python", [])).status).toBe("none");
  const vic = await Tab.open("vic", "w/r/report");
  await vic.until((f) => f.type === "replayed");
  vic.send({ op: "run", cells: ["pkg"], params: {} });
  await vic.until((f) => f.type === "state" && f.cell === "pkg" && f.state === "ok");
  expect(vic.printed("pkg")).toContain("tabulate yes");
  vic.close();
  // and the live notebook doesn't have it any more
  const again = await Tab.open("ana", "w/r");
  await again.until((f) => f.type === "replayed");
  again.send({ op: "restart" });
  await again.until((f) => f.type === "session" && f.state === "ready");
  again.frames = [];
  again.send({ op: "run", cells: ["pkg"], params: {} });
  await again.until((f) => f.type === "state" && f.cell === "pkg" && f.state === "ok");
  expect(again.printed("pkg")).toContain("tabulate no");
  again.close();
  // templates: a declared npm package bundles; one not declared is refused
  expect((await applied("/workspaces/w/notebooks/r", "js", ["ms@^2"])).status).toBe("ready");
  const tpl = (src: string) => api("ana", "PUT", "/workspaces/w/notebooks/r/template", { source: src });
  const ok = (await tpl(`<script>import ms from "ms";</script><p>{ms(60000)}</p>`)).body;
  expect(ok.error).toBeNull();
  const no = (await tpl(`<script>import pad from "left-pad";</script><p>{pad("x", 3)}</p>`)).body;
  expect(no.error.message).toContain('not "left-pad"');
}, 240_000);

test("public links: off until an admin allows them; networks, passcode, expiry; the owner's last run served, no code", async () => {
  const anon = (path: string, init: RequestInit = {}) => fetch(`http://localhost:${PORT}${path}`, init);
  const link = (who: string, body: object) => api(who, "PUT", "/workspaces/w/notebooks/r/published/public", body);
  expect((await api("ana", "POST", "/workspaces/w/notebooks/r/published", { runAs: "owner" })).status).toBe(200);

  // off until an administrator turns them on, within networks every link must stay in
  expect((await link("ana", { refresh: 5 })).status).toBe(400);
  expect((await api("ana", "PUT", "/admin/auth/public", { enabled: true })).status).toBe(403);
  expect((await api("root", "PUT", "/admin/auth/public", { enabled: true, networks: ["127.0.0.0/8", "::1/128", "10.0.0.0/8"] })).status).toBe(200);
  expect((await link("vic", { refresh: 5 })).status).toBe(403); // a Viewer doesn't make links
  expect((await link("ana", { refresh: 5, networks: ["192.168.0.0/16"] })).status).toBe(400); // outside the server's
  expect((await link("ana", { refresh: 5, embed: ["not a site"] })).status).toBe(400);

  const made = (await link("ana", { refresh: 5, passcode: "sesame-123" })).body;
  expect(made).toMatchObject({ refresh: 5, passcode: true, embed: "none" });
  const token = made.token as string;
  expect(made.path).toBe(`/p/${token}`);
  expect((await api("ana", "GET", "/workspaces/w/notebooks/r/published")).body.published.public.token).toBe(token);
  expect((await api("vic", "GET", "/workspaces/w/notebooks/r/published")).body.published.public).toBeUndefined();

  // the passcode first; a wrong one refused
  expect((await anon(`/api/public/${token}`)).status).toBe(401);
  expect((await anon(`/api/public/${token}/unlock`, { method: "POST", body: JSON.stringify({ passcode: "wrong" }) })).status).toBe(401);
  const unlocked = await anon(`/api/public/${token}/unlock`, { method: "POST", body: JSON.stringify({ passcode: "sesame-123" }) });
  const cookie = /querier_public_[^=;]+=[^;]+/.exec(unlocked.headers.get("set-cookie") ?? "")![0];
  const meta = await (await anon(`/api/public/${token}`, { headers: { cookie } })).json();
  expect(meta.cells.find((c: any) => c.name === "tok").source).toBe(""); // no code
  expect(meta.cells.find((c: any) => c.name === "tok").hash).toBeTruthy();
  expect(meta.params).toEqual([]); // nobody sets PARAMs: their defaults

  // the first visit starts a run as the owner; then it is served, refreshed when older than the link says
  let out = await anon(`/api/public/${token}/outputs`, { headers: { cookie } });
  for (let i = 0; i < 200 && out.status === 202; i++) (await Bun.sleep(200), (out = await anon(`/api/public/${token}/outputs`, { headers: { cookie } })));
  expect(out.status).toBe(200);
  const buf = new Uint8Array(await out.arrayBuffer());
  const frames: any[] = [];
  for (let at = 0; at < buf.length; ) {
    const view = new DataView(buf.buffer, buf.byteOffset + at);
    const n = view.getUint32(0);
    frames.push(JSON.parse(new TextDecoder().decode(buf.subarray(at + 4, at + 4 + n))));
    at += 8 + n + view.getUint32(4 + n);
  }
  expect(frames.at(-1).type).toBe("replayed");
  expect(frames.some((f) => f.type === "event" && f.cell === "tok" && f.event.text?.includes("token length 16"))).toBe(true); // ana's token
  expect(frames.some((f) => f.event?.traceback)).toBe(false);

  // the page: not framed by other sites, its address not passed on (when the UI is built)
  const page = await anon(`/p/${token}`);
  if (page.status === 200) {
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  }

  // a network it isn't opened from; an embedder; then an expiry that passes
  expect((await link("ana", { refresh: 5, networks: ["10.0.0.0/8"] })).status).toBe(200);
  expect((await anon(`/api/public/${token}`, { headers: { cookie } })).status).toBe(403);
  expect((await anon(`/p/${token}`)).status).toBe(403);
  expect((await link("ana", { refresh: 5, embed: ["https://intranet.example.com"] })).body.embed).toEqual(["https://intranet.example.com"]);
  expect((await link("ana", { refresh: 5, expires: Date.now() - 1000 })).status).toBe(400);
  expect((await link("ana", { refresh: 5, expires: Date.now() + 800 })).status).toBe(200);
  await Bun.sleep(1000);
  expect((await anon(`/api/public/${token}`, { headers: { cookie } })).status).toBe(410);

  // a new address: the old one is gone; the passcode kept
  expect((await link("ana", { refresh: 5 })).body.passcode).toBe(true);
  const rotated = (await api("ana", "POST", "/workspaces/w/notebooks/r/published/public/token")).body.token as string;
  expect(rotated).not.toBe(token);
  expect((await anon(`/api/public/${token}`, { headers: { cookie } })).status).toBe(404);
  expect((await anon(`/api/public/${rotated}`)).status).toBe(401);

  // off again, server-wide: every link is gone from the outside
  expect((await api("root", "PUT", "/admin/auth/public", { enabled: false })).status).toBe(200);
  expect((await anon(`/api/public/${rotated}`)).status).toBe(404);
  expect((await api("root", "PUT", "/admin/auth/public", { enabled: true })).status).toBe(200);
  // published to run as each viewer: it can't be public, the link goes
  expect((await api("ana", "POST", "/workspaces/w/notebooks/r/published", { runAs: "viewer" })).status).toBe(200);
  expect((await api("ana", "GET", "/workspaces/w/notebooks/r/published")).body.published.public).toBeNull();
  expect((await api("root", "GET", "/admin/audit?action=report.public")).body.entries.length).toBeGreaterThan(3);
}, 120_000);
