// HTTP + WebSocket server. Files are edited over REST; runs, outputs and
// completion travel over one WebSocket per notebook, as frames (protocol.ts).
//   bun server/app.ts [--port 3000] [--notebooks ./notebooks]

import { join, resolve } from "node:path";
import { Host, type CellOutput, type Client } from "./host";
import { encodeFrame } from "./runner/protocol";
import { FirecrackerRunner } from "./runner/firecracker";
import { LocalRunner } from "./runner/local";
import type { Runner } from "./runner/types";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Git } from "./git";
import { exposition } from "./metrics";
import { Access } from "./mcp/access";
import { buildTemplate, templateVersion, type TemplatePackages } from "./template";
import { mcpServer, type Ctx } from "./mcp/server";
import { Connections, type Connection } from "./connections";
import { checkAttributes, DEFAULT_WORKSPACE, NotFound, Store, UserError } from "./store";
import { Auth, LoginFailed, OIDC_COOKIE, type Session } from "./auth";
import { Authz, policiesDir } from "./auth/authz";
import { Grants, NotebookAttributes } from "./auth/grants";
import { ACTIONS, ALL_ACTIONS, CONNECTION_ORDER, CONNECTION_ROLES, grantPolicy, principalTags, ROLE_ORDER, SHARE_LEVELS, SHARE_ORDER, WORKSPACE_ROLES, type Action, type ConnectionRole, type Grant, type Resource, type ShareLevel, type Subject, type WorkspaceRole } from "./auth/policy";
import { describeSubject } from "./auth/grants";
import { cookieOf } from "./auth/sessions";
import { publicPrincipal, type Principal } from "./auth/principal";
import { Kernels } from "./kernels";
import { reportVersion, Reports, type Published, type RunAs } from "./reports";
import { Environments, type EnvKind } from "./environments";
import { hash } from "../shared/hash";
import { allowInsecureLogin, authFile, clientAddress, publicUrl, type ProviderConfig } from "./auth/config";

const arg = (flag: string, fallback: string) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const port = Number(arg("--port", process.env.PORT ?? "3000"));
const store = new Store(arg("--notebooks", process.env.QUERIER_NOTEBOOKS ?? "notebooks"));
// QUERIER_RUNNER=firecracker (the Docker image) runs each session in a microVM;
// the default runs kernels as local processes, for development
const runner: Runner = process.env.QUERIER_RUNNER === "firecracker" ? new FirecrackerRunner() : new LocalRunner();
const connections = new Connections();
const access = new Access();
// who may come in (server/auth): no Querier without its sysadmin
const auth = await Auth.open().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
// who may do what (server/auth/policy.ts): grants, and the custom policy files
const authz = new Authz(store, new Grants(auth.db), new NotebookAttributes(auth.db), auth.audit);
await authz.reloadCustom();
authz.watchCustom();
// who may sign in at all: the policies' say (signIn), at sign-in and on every request
auth.admit = (p) => authz.can(p, "signIn", authz.tenant(), true);
{
  // AI tokens from before accounts act as the sysadmin now
  const adopted = await access.adopt(auth.sysadmin.principal().id);
  if (adopted) console.log(`${adopted} AI client token${adopted === 1 ? "" : "s"} from before accounts now act as the sysadmin`);
}
// notebooks from before workspaces go into "default", their AI access too
{
  const moved = await store.migrate();
  await access.migrate(moved, DEFAULT_WORKSPACE);
  if (moved.length) console.log(`moved ${moved.length} notebook${moved.length === 1 ? "" : "s"} into the "${DEFAULT_WORKSPACE}" workspace`);
}
if (allowInsecureLogin && !publicUrl.startsWith("https://"))
  console.warn("QUERIER_ALLOW_HTTP=1: passwords and session cookies are accepted over plain HTTP, readable by anyone on the network between browsers and Querier. Serve it over HTTPS (a reverse proxy ending TLS, QUERIER_PUBLIC_URL) and remove it.");
const dist = resolve(import.meta.dir, "../web/dist");
/** For the sysadmin's own session: whether its password is Querier's to change, and still the generated one. */
const sysadminAccount = (p: Principal) =>
  p.sysadmin ? { password: { changeable: auth.sysadmin.source === "file", mustChange: auth.sysadmin.mustChangePassword } } : {};

// Each person has their own kernel of a notebook (as in Microsoft Fabric): a Host
// per (notebook, person), so what a kernel holds and prints is its owner's. The
// caps and the idle stop are kernels.ts's.
const kernels = new Kernels();
// workspaces' and notebooks' packages (environments.ts): Python for kernels, npm for report templates
const environments = new Environments(auth.db, {
  images: runner instanceof FirecrackerRunner,
  python: process.env.QUERIER_PYTHON ?? resolve(import.meta.dir, "../.venv/bin/python"),
  onApplied: (target, kind) => environmentApplied(target, kind),
});
/** A target's folder: "ws:<name>" or "nb:<ws>/<nb>". */
const envDir = (target: string) => (target.startsWith("ws:") ? store.wsDir(target.slice(3)) : store.dir(target.slice(3)));
/** Hashes of what a notebook's kernels and templates get: the environments applied now (or a published report's, pinned). */
const envHashes = (nb: string): Published["envs"] => {
  const ws = `ws:${nb.slice(0, nb.indexOf("/"))}`;
  return {
    wsPython: environments.hashOf(ws, "python"),
    nbPython: environments.hashOf(`nb:${nb}`, "python"),
    wsJs: environments.hashOf(ws, "js"),
    nbJs: environments.hashOf(`nb:${nb}`, "js"),
  };
};
/** The Python packages a kernel of `nb` starts with. A build missing (another Python, a new server) is made again from the folder's lock. */
async function packagesFor(nb: string, pinned?: Published["envs"]) {
  const h = pinned ?? envHashes(nb);
  const ws = nb.slice(0, nb.indexOf("/"));
  const get = async (dir: string, hash?: string) => {
    if (!hash) return null;
    if (!environments.python(hash)) await environments.installPython(dir, hash).catch((e) => console.error(`environment ${hash} for ${nb}: ${e.message}`));
    return environments.python(hash);
  };
  return { workspace: await get(store.wsDir(ws), h?.wsPython), notebook: await get(store.dir(nb), h?.nbPython) };
}
/** The npm packages a template of `nb` may import (the notebook's first), from what is applied (or pinned). */
async function templatePackages(nb: string, pinned?: Published["envs"]): Promise<TemplatePackages> {
  const h = pinned ?? envHashes(nb);
  const ws = nb.slice(0, nb.indexOf("/"));
  const dirs = [environments.js(h?.nbJs), environments.js(h?.wsJs)].filter((d): d is string => !!d);
  const names = new Set<string>();
  for (const [dir, hash] of [[store.dir(nb), h?.nbJs], [store.wsDir(ws), h?.wsJs]] as const) {
    if (!hash) continue;
    // the names the applied lock declares (a folder edited since doesn't add any)
    const f = Bun.file(join(environments.js(hash) ?? dir, "package.json"));
    if (await f.exists()) for (const n of Object.keys(((await f.json()) as any).dependencies ?? {})) names.add(n);
  }
  return { names: [...names], dirs, key: `${h?.nbJs ?? ""}:${h?.wsJs ?? ""}` };
}
/** An environment was applied: kernels that have the old packages are told; templates are built again. */
function environmentApplied(target: string, kind: EnvKind) {
  const inScope = (nb: string) => (target.startsWith("ws:") ? nb.startsWith(`${target.slice(3)}/`) : nb === target.slice(3));
  for (const h of hosts.values()) {
    if (h.kind === "live" && inScope(h.nb)) kind === "python" ? h.environmentChanged() : h.broadcast({ type: "notebook" });
  }
}
const hosts = new Map<string, Host>();
const hostKey = (nb: string, owner: string) => `${nb}\u0000${owner}`;
/** `owner`'s host of `nb`, made if need be (it doesn't start a kernel). */
const hostOf = (nb: string, owner: Principal) => {
  store.dir(nb); // validates the name
  const key = hostKey(nb, owner.id);
  let h = hosts.get(key);
  if (!h) hosts.set(key, (h = new Host(nb, store, runner, { env: envFor }, { owner, kernels, packages: () => packagesFor(nb) })));
  return h;
};
/** Everyone's own hosts of `nb`: what changes its files reaches each of them (not a published report's: its cells are frozen). */
const hostsOf = (nb: string) => [...hosts.values()].filter((h) => h.nb === nb && h.kind === "live");
const changed = (nb: string) => {
  for (const h of hostsOf(nb)) {
    h.broadcast({ type: "notebook" });
    h.analyzeSoon();
  }
};

/** Tell a notebook's open tabs (everyone's) where it went, or that it's gone, and stop its kernels. */
async function closeHost(nb: string, message: object) {
  for (const [key, h] of [...hosts]) {
    if (h.nb !== nb) continue;
    h.broadcast(message);
    hosts.delete(key);
    await h.close();
  }
}

// -- published reports (reports.ts): each viewer's own report kernel runs the published cells, with
// their connections or the owner's; a scheduled one's result is given to viewers before they run anything
const reports = new Reports(auth.db);
const reportKey = (nb: string, viewer: string) => `${nb}\u0000report\u0000${viewer}`;
/** The latest scheduled run of each report: its outputs, and when. */
const snapshots = new Map<string, { outputs: Map<string, CellOutput>; at: number }>();
/** Whose connections a published report runs with, for `viewer`: theirs, or its owner's (who must still exist). */
function reportRunAs(p: Published, viewer: Principal): Principal {
  if (p.runAs === "viewer") return viewer;
  const owner = p.owner ? auth.principalById(p.owner) : null;
  if (!owner) throw new UserError("This report runs as its owner, who is no longer known: it needs publishing again.");
  return owner;
}
/** `viewer`'s host of the published report of `nb`, made if need be (it doesn't start a kernel). */
function reportHostOf(nb: string, viewer: Principal): Host {
  const key = reportKey(nb, viewer.id);
  let h = hosts.get(key);
  if (h) return h;
  const p = reports.get(nb);
  if (!p) throw new NotFound("This report isn't published.");
  h = new Host(nb, store, runner, { env: envFor }, {
    owner: viewer,
    kernels,
    runAs: reportRunAs(p, viewer),
    cells: async () => reports.get(nb)?.cells ?? [],
    keepFiles: false,
    kind: "report",
    // the packages it was published with: a later change doesn't reach what an owner's report runs
    packages: () => packagesFor(nb, reports.get(nb)?.envs ?? {}),
  });
  hosts.set(key, h);
  // a scheduled run's result: theirs to see at once, until they change something
  const snap = snapshots.get(nb);
  if (snap && canSchedule(p)) h.seed(snap.outputs, snap.at);
  return h;
}
/** A report's published version changed or went: its viewers' kernels stop, and their tabs reload it. */
async function closeReportHosts(nb: string, message: object) {
  for (const [key, h] of [...hosts]) {
    if (h.nb !== nb || h.kind === "live") continue;
    h.broadcast(message);
    hosts.delete(key);
    await h.close();
  }
}
/** Only a report run as its owner, with nothing bound, can be run by the server for everyone. */
const canSchedule = (p: Published) => p.runAs === "owner" && !Object.keys(p.bindings).length;

