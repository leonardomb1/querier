// REST for files: notebooks and their cells.

export type Lang = "sql" | "python" | "md";

export interface Cell {
  file: string;
  name: string;
  lang: Lang;
  source: string;
}

export interface ParamDecl {
  name: string;
  type: string;
  default?: string;
  cell: string;
}

export interface SandboxSettings {
  vcpus?: number;
  /** MiB */
  memory?: number;
  egress?: string[];
}

export interface Notebook {
  name: string;
  title: string;
  description?: string;
  sandbox?: SandboxSettings;
  report?: Report;
  /** report.svelte, when the report has a template */
  template?: string;
  cells: Cell[];
  params: ParamDecl[];
  files: string[];
}

export interface NotebookSummary {
  name: string;
  title: string;
  description?: string;
  sql: number;
  python: number;
  text: number;
  /** Last change to any file in the folder, epoch ms. */
  modified: number;
  /** Set when the folder does not load. */
  problem?: string;
}

export interface NotebookIndex {
  /** Where notebook folders live on the server. */
  root: string;
  notebooks: NotebookSummary[];
}

/** A failed call: `status` is the HTTP status, or 0 when the server was not reached. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("The querier server can't be reached.", 0);
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(out.error ?? res.statusText, res.status);
  return out as T;
}

const nbPath = (nb: string) => `/notebooks/${encodeURIComponent(nb)}`;
const cellPath = (nb: string, cell: string) => `${nbPath(nb)}/cells/${encodeURIComponent(cell)}`;

/** How a PARAM shows in the report: a text box, a dropdown fed by a cell or a list, or (from/to) the time picker. */
export interface VarSpec {
  control: "text" | "select" | "time";
  source?: { cell: string; column?: string } | { values: string[] };
}

/** How a notebook reads as a report (notebook.json `report`). */
export interface Report {
  /** What shows, in order; absent: the default (shared/report.ts). */
  blocks?: Block[];
  /** Before blocks: shown or hidden against the default, and half-width cells. */
  show?: Record<string, boolean>;
  half?: string[];
  /** Grafana's relative range (`now-7d` … `now`), bound to the `from` / `to` PARAMs. */
  time?: { from: string; to: string };
  /** Re-run the report's cells this often while it is open: "30s", "1m", "5m", "15m", "1h". */
  refresh?: string;
  variables?: Record<string, VarSpec>;
  /** Shown as its blocks or as report.svelte (default: the template when there is one). */
  view?: "blocks" | "template";
}

export type CellChange = "added" | "modified" | "deleted" | "moved";

export interface GitStatus {
  tracked: boolean;
  declined: boolean;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  remote?: string;
  identity: { name?: string; email?: string };
  head?: { hash: string; subject: string };
  cells: { name: string; change: CellChange; file?: string; was?: string }[];
  files: { path: string; change: "added" | "modified" | "deleted" }[];
  original: Record<string, string>;
  conflict?: string;
}

export interface Commit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: number;
  cells: string[];
  parents: string[];
  refs: { name: string; kind: "head" | "branch" | "remote" | "tag" }[];
  head: boolean;
}

export interface CommitDetail {
  hash: string;
  subject: string;
  body: string;
  author: string;
  date: number;
  cells: { name: string; change: "added" | "modified" | "deleted"; before: string; after: string }[];
}

export interface SecretInfo {
  name: string;
  scope: "global" | "notebook";
  updated: number;
  shadowed?: boolean;
}

export interface TemplateError {
  message: string;
  line?: number;
  col?: number;
}

export type AiLevel = "off" | "read" | "run" | "edit";

export interface AiClient {
  id: string;
  name: string;
  created: number;
  lastUsed?: number;
}

export type { Block, Part } from "../../../shared/report";
import type { Block } from "../../../shared/report";

