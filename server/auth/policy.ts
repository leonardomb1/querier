// Who may do what: one decision point, Cedar (cedarpolicy.com) underneath.
//
// Every request is a (principal, action, resource). The principal is a User,
// in its directory Groups, with its attributes as tags (Set<String>: directories
// and claims are multi-valued). Resources are the Tenant (all of Querier), a
// Workspace, or a Notebook (in its Workspace); their attributes are tags too.
//
// The policies come from three places, evaluated together:
//   grants   workspace roles (Admin, Member, Contributor, Viewer, as Microsoft
//            Fabric's) and notebook shares (Read, Run, Edit, Reshare), to a
//            person, a group, everyone, or everyone matching a condition
//   custom   .cedar files the sysadmin writes (the admin console, or git)
// Forbid wins over permit. A policy whose condition errors (a missing tag, a
// wrong type) is skipped by Cedar, and a skipped forbid would allow: so any
// error during a decision makes it a deny. The sysadmin is not asked.

import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import type { Principal } from "./principal";

// -- actions, and what each applies to

export const ACTIONS = {
  // signing in at all: everyone the directories accept, unless a policy forbids it (by group, attribute)
  signIn: ["Tenant"],
  "workspace.create": ["Tenant"],
  "admin.manage": ["Tenant"],
  "workspace.view": ["Workspace"],
  "workspace.manage": ["Workspace"],
  "workspace.manageAccess": ["Workspace"],
  "notebook.create": ["Workspace"],
  "notebook.view": ["Notebook"],
  "notebook.readCode": ["Notebook"],
  "notebook.run": ["Notebook"],
  "notebook.edit": ["Notebook"],
  "notebook.delete": ["Notebook"],
  "notebook.share": ["Notebook"],
  "report.view": ["Notebook"],
  "git.pull": ["Notebook"],
  "git.push": ["Notebook"],
  "sandbox.manage": ["Workspace", "Notebook"],
  // the packages kernels and report templates get (pyproject/uv.lock, package.json/bun.lock)
  "environment.manage": ["Workspace", "Notebook"],
  "ai.configure": ["Workspace", "Notebook"],
  // a Connection: using its credentials in a kernel; changing it, its values and who has it.
  // On the Tenant or a Workspace: making one there.
  "connection.use": ["Connection"],
  "connection.manage": ["Tenant", "Workspace", "Connection"],
} as const;
export type Action = keyof typeof ACTIONS;
export const ALL_ACTIONS = Object.keys(ACTIONS) as Action[];

// -- roles: what each grants (docs: the plan's table)

const VIEWER: Action[] = ["workspace.view", "notebook.view", "notebook.readCode", "report.view"];
const CONTRIBUTOR: Action[] = [...VIEWER, "notebook.create", "notebook.run", "notebook.edit", "notebook.delete", "git.pull", "git.push", "connection.use"];
const MEMBER: Action[] = [...CONTRIBUTOR, "notebook.share", "sandbox.manage", "environment.manage", "connection.manage", "ai.configure", "workspace.manageAccess"];
const ADMIN: Action[] = [...MEMBER, "workspace.manage"];
export const WORKSPACE_ROLES = { Admin: ADMIN, Member: MEMBER, Contributor: CONTRIBUTOR, Viewer: VIEWER } as const;
export type WorkspaceRole = keyof typeof WORKSPACE_ROLES;
export const ROLE_ORDER: WorkspaceRole[] = ["Viewer", "Contributor", "Member", "Admin"];

const READ: Action[] = ["notebook.view", "notebook.readCode", "report.view"];
const RUN: Action[] = [...READ, "notebook.run"];
const EDIT: Action[] = [...RUN, "notebook.edit", "git.pull", "git.push"];
const RESHARE: Action[] = [...EDIT, "notebook.share"];
export const SHARE_LEVELS = { Read: READ, Run: RUN, Edit: EDIT, Reshare: RESHARE } as const;
export type ShareLevel = keyof typeof SHARE_LEVELS;
export const SHARE_ORDER: ShareLevel[] = ["Read", "Run", "Edit", "Reshare"];

