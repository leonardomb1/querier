// HTTP + WebSocket server. Files are edited over REST; runs, outputs and
// completion travel over one WebSocket per notebook, as frames (protocol.ts).
//   bun server/app.ts [--port 3000] [--notebooks ./notebooks]

import { join, resolve } from "node:path";
import { Host, type Client } from "./host";
import { FirecrackerRunner } from "./runner/firecracker";
import { LocalRunner } from "./runner/local";
import type { Runner } from "./runner/types";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Git } from "./git";
import { Access } from "./mcp/access";
import { buildTemplate, templateVersion } from "./template";
import { mcpServer, type Ctx } from "./mcp/server";
import { Secrets, type Scope } from "./secrets";
import { NotFound, Store, UserError } from "./store";

const arg = (flag: string, fallback: string) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const port = Number(arg("--port", process.env.PORT ?? "3000"));
const store = new Store(arg("--notebooks", process.env.QUERIER_NOTEBOOKS ?? "notebooks"));
// QUERIER_RUNNER=firecracker (the Docker image) runs each session in a microVM;
// the default runs kernels as local processes, for development
const runner: Runner = process.env.QUERIER_RUNNER === "firecracker" ? new FirecrackerRunner() : new LocalRunner();
const secrets = new Secrets();
const access = new Access();
const dist = resolve(import.meta.dir, "../web/dist");

const hosts = new Map<string, Host>();
const host = (nb: string) => {
  store.dir(nb); // validates the name
  let h = hosts.get(nb);
  if (!h) hosts.set(nb, (h = new Host(nb, store, runner, secrets)));
  return h;
};
const changed = (nb: string) => {
  const h = hosts.get(nb);
  h?.broadcast({ type: "notebook" });
  h?.analyzeSoon();
};

const gitOf = (nb: string) => new Git(store.dir(nb), () => secrets.env(nb));

/** A notebook name from the path, checked (store.dir throws on a bad one). */
const nbParam = (r: { params: Record<string, string> }) => (store.dir(r.params.nb), r.params.nb);
const scopeOf = (s: unknown): Scope => (s === "global" ? "global" : "notebook");

/** A global change reaches every open notebook; a notebook one only its own. */
async function secretsChanged(nb: string | null) {
  await Promise.all([...hosts.values()].filter((h) => nb == null || h.nb === nb).map((h) => h.secretsChanged()));
}

// AI clients over MCP (mcp/): each request its own stateless server
const mcpCtx: Ctx = {
  store,
  access,
  host,
  changed,
};

async function mcp(req: Request, srv: { timeout(req: Request, seconds: number): void }) {
  // a web page must not drive it from someone's browser (DNS rebinding): no Origin, or this server's own
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return new Response("Forbidden origin", { status: 403 });
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  const client = token ? await access.verify(token) : null;
  if (!client) {
    const message = "Querier needs a client token: make one in Querier (palette → AI clients) and send it as `Authorization: Bearer <token>`.";
    return Response.json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }, { status: 401 });
  }
  srv.timeout(req, 0); // runs may take minutes
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = mcpServer(mcpCtx, client);
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    server.close().catch(() => {});
  }
}

/** A request that changes something must come from Querier's own pages: not
 *  another site open in the browser, nor a report template's sandboxed frame
 *  (whose origin is "null"). There are no logins to lean on. */
function foreign(req: Request): boolean {
  if (req.method === "GET" || req.method === "HEAD") return false;
  const origin = req.headers.get("origin");
  return origin != null && origin !== new URL(req.url).origin;
}

/** JSON in, JSON out, errors as { error } with a status. */
const api =
  (fn: (req: Request & { params: Record<string, string> }, body: any) => Promise<unknown>) =>
  async (req: Request & { params: Record<string, string> }) => {
    if (foreign(req)) return Response.json({ error: "Requests that change things must come from Querier's own pages." }, { status: 403 });
    try {
      const body = req.method === "GET" || req.method === "DELETE" ? undefined : await req.json().catch(() => ({}));
      return Response.json((await fn(req, body)) ?? { ok: true });
    } catch (e: any) {
      const status = e instanceof NotFound ? 404 : e instanceof UserError ? 400 : 500;
      if (status === 500) console.error(e);
      return Response.json({ error: e.message }, { status });
    }
  };

