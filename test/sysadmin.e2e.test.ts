// The first start with no sysadmin in the environment: Querier makes its own,
// prints the generated password, the first sign-in is asked for a new one, and
// after it the generated one no longer works.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 3970 + Math.floor(Math.random() * 5);
const B = `http://localhost:${PORT}`;
let dir: string;
let server: ReturnType<typeof Bun.spawn>;
let log = "";

async function start(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, QUERIER_CONFIG_DIR: join(dir, "config"), ...extra };
  for (const k of ["QUERIER_ADMIN_USER", "QUERIER_ADMIN_PASSWORD_HASH", "QUERIER_ADMIN_PASSWORD", "QUERIER_PUBLIC_URL", "QUERIER_ALLOW_INSECURE_LOGIN"]) delete env[k];
  if (!extra.QUERIER_ALLOW_HTTP) delete env.QUERIER_ALLOW_HTTP;
  log = "";
  // cwd: the temporary folder, so the repository's .env isn't read
  server = Bun.spawn(["bun", resolve(import.meta.dir, "../server/app.ts"), "--port", String(PORT), "--notebooks", join(dir, "nb")], { env, cwd: dir, stdout: "pipe", stderr: "pipe" });
  (async () => {
    for await (const chunk of server.stdout as ReadableStream<Uint8Array>) log += new TextDecoder().decode(chunk);
  })();
  for (let i = 0; i < 100 && !(await fetch(`${B}/api/auth/providers`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
}

const login = (username: string, password: string) =>
  fetch(`${B}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "sysadmin", username, password }) });
const cookieOf = (r: Response) => /querier_session=[^;]+/.exec(r.headers.get("set-cookie") ?? "")?.[0] ?? "";
const me = (cookie: string) => fetch(`${B}/api/me`, { headers: { cookie } }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
const change = (cookie: string, current: string, password: string) =>
  fetch(`${B}/api/me/password`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ current, password }) }).then(async (r) => ({
    status: r.status,
    body: (await r.json()) as any,
  }));

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "querier-sysadmin-"));
  await mkdir(join(dir, "nb"), { recursive: true });
  await start();
});

afterAll(async () => {
  server?.kill();
  await rm(dir, { recursive: true, force: true });
});

test("first start: a generated password in the log; signing in with it asks for a new one", async () => {
  const generated = log.match(/password: (\S+)/)?.[1];
  expect(generated).toBeTruthy();
  expect(log).toContain("username: admin");

  const r = await login("admin", generated!);
  expect(r.status).toBe(200);
  const cookie = cookieOf(r);
  expect((await me(cookie)).body.password).toEqual({ changeable: true, mustChange: true });

  // too short is refused; the generated one isn't asked (signing in proved it)
  expect((await change(cookie, "", "short")).status).toBe(400);
  const ok = await change(cookie, "", "the admin's own passphrase");
  expect(ok.status).toBe(200);
  expect(ok.body.password).toEqual({ changeable: true, mustChange: false });

  // this session goes on; the generated password is gone
  expect((await me(cookie)).body.password.mustChange).toBe(false);
  expect((await login("admin", generated!)).status).toBe(401);
  const again = await login("admin", "the admin's own passphrase");
  expect(again.status).toBe(200);

  // from now on the current password is asked, and a wrong one refused
  expect((await change(cookieOf(again), "wrong", "yet another passphrase")).status).toBe(403);
});

test("a restart: the password stays, and nothing is printed", async () => {
  server.kill();
  await server.exited;
  await start();
  expect(log).not.toContain("password:");
  expect((await login("admin", "the admin's own passphrase")).status).toBe(200);
});

test("only the sysadmin's password is Querier's to change", async () => {
  expect((await change("", "", "whatever it is")).status).toBe(401);
});

test("plain HTTP from another machine: passwords refused, unless QUERIER_ALLOW_HTTP opts out", async () => {
  // as reached by a name that isn't this machine's (the Host header), over http://
  const remote = (password: string) =>
    fetch(`${B}/api/auth/login`, { method: "POST", headers: { host: "querier.corp", "content-type": "application/json" }, body: JSON.stringify({ provider: "sysadmin", username: "admin", password }) });
  expect((await fetch(`${B}/api/auth/providers`).then((r) => r.json())).httpAllowed).toBe(false);
  const refused = await remote("the admin's own passphrase");
  expect(refused.status).toBe(403);
  expect((await refused.json()).error).toContain("QUERIER_ALLOW_HTTP=1");

  server.kill();
  await server.exited;
  await start({ QUERIER_ALLOW_HTTP: "1" });
  expect((await fetch(`${B}/api/auth/providers`).then((r) => r.json())).httpAllowed).toBe(true);
  expect((await remote("the admin's own passphrase")).status).toBe(200);
  expect((await remote("wrong")).status).toBe(401);
});