export const api = {
  list: () => call<NotebookIndex>("GET", "/notebooks"),
  create: (name: string, title?: string) => call("POST", "/notebooks", { name, title }),
  load: (nb: string) => call<Notebook>("GET", nbPath(nb)),
  settings: (nb: string, patch: { title?: string; description?: string | null; sandbox?: SandboxSettings | null; report?: Report }) =>
    call("PATCH", nbPath(nb), patch),
  addCell: (nb: string, lang: Lang, after: string | null) =>
    call<{ name: string }>("POST", `${nbPath(nb)}/cells`, { lang, after }),
  save: (nb: string, cell: string, source: string) => call("PUT", cellPath(nb, cell), { source }),
  rename: (nb: string, cell: string, name: string) => call<{ updated: string[] }>("PATCH", cellPath(nb, cell), { name }),
  move: (nb: string, cell: string, by: number) => call("PATCH", cellPath(nb, cell), { move: by }),
  setLang: (nb: string, cell: string, lang: Lang) => call("PATCH", cellPath(nb, cell), { lang }),
  remove: (nb: string, cell: string) => call("DELETE", cellPath(nb, cell)),

  git: {
    status: (nb: string) => call<GitStatus>("GET", `${nbPath(nb)}/git`),
    init: (nb: string, who: { name: string; email: string; remote?: string }) => call("POST", `${nbPath(nb)}/git/init`, who),
    decline: (nb: string) => call("POST", `${nbPath(nb)}/git/decline`, {}),
    commit: (nb: string, message: string) => call("POST", `${nbPath(nb)}/git/commit`, { message }),
    restore: (nb: string, rev?: string, cells?: string[]) => call("POST", `${nbPath(nb)}/git/restore`, { rev, cells }),
    log: (nb: string) => call<Commit[]>("GET", `${nbPath(nb)}/git/log`),
    show: (nb: string, rev: string) => call<CommitDetail>("GET", `${nbPath(nb)}/git/commits/${rev}`),
    branches: (nb: string) => call<{ name: string; current: boolean }[]>("GET", `${nbPath(nb)}/git/branches`),
    createBranch: (nb: string, name: string) => call("POST", `${nbPath(nb)}/git/branches`, { name }),
    switchBranch: (nb: string, name: string) => call("POST", `${nbPath(nb)}/git/switch`, { name }),
    setRemote: (nb: string, url: string) => call("POST", `${nbPath(nb)}/git/remote`, { url }),
    fetch: (nb: string) => call("POST", `${nbPath(nb)}/git/fetch`, {}),
    pull: (nb: string, rebase = false) => call("POST", `${nbPath(nb)}/git/pull`, { rebase }),
    push: (nb: string) => call("POST", `${nbPath(nb)}/git/push`, {}),
  },
  ai: {
    level: (nb: string) => call<{ level: AiLevel }>("GET", `${nbPath(nb)}/ai`),
    setLevel: (nb: string, level: AiLevel) => call("PUT", `${nbPath(nb)}/ai`, { level }),
    clients: () => call<{ file: string; clients: AiClient[] }>("GET", "/ai/clients"),
    // the token comes back this once
    createClient: (name: string) => call<{ client: AiClient; token: string }>("POST", "/ai/clients", { name }),
    revoke: (id: string) => call("DELETE", `/ai/clients/${encodeURIComponent(id)}`),
  },
  template: {
    get: (nb: string) => call<{ source: string | null; version?: string; error?: TemplateError | null }>("GET", `${nbPath(nb)}/template`),
    save: (nb: string, source: string) => call<{ version: string; error: TemplateError | null }>("PUT", `${nbPath(nb)}/template`, { source }),
    remove: (nb: string) => call("DELETE", `${nbPath(nb)}/template`),
  },
  // values go in, never come back out
  secrets: (nb: string) => call<{ file: string; secrets: SecretInfo[] }>("GET", `${nbPath(nb)}/secrets`),
  setSecret: (nb: string, name: string, value: string, scope: SecretInfo["scope"]) =>
    call("PUT", `${nbPath(nb)}/secrets/${encodeURIComponent(name)}`, { value, scope }),
  removeSecret: (nb: string, name: string, scope: SecretInfo["scope"]) =>
    call("DELETE", `${nbPath(nb)}/secrets/${encodeURIComponent(name)}?scope=${scope}`),
};
