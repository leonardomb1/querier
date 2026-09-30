// Terminals end to end: a shell in one's own kernel, over the kernel socket. The
// sandbox is a microVM in production; here a local kernel stands in for it, which
// the server allows only with QUERIER_ALLOW_LOCAL_SHELL (and refuses without).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../server/auth/db";
import type { Principal } from "../server/auth/principal";
import { Sessions } from "../server/auth/sessions";

let dir: string;
const servers: ReturnType<typeof Bun.spawn>[] = [];
const cookies: Record<string, string> = {};

const person = (id: string): Principal => ({ id: `corp:${id}`, provider: "corp", subject: id, username: id, groups: [], attrs: {} });

async function start(port: number, config: string, extra: Record<string, string>) {
  const server = Bun.spawn(["bun", resolve(import.meta.dir, "../server/app.ts"), "--port", String(port), "--notebooks", join(dir, "nb")], {
    cwd: dir,
    env: { ...process.env, QUERIER_CONFIG_DIR: join(dir, config), QUERIER_ADMIN_USER: "root", QUERIER_ADMIN_PASSWORD_HASH: await Bun.password.hash("root-pass"), QUERIER_ADMIN_PASSWORD: "", QUERIER_RUNNER: "", ...extra },
    stdout: "pipe",
    stderr: "pipe",
  });
  servers.push(server);
  for (let i = 0; i < 100 && !(await fetch(`http://localhost:${port}/api/auth/providers`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
  const login = await fetch(`http://localhost:${port}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "sysadmin", username: "root", password: "root-pass" }) });
  const root = /querier_session=[^;]+/.exec(login.headers.get("set-cookie") ?? "")![0];
  const grant = (id: string, role: string) =>
    fetch(`http://localhost:${port}/api/workspaces/w/access`, { method: "POST", headers: { cookie: root, "content-type": "application/json" }, body: JSON.stringify({ subject: { kind: "user", id }, role }) });
  expect((await grant("corp:ana", "Contributor")).status).toBe(200);
  expect((await grant("corp:vic", "Viewer")).status).toBe(200);
  const sessions = new Sessions(openDb(join(dir, config, "querier.db")), () => ({ absoluteHours: 1, idleMinutes: 60, refreshMinutes: 60 }));
  for (const n of ["ana", "vic"]) cookies[`${port}:${n}`] = `querier_session=${sessions.create(person(n)).id}`;
}

/** A tab with a terminal: what the shell printed, and how it ended. */
async function terminal(port: number, who: string) {
  const ws = new WebSocket(`ws://localhost:${port}/ws/w/nb`, { headers: { cookie: cookies[`${port}:${who}`] } } as any);
  ws.binaryType = "arraybuffer";
  const t = { out: "", exit: null as null | { code?: number | null; message?: string }, ws };
  ws.onmessage = (e) => {
    const buf = new Uint8Array(e.data as ArrayBuffer);
    const view = new DataView(buf.buffer);
    const n = view.getUint32(0);
    const meta = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + n)));
    const data = buf.subarray(8 + n, 8 + n + view.getUint32(4 + n));
    if (meta.term !== "t1") return;
    if (meta.type === "terminal-output") t.out += new TextDecoder().decode(data);
    if (meta.type === "terminal-exit") t.exit = { code: meta.code, message: meta.message };
  };
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ op: "terminal-open", term: "t1", cols: 100, rows: 30 }));
  return t;
}

const until = async (ok: () => boolean, ms = 20_000) => {
  for (let t = 0; t < ms && !ok(); t += 50) await Bun.sleep(50);
  return ok();
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "querier-terminal-"));
  await mkdir(join(dir, "nb/w/nb"), { recursive: true });
  await Bun.write(join(dir, "nb/w/workspace.json"), JSON.stringify({ title: "w" }));
  await Bun.write(join(dir, "nb/w/nb/01_q.sql"), "SELECT 1 AS one;\n");
  await start(3940, "config-local", { QUERIER_ALLOW_LOCAL_SHELL: "1" });
  await start(3941, "config-server", {});
});

afterAll(async () => {
  for (const s of servers) s.kill();
  await rm(dir, { recursive: true, force: true });
});

test("a terminal: a shell in one's kernel, in the notebook's folder, until it exits", async () => {
  const t = await terminal(3940, "ana");
  t.ws.send(JSON.stringify({ op: "terminal-input", term: "t1", data: "echo made-$((6*7)); ls\n" }));
  expect(await until(() => t.out.includes("made-42") && t.out.includes("01_q.sql"))).toBe(true);
  t.ws.send(JSON.stringify({ op: "terminal-resize", term: "t1", cols: 50, rows: 10 }));
  t.ws.send(JSON.stringify({ op: "terminal-input", term: "t1", data: "stty size; exit 3\n" }));
  expect(await until(() => t.exit !== null)).toBe(true);
  expect(t.out).toContain("10 50");
  expect(t.exit!.code).toBe(3);
  t.ws.close();
}, 30_000);

test("a viewer can't open one", async () => {
  const t = await terminal(3940, "vic");
  expect(await until(() => t.exit !== null, 5000)).toBe(true);
  expect(t.exit!.message).toContain("permission");
  t.ws.close();
});

test("a kernel that isn't a sandbox gets no terminal", async () => {
  const t = await terminal(3941, "ana");
  expect(await until(() => t.exit !== null)).toBe(true);
  expect(t.exit!.message).toContain("only in the microVM sandbox");
  t.ws.close();
}, 30_000);
