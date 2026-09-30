// Access control end to end: the real server, people with sessions (as if they
// had signed in through a directory), grants made over the API, and what each
// of them can then do over HTTP and the kernel socket.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../server/auth/db";
import type { Principal } from "../server/auth/principal";
import { Sessions } from "../server/auth/sessions";

const PORT = 3990 + Math.floor(Math.random() * 5);
const B = `http://localhost:${PORT}`;
let dir: string;
let server: ReturnType<typeof Bun.spawn>;
const cookies: Record<string, string> = {};

const person = (id: string, groups: string[], attrs: Record<string, string[]> = {}): Principal => ({ id: `corp:${id}`, provider: "corp", subject: id, username: id, groups, attrs });

async function http(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${B}/api${path}`, {
    method,
    headers: { cookie: cookies[who] ?? "", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

/** Open the kernel socket, send one message, collect frame types for a moment. */
async function socket(who: string, nb: string, send?: object): Promise<{ opened: boolean; types: string[]; denied: string[] }> {
  const types: string[] = [];
  const denied: string[] = [];
  const ws = new WebSocket(`ws://localhost:${PORT}/ws/${nb}`, { headers: { cookie: cookies[who] ?? "" } } as any);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (e) => {
    const buf = new Uint8Array(e.data as ArrayBuffer);
    const meta = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + new DataView(buf.buffer).getUint32(0))));
    types.push(meta.type);
    if (meta.type === "denied") denied.push(meta.message);
  };
  const opened = await new Promise<boolean>((r) => ((ws.onopen = () => r(true)), (ws.onerror = () => r(false)), (ws.onclose = () => r(false))));
  if (opened && send) ws.send(JSON.stringify(send));
  await Bun.sleep(opened ? 700 : 0);
  ws.close();
  return { opened, types, denied };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "querier-authz-"));
  for (const [ws, nb] of [["finance", "forecast"], ["finance", "payroll"], ["sales", "pipeline"]]) {
    await mkdir(join(dir, "nb", ws, nb), { recursive: true });
    await Bun.write(join(dir, "nb", ws, "workspace.json"), JSON.stringify({ title: ws }));
    await Bun.write(join(dir, "nb", ws, nb, "01_q.sql"), "SELECT 1 AS one;\n");
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    QUERIER_CONFIG_DIR: join(dir, "config"),
    QUERIER_ADMIN_USER: "root",
    QUERIER_ADMIN_PASSWORD_HASH: await Bun.password.hash("root-pass"),
  };
  delete env.QUERIER_ADMIN_PASSWORD;
  // cwd: the temporary folder, so the repository's .env isn't read
  server = Bun.spawn(["bun", resolve(import.meta.dir, "../server/app.ts"), "--port", String(PORT), "--notebooks", join(dir, "nb")], { env, cwd: dir, stdout: "pipe", stderr: "pipe" });
  for (let i = 0; i < 100 && !(await fetch(`${B}/api/auth/providers`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
  // the sysadmin signs in; the others as if their directory had let them in
  const login = await fetch(`${B}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "sysadmin", username: "root", password: "root-pass" }) });
  cookies.root = /querier_session=[^;]+/.exec(login.headers.get("set-cookie") ?? "")![0];
  const sessions = new Sessions(openDb(join(dir, "config/querier.db")), () => ({ absoluteHours: 1, idleMinutes: 60, refreshMinutes: 60 }));
  const people = { ana: person("ana", ["finance-analysts"]), bob: person("bob", [], { department: ["Sales"] }), eve: person("eve", []) };
  const db = openDb(join(dir, "config/querier.db"));
  for (const [name, p] of Object.entries(people)) {
    cookies[name] = `querier_session=${sessions.create(p).id}`;
    // as their sign-in would have: known by id from now on
    db.query("INSERT INTO users (id, provider, username, principal, last_login) VALUES (?, ?, ?, ?, ?)").run(p.id, p.provider, p.username, JSON.stringify(p), Date.now());
  }
});

afterAll(async () => {
  server?.kill();
  await rm(dir, { recursive: true, force: true });
});

test("before any grant: signed in, nothing visible", async () => {
  expect((await http("eve", "GET", "/workspaces")).body.workspaces).toEqual([]);
  expect((await http("eve", "GET", "/workspaces/finance/notebooks/forecast")).status).toBe(403);
  expect((await socket("eve", "finance/forecast")).opened).toBe(false);
  expect((await http("nobody", "GET", "/workspaces")).status).toBe(401);
});

test("grants over the API: a group's role, an attribute condition, a single share", async () => {
  expect((await http("root", "POST", "/workspaces/finance/access", { subject: { kind: "group", name: "finance-analysts" }, role: "Contributor" })).status).toBe(200);
  const cond = 'principal.hasTag("department") && principal.getTag("department").contains("Sales")';
  expect((await http("root", "POST", "/workspaces/sales/access", { subject: { kind: "condition", when: cond }, role: "Viewer" })).status).toBe(200);
  expect((await http("root", "POST", "/workspaces/finance/notebooks/forecast/access", { subject: { kind: "user", id: "corp:eve" }, role: "Read" })).status).toBe(200);
  // a condition that isn't a safe policy is refused
  const bad = await http("root", "POST", "/workspaces/sales/access", { subject: { kind: "condition", when: 'principal.getTag("x").contains("y")' }, role: "Viewer" });
  expect(bad.status).toBe(400);
  expect(bad.body.error).toContain("isn't a valid policy");
  // a role changed as the dialog does it: the new one first, then the old one goes
  const viewer = (await http("root", "POST", "/workspaces/sales/access", { subject: { kind: "user", id: "corp:eve" }, role: "Viewer" })).body;
  expect((await http("root", "POST", "/workspaces/sales/access", { subject: { kind: "user", id: "corp:eve" }, role: "Contributor" })).status).toBe(200);
  expect((await http("root", "DELETE", `/workspaces/sales/access/${viewer.id}`)).status).toBe(200);
  const eveSales = (await http("root", "GET", "/workspaces/sales/access")).body.grants.filter((g: any) => g.subject.id === "corp:eve");
  expect(eveSales.map((g: any) => g.role)).toEqual(["Contributor"]);
  expect((await http("root", "DELETE", `/workspaces/sales/access/${eveSales[0].id}`)).status).toBe(200);
  // a Contributor can't hand out access
  expect((await http("ana", "POST", "/workspaces/finance/access", { subject: { kind: "user", id: "corp:eve" }, role: "Admin" })).status).toBe(403);
});

test("lists show what each may see, with what they may do", async () => {
  const ana = (await http("ana", "GET", "/workspaces")).body.workspaces;
  expect(ana.map((w: any) => w.name)).toEqual(["finance"]);
  expect(ana[0].permissions).toContain("notebook.create");
  expect(ana[0].permissions).not.toContain("workspace.manageAccess");
  const eve = (await http("eve", "GET", "/workspaces")).body.workspaces;
  expect(eve.map((w: any) => [w.name, w.notebooks.map((n: any) => n.name)])).toEqual([["finance", ["forecast"]]]);
  expect(eve[0].permissions).toEqual([]); // no role in the workspace: just the shared notebook
  expect((await http("bob", "GET", "/workspaces")).body.workspaces.map((w: any) => w.name)).toEqual(["sales"]);
  expect((await http("eve", "GET", "/workspaces")).body.root).toBe(""); // the server's paths are for admins
});

test("each can do what their role allows, and no more", async () => {
  // eve: Read on one notebook
  expect((await http("eve", "GET", "/workspaces/finance/notebooks/forecast")).body.cells[0].source).toContain("SELECT");
  expect((await http("eve", "PUT", "/workspaces/finance/notebooks/forecast/cells/q", { source: "SELECT 2;" })).status).toBe(403);
  expect((await http("eve", "GET", "/workspaces/finance/notebooks/payroll")).status).toBe(403);
  // bob: Viewer of sales (through his department)
  expect((await http("bob", "GET", "/workspaces/sales/notebooks/pipeline")).status).toBe(200);
  expect((await http("bob", "PATCH", "/workspaces/sales/notebooks/pipeline", { title: "x" })).status).toBe(403);
  // ana: Contributor of finance: edits, but can't change the sandbox or delete the workspace
  expect((await http("ana", "PUT", "/workspaces/finance/notebooks/payroll/cells/q", { source: "SELECT 3 AS three;\n" })).status).toBe(200);
  expect((await http("ana", "PATCH", "/workspaces/finance/notebooks/payroll", { sandbox: { memory: 4096 } })).status).toBe(403);
  expect((await http("ana", "DELETE", "/workspaces/finance")).status).toBe(403);
  // a connection for the workspace: connection.manage (Member), not a Contributor's
  expect((await http("ana", "POST", "/connections", { workspace: "finance", name: "pg", variables: ["PG_PASS"], credentials: "shared" })).status).toBe(403);
});

test("what each page is told: permissions, never the server's paths unless an admin", async () => {
  const nb = (await http("eve", "GET", "/workspaces/finance/notebooks/forecast")).body;
  expect(nb.permissions).toEqual(expect.arrayContaining(["notebook.view", "notebook.readCode"]));
  expect(nb.permissions).not.toContain("notebook.run");
  expect((await http("ana", "GET", "/ai/clients")).body.file).toBe("");
  expect((await http("ana", "GET", "/me")).body.permissions).toEqual(["signIn"]); // nothing else outside a workspace
  // the share dialog's suggestions: people who have signed in, and their groups
  const dir = (await http("root", "GET", "/directory?q=")).body;
  expect(dir.people.map((p: any) => p.id)).not.toContain("sysadmin:root");
});

test("the condition editor: checked as typed, and what it can suggest", async () => {
  const bad = (await http("ana", "POST", "/access/check", { when: 'principal.getTag("department").contains("x")' })).body.problems;
  expect(bad[0].start).toBe(0);
  expect((await http("ana", "POST", "/access/check", { when: 'principal.hasTag("department")' })).body.problems).toEqual([]);
  const v = (await http("ana", "GET", "/access/vocabulary")).body;
  expect(Object.keys(v.tags)).toEqual(expect.arrayContaining(["username", "email", "emailDomain"]));
  expect(v.groups).toEqual(expect.any(Array));
  expect(v.resourceTags).toEqual(expect.any(Object));
});

test("a notebook's attributes: set by the workspace's Admin, read by policies", async () => {
  expect((await http("ana", "PUT", "/workspaces/finance/notebooks/payroll/attributes", { attributes: { classification: "open" } })).status).toBe(403);
  expect((await http("root", "PUT", "/workspaces/finance/notebooks/payroll/attributes", { attributes: { classification: "restricted" } })).status).toBe(200);
  expect((await http("ana", "GET", "/workspaces/finance/notebooks/payroll/attributes")).body.attributes).toEqual({ classification: "restricted" });
  const policies = join(dir, "config/policies");
  await mkdir(policies, { recursive: true });
  await Bun.write(
    join(policies, "restricted.cedar"),
    'forbid (principal, action == Action::"notebook.view", resource) when { resource.hasTag("classification") && resource.getTag("classification").contains("restricted") && !(principal in Group::"hr") };\n',
  );
  await Bun.sleep(700);
  expect((await http("ana", "GET", "/workspaces/finance/notebooks/payroll")).status).toBe(403);
  const list = (await http("ana", "GET", "/workspaces")).body.workspaces[0].notebooks.map((n: any) => n.name);
  expect(list).toEqual(["forecast"]);
  await rm(join(policies, "restricted.cedar"));
  await Bun.sleep(700);
  expect((await http("ana", "GET", "/workspaces/finance/notebooks/payroll")).status).toBe(200);
});

test("connections: a workspace's Contributors use its own, never set them; others are given one by its roles", async () => {
  const pg = (await http("root", "POST", "/connections", { workspace: "finance", name: "pg", variables: ["PG_USER", "PG_PASS"], credentials: "shared" })).body;
  expect(pg.id).toBeTruthy();
  expect((await http("root", "PUT", `/connections/${pg.id}/values`, { values: { PG_USER: "svc", PG_PASS: "pg-secret-pass" } })).body.set.sort()).toEqual(["PG_PASS", "PG_USER"]);
  // ana (Contributor of finance) uses it, can't change it; nothing tells her the values
  const seen = (await http("ana", "GET", "/workspaces/finance/notebooks/payroll/connections")).body.connections;
  expect(seen.map((c: any) => [c.name, c.permissions])).toEqual([["pg", ["connection.use"]]]);
  expect(JSON.stringify(seen)).not.toContain("pg-secret-pass");
  expect((await http("ana", "PUT", `/connections/${pg.id}/values`, { values: { PG_PASS: "x" } })).status).toBe(403);
  expect((await http("ana", "DELETE", `/connections/${pg.id}`)).status).toBe(403);
  // eve (a Read share) doesn't have it
  expect((await http("eve", "GET", "/workspaces/finance/notebooks/forecast/connections")).body.connections).toEqual([]);
  // everyone's connection, per person, given to eve as a User: she sets her own
  const gh = (await http("root", "POST", "/connections", { name: "github", variables: ["GIT_TOKEN"], credentials: "per-user" })).body;
  expect((await http("eve", "PUT", `/connections/${gh.id}/mine`, { values: { GIT_TOKEN: "x" } })).status).toBe(403);
  expect((await http("root", "POST", `/connections/${gh.id}/access`, { subject: { kind: "user", id: "corp:eve" }, role: "User" })).status).toBe(200);
  expect((await http("eve", "PUT", `/connections/${gh.id}/mine`, { values: { GIT_TOKEN: "eve-token" } })).body.mine).toEqual(["GIT_TOKEN"]);
  expect((await http("eve", "GET", "/workspaces/finance/notebooks/forecast/connections")).body.connections.map((c: any) => [c.name, c.mine])).toEqual([["github", ["GIT_TOKEN"]]]);
  // an Owner role: only who manages it gives it
  expect((await http("eve", "POST", `/connections/${gh.id}/access`, { subject: { kind: "everyone" }, role: "User" })).status).toBe(403);
});

test("the kernel socket: each message checked; outputs only for those who may run", async () => {
  const eve = await socket("eve", "finance/forecast", { op: "run", cells: ["q"] });
  expect(eve.opened).toBe(true);
  expect(eve.denied[0]).toContain("permission to run");
  const ana = await socket("ana", "finance/payroll", { op: "check", id: 1, source: "SELECT 1", cell: "q" });
  expect(ana.denied).toEqual([]);
  expect(ana.types).toContain("check");
});

test("a custom policy file forbids over a grant, at once; a bad one leaves the good in force", async () => {
  const policies = join(dir, "config/policies");
  await mkdir(policies, { recursive: true });
  await Bun.write(join(policies, "freeze.cedar"), 'forbid (principal, action == Action::"notebook.edit", resource in Workspace::"finance");\n');
  await Bun.sleep(700); // the folder is watched
  expect((await http("ana", "PUT", "/workspaces/finance/notebooks/payroll/cells/q", { source: "SELECT 4;\n" })).status).toBe(403);
  await Bun.write(join(policies, "broken.cedar"), "not cedar at all");
  await Bun.sleep(700);
  expect((await http("ana", "PUT", "/workspaces/finance/notebooks/payroll/cells/q", { source: "SELECT 5;\n" })).status).toBe(403);
});

test("the audit log has the denials", async () => {
  const { Audit } = await import("../server/auth/audit");
  const log = new Audit(openDb(join(dir, "config/querier.db"))).list({ limit: 500 });
  expect(log.some((e) => e.actor === "corp:eve" && e.action === "notebook.edit" && e.decision === "deny")).toBe(true);
  expect(log.some((e) => e.action === "grant.add" && e.actor === "sysadmin:root")).toBe(true);
});

test("the admin console: policy files checked and saved, a decision explained, people, the audit log", async () => {
  expect((await http("ana", "GET", "/admin/policies")).status).toBe(403);
  expect((await http("ana", "GET", "/admin/audit")).status).toBe(403);
  // a file as it is typed: problems placed in it; an unguarded tag, a wrong action
  const text = 'permit (principal, action == Action::"notebook.view", resource) when { principal.getTag("d").contains("x") };';
  const [p] = (await http("root", "POST", "/admin/policies/check", { text })).body.problems;
  expect(p.message).toContain("unable to guarantee safety");
  expect(text.slice(p.start, p.end)).toContain('principal.getTag("d")');
  expect((await http("root", "PUT", "/admin/policies/bad", { text })).status).toBe(400);
  // a good one: saved, and in force at once (eve sees payroll, read-only)
  const good = 'permit (principal == User::"corp:eve", action == Action::"notebook.view", resource == Notebook::"finance/payroll");';
  // with another file broken (the test above's), none can load: the refusal names it
  const refused = await http("root", "PUT", "/admin/policies/eve-payroll", { text: good });
  expect(refused.body.error).toContain("broken.cedar");
  for (const f of ["broken", "freeze"]) expect((await http("root", "DELETE", `/admin/policies/${f}`)).status).toBe(200);
  expect((await http("root", "PUT", "/admin/policies/eve-payroll", { text: good })).body).toEqual({ name: "eve-payroll.cedar" });
  const list = (await http("root", "GET", "/admin/policies")).body;
  expect(list.files.map((f: any) => f.name)).toContain("eve-payroll.cedar");
  expect(list.actions).toContain("notebook.run");
  expect((await http("eve", "GET", "/workspaces/finance/notebooks/payroll")).status).not.toBe(403);
  // why: that file's policy; and a denial with no policy for it
  const why = (await http("root", "POST", "/admin/explain", { principal: "corp:eve", action: "notebook.view", resource: { type: "Notebook", id: "finance/payroll" } })).body;
  expect(why.allow).toBe(true);
  expect(why.reasons.map((r: any) => r.source)).toEqual(["eve-payroll.cedar, policy 1"]);
  const no = (await http("root", "POST", "/admin/explain", { principal: "corp:eve", action: "notebook.run", resource: { type: "Notebook", id: "finance/payroll" } })).body;
  expect(no.allow).toBe(false);
  const grantWhy = (await http("root", "POST", "/admin/explain", { principal: "corp:ana", action: "notebook.run", resource: { type: "Notebook", id: "finance/forecast" } })).body;
  expect(grantWhy.reasons[0].source).toContain("Contributor in the workspace finance, to group finance-analysts");
  expect((await http("root", "POST", "/admin/explain", { principal: "corp:ana", action: "workspace.create", resource: { type: "Notebook", id: "finance/forecast" } })).status).toBe(400);
  expect((await http("root", "DELETE", "/admin/policies/eve-payroll")).status).toBe(200);
  expect((await http("eve", "GET", "/workspaces/finance/notebooks/payroll")).status).toBe(403);
  // people: whole, with what they may do where
  const bob = (await http("root", "GET", "/admin/people/corp%3Abob")).body; // as the page asks: escaped
  expect(bob.tags.department).toEqual(["Sales"]);
  expect(bob.workspaces.map((w: any) => [w.name, w.permissions.includes("workspace.view")])).toEqual([["sales", true]]);
  expect((await http("root", "GET", "/admin/people?q=ana")).body.people.map((p: any) => p.id)).toEqual(["corp:ana"]);
  // the audit log: newest first, filtered, with names
  const audit = (await http("root", "GET", "/admin/audit?action=policy.")).body;
  expect(audit.entries.map((e: any) => e.action)).toEqual(["policy.delete", "policy.save", "policy.delete", "policy.delete"]);
  expect(audit.names["sysadmin:root"]).toBe("System administrator");
  const denials = (await http("root", "GET", "/admin/audit?decision=deny&actor=corp:eve")).body.entries;
  expect(denials.length).toBeGreaterThan(0);
});

test("sign-in settings: providers made, tested and kept in auth.json; their secrets never sent back", async () => {
  expect((await http("ana", "GET", "/admin/auth")).status).toBe(403);
  const ad = { type: "ldap", label: "Corporate AD", url: "ldaps://127.0.0.1:1", bindDn: "CN=svc,DC=corp", bindPassword: "svc-s3cret", baseDn: "DC=corp", attributes: { department: "department" } };
  expect((await http("root", "PUT", "/admin/auth/providers/corp-ad", { provider: { ...ad, url: "ldap://127.0.0.1:1" } })).status).toBe(400); // plain ldap://
  expect((await http("root", "PUT", "/admin/auth/providers/Bad Id", { provider: ad })).status).toBe(400);
  const made = (await http("root", "PUT", "/admin/auth/providers/corp-ad", { provider: ad })).body;
  expect(made).toMatchObject({ id: "corp-ad", bindPassword: "", secretStored: true });
  // a blank secret keeps the stored one; an env: reference is shown (it is a name)
  expect((await http("root", "PUT", "/admin/auth/providers/corp-ad", { provider: { ...ad, bindPassword: "", label: "AD" } })).status).toBe(200);
  const kc = { type: "oidc", label: "Keycloak", issuer: "http://127.0.0.1:1/realms/corp", clientId: "querier", clientSecret: "env:QUERIER_TEST_NOPE" };
  expect((await http("root", "PUT", "/admin/auth/providers/kc", { provider: kc })).status).toBe(200);
  const all = (await http("root", "GET", "/admin/auth")).body;
  expect(all.providers.map((p: any) => [p.id, p.label])).toEqual([["corp-ad", "AD"], ["kc", "Keycloak"]]);
  expect(JSON.stringify(all)).not.toContain("svc-s3cret");
  expect(all.providers[1]).toMatchObject({ clientSecret: "env:QUERIER_TEST_NOPE", secretEnvMissing: true });
  expect((await (await fetch(`${B}/api/auth/providers`)).json()).providers.map((p: any) => p.id)).toEqual(["corp-ad", "kc", "sysadmin"]);
  // tests: unreachable, each step saying so; the redirect address to register
  const t1 = (await http("root", "POST", "/admin/auth/test", { provider: { ...ad, id: "corp-ad", bindPassword: "" }, username: "ana" })).body;
  expect(t1.steps.find((s: any) => !s.ok)?.what).toContain("Reach ldaps://127.0.0.1:1");
  const t2 = (await http("root", "POST", "/admin/auth/test", { provider: { ...kc, id: "kc" } })).body;
  expect(t2.steps.some((s: any) => !s.ok)).toBe(true);
  expect(t2.redirectUri).toContain("/api/auth/oidc/kc/callback");
  // the directory's CA: a certificate read and described, junk refused, and kept with the provider as PEM
  const pem = await Bun.file(join(import.meta.dir, "fixtures/test-ca.pem")).text();
  const read = (await http("root", "POST", "/admin/auth/certificate", { pem })).body;
  expect(read.certs[0]).toMatchObject({ subject: "CN=Querier Test CA", ca: true, expired: false });
  expect(read.certs[0].fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  const der = Buffer.from(pem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, ""), "base64").toString("base64");
  expect((await http("root", "POST", "/admin/auth/certificate", { der })).body.certs[0].fingerprint).toBe(read.certs[0].fingerprint);
  expect((await http("root", "POST", "/admin/auth/certificate", { pem: "not a certificate" })).status).toBe(400);
  expect((await http("ana", "POST", "/admin/auth/certificate", { pem })).status).toBe(403);
  expect((await http("root", "PUT", "/admin/auth/providers/corp-ad", { provider: { ...ad, bindPassword: "", label: "AD", ca: "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----" } })).status).toBe(400);
  const withCa = (await http("root", "PUT", "/admin/auth/providers/corp-ad", { provider: { ...ad, bindPassword: "", label: "AD", ca: pem, caFile: "/ignored.pem" } })).body;
  expect(withCa.ca).toBe(read.pem);
  expect(withCa.caFile).toBeUndefined();
  // the sign-in page's order; sessions
  expect((await http("root", "PUT", "/admin/auth/order", { ids: ["kc", "corp-ad"] })).status).toBe(200);
  expect((await http("root", "GET", "/admin/auth")).body.providers.map((p: any) => p.id)).toEqual(["kc", "corp-ad"]);
  expect((await http("root", "PUT", "/admin/auth/session", { absoluteHours: 0, idleMinutes: 60, refreshMinutes: 15 })).status).toBe(400);
  expect((await http("root", "PUT", "/admin/auth/session", { absoluteHours: 8, idleMinutes: 60, refreshMinutes: 15 })).body.absoluteHours).toBe(8);
  for (const id of ["kc", "corp-ad"]) expect((await http("root", "DELETE", `/admin/auth/providers/${id}`)).status).toBe(200);
  expect((await http("root", "GET", "/admin/audit?action=auth.")).body.entries.length).toBeGreaterThan(3);
});

// (last: it signs people out)
test("who may sign in: a rule over groups; who no longer matches is signed out at once; the sysadmin always may", async () => {
  expect((await http("bob", "GET", "/me")).status).toBe(200);
  const bad = await http("root", "PUT", "/admin/auth/admission", { when: 'principal.getTag("x").contains("y")' });
  expect(bad.status).toBe(400);
  const set = (await http("root", "PUT", "/admin/auth/admission", { when: 'principal in Group::"finance-analysts"' })).body;
  expect(set).toEqual({ when: 'principal in Group::"finance-analysts"' });
  expect((await http("root", "GET", "/admin/auth")).body.admission.when).toBe('principal in Group::"finance-analysts"');
  expect((await http("ana", "GET", "/me")).status).toBe(200); // in the group
  expect((await http("bob", "GET", "/me")).status).toBe(401); // signed out
  expect((await http("bob", "GET", "/workspaces")).status).toBe(401); // and stays out
  expect((await http("root", "GET", "/me")).status).toBe(200); // the sysadmin
  const why = (await http("root", "POST", "/admin/explain", { principal: "corp:bob", action: "signIn", resource: { type: "Tenant", id: "querier" } })).body;
  expect(why.allow).toBe(false);
  expect(why.reasons.map((r: any) => r.source)).toEqual(["sign-in.cedar, policy 1"]);
  expect((await http("root", "PUT", "/admin/auth/admission", { when: null })).body).toEqual({ when: null });
  const audit = (await http("root", "GET", "/admin/audit?action=auth.admission")).body.entries;
  expect(audit.length).toBe(3 - 1); // the refused one isn't logged
});
