// OIDC against a real Keycloak (skipped unless QUERIER_IT_KEYCLOAK is its URL; test/it/keycloak.sh makes one):
// the realm "querier" with client "querier" (secret s3cret, redirect
// http://localhost:3999/api/auth/oidc/kc/callback), a group mapper ("groups"),
// a "department" attribute mapper, and user ana / ana-pass in group finance.
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "../server/auth";
import { openDb } from "../server/auth/db";
import { Sysadmin } from "../server/auth/sysadmin";
import { Signer } from "../server/auth/tokens";

const KC = process.env.QUERIER_IT_KEYCLOAK;
const ORIGIN = "http://localhost:3999";

/** A browser, as far as a login form needs one: cookies, and redirects seen, not followed. */
async function browserLogin(url: string, username: string, password: string): Promise<URL> {
  const jar = new Map<string, string>();
  const keep = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const [k, ...v] = kv.split("=");
      jar.set(k.trim(), v.join("="));
    }
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const page = await fetch(url, { redirect: "manual" });
  keep(page);
  const html = await page.text();
  const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(html)?.[1];
  if (!action) throw new Error("no login form: " + html.slice(0, 300));
  const res = await fetch(action.replace(/&amp;/g, "&"), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() },
    body: new URLSearchParams({ username, password, credentialId: "" }),
  });
  const to = res.headers.get("location");
  if (!to) throw new Error(`no redirect after login (${res.status})`);
  return new URL(to);
}

async function keycloakAdmin(path: string, method = "GET", body?: unknown) {
  const tok = await (await fetch(`${KC}/realms/master/protocol/openid-connect/token`, { method: "POST", body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "admin", password: "admin" }) })).json();
  return fetch(`${KC}/admin/realms/querier${path}`, { method, headers: { Authorization: `Bearer ${tok.access_token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
}

test.skipIf(!KC)("Keycloak: code flow with PKCE, groups and attributes, refresh, replay refused, disabled user's session ends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "querier-kc-"));
  const db = openDb(":memory:");
  const auth = await Auth.open({
    db,
    config: {
      providers: [{ id: "kc", type: "oidc", label: "Keycloak", issuer: `${KC}/realms/querier`, clientId: "querier", clientSecret: "s3cret", attributes: { department: "department" } }],
      session: { absoluteHours: 1, idleMinutes: 60, refreshMinutes: 15 },
    },
    sysadmin: new Sysadmin({ QUERIER_ADMIN_USER: "root", QUERIER_ADMIN_PASSWORD: "x" }),
    signer: await Signer.open(join(dir, "k")),
  });
  expect(auth.providers().map((p) => [p.id, p.kind])).toContainEqual(["kc", "redirect"]);

  const started = await auth.oidcStart("kc", ORIGIN, "#/w/finance");
  const binding = /querier_oidc=([^;]+)/.exec(started.cookie)![1];
  const start = new URL(started.url);
  expect(start.searchParams.get("code_challenge_method")).toBe("S256");
  expect(start.searchParams.get("nonce")).toBeTruthy();
  const back = await browserLogin(start.href, "ana", "ana-pass");
  expect(back.pathname).toBe("/api/auth/oidc/kc/callback");

  // a forged state is refused
  const forged = new URL(back);
  forged.searchParams.set("state", "forged");
  expect(auth.oidcCallback("kc", forged, ORIGIN, "127.0.0.1", binding)).rejects.toThrow("try again");

  // someone's callback handed to another browser (no binding cookie, or another): refused
  const second = await auth.oidcStart("kc", ORIGIN, "#/");
  const secondBack = await browserLogin(second.url, "ana", "ana-pass");
  expect(auth.oidcCallback("kc", secondBack, ORIGIN, "127.0.0.1", "")).rejects.toThrow("wasn't started in this browser");

  const { cookie, next } = await auth.oidcCallback("kc", back, ORIGIN, "127.0.0.1", binding);
  expect(next).toBe("#/w/finance");
  // the same answer again: already used
  expect(auth.oidcCallback("kc", back, ORIGIN, "127.0.0.1", binding)).rejects.toThrow("already used");

  const id = /querier_session=([^;]+)/.exec(cookie)![1];
  const req = () => new Request("http://localhost/api/me", { headers: { cookie: `querier_session=${id}` } });
  const s = await auth.authenticate(req());
  expect(s?.principal).toMatchObject({ provider: "kc", username: "ana", email: "ana@example.com", groups: ["finance"], attrs: { department: ["Finance"] } });
  expect(s?.refresh).toBeTruthy();

  // due for a refresh: the refresh token gets new claims
  db.query("UPDATE sessions SET refreshed = 0").run();
  expect((await auth.authenticate(req()))?.principal.groups).toEqual(["finance"]);

  // disabled in Keycloak: the next refresh ends the session
  const users = await (await keycloakAdmin("/users?username=ana")).json();
  await keycloakAdmin(`/users/${users[0].id}`, "PUT", { ...users[0], enabled: false });
  try {
    db.query("UPDATE sessions SET refreshed = 0").run();
    expect(await auth.authenticate(req())).toBeNull();
    expect(auth.audit.list().map((e) => e.action)).toContain("logout");
  } finally {
    await keycloakAdmin(`/users/${users[0].id}`, "PUT", { ...users[0], enabled: true });
  }
}, 30_000);