// scheduled runs: the published report, as its owner, every so often
const schedules = new Map<string, ReturnType<typeof setInterval>>();
function schedule(nb: string, delay = 1000) {
  clearInterval(schedules.get(nb));
  schedules.delete(nb);
  const p = reports.get(nb);
  if (!p?.schedule || !canSchedule(p)) return void snapshots.delete(nb);
  const every = Math.max(1000, p.schedule.every * 60_000);
  schedules.set(nb, setInterval(() => void runScheduled(nb), every).unref() as any);
  setTimeout(() => void runScheduled(nb), delay).unref();
}
const scheduling = new Set<string>();
async function runScheduled(nb: string) {
  if (scheduling.has(nb)) return;
  const p = reports.get(nb);
  if (!p || !canSchedule(p)) return;
  scheduling.add(nb);
  const started = Date.now();
  const owner = p.owner ? auth.principalById(p.owner) : null;
  try {
    if (!owner || !authz.can(owner, "notebook.run", await authz.notebook(nb), true)) throw new Error("its owner may no longer run it");
    // its own kernel, counted apart from the owner's (a few scheduled reports mustn't lock them out)
    const h = new Host(nb, store, runner, { env: envFor }, {
      owner: { ...owner, id: `schedule:${nb}` },
      runAs: owner,
      kernels,
      cells: async () => reports.get(nb)?.cells ?? [],
      keepFiles: false,
      kind: "schedule",
      packages: () => packagesFor(nb, reports.get(nb)?.envs ?? {}),
    });
    try {
      const code = p.cells.filter((c) => c.lang !== "md").map((c) => c.name);
      const { finished } = await h.runAndWait(code, {}, 15 * 60_000);
      if (!finished) throw new Error("it didn't finish in 15 minutes");
      const outputs = h.results();
      const failed = [...outputs].filter(([, o]) => o.state === "error").map(([c]) => c);
      // a failed run doesn't replace a good one: viewers keep the last that worked
      if (!failed.length) {
        snapshots.set(nb, { outputs: new Map(outputs), at: Date.now() });
        for (const v of [...hosts.values()].filter((x) => x.nb === nb && x.kind === "report")) v.seed(outputs, Date.now());
      }
      auth.audit.log({ actor: owner.id, action: "report.scheduled", resource: `Notebook:${nb}`, decision: failed.length ? "fail" : "ok", detail: { ms: Date.now() - started, ...(failed.length ? { failed } : {}) } });
    } finally {
      await h.close();
    }
  } catch (e: any) {
    auth.audit.log({ actor: owner?.id ?? p.owner, action: "report.scheduled", resource: `Notebook:${nb}`, decision: "fail", detail: { error: String(e.message ?? e) } });
  } finally {
    scheduling.delete(nb);
  }
}
// after a start, not all at once
reports.all().forEach(([nb], i) => schedule(nb, 1000 + i * 3000));

// kernels nobody has used for a while stop (unless the limit is 0); hosts with no tab and no kernel go
setInterval(
  async () => {
    const now = Date.now();
    for (const [key, h] of [...hosts]) {
      if (kernels.limits.idle > 0 && h.running && !h.busy && now - h.lastUsed > kernels.limits.idle) await h.stopIdle(kernels.limits.idle).catch(() => {});
      else if (!h.running && !h.clients.size && now - h.lastUsed > 60_000) hosts.delete(key);
    }
  },
  kernels.limits.idle > 0 ? Math.min(60_000, Math.max(1000, kernels.limits.idle / 4)) : 60_000,
).unref();

/** A notebook's git, with the credentials of who asks (GIT_TOKEN, GIT_USER: a connection they may use). */
const gitOf = (nb: string, who: Principal) => new Git(store.dir(nb), () => envFor(nb, who));

/** A notebook's id from the path (the api wrapper joins ws and nb), checked. */
const nbParam = (r: { params: Record<string, string> }) => (store.dir(r.params.nb), r.params.nb);
/** A notebook's id from a raw request's path: /…/workspaces/:ws/notebooks/:nb/… */
const idOf = (r: { params: Record<string, string> }) => {
  const id = `${r.params.ws}/${r.params.nb}`;
  store.dir(id);
  return id;
};

/** Every open notebook of a workspace: told where it went, and its kernel stopped. */
async function closeWorkspace(ws: string, message: (id: string) => object) {
  for (const id of new Set([...hosts.values()].map((h) => h.nb))) if (id.startsWith(`${ws}/`)) await closeHost(id, message(id));
}

/** The environment `who`'s kernel (or git) of `nb` gets: the connections they may use there. */
async function envFor(nb: string, who: Principal | undefined): Promise<Record<string, string>> {
  if (!who) return {};
  return connections.env(nb.slice(0, nb.indexOf("/")), who.id, async (c) => authz.can(who, "connection.use", await authz.connection(c), true));
}

/** A connection changed (or who may use it): the kernels that may have it are told theirs is stale.
 *  Everyone's reaches every kernel; a workspace's, its notebooks'; one person's own values, their kernels. */
async function connectionsChanged(scope: { ws?: string; owner?: string } | null) {
  // (a report run as its owner has the owner's connections: their change reaches it)
  const hit = (h: Host) => scope == null || ((scope.ws == null || h.nb.startsWith(`${scope.ws}/`)) && (scope.owner == null || h.runAs?.id === scope.owner));
  await Promise.all([...hosts.values()].filter(hit).map((h) => h.secretsChanged()));
}

// AI clients over MCP (mcp/): each request its own stateless server
const mcpCtx: Omit<Ctx, "may" | "host"> = {
  store,
  access,
  hosts: hostsOf,
  changed,
  templatePackages: (nb) => templatePackages(nb),
};

async function mcp(req: Request, srv: { timeout(req: Request, seconds: number): void }) {
  // a web page must not drive it from someone's browser (DNS rebinding): no Origin, or this server's own
  const origin = req.headers.get("origin");
  if (origin && !ownOrigin(req, origin)) return new Response("Forbidden origin", { status: 403 });
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  const client = token ? await access.verify(token) : null;
  if (!client) {
    const message = "Querier needs a client token: make one in Querier (palette → AI clients) and send it as `Authorization: Bearer <token>`.";
    return Response.json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }, { status: 401 });
  }
  // a token acts as its owner, as they were when they last signed in
  const owner = client.owner ? auth.principalById(client.owner) : null;
  if (!owner) {
    auth.audit.log({ actor: client.owner, action: "mcp", decision: "deny", detail: { client: client.id, why: "owner unknown" } });
    const message = "This token's owner is unknown: make a new token.";
    return Response.json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }, { status: 403 });
  }
  srv.timeout(req, 0); // runs may take minutes
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const may: Ctx["may"] = async (nb, action) => authz.can(owner, action, await authz.notebook(nb), true);
  // its runs are in the owner's own kernel, as their tabs' are
  const server = mcpServer({ ...mcpCtx, may, host: (nb) => hostOf(nb, owner) }, client);
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    server.close().catch(() => {});
  }
}

/** A request that changes something must come from Querier's own pages: not
 *  another site open in the browser, nor a report template's sandboxed frame
 *  (whose origin is "null"). The session cookie is SameSite=Lax; this is the
 *  second line against cross-site requests. */
function foreign(req: Request): boolean {
  if (req.method === "GET" || req.method === "HEAD") return false;
  const origin = req.headers.get("origin");
  return origin != null && !ownOrigin(req, origin);
}

/** Querier's own origin: the request's, or (behind a proxy that ends TLS) QUERIER_PUBLIC_URL's. */
function ownOrigin(req: Request, origin: string): boolean {
  return origin === new URL(req.url).origin || (publicUrl !== "" && origin === new URL(publicUrl).origin);
}

/** A token for a notebook's template script, good for a day (the report page asks again on load). */
const templateToken = (nb: string) => auth.signer.sign(`template:${nb}`, 24 * 3600);

/** The request's session, or the 401 that sends the browser to sign in. */
async function signedIn(req: Request): Promise<Session | Response> {
  const s = await auth.authenticate(req);
  if (!s) return Response.json({ error: "Sign in to use Querier.", login: true }, { status: 401 });
  return s;
}

/** Refused: what for, in words (a 403 the page shows). */
export class Forbidden extends Error {}
const WORDS: Partial<Record<Action, string>> = {
  "workspace.create": "create workspaces",
  "workspace.view": "see this workspace",
  "workspace.manage": "change this workspace's settings",
  "workspace.manageAccess": "manage who has access here",
  "notebook.create": "create notebooks here",
  "notebook.view": "see this notebook",
  "notebook.readCode": "read this notebook's code",
  "notebook.run": "run this notebook",
  "notebook.edit": "edit this notebook",
  "notebook.delete": "delete this notebook",
  "notebook.share": "share this notebook",
  "sandbox.manage": "change the sandbox",
  "environment.manage": "change the environment's packages",
  "ai.configure": "change AI access",
  "connection.manage": "manage connections here",
  "connection.use": "use this connection",
  signIn: "sign in to Querier",
  "git.pull": "pull into this notebook",
  "git.push": "push this notebook",
  "admin.manage": "administer Querier",
};
/** Allowed, or throws Forbidden (the audit log has the denial). */
function need(s: Session, action: Action, r: Resource) {
  if (!authz.can(s.principal, action, r)) throw new Forbidden(`You don't have permission to ${WORDS[action] ?? action}.`);
}

// what a route needs: an action on its notebook, workspace or all of Querier; or, checked
// in the handler, SELF (one's own things), LIST (what it returns is filtered), CUSTOM (by field)
type Rule = { on: "notebook" | "workspace" | "tenant"; action: Action } | "SELF" | "LIST" | "CUSTOM";
const SELF = "SELF" as const;
const LIST = "LIST" as const;
const CUSTOM = "CUSTOM" as const;

async function resourceOf(rule: Exclude<Rule, string>, params: Record<string, string>): Promise<Resource> {
  if (rule.on === "tenant") return authz.tenant();
  if (rule.on === "workspace") {
    store.wsDir(params.ws);
    return authz.workspace(params.ws);
  }
  store.dir(params.nb);
  return authz.notebook(params.nb);
}

/** A subject from the share dialog: a person, a group, everyone, or a condition on attributes (Cedar). */
function subjectOf(v: any): Subject {
  const kind = String(v?.kind ?? "");
  if (kind === "user" && typeof v.id === "string" && v.id) return { kind, id: v.id };
  if (kind === "group" && typeof v.name === "string" && v.name.trim()) return { kind, name: v.name.trim() };
  if (kind === "everyone") return { kind };
  if (kind === "condition" && typeof v.when === "string" && v.when.trim()) return { kind, when: v.when.trim() };
  throw new UserError("Give access to a person, a group, everyone, or a condition.");
}

/** A file's path on the server: for those who administer it, not everyone who may view what it holds. */
const pathFor = (s: Session, path: string) => (authz.can(s.principal, "admin.manage", authz.tenant(), true) ? path : "");

/** A grant, checked as the policy it becomes (a condition must be valid Cedar, its tags guarded), stored, in force. */
function addGrant(s: Session, g: Omit<Grant, "id" | "created">): Grant {
  let problems;
  try {
    problems = authz.engine.validate({ check: grantPolicy({ ...g, id: "check" }) });
  } catch (e: any) {
    throw new UserError(e.message);
  }
  if (problems.length) throw new UserError(`That condition isn't a valid policy: ${problems[0].message}`);
  const made = authz.grants.add({ ...g, createdBy: s.principal.id });
  authz.reloadGrants();
  auth.audit.log({ actor: s.principal.id, action: "grant.add", resource: `${g.scope}:${g.target}`, decision: "ok", detail: { subject: g.subject, role: g.role } });
  void grantsMoved(g);
  return made;
}

