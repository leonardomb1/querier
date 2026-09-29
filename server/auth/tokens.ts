// Short-lived signed tokens for what can't carry the session cookie: a report
// template's script is fetched from a sandboxed frame with no origin of its own.
// HMAC-SHA256 with a key kept in the config directory.

import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir } from "./config";

export class Signer {
  private constructor(private key: CryptoKey) {}

  static async open(file = join(configDir, "signing.key")): Promise<Signer> {
    const f = Bun.file(file);
    let raw: Uint8Array<ArrayBuffer>;
    if (await f.exists()) raw = new Uint8Array(await f.arrayBuffer());
    else {
      raw = crypto.getRandomValues(new Uint8Array(32));
      await mkdir(dirname(file), { recursive: true });
      await Bun.write(file, raw);
      await chmod(file, 0o600);
    }
    return new Signer(await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));
  }

  /** A token for `scope` (e.g. "template:ws/nb"), good for `ttlSeconds`. */
  async sign(scope: string, ttlSeconds = 3600, now = Date.now()): Promise<string> {
    const exp = Math.floor(now / 1000) + ttlSeconds;
    const sig = Buffer.from(await crypto.subtle.sign("HMAC", this.key, new TextEncoder().encode(`${scope}.${exp}`))).toString("base64url");
    return `${exp}.${sig}`;
  }

  async verify(scope: string, token: string, now = Date.now()): Promise<boolean> {
    const [exp, sig] = String(token).split(".");
    if (!exp || !sig || Number(exp) * 1000 < now) return false;
    return crypto.subtle.verify("HMAC", this.key, Buffer.from(sig, "base64url"), new TextEncoder().encode(`${scope}.${exp}`));
  }
}
