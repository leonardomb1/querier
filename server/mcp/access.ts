// Who may use Querier over MCP, and how far into each notebook.
//
// A client is an AI tool (Claude Code, Claude Desktop, ...) holding a token made
// here; only a hash of it is kept. Each notebook has an access level, kept on the
// server next to the secrets (never in the notebook's folder, so a pulled repo
// can't grant itself more):
//   off   invisible
//   read  code, how cells depend on each other, schemas, errors: no rows
//   run   also runs cells and queries, and sees what they return
//   edit  also changes cells and the report layout
// A notebook without a level of its own has `read`.

import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir } from "../auth/config";
import { UserError } from "../store";

export const LEVELS = ["off", "read", "run", "edit"] as const;
export type Level = (typeof LEVELS)[number];
export const DEFAULT_LEVEL: Level = "read";

export interface ClientInfo {
  id: string;
  name: string;
  created: number;
  lastUsed?: number;
  /** the principal the token acts as: a personal access token */
  owner?: string;
  /** given an owner when accounts came: it had none before */
  adopted?: boolean;
}

interface File {
  clients: (ClientInfo & { hash: string })[];
  /** by notebook id, "workspace/notebook" */
  access: Record<string, Level>;
  /** a workspace's default for its notebooks */
  workspaces?: Record<string, Level>;
}

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

export class Access {
  readonly file: string;
  private cache?: File;

  constructor(file = process.env.QUERIER_MCP ?? join(configDir, "mcp.json")) {
    this.file = file;
  }

  private async read(): Promise<File> {
    if (this.cache) return this.cache;
    const f = Bun.file(this.file);
    this.cache = (await f.exists()) ? await f.json() : { clients: [], access: {} };
    return this.cache!;
  }

  private async write(data: File) {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await Bun.write(this.file, JSON.stringify(data, null, 2) + "\n");
    await chmod(this.file, 0o600);
    this.cache = data;
  }

  /** Clients: every one, or `owner`'s. */
  async clients(owner?: string): Promise<ClientInfo[]> {
    return (await this.read()).clients.filter((c) => owner == null || c.owner === owner).map(({ hash: _, ...c }) => c);
  }

  /** A new client acting as `owner`; its token is returned once and never again. */
  async create(name: string, owner: string): Promise<{ client: ClientInfo; token: string }> {
    name = name.trim();
    if (!name) throw new UserError("Name the client, e.g. “Claude Code on my laptop”.");
    const data = structuredClone(await this.read());
    const token = `qk_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")}`;
    const client: ClientInfo = { id: crypto.randomUUID().slice(0, 8), name, created: Date.now(), owner };
    data.clients.push({ ...client, hash: sha256(token) });
    await this.write(data);
    return { client, token };
  }

  /** Revoke a client; with `owner`, only one of theirs. */
  async revoke(id: string, owner?: string) {
    const data = structuredClone(await this.read());
    const c = data.clients.find((x) => x.id === id);
    if (!c || (owner != null && c.owner !== owner)) throw new UserError("There is no such client.");
    data.clients = data.clients.filter((x) => x.id !== id);
    await this.write(data);
  }

  /** Tokens from before accounts had no owner: they become `owner`'s (the sysadmin's), marked adopted. */
  async adopt(owner: string): Promise<number> {
    const data = structuredClone(await this.read());
    const orphans = data.clients.filter((c) => !c.owner);
    if (!orphans.length) return 0;
    for (const c of orphans) Object.assign(c, { owner, adopted: true });
    await this.write(data);
    return orphans.length;
  }

  /** The client a bearer token belongs to, if any. */
  async verify(token: string): Promise<ClientInfo | null> {
    const data = await this.read();
    const h = sha256(token);
    const c = data.clients.find((c) => c.hash.length === h.length && crypto.timingSafeEqual(Buffer.from(c.hash), Buffer.from(h)));
    if (!c) return null;
    // remembered at most once a minute: not a write per request
    if (!c.lastUsed || Date.now() - c.lastUsed > 60_000) {
      const next = structuredClone(data);
      next.clients.find((x) => x.id === c.id)!.lastUsed = Date.now();
      await this.write(next).catch(() => {});
    }
    const { hash: _, ...info } = c;
    return info;
  }

  /** A notebook's level: its own, else its workspace's default, else read. */
  async level(nb: string): Promise<Level> {
    const data = await this.read();
    return data.access[nb] ?? data.workspaces?.[nb.split("/")[0]] ?? DEFAULT_LEVEL;
  }

  /** Whether the notebook has a level of its own (not its workspace's). */
  async ownLevel(nb: string): Promise<Level | null> {
    return (await this.read()).access[nb] ?? null;
  }

  async workspaceLevel(ws: string): Promise<Level> {
    return (await this.read()).workspaces?.[ws] ?? DEFAULT_LEVEL;
  }

  async setWorkspaceLevel(ws: string, level: Level) {
    if (!LEVELS.includes(level)) throw new UserError(`Access must be one of ${LEVELS.join(", ")}.`);
    const data = structuredClone(await this.read());
    data.workspaces ??= {};
    if (level === DEFAULT_LEVEL) delete data.workspaces[ws];
    else data.workspaces[ws] = level;
    await this.write(data);
  }

  /** Notebooks from before workspaces: their levels go under their new ids. */
  async migrate(moved: string[], ws: string) {
    const data = structuredClone(await this.read());
    let changed = false;
    for (const nb of moved) {
      if (!(nb in data.access)) continue;
      data.access[`${ws}/${nb === ws ? `${nb}-notebook` : nb}`] = data.access[nb];
      delete data.access[nb];
      changed = true;
    }
    if (changed) await this.write(data);
  }

  /** A workspace was renamed (to) or deleted (null). */
  async moveWorkspace(ws: string, to: string | null) {
    const data = structuredClone(await this.read());
    if (data.workspaces?.[ws]) {
      if (to) data.workspaces[to] = data.workspaces[ws];
      delete data.workspaces[ws];
    }
    for (const id of Object.keys(data.access)) {
      if (id.split("/")[0] !== ws) continue;
      if (to) data.access[`${to}/${id.split("/")[1]}`] = data.access[id];
      delete data.access[id];
    }
    await this.write(data);
  }

  /** A notebook was renamed (to) or deleted (null): its level follows, or goes. */
  async moveNotebook(from: string, to: string | null) {
    const data = structuredClone(await this.read());
    if (!(from in data.access)) return;
    if (to) data.access[to] = data.access[from];
    delete data.access[from];
    await this.write(data);
  }

  /** A notebook's own level; null returns it to its workspace's default. */
  async setLevel(nb: string, level: Level | null) {
    if (level != null && !LEVELS.includes(level)) throw new UserError(`Access must be one of ${LEVELS.join(", ")}.`);
    const data = structuredClone(await this.read());
    if (level == null) delete data.access[nb];
    else data.access[nb] = level;
    await this.write(data);
  }
}

/** Whether `have` allows what `need` asks. */
export const allows = (have: Level, need: Exclude<Level, "off">) => LEVELS.indexOf(have) >= LEVELS.indexOf(need);
