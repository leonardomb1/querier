// Authentication: the ways in (the sysadmin, LDAP directories, OIDC providers),
// sessions, and the audit log. Who may do what is policy (phase 2); for now
// only the sysadmin may use Querier, and everyone else can sign in and wait
// to be given access.

import type { Database } from "bun:sqlite";
import { principalTags } from "./policy";
import { allowInsecureLogin, loadAuthConfig, saveAuthConfig, secureCookies, type AuthConfig, type ProviderConfig } from "./config";

/** Ties an OIDC sign-in to the browser that started it: no one can hand you a login of theirs. */
export const OIDC_COOKIE = "querier_oidc";
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
import { openDb } from "./db";
import { Audit } from "./audit";
import { LdapProvider, LoginFailed, type TestStep } from "./ldap";
import { LoginLimiter } from "./limits";
import { OidcProvider } from "./oidc";
import type { Principal } from "./principal";
import { cookieOf, Sessions, type Session } from "./sessions";
import { Sysadmin } from "./sysadmin";
import { Signer } from "./tokens";

export { LoginFailed };
export type { Principal, Session };

export interface ProviderInfo {
  id: string;
  label: string;
  /** password: a username and password form; redirect: sign in at the provider */
  kind: "password" | "redirect";
  type: "sysadmin" | "ldap" | "oidc";
}

