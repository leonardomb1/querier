// Hash routes, loaded before they are shown. The page you are on stays up
// (with a progress line along the top after a moment) while the next one's data loads,
// then the two cross-fade through the View Transitions API.

import { flushSync } from "svelte";
import { api, ApiError, loginHref, type Notebook, type SignIn, type WorkspaceIndex } from "./api";
import { parse, type AdminSection } from "./href";
import { session } from "./session.svelte";

export type Route =
  /** the workspaces, one of them open (its overview or its settings), or none */
  | { page: "home"; index: WorkspaceIndex; ws: string | null; tab: "overview" | "settings" | "admin"; section?: AdminSection; query?: Record<string, string> }
  | { page: "notebook"; name: string; book: Notebook }
  | { page: "report"; name: string; book: Notebook }
  /** a published report, as its viewers get it */
  | { page: "view"; name: string; book: Notebook }
  | { page: "login"; providers: SignIn[]; next: string; error: string; insecure: boolean }
  /** a public link's report (/p/<token>): nobody signs in */
  | { page: "public"; token: string }
  | { page: "error"; status: number; title: string; message: string; retry: boolean };

function failure(e: unknown, what: string): Route {
  const status = e instanceof ApiError ? e.status : 500;
  const message = e instanceof Error ? e.message : String(e);
  if (status === 404) return { page: "error", status, title: `${what} doesn't exist`, message, retry: false };
  if (status === 0) return { page: "error", status, title: "Can't reach the server", message: "Is `bun run start` still running?", retry: true };
  if (status === 403) return { page: "error", status, title: "You don't have access", message: `${message} Ask its workspace's Admin or Member, or whoever shared it, for access.`, retry: true };
  return { page: "error", status, title: "Something went wrong", message, retry: true };
}

async function load(hash: string): Promise<Route | null> {
  // a public link is its own address, not a route of the app: no session, no sign-in
  const pub = /^\/p\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname);
  if (pub) return { page: "public", token: pub[1] };
  const where = parse(hash);
  if (!where) return { page: "error", status: 404, title: "Nothing here", message: `No page at ${hash}.`, retry: false };
  if (where.page === "legacy") {
    location.replace(where.to); // its hashchange loads it
    return null;
  }
  if (where.page === "login") {
    // signed in already: straight on
    if (!where.error && (await session.load())) {
      location.replace(where.next);
      return null;
    }
    try {
      const { providers, httpAllowed } = await api.auth.providers();
      // plain HTTP, not this machine: passwords are refused, unless the server opted out (QUERIER_ALLOW_HTTP)
      const plain = location.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
      return { ...where, providers, insecure: plain && !httpAllowed };
    } catch (e) {
      return failure(e, "The login page");
    }
  }
  // who is it: not signed in, to the login page and back
  if (!session.me && !(await session.load())) {
    location.replace(loginHref(hash));
    return null;
  }
  try {
    if (where.page === "home") {
      const index = await api.workspaces();
      if (where.ws != null && !index.workspaces.some((w) => w.name === where.ws))
        return { page: "error", status: 404, title: `Workspace “${where.ws}” doesn't exist`, message: "It may have been renamed or deleted.", retry: false };
      return { ...where, index };
    }
    if (where.page === "view") return { page: "view", name: where.id, book: await api.report.get(where.id) };
    // the report, for someone who may view it but not run the notebook: its published version
    if (where.page === "report") {
      const book = await api.load(where.id).catch((e) => {
        if (e instanceof ApiError && e.status === 403) return null;
        throw e;
      });
      if (!book || (!book.permissions.includes("notebook.run") && book.published)) return { page: "view", name: where.id, book: await api.report.get(where.id) };
      return { page: "report", name: where.id, book };
    }
    return { page: where.page, name: where.id, book: await api.load(where.id) };
  } catch (e) {
    // the session ended meanwhile: api.ts is taking the browser to the login page
    if (e instanceof ApiError && e.status === 401) return null;
    return failure(e, where.page === "home" ? "That page" : where.page === "view" ? `The report of “${where.id}”` : `Notebook “${where.id}”`);
  }
}

export class Router {
  route = $state<Route | null>(null);
  /** A navigation is in flight; `slow` once it has taken long enough to show. */
  loading = $state(false);
  slow = $state(false);

  private seq = 0;

  constructor() {
    addEventListener("hashchange", () => this.go());
    this.go();
  }

  async go() {
    const seq = ++this.seq;
    this.loading = true;
    const timer = setTimeout(() => seq === this.seq && (this.slow = true), 300);
    const next = await load(location.hash);
    clearTimeout(timer);
    if (seq !== this.seq || !next) return; // a newer navigation won, or this one redirected
    const swap = () => {
      this.route = next;
      this.loading = false;
      this.slow = false;
    };
    const first = this.route === null;
    if (first || !document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return swap();
    document.startViewTransition(() => flushSync(swap));
  }

  retry = () => this.go();
}
