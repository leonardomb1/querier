// Who was given what: workspace roles, notebook shares and connection roles, kept in the auth
// database, compiled into policies (policy.ts). They follow a workspace or a
// notebook when it is renamed or moved, and go when it is deleted.

import type { Database } from "bun:sqlite";
import type { Grant, Subject } from "./policy";

export class Grants {
  constructor(private db: Database) {}

  private row = (r: any): Grant => ({ id: r.id, scope: r.scope, target: r.target, subject: JSON.parse(r.subject), role: r.role, createdBy: r.created_by ?? undefined, created: r.created });

  all(): Grant[] {
    return (this.db.query("SELECT * FROM grants ORDER BY created").all() as any[]).map(this.row);
  }

  /** A workspace's grants, or a notebook's. */
  of(scope: Grant["scope"], target: string): Grant[] {
    return (this.db.query("SELECT * FROM grants WHERE scope = ? AND target = ? ORDER BY created").all(scope, target) as any[]).map(this.row);
  }

  get(id: string): Grant | null {
    const r = this.db.query("SELECT * FROM grants WHERE id = ?").get(id);
    return r ? this.row(r) : null;
  }

  add(g: Omit<Grant, "id" | "created">): Grant {
    const grant: Grant = { ...g, id: crypto.randomUUID().slice(0, 12), created: Date.now() };
    this.db
      .query("INSERT INTO grants (id, scope, target, subject, role, created_by, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(grant.id, grant.scope, grant.target, JSON.stringify(grant.subject), grant.role, grant.createdBy ?? null, grant.created!);
    return grant;
  }

  remove(id: string) {
    this.db.query("DELETE FROM grants WHERE id = ?").run(id);
  }

  /** A workspace renamed (to) or deleted (null): its grants, and its notebooks', follow or go. */
  moveWorkspace(from: string, to: string | null) {
    if (to == null) {
      this.db.query("DELETE FROM grants WHERE (scope = 'workspace' AND target = ?) OR (scope = 'notebook' AND target LIKE ?)").run(from, `${from}/%`);
      return;
    }
    this.db.query("UPDATE grants SET target = ? WHERE scope = 'workspace' AND target = ?").run(to, from);
    this.db.query("UPDATE grants SET target = ? || substr(target, ?) WHERE scope = 'notebook' AND target LIKE ?").run(to, from.length + 1, `${from}/%`);
  }

  /** Something deleted: every grant on it goes (a connection's roles). */
  dropTarget(scope: Grant["scope"], target: string) {
    this.db.query("DELETE FROM grants WHERE scope = ? AND target = ?").run(scope, target);
  }

  /** A notebook renamed or moved (to) or deleted (null): its shares follow or go. */
  moveNotebook(from: string, to: string | null) {
    if (to == null) this.db.query("DELETE FROM grants WHERE scope = 'notebook' AND target = ?").run(from);
    else this.db.query("UPDATE grants SET target = ? WHERE scope = 'notebook' AND target = ?").run(to, from);
  }
}

/** A subject as people read it. */
export function describeSubject(s: Subject): string {
  return s.kind === "user" ? s.id : s.kind === "group" ? `group ${s.name}` : s.kind === "everyone" ? "everyone signed in" : `anyone where ${s.when}`;
}

/** A notebook's attributes for policies ({ classification: "confidential" }). Kept here, not in
 *  the notebook's folder: whoever may edit a notebook, or pull into it, can't relabel it. */
export class NotebookAttributes {
  constructor(private db: Database) {}

  get(id: string): Record<string, string> {
    const r = this.db.query("SELECT attrs FROM notebook_attributes WHERE id = ?").get(id) as { attrs: string } | null;
    return r ? JSON.parse(r.attrs) : {};
  }

  set(id: string, attrs: Record<string, string> | null) {
    if (!attrs || !Object.keys(attrs).length) this.db.query("DELETE FROM notebook_attributes WHERE id = ?").run(id);
    else this.db.query("INSERT INTO notebook_attributes (id, attrs) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET attrs = excluded.attrs").run(id, JSON.stringify(attrs));
  }

  /** Every notebook's, for the condition editor's suggestions. */
  all(): Record<string, string>[] {
    return (this.db.query("SELECT attrs FROM notebook_attributes").all() as { attrs: string }[]).map((r) => JSON.parse(r.attrs));
  }

  moveWorkspace(from: string, to: string | null) {
    if (to == null) this.db.query("DELETE FROM notebook_attributes WHERE id LIKE ?").run(`${from}/%`);
    else this.db.query("UPDATE notebook_attributes SET id = ? || substr(id, ?) WHERE id LIKE ?").run(to, from.length + 1, `${from}/%`);
  }

  moveNotebook(from: string, to: string | null) {
    if (to == null) this.db.query("DELETE FROM notebook_attributes WHERE id = ?").run(from);
    else this.db.query("UPDATE notebook_attributes SET id = ? WHERE id = ?").run(to, from);
  }
}
