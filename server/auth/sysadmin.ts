// The one sysadmin, from the environment (.env): QUERIER_ADMIN_USER, and
// QUERIER_ADMIN_PASSWORD_HASH (a Bun.password hash from `bun server/auth/hash.ts`,
// base64-encoded as "b64:…": a raw hash's $ signs are expanded by .env readers).
// It is not any provider's: it works when the directory or the identity
// provider is down (break-glass), is subject to no policy, and can't be removed
// from the UI. Querier doesn't start without it.

import type { Principal } from "./principal";

export class Sysadmin {
  readonly username: string;
  private hash: Promise<string>;

  constructor(env: Record<string, string | undefined> = process.env) {
    const user = env.QUERIER_ADMIN_USER?.trim();
    const hash = env.QUERIER_ADMIN_PASSWORD_HASH?.trim();
    const plain = env.QUERIER_ADMIN_PASSWORD;
    if (!user || (!hash && !plain))
      throw new Error(
        "No sysadmin: set QUERIER_ADMIN_USER and QUERIER_ADMIN_PASSWORD_HASH (make one with `bun server/auth/hash.ts`) in .env, or in the container's environment.",
      );
    this.username = user;
    if (hash) {
      const raw = hash.startsWith("b64:") ? Buffer.from(hash.slice(4), "base64").toString() : hash;
      if (!raw.startsWith("$")) throw new Error("QUERIER_ADMIN_PASSWORD_HASH isn't a password hash: make one with `bun server/auth/hash.ts` (its b64: form survives .env files).");
      this.hash = Promise.resolve(raw);
    }
    else {
      console.warn("QUERIER_ADMIN_PASSWORD is set in plain text: prefer QUERIER_ADMIN_PASSWORD_HASH (`bun server/auth/hash.ts`).");
      this.hash = Bun.password.hash(plain!);
    }
  }

  async verify(username: string, password: string): Promise<boolean> {
    // compared even when the name is wrong: the answer takes as long either way
    const ok = await Bun.password.verify(password, await this.hash).catch(() => false);
    return ok && username === this.username;
  }

  /** Which account this is: its name and hash. Sessions of another (an edited .env) end. */
  async fingerprint(): Promise<string> {
    return new Bun.CryptoHasher("sha256").update(`${this.username}\0${await this.hash}`).digest("hex");
  }

  principal(): Principal {
    return { id: `sysadmin:${this.username}`, provider: "sysadmin", subject: this.username, username: this.username, name: "System administrator", groups: [], attrs: {}, sysadmin: true };
  }
}
