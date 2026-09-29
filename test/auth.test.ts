import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, safeNext } from "../server/auth";
import { clientAddress } from "../server/auth/config";
import { openDb } from "../server/auth/db";
import { escapeFilter, LdapProvider } from "../server/auth/ldap";
import { LoginLimiter } from "../server/auth/limits";
import { isEntraOverage } from "../server/auth/oidc";
import { mapAttributes, strings } from "../server/auth/principal";
import { cookieOf, Sessions } from "../server/auth/sessions";
import { Sysadmin } from "../server/auth/sysadmin";
import { Signer } from "../server/auth/tokens";

const req = (cookie = "", url = "http://localhost/api/me") => new Request(url, { headers: { cookie } });

test("LDAP filters: what a user types can't change the filter (RFC 4515)", () => {
  expect(escapeFilter("ana")).toBe("ana");
  expect(escapeFilter("*)(uid=*")).toBe("\\2a\\29\\28uid=\\2a");
  expect(escapeFilter("a\\b\0")).toBe("a\\5cb\\00");
  expect(() => new LdapProvider({ id: "x", type: "ldap", label: "X", url: "ldap://dc:389", bindDn: "", bindPassword: "", baseDn: "" })).toThrow("in the clear");
  expect(() => new LdapProvider({ id: "x", type: "ldap", label: "X", url: "ldap://dc:389", startTls: true, bindDn: "", bindPassword: "", baseDn: "" })).not.toThrow();
});

test("an empty LDAP password is refused before any bind (it would be an unauthenticated bind)", async () => {
  const p = new LdapProvider({ id: "x", type: "ldap", label: "X", url: "ldaps://nowhere.invalid:636", bindDn: "cn=svc", bindPassword: "pw", baseDn: "dc=x" });
  expect(p.authenticate("ana", "")).rejects.toThrow("wrong");
});

test("attributes: any claim or directory value as a set of strings", () => {
  expect(strings(["a", ["b", "a"], null, 3, { x: 1 }, " "])).toEqual(["a", "b", "3"]);
  expect(mapAttributes({ department: "Finance", realm_access: { roles: ["x", "y"] } }, { dept: "department", roles: "realm_access.roles", none: "missing" })).toEqual({
    dept: ["Finance"],
    roles: ["x", "y"],
  });
  expect(isEntraOverage({ _claim_names: { groups: "src1" } })).toBe(true);
  expect(isEntraOverage({ hasgroups: true })).toBe(true);
  expect(isEntraOverage({ groups: ["a"] })).toBe(false);
});

test("failed logins wait, longer each time; a success clears it", () => {
  const l = new LoginLimiter(3, 60_000);
  for (let i = 0; i < 3; i++) l.failed("k", 1000);
  expect(l.wait("k", 1000)).toBe(60_000);
  expect(l.wait("k", 62_000)).toBe(0);
  for (let i = 0; i < 3; i++) l.failed("k", 70_000);
  expect(l.wait("k", 70_000)).toBe(120_000);
  l.succeeded("k");
  expect(l.wait("k", 70_000)).toBe(0);
});

test("the sysadmin: from the environment, required, checked by hash", async () => {
  expect(() => new Sysadmin({})).toThrow("No sysadmin");
  const hash = await Bun.password.hash("correct horse");
  const s = new Sysadmin({ QUERIER_ADMIN_USER: "root", QUERIER_ADMIN_PASSWORD_HASH: hash });
  expect(await s.verify("root", "correct horse")).toBe(true);
  expect(await s.verify("root", "wrong")).toBe(false);
  expect(await s.verify("other", "correct horse")).toBe(false);
  expect(s.principal()).toMatchObject({ id: "sysadmin:root", sysadmin: true });
  // the b64: form, as hash.ts prints it for .env files
  const b64 = new Sysadmin({ QUERIER_ADMIN_USER: "root", QUERIER_ADMIN_PASSWORD_HASH: `b64:${Buffer.from(hash).toString("base64")}` });
  expect(await b64.verify("root", "correct horse")).toBe(true);
  expect(() => new Sysadmin({ QUERIER_ADMIN_USER: "root", QUERIER_ADMIN_PASSWORD_HASH: "=19=65536" })).toThrow("isn't a password hash");
});