function removeGrant(s: Session, g: Grant) {
  authz.grants.remove(g.id);
  authz.reloadGrants();
  auth.audit.log({ actor: s.principal.id, action: "grant.remove", resource: `${g.scope}:${g.target}`, decision: "ok", detail: { subject: g.subject, role: g.role } });
  void grantsMoved(g);
}

/** Who may use which connection may have changed: the kernels it reaches are told theirs is stale. */
async function grantsMoved(g: Pick<Grant, "scope" | "target">) {
  if (g.scope === "workspace") await connectionsChanged({ ws: g.target });
  else if (g.scope === "connection") {
    const c = await connections.get(g.target);
    await connectionsChanged(c?.workspace ? { ws: c.workspace } : null);
  }
}

/** A grant for the dialog: with its subject in words, and a person's name when known. */
function showGrant(g: Grant) {
  const who = g.subject.kind === "user" ? auth.principalById(g.subject.id) : null;
  return { ...g, label: who ? (who.name ?? who.username) : describeSubject(g.subject), detail: who?.email ?? (g.subject.kind === "user" ? g.subject.id : undefined) };
}

// -- identity providers, for the admin console: auth.json's providers, never their stored secrets

const SECRET_OF = { ldap: "bindPassword", oidc: "clientSecret" } as const;

// who may sign in: a managed policy file, sign-in.cedar, written from Administration → Sign-in
const ADMISSION_FILE = "sign-in.cedar";
const admissionText = (when: string) =>
  `// Who may sign in (Administration → Sign-in: change it there). Everyone else is refused at
// sign-in, and signed out as soon as they no longer match. The system administrator always may.
forbid (principal, action == Action::"signIn", resource)
unless {
  ${when.trim().replace(/\n/g, "\n  ")}
};
`;
/** The managed rule's condition; "custom" when the file isn't in the managed shape (edited as a policy). */
async function admission(): Promise<{ when: string | null; custom?: boolean }> {
  const f = (await authz.customFiles()).find((x) => x.name === ADMISSION_FILE);
  if (!f) return { when: null };
  const m = /^forbid \(principal, action == Action::"signIn", resource\)\nunless \{\n([\s\S]*)\n\};\s*$/m.exec(f.text);
  return m ? { when: m[1].replace(/^ {2}/gm, "") } : { when: null, custom: true };
}

/** A workspace's or notebook's environments, as its settings show them. */
async function environmentOf(target: string) {
  const dir = envDir(target);
  return { python: await environments.state(dir, target, "python"), js: await environments.state(dir, target, "js") };
}

/** Lock and build what `b.dependencies` says: its state (building) at once; the page follows it. */
async function applyEnvironment(s: Session, target: string, kind: string, b: any) {
  if (kind !== "python" && kind !== "js") throw new NotFound("An environment is python or js.");
  const deps = Array.isArray(b.dependencies) ? b.dependencies.map(String) : [];
  environments.apply(envDir(target), target, kind, deps, s.principal.id);
  auth.audit.log({ actor: s.principal.id, action: "environment.apply", resource: target, decision: "ok", detail: { kind, dependencies: deps } });
  return environmentOf(target);
}

/** A provider as the console shows it: a stored secret isn't sent (an env: reference is: it is only a name). */
function showProvider(p: ProviderConfig) {
  const v = (p as any)[SECRET_OF[p.type]] as string | undefined;
  const ref = v?.startsWith("env:") ? v.slice(4) : null;
  return {
    ...p,
    [SECRET_OF[p.type]]: ref ? v : "",
    secretStored: !!v && !ref,
    secretEnvMissing: ref != null && process.env[ref] == null,
    problem: auth.problems[p.id],
  };
}

/** A provider from the console, checked, only the settings it may have; a blank secret keeps the stored one. */
function providerFrom(b: any, existing?: ProviderConfig): ProviderConfig {
  const str = (v: unknown, what: string, required = false) => {
    const t = typeof v === "string" ? v.trim() : "";
    if (required && !t) throw new UserError(`${what} is needed.`);
    return t || undefined;
  };
  const id = str(b.id, "An id", true)!;
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id) || id === "sysadmin") throw new UserError("An id: lowercase letters, digits and -, starting with a letter (not sysadmin). It is part of everyone's id from it.");
  const attributes: Record<string, string> = {};
  for (const [k, v] of Object.entries(b.attributes ?? {})) {
    if (!/^[A-Za-z_][\w.-]{0,63}$/.test(k)) throw new UserError(`\`${k}\` can't be an attribute's name: letters, digits, _ . -`);
    const from = str(v, `Where ${k} comes from`, true)!;
    attributes[k] = from;
  }
  const secret = (given: unknown, key: "bindPassword" | "clientSecret") => {
    const t = typeof given === "string" ? given : "";
    if (t) return t.trim();
    const kept = existing && existing.type === b.type ? (existing as any)[key] : undefined;
    if (!kept) throw new UserError(key === "bindPassword" ? "The service account's password is needed." : "The client secret is needed.");
    return kept as string;
  };
  const label = str(b.label, "A label", true)!;
  if (b.type === "ldap") {
    const url = str(b.url, "The directory's address", true)!;
    if (!/^ldaps?:\/\/[^\s/]+/.test(url)) throw new UserError("The directory's address: ldaps://host:636, or ldap://host:389 with StartTLS.");
    const out: ProviderConfig = {
      id,
      type: "ldap",
      label,
      url,
      startTls: !!b.startTls || undefined,
      caFile: str(b.caFile, ""),
      tlsServerName: str(b.tlsServerName, ""),
      allowInsecure: !!b.allowInsecure || undefined,
      bindDn: str(b.bindDn, "The service account's DN", true)!,
      bindPassword: secret(b.bindPassword, "bindPassword"),
      baseDn: str(b.baseDn, "Where people are (base DN)", true)!,
      userFilter: str(b.userFilter, ""),
      idAttribute: str(b.idAttribute, ""),
      usernameAttribute: str(b.usernameAttribute, ""),
      emailAttribute: str(b.emailAttribute, ""),
      nameAttribute: str(b.nameAttribute, ""),
      groupBaseDn: str(b.groupBaseDn, ""),
      nestedGroups: b.nestedGroups === false ? false : undefined,
      groupName: b.groupName === "dn" ? "dn" : undefined,
      attributes: Object.keys(attributes).length ? attributes : undefined,
    };
    if (out.userFilter && !out.userFilter.includes("{username}")) throw new UserError("The user filter must say where the username goes: {username}.");
    if (url.startsWith("ldap://") && !out.startTls && !out.allowInsecure) throw new UserError("ldap:// without StartTLS sends passwords in the clear: use ldaps://, turn on StartTLS, or allow it knowingly.");
    return JSON.parse(JSON.stringify(out));
  }
  if (b.type === "oidc") {
    const issuer = str(b.issuer, "The issuer", true)!;
    if (!/^https?:\/\//.test(issuer)) throw new UserError("The issuer is its https:// address.");
    const scopes = Array.isArray(b.scopes) ? b.scopes.map(String).map((x: string) => x.trim()).filter(Boolean) : undefined;
    const out: ProviderConfig = {
      id,
      type: "oidc",
      label,
      issuer: issuer.replace(/\/+$/, ""),
      clientId: str(b.clientId, "The client id", true)!,
      clientSecret: secret(b.clientSecret, "clientSecret"),
      scopes: scopes?.length ? scopes : undefined,
      usernameClaim: str(b.usernameClaim, ""),
      emailClaim: str(b.emailClaim, ""),
      nameClaim: str(b.nameClaim, ""),
      groupsClaim: str(b.groupsClaim, ""),
      attributes: Object.keys(attributes).length ? attributes : undefined,
      entraGraphOverage: !!b.entraGraphOverage || undefined,
      userinfo: !!b.userinfo || undefined,
    };
    return JSON.parse(JSON.stringify(out));
  }
  throw new UserError("A provider is a directory (LDAP) or OpenID Connect.");
}

/** A connection by the id in the path, or 404. */
async function connectionParam(r: { params: Record<string, string> }): Promise<Connection> {
  const c = await connections.get(r.params.id);
  if (!c) throw new NotFound("There is no such connection.");
  return c;
}

/** A connection as its page shows it: which values are set (never what), the asker's own, and what they may do to it. */
async function showConnection(c: Connection, p: Principal) {
  const info = await connections.info(c, p.id);
  return { ...info, permissions: authz.allowed(p, await authz.connection(c)) };
}

/** JSON in, JSON out, errors as { error } with a status; signed in, and allowed by `rule`. */
const api =
  (rule: Rule, fn: (req: Request & { params: Record<string, string>; session: Session }, body: any) => Promise<unknown>) =>
  async (r: Request & { params: Record<string, string> }) => {
    if (foreign(r)) return Response.json({ error: "Requests that change things must come from Querier's own pages." }, { status: 403 });
    const s = await signedIn(r);
    if (s instanceof Response) return s;
    const req = Object.assign(r, { session: s });
    // a notebook's id is its workspace and its folder: "ws/nb"
    if (req.params?.ws != null && req.params.nb != null) req.params.nb = `${req.params.ws}/${req.params.nb}`;
    try {
      if (typeof rule === "object") need(s, rule.action, await resourceOf(rule, req.params));
      const body = req.method === "GET" || req.method === "DELETE" ? undefined : await req.json().catch(() => ({}));
      return Response.json((await fn(req, body)) ?? { ok: true });
    } catch (e: any) {
      const status = e instanceof Forbidden ? 403 : e instanceof NotFound ? 404 : e instanceof UserError ? 400 : 500;
      if (status === 500) console.error(e);
      return Response.json({ error: e.message }, { status });
    }
  };

const METRICS_TOKEN = process.env.QUERIER_METRICS_TOKEN ?? "";

/** What each kernel-socket message needs. An op not listed is refused. */
const SOCKET_NEEDS = {
  run: "notebook.run",
  interrupt: "notebook.run",
  restart: "notebook.run",
  complete: "notebook.run",
  inspect: "notebook.run",
  filter: "notebook.run",
  check: "notebook.readCode",
} as const satisfies Record<string, Action>;

/** A refused socket message: answered, so the page isn't left waiting. */
function refuseSocket(ws: Client, msg: { op?: string; id?: number }, action: Action | undefined) {
  const message = action ? `You don't have permission to ${WORDS[action] ?? action}.` : `Unknown request \`${msg.op}\`.`;
  const frame = (meta: object) => ws.send(encodeFrame(meta));
  if (msg.op === "complete") frame({ type: "complete", id: msg.id, start: 0, end: 0, items: [] });
  else if (msg.op === "check") frame({ type: "check", id: msg.id, diagnostics: [] });
  else if (msg.op === "inspect") frame({ type: "inspect", id: msg.id, columns: [], rows: [], error: message });
  else if (msg.op === "filter") frame({ type: "filtered", id: msg.id, error: message });
  frame({ type: "denied", op: msg.op, message });
}
/** What each report-socket message needs: running the published cells is viewing the report. The
 *  rest (completions, inspecting, checking code) isn't a viewer's: those are refused. */
const REPORT_SOCKET_NEEDS = {
  run: "report.view",
  interrupt: "report.view",
  restart: "report.view",
  filter: "report.view",
} as const;

