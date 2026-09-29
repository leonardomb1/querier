// Connections: what a kernel may reach and with which credentials, as Microsoft
// Fabric's. A connection is a named set of environment variables a kernel gets
// (basalt reads them by its own convention: a connection `sr` takes SR_USER and
// SR_PASS; OPTIONS say token = env('GH_TOKEN'); Python reads os.environ), for
// everyone (the tenant's) or for one workspace's notebooks. Its credentials are
// shared (set once, by who manages it) or each person's own (per-user: each
// enters theirs, and a kernel runs with its owner's).
//
// Who may use or manage one is policy (auth/policy.ts: a Connection is in its
// workspace; a workspace's Contributors use its connections, its Members manage
// them; a connection's own grants give Owner or User). A kernel gets exactly the
// connections its owner may use: the others aren't there.
//
// They live on the server, in one owner-only file (<config>/connections.json),
// never in a notebook and never back to a browser: the API tells which
// variables are set, not their values.

import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir } from "./auth/config";
import { UserError } from "./store";

export type Credentials = "shared" | "per-user";

export interface Connection {
  id: string;
  /** how it is shown and named: unique among those a notebook sees */
  name: string;
  /** a workspace's; none: everyone's (the tenant's) */
  workspace?: string;
  description?: string;
  /** the environment variables it gives a kernel */
  variables: string[];
  credentials: Credentials;
  created: number;
  createdBy?: string;
  updated: number;
}

interface Value {
  value: string;
  updated: number;
}

interface File {
  version: 1;
  connections: Connection[];
  /** a shared connection's values, by connection id, then variable */
  shared: Record<string, Record<string, Value>>;
  /** each person's own values of a per-user connection: by connection id, then principal id, then variable */
  users: Record<string, Record<string, Record<string, Value>>>;
}

/** What the API tells of a connection: never its values, only which are set. */
export interface ConnectionInfo extends Connection {
  /** variables with a shared value */
  set: string[];
  /** variables the asker has set their own value of (per-user) */
  mine: string[];
}

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Variables a kernel must not have overridden: they would change how it runs, not what it reaches. */
const RESERVED = new Set(["PATH", "HOME", "USER", "SHELL", "PWD", "LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH", "PYTHONHOME"]);

export class Connections {
  readonly file: string;
  private cache?: File;
  /** writes one after another: two requests never interleave a read-modify-write */
  private writing: Promise<unknown> = Promise.resolve();

  constructor(file = process.env.QUERIER_CONNECTIONS ?? join(configDir, "connections.json")) {
    this.file = file;
  }

  private async read(): Promise<File> {
    if (this.cache) return this.cache;
    const f = Bun.file(this.file);
    this.cache = (await f.exists()) ? await f.json() : { version: 1, connections: [], shared: {}, users: {} };
    return this.cache!;
  }

  private change<T>(fn: (data: File) => T): Promise<T> {
    const next = this.writing.then(async () => {
      const data = structuredClone(await this.read());
      const out = fn(data);
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await Bun.write(this.file, JSON.stringify(data, null, 2) + "\n");
      await chmod(this.file, 0o600);
      this.cache = data;
      return out;
    });
    this.writing = next.catch(() => {});
    return next;
  }

  // -- reading

  async all(): Promise<Connection[]> {
    return (await this.read()).connections;
  }

  async get(id: string): Promise<Connection | undefined> {
    return (await this.read()).connections.find((c) => c.id === id);
  }

  /** What a notebook of `ws` sees: everyone's, and the workspace's. */
  async inScope(ws: string): Promise<Connection[]> {
    return (await this.read()).connections.filter((c) => !c.workspace || c.workspace === ws);
  }

  async info(c: Connection, principal: string): Promise<ConnectionInfo> {
    const data = await this.read();
    return { ...c, set: Object.keys(data.shared[c.id] ?? {}), mine: Object.keys(data.users[c.id]?.[principal] ?? {}) };
  }

  /** The environment `owner`'s kernel of a notebook in `ws` gets: every connection they may use,
   *  with its shared values or their own; the workspace's over everyone's where a name is both. */
  async env(ws: string, owner: string | undefined, mayUse: (c: Connection) => Promise<boolean> | boolean): Promise<Record<string, string>> {
    const data = await this.read();
    const out: Record<string, string> = {};
    const list = data.connections.filter((c) => !c.workspace || c.workspace === ws).sort((a, b) => Number(!!a.workspace) - Number(!!b.workspace) || a.name.localeCompare(b.name));
    for (const c of list) {
      if (!(await mayUse(c))) continue;
      const values = c.credentials === "shared" ? data.shared[c.id] : owner ? data.users[c.id]?.[owner] : undefined;
      for (const v of c.variables) if (values?.[v]) out[v] = values[v].value;
    }
    return out;
  }

  // -- changing