// a connection's own roles, as Fabric's: its Users run with it, its Owners also change it and who has it
export const CONNECTION_ROLES = { User: ["connection.use"] as Action[], Owner: ["connection.use", "connection.manage"] as Action[] } as const;
export type ConnectionRole = keyof typeof CONNECTION_ROLES;
export const CONNECTION_ORDER: ConnectionRole[] = ["User", "Owner"];

// -- the schema

export const SCHEMA = `
entity Tenant;
entity Group;
entity User in [Group] tags Set<String>;
entity Workspace tags Set<String>;
entity Notebook in [Workspace] tags Set<String>;
entity Connection in [Workspace] tags Set<String>;
${ALL_ACTIONS.map((a) => `action "${a}" appliesTo { principal: User, resource: [${ACTIONS[a].join(", ")}] };`).join("\n")}
`;

// -- grants, as policies

export type Subject = { kind: "user"; id: string } | { kind: "group"; name: string } | { kind: "everyone" } | { kind: "condition"; when: string };

export interface Grant {
  id: string;
  /** a workspace's role, a notebook's share, or a connection's role */
  scope: "workspace" | "notebook" | "connection";
  /** the workspace's name, the notebook's id "ws/nb", or the connection's id */
  target: string;
  subject: Subject;
  role: WorkspaceRole | ShareLevel | ConnectionRole;
  createdBy?: string;
  created?: number;
}