/** A published report's viewer asks something of their report kernel. */
async function reportMessage(ws: Client, msg: any): Promise<unknown> {
  const action = REPORT_SOCKET_NEEDS[msg.op as keyof typeof REPORT_SOCKET_NEEDS];
  const nb = ws.data.nb;
  if (!action || !authz.can(ws.data.principal, action, await authz.notebook(nb))) return refuseSocket(ws, msg, action);
  const p = reports.get(nb);
  if (!p) return ws.send(encodeFrame({ type: "gone" }));
  let h: Host;
  try {
    h = reportHostOf(nb, ws.data.principal);
  } catch (e: any) {
    return ws.send(encodeFrame({ type: "denied", op: msg.op, message: e.message }));
  }
  const deny = (message: string) => ws.send(encodeFrame({ type: "denied", op: msg.op, message }));
  // published again since this tab opened: it follows the new report kernel
  if (!h.clients.has(ws)) h.attach(ws);
  switch (msg.op) {
    case "run": {
      // only the published cells; bound PARAMs are the server's to set, from the viewer's tags
      const names = new Set(p.cells.map((c) => c.name));
      const cells = (Array.isArray(msg.cells) ? msg.cells : []).filter((c: unknown) => typeof c === "string" && names.has(c));
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(msg.params ?? {})) if (!(k in p.bindings) && typeof v === "string") params[k] = v;
      const tags = principalTags(ws.data.principal);
      for (const [param, tag] of Object.entries(p.bindings)) {
        const values = tags[tag] ?? [];
        if (!values.length) return deny(`This report sets ${param} from your ${tag}, and you have none: ask an administrator.`);
        params[param] = values.join(",");
      }
      // run as its owner: only while they may still run it
      if (p.runAs === "owner") {
        const owner = p.owner ? auth.principalById(p.owner) : null;
        if (!owner || !authz.can(owner, "notebook.run", await authz.notebook(nb), true)) return deny("This report runs as its owner, who may no longer run it: it needs publishing again.");
      }
      return void h.run(cells, params);
    }
    case "interrupt":
      return h.interrupt();
    case "restart":
      return h.restart();
    case "filter":
      return h.filterFor(ws, msg.id, msg.cell, msg.terms ?? []);
  }
}

/** Open sockets by session: they close when it ends (signed out, expired, the account disabled). */
const sockets = new Map<string, Set<Client>>();
auth.onEnded((sid) => {
  for (const ws of sockets.get(sid) ?? []) ws.close(4401, "signed out");
  sockets.delete(sid);
});
/** The client's address: the connection's, or X-Forwarded-For's when it comes from a trusted proxy (QUERIER_TRUSTED_PROXIES). */
const clientIp = (req: Request, srv: { requestIP(r: Request): { address: string } | null }) => clientAddress(srv.requestIP(req)?.address ?? "?", req.headers.get("x-forwarded-for"));
/** Back to the login page with a message. */
const toLogin = (message: string) => new Response(null, { status: 302, headers: { Location: `/#/login?error=${encodeURIComponent(message)}` } });

