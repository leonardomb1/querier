// Signed-in sessions: a random id in an HttpOnly cookie, only its hash kept.
// A session ends when idle too long, at its absolute limit, on sign-out, or
// when a refresh finds the person gone or disabled.

import type { Database } from "bun:sqlite";
import type { AuthConfig } from "./config";
import { secureCookies } from "./config";
import type { Principal } from "./principal";

export const COOKIE = "querier_session";

export interface Session {
  idHash: string;
  principal: Principal;
  provider: string;
  refresh?: string;
  created: number;
  lastSeen: number;
  refreshed: number;
  expires: number;
}

const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

export class Sessions {
  constructor(
    private db: Database,
    private cfg: () => AuthConfig["session"],
  ) {}

  create(principal: Principal, refresh?: string, now = Date.now()): { id: string; session: Session } {
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const s: Session = { idHash: sha(id), principal, provider: principal.provider, refresh, created: now, lastSeen: now, refreshed: now, expires: now + this.cfg().absoluteHours * 3600_000 };
    this.db
      .query("INSERT INTO sessions (id_hash, principal, principal_id, provider, refresh, created, last_seen, refreshed, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(s.idHash, JSON.stringify(principal), principal.id, s.provider, refresh ?? null, s.created, s.lastSeen, s.refreshed, s.expires);
    return { id, session: s };
  }

  /** The live session for a cookie's id, or null (and an expired one is removed). */
  get(id: string, now = Date.now()): Session | null {
    if (!id) return null;
    const row = this.db.query("SELECT * FROM sessions WHERE id_hash = ?").get(sha(id)) as any;
    if (!row) return null;
    const idleMs = this.cfg().idleMinutes * 60_000;
    if (row.expires <= now || now - row.last_seen > idleMs) {
      this.db.query("DELETE FROM sessions WHERE id_hash = ?").run(row.id_hash);
      return null;
    }
    // seen: written at most once a minute
    if (now - row.last_seen > 60_000) this.db.query("UPDATE sessions SET last_seen = ? WHERE id_hash = ?").run(now, row.id_hash);
    return { idHash: row.id_hash, principal: JSON.parse(row.principal), provider: row.provider, refresh: row.refresh ?? undefined, created: row.created, lastSeen: now, refreshed: row.refreshed, expires: row.expires };
  }

  dueForRefresh(s: Session, now = Date.now()) {
    return now - s.refreshed > this.cfg().refreshMinutes * 60_000;
  }

  update(s: Session, principal: Principal, refresh?: string, now = Date.now()) {
    this.db.query("UPDATE sessions SET principal = ?, refresh = ?, refreshed = ? WHERE id_hash = ?").run(JSON.stringify(principal), refresh ?? null, now, s.idHash);
    s.principal = principal;
    s.refresh = refresh;
    s.refreshed = now;
  }

  end(idHash: string) {
    this.db.query("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
  }

  cookie(id: string): string {
    return `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${this.cfg().absoluteHours * 3600}${secureCookies ? "; Secure" : ""}`;
  }
  clearCookie(): string {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookies ? "; Secure" : ""}`;
  }
}

/** A cookie's value from a request. */
export function cookieOf(req: Request, name = COOKIE): string {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}
