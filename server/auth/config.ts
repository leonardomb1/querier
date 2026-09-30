// Where authentication keeps its state, and how identity providers are set up.
// The config directory holds the database (sessions, audit), the signing key,
// and auth.json (the providers: mode 600, like secrets.json). A setting's value
// may be "env:NAME", read from the environment, so no secret need be in the file.

import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const configDir = process.env.QUERIER_CONFIG_DIR ?? join(homedir(), ".config/querier");

/** The address people reach Querier at (for OIDC redirects, and whether cookies are Secure). */
export const publicUrl = (process.env.QUERIER_PUBLIC_URL ?? "").replace(/\/+$/, "");
/** Passwords over plain HTTP from anywhere: refused unless opted out of HTTPS (QUERIER_ALLOW_HTTP=1;
 *  QUERIER_ALLOW_INSECURE_LOGIN=1 is its old name), for a trusted network until a certificate is in place. */
export const allowInsecureLogin = process.env.QUERIER_ALLOW_HTTP === "1" || process.env.QUERIER_ALLOW_INSECURE_LOGIN === "1";
export const secureCookies = publicUrl.startsWith("https://");
/** Proxies in front of Querier (their addresses): only their X-Forwarded-For is believed. */
export const trustedProxies = new Set((process.env.QUERIER_TRUSTED_PROXIES ?? "").split(",").map((s) => s.trim()).filter(Boolean));

/** The client's address: the connection's, unless that is a trusted proxy; then the right-most
 *  X-Forwarded-For hop that isn't one (the left ones are the client's to forge). */
export function clientAddress(peer: string, forwardedFor: string | null, trusted: Set<string> = trustedProxies): string {
  const bare = (a: string) => a.replace(/^::ffff:/, "");
  if (!trusted.has(bare(peer))) return peer;
  const hops = (forwardedFor ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return hops.reverse().find((h) => !trusted.has(bare(h))) ?? peer;
}

export interface LdapProviderConfig {
  id: string;
  type: "ldap";
  label: string;
  /** ldaps://host:636, or ldap://host:389 with startTls */
  url: string;
  startTls?: boolean;
  /** a PEM file of the CA that signed the directory's certificate */
  caFile?: string;
  /** the name on the directory's certificate, when it is reached by another (an IP, a tunnel) */
  tlsServerName?: string;
  /** plain ldap:// without StartTLS: refused unless this is set */
  allowInsecure?: boolean;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  /** "{username}" is replaced by the escaped username */
  userFilter?: string;
  /** a stable id: objectGUID (AD), entryUUID (OpenLDAP) */
  idAttribute?: string;
  usernameAttribute?: string;
  /** resolve nested groups (AD's LDAP_MATCHING_RULE_IN_CHAIN) under this base */
  groupBaseDn?: string;
  nestedGroups?: boolean;
  /** a group's name in policies: cn (default) or the whole dn */
  groupName?: "cn" | "dn";
  /** directory attribute → principal attribute: { department: "department", title: "title" } */
  attributes?: Record<string, string>;
  emailAttribute?: string;
  nameAttribute?: string;
}

export interface OidcProviderConfig {
  id: string;
  type: "oidc";
  label: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  /** claim names: where the username, email, name and groups are */
  usernameClaim?: string;
  emailClaim?: string;
  nameClaim?: string;
  groupsClaim?: string;
  /** claim → principal attribute: { department: "department" }; dotted paths reach into objects */
  attributes?: Record<string, string>;
  /** Microsoft Entra: fetch groups from Graph when the token says there are too many to list */
  entraGraphOverage?: boolean;
  /** also read the userinfo endpoint's claims */
  userinfo?: boolean;
}

export type ProviderConfig = LdapProviderConfig | OidcProviderConfig;

export interface AuthConfig {
  providers: ProviderConfig[];
  session: { absoluteHours: number; idleMinutes: number; refreshMinutes: number };
}

const DEFAULTS: AuthConfig = { providers: [], session: { absoluteHours: 12, idleMinutes: 120, refreshMinutes: 15 } };

export const authFile = () => process.env.QUERIER_AUTH_CONFIG ?? join(configDir, "auth.json");

export async function loadAuthConfig(): Promise<AuthConfig> {
  const f = Bun.file(authFile());
  if (!(await f.exists())) return structuredClone(DEFAULTS);
  const raw = (await f.json()) as Partial<AuthConfig>;
  return { providers: raw.providers ?? [], session: { ...DEFAULTS.session, ...(raw.session ?? {}) } };
}

export async function saveAuthConfig(c: AuthConfig) {
  await mkdir(dirname(authFile()), { recursive: true });
  await Bun.write(authFile(), JSON.stringify(c, null, 2) + "\n");
  await chmod(authFile(), 0o600);
}

/** A setting's value: "env:NAME" is read from the environment. */
export function resolveValue(v: string | undefined): string {
  if (!v) return "";
  if (v.startsWith("env:")) {
    const name = v.slice(4);
    const got = process.env[name];
    if (got == null) throw new Error(`The environment variable ${name} is not set.`);
    return got;
  }
  return v;
}
