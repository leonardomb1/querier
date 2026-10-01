// REST for files: notebooks and their cells.

export type Lang = "sql" | "python" | "md";

export interface Cell {
  file: string;
  name: string;
  lang: Lang;
  source: string;
  /** its source's hash, where the source isn't sent (a published report seen without its code) */
  hash?: string;
}

/** A notebook's published report: who published it, how it runs, whether the live notebook moved on. */
export interface PublishedInfo {
  at: number;
  by: string;
  /** with each viewer's connections, or its owner's */
  runAs: "viewer" | "owner";
  owner?: string;
  /** PARAM → the viewer's tag the server sets it from */
  bindings?: Record<string, string>;
  /** minutes between the server's runs of it (run as its owner) */
  schedule?: { every: number };
  /** the live notebook has changed since (editors only) */
  changed?: boolean;
  /** when the scheduled run viewers see was made */
  snapshotAt?: number;
  /** its public link (for who may make one): null when it has none */
  public?: PublicLinkInfo | null;
  /** whether the server allows public links, and the networks they must stay within */
  publicAllowed?: { enabled: boolean; networks: string[] };
}

/** A public link to a published report, as its editors see it (the passcode as whether there is one). */
export interface PublicLinkInfo {
  token: string;
  path: string;
  refresh: number;
  networks: string[];
  expires: number | null;
  passcode: boolean;
  embed: "none" | "any" | string[];
  createdAt: number;
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
  /** its id, "workspace/notebook" */
  name: string;
  workspace: string;
  title: string;
  description?: string;
  sandbox?: SandboxSettings;
  report?: Report;
  /** report.svelte, when the report has a template */
  template?: string;
  cells: Cell[];
  params: ParamDecl[];
  files: string[];
  /** what the signed-in person may do to it */
  permissions: Action[];
  /** they may view it, not read its code: its cells come without source */
  codeHidden?: boolean;
  /** its report, if published */
  published?: PublishedInfo;
  /** a published report's: its PARAMs the server sets (not the viewer's controls), and to what for this viewer */
  bound?: string[];
  boundValues?: Record<string, string>;
  /** a published report's template bundle: fetched with this token, at this version */
  templateToken?: string;
  templateVersion?: string;
}

/** What a person may do (the server's policy actions). */
export type Action =
  | "workspace.create"
  | "admin.manage"
  | "workspace.view"
  | "workspace.manage"
  | "workspace.manageAccess"
  | "notebook.create"
  | "notebook.view"
  | "notebook.readCode"
  | "notebook.run"
  | "notebook.shell"
  | "notebook.edit"
  | "notebook.delete"
  | "notebook.share"
  | "report.view"
  | "report.publishPublic"
  | "git.pull"
  | "git.push"
  | "sandbox.manage"
  | "environment.manage"
  | "ai.configure"
  | "connection.use"
  | "connection.manage";

