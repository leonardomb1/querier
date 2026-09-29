import { expect, test } from "bun:test";
import { grantPolicy, PolicyEngine, type Grant } from "../server/auth/policy";
import type { Principal } from "../server/auth/principal";

const user = (id: string, groups: string[] = [], attrs: Record<string, string[]> = {}): Principal => ({ id, provider: "corp", subject: id, username: id, groups, attrs });
const ws = (id: string, attrs = {}) => ({ type: "Workspace" as const, id, attrs });
const nb = (id: string, attrs = {}, workspaceAttrs = {}) => ({ type: "Notebook" as const, id, attrs, workspaceAttrs });

const grants: Grant[] = [
  { id: "1", scope: "workspace", target: "finance", subject: { kind: "group", name: "finance-analysts" }, role: "Contributor" },
  { id: "2", scope: "workspace", target: "finance", subject: { kind: "user", id: "corp:boss" }, role: "Admin" },
  { id: "3", scope: "workspace", target: "sales", subject: { kind: "condition", when: 'principal.hasTag("department") && principal.getTag("department").contains("Sales")' }, role: "Viewer" },
  { id: "4", scope: "notebook", target: "finance/forecast", subject: { kind: "user", id: "corp:guest" }, role: "Run" },
];

test("Fabric roles: what each role of a workspace allows, on it and its notebooks", () => {
  const e = new PolicyEngine();
  expect(e.setGrants(grants)).toEqual([]);
  const ana = user("corp:ana", ["finance-analysts"]);
  expect(e.decide(ana, "notebook.run", nb("finance/q")).allow).toBe(true);
  expect(e.decide(ana, "notebook.edit", nb("finance/q")).allow).toBe(true);
  expect(e.decide(ana, "notebook.share", nb("finance/q")).allow).toBe(false); // Contributor
  expect(e.decide(ana, "workspace.manage", ws("finance")).allow).toBe(false);
  expect(e.decide(ana, "notebook.view", nb("sales/q")).allow).toBe(false); // not their workspace
  expect(e.allowed(user("corp:boss"), ws("finance"))).toContain("workspace.manage");
  // the reason: the grant's policy
  expect(e.decide(ana, "notebook.run", nb("finance/q")).reasons).toEqual(["grant:1"]);
});

test("a dynamic group: everyone whose directory says department = Sales", () => {
  const e = new PolicyEngine();
  e.setGrants(grants);
  const bob = user("corp:bob", [], { department: ["Sales", "EMEA"] });
  expect(e.decide(bob, "notebook.view", nb("sales/q")).allow).toBe(true);
  expect(e.decide(bob, "notebook.run", nb("sales/q")).allow).toBe(false); // Viewer
  expect(e.decide(user("corp:carl", [], { department: ["Ops"] }), "notebook.view", nb("sales/q")).allow).toBe(false);
  expect(e.decide(user("corp:dan"), "notebook.view", nb("sales/q")).allow).toBe(false); // no department at all
});

test("a notebook shared on its own: that notebook only, up to its level", () => {
  const e = new PolicyEngine();
  e.setGrants(grants);
  const guest = user("corp:guest");
  expect(e.decide(guest, "notebook.run", nb("finance/forecast")).allow).toBe(true);
  expect(e.decide(guest, "notebook.edit", nb("finance/forecast")).allow).toBe(false);
  expect(e.decide(guest, "notebook.view", nb("finance/other")).allow).toBe(false);
  expect(e.decide(guest, "workspace.view", ws("finance")).allow).toBe(false);
});

test("custom policies: a forbid over a grant; resource attributes; the sysadmin isn't asked", () => {
  const e = new PolicyEngine();
  e.setGrants(grants);
  expect(
    e.setCustom({
      "confidential.cedar": `forbid (principal, action == Action::"notebook.run", resource)
  when { resource.hasTag("classification") && resource.getTag("classification").contains("confidential")
         && !(principal.hasTag("clearance") && principal.getTag("clearance").contains("high")) };`,
    }),
  ).toEqual([]);
  const ana = user("corp:ana", ["finance-analysts"]);
  const secret = nb("finance/q", { classification: ["confidential"] });
  const d = e.decide(ana, "notebook.run", secret);
  expect(d.allow).toBe(false);
  expect(d.reasons).toEqual(["confidential.cedar#1"]);
  expect(e.decide(user("corp:ana", ["finance-analysts"], { clearance: ["high"] }), "notebook.run", secret).allow).toBe(true);
  expect(e.decide({ ...user("sysadmin:root"), sysadmin: true }, "workspace.manage", ws("anything")).allow).toBe(true);
});

test("bad custom policies are refused whole, and the last valid set stays", () => {
  const e = new PolicyEngine();
  e.setGrants(grants);
  const good = { "a.cedar": 'permit (principal, action == Action::"notebook.view", resource) when { principal.hasTag("team") && principal.getTag("team").contains("all") };' };
  expect(e.setCustom(good)).toEqual([]);
  // an unguarded getTag would error (and a skipped forbid allows): refused
  const unguarded = e.setCustom({ "b.cedar": 'forbid (principal, action, resource) when { principal.getTag("team").contains("x") };' });
  expect(unguarded[0].message).toContain("unable to guarantee safety");
  expect(e.setCustom({ "c.cedar": "permit (principal, action == Action::\"nope\", resource);" }).length).toBeGreaterThan(0);
  expect(e.setCustom({ "d.cedar": "this is not cedar" }).length).toBeGreaterThan(0);
  // still the good one
  expect(e.decide(user("corp:x", [], { team: ["all"] }), "notebook.view", nb("any/nb")).allow).toBe(true);
  expect(Object.keys(e.policies())).toContain("a.cedar#1");
});

test("grants' names are escaped: no policy injection through a group or user name", () => {
  const evil: Grant = { id: "x", scope: "workspace", target: "w", subject: { kind: "group", name: 'g"); permit (principal, action, resource' }, role: "Viewer" };
  expect(grantPolicy(evil)).toContain('Group::"g\\"); permit (principal, action, resource"');
  const e = new PolicyEngine();
  expect(e.setGrants([evil])).toEqual([]);
  expect(e.decide(user("corp:any"), "notebook.view", nb("other/nb")).allow).toBe(false);
  expect(() => grantPolicy({ ...evil, subject: { kind: "user", id: "a\nb" } })).toThrow("control");
});

test("a condition's problems are placed in its own text", () => {
  const e = new PolicyEngine();
  expect(e.checkCondition('principal.hasTag("d") && principal.getTag("d").contains("x")')).toEqual([]);
  const when = 'principal.getTag("d").contains("x")';
  const [p] = e.checkCondition(when);
  expect(p.message).toContain("unable to guarantee safety");
  expect(p.help).toContain("hasTag");
  expect(when.slice(p.start, p.end)).toBe(when); // the unguarded expression
  const typo = 'principal.getTg("d")';
  const [q] = e.checkCondition(typo);
  expect(q.message).toContain("getTg");
  expect(q.start).toBe(0);
});
