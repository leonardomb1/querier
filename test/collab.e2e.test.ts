// Editing together end to end: the real server, people with sessions, and the
// notebook's room as their pages speak to it (y-websocket's protocol).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { openDb } from "../server/auth/db";
import type { Principal } from "../server/auth/principal";
import { Sessions } from "../server/auth/sessions";

const PORT = 3960 + Math.floor(Math.random() * 5);
const B = `http://localhost:${PORT}`;
let dir: string;
let server: ReturnType<typeof Bun.spawn>;
const cookies: Record<string, string> = {};

const person = (id: string, name: string): Principal => ({ id: `corp:${id}`, provider: "corp", subject: id, username: id, name, groups: [], attrs: {} });

/** A page in the room: its copy of the text, and who it sees. */
class Page {
  doc = new Y.Doc();
  awareness = new awarenessProtocol.Awareness(this.doc);
  ws: WebSocket;
  synced: Promise<void>;
  private flushed = new Map<number, () => void>();

  constructor(who: string) {
    this.ws = new WebSocket(`ws://localhost:${PORT}/ws/team/plan/collab`, { headers: { cookie: cookies[who] } } as any);
    this.ws.binaryType = "arraybuffer";
    let ready!: () => void;
    this.synced = new Promise((r) => (ready = r));
    this.doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeUpdate(enc, u);
      this.ws.send(encoding.toUint8Array(enc));
    });
    this.awareness.on("update", ({ added, updated, removed }: any, origin: unknown) => {
      if (origin !== "local") return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 1);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]));
      this.ws.send(encoding.toUint8Array(enc));
    });
    this.ws.onopen = () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, this.doc);
      this.ws.send(encoding.toUint8Array(enc));
    };
    this.ws.onmessage = (e) => {
      const dec = decoding.createDecoder(new Uint8Array(e.data as ArrayBuffer));
      const kind = decoding.readVarUint(dec);
      if (kind === 0) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, 0);
        const step = syncProtocol.readSyncMessage(dec, enc, this.doc, this);
        if (encoding.length(enc) > 1) this.ws.send(encoding.toUint8Array(enc));
        if (step === syncProtocol.messageYjsSyncStep2) ready();
      } else if (kind === 1) awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), this);
      else if (kind === 3) this.flushed.get(decoding.readVarUint(dec))?.();
    };
  }

  text(cell: string) {
    return this.doc.getMap<Y.Text>("cells").get(cell)!;
  }

  flush(): Promise<void> {
    const id = Math.floor(Math.random() * 1e6);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 3);
    encoding.writeVarUint(enc, id);
    this.ws.send(encoding.toUint8Array(enc));
    return new Promise((r) => this.flushed.set(id, r));
  }

  others() {
    return [...this.awareness.getStates()].filter(([c]) => c !== this.doc.clientID).map(([, s]) => s);
  }

  close() {
    this.ws.close();
  }
}