test("sessions: the cookie's id, hashed; idle and absolute limits; refresh due", () => {
  const db = openDb(":memory:");
  const cfg = { absoluteHours: 1, idleMinutes: 10, refreshMinutes: 5 };
  const s = new Sessions(db, () => cfg);
  const p = { id: "ad:1", provider: "ad", subject: "1", username: "ana", groups: ["g"], attrs: {} };
  const { id } = s.create(p, undefined, 0);
  expect((db.query("SELECT id_hash FROM sessions").get() as any).id_hash).not.toBe(id); // only its hash
  expect(s.get(id, 60_000)?.principal.username).toBe("ana");
  expect(s.dueForRefresh(s.get(id, 60_000)!, 6 * 60_000)).toBe(true);
  expect(s.get(id, 60_000 + 11 * 60_000)).toBeNull(); // idle
  const b = s.create(p, undefined, 0);
  for (let t = 5; t < 60; t += 5) s.get(b.id, t * 60_000); // kept busy
  expect(s.get(b.id, 61 * 60_000)).toBeNull(); // past its absolute limit
  expect(s.cookie("x")).toContain("HttpOnly; SameSite=Lax");
  expect(cookieOf(req("a=1; querier_session=abc=; b=2"))).toBe("abc=");
});

test("signed tokens: scoped, expiring", async () => {
  const dir = await mkdtemp(join(tmpdir(), "querier-sign-"));
  const s = await Signer.open(join(dir, "k"));
  const t = await s.sign("template:w/nb", 60, 0);
  expect(await s.verify("template:w/nb", t, 1000)).toBe(true);
  expect(await s.verify("template:w/other", t, 1000)).toBe(false);
  expect(await s.verify("template:w/nb", t, 61_000)).toBe(false);
  expect(await s.verify("template:w/nb", "1.x", 0)).toBe(false);
  // the same key next time
  expect(await (await Signer.open(join(dir, "k"))).verify("template:w/nb", t, 1000)).toBe(true);
});

test("signing in: the sysadmin gets a session; a wrong password is audited", async () => {
  const dir = await mkdtemp(join(tmpdir(), "querier-auth-"));
  const auth = await Auth.open({
    db: openDb(":memory:"),
    config: { providers: [], session: { absoluteHours: 1, idleMinutes: 60, refreshMinutes: 15 } },
    sysadmin: new Sysadmin({ QUERIER_ADMIN_USER: "root", QUERIER_ADMIN_PASSWORD_HASH: await Bun.password.hash("pw") }),
    signer: await Signer.open(join(dir, "k")),
  });
  expect(auth.providers().map((p) => p.id)).toEqual(["sysadmin"]);
  expect(auth.login("sysadmin", "root", "nope", "1.2.3.4")).rejects.toThrow("wrong");
  const { cookie } = await auth.login("sysadmin", "root", "pw", "1.2.3.4");
  const id = /querier_session=([^;]+)/.exec(cookie)![1];
  expect((await auth.authenticate(req(`querier_session=${id}`)))?.principal.sysadmin).toBe(true);
  expect(await auth.authenticate(req("querier_session=forged"))).toBeNull();
  // another sysadmin in .env (a new password): the old session ends
  const other = await Auth.open({
    db: (auth as any).db,
    config: auth.config,
    sysadmin: new Sysadmin({ QUERIER_ADMIN_USER: "root", QUERIER_ADMIN_PASSWORD_HASH: await Bun.password.hash("new") }),
    signer: auth.signer,
  });
  expect(await other.authenticate(req(`querier_session=${id}`))).toBeNull();
  expect(auth.audit.list().filter((e) => e.action === "login").map((e) => [e.action, e.decision])).toEqual([
    ["login", "ok"],
    ["login", "fail"],
  ]);
  // passwords over plain HTTP only on this machine
  expect(auth.passwordsAllowed(req("", "http://localhost/api/auth/login"))).toBe(true);
  expect(auth.passwordsAllowed(req("", "http://querier.corp/api/auth/login"))).toBe(false);
  expect(auth.passwordsAllowed(req("", "https://querier.corp/api/auth/login"))).toBe(true);
});

test("the client's address: X-Forwarded-For only from a trusted proxy, its right-most untrusted hop", () => {
  const proxies = new Set(["10.0.0.2"]);
  expect(clientAddress("203.0.113.5", "1.1.1.1", proxies)).toBe("203.0.113.5"); // not a proxy: ignored
  expect(clientAddress("10.0.0.2", "198.51.100.7", proxies)).toBe("198.51.100.7");
  expect(clientAddress("::ffff:10.0.0.2", "forged, 198.51.100.7", proxies)).toBe("198.51.100.7"); // the left is the client's to write
  expect(clientAddress("10.0.0.2", null, proxies)).toBe("10.0.0.2");
});

test("after signing in, only this app's own routes", () => {
  expect(safeNext("#/w/default/nb/retail")).toBe("#/w/default/nb/retail");
  expect(safeNext("https://evil.example")).toBe("#/");
  expect(safeNext("//evil.example")).toBe("#/");
  expect(safeNext('#/x"><script>')).toBe("#/");
});