const server = Bun.serve<{ nb: string }, any>({
  port,
  routes: {
    "/api/notebooks": {
      GET: api(async () => ({ root: store.root, notebooks: await store.list() })),
      POST: api(async (_, b) => store.create(b.name, b.title)),
    },
    "/api/notebooks/:nb": {
      GET: api((r) => store.load(r.params.nb)),
      PATCH: api(async (r, b) => {
        await store.settings(r.params.nb, b);
        changed(r.params.nb);
      }),
    },
    "/api/notebooks/:nb/cells": {
      POST: api(async (r, b) => {
        const name = await store.add(r.params.nb, b.lang, b.after ?? null, b.source ?? "");
        changed(r.params.nb);
        return { name };
      }),
    },
    "/api/notebooks/:nb/cells/:cell": {
      PUT: api(async (r, b) => {
        await store.save(r.params.nb, r.params.cell, b.source);
        hosts.get(r.params.nb)?.analyzeSoon();
      }),
      PATCH: api(async (r, b) => {
        const { nb, cell } = r.params;
        let updated: string[] = [];
        if (b.name && b.name !== cell) {
          updated = await store.rename(nb, cell, b.name);
          await hosts.get(nb)?.renamed(cell, b.name);
        }
        if (b.lang) await store.setLang(nb, b.name ?? cell, b.lang);
        if (b.move) await store.move(nb, b.name ?? cell, b.move);
        changed(nb);
        return { updated };
      }),
      DELETE: api(async (r) => {
        await store.remove(r.params.nb, r.params.cell);
        await hosts.get(r.params.nb)?.removed(r.params.cell);
        changed(r.params.nb);
      }),
    },
    // the report as a Svelte template (server/template.ts): its source, and the bundle its frame runs
    "/api/notebooks/:nb/template": {
      GET: api(async (r) => {
        const source = await store.template(nbParam(r));
        if (source == null) return { source: null };
        const built = await buildTemplate(source);
        return { source, version: await templateVersion(source), error: built.error ?? null };
      }),
      PUT: api(async (r, b) => {
        const nb = nbParam(r);
        const source = String(b.source ?? "");
        await store.saveTemplate(nb, source);
        changed(nb);
        const built = await buildTemplate(source);
        return { version: await templateVersion(source), error: built.error ?? null };
      }),
      DELETE: api(async (r) => {
        const nb = nbParam(r);
        await store.removeTemplate(nb);
        changed(nb);
      }),
    },
    "/api/notebooks/:nb/template.js": {
      GET: async (r) => {
        try {
          const source = await store.template(nbParam(r));
          if (source == null) return new Response("no template", { status: 404 });
          const built = await buildTemplate(source);
          if (built.error) return Response.json(built, { status: 422 });
          // named by version (?v=): the same URL never changes content
          return new Response(built.js, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable" } });
        } catch (e: any) {
          return Response.json({ error: { message: e.message } }, { status: e instanceof UserError ? 400 : 500 });
        }
      },
    },
    // a cell's result in full, from the kernel: ?format=parquet (default) or csv
    "/api/notebooks/:nb/cells/:cell/export": {
      GET: async (r) => {
        const { nb, cell } = r.params;
        const format = new URL(r.url).searchParams.get("format") === "csv" ? "csv" : "parquet";
        try {
          store.dir(nb);
          const chunks = await host(nb).export(cell, format);
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
    // names only, never values; a notebook secret wins over a global one
    "/api/notebooks/:nb/secrets": {
      GET: api(async (r) => ({ file: secrets.file, secrets: await secrets.list(nbParam(r)) })),
    },
    "/api/notebooks/:nb/secrets/:name": {
      PUT: api(async (r, b) => {
        await secrets.set(nbParam(r), scopeOf(b.scope), r.params.name, String(b.value ?? ""));
        await secretsChanged(b.scope === "global" ? null : r.params.nb);
      }),
      DELETE: api(async (r) => {
        const scope = scopeOf(new URL(r.url).searchParams.get("scope"));
        await secrets.remove(nbParam(r), scope, r.params.name);
        await secretsChanged(scope === "global" ? null : r.params.nb);
      }),
    },
    // git: each notebook folder may be its own repository, opted into per notebook
    "/api/notebooks/:nb/git": {
      GET: api(async (r) => {
        const nb = nbParam(r);
        return { ...(await gitOf(nb).status()), declined: (await store.readSettings(nb)).git === false };
      }),
    },
    "/api/notebooks/:nb/git/init": {
      POST: api(async (r, b) => {
        const nb = nbParam(r);
        await gitOf(nb).init({ name: b.name, email: b.email }, b.remote || undefined);
        // clear an earlier "don't ask" (only then: rewriting notebook.json would be a change)
        if ((await store.readSettings(nb)).git === false) await store.settings(nb, { git: null });
      }),
    },
    "/api/notebooks/:nb/git/decline": { POST: api(async (r) => store.settings(nbParam(r), { git: false })) },
    "/api/notebooks/:nb/git/commit": { POST: api(async (r, b) => gitOf(nbParam(r)).commit(String(b.message ?? ""))) },
    "/api/notebooks/:nb/git/restore": {
      POST: api(async (r, b) => {
        const nb = nbParam(r);
        await gitOf(nb).restore(b.rev ?? "HEAD", b.cells);
        changed(nb); // git rewrote files: every tab reloads them
      }),
    },
    "/api/notebooks/:nb/git/log": { GET: api(async (r) => gitOf(nbParam(r)).log(300)) },
    "/api/notebooks/:nb/git/commits/:rev": { GET: api(async (r) => gitOf(nbParam(r)).show(r.params.rev)) },
    "/api/notebooks/:nb/git/branches": {
      GET: api(async (r) => gitOf(nbParam(r)).branches()),
      POST: api(async (r, b) => gitOf(nbParam(r)).createBranch(String(b.name ?? ""))),
    },
    "/api/notebooks/:nb/git/switch": {
      POST: api(async (r, b) => {
        const nb = nbParam(r);
        await gitOf(nb).switchBranch(String(b.name ?? ""));
        changed(nb); // git rewrote files: every tab reloads them
      }),
    },
    "/api/notebooks/:nb/git/remote": { POST: api(async (r, b) => gitOf(nbParam(r)).setRemote(String(b.url ?? "").trim())) },
    "/api/notebooks/:nb/git/fetch": { POST: api(async (r) => gitOf(nbParam(r)).fetch()) },
    "/api/notebooks/:nb/git/pull": {
      POST: api(async (r, b) => {
        const nb = nbParam(r);
        await gitOf(nb).pull(!!b.rebase);
        changed(nb); // git rewrote files: every tab reloads them
      }),
    },
    "/api/notebooks/:nb/git/push": { POST: api(async (r) => gitOf(nbParam(r)).push()) },
    "/mcp": mcp,
    // AI clients: tokens (shown once), and each notebook's access level
    "/api/ai/clients": {
      GET: api(async () => ({ file: access.file, clients: await access.clients() })),
      POST: api(async (_, b) => access.create(String(b.name ?? ""))),
    },
    "/api/ai/clients/:id": { DELETE: api(async (r) => access.revoke(r.params.id)) },
    "/api/notebooks/:nb/ai": {
      GET: api(async (r) => ({ level: await access.level(nbParam(r)) })),
      PUT: api(async (r, b) => access.setLevel(nbParam(r), b.level)),
    },
    "/ws/:nb": (req, srv) => {
      const nb = (req as any).params.nb;
      // a socket runs cells: only Querier's own pages open one (browsers always send Origin here)
      const origin = req.headers.get("origin");
      if (origin && origin !== new URL(req.url).origin) return new Response("Forbidden origin", { status: 403 });
      try {
        store.dir(nb);
      } catch {
        return new Response("bad notebook", { status: 400 });
      }
      return srv.upgrade(req, { data: { nb } }) ? undefined : new Response("upgrade failed", { status: 400 });
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
      host(ws.data.nb).attach(ws);
    },
    close(ws: Client) {
      hosts.get(ws.data.nb)?.detach(ws);
    },
    async message(ws: Client, raw) {
      const h = host(ws.data.nb);
      const msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
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
