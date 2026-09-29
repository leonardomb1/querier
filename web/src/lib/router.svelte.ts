// Hash routes, loaded before they are shown. The page you are on stays up
// (dimmed, with a spinner after a moment) while the next one's data loads,
// then the two cross-fade through the View Transitions API.

import { flushSync } from "svelte";
import { api, ApiError, type Notebook, type NotebookIndex } from "./api";

export type Route =
  | { page: "list"; index: NotebookIndex }
  | { page: "notebook"; name: string; book: Notebook }
  | { page: "report"; name: string; book: Notebook }
  | { page: "error"; status: number; title: string; message: string; retry: boolean };

function parse(hash: string): { page: "list" } | { page: "notebook" | "report"; name: string } | null {
  const path = hash.replace(/^#/, "") || "/";
  if (path === "/") return { page: "list" };
  const r = /^\/nb\/([^/]+)\/report\/?$/.exec(path);
  if (r) return { page: "report", name: decodeURIComponent(r[1]) };
  const m = /^\/nb\/([^/]+)\/?$/.exec(path);
  return m ? { page: "notebook", name: decodeURIComponent(m[1]) } : null;
}

function failure(e: unknown, what: string): Route {
  const status = e instanceof ApiError ? e.status : 500;
  const message = e instanceof Error ? e.message : String(e);
  if (status === 404) return { page: "error", status, title: `${what} doesn't exist`, message, retry: false };
  if (status === 0) return { page: "error", status, title: "Can't reach the server", message: "Is `bun run start` still running?", retry: true };
  return { page: "error", status, title: "Something went wrong", message, retry: true };
}

async function load(hash: string): Promise<Route> {
  const where = parse(hash);
  if (!where) return { page: "error", status: 404, title: "Nothing here", message: `No page at ${hash}.`, retry: false };
  try {
    if (where.page === "list") return { page: "list", index: await api.list() };
    return { page: where.page, name: where.name, book: await api.load(where.name) };
  } catch (e) {
    return failure(e, where.page === "list" ? "That page" : `Notebook “${where.name}”`);
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
    const timer = setTimeout(() => seq === this.seq && (this.slow = true), 150);
    const next = await load(location.hash);
    clearTimeout(timer);
    if (seq !== this.seq) return; // a newer navigation won
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