export const WORKSPACE_ROLES = ["Viewer", "Contributor", "Member", "Admin"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export const SHARE_LEVELS = ["Read", "Run", "Edit", "Reshare"] as const;
export type ShareLevel = (typeof SHARE_LEVELS)[number];
export const CONNECTION_ROLES = ["User", "Owner"] as const;
export type ConnectionRole = (typeof CONNECTION_ROLES)[number];
/** What a grant is on: a workspace (roles), a notebook (shares), a connection (its roles). */
export type AccessScope = "workspace" | "notebook" | "connection";

/** Who a grant is for. `condition`: a Cedar expression over principal's tags. */
export type Subject = { kind: "user"; id: string } | { kind: "group"; name: string } | { kind: "everyone" } | { kind: "condition"; when: string };

/** A workspace role or a notebook share, as the access dialog lists it. */
export interface Grant {
  id: string;
  scope: AccessScope;
  target: string;
  subject: Subject;
  role: WorkspaceRole | ShareLevel | ConnectionRole;
  createdBy?: string;
  created?: number;
  /** who, readably; `detail`: an email or id under it */
  label: string;
  detail?: string;
}

export interface DirectoryHits {
  people: { id: string; username: string; name?: string; email?: string; provider: string }[];
  groups: string[];
}

export interface NotebookSummary {
  /** "workspace/notebook" */
  id: string;
  workspace: string;
  /** the folder's name */
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
  permissions: Action[];
  /** its report is published */
  published?: boolean;
}

/** A workspace: a folder of notebooks, with settings they share. */
export interface WorkspaceSummary {
  name: string;
  title: string;
  description?: string;
  /** key/value tags, for policies to come */
  attributes: Record<string, string>;
  /** its notebooks' sandbox defaults */
  sandbox?: SandboxSettings;
  /** its notebooks' AI access, unless one sets its own */
  ai: AiLevel;
  notebooks: NotebookSummary[];
  modified: number;
  /** what the signed-in person may do in it (empty: they only see notebooks shared with them) */
  permissions: Action[];
}

export interface WorkspaceIndex {
  /** Where workspace folders live on the server (for admins; empty otherwise). */
  root: string;
  workspaces: WorkspaceSummary[];
  /** what they may do outside any workspace (create one, administer) */
  permissions: Action[];
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
  // signed out (or the session ended): to the login page, back here after
  if (res.status === 401 && out.login && !location.hash.startsWith("#/login")) location.hash = loginHref(location.hash);
  if (!res.ok) throw new ApiError(out.error ?? res.statusText, res.status);
  return out as T;
}

/** The login page, returning to `next` after. */
export const loginHref = (next = "#/", error?: string) =>
  `#/login?next=${encodeURIComponent(next || "#/")}${error ? `&error=${encodeURIComponent(error)}` : ""}`;

/** Someone signed in: who, from where, what they carry. */
/** The sysadmin's password: Querier's to change (not .env's), and still the generated one. */
export type SysadminPassword = { changeable: boolean; mustChange: boolean };

export interface Me {
  id: string;
  provider: string;
  username: string;
  email?: string;
  name?: string;
  groups: string[];
  attrs: Record<string, string[]>;
  sysadmin: boolean;
}
export interface SignIn {
  id: string;
  label: string;
  kind: "password" | "redirect";
  type: "sysadmin" | "ldap" | "oidc";
}

/** A notebook's id, "workspace/notebook", as its two parts. */
export function splitId(id: string): [string, string] {
  const i = id.indexOf("/");
  return [id.slice(0, i), id.slice(i + 1)];
}
const wsPath = (ws: string) => `/workspaces/${encodeURIComponent(ws)}`;
const nbPath = (nb: string) => {
  const [ws, name] = splitId(nb);
  return `${wsPath(ws)}/notebooks/${encodeURIComponent(name)}`;
};
/** A notebook's API address, for what is not fetched as JSON (downloads, the template's script). */
export const nbUrl = (nb: string) => `/api${nbPath(nb)}`;
const accessPath = (scope: AccessScope, target: string) =>
  scope === "workspace" ? wsPath(target) : scope === "notebook" ? nbPath(target) : `/connections/${encodeURIComponent(target)}`;
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

/** A workspace's or notebook's environment (Python packages for kernels, npm for templates). */
export interface EnvState {
  kind: "python" | "js";
  /** what the folder's file declares */
  dependencies: string[];
  applied: { hash: string; dependencies: string[]; at: number; by: string } | null;
  status: "none" | "ready" | "building" | "failed";
  log?: string;
  /** the folder's files differ from what is in force (edited, pulled) */
  changed: boolean;
}

// -- the admin console

export interface PolicyProblem {
  policy: string;
  message: string;
  help?: string;
  start?: number;
  end?: number;
  warning?: boolean;
}
export interface PolicyFile {
  name: string;
  text: string;
  problems: PolicyProblem[];
}
export interface PolicyIndex {
  files: PolicyFile[];
  /** what the last load found wrong: the last valid set stays in force meanwhile */
  problems: PolicyProblem[];
  grants: number;
  roles: { workspace: Record<string, Action[]>; share: Record<string, Action[]>; connection: Record<string, Action[]> };
  actions: Action[];
  /** what each action applies to: Tenant, Workspace, Notebook, Connection */
  appliesTo: Record<Action, ResourceRef["type"][]>;
  workspaces: string[];
  folder: string;
}
export interface Explanation {
  allow: boolean;
  reasons: { id: string; source: string; text?: string }[];
  errors: string[];
  principal: Me & { tags: Record<string, string[]> };
}
export interface Person extends Me {
  lastLogin?: number;
}
export interface PersonDetail {
  principal: Person;
  tags: Record<string, string[]>;
  tenant: Action[];
  workspaces: { name: string; title: string; permissions: Action[]; notebooks: { id: string; title: string; permissions: Action[] }[] }[];
}
export interface AuditEntry {
  id: number;
  ts: number;
  actor?: string;
  action: string;
  resource?: string;
  decision?: "allow" | "deny" | "ok" | "fail";
  detail?: Record<string, unknown>;
}
/** An identity provider's settings (auth.json), as the console gets them: a stored secret never comes back. */
/** Administration → Server: the machine, the running kernels, the live sessions. */
export interface ServerStatus {
  machine: { cpus: number; cpu: number | null; load: number[]; memTotal: number; memFree: number; uptime: number; querierUptime: number; querierRss: number };
  limits: { total: number; perUser: number; idle: number; running: number };
  runner: "firecracker" | "local";
  kernels: {
    id: string;
    notebook: string;
    kind: "live" | "report" | "schedule";
    owner: { id: string; name: string } | null;
    state: "starting" | "running" | "idle";
    startedAt: number | null;
    lastUsed: number;
    tabs: number;
    terminals: number;
    info: Record<string, string>;
    point: { t: number; cpu: number | null; mem: number; memTotal: number } | null;
  }[];
  sessions: {
    id: string;
    who: { id: string; name: string; username: string; sysadmin: boolean };
    provider: string;
    created: number;
    lastSeen: number;
    expires: number;
    sockets: number;
    yours: boolean;
  }[];
}

/** A certificate as the server read it: to compare with what IT says it is. */
export interface CertificateInfo {
  subject: string;
  issuer: string;
  notAfter: string;
  fingerprint: string;
  ca: boolean;
  expired: boolean;
}

export interface ProviderSettings {
  id: string;
  type: "ldap" | "oidc";
  label: string;
  // ldap
  url?: string;
  startTls?: boolean;
  /** the CA certificate, as PEM (uploaded or pasted) */
  ca?: string;
  caFile?: string;
  tlsServerName?: string;
  allowInsecure?: boolean;
  bindDn?: string;
  /** "env:NAME", or "" when stored (secretStored) or not set; a new value to store when saving */
  bindPassword?: string;
  baseDn?: string;
  userFilter?: string;
  idAttribute?: string;
  usernameAttribute?: string;
  emailAttribute?: string;
  nameAttribute?: string;
  groupBaseDn?: string;
  nestedGroups?: boolean;
  groupName?: "cn" | "dn";
  // oidc
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  usernameClaim?: string;
  emailClaim?: string;
  nameClaim?: string;
  groupsClaim?: string;
  entraGraphOverage?: boolean;
  userinfo?: boolean;
  // both
  /** tag name → directory attribute or claim */
  attributes?: Record<string, string>;
  secretStored?: boolean;
  secretEnvMissing?: boolean;
  /** why it isn't in use (a setting it can't work with) */
  problem?: string;
}
export interface AuthSettings {
  providers: ProviderSettings[];
  session: { absoluteHours: number; idleMinutes: number; refreshMinutes: number };
  file: string;
  redirectBase: string;
  sysadmin: string;
  /** where its account lives: Querier's own ("file": its password changed from the account menu), or the server's .env */
  sysadminSource: "file" | "env";
  /** who may sign in: a condition over their groups and attributes (null: everyone the directories accept);
   *  `custom`: sign-in.cedar was edited as a policy file, not in this shape */
  admission: { when: string | null; custom?: boolean };
  /** public links to reports: allowed at all, and the networks every link must stay within */
  publicLinks: { enabled: boolean; networks?: string[] };
}
export interface ProviderTest {
  steps: { ok: boolean; what: string; detail?: string; ms?: number }[];
  principal?: Me;
  disabled?: boolean;
  redirectUri?: string;
}

export type ResourceRef = { type: "Tenant" | "Workspace" | "Notebook" | "Connection"; id: string };

/** A connection: environment variables a kernel gets, everyone's or a workspace's, with shared
 *  credentials or each person's own. Values never come back: only which are set. */
export interface ConnectionInfo {
  id: string;
  name: string;
  /** a workspace's; none: everyone's */
  workspace?: string;
  description?: string;
  variables: string[];
  credentials: "shared" | "per-user";
  created: number;
  createdBy?: string;
  updated: number;
  /** variables with a shared value */
  set: string[];
  /** variables the signed-in person set their own value of */
  mine: string[];
  /** what they may do to it: connection.use, connection.manage */
  permissions: Action[];
}
export interface NewConnection {
  name: string;
  workspace?: string;
  description?: string;
  variables: string[];
  credentials: "shared" | "per-user";
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
import type { CedarVocabulary } from "./cedarcomplete";
import type { Block } from "../../../shared/report";

export const api = {
  auth: {
    providers: () => call<{ providers: SignIn[]; httpAllowed: boolean }>("GET", "/auth/providers"),
    login: (provider: string, username: string, password: string) => call<{ me: Me }>("POST", "/auth/login", { provider, username, password }),
    logout: () => call("POST", "/auth/logout", {}),
    /** who is signed in, and what they may do outside any workspace */
    me: () => call<{ me: Me; permissions: Action[]; sessionExpires: number; password?: SysadminPassword }>("GET", "/me"),
    /** the sysadmin's new password (Querier's own account): `current` isn't asked while it is the generated one */
    changePassword: (current: string, password: string) => call<{ password: SysadminPassword }>("POST", "/me/password", { current, password }),
  },
  workspaces: () => call<WorkspaceIndex>("GET", "/workspaces"),
  create: (ws: string, name: string, title?: string) => call<{ id: string }>("POST", `${wsPath(ws)}/notebooks`, { name, title }),
  load: (nb: string) => call<Notebook>("GET", nbPath(nb)),
  removeNotebook: (nb: string) => call("DELETE", nbPath(nb)),
  /** a new folder name, in the same workspace or another */
  renameNotebook: (nb: string, name: string, workspace?: string) => call<{ id: string }>("POST", `${nbPath(nb)}/rename`, { name, workspace }),
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
    /** the level in force; the notebook's own (null: its workspace's), and the workspace's */
    level: (nb: string) => call<{ level: AiLevel; own: AiLevel | null; workspace: AiLevel }>("GET", `${nbPath(nb)}/ai`),
    /** null: follow the workspace */
    setLevel: (nb: string, level: AiLevel | null) => call("PUT", `${nbPath(nb)}/ai`, { level }),
    clients: () => call<{ file: string; clients: AiClient[] }>("GET", "/ai/clients"),
    // the token comes back this once
    createClient: (name: string) => call<{ client: AiClient; token: string }>("POST", "/ai/clients", { name }),
    revoke: (id: string) => call("DELETE", `/ai/clients/${encodeURIComponent(id)}`),
  },
  template: {
    /** `token`: what the template's frame fetches its script with (the frame sends no cookie) */
    get: (nb: string) => call<{ source: string | null; version?: string; error?: TemplateError | null; token?: string }>("GET", `${nbPath(nb)}/template`),
    save: (nb: string, source: string) => call<{ version: string; error: TemplateError | null; token: string }>("PUT", `${nbPath(nb)}/template`, { source }),
    remove: (nb: string) => call("DELETE", `${nbPath(nb)}/template`),
  },
  workspace: {
    get: (ws: string) => call<WorkspaceSummary>("GET", wsPath(ws)),
    create: (name: string, title?: string) => call<{ name: string }>("POST", "/workspaces", { name, title }),
    settings: (
      ws: string,
      patch: { title?: string; description?: string | null; attributes?: Record<string, string> | null; sandbox?: SandboxSettings | null; ai?: AiLevel },
    ) => call("PATCH", wsPath(ws), patch),
    rename: (ws: string, name: string) => call<{ name: string }>("POST", `${wsPath(ws)}/rename`, { name }),
    /** only an empty one, unless `force`: then its notebooks too */
    remove: (ws: string, force = false) => call("DELETE", `${wsPath(ws)}${force ? "?force=1" : ""}`),
  },
  /** who has access: a workspace's roles, a notebook's shares */
  access: {
    of: (scope: AccessScope, target: string) => call<{ grants: Grant[] }>("GET", `${accessPath(scope, target)}/access`),
    grant: (scope: AccessScope, target: string, subject: Subject, role: Grant["role"]) => call<Grant>("POST", `${accessPath(scope, target)}/access`, { subject, role }),
    revoke: (scope: AccessScope, target: string, id: string) => call("DELETE", `${accessPath(scope, target)}/access/${encodeURIComponent(id)}`),
    /** people and groups who have signed in */
    directory: (q: string) => call<DirectoryHits>("GET", `/directory?q=${encodeURIComponent(q)}`),
    /** a condition's problems, with where they are in it */
    check: (when: string) => call<{ problems: { message: string; help?: string; start?: number; end?: number }[] }>("POST", "/access/check", { when }),
    /** what conditions can name: people's tags and values, groups, resources' tags */
    vocabulary: () => call<CedarVocabulary>("GET", "/access/vocabulary"),
    /** a notebook's attributes for policies (a workspace Admin sets them) */
    attributes: (nb: string) => call<{ attributes: Record<string, string> }>("GET", `${nbPath(nb)}/attributes`),
    setAttributes: (nb: string, attributes: Record<string, string> | null) => call("PUT", `${nbPath(nb)}/attributes`, { attributes }),
  },
  /** the packages a workspace's or notebook's kernels and templates get */
  environment: {
    get: (scope: "workspace" | "notebook", target: string) =>
      call<{ python: EnvState; js: EnvState }>("GET", `${scope === "workspace" ? wsPath(target) : nbPath(target)}/environment`),
    apply: (scope: "workspace" | "notebook", target: string, kind: "python" | "js", dependencies: string[]) =>
      call<{ python: EnvState; js: EnvState }>("PUT", `${scope === "workspace" ? wsPath(target) : nbPath(target)}/environment/${kind}`, { dependencies }),
  },
  /** a notebook's published report: what its viewers get, and publishing it */
  report: {
    get: (nb: string) => call<Notebook>("GET", `${nbPath(nb)}/published`),
    publish: (nb: string, o: { runAs: "viewer" | "owner"; bindings?: Record<string, string>; schedule?: { every: number } | null }) =>
      call<{ at: number }>("POST", `${nbPath(nb)}/published`, o),
    unpublish: (nb: string) => call("DELETE", `${nbPath(nb)}/published`),
    /** its public link, made or changed: the passcode typed anew, left as it is (undefined), or taken off (null) */
    setPublic: (nb: string, o: { refresh: number; networks: string[]; expires: string | null; passcode?: string | null; embed: "none" | "any" | string[] }) =>
      call<PublicLinkInfo>("PUT", `${nbPath(nb)}/published/public`, o),
    removePublic: (nb: string) => call("DELETE", `${nbPath(nb)}/published/public`),
    rotatePublic: (nb: string) => call<PublicLinkInfo>("POST", `${nbPath(nb)}/published/public/token`),
  },
  /** the admin console (admin.manage) */
  admin: {
    policies: () => call<PolicyIndex>("GET", "/admin/policies"),
    check: (text: string) => call<{ problems: PolicyProblem[] }>("POST", "/admin/policies/check", { text }),
    save: (name: string, text: string) => call<{ name: string }>("PUT", `/admin/policies/${encodeURIComponent(name)}`, { text }),
    remove: (name: string) => call("DELETE", `/admin/policies/${encodeURIComponent(name)}`),
    explain: (principal: string, action: Action, resource: ResourceRef) => call<Explanation>("POST", "/admin/explain", { principal, action, resource }),
    people: (q = "") => call<{ people: Person[] }>("GET", `/admin/people?q=${encodeURIComponent(q)}`),
    /** sign-in: identity providers and sessions */
    auth: {
      get: () => call<AuthSettings>("GET", "/admin/auth"),
      /** try settings, saved or not (`original`: the saved one whose stored secret a blank one keeps) */
      test: (provider: ProviderSettings, original?: string, username?: string) => call<ProviderTest>("POST", "/admin/auth/test", { provider, original, username }),
      save: (id: string, provider: ProviderSettings) => call<ProviderSettings>("PUT", `/admin/auth/providers/${encodeURIComponent(id)}`, { provider }),
      remove: (id: string) => call("DELETE", `/admin/auth/providers/${encodeURIComponent(id)}`),
      order: (ids: string[]) => call("PUT", "/admin/auth/order", { ids }),
      session: (s: AuthSettings["session"]) => call<AuthSettings["session"]>("PUT", "/admin/auth/session", s),
      admission: (when: string | null) => call<AuthSettings["admission"]>("PUT", "/admin/auth/admission", { when }),
      publicLinks: (o: { enabled: boolean; networks: string[] }) => call<AuthSettings["publicLinks"]>("PUT", "/admin/auth/public", o),
      /** a certificate read on the server (PEM text, or a DER file's bytes in base64): checked, and what it is */
      certificate: (given: { pem: string } | { der: string }) => call<{ pem: string; certs: CertificateInfo[] }>("POST", "/admin/auth/certificate", given),
    },
    person: (id: string) => call<PersonDetail>("GET", `/admin/people/${encodeURIComponent(id)}`),
    /** the machine, every running kernel, everyone signed in */
    server: () => call<ServerStatus>("GET", "/admin/server"),
    stopKernel: (id: string) => call("DELETE", `/admin/server/kernels/${encodeURIComponent(id)}`),
    revokeSession: (id: string) => call("DELETE", `/admin/sessions/${encodeURIComponent(id)}`),
    audit: (q: { before?: number; limit?: number; actor?: string; action?: string; decision?: string; resource?: string }) =>
      call<{ entries: AuditEntry[]; names: Record<string, string> }>(
        "GET",
        `/admin/audit?${new URLSearchParams(Object.entries(q).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)]))}`,
      ),
  },
  // connections: what kernels get; values go in, never come back out
  connections: {
    /** those the signed-in person may use or manage: everyone's and `workspace`'s, or all */
    list: (workspace?: string) =>
      call<{ connections: ConnectionInfo[]; mayCreate: boolean; mayCreateEveryone: boolean }>("GET", `/connections${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`),
    /** what a notebook's kernel gets, for the signed-in person */
    forNotebook: (nb: string) => call<{ connections: ConnectionInfo[] }>("GET", `${nbPath(nb)}/connections`),
    create: (c: NewConnection) => call<ConnectionInfo>("POST", "/connections", c),
    update: (id: string, patch: { name?: string; description?: string | null; variables?: string[]; credentials?: "shared" | "per-user" }) =>
      call<ConnectionInfo>("PATCH", `/connections/${encodeURIComponent(id)}`, patch),
    remove: (id: string) => call("DELETE", `/connections/${encodeURIComponent(id)}`),
    /** a shared connection's values: a string sets, null clears */
    setValues: (id: string, values: Record<string, string | null>) => call<ConnectionInfo>("PUT", `/connections/${encodeURIComponent(id)}/values`, { values }),
    /** one's own values of a per-person connection */
    setMine: (id: string, values: Record<string, string | null>) => call<ConnectionInfo>("PUT", `/connections/${encodeURIComponent(id)}/mine`, { values }),
    clearMine: (id: string) => call("DELETE", `/connections/${encodeURIComponent(id)}/mine`),
  },
};
