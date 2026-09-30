// The one sysadmin. It is not any provider's: it works when the directory or the
// identity provider is down (break-glass), is subject to no policy, and can't be
// removed from the UI. Its account is either
// - Querier's own (the default): made on the first start, with a generated
//   password printed to the log (`docker compose logs`) until it is changed from
//   the account menu, which the first sign-in asks for. Stored hashed in
//   <config>/sysadmin.json; deleting that file and restarting makes a new one
//   (a lost password). QUERIER_ADMIN_USER names it (default "admin").
// - or the environment's (.env): QUERIER_ADMIN_USER with QUERIER_ADMIN_PASSWORD_HASH
//   (a Bun.password hash from `bun server/auth/hash.ts`, base64-encoded as "b64:…":
//   a raw hash's $ signs are expanded by .env readers). It is changed only there.

import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir } from "./config";
import type { Principal } from "./principal";

type Env = Record<string, string | undefined>;
type Stored = { username: string; hash: string; initialPassword?: string };

export const sysadminFile = () => join(configDir, "sysadmin.json");
export const MIN_PASSWORD = 12;

export class Sysadmin {
  readonly username: string;
  private hash: Promise<string>;
  private file?: string;
  /** where the account lives: .env's, or Querier's own file (changeable from the UI) */
  readonly source: "env" | "file";
  /** the generated password, until it is changed: the first sign-in asks for a new one */
  private initial?: string;

  /** The environment's account; throws when it has none (see `open`). */
  constructor(env: Env = process.env, stored?: { file: string; account: Stored }) {
    if (stored) {
      this.source = "file";
      this.file = stored.file;
      this.username = stored.account.username;
      this.hash = Promise.resolve(stored.account.hash);
      this.initial = stored.account.initialPassword;
      return;
    }
    const user = env.QUERIER_ADMIN_USER?.trim();
    const hash = env.QUERIER_ADMIN_PASSWORD_HASH?.trim();
    const plain = env.QUERIER_ADMIN_PASSWORD;
    if (!user || (!hash && !plain)) throw new Error("No sysadmin in the environment: QUERIER_ADMIN_USER with QUERIER_ADMIN_PASSWORD_HASH.");
    this.source = "env";
    this.username = user;
    if (hash) {
      const raw = hash.startsWith("b64:") ? Buffer.from(hash.slice(4), "base64").toString() : hash;
      if (!raw.startsWith("$")) throw new Error("QUERIER_ADMIN_PASSWORD_HASH isn't a password hash: make one with `bun server/auth/hash.ts` (its b64: form survives .env files).");
      this.hash = Promise.resolve(raw);
    } else {
      console.warn("QUERIER_ADMIN_PASSWORD is set in plain text: prefer QUERIER_ADMIN_PASSWORD_HASH (`bun server/auth/hash.ts`).");
      this.hash = Bun.password.hash(plain!);
    }
  }

  /** The environment's account if it has one, else Querier's own: made (and its password printed) on the first start. */
  static async open(env: Env = process.env, file = sysadminFile()): Promise<Sysadmin> {
    if (env.QUERIER_ADMIN_PASSWORD_HASH?.trim() || env.QUERIER_ADMIN_PASSWORD) {
      if (!env.QUERIER_ADMIN_USER?.trim()) throw new Error("QUERIER_ADMIN_PASSWORD_HASH is set without QUERIER_ADMIN_USER: set both in .env, or neither (Querier then makes its own sysadmin).");
      return new Sysadmin(env);
    }
    const f = Bun.file(file);
    let account: Stored;
    if (await f.exists()) {
      account = (await f.json()) as Stored;
      if (!account.username || !account.hash?.startsWith("$")) throw new Error(`${file} isn't a sysadmin account: delete it, and a new one is made on the next start.`);
    } else {
      const password = generatePassword();
      account = { username: env.QUERIER_ADMIN_USER?.trim() || "admin", hash: await Bun.password.hash(password), initialPassword: password };
      await save(file, account);
    }
    // QUERIER_ADMIN_USER renames it
    const rename = env.QUERIER_ADMIN_USER?.trim();
    if (rename && rename !== account.username) {
      account = { ...account, username: rename };
      await save(file, account);
    }
    const s = new Sysadmin(env, { file, account });
    if (s.initial) announce(s.username, s.initial, file);
    return s;
  }

  /** Still on the generated password: the first sign-in asks for a new one. */
  get mustChangePassword(): boolean {
    return !!this.initial;
  }

  async verify(username: string, password: string): Promise<boolean> {
    // compared even when the name is wrong: the answer takes as long either way
    const ok = await Bun.password.verify(password, await this.hash).catch(() => false);
    return ok && username === this.username;
  }

  /** A new password for Querier's own account (the environment's changes only there). */
  async setPassword(next: string): Promise<void> {
    if (this.source !== "file" || !this.file) throw new Error("The sysadmin's password is set in the environment (QUERIER_ADMIN_PASSWORD_HASH in .env): change it there.");
    if (next.length < MIN_PASSWORD) throw new Error(`A password of at least ${MIN_PASSWORD} characters.`);
    if (this.initial && next === this.initial) throw new Error("Not the generated password: one of your own.");
    const hash = await Bun.password.hash(next);
    await save(this.file, { username: this.username, hash });
    this.hash = Promise.resolve(hash);
    this.initial = undefined;
  }

  /** Which account this is: its name and hash. Sessions of another (a new password, an edited .env) end. */
  async fingerprint(): Promise<string> {
    return new Bun.CryptoHasher("sha256").update(`${this.username}\0${await this.hash}`).digest("hex");
  }

  principal(): Principal {
    return { id: `sysadmin:${this.username}`, provider: "sysadmin", subject: this.username, username: this.username, name: "System administrator", groups: [], attrs: {}, sysadmin: true };
  }
}

async function save(file: string, account: Stored) {
  await mkdir(dirname(file), { recursive: true });
  await Bun.write(file, JSON.stringify(account, null, 2) + "\n");
  await chmod(file, 0o600);
}

/** 20 characters in four groups, from letters and digits nobody misreads: over 100 bits. */
export function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const out: string[] = [];
  // rejection sampling: every character equally likely
  while (out.length < 20) for (const b of crypto.getRandomValues(new Uint8Array(32))) if (b < 220 && out.length < 20) out.push(alphabet[b % 55]);
  return [0, 5, 10, 15].map((i) => out.slice(i, i + 5).join("")).join("-");
}

function announce(username: string, password: string, file: string) {
  const lines = [
    "Querier's system administrator:",
    "",
    `  username: ${username}`,
    `  password: ${password}`,
    "",
    'Sign in with "System administrator"; the first sign-in asks for',
    "a password of your own. Until then this is printed on every start.",
    `Lost it later? Delete ${file} and restart.`,
  ];
  const width = Math.max(...lines.map((l) => l.length));
  const bar = "─".repeat(width + 2);
  console.log(`┌${bar}┐\n${lines.map((l) => `│ ${l.padEnd(width)} │`).join("\n")}\n└${bar}┘`);
}