const server = Bun.serve<Client["data"], any>({
  port,
  routes: {
    // every running kernel's CPU and memory, for Prometheus: its bearer token (QUERIER_METRICS_TOKEN), or the sysadmin
    "/metrics": {
      GET: async (req) => {
        const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
        const tokenOk = METRICS_TOKEN && bearer.length === METRICS_TOKEN.length && crypto.timingSafeEqual(Buffer.from(bearer), Buffer.from(METRICS_TOKEN));
        if (!tokenOk) {
          const s = await signedIn(req);
          if (s instanceof Response) return s;
          if (!authz.can(s.principal, "admin.manage", authz.tenant())) return Response.json({ error: "Reading metrics needs a token, or administering Querier." }, { status: 403 });
        }
        return new Response(exposition([...hosts.values()].map((h) => h.latestMetrics()).filter((m) => m != null)), {
          headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
        });
      },
    },

    // -- signing in (no session needed)
    // the sign-in choices, and whether passwords are taken over plain HTTP (QUERIER_ALLOW_HTTP)
    "/api/auth/providers": { GET: () => Response.json({ providers: auth.providers(), httpAllowed: allowInsecureLogin }) },
    "/api/auth/login": {
      POST: async (req, srv) => {
        if (foreign(req)) return Response.json({ error: "Sign in from Querier's own page." }, { status: 403 });
        if (!auth.passwordsAllowed(req))
          return Response.json({ error: "Passwords are only accepted over HTTPS: serve Querier over HTTPS and set QUERIER_PUBLIC_URL to its https:// address (or, on a network you trust, QUERIER_ALLOW_HTTP=1 for now)." }, { status: 403 });
        const b = await req.json().catch(() => ({}));
        try {
          const { principal, cookie } = await auth.login(String(b.provider ?? ""), String(b.username ?? ""), String(b.password ?? ""), clientIp(req, srv));
          return Response.json({ me: publicPrincipal(principal) }, { headers: { "Set-Cookie": cookie } });
        } catch (e: any) {
          if (e instanceof LoginFailed) return Response.json({ error: e.message }, { status: 401 });
          console.error(e);
          return Response.json({ error: "Signing in failed." }, { status: 500 });
        }
      },
    },
    "/api/auth/oidc/:id/start": {
      GET: async (req) => {
        try {
          const url = new URL(req.url);
          const { url: to, cookie } = await auth.oidcStart(req.params.id, url.origin, url.searchParams.get("next") ?? "#/");
          return new Response(null, { status: 302, headers: { Location: to, "Set-Cookie": cookie } });
        } catch (e: any) {
          return toLogin(e instanceof LoginFailed ? e.message : `The provider can't be reached: ${e.message}`);
        }
      },
    },
    "/api/auth/oidc/:id/callback": {
      GET: async (req, srv) => {
        const url = new URL(req.url);
        if (url.searchParams.get("error")) return toLogin(url.searchParams.get("error_description") ?? url.searchParams.get("error")!);
        try {
          const { cookie, next } = await auth.oidcCallback(req.params.id, url, url.origin, clientIp(req, srv), cookieOf(req, OIDC_COOKIE));
          const headers = new Headers({ Location: `/${next}` });
          headers.append("Set-Cookie", cookie);
          headers.append("Set-Cookie", auth.oidcCookie(""));
          return new Response(null, { status: 302, headers });
        } catch (e: any) {
          return toLogin(e instanceof LoginFailed ? e.message : "Signing in failed.");
        }
      },
    },
    "/api/auth/logout": {
      POST: async (req) => {
        if (foreign(req)) return Response.json({ error: "Sign out from Querier's own page." }, { status: 403 });
        const s = await auth.authenticate(req);
        if (s) auth.end(s, "signed out");
        return Response.json({ ok: true }, { headers: { "Set-Cookie": auth.sessions.clearCookie() } });
      },
    },
    // who is signed in, and (for now) whether they may use Querier
    "/api/me": {
      GET: async (req) => {
        const s = await auth.authenticate(req);
        if (!s) return Response.json({ error: "Not signed in.", login: true }, { status: 401 });
        return Response.json({ me: publicPrincipal(s.principal), permissions: authz.allowed(s.principal, authz.tenant()), sessionExpires: s.expires, ...sysadminAccount(s.principal) });
      },
    },
    // the sysadmin's own password (Querier's account; one from .env changes there)
    "/api/me/password": {
      POST: async (req, srv) => {
        if (foreign(req)) return Response.json({ error: "Change it from Querier's own page." }, { status: 403 });
        const s = await auth.authenticate(req);
        if (!s) return Response.json({ error: "Not signed in.", login: true }, { status: 401 });
        const b = await req.json().catch(() => ({}));
        try {
          await auth.changeSysadminPassword(s, String(b.current ?? ""), String(b.password ?? ""), clientIp(req, srv));
          return Response.json(sysadminAccount(s.principal));
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: e instanceof LoginFailed ? 403 : 400 });
        }
      },
    },
    // workspaces: folders of notebooks, with settings their notebooks share
    "/api/workspaces": {
      // the workspaces and notebooks you may see, each with what you may do there
      GET: api(LIST, async (r) => {
        const p = r.session.principal;
        const out = [];
        for (const w of await store.workspaces()) {
          const permissions = authz.allowed(p, await authz.workspace(w.name));
          const notebooks = [];
          for (const n of w.notebooks) {
            const np = authz.allowed(p, await authz.notebook(n.id));
            if (np.includes("notebook.view") || (np.includes("report.view") && reports.get(n.id))) notebooks.push({ ...n, permissions: np, published: !!reports.get(n.id) });
          }
          // a workspace shows when you have a role in it, or a notebook of it was shared with you
          if (!permissions.includes("workspace.view") && !notebooks.length) continue;
          out.push({ ...w, notebooks, permissions, ai: await access.workspaceLevel(w.name) });
        }
        const admin = authz.can(p, "admin.manage", authz.tenant(), true);
        return { root: admin ? store.root : "", workspaces: out, permissions: authz.allowed(p, authz.tenant()) };
      }),
      // its maker becomes its Admin (as in Fabric)
      POST: api({ on: "tenant", action: "workspace.create" }, async (r, b) => {
        const name = String(b.name ?? "").trim();
        await store.createWorkspace(name, String(b.title ?? "").trim());
        const p = r.session.principal;
        if (!p.sysadmin) {
          authz.grants.add({ scope: "workspace", target: name, subject: { kind: "user", id: p.id }, role: "Admin", createdBy: p.id });
          authz.reloadGrants();
        }
        auth.audit.log({ actor: p.id, action: "workspace.create", resource: `Workspace:${name}`, decision: "ok" });
        return { name };
      }),
    },
    "/api/workspaces/:ws": {
      GET: api({ on: "workspace", action: "workspace.view" }, async (r) => {
        const w = (await store.workspaces()).find((x) => x.name === r.params.ws);
        if (!w) throw new NotFound(`no workspace \`${r.params.ws}\``);
        return { ...w, ai: await access.workspaceLevel(w.name), permissions: authz.allowed(r.session.principal, await authz.workspace(w.name)) };
      }),
      // each part needs its own: settings (Admin), the sandbox, AI access (Member)
      PATCH: api(CUSTOM, async (r, b) => {
        const ws = r.params.ws;
        const { ai, ...settings } = b ?? {};
        const res = await authz.workspace(ws);
        if (["title", "description", "attributes"].some((k) => k in settings)) need(r.session, "workspace.manage", res);
        if ("sandbox" in settings) need(r.session, "sandbox.manage", res);
        if (ai !== undefined) need(r.session, "ai.configure", res);
        await store.workspaceSettings(ws, settings);
        if (ai !== undefined) await access.setWorkspaceLevel(ws, ai);
        // its notebooks' sandboxes may have changed: their tabs reload what they show
        for (const id of new Set([...hosts.values()].map((h) => h.nb))) if (id.startsWith(`${ws}/`)) changed(id);
      }),
      // only an empty one, unless ?force=1: then its notebooks, connections and AI access go too
      DELETE: api({ on: "workspace", action: "workspace.manage" }, async (r) => {
        const ws = r.params.ws;
        const force = new URL(r.url).searchParams.get("force") === "1";
        await store.removeWorkspace(ws, force);
        await closeWorkspace(ws, () => ({ type: "gone", workspace: true }));
        for (const id of await connections.moveWorkspace(ws, null)) authz.grants.dropTarget("connection", id);
        await access.moveWorkspace(ws, null);
        authz.grants.moveWorkspace(ws, null);
        authz.notebookAttrs.moveWorkspace(ws, null);
        reports.moveWorkspace(ws, null);
        environments.moveWorkspace(ws, null);
        for (const nb of [...schedules.keys()]) if (nb.startsWith(`${ws}/`)) schedule(nb);
        authz.reloadGrants();
        auth.audit.log({ actor: r.session.principal.id, action: "workspace.delete", resource: `Workspace:${ws}`, decision: "ok" });
      }),
    },
    "/api/workspaces/:ws/rename": {
      POST: api({ on: "workspace", action: "workspace.manage" }, async (r, b) => {
        const ws = r.params.ws;
        const to = String(b.name ?? "").trim();
        await store.renameWorkspace(ws, to, true); // refused before any tab is told to move
        await closeWorkspace(ws, (id) => ({ type: "moved", to: `${to}/${id.split("/")[1]}` }));
        await store.renameWorkspace(ws, to);
        await connections.moveWorkspace(ws, to);
        await access.moveWorkspace(ws, to);
        authz.grants.moveWorkspace(ws, to);
        authz.notebookAttrs.moveWorkspace(ws, to);
        const moved = [...schedules.keys()].filter((nb) => nb.startsWith(`${ws}/`));
        reports.moveWorkspace(ws, to);
        environments.moveWorkspace(ws, to);
        for (const nb of moved) (schedule(nb), schedule(`${to}/${nb.slice(ws.length + 1)}`));
        authz.reloadGrants();
        return { name: to };
      }),
    },
    "/api/workspaces/:ws/notebooks": {
      POST: api({ on: "workspace", action: "notebook.create" }, async (r, b) => {
        const id = `${r.params.ws}/${String(b.name ?? "").trim()}`;
        await store.create(id, b.title);
        return { id };
      }),
    },
    "/api/workspaces/:ws/notebooks/:nb": {
      GET: api({ on: "notebook", action: "notebook.view" }, async (r) => {
        const book = await store.load(r.params.nb);
        const permissions = authz.allowed(r.session.principal, await authz.notebook(r.params.nb));
        const pub = reports.get(r.params.nb);
        const published = pub && {
          at: pub.publishedAt,
          by: auth.names([pub.publishedBy])[pub.publishedBy] ?? pub.publishedBy,
          runAs: pub.runAs,
          owner: pub.owner && (auth.names([pub.owner])[pub.owner] ?? pub.owner),
          bindings: pub.bindings,
          schedule: pub.schedule,
          // the live notebook has moved on since: its viewers still get what was published
          changed: pub.version !== reportVersion(book),
        };
        if (permissions.includes("notebook.readCode")) return { ...book, permissions, published };
        // seen, not read: its cells without their code
        return { ...book, template: undefined, cells: book.cells.map((c) => ({ ...c, source: c.lang === "md" ? c.source : "" })), permissions, published, codeHidden: true };
      }),
      // the sandbox needs its own (Member); everything else is editing
      PATCH: api(CUSTOM, async (r, b) => {
        const res = await authz.notebook(r.params.nb);
        if ("sandbox" in (b ?? {})) need(r.session, "sandbox.manage", res);
        if (Object.keys(b ?? {}).some((k) => k !== "sandbox")) need(r.session, "notebook.edit", res);
        await store.settings(r.params.nb, b);
        changed(r.params.nb);
      }),
      // the folder, its kernels and its AI access: all of it
      DELETE: api({ on: "notebook", action: "notebook.delete" }, async (r) => {
        const nb = nbParam(r);
        await closeHost(nb, { type: "gone" });
        await store.removeNotebook(nb);
        await access.moveNotebook(nb, null);
        authz.grants.moveNotebook(nb, null);
        authz.notebookAttrs.moveNotebook(nb, null);
        reports.moveNotebook(nb, null);
        environments.moveNotebook(nb, null);
        schedule(nb);
        authz.reloadGrants();
        auth.audit.log({ actor: r.session.principal.id, action: "notebook.delete", resource: `Notebook:${nb}`, decision: "ok" });
      }),
    },
    // a new folder name, or another workspace; its AI access follows it, open tabs too
    "/api/workspaces/:ws/notebooks/:nb/rename": {
      POST: api(CUSTOM, async (r, b) => {
        const nb = nbParam(r);
        const toWs = String(b.workspace ?? r.params.ws).trim();
        const to = `${toWs}/${String(b.name ?? "").trim()}`;
        if (toWs === r.params.ws) need(r.session, "notebook.edit", await authz.notebook(nb));
        else {
          need(r.session, "notebook.delete", await authz.notebook(nb));
          need(r.session, "notebook.create", await authz.workspace(toWs));
        }
        await store.renameNotebook(nb, to, true); // refused before any tab is told to move
        await closeHost(nb, { type: "moved", to });
        await store.renameNotebook(nb, to);
        await access.moveNotebook(nb, to);
        authz.grants.moveNotebook(nb, to);
        authz.notebookAttrs.moveNotebook(nb, to);
        reports.moveNotebook(nb, to);
        environments.moveNotebook(nb, to);
        schedule(nb);
        schedule(to);
        authz.reloadGrants();
        return { id: to };
      }),
    },
    "/api/workspaces/:ws/notebooks/:nb/cells": {
      POST: api({ on: "notebook", action: "notebook.edit" }, async (r, b) => {
        const name = await store.add(r.params.nb, b.lang, b.after ?? null, b.source ?? "");
        changed(r.params.nb);
        return { name };
      }),
    },
    "/api/workspaces/:ws/notebooks/:nb/cells/:cell": {
      PUT: api({ on: "notebook", action: "notebook.edit" }, async (r, b) => {
        await store.save(r.params.nb, r.params.cell, b.source);
        for (const h of hostsOf(r.params.nb)) h.analyzeSoon();
      }),
      PATCH: api({ on: "notebook", action: "notebook.edit" }, async (r, b) => {
        const { nb, cell } = r.params;
        let updated: string[] = [];
        if (b.name && b.name !== cell) {
          updated = await store.rename(nb, cell, b.name);
          for (const h of hostsOf(nb)) await h.renamed(cell, b.name);
        }
        if (b.lang) await store.setLang(nb, b.name ?? cell, b.lang);
        if (b.move) await store.move(nb, b.name ?? cell, b.move);
        changed(nb);
        return { updated };
      }),
      DELETE: api({ on: "notebook", action: "notebook.edit" }, async (r) => {
        await store.remove(r.params.nb, r.params.cell);
        for (const h of hostsOf(r.params.nb)) await h.removed(r.params.cell);
        changed(r.params.nb);
      }),
    },
    // -- environments: the Python packages kernels get and the npm packages templates may import
    "/api/workspaces/:ws/environment": {
      GET: api({ on: "workspace", action: "workspace.view" }, async (r) => environmentOf(`ws:${r.params.ws}`)),
    },
    "/api/workspaces/:ws/environment/:kind": {
      PUT: api({ on: "workspace", action: "environment.manage" }, async (r, b) => applyEnvironment(r.session, `ws:${r.params.ws}`, r.params.kind, b)),
    },
    "/api/workspaces/:ws/notebooks/:nb/environment": {
      GET: api({ on: "notebook", action: "notebook.view" }, async (r) => environmentOf(`nb:${nbParam(r)}`)),
    },
    "/api/workspaces/:ws/notebooks/:nb/environment/:kind": {
      PUT: api({ on: "notebook", action: "environment.manage" }, async (r, b) => applyEnvironment(r.session, `nb:${nbParam(r)}`, r.params.kind, b)),
    },
    // -- the published report: what its viewers get (report.view), and publishing it (notebook.share)
    "/api/workspaces/:ws/notebooks/:nb/published": {
      GET: api({ on: "notebook", action: "report.view" }, async (r) => {
        const nb = nbParam(r);
        const p = reports.get(nb);
        if (!p) throw new NotFound("This report isn't published.");
        const who = r.session.principal;
        const permissions = authz.allowed(who, await authz.notebook(nb));
        const code = permissions.includes("notebook.readCode");
        const names = auth.names([p.publishedBy, ...(p.owner ? [p.owner] : [])]);
        const snap = snapshots.get(nb);
        return {
          name: nb,
          workspace: r.params.ws,
          title: p.title,
          description: p.description,
          report: p.report,
          // report.svelte is its layout: the frame's script is built from it (?published=1)
          template: p.template ?? undefined,
          templateToken: p.template ? await auth.signer.sign(`template:published:${nb}`, 24 * 3600) : undefined,
          templateVersion: p.template ? await templateVersion(p.template, await templatePackages(nb, p.envs ?? {})) : undefined,
          // its code only for who may read it; everyone gets each cell's hash (what is fresh)
          cells: p.cells.map((c) => ({ ...c, source: code || c.lang === "md" ? c.source : "", hash: hash(c.source) })),
          // bound PARAMs are the server's to set: they aren't the viewer's controls
          params: p.params.filter((x) => !(x.name in p.bindings)),
          bound: Object.keys(p.bindings),
          // what the server sets them to for this viewer: their own attributes (what is fresh, on their side)
          boundValues: Object.fromEntries(Object.entries(p.bindings).map(([param, tag]) => [param, (principalTags(who)[tag] ?? []).join(",")])),
          files: [],
          permissions,
          published: {
            at: p.publishedAt,
            by: names[p.publishedBy] ?? p.publishedBy,
            runAs: p.runAs,
            owner: p.owner && (names[p.owner] ?? p.owner),
            schedule: p.schedule,
            snapshotAt: snap && canSchedule(p) ? snap.at : undefined,
          },
        };
      }),
      // publish (again): the cells, layout and template as they are now, and how it runs
      POST: api({ on: "notebook", action: "notebook.share" }, async (r, b) => {
        const nb = nbParam(r);
        const who = r.session.principal;
        const book = await store.load(nb);
        const runAs: RunAs = b.runAs === "owner" ? "owner" : "viewer";
        // running as its owner lends their connections: only for themselves, and only what they may run
        if (runAs === "owner") need(r.session, "notebook.run", await authz.notebook(nb));
        const bindings: Record<string, string> = {};
        for (const [param, tag] of Object.entries(b.bindings ?? {})) {
          if (!book.params.some((x) => x.name === param)) throw new UserError(`There is no PARAM \`${param}\` in this notebook.`);
          const t = String(tag ?? "").trim();
          if (!/^[A-Za-z_][\w.-]{0,63}$/.test(t)) throw new UserError(`\`${param}\` needs the name of a tag people have (department, region…).`);
          bindings[param] = t;
        }
        let sched: Published["schedule"];
        if (b.schedule?.every != null) {
          const every = Number(b.schedule.every);
          if (!(every > 0)) throw new UserError("A schedule runs every so many minutes.");
          if (runAs !== "owner") throw new UserError("Only a report run as its owner can be scheduled: run as each viewer, it has no single result to keep.");
          if (Object.keys(bindings).length) throw new UserError("A report with bound PARAMs gives each viewer their own rows: it can't be scheduled.");
          sched = { every };
        }
        const published: Published = {
          cells: book.cells.map((c) => ({ name: c.name, lang: c.lang, source: c.source, file: c.file })),
          report: book.report,
          template: book.template ?? null,
          params: book.params,
          title: book.title,
          description: book.description,
          runAs,
          ...(runAs === "owner" ? { owner: who.id } : {}),
          bindings,
          ...(sched ? { schedule: sched } : {}),
          publishedBy: who.id,
          publishedAt: Date.now(),
          version: reportVersion(book),
          envs: envHashes(nb),
        };
        reports.set(nb, published);
        snapshots.delete(nb);
        await closeReportHosts(nb, { type: "notebook" });
        schedule(nb);
        auth.audit.log({ actor: who.id, action: "report.publish", resource: `Notebook:${nb}`, decision: "ok", detail: { runAs, bindings, schedule: sched } });
        changed(nb); // its editors' tabs show it published
        return { at: published.publishedAt };
      }),
      DELETE: api({ on: "notebook", action: "notebook.share" }, async (r) => {
        const nb = nbParam(r);
        reports.remove(nb);
        schedule(nb);
        await closeReportHosts(nb, { type: "gone" });
        auth.audit.log({ actor: r.session.principal.id, action: "report.unpublish", resource: `Notebook:${nb}`, decision: "ok" });
        changed(nb);
      }),
    },
    // the report as a Svelte template (server/template.ts): its source, and the bundle its frame runs
    "/api/workspaces/:ws/notebooks/:nb/template": {
      GET: api({ on: "notebook", action: "notebook.readCode" }, async (r) => {
        const source = await store.template(nbParam(r));
        if (source == null) return { source: null };
        const pk = await templatePackages(nbParam(r));
        const built = await buildTemplate(source, pk);
        return { source, version: await templateVersion(source, pk), error: built.error ?? null, token: await templateToken(nbParam(r)) };
      }),
      PUT: api({ on: "notebook", action: "notebook.edit" }, async (r, b) => {
        const nb = nbParam(r);
        const source = String(b.source ?? "");
        await store.saveTemplate(nb, source);
        changed(nb);
        const pk = await templatePackages(nb);
        const built = await buildTemplate(source, pk);
        return { version: await templateVersion(source, pk), error: built.error ?? null, token: await templateToken(nb) };
      }),
      DELETE: api({ on: "notebook", action: "notebook.edit" }, async (r) => {
        const nb = nbParam(r);
        await store.removeTemplate(nb);
        changed(nb);
      }),
    },
    // fetched by the template's sandboxed frame, which sends no cookie: a signed token instead
    "/api/workspaces/:ws/notebooks/:nb/template.js": {
      GET: async (r) => {
        try {
          // the published report's (its own token), or the live notebook's
          const pub = new URL(r.url).searchParams.get("published") === "1";
          if (!(await auth.signer.verify(pub ? `template:published:${idOf(r)}` : `template:${idOf(r)}`, new URL(r.url).searchParams.get("t") ?? ""))) return new Response("no access", { status: 403 });
          const source = pub ? (reports.get(idOf(r))?.template ?? null) : await store.template(idOf(r));
          if (source == null) return new Response("no template", { status: 404 });
          const built = await buildTemplate(source, await templatePackages(idOf(r), pub ? (reports.get(idOf(r))?.envs ?? {}) : undefined));
          if (built.error) return Response.json(built, { status: 422 });
          // named by version (?v=): the same URL never changes content
          return new Response(built.js, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable" } });
        } catch (e: any) {
          return Response.json({ error: { message: e.message } }, { status: e instanceof UserError ? 400 : 500 });
        }
      },
    },
    // a cell's result in full, from the kernel: ?format=parquet (default) or csv
    "/api/workspaces/:ws/notebooks/:nb/cells/:cell/export": {
      GET: async (r) => {
        const s = await signedIn(r);
        if (s instanceof Response) return s;
        // a published report's viewer exports from their report kernel
        const fromReport = new URL(r.url).searchParams.get("report") === "1";
        if (!authz.can(s.principal, fromReport ? "report.view" : "notebook.run", await authz.notebook(idOf(r))))
          return Response.json({ error: fromReport ? "You don't have permission to see this report." : "You don't have permission to run this notebook." }, { status: 403 });
        const { cell } = r.params;
        const format = new URL(r.url).searchParams.get("format") === "csv" ? "csv" : "parquet";
        try {
          const nb = idOf(r);
          const chunks = await (fromReport ? reportHostOf(nb, s.principal) : hostOf(nb, s.principal)).export(cell, format);
          const body = new ReadableStream<Uint8Array>({
            async start(c) {
              try {
                for await (const chunk of chunks) c.enqueue(chunk);
                c.close();
              } catch (e) {
                c.error(e);
              }
            },
          });
          return new Response(body, {
            headers: {
              "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.apache.parquet",
              "Content-Disposition": `attachment; filename="${cell}.${format}"`,
            },
          });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: e instanceof UserError ? 400 : 409 });
        }
      },
    },
    // what this notebook's kernel gets, for the asker: the connections they may use here, and which values they lack
    "/api/workspaces/:ws/notebooks/:nb/connections": {
      GET: api({ on: "notebook", action: "notebook.view" }, async (r) => {
        const p = r.session.principal;
        const out = [];
        for (const c of await connections.inScope(r.params.ws)) {
          const info = await showConnection(c, p);
          if (info.permissions.includes("connection.use") || info.permissions.includes("connection.manage")) out.push(info);
        }
        return { connections: out };
      }),
    },
    // git: each notebook folder may be its own repository, opted into per notebook
    "/api/workspaces/:ws/notebooks/:nb/git": {
      GET: api({ on: "notebook", action: "notebook.view" }, async (r) => {
        const nb = nbParam(r);
        return { ...(await gitOf(nb, r.session.principal).status()), declined: (await store.readSettings(nb)).git === false };
      }),
    },
    "/api/workspaces/:ws/notebooks/:nb/git/init": {
      POST: api({ on: "notebook", action: "notebook.edit" }, async (r, b) => {
        const nb = nbParam(r);
        await gitOf(nb, r.session.principal).init({ name: b.name, email: b.email }, b.remote || undefined);
        // clear an earlier "don't ask" (only then: rewriting notebook.json would be a change)
        if ((await store.readSettings(nb)).git === false) await store.settings(nb, { git: null });
      }),
    },
    "/api/workspaces/:ws/notebooks/:nb/git/decline": { POST: api({ on: "notebook", action: "notebook.edit" }, async (r) => store.settings(nbParam(r), { git: false })) },
    "/api/workspaces/:ws/notebooks/:nb/git/commit": { POST: api({ on: "notebook", action: "notebook.edit" }, async (r, b) => gitOf(nbParam(r), r.session.principal).commit(String(b.message ?? ""))) },
    "/api/workspaces/:ws/notebooks/:nb/git/restore": {
      POST: api({ on: "notebook", action: "notebook.edit" }, async (r, b) => {
        const nb = nbParam(r);
        await gitOf(nb, r.session.principal).restore(b.rev ?? "HEAD", b.cells);
        changed(nb); // git rewrote files: every tab reloads them
      }),
    },
    "/api/workspaces/:ws/notebooks/:nb/git/log": { GET: api({ on: "notebook", action: "notebook.readCode" }, async (r) => gitOf(nbParam(r), r.session.principal).log(300)) },
    "/api/workspaces/:ws/notebooks/:nb/git/commits/:rev": { GET: api({ on: "notebook", action: "notebook.readCode" }, async (r) => gitOf(nbParam(r), r.session.principal).show(r.params.rev)) },
    "/api/workspaces/:ws/notebooks/:nb/git/branches": {
      GET: api({ on: "notebook", action: "notebook.view" }, async (r) => gitOf(nbParam(r), r.session.principal).branches()),
      POST: api({ on: "notebook", action: "notebook.edit" }, async (r, b) => gitOf(nbParam(r), r.session.principal).createBranch(String(b.name ?? ""))),
    },
    "/api/workspaces/:ws/notebooks/:nb/git/switch": {
      POST: api({ on: "notebook", action: "notebook.edit" }, async (r, b) => {
        const nb = nbParam(r);
        await gitOf(nb, r.session.principal).switchBranch(String(b.name ?? ""));
        changed(nb); // git rewrote files: every tab reloads them
      }),
    },
    "/api/workspaces/:ws/notebooks/:nb/git/remote": { POST: api({ on: "notebook", action: "git.push" }, async (r, b) => gitOf(nbParam(r), r.session.principal).setRemote(String(b.url ?? "").trim())) },
    "/api/workspaces/:ws/notebooks/:nb/git/fetch": { POST: api({ on: "notebook", action: "git.pull" }, async (r) => gitOf(nbParam(r), r.session.principal).fetch()) },
    "/api/workspaces/:ws/notebooks/:nb/git/pull": {
      POST: api({ on: "notebook", action: "git.pull" }, async (r, b) => {
        const nb = nbParam(r);
        await gitOf(nb, r.session.principal).pull(!!b.rebase);
        changed(nb); // git rewrote files: every tab reloads them
      }),
    },
    "/api/workspaces/:ws/notebooks/:nb/git/push": { POST: api({ on: "notebook", action: "git.push" }, async (r) => gitOf(nbParam(r), r.session.principal).push()) },
    "/mcp": mcp,
    // AI clients: tokens (shown once), and each notebook's access level
    // a person's own AI clients: each token acts as them
    "/api/ai/clients": {
      GET: api(SELF, async (r) => ({ file: pathFor(r.session, access.file), clients: await access.clients(r.session.principal.id) })),
      POST: api(SELF, async (r, b) => {
        const made = await access.create(String(b.name ?? ""), r.session.principal.id);
        auth.audit.log({ actor: r.session.principal.id, action: "ai.token.create", resource: made.client.id, decision: "ok", detail: { name: made.client.name } });
        return made;
      }),
    },
    "/api/ai/clients/:id": {
      DELETE: api(SELF, async (r) => {
        await access.revoke(r.params.id, r.session.principal.id);
        auth.audit.log({ actor: r.session.principal.id, action: "ai.token.revoke", resource: r.params.id, decision: "ok" });
      }),
    },
    "/api/workspaces/:ws/notebooks/:nb/ai": {
      // the level in force, whether it is the notebook's own, and its workspace's default
      GET: api({ on: "notebook", action: "notebook.view" }, async (r) => {
        const nb = nbParam(r);
        return { level: await access.level(nb), own: await access.ownLevel(nb), workspace: await access.workspaceLevel(r.params.ws) };
      }),
      PUT: api({ on: "notebook", action: "ai.configure" }, async (r, b) => access.setLevel(nbParam(r), b.level ?? null)),
    },
    // -- who has access: a workspace's roles, a notebook's shares
    "/api/workspaces/:ws/access": {
      GET: api({ on: "workspace", action: "workspace.manageAccess" }, async (r) => ({ grants: authz.grants.of("workspace", r.params.ws).map(showGrant) })),
      // a Member gives roles up to Member; Admin only an Admin may give
      POST: api({ on: "workspace", action: "workspace.manageAccess" }, async (r, b) => {
        const role = String(b.role ?? "");
        if (!(role in WORKSPACE_ROLES)) throw new UserError(`A workspace role is one of ${ROLE_ORDER.join(", ")}.`);
        if (role === "Admin") need(r.session, "workspace.manage", await authz.workspace(r.params.ws));
        return showGrant(addGrant(r.session, { scope: "workspace", target: r.params.ws, subject: subjectOf(b.subject), role: role as WorkspaceRole }));
      }),
    },
    "/api/workspaces/:ws/access/:id": {
      DELETE: api({ on: "workspace", action: "workspace.manageAccess" }, async (r) => {
        const g = authz.grants.get(r.params.id);
        if (!g || g.scope !== "workspace" || g.target !== r.params.ws) throw new NotFound("There is no such grant.");
        if (g.role === "Admin") need(r.session, "workspace.manage", await authz.workspace(r.params.ws));
        removeGrant(r.session, g);
      }),
    },
    "/api/workspaces/:ws/notebooks/:nb/access": {
      GET: api({ on: "notebook", action: "notebook.share" }, async (r) => ({ grants: authz.grants.of("notebook", r.params.nb).map(showGrant) })),
      POST: api({ on: "notebook", action: "notebook.share" }, async (r, b) => {
        const role = String(b.role ?? "");
        if (!(role in SHARE_LEVELS)) throw new UserError(`A share is one of ${SHARE_ORDER.join(", ")}.`);
        return showGrant(addGrant(r.session, { scope: "notebook", target: r.params.nb, subject: subjectOf(b.subject), role: role as ShareLevel }));
      }),
    },
    "/api/workspaces/:ws/notebooks/:nb/access/:id": {
      DELETE: api({ on: "notebook", action: "notebook.share" }, async (r) => {
        const g = authz.grants.get(r.params.id);
        if (!g || g.scope !== "notebook" || g.target !== r.params.nb) throw new NotFound("There is no such share.");
        removeGrant(r.session, g);
      }),
    },
    // a notebook's attributes for policies (a classification): kept by the server, changed by a workspace Admin
    "/api/workspaces/:ws/notebooks/:nb/attributes": {
      GET: api({ on: "notebook", action: "notebook.view" }, async (r) => ({ attributes: authz.notebookAttrs.get(r.params.nb) })),
      PUT: api(CUSTOM, async (r, b) => {
        need(r.session, "workspace.manage", await authz.workspace(r.params.ws));
        const attrs = b.attributes == null ? null : checkAttributes(b.attributes);
        authz.notebookAttrs.set(nbParam(r), attrs);
        auth.audit.log({ actor: r.session.principal.id, action: "notebook.attributes", resource: `Notebook:${r.params.nb}`, decision: "ok", detail: { attributes: attrs } });
      }),
    },
    // -- connections: everyone's (the tenant's) and each workspace's; who may use them is policy
    "/api/connections": {
      // those the asker may use or manage: everyone's and ?workspace=ws's, or all of them
      GET: api(LIST, async (r) => {
        const ws = new URL(r.url).searchParams.get("workspace");
        const p = r.session.principal;
        const out = [];
        for (const c of ws ? await connections.inScope(ws) : await connections.all()) {
          const info = await showConnection(c, p);
          if (info.permissions.length) out.push(info);
        }
        const where = ws ? await authz.workspace(ws) : authz.tenant();
        return { connections: out, mayCreate: authz.can(p, "connection.manage", where, true), mayCreateEveryone: authz.can(p, "connection.manage", authz.tenant(), true) };
      }),
      // a new one: everyone's (connection.manage on the tenant) or a workspace's (there)
      POST: api(CUSTOM, async (r, b) => {
        const ws = b.workspace ? String(b.workspace) : undefined;
        if (ws) store.wsDir(ws);
        need(r.session, "connection.manage", ws ? await authz.workspace(ws) : authz.tenant());
        const variables = Array.isArray(b.variables) ? b.variables.map(String) : [];
        const c = await connections.create({ name: String(b.name ?? ""), workspace: ws, description: b.description, variables, credentials: b.credentials }, r.session.principal.id);
        auth.audit.log({ actor: r.session.principal.id, action: "connection.create", resource: `Connection:${c.id}`, decision: "ok", detail: { name: c.name, workspace: ws } });
        return showConnection(c, r.session.principal);
      }),
    },
    "/api/connections/:id": {
      PATCH: api(CUSTOM, async (r, b) => {
        const c = await connectionParam(r);
        need(r.session, "connection.manage", await authz.connection(c));
        const next = await connections.update(c.id, { name: b.name, description: b.description, variables: Array.isArray(b.variables) ? b.variables.map(String) : undefined, credentials: b.credentials });
        auth.audit.log({ actor: r.session.principal.id, action: "connection.update", resource: `Connection:${c.id}`, decision: "ok" });
        await connectionsChanged(c.workspace ? { ws: c.workspace } : null);
        return showConnection(next, r.session.principal);
      }),
      DELETE: api(CUSTOM, async (r) => {
        const c = await connectionParam(r);
        need(r.session, "connection.manage", await authz.connection(c));
        await connections.remove(c.id);
        authz.grants.dropTarget("connection", c.id);
        authz.reloadGrants();
        auth.audit.log({ actor: r.session.principal.id, action: "connection.delete", resource: `Connection:${c.id}`, decision: "ok", detail: { name: c.name } });
        await connectionsChanged(c.workspace ? { ws: c.workspace } : null);
      }),
    },
    // a shared connection's values (who manages it sets them): { values: { VAR: "…" | null } }
    "/api/connections/:id/values": {
      PUT: api(CUSTOM, async (r, b) => {
        const c = await connectionParam(r);
        need(r.session, "connection.manage", await authz.connection(c));
        await connections.setValues(c.id, b.values ?? {});
        auth.audit.log({ actor: r.session.principal.id, action: "connection.values", resource: `Connection:${c.id}`, decision: "ok", detail: { variables: Object.keys(b.values ?? {}) } });
        await connectionsChanged(c.workspace ? { ws: c.workspace } : null);
        return showConnection((await connections.get(c.id))!, r.session.principal);
      }),
    },
    // one's own values of a per-user connection they may use
    "/api/connections/:id/mine": {
      PUT: api(CUSTOM, async (r, b) => {
        const c = await connectionParam(r);
        need(r.session, "connection.use", await authz.connection(c));
        await connections.setValues(c.id, b.values ?? {}, r.session.principal.id);
        await connectionsChanged({ ...(c.workspace ? { ws: c.workspace } : {}), owner: r.session.principal.id });
        return showConnection((await connections.get(c.id))!, r.session.principal);
      }),
      DELETE: api(CUSTOM, async (r) => {
        const c = await connectionParam(r);
        need(r.session, "connection.use", await authz.connection(c));
        await connections.setValues(c.id, Object.fromEntries(c.variables.map((v) => [v, null])), r.session.principal.id);
        await connectionsChanged({ ...(c.workspace ? { ws: c.workspace } : {}), owner: r.session.principal.id });
      }),
    },
    // a connection's own roles: Owner (use it, change it, give it), User (use it)
    "/api/connections/:id/access": {
      GET: api(CUSTOM, async (r) => {
        const c = await connectionParam(r);
        need(r.session, "connection.manage", await authz.connection(c));
        return { grants: authz.grants.of("connection", c.id).map(showGrant) };
      }),
      POST: api(CUSTOM, async (r, b) => {
        const c = await connectionParam(r);
        need(r.session, "connection.manage", await authz.connection(c));
        const role = String(b.role ?? "");
        if (!(role in CONNECTION_ROLES)) throw new UserError(`A connection role is one of ${CONNECTION_ORDER.join(", ")}.`);
        return showGrant(addGrant(r.session, { scope: "connection", target: c.id, subject: subjectOf(b.subject), role: role as ConnectionRole }));
      }),
    },
    "/api/connections/:id/access/:grant": {
      DELETE: api(CUSTOM, async (r) => {
        const c = await connectionParam(r);
        need(r.session, "connection.manage", await authz.connection(c));
        const g = authz.grants.get(r.params.grant);
        if (!g || g.scope !== "connection" || g.target !== c.id) throw new NotFound("There is no such grant.");
        removeGrant(r.session, g);
      }),
    },
    // -- sign-in: the identity providers (auth.json) and session lifetimes (admin.manage)
    "/api/admin/auth": {
      GET: api({ on: "tenant", action: "admin.manage" }, async (r) => ({
        providers: auth.config.providers.map(showProvider),
        session: auth.config.session,
        file: authFile(),
        // where OIDC providers send people back: to register with them
        redirectBase: publicUrl || new URL(r.url).origin,
        sysadmin: auth.sysadmin.principal().username,
        admission: await admission(),
      })),
    },
    // who may sign in: a condition over their groups and attributes (null: everyone the directories accept)
    "/api/admin/auth/admission": {
      PUT: api({ on: "tenant", action: "admin.manage" }, async (r, b) => {
        const when = typeof b.when === "string" && b.when.trim() ? b.when.trim() : null;
        if (when) {
          const problems = authz.engine.checkCondition(when);
          if (problems.length) throw new UserError(`That condition isn't a valid policy: ${problems[0].message}`);
          await authz.saveCustom(ADMISSION_FILE, admissionText(when));
        } else await authz.removeCustom(ADMISSION_FILE);
        auth.audit.log({ actor: r.session.principal.id, action: "auth.admission", resource: "Tenant:querier", decision: "ok", detail: { when } });
        return admission();
      }),
    },
    // a provider's settings tried, saved or not, without anyone's password (LDAP: a person looked up by name)
    "/api/admin/auth/test": {
      POST: api({ on: "tenant", action: "admin.manage" }, async (r, b) => {
        const existing = auth.config.providers.find((p) => p.id === (b.original ?? b.provider?.id));
        const p = providerFrom(b.provider ?? {}, existing);
        return auth.test(p, new URL(r.url).origin, typeof b.username === "string" ? b.username : undefined);
      }),
    },
    // a provider made or changed (its id stays: it is part of the id of everyone who signed in with it)
    "/api/admin/auth/providers/:id": {
      PUT: api({ on: "tenant", action: "admin.manage" }, async (r, b) => {
        const existing = auth.config.providers.find((p) => p.id === r.params.id);
        const p = providerFrom({ ...(b.provider ?? {}), id: r.params.id }, existing);
        const providers = existing ? auth.config.providers.map((x) => (x.id === p.id ? p : x)) : [...auth.config.providers, p];
        await auth.saveConfig({ ...auth.config, providers });
        auth.audit.log({ actor: r.session.principal.id, action: existing ? "auth.provider.update" : "auth.provider.create", resource: `Provider:${p.id}`, decision: "ok", detail: { type: p.type, label: p.label } });
        return showProvider(p);
      }),
      DELETE: api({ on: "tenant", action: "admin.manage" }, async (r) => {
        if (!auth.config.providers.some((p) => p.id === r.params.id)) throw new NotFound("There is no such provider.");
        await auth.saveConfig({ ...auth.config, providers: auth.config.providers.filter((p) => p.id !== r.params.id) });
        auth.audit.log({ actor: r.session.principal.id, action: "auth.provider.delete", resource: `Provider:${r.params.id}`, decision: "ok" });
      }),
    },
    // the order of the sign-in page's choices
    "/api/admin/auth/order": {
      PUT: api({ on: "tenant", action: "admin.manage" }, async (r, b) => {
        const ids: string[] = Array.isArray(b.ids) ? b.ids.map(String) : [];
        const byId = new Map(auth.config.providers.map((p) => [p.id, p]));
        if (ids.length !== byId.size || ids.some((id) => !byId.has(id))) throw new UserError("Every provider, once.");
        await auth.saveConfig({ ...auth.config, providers: ids.map((id) => byId.get(id)!) });
      }),
    },
    "/api/admin/auth/session": {
      PUT: api({ on: "tenant", action: "admin.manage" }, async (r, b) => {
        const n = (v: unknown, what: string, min: number, max: number) => {
          const x = Number(v);
          if (!Number.isFinite(x) || x < min || x > max) throw new UserError(`${what}: between ${min} and ${max}.`);
          return x;
        };
        const session = {
          absoluteHours: n(b.absoluteHours, "A session's longest life, in hours", 1, 24 * 30),
          idleMinutes: n(b.idleMinutes, "Signed out after this long unused, in minutes", 5, 24 * 60 * 7),
          refreshMinutes: n(b.refreshMinutes, "Groups and attributes read again every, in minutes", 1, 24 * 60),
        };
        await auth.saveConfig({ ...auth.config, session });
        auth.audit.log({ actor: r.session.principal.id, action: "auth.session", resource: "Tenant:querier", decision: "ok", detail: session });
        return session;
      }),
    },
    // -- the admin console: policy files, explaining a decision, people, the audit log (admin.manage)
    "/api/admin/policies": {
      GET: api({ on: "tenant", action: "admin.manage" }, async () => ({
        files: (await authz.customFiles()).map((f) => ({ ...f, problems: authz.engine.checkFile(f.text) })),
        // what the last load found wrong: the last valid set stays in force meanwhile
        problems: authz.engine.problems,
        grants: authz.grants.all().length,
        roles: { workspace: WORKSPACE_ROLES, share: SHARE_LEVELS, connection: CONNECTION_ROLES },
        actions: ALL_ACTIONS,
        appliesTo: ACTIONS,
        workspaces: (await store.workspaces()).map((w) => w.name),
        folder: policiesDir(),
      })),
    },
    // a file as it is typed: its problems, placed in its text
    "/api/admin/policies/check": {
      POST: api({ on: "tenant", action: "admin.manage" }, async (_r, b) => ({ problems: authz.engine.checkFile(String(b.text ?? "")) })),
    },
    "/api/admin/policies/:name": {
      PUT: api({ on: "tenant", action: "admin.manage" }, async (r, b) => {
        const name = await authz.saveCustom(r.params.name, String(b.text ?? ""));
        auth.audit.log({ actor: r.session.principal.id, action: "policy.save", resource: `Policy:${name}`, decision: "ok" });
        await connectionsChanged(null); // who may use a connection may have changed
        return { name };
      }),
      DELETE: api({ on: "tenant", action: "admin.manage" }, async (r) => {
        await authz.removeCustom(r.params.name);
        auth.audit.log({ actor: r.session.principal.id, action: "policy.delete", resource: `Policy:${r.params.name}`, decision: "ok" });
        await connectionsChanged(null);
      }),
    },
    // may this person do this to that, and which policies decided it
    "/api/admin/explain": {
      POST: api({ on: "tenant", action: "admin.manage" }, async (_r, b) => {
        const who = auth.principalById(String(b.principal ?? ""));
        if (!who) throw new UserError("Nobody by that id has signed in.");
        const action = String(b.action ?? "") as Action;
        if (!ALL_ACTIONS.includes(action)) throw new UserError(`\`${action}\` isn't an action.`);
        const type = String(b.resource?.type ?? "");
        const id = String(b.resource?.id ?? "");
        let res: Resource;
        if (type === "Tenant") res = authz.tenant();
        else if (type === "Workspace") (store.wsDir(id), (res = await authz.workspace(id)));
        else if (type === "Notebook") (store.dir(id), (res = await authz.notebook(id)));
        else if (type === "Connection") {
          const c = await connections.get(id);
          if (!c) throw new NotFound("There is no such connection.");
          res = await authz.connection(c);
        } else throw new UserError("A resource is a Tenant, Workspace, Notebook or Connection.");
        if (!(ACTIONS[action] as readonly string[]).includes(res.type)) throw new UserError(`${action} doesn't apply to a ${res.type}: it applies to ${ACTIONS[action].join(" or ")}.`);
        const d = authz.explain(who, action, res);
        const texts = authz.engine.policies();
        const reasons = d.reasons.map((pid) => {
          if (pid === "sysadmin") return { id: pid, source: "The system administrator: no policy is asked." };
          if (pid.startsWith("grant:")) {
            const g = authz.grants.get(pid.slice(6));
            const shown = g && showGrant(g);
            return { id: pid, text: texts[pid], source: shown ? `${g!.role} ${g!.scope === "workspace" ? "in the workspace" : g!.scope === "notebook" ? "share of the notebook" : "of the connection"} ${g!.target}, to ${shown.label}` : "a grant" };
          }
          return { id: pid, text: texts[pid], source: `${pid.split("#")[0]}, policy ${pid.split("#")[1]}` };
        });
        return { allow: d.allow, reasons, errors: d.errors, principal: { ...publicPrincipal(who), tags: principalTags(who) } };
      }),
    },
    "/api/admin/people": {
      GET: api({ on: "tenant", action: "admin.manage" }, async (r) => ({ people: auth.people(new URL(r.url).searchParams.get("q") ?? "") })),
    },
    // one person: their tags as policies see them, and what they may do in each workspace
    "/api/admin/people/:id": {
      GET: api({ on: "tenant", action: "admin.manage" }, async (r) => {
        const who = auth.principalById(r.params.id);
        if (!who) throw new NotFound("Nobody by that id has signed in.");
        const workspaces = [];
        for (const w of await store.workspaces()) {
          const permissions = authz.allowed(who, await authz.workspace(w.name));
          const notebooks = [];
          for (const n of w.notebooks) {
            const np = authz.allowed(who, await authz.notebook(n.id));
            if (np.length) notebooks.push({ id: n.id, title: n.title, permissions: np });
          }
          if (permissions.length || notebooks.length) workspaces.push({ name: w.name, title: w.title, permissions, notebooks });
        }
        const person = auth.people(r.params.id).find((p) => p.id === r.params.id);
        return { principal: { ...publicPrincipal(who), lastLogin: person?.lastLogin }, tags: principalTags(who), tenant: authz.allowed(who, authz.tenant()), workspaces };
      }),
    },
    "/api/admin/audit": {
      GET: api({ on: "tenant", action: "admin.manage" }, async (r) => {
        const q = new URL(r.url).searchParams;
        const num = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
        const entries = auth.audit.list({ before: num("before"), limit: num("limit") ?? 100, actor: q.get("actor") || undefined, action: q.get("action") || undefined, decision: q.get("decision") || undefined, resource: q.get("resource") || undefined });
        return { entries, names: auth.names(entries.map((e: any) => e.actor).filter(Boolean)) };
      }),
    },
    // a condition as it is typed: its problems, where they are (the condition editor's squiggles)
    "/api/access/check": {
      POST: api(SELF, async (_r, b) => ({ problems: authz.engine.checkCondition(String(b.when ?? "")) })),
    },
    // what a condition can name: people's tags and their values, groups, and resources' tags
    "/api/access/vocabulary": {
      GET: api(SELF, async () => {
        const resource = new Map<string, Set<string>>();
        const add = (a: Record<string, string>) => Object.entries(a).forEach(([k, v]) => (resource.get(k) ?? resource.set(k, new Set()).get(k)!).add(v));
        for (const w of await store.workspaces()) add(w.attributes ?? {});
        authz.notebookAttrs.all().forEach(add);
        return { ...auth.vocabulary(), resourceTags: Object.fromEntries([...resource].map(([k, v]) => [k, [...v].sort()])) };
      }),
    },
    // people and groups who have signed in: what the share dialog suggests
    "/api/directory": {
      GET: api(SELF, async (r) => auth.directory(new URL(r.url).searchParams.get("q") ?? "")),
    },
    // a published report's viewer: their own report kernel (report.view); each message checked (REPORT_SOCKET_NEEDS)
    "/ws/:ws/:nb/report": (req, srv) => {
      const nb = `${(req as any).params.ws}/${(req as any).params.nb}`;
      const origin = req.headers.get("origin");
      if (origin && !ownOrigin(req, origin)) return new Response("Forbidden origin", { status: 403 });
      try {
        store.dir(nb);
      } catch {
        return new Response("bad notebook", { status: 400 });
      }
      return (async () => {
        const s = await signedIn(req);
        if (s instanceof Response) return s;
        if (!authz.can(s.principal, "report.view", await authz.notebook(nb))) return Response.json({ error: "You don't have permission to see this report." }, { status: 403 });
        if (!reports.get(nb)) return Response.json({ error: "This report isn't published." }, { status: 404 });
        return srv.upgrade(req, { data: { nb, sid: s.idHash, principal: s.principal, outputs: true, report: true } }) ? undefined : new Response("upgrade failed", { status: 400 });
      })();
    },
    "/ws/:ws/:nb": (req, srv) => {
      const nb = `${(req as any).params.ws}/${(req as any).params.nb}`;
      // a socket runs cells: only Querier's own pages open one (browsers always send Origin here)
      const origin = req.headers.get("origin");
      if (origin && !ownOrigin(req, origin)) return new Response("Forbidden origin", { status: 403 });
      try {
        store.dir(nb);
      } catch {
        return new Response("bad notebook", { status: 400 });
      }
      // signed in, and may see the notebook; each message is checked again (socketNeeds)
      return (async () => {
        const s = await signedIn(req);
        if (s instanceof Response) return s;
        const r = await authz.notebook(nb);
        if (!authz.can(s.principal, "notebook.view", r)) return Response.json({ error: "You don't have permission to see this notebook." }, { status: 403 });
        const outputs = authz.can(s.principal, "notebook.run", r, true);
        return srv.upgrade(req, { data: { nb, sid: s.idHash, principal: s.principal, outputs } }) ? undefined : new Response("upgrade failed", { status: 400 });
      })();
    },
  },

  async fetch(req) {
    // The built UI: files by path, index.html for everything else.
    const path = new URL(req.url).pathname;
    const file = Bun.file(join(dist, path.replace(/\.\.+/g, "")));
    // hashed assets never change; the page that names them must be asked for each time,
    // or a browser keeps loading the old build after an update
    if (path !== "/" && (await file.exists()))
      return new Response(file, {
        headers: {
          "Cache-Control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
          // fonts load in CORS mode: a report template's frame (no origin of its own) uses them too
          ...(/\.(woff2?|ttf|otf)$/.test(path) ? { "Access-Control-Allow-Origin": "*" } : {}),
        },
      });
    const index = Bun.file(join(dist, "index.html"));
    if (await index.exists()) return new Response(index, { headers: { "Cache-Control": "no-cache" } });
    return new Response("UI not built: run `bun run build`, or `bun run dev` for the dev server", { status: 404 });
  },

  websocket: {
    open(ws: Client) {
      (sockets.get(ws.data.sid) ?? sockets.set(ws.data.sid, new Set()).get(ws.data.sid)!).add(ws);
      try {
        (ws.data.report ? reportHostOf(ws.data.nb, ws.data.principal) : hostOf(ws.data.nb, ws.data.principal)).attach(ws);
      } catch (e: any) {
        ws.send(encodeFrame({ type: "denied", op: "open", message: e.message }));
        ws.close(4404, "not published");
      }
    },
    close(ws: Client) {
      sockets.get(ws.data.sid)?.delete(ws);
      if (!sockets.get(ws.data.sid)?.size) sockets.delete(ws.data.sid);
      hosts.get(ws.data.report ? reportKey(ws.data.nb, ws.data.principal.id) : hostKey(ws.data.nb, ws.data.principal.id))?.detach(ws);
    },
    async message(ws: Client, raw) {
      const msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      if (ws.data.report) return void (await reportMessage(ws, msg));
      const h = hostOf(ws.data.nb, ws.data.principal);
      // every message is checked, with the policies as they are now (a revoked grant stops at once)
      const action = SOCKET_NEEDS[msg.op as keyof typeof SOCKET_NEEDS];
      if (!action || !authz.can(ws.data.principal, action, await authz.notebook(ws.data.nb))) return refuseSocket(ws, msg, action);
      switch (msg.op) {
        case "run":
          return void h.run(msg.cells, msg.params ?? {});
        case "interrupt":
          return h.interrupt();
        case "restart":
          return h.restart();
        case "complete":
          return h.complete(ws, msg.id, msg.lang, msg.source, msg.pos);
        case "inspect":
          return h.inspect(ws, msg.id, msg.script);
        case "check":
          return h.checkFor(ws, msg.id, msg.source, msg.cell);
        case "filter":
          return h.filterFor(ws, msg.id, msg.cell, msg.terms ?? []);
      }
    },
  },
});

console.log(`querier on http://localhost:${server.port} — notebooks in ${store.root}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await Promise.all([...hosts.values()].map((h) => h.close()));
    process.exit(0);
  });
}
