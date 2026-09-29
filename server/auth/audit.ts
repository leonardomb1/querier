// The audit log: who did what to what, and what was decided. Decisions and
// changes (logins, denials, runs, edits, exports, grants, policies), not every
// keystroke's completion request.

import type { Database } from "bun:sqlite";

export interface AuditEntry {
  actor?: string;
  action: string;
  resource?: string;
  decision?: "allow" | "deny" | "ok" | "fail";
  detail?: Record<string, unknown>;
}

export class Audit {
  constructor(private db: Database) {}

  log(e: AuditEntry, ts = Date.now()) {
    this.db
      .query("INSERT INTO audit (ts, actor, action, resource, decision, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ts, e.actor ?? null, e.action, e.resource ?? null, e.decision ?? null, e.detail ? JSON.stringify(e.detail) : null);
  }

  /** Newest first; `before` (an entry's id) pages back. `actor` is exact, `action` a prefix, `resource` a part. */
  list({ before, limit = 200, actor, action, decision, resource }: { before?: number; limit?: number; actor?: string; action?: string; decision?: string; resource?: string } = {}) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (before) where.push("id < ?"), args.push(before);
    if (actor) where.push("actor = ?"), args.push(actor);
    if (action) where.push("action LIKE ?"), args.push(`${action}%`);
    if (decision) where.push("decision = ?"), args.push(decision);
    if (resource) where.push("resource LIKE ?"), args.push(`%${resource}%`);
    const rows = this.db.query(`SELECT * FROM audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(limit, 1000)) as any[];
    return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : undefined }));
  }
}