  private check(data: File, c: Pick<Connection, "name" | "workspace" | "variables">, id?: string) {
    if (!NAME.test(c.name)) throw new UserError("A connection's name: a letter, then letters, digits, - and _ (up to 64).");
    const clash = data.connections.find((x) => x.id !== id && x.name.toLowerCase() === c.name.toLowerCase() && (!x.workspace || !c.workspace || x.workspace === c.workspace));
    if (clash) throw new UserError(`There is already a connection named ${clash.name}${clash.workspace ? ` in ${clash.workspace}` : " for everyone"}.`);
    if (!c.variables.length) throw new UserError("A connection gives a kernel at least one variable.");
    if (c.variables.length > 20) throw new UserError("A connection gives at most 20 variables.");
    for (const v of c.variables) {
      if (!VARIABLE.test(v)) throw new UserError(`\`${v}\` can't be an environment variable name: letters, digits and _, not starting with a digit.`);
      if (RESERVED.has(v.toUpperCase()) || v.startsWith("QUERIER_")) throw new UserError(`\`${v}\` is the kernel's own: a connection can't set it.`);
    }
    if (new Set(c.variables).size !== c.variables.length) throw new UserError("Each variable once.");
  }

  async create(c: { name: string; workspace?: string; description?: string; variables: string[]; credentials: Credentials }, by: string): Promise<Connection> {
    return this.change((data) => {
      const made: Connection = {
        id: crypto.randomUUID().slice(0, 12),
        name: c.name.trim(),
        ...(c.workspace ? { workspace: c.workspace } : {}),
        ...(c.description?.trim() ? { description: c.description.trim() } : {}),
        variables: c.variables.map((v) => v.trim()),
        credentials: c.credentials === "per-user" ? "per-user" : "shared",
        created: Date.now(),
        createdBy: by,
        updated: Date.now(),
      };
      this.check(data, made);
      data.connections.push(made);
      return made;
    });
  }

  /** Its name, description, variables or credentials. Values of variables it no longer has go; so do
   *  the other kind's when the credentials change (shared ones aren't anyone's own, and back). */
  async update(id: string, patch: { name?: string; description?: string | null; variables?: string[]; credentials?: Credentials }): Promise<Connection> {
    return this.change((data) => {
      const c = data.connections.find((x) => x.id === id);
      if (!c) throw new UserError("There is no such connection.");
      const next: Connection = {
        ...c,
        ...(patch.name != null ? { name: patch.name.trim() } : {}),
        ...(patch.variables ? { variables: patch.variables.map((v) => v.trim()) } : {}),
        ...(patch.credentials ? { credentials: patch.credentials === "per-user" ? "per-user" : "shared" } : {}),
        updated: Date.now(),
      };
      if (patch.description !== undefined) {
        if (patch.description?.trim()) next.description = patch.description.trim();
        else delete next.description;
      }
      this.check(data, next, id);
      if (next.credentials !== c.credentials) {
        delete data.shared[id];
        delete data.users[id];
      }
      const keep = new Set(next.variables);
      for (const v of Object.keys(data.shared[id] ?? {})) if (!keep.has(v)) delete data.shared[id][v];
      for (const mine of Object.values(data.users[id] ?? {})) for (const v of Object.keys(mine)) if (!keep.has(v)) delete mine[v];
      Object.assign(c, next);
      return c;
    });
  }

  async remove(id: string) {
    await this.change((data) => {
      data.connections = data.connections.filter((c) => c.id !== id);
      delete data.shared[id];
      delete data.users[id];
    });
  }

  /** Values to set (a string) or clear (null), of `owner`'s own (per-user) or the shared ones. */
  async setValues(id: string, values: Record<string, string | null>, owner?: string) {
    await this.change((data) => {
      const c = data.connections.find((x) => x.id === id);
      if (!c) throw new UserError("There is no such connection.");
      if ((c.credentials === "per-user") !== (owner != null)) throw new UserError(c.credentials === "per-user" ? "Each person sets their own credentials for this connection." : "This connection's credentials are shared: set by who manages it.");
      const into = owner != null ? ((data.users[id] ??= {})[owner] ??= {}) : (data.shared[id] ??= {});
      for (const [k, v] of Object.entries(values)) {
        if (!c.variables.includes(k)) throw new UserError(`${c.name} has no variable \`${k}\`.`);
        if (v == null || v === "") delete into[k];
        else into[k] = { value: String(v), updated: Date.now() };
      }
      if (owner != null && !Object.keys(into).length) delete data.users[id][owner];
    });
  }

  /** A workspace was renamed (to) or deleted (null): its connections follow, or go (their ids are returned, for their grants). */
  async moveWorkspace(ws: string, to: string | null): Promise<string[]> {
    return this.change((data) => {
      const mine = data.connections.filter((c) => c.workspace === ws);
      for (const c of mine) {
        if (to) c.workspace = to;
        else {
          delete data.shared[c.id];
          delete data.users[c.id];
        }
      }
      if (!to) data.connections = data.connections.filter((c) => c.workspace !== ws);
      return mine.map((c) => c.id);
    });
  }
}

/** Replace every secret value in `text` with a mask: longest first, so a value
 *  containing another is masked whole. Values under 4 characters are left
 *  alone — masking every "1" or "yes" would garble output for no protection. */
export function redactor(values: Iterable<string>): (text: string) => string {
  const vals = [...new Set(values)].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
  if (!vals.length) return (t) => t;
  return (text) => {
    for (const v of vals) if (text.includes(v)) text = text.split(v).join("••••••");
    return text;
  };
}