const until = async (ok: () => boolean, ms = 3000) => {
  for (let t = 0; t < ms && !ok(); t += 25) await Bun.sleep(25);
  return ok();
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "querier-collab-"));
  await mkdir(join(dir, "nb", "team", "plan"), { recursive: true });
  await Bun.write(join(dir, "nb", "team", "workspace.json"), JSON.stringify({ title: "team" }));
  await Bun.write(join(dir, "nb", "team", "plan", "01_q.sql"), "SELECT 1 AS one;\n");
  await Bun.write(join(dir, "nb", "team", "plan", "02_py.py"), "x = 1\n");
  const env: Record<string, string | undefined> = { ...process.env, QUERIER_CONFIG_DIR: join(dir, "config"), QUERIER_ADMIN_USER: "root", QUERIER_ADMIN_PASSWORD_HASH: await Bun.password.hash("root-pass") };
  delete env.QUERIER_ADMIN_PASSWORD;
  server = Bun.spawn(["bun", resolve(import.meta.dir, "../server/app.ts"), "--port", String(PORT), "--notebooks", join(dir, "nb")], { env, cwd: dir, stdout: "pipe", stderr: "pipe" });
  for (let i = 0; i < 100 && !(await fetch(`${B}/api/auth/providers`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
  const login = await fetch(`${B}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "sysadmin", username: "root", password: "root-pass" }) });
  cookies.root = /querier_session=[^;]+/.exec(login.headers.get("set-cookie") ?? "")![0];
  const db = openDb(join(dir, "config/querier.db"));
  const sessions = new Sessions(db, () => ({ absoluteHours: 1, idleMinutes: 60, refreshMinutes: 60 }));
  for (const [key, p] of Object.entries({ ana: person("ana", "Ana Lima"), bob: person("bob", "Bob Stone"), vic: person("vic", "Vic Viewer") })) {
    cookies[key] = `querier_session=${sessions.create(p).id}`;
    db.query("INSERT INTO users (id, provider, username, principal, last_login) VALUES (?, ?, ?, ?, ?)").run(p.id, p.provider, p.username, JSON.stringify(p), Date.now());
  }
  const grant = (id: string, role: string) =>
    fetch(`${B}/api/workspaces/team/access`, { method: "POST", headers: { cookie: cookies.root, "content-type": "application/json" }, body: JSON.stringify({ subject: { kind: "user", id }, role }) });
  expect((await grant("corp:ana", "Contributor")).status).toBe(200);
  expect((await grant("corp:bob", "Contributor")).status).toBe(200);
  expect((await grant("corp:vic", "Viewer")).status).toBe(200);
});

afterAll(async () => {
  server?.kill();
  await rm(dir, { recursive: true, force: true });
});

test("two people type in the same cell at once: both edits land, for both, and in the file", async () => {
  const ana = new Page("ana");
  const bob = new Page("bob");
  await Promise.all([ana.synced, bob.synced]);
  expect(ana.text("q").toString()).toBe("SELECT 1 AS one;\n");

  ana.text("q").insert(0, "-- ana\n");
  bob.text("q").insert(bob.text("q").length, "-- bob\n");
  expect(await until(() => ana.text("q").toString() === bob.text("q").toString() && ana.text("q").toString().includes("-- bob"))).toBe(true);
  expect(ana.text("q").toString()).toBe("-- ana\nSELECT 1 AS one;\n-- bob\n");

  await ana.flush();
  expect(await Bun.file(join(dir, "nb/team/plan/01_q.sql")).text()).toBe("-- ana\nSELECT 1 AS one;\n-- bob\n");
  ana.close();
  bob.close();
});

test("presence: who someone is comes from the server, not their page", async () => {
  const ana = new Page("ana");
  const bob = new Page("bob");
  await Promise.all([ana.synced, bob.synced]);
  ana.awareness.setLocalState({ cell: "py", cursor: null, user: { id: "corp:root", name: "The Boss", color: 0 } });
  expect(await until(() => bob.others().some((s: any) => s.cell === "py"))).toBe(true);
  const seen: any = bob.others().find((s: any) => s.cell === "py");
  expect(seen.user.id).toBe("corp:ana");
  expect(seen.user.name).toBe("Ana Lima");

  // gone with their page
  ana.close();
  expect(await until(() => !bob.others().some((s: any) => s.user?.id === "corp:ana"))).toBe(true);
  bob.close();
});

test("a viewer is present, sees the text as it is typed, and can't change it", async () => {
  const ana = new Page("ana");
  const vic = new Page("vic");
  await Promise.all([ana.synced, vic.synced]);
  ana.text("py").insert(0, "# by ana\n");
  expect(await until(() => vic.text("py").toString().startsWith("# by ana"))).toBe(true);

  vic.text("py").insert(0, "import os  # by vic\n");
  await Bun.sleep(400);
  await ana.flush();
  expect(ana.text("py").toString()).not.toContain("by vic");
  expect(await Bun.file(join(dir, "nb/team/plan/02_py.py")).text()).not.toContain("by vic");
  ana.close();
  vic.close();
});

test("changes made to the files otherwise (an AI client, a pull, a new cell) come into the room", async () => {
  const ana = new Page("ana");
  await ana.synced;
  const put = await fetch(`${B}/api/workspaces/team/notebooks/plan/cells/py`, {
    method: "PUT",
    headers: { cookie: cookies.bob, "content-type": "application/json" },
    body: JSON.stringify({ source: "y = 2\n" }),
  });
  expect(put.status).toBe(200);
  expect(await until(() => ana.text("py").toString() === "y = 2\n")).toBe(true);

  const added = await fetch(`${B}/api/workspaces/team/notebooks/plan/cells`, {
    method: "POST",
    headers: { cookie: cookies.bob, "content-type": "application/json" },
    body: JSON.stringify({ lang: "sql", after: "py", source: "SELECT 2;\n" }),
  });
  const { name } = (await added.json()) as { name: string };
  expect(await until(() => ana.text(name)?.toString() === "SELECT 2;\n")).toBe(true);
  ana.close();
});

test("only who may see the notebook's code joins its room", async () => {
  const res = await fetch(`${B}/ws/team/plan/collab`, { headers: { upgrade: "websocket", connection: "upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
  expect(res.status).toBe(401);
});
