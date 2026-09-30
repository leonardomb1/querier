// Where authentication keeps its state, and how identity providers are set up.
// The config directory holds the database (sessions, audit), the signing key,
// and auth.json (the providers: mode 600, like secrets.json). A setting's value
// may be "env:NAME", read from the environment, so no secret need be in the file.

import { X509Certificate } from "node:crypto";
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
  /** the CA that signed the directory's certificate, as PEM (uploaded or pasted in the UI) */
  ca?: string;
  /** or a PEM file of it on the server */
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

/** One certificate of a PEM, as the UI shows it: to compare with what IT says it is. */
export interface CertificateInfo {
  subject: string;
  issuer: string;
  notAfter: string;
  fingerprint: string;
  ca: boolean;
  expired: boolean;
}

/** The certificates in a PEM (a CA, or a chain of them), each checked: throws when it holds none or a
 *  broken one. A DER file (a Windows .cer) is taken too, and comes back as PEM. */
export function readCertificates(input: string | Uint8Array): { pem: string; certs: CertificateInfo[] } {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  const ders: Uint8Array[] = blocks.length
    ? blocks.map((b) => Buffer.from(b.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, ""), "base64"))
    : typeof input !== "string" && input.length
      ? [input]
      : [];
  if (!ders.length) throw new Error("That isn't a certificate: a PEM file (-----BEGIN CERTIFICATE-----) or a .cer/.crt file.");
  const certs: CertificateInfo[] = [];
  const pems: string[] = [];
  for (const der of ders) {
    let x: X509Certificate;
    try {
      x = new X509Certificate(Buffer.from(der));
    } catch {
      throw new Error("That certificate can't be read: is it the whole file?");
    }
    const b64 = Buffer.from(x.raw).toString("base64");
    pems.push(`-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----`);
    certs.push({
      subject: x.subject.replace(/\n/g, ", "),
      issuer: x.issuer.replace(/\n/g, ", "),
      notAfter: new Date(x.validTo).toISOString(),
      fingerprint: x.fingerprint256,
      ca: x.ca,
      expired: new Date(x.validTo).getTime() < Date.now(),
    });
  }
  return { pem: pems.join("\n") + "\n", certs };
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