/** A Cedar string literal: quotes and backslashes escaped; control characters refused. */
export function cedarString(s: string): string {
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error("A name can't hold control characters.");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const uid = (type: string, id: string) => `${type}::${cedarString(id)}`;

export function grantPolicy(g: Grant): string {
  const actions =
    g.scope === "workspace" ? WORKSPACE_ROLES[g.role as WorkspaceRole] : g.scope === "notebook" ? SHARE_LEVELS[g.role as ShareLevel] : CONNECTION_ROLES[g.role as ConnectionRole];
  if (!actions) throw new Error(`\`${g.role}\` isn't a ${g.scope === "workspace" ? "workspace role" : g.scope === "notebook" ? "share level" : "connection role"}.`);
  const s = g.subject;
  const principal = s.kind === "user" ? `principal == ${uid("User", s.id)}` : s.kind === "group" ? `principal in ${uid("Group", s.name)}` : "principal";
  const resource =
    g.scope === "workspace" ? `resource in ${uid("Workspace", g.target)}` : g.scope === "notebook" ? `resource == ${uid("Notebook", g.target)}` : `resource == ${uid("Connection", g.target)}`;
  const when = s.kind === "condition" ? ` when { ${s.when} }` : "";
  return `permit (${principal}, action in [${actions.map((a) => uid("Action", a)).join(", ")}], ${resource})${when};`;
}

/** Always in force: anyone the directories accept may sign in, unless a forbid says otherwise. */
const BUILTIN: Record<string, string> = {
  "builtin:sign-in": 'permit (principal, action == Action::"signIn", resource);',
};

// -- the engine

export interface Resource {
  type: "Tenant" | "Workspace" | "Notebook" | "Connection";
  /** Workspace: its name; Notebook: "ws/nb"; Connection: its id */
  id: string;
  attrs?: Record<string, string[]>;
  /** a connection's workspace (none: everyone's) */
  workspace?: string;
  /** a notebook's (or a connection's) workspace's attributes */
  workspaceAttrs?: Record<string, string[]>;
}

export interface Decision {
  allow: boolean;
  /** the policies that decided (for "why") */
  reasons: string[];
  errors: string[];
}

export interface PolicyProblem {
  policy: string;
  message: string;
  /** what to do about it, when Cedar says */
  help?: string;
  /** where in the policy's text, as offsets */
  start?: number;
  end?: number;
  /** allowed, but likely not what was meant (a scope no action fits) */
  warning?: boolean;
}

type CedarError = { message: string; help?: string | null; sourceLocations?: { start: number; end: number }[] };
const problemOf = (policy: string, e: CedarError): PolicyProblem => ({
  policy,
  message: e.message.replace(/^failed to parse policy with id `[^`]*` from string: /, "").replace(/^for policy `[^`]*`, /, ""),
  help: e.help ?? undefined,
  start: e.sourceLocations?.[0]?.start,
  end: e.sourceLocations?.[0]?.end,
});

const tags = (a: Record<string, string[]> = {}) => Object.fromEntries(Object.entries(a).filter(([, v]) => v.length));

/** The principal's own tags: its mapped attributes, plus who and where it is from. */
export function principalTags(p: Principal): Record<string, string[]> {
  return tags({ ...p.attrs, username: [p.username], provider: [p.provider], ...(p.email ? { email: [p.email], emailDomain: [p.email.split("@")[1] ?? ""] } : {}) });
}

export class PolicyEngine {
  private setId = "";
  private version = 0;
  /** in force: the grants' and custom policies' texts, by id */
  private grants: Record<string, string> = {};
  private custom: Record<string, string> = {};
  /** what the last custom load found wrong (the last valid set stays in force) */
  problems: PolicyProblem[] = [];

  constructor() {
    const s = cedar.preparseSchema("querier", SCHEMA);
    if (s.type !== "success") throw new Error(`the policy schema doesn't parse: ${JSON.stringify(s.errors)}`);
    this.rebuild();
  }

  /** Validate policies against the schema, strictly: an unguarded getTag, an unknown action or attribute, is a problem. */
  validate(policies: Record<string, string>): PolicyProblem[] {
    if (!Object.keys(policies).length) return [];
    const parsed = cedar.checkParsePolicySet({ staticPolicies: policies });
    if (parsed.type !== "success") return parsed.errors.map((e) => problemOf("(parse)", e));
    const v = cedar.validate({ schema: SCHEMA, policies: { staticPolicies: policies }, validationSettings: { mode: "strict" } });
    if (v.type !== "success") return v.errors.map((e) => problemOf("(validation)", e));
    return v.validationErrors.map((e) => problemOf(e.policyId, e.error));
  }

  /** A policy file as it is typed: its problems, placed in its text. Warnings don't stop it saving. */
  checkFile(text: string): PolicyProblem[] {
    if (!text.trim()) return [];
    const parsed = cedar.checkParsePolicySet({ staticPolicies: text });
    if (parsed.type !== "success") return parsed.errors.map((e) => problemOf("file", e));
    const v = cedar.validate({ schema: SCHEMA, policies: { staticPolicies: text }, validationSettings: { mode: "strict" } });
    if (v.type !== "success") return v.errors.map((e) => problemOf("file", e));
    return [...v.validationErrors.map((e) => problemOf(e.policyId, e.error)), ...v.validationWarnings.map((e) => ({ ...problemOf(e.policyId, e.error), warning: true }))];
  }

  /** A grant's condition, checked as the policy it becomes: its problems, placed in the condition's own text. */
  checkCondition(when: string): PolicyProblem[] {
    let text: string;
    try {
      text = grantPolicy({ id: "check", scope: "workspace", target: "check", subject: { kind: "condition", when }, role: "Viewer" });
    } catch (e: any) {
      return [{ policy: "condition", message: e.message }];
    }
    const at = text.lastIndexOf(` when { ${when} }`) + " when { ".length;
    const inside = (n?: number) => (n == null ? undefined : Math.max(0, Math.min(when.length, n - at)));
    return this.validate({ check: text }).map((p) => ({ ...p, policy: "condition", start: inside(p.start), end: inside(p.end) }));
  }

  /** The grants in force: each compiled; a grant that doesn't validate is left out and reported. */
  setGrants(list: Grant[]): PolicyProblem[] {
    const out: Record<string, string> = {};
    const problems: PolicyProblem[] = [];
    for (const g of list) {
      try {
        const text = grantPolicy(g);
        const p = this.validate({ [`grant:${g.id}`]: text });
        if (p.length) problems.push(...p);
        else out[`grant:${g.id}`] = text;
      } catch (e: any) {
        problems.push({ policy: `grant:${g.id}`, message: e.message });
      }
    }
    this.grants = out;
    this.rebuild();
    return problems;
  }

  /** Custom policies, by file: all valid, or none of them change (the last valid set stays). */
  setCustom(files: Record<string, string>): PolicyProblem[] {
    const policies: Record<string, string> = {};
    const problems: PolicyProblem[] = [];
    for (const [file, text] of Object.entries(files)) {
      const parts = cedar.policySetTextToParts(text);
      if (parts.type !== "success") {
        problems.push(...parts.errors.map((e) => problemOf(file, e)));
        continue;
      }
      parts.policies.forEach((p, i) => (policies[`${file}#${i + 1}`] = p));
    }
    problems.push(...this.validate(policies));
    this.problems = problems;
    if (problems.length) return problems;
    this.custom = policies;
    this.rebuild();
    return [];
  }

  private rebuild() {
    const id = `querier-${++this.version}`;
    const r = cedar.preparsePolicySet(id, { staticPolicies: { ...BUILTIN, ...this.grants, ...this.custom } });
    if (r.type !== "success") throw new Error(`policies don't parse: ${JSON.stringify(r.errors)}`);
    this.setId = id;
  }

  /** The policies in force, by id: for the admin console. */
  policies(): Record<string, string> {
    return { ...BUILTIN, ...this.grants, ...this.custom };
  }

  /** May `p` do `action` to `r`? */
  decide(p: Principal, action: Action, r: Resource): Decision {
    if (p.sysadmin) return { allow: true, reasons: ["sysadmin"], errors: [] };
    const user = { type: "User", id: p.id };
    const entities: cedar.EntityJson[] = [
      { uid: user, attrs: {}, parents: p.groups.map((g) => ({ type: "Group", id: g })), tags: principalTags(p) },
      ...p.groups.map((g) => ({ uid: { type: "Group", id: g }, attrs: {}, parents: [] })),
    ];
    if (r.type === "Tenant") entities.push({ uid: { type: "Tenant", id: "querier" }, attrs: {}, parents: [] });
    else if (r.type === "Workspace") entities.push({ uid: { type: "Workspace", id: r.id }, attrs: {}, parents: [], tags: tags(r.attrs) });
    else if (r.type === "Connection") {
      entities.push({ uid: { type: "Connection", id: r.id }, attrs: {}, parents: r.workspace ? [{ type: "Workspace", id: r.workspace }] : [], tags: tags(r.attrs) });
      if (r.workspace) entities.push({ uid: { type: "Workspace", id: r.workspace }, attrs: {}, parents: [], tags: tags(r.workspaceAttrs) });
    } else {
      const ws = r.id.slice(0, r.id.indexOf("/"));
      entities.push(
        { uid: { type: "Notebook", id: r.id }, attrs: {}, parents: [{ type: "Workspace", id: ws }], tags: tags(r.attrs) },
        { uid: { type: "Workspace", id: ws }, attrs: {}, parents: [], tags: tags(r.workspaceAttrs) },
      );
    }
    const answer = cedar.statefulIsAuthorized({
      principal: user,
      action: { type: "Action", id: action },
      resource: { type: r.type, id: r.type === "Tenant" ? "querier" : r.id },
      context: {},
      preparsedSchemaName: "querier",
      validateRequest: true,
      preparsedPolicySetId: this.setId,
      entities,
    });
    if (answer.type !== "success") return { allow: false, reasons: [], errors: answer.errors.map((e) => e.message) };
    const { decision, diagnostics } = answer.response;
    const errors = diagnostics.errors.map((e) => `${e.policyId}: ${e.error.message}`);
    // an error anywhere may be a skipped forbid: deny
    return { allow: decision === "allow" && errors.length === 0, reasons: diagnostics.reason, errors };
  }

  /** Every action `p` may do to `r`: what the UI shows and hides. */
  allowed(p: Principal, r: Resource): Action[] {
    return ALL_ACTIONS.filter((a) => (ACTIONS[a] as readonly string[]).includes(r.type) && this.decide(p, a, r).allow);
  }
}
