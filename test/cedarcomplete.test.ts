import { expect, test } from "bun:test";
import { cedarComplete } from "../web/src/lib/cedarcomplete";

const V = { tags: { department: ["Finance", "Sales"], title: [] }, groups: ["finance-analysts", "hr"], resourceTags: { classification: ["restricted"] } };
const at = (doc: string) => cedarComplete(doc.replace("|", ""), doc.indexOf("|"), V);
const labels = (doc: string) => at(doc)?.items.map((i) => i.label) ?? null;

test("after principal. or resource.: the tag methods", () => {
  expect(labels("principal.|")).toEqual(["hasTag", "getTag"]);
  expect(labels("x && resource.get|")).toEqual(["hasTag", "getTag"]);
  expect(at("principal.get|")!.from).toBe("principal.".length);
});

test("after a set: its methods", () => {
  expect(labels('principal.getTag("department").|')).toEqual(["contains", "containsAny", "containsAll", "isEmpty"]);
});

test("inside strings: tag names, their values, groups", () => {
  expect(labels('principal.hasTag("|')).toEqual(["department", "title"]);
  expect(labels('resource.getTag("|')).toEqual(["classification"]);
  expect(labels('principal.hasTag("department") && principal.getTag("department").contains("|')).toEqual(["Finance", "Sales"]);
  expect(labels('principal.getTag("department").containsAny(["Finance", "|')).toEqual(["Finance", "Sales"]);
  expect(labels('principal in Group::"|')).toEqual(["finance-analysts", "hr"]);
  expect(at('principal in Group::"fi|')!.from).toBe('principal in Group::"'.length);
  // any other string: nothing
  expect(at('"just a string|')).toBeNull();
});

test("elsewhere: words, and whole guarded conditions per known tag", () => {
  const items = at("|")!.items;
  const dept = items.find((i) => i.label === "principal department")!;
  expect(dept.insert).toBe('principal.hasTag("department") && principal.getTag("department").contains("${2|Finance,Sales|}")');
  expect(items.find((i) => i.label === "principal in Group")!.insert).toBe('principal in Group::"${1|finance-analysts,hr|}"');
  expect(items.map((i) => i.label)).toContain("principal");
  expect(at("x && pri|")!.from).toBe("x && ".length);
});

test("a quote inside a comment doesn't open a string", () => {
  expect(labels('// "no\nprincipal.|')).toEqual(["hasTag", "getTag"]);
});

test("writing whole policies: permit and forbid, actions and workspaces by name", () => {
  const P = { ...V, policies: { actions: ["notebook.view", "notebook.run"], workspaces: ["finance", "sales"] } };
  const at2 = (doc: string) => cedarComplete(doc.replace("|", ""), doc.indexOf("|"), P);
  expect(at2('permit (principal, action == Action::"|')!.items.map((i) => i.label)).toEqual(["notebook.view", "notebook.run"]);
  expect(at2('permit (principal, action, resource in Workspace::"|')!.items.map((i) => i.label)).toEqual(["finance", "sales"]);
  const permit = at2("|")!.items.find((i) => i.label === "permit")!;
  expect(permit.insert).toContain('action == Action::"${2|notebook.view,notebook.run|}"');
  // a condition (no policies) offers none of it
  expect(at("|")!.items.some((i) => i.label === "permit")).toBe(false);
});