/** A place to return to after signing in: a route of this app, nothing else. */
export function safeNext(next: unknown): string {
  const s = String(next ?? "");
  return /^#\/[\w\-./%?=&~]*$/.test(s) ? s : "#/";
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export class Auth {
  readonly audit: Audit;
  readonly sessions: Sessions;
  private limiter = new LoginLimiter();
  private ldap = new Map<string, LdapProvider>();
  private oidc = new Map<string, OidcProvider>();
  private ended = new Set<(idHash: string) => void>();

  private constructor(
    readonly db: Database,
    private cfg: AuthConfig,
    readonly sysadmin: Sysadmin,
    readonly signer: Signer,
  ) {
    this.audit = new Audit(db);
    this.sessions = new Sessions(db, () => this.cfg.session);
    this.configure(cfg);
  }

  static async open(o: { db?: Database; config?: AuthConfig; sysadmin?: Sysadmin; signer?: Signer } = {}): Promise<Auth> {
    return new Auth(o.db ?? openDb(), o.config ?? (await loadAuthConfig()), o.sysadmin ?? new Sysadmin(), o.signer ?? (await Signer.open()));
  }

  /** New provider settings (the admin console, a reload): providers rebuilt. */
  configure(cfg: AuthConfig) {
    this.cfg = cfg;
    this.ldap.clear();
    this.oidc.clear();
    this.problems = {};
    for (const p of cfg.providers) {
      try {
        if (p.type === "ldap") this.ldap.set(p.id, new LdapProvider(p));
        else this.oidc.set(p.id, new OidcProvider(p));
      } catch (e: any) {
        this.problems[p.id] = e.message;
        console.error(`auth: provider ${p.id} left out: ${e.message}`);
      }
    }
  }
  /** Providers left out, and why (a setting they can't work with): the admin console shows it. */
  problems: Record<string, string> = {};

  /** New settings: written to auth.json, and in force at once (sign-ins from now on use them). */
  async saveConfig(cfg: AuthConfig) {
    await saveAuthConfig(cfg);
    this.configure(cfg);
  }

  /** Try a provider's settings (saved or not) without anyone's password. */
  async test(p: ProviderConfig, origin: string, username?: string): Promise<{ steps: TestStep[]; principal?: Principal; disabled?: boolean; redirectUri?: string }> {
    try {
      return p.type === "ldap" ? await new LdapProvider(p).test(username) : await new OidcProvider(p).test(origin);
    } catch (e: any) {
      return { steps: [{ ok: false, what: "Settings", detail: e.message }] };
    }
  }
  get config(): AuthConfig {
    return this.cfg;
  }

  /** The ways to sign in, for the login page. */
  providers(): ProviderInfo[] {
    const from = (p: ProviderConfig): ProviderInfo => ({ id: p.id, label: p.label, kind: p.type === "ldap" ? "password" : "redirect", type: p.type });
    return [...this.cfg.providers.filter((p) => this.ldap.has(p.id) || this.oidc.has(p.id)).map(from), { id: "sysadmin", label: "System administrator", kind: "password", type: "sysadmin" }];
  }

  /** Passwords only over HTTPS (or on this machine, or with the development switch). */
  passwordsAllowed(req: Request): boolean {
    return secureCookies || allowInsecureLogin || new URL(req.url).protocol === "https:" || LOOPBACK.has(new URL(req.url).hostname);
  }

  // -- signing in

  /** A username and password, for the sysadmin or a directory. */
  async login(providerId: string, username: string, password: string, ip: string): Promise<{ principal: Principal; cookie: string }> {
    const key = `${ip}\u0000${providerId}\u0000${username.toLowerCase()}`;
    const wait = this.limiter.wait(key);
    if (wait) throw new LoginFailed(`Too many failed attempts: try again in ${Math.ceil(wait / 60_000)} minute${wait > 60_000 ? "s" : ""}.`);
    let principal: Principal | null = null;
    try {
      if (providerId === "sysadmin") {
        if (await this.sysadmin.verify(username, password)) principal = { ...this.sysadmin.principal(), ref: await this.sysadmin.fingerprint() };
      } else {
        const p = this.ldap.get(providerId);
        if (!p) throw new LoginFailed("That sign-in method isn't available.");
        principal = await p.authenticate(username, password);
      }
    } catch (e) {
      if (!(e instanceof LoginFailed)) {
        console.error(`auth: ${providerId}:`, e);
        this.audit.log({ actor: `${providerId}:${username}`, action: "login", decision: "fail", detail: { provider: providerId, error: String((e as Error).message) } });
        throw new LoginFailed("The directory can't be reached right now.");
      }
    }
    if (!principal) {
      this.limiter.failed(key);
      this.audit.log({ actor: `${providerId}:${username}`, action: "login", decision: "fail", detail: { provider: providerId, ip } });
      throw new LoginFailed();
    }
    this.limiter.succeeded(key);
    return { principal, cookie: this.begin(principal, undefined, ip) };
  }

  private begin(principal: Principal, refresh: string | undefined, ip: string): string {
    // the directory said yes; policy may still say no (only some groups, some attributes)
    if (this.admit && !this.admit(principal)) {
      this.audit.log({ actor: principal.id, action: "login", decision: "deny", detail: { provider: principal.provider, ip, why: "sign-in not allowed by policy" } });
      throw new LoginFailed("Your account can't sign in to Querier. Ask an administrator for access.");
    }
    const { id } = this.sessions.create(principal, refresh);
    this.remember(principal);
    this.audit.log({ actor: principal.id, action: "login", decision: "ok", detail: { provider: principal.provider, ip, groups: principal.groups.length } });
    return this.sessions.cookie(id);
  }

  /** A principal by id, as it was when it last signed in or refreshed (what an AI token of theirs acts as). */
  principalById(id: string): Principal | null {
    if (id === this.sysadmin.principal().id) return this.sysadmin.principal();
    const r = this.db.query("SELECT principal FROM users WHERE id = ?").get(id) as { principal: string } | null;
    return r ? JSON.parse(r.principal) : null;
  }

  /** People and groups seen signing in: for the share dialog to suggest. */
  directory(q = "", limit = 20): { people: { id: string; username: string; name?: string; email?: string; provider: string }[]; groups: string[] } {
    const rows = this.db.query("SELECT principal FROM users ORDER BY last_login DESC").all() as { principal: string }[];
    // not the sysadmin: no grant is needed for it, and it's no one to share with
    const all = rows.map((r) => JSON.parse(r.principal) as Principal).filter((p) => !p.sysadmin && p.provider !== "sysadmin");
    const hit = (s?: string) => !q || (s ?? "").toLowerCase().includes(q.toLowerCase());
    const people = all.filter((p) => hit(p.username) || hit(p.name) || hit(p.email)).slice(0, limit).map((p) => ({ id: p.id, username: p.username, name: p.name, email: p.email, provider: p.provider }));
    const groups = [...new Set(all.flatMap((p) => p.groups))].filter((g) => hit(g)).sort().slice(0, limit);
    return { people, groups };
  }

  /** The words a condition can use about a person: each tag, with the values seen for it (not
   *  who has them), the tags providers map even before anyone signed in, and the groups. */
  vocabulary(): { tags: Record<string, string[]>; groups: string[] } {
    const tags = new Map<string, Set<string>>();
    const add = (k: string, v?: string) => {
      const set = tags.get(k) ?? tags.set(k, new Set()).get(k)!;
      if (v != null && set.size < 100) set.add(v);
    };
    for (const k of ["username", "provider", "email", "emailDomain"]) add(k);
    for (const p of this.cfg.providers) for (const k of Object.keys(p.attributes ?? {})) add(k);
    const groups = new Set<string>();
    for (const r of this.db.query("SELECT principal FROM users").all() as { principal: string }[]) {
      const p = JSON.parse(r.principal) as Principal;
      if (p.sysadmin || p.provider === "sysadmin") continue;
      for (const [k, vs] of Object.entries(principalTags(p))) for (const v of vs) add(k, k === "username" || k === "email" ? undefined : v);
      p.groups.forEach((g) => groups.add(g));
    }
    return { tags: Object.fromEntries([...tags].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v].sort()])), groups: [...groups].sort() };
  }

  /** Everyone who has signed in, whole (groups, attributes, when last), for the admin console. */
  people(q = "", limit = 200): (Principal & { lastLogin: number })[] {
    const rows = this.db.query("SELECT principal, last_login FROM users ORDER BY last_login DESC").all() as { principal: string; last_login: number }[];
    const hit = (s?: string) => !q || (s ?? "").toLowerCase().includes(q.toLowerCase());
    return rows
      .map((r) => ({ ...(JSON.parse(r.principal) as Principal), lastLogin: r.last_login }))
      .filter((p) => hit(p.username) || hit(p.name) || hit(p.email) || hit(p.id) || p.groups.some(hit))
      .slice(0, limit);
  }

  /** How people are called, by id: the audit log's actors. */
  names(ids: Iterable<string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of new Set(ids)) {
      const p = this.principalById(id);
      if (p) out[id] = p.name ?? p.username;
    }
    return out;
  }

  /** People who have signed in: for sharing and policies to name. */
  private remember(p: Principal) {
    this.db
      .query("INSERT INTO users (id, provider, username, principal, last_login) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET username = excluded.username, principal = excluded.principal, last_login = excluded.last_login")
      .run(p.id, p.provider, p.username, JSON.stringify(p), Date.now());
  }

  /** Where to send the browser to sign in at an OIDC provider, and the cookie that binds the sign-in to it. */
  async oidcStart(providerId: string, origin: string, next: string): Promise<{ url: string; cookie: string }> {
    const p = this.oidc.get(providerId);
    if (!p) throw new LoginFailed("That sign-in method isn't available.");
    const flow = await p.start(origin);
    const binding = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
    const now = Date.now();
    this.db.query("DELETE FROM oidc_flows WHERE created < ?").run(now - 10 * 60_000);
    this.db
      .query("INSERT INTO oidc_flows (state, provider, verifier, nonce, next, binding, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(flow.state, providerId, flow.verifier, flow.nonce, safeNext(next), sha(binding), now);
    return { url: flow.url, cookie: this.oidcCookie(binding) };
  }

  /** The binding cookie: sent back on the provider's redirect (a top-level GET, so SameSite=Lax), gone after. */
  oidcCookie(binding: string): string {
    return `${OIDC_COOKIE}=${binding}; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=${binding ? 600 : 0}${secureCookies ? "; Secure" : ""}`;
  }

  /** The provider sent the browser back. */
  async oidcCallback(providerId: string, url: URL, origin: string, ip: string, binding: string): Promise<{ cookie: string; next: string }> {
    const p = this.oidc.get(providerId);
    if (!p) throw new LoginFailed("That sign-in method isn't available.");
    const state = url.searchParams.get("state") ?? "";
    const flow = this.db.query("SELECT * FROM oidc_flows WHERE state = ? AND provider = ?").get(state, providerId) as any;
    if (!flow || Date.now() - flow.created > 10 * 60_000) throw new LoginFailed("That sign-in took too long, or was already used: try again.");
    this.db.query("DELETE FROM oidc_flows WHERE state = ?").run(state);
    // finished in another browser than it started in: someone's login handed to you
    if (!binding || sha(binding) !== flow.binding) {
      this.audit.log({ actor: `${providerId}:?`, action: "login", decision: "fail", detail: { provider: providerId, error: "not the browser that started it", ip } });
      throw new LoginFailed("That sign-in wasn't started in this browser: try again.");
    }
    try {
      const { principal, tokens } = await p.finish(url, flow, origin);
      return { cookie: this.begin(principal, tokens.refreshToken, ip), next: flow.next };
    } catch (e: any) {
      this.audit.log({ actor: `${providerId}:?`, action: "login", decision: "fail", detail: { provider: providerId, error: e.message } });
      throw new LoginFailed(`Signing in with ${p.cfg.label} failed: ${e.message}`);
    }
  }

  // -- who is asking

  /** The request's session and principal, refreshed from its provider when due; null if not signed in. */
  async authenticate(req: Request): Promise<Session | null> {
    const s = this.sessions.get(cookieOf(req));
    if (!s) return null;
    if (s.principal.sysadmin) {
      // .env's sysadmin changed (another name, another password): its old sessions end
      if (s.principal.ref !== (await this.sysadmin.fingerprint())) {
        this.end(s, "the sysadmin account changed");
        return null;
      }
      return s;
    }
    if (!this.sessions.dueForRefresh(s)) return this.admitted(s);
    try {
      const fresh = await this.refresh(s);
      if (!fresh) {
        this.end(s, "refresh: the account is gone or disabled");
        return null;
      }
      return this.admitted(s);
    } catch (e: any) {
      // the provider can't be reached: keep the session until its limits, and try again next time
      console.error(`auth: refreshing ${s.principal.id}:`, e.message);
      return s;
    }
  }

  /** Who may sign in at all (policy.ts `signIn`): asked at sign-in and on every request, so someone a
   *  policy no longer lets in (a group taken away, a rule changed) is signed out at once. Set by the app. */
  admit?: (p: Principal) => boolean;

  /** The session, if its person may still sign in; else it ends. */
  private admitted(s: Session): Session | null {
    if (!this.admit || this.admit(s.principal)) return s;
    this.end(s, "sign-in no longer allowed by policy");
    return null;
  }

  /** The principal read again from its provider; false when the provider says it's no longer valid. */
  private async refresh(s: Session): Promise<boolean> {
    const ldap = this.ldap.get(s.provider);
    if (ldap) {
      const p = s.principal.ref ? await ldap.lookup(s.principal.ref) : null;
      if (!p) return false;
      this.sessions.update(s, p);
      this.remember(p);
      return true;
    }
    const oidc = this.oidc.get(s.provider);
    if (oidc) {
      // no refresh token: the session lives to its limits
      if (!s.refresh) return (this.sessions.update(s, s.principal), true);
      try {
        const { principal, tokens } = await oidc.refresh(s.refresh);
        this.sessions.update(s, principal, tokens.refreshToken);
        this.remember(principal);
        return true;
      } catch (e) {
        if (e instanceof TypeError) throw e; // the network, not a refusal
        return false;
      }
    }
    // its provider was removed from the settings
    return false;
  }

  end(s: Session, why: string) {
    this.sessions.end(s.idHash);
    this.audit.log({ actor: s.principal.id, action: "logout", detail: { why } });
    for (const cb of this.ended) cb(s.idHash);
  }

  /** Told when a session ends: its open sockets close. */
  onEnded(cb: (idHash: string) => void) {
    this.ended.add(cb);
  }
}
