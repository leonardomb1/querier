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
import { homedir } from "node:os";
import { UserError } from "../store";

export const LEVELS = ["off", "read", "run", "edit"] as const;
export type Level = (typeof LEVELS)[number];
export const DEFAULT_LEVEL: Level = "read";

export interface ClientInfo {
  id: string;
  name: string;
  created: number;
  lastUsed?: number;
}

interface File {
  clients: (ClientInfo & { hash: string })[];
  access: Record<string, Level>;
}

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

export class Access {
  readonly file: string;
  private cache?: File;

  constructor(file = process.env.QUERIER_MCP ?? join(dirname(process.env.QUERIER_SECRETS ?? join(homedir(), ".config/querier/secrets.json")), "mcp.json")) {
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

  async clients(): Promise<ClientInfo[]> {
    return (await this.read()).clients.map(({ hash: _, ...c }) => c);
  }

  /** A new client; its token is returned once and never again. */
  async create(name: string): Promise<{ client: ClientInfo; token: string }> {
    name = name.trim();
    if (!name) throw new UserError("Name the client, e.g. “Claude Code on my laptop”.");
    const data = structuredClone(await this.read());
    const token = `qk_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")}`;
    const client = { id: crypto.randomUUID().slice(0, 8), name, created: Date.now() };
    data.clients.push({ ...client, hash: sha256(token) });
    await this.write(data);
    return { client, token };
  }

  async revoke(id: string) {
    const data = structuredClone(await this.read());
    data.clients = data.clients.filter((c) => c.id !== id);
    await this.write(data);
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

  async level(nb: string): Promise<Level> {
    return (await this.read()).access[nb] ?? DEFAULT_LEVEL;
  }

  async setLevel(nb: string, level: Level) {
    if (!LEVELS.includes(level)) throw new UserError(`Access must be one of ${LEVELS.join(", ")}.`);
    const data = structuredClone(await this.read());
    if (level === DEFAULT_LEVEL) delete data.access[nb];
    else data.access[nb] = level;
    await this.write(data);
  }
}

/** Whether `have` allows what `need` asks. */
export const allows = (have: Level, need: Exclude<Level, "off">) => LEVELS.indexOf(have) >= LEVELS.indexOf(need);
