// A directory (Active Directory, OpenLDAP) as an identity provider: search for
// the person with a service account, then bind as them with their password.
// LDAPS or StartTLS only (plain LDAP needs allowInsecure); what the user types
// is escaped before it goes into a filter (RFC 4515); AD's nested groups come
// from its in-chain matching rule; disabled accounts are refused.

import { Client, type Entry } from "ldapts";
import type { LdapProviderConfig } from "./config";
import { resolveValue } from "./config";
import { strings, type Principal } from "./principal";

/** RFC 4515: \ * ( ) and NUL escaped as \XX, so a value can't change a filter. */
export function escapeFilter(v: string): string {
  return v.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

const AD_DISABLED = 0x2;
const IN_CHAIN = "1.2.840.113556.1.4.1941";

/** A generic answer: which of name or password was wrong is not said. */
/** A binary SID as AD writes it: S-1-5-21-…-rid. */
export function sidText(b: Buffer): string {
  const subs = Array.from({ length: b[1] }, (_, i) => `-${b.readUInt32LE(8 + 4 * i)}`).join("");
  return `S-${b[0]}-${b.readUIntBE(2, 6)}${subs}`;
}

/** One step of a connection test: what was tried, how it went. */
export interface TestStep {
  ok: boolean;
  what: string;
  detail?: string;
  ms?: number;
}

export class LoginFailed extends Error {
  constructor(message = "The username or password is wrong.") {
    super(message);
  }
}

/** An AD objectGUID (little-endian parts) as the usual text form; other binaries as hex. */
function guidText(b: Buffer): string {
  if (b.length !== 16) return b.toString("hex");
  const h = (s: number, e: number, rev: boolean) => {
    const part = [...b.subarray(s, e)];
    return (rev ? part.reverse() : part).map((x) => x.toString(16).padStart(2, "0")).join("");
  };
  return `${h(0, 4, true)}-${h(4, 6, true)}-${h(6, 8, true)}-${h(8, 10, false)}-${h(10, 16, false)}`;
}

export class LdapProvider {
  constructor(readonly cfg: LdapProviderConfig) {
    const plain = cfg.url.startsWith("ldap://") && !cfg.startTls;
    if (plain && !cfg.allowInsecure) throw new Error(`${cfg.id}: ldap:// without StartTLS sends passwords in the clear: use ldaps://, startTls, or allowInsecure.`);
  }

  private async client(): Promise<Client> {
    const ca = this.cfg.ca ? [this.cfg.ca] : this.cfg.caFile ? [await Bun.file(this.cfg.caFile).text()] : undefined;
    // the certificate is always checked: against tlsServerName when the url names the host otherwise
    const tlsOptions = { ca, rejectUnauthorized: true, minVersion: "TLSv1.2" as const, ...(this.cfg.tlsServerName ? { servername: this.cfg.tlsServerName } : {}) };
    const c = new Client({ url: this.cfg.url, tlsOptions: this.cfg.url.startsWith("ldaps://") ? tlsOptions : undefined, timeout: 10_000, connectTimeout: 10_000 });
    if (this.cfg.startTls) await c.startTLS(tlsOptions);
    return c;
  }

  private attributeNames(): string[] {
    const c = this.cfg;
    return [
      ...new Set([
        c.idAttribute ?? "objectGUID",
        c.usernameAttribute ?? "sAMAccountName",
        c.emailAttribute ?? "mail",
        c.nameAttribute ?? "displayName",
        "memberOf",
        "userAccountControl",
        ...Object.values(c.attributes ?? {}),
      ]),
    ];
  }

  /** Search with the service account: `filter` is complete (escaped) already. */
  private async find(client: Client, base: string, filter: string, scope: "sub" | "base" = "sub"): Promise<Entry[]> {
    const idAttr = this.cfg.idAttribute ?? "objectGUID";
    const { searchEntries } = await client.search(base, { scope, filter, attributes: this.attributeNames(), sizeLimit: 2, explicitBufferAttributes: [idAttr] });
    return searchEntries;
  }

  /** Check a username and password; the person as a principal. */
  async authenticate(username: string, password: string): Promise<Principal> {
    // an empty password is an "unauthenticated bind": it succeeds without checking anything
    if (!username.trim() || !password) throw new LoginFailed();
    const client = await this.client();
    try {
      await client.bind(this.cfg.bindDn, resolveValue(this.cfg.bindPassword));
      const filter = (this.cfg.userFilter ?? "(&(objectClass=user)(sAMAccountName={username}))").replaceAll("{username}", escapeFilter(username.trim()));
      const found = await this.find(client, this.cfg.baseDn, filter);
      if (found.length !== 1) throw new LoginFailed();
      const entry = found[0];
      if (Number(entry.userAccountControl ?? 0) & AD_DISABLED) throw new LoginFailed("This account is disabled.");
      // the password, checked by binding as the person
      const as = await this.client();
      try {
        await as.bind(entry.dn, password);
      } catch {
        throw new LoginFailed();
      } finally {
        await as.unbind().catch(() => {});
      }
      return await this.principalOf(client, entry);
    } finally {
      await client.unbind().catch(() => {});
    }
  }

  /** Check the settings without anyone's password: reach the directory, bind as the service account,
   *  search the base, and (given a username) find the person as a sign-in would, with their groups and
   *  attributes. Each step says how it went; the first failure ends it. */
  async test(username?: string): Promise<{ steps: TestStep[]; principal?: Principal; disabled?: boolean }> {
    const steps: TestStep[] = [];
    const step = async <T>(what: string, fn: () => Promise<T>, detail?: (v: T) => string): Promise<T | undefined> => {
      const t = Date.now();
      try {
        const v = await fn();
        steps.push({ ok: true, what, detail: detail?.(v), ms: Date.now() - t });
        return v;
      } catch (e: any) {
        steps.push({ ok: false, what, detail: String(e?.message ?? e), ms: Date.now() - t });
        return undefined;
      }
    };
    // (the connection is made as it binds: reaching the directory and signing in are one step)
    const client = await step("Read the TLS settings", () => this.client());
    if (!client) return { steps };
    steps.pop();
    try {
      const signedIn = await step(`Reach ${this.cfg.url}${this.cfg.startTls ? " (StartTLS)" : ""} and sign in as ${this.cfg.bindDn}`, () =>
        client.bind(this.cfg.bindDn, resolveValue(this.cfg.bindPassword)).then(() => true),
      );
      if (signedIn == null) return { steps };
      const base = await step(`Read ${this.cfg.baseDn}`, () => this.find(client, this.cfg.baseDn, "(objectClass=*)", "base"), (r) => (r.length ? "found" : "not found"));
      if (!base?.length) return { steps };
      if (!username?.trim()) return { steps };
      const filter = (this.cfg.userFilter ?? "(&(objectClass=user)(sAMAccountName={username}))").replaceAll("{username}", escapeFilter(username.trim()));
      const found = await step(`Find ${username.trim()} with ${filter}`, () => this.find(client, this.cfg.baseDn, filter), (r) => (r.length === 1 ? r[0].dn : `${r.length} found: ${r.length ? "more than one matches" : "nobody matches"}`));
      if (found?.length !== 1) {
        if (found) steps[steps.length - 1].ok = false;
        return { steps };
      }
      const principal = await step("Read their groups and attributes", () => this.principalOf(client, found[0]), (p) => `${p.groups.length} group${p.groups.length === 1 ? "" : "s"}, ${Object.keys(p.attrs).length} attribute${Object.keys(p.attrs).length === 1 ? "" : "s"}`);
      return { steps, principal, disabled: !!(Number(found[0].userAccountControl ?? 0) & AD_DISABLED) };
    } finally {
      await client.unbind().catch(() => {});
    }
  }

  /** The person again, by their dn, with the service account: for a session's refresh. Null when gone or disabled. */
  async lookup(dn: string): Promise<Principal | null> {
    const client = await this.client();
    try {
      await client.bind(this.cfg.bindDn, resolveValue(this.cfg.bindPassword));
      const found = await this.find(client, dn, "(objectClass=*)", "base").catch(() => []);
      if (found.length !== 1) return null;
      if (Number(found[0].userAccountControl ?? 0) & AD_DISABLED) return null;
      return await this.principalOf(client, found[0]);
    } finally {
      await client.unbind().catch(() => {});
    }
  }

  /** Every group a person is in, however deep, the fast way Active Directory offers: their tokenGroups
   *  (the SIDs AD works out for their sign-in), then those groups by SID, a hundred at a time. The
   *  in-chain search it replaces walks the whole domain and is too slow for a large one. Null when the
   *  directory has no tokenGroups (not AD): the caller searches in chain instead. */
  private async tokenGroups(client: Client, dn: string, base: string): Promise<Entry[] | null> {
    const { searchEntries } = await client.search(dn, { scope: "base", filter: "(objectClass=*)", attributes: ["tokenGroups"], explicitBufferAttributes: ["tokenGroups"] }).catch(() => ({ searchEntries: [] as Entry[] }));
    const raw = searchEntries[0]?.tokenGroups;
    const sids = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((v): v is Buffer => Buffer.isBuffer(v));
    if (!sids.length) return null;
    const out: Entry[] = [];
    for (let i = 0; i < sids.length; i += 100) {
      // (as text, S-1-5-21-…: AD matches that reliably, where an escaped binary value doesn't go through)
      const any = sids.slice(i, i + 100).map((sid) => `(objectSid=${sidText(sid)})`).join("");
      const r = await client.search(base, { scope: "sub", filter: `(&(objectClass=group)(|${any}))`, attributes: ["cn"], paged: { pageSize: 200 } });
      out.push(...r.searchEntries);
    }
    return out;
  }

  private async principalOf(client: Client, e: Entry): Promise<Principal> {
    const c = this.cfg;
    const raw = e[c.idAttribute ?? "objectGUID"];
    const id = Buffer.isBuffer(raw) ? guidText(raw) : Array.isArray(raw) && Buffer.isBuffer(raw[0]) ? guidText(raw[0] as Buffer) : strings(raw)[0] ?? e.dn;
    const first = (name: string) => strings(e[name])[0];
    let groups: string[];
    if (c.nestedGroups !== false && c.groupBaseDn) {
      // every group the person is in, directly or through other groups (AD)
      const found = (await this.tokenGroups(client, e.dn, c.groupBaseDn)) ?? (await client.search(c.groupBaseDn, { scope: "sub", filter: `(member:${IN_CHAIN}:=${escapeFilter(e.dn)})`, attributes: ["cn"] })).searchEntries;
      groups = found.map((g) => (c.groupName === "dn" ? g.dn : (strings(g.cn)[0] ?? g.dn)));
    } else {
      groups = strings(e.memberOf).map((dn) => (c.groupName === "dn" ? dn : (/^cn=([^,]+)/i.exec(dn)?.[1] ?? dn)));
    }
    const attrs: Record<string, string[]> = {};
    for (const [name, from] of Object.entries(c.attributes ?? {})) {
      const v = strings(e[from]);
      if (v.length) attrs[name] = v;
    }
    return {
      id: `${c.id}:${id}`,
      provider: c.id,
      subject: id,
      username: first(c.usernameAttribute ?? "sAMAccountName") ?? e.dn,
      email: first(c.emailAttribute ?? "mail"),
      name: first(c.nameAttribute ?? "displayName"),
      groups: [...new Set(groups)].sort(),
      attrs,
      ref: e.dn,
    };
  }
}
