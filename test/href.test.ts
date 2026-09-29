import { expect, test } from "bun:test";
import { adminHref, nbHref, parse, viewHref, wsHref } from "../web/src/lib/href";

test("addresses: home, workspaces, notebooks, the admin console, and back", () => {
  expect(parse("#/")).toEqual({ page: "home", ws: null, tab: "overview" });
  expect(parse(wsHref("sales", "settings"))).toEqual({ page: "home", ws: "sales", tab: "settings" });
  expect(parse(nbHref("sales/q 1", true))).toEqual({ page: "report", id: "sales/q 1" });
  expect(parse("#/admin")).toEqual({ page: "home", ws: null, tab: "admin", section: "policies", query: {} });
  expect(parse(adminHref("audit", { actor: "corp:ana" }))).toEqual({ page: "home", ws: null, tab: "admin", section: "audit", query: { actor: "corp:ana" } });
  expect(parse(viewHref("sales/q"))).toEqual({ page: "view", id: "sales/q" });
  // an unknown section: the first
  expect(parse("#/admin/nope")).toMatchObject({ tab: "admin", section: "policies" });
});
