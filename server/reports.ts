// Published reports: a notebook's report as its viewers get it. Publishing
// freezes the code (every cell's source, the layout, report.svelte) as it is,
// with how it runs: as each viewer (their own connections, single sign-on) or
// as its owner (the publisher's connections: only they can choose that, it's
// their credentials they lend). Code that runs with someone's credentials must
// be code they approved, so an owner's report runs what they published, never
// the live folder a Contributor can change: an edit reaches viewers when it is
// published again.
//
// Bound PARAMs are how rows are kept apart: a PARAM bound to a tag of the viewer
// (region = principal.getTag("region")) is set by the server on every run,
// never by the viewer. A report run as its owner can also be scheduled: the
// server runs it and viewers open it already run, without a kernel of their own
// until they change something.
//
// Kept in the auth database, not in the notebook's folder: whoever may edit the
// notebook, or pull into it, can't change who it runs as or what is bound.

import type { Database } from "bun:sqlite";
import { hash } from "../shared/hash";
import type { Cell, ParamDecl } from "./notebook";
import type { Report } from "./store";

export type RunAs = "viewer" | "owner";

export interface Published {
  cells: Pick<Cell, "name" | "lang" | "source" | "file">[];
  report?: Report;
  template?: string | null;
  params: ParamDecl[];
  title: string;
  description?: string;
  runAs: RunAs;
  /** runAs owner: whose connections (the publisher) */
  owner?: string;
  /** PARAM → the viewer's tag it takes */
  bindings: Record<string, string>;
  /** runAs owner, nothing bound: run by the server this often (minutes) */
  schedule?: { every: number };
  publishedBy: string;
  publishedAt: number;
  /** what was published: to tell when the live notebook has moved on */
  version: string;
  /** the environments applied when it was published (environments.ts): what it runs and bundles with, whatever changes after */
  envs?: { wsPython?: string; nbPython?: string; wsJs?: string; nbJs?: string };
  /** a link anyone may open without signing in (when administrators allow them) */
  public?: PublicLink;
}

/** A public link: what it serves is the report's last run as its owner, refreshed when older than
 *  `refresh` minutes. Its PARAMs keep their defaults (nobody sets them), and no code is sent. */
export interface PublicLink {
  /** the link's secret (/p/<token>): a new one ends the old link */
  token: string;
  createdBy: string;
  createdAt: number;
  /** minutes a run's results are served before a visit runs it again */
  refresh: number;
  /** where it may be opened from (within the server's own list, when it has one) */
  networks?: string[];
  /** epoch ms: gone after */
  expires?: number;
  /** a passcode viewers type once (its hash); bumped when it changes, so earlier unlocks end */
  passcode?: { hash: string; version: number };
  /** who may show it in a frame: nobody else (the default), anyone, or these origins */
  embed: "none" | "any" | string[];
}

/** A version for what a report shows: its cells' sources, its layout and template. */
export function reportVersion(p: { cells: { name: string; source: string }[]; report?: Report; template?: string | null }): string {
  return hash(JSON.stringify([p.cells.map((c) => [c.name, c.source]), p.report ?? null, p.template ?? null]));
}

export class Reports {
  constructor(private db: Database) {}

  get(nb: string): Published | null {
    const r = this.db.query("SELECT data FROM reports WHERE id = ?").get(nb) as { data: string } | null;
    return r ? JSON.parse(r.data) : null;
  }

  all(): [string, Published][] {
    return (this.db.query("SELECT id, data FROM reports").all() as { id: string; data: string }[]).map((r) => [r.id, JSON.parse(r.data)]);
  }

  /** The published report a public link's token opens, if any. */
  byToken(token: string): [string, Published] | null {
    if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return null;
    for (const [nb, p] of this.all()) if (p.public?.token === token) return [nb, p];
    return null;
  }

  set(nb: string, p: Published) {
    this.db.query("INSERT INTO reports (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(nb, JSON.stringify(p));
  }

  remove(nb: string) {
    this.db.query("DELETE FROM reports WHERE id = ?").run(nb);
  }

  moveWorkspace(from: string, to: string | null) {
    if (to == null) this.db.query("DELETE FROM reports WHERE id LIKE ?").run(`${from}/%`);
    else this.db.query("UPDATE reports SET id = ? || substr(id, ?) WHERE id LIKE ?").run(to, from.length + 1, `${from}/%`);
  }

  moveNotebook(from: string, to: string | null) {
    if (to == null) this.remove(from);
    else this.db.query("UPDATE reports SET id = ? WHERE id = ?").run(to, from);
  }
}
