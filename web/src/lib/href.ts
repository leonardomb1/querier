// Where things live in the address bar: #/, #/w/<workspace>[/settings],
// #/w/<workspace>/nb/<notebook>[/report], #/admin[/<section>], and
// #/login?next=<where to return>.

import { splitId } from "./api";

const enc = encodeURIComponent;

export const homeHref = () => "#/";
/** The admin console's sections. */
export const ADMIN_SECTIONS = ["policies", "explain", "people", "audit", "signin", "server"] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];
export const adminHref = (section: AdminSection = "policies", q?: Record<string, string>) =>
  `#/admin/${section}${q && Object.keys(q).length ? `?${new URLSearchParams(q)}` : ""}`;
export const wsHref = (ws: string, tab?: "settings") => `#/w/${enc(ws)}${tab ? `/${tab}` : ""}`;
/** A notebook's published report, as its viewers see it. */
export function viewHref(id: string): string {
  const [ws, nb] = splitId(id);
  return `#/w/${enc(ws)}/nb/${enc(nb)}/view`;
}
/** A notebook by its id, "workspace/notebook". */
export function nbHref(id: string, report = false): string {
  const [ws, nb] = splitId(id);
  return `#/w/${enc(ws)}/nb/${enc(nb)}${report ? "/report" : ""}`;
}

export type Place =
  | { page: "home"; ws: string | null; tab: "overview" | "settings" }
  /** the admin console (at home): a section, and what it was opened on (?principal=…) */
  | { page: "home"; ws: null; tab: "admin"; section: AdminSection; query: Record<string, string> }
  | { page: "notebook" | "report"; id: string }
  /** its published report, as viewers get it */
  | { page: "view"; id: string }
  /** signing in; back to `next` after */
  | { page: "login"; next: string; error: string }
  /** an address from before workspaces: its notebooks are in `default` now */
  | { page: "legacy"; to: string };

export function parse(hash: string): Place | null {
  if (/^#\/login(\?|$)/.test(hash)) {
    const q = new URLSearchParams(hash.slice(hash.indexOf("?") + 1));
    const next = q.get("next") ?? "#/";
    return { page: "login", next: next.startsWith("#/") && !next.startsWith("#/login") ? next : "#/", error: q.get("error") ?? "" };
  }
  const admin = /^#\/admin(?:\/([a-z]+))?\/?(?:\?(.*))?$/.exec(hash);
  if (admin) {
    const section = (ADMIN_SECTIONS as readonly string[]).includes(admin[1] ?? "") ? (admin[1] as AdminSection) : "policies";
    return { page: "home", ws: null, tab: "admin", section, query: Object.fromEntries(new URLSearchParams(admin[2] ?? "")) };
  }
  const path = (hash.replace(/^#/, "") || "/").replace(/\/+$/, "") || "/";
  if (path === "/") return { page: "home", ws: null, tab: "overview" };
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  let m = /^\/w\/([^/]+)(?:\/(settings))?$/.exec(path);
  if (m) return { page: "home", ws: dec(m[1]), tab: m[2] ? "settings" : "overview" };
  m = /^\/w\/([^/]+)\/nb\/([^/]+)(\/report|\/view)?$/.exec(path);
  if (m) return { page: m[3] === "/view" ? "view" : m[3] ? "report" : "notebook", id: `${dec(m[1])}/${dec(m[2])}` };
  m = /^\/nb\/([^/]+)(\/report)?$/.exec(path);
  if (m) return { page: "legacy", to: nbHref(`default/${dec(m[1])}`, !!m[2]) };
  return null;
}
