// Who is asking, whatever vouched for them: the sysadmin, a directory (LDAP),
// or an OIDC provider. Every attribute is a set of strings (directories and
// claims are often multi-valued), which is also how policies read them.

export interface Principal {
  /** "<provider>:<subject>": stable across logins */
  id: string;
  provider: string;
  subject: string;
  username: string;
  email?: string;
  name?: string;
  groups: string[];
  attrs: Record<string, string[]>;
  /** the sysadmin from .env: every action, no policy */
  sysadmin?: boolean;
  /** what the provider needs to look the person up again (an LDAP dn) */
  ref?: string;
}

/** Any value as a set of strings: arrays flattened, objects left out, blanks dropped. */
export function strings(v: unknown): string[] {
  const out: string[] = [];
  const add = (x: unknown) => {
    if (x == null) return;
    if (Array.isArray(x)) return x.forEach(add);
    if (typeof x === "object") return;
    const s = String(x).trim();
    if (s) out.push(s);
  };
  add(v);
  return [...new Set(out)];
}

/** A value at a dotted path: "realm_access.roles". */
export function at(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const k of path.split(".")) cur = cur == null ? undefined : cur[k];
  return cur;
}

/** Attributes by mapping: { principalName: sourceName }. */
export function mapAttributes(source: unknown, mapping: Record<string, string> | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, from] of Object.entries(mapping ?? {})) {
    const v = strings(at(source, from));
    if (v.length) out[name] = v;
  }
  return out;
}

/** What the browser may know of a principal. */
export function publicPrincipal(p: Principal) {
  return { id: p.id, provider: p.provider, username: p.username, email: p.email, name: p.name, groups: p.groups, attrs: p.attrs, sysadmin: !!p.sysadmin };
}
