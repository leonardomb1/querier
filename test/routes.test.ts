// Every way into the server decides who may pass. Routes built with api() must
// name what they need (the type checker enforces it); the routes that aren't
// are listed here with how they check, and a new one fails this test until it
// is added (and checked). So do kernel-socket messages without a declared action.
import { expect, test } from "bun:test";
import { resolve } from "node:path";

const app = await Bun.file(resolve(import.meta.dir, "../server/app.ts")).text();

/** Routes that don't go through api(), and why that's fine. */
const RAW: Record<string, string> = {
  "/metrics": "its bearer token, or admin.manage",
  "/api/auth/providers": "public: the login page's choices",
  "/api/auth/login": "public: signing in (throttled, HTTPS only)",
  "/api/auth/oidc/:id/start": "public: signing in",
  "/api/auth/oidc/:id/callback": "public: signing in (state, nonce, browser binding)",
  "/api/auth/logout": "its own session",
  "/api/me": "its own session",
  "/api/me/password": "its own session, the sysadmin's (the current password, throttled)",
  "/api/workspaces/:ws/notebooks/:nb/template.js": "a signed token, given with notebook.readCode",
  "/api/workspaces/:ws/notebooks/:nb/cells/:cell/export": "signed in, notebook.run",
  "/mcp": "a client token; each tool checks its owner and the AI level",
  "/ws/:ws/:nb": "signed in, notebook.view; each message checked (SOCKET_NEEDS)",
  "/ws/:ws/:nb/report": "signed in, report.view, published; each message checked (REPORT_SOCKET_NEEDS)",
};

test("every route either names what it needs (api) or is a reviewed raw route", () => {
  const routes = [...app.matchAll(/^    "(\/[^"]+)": (.*)$/gm)].map((m) => ({ path: m[1], rest: m[2] }));
  expect(routes.length).toBeGreaterThan(40);
  const raw: string[] = [];
  for (const { path } of routes) {
    // the route's block: up to the next route
    const at = app.indexOf(`    "${path}": `);
    const next = app.slice(at + 1).search(/^    "\//m);
    const block = app.slice(at, next < 0 ? undefined : at + 1 + next);
    const methods = [...block.matchAll(/\b(GET|POST|PUT|PATCH|DELETE): (api\()?/g)];
    const direct = methods.some((m) => !m[2]) || !methods.length;
    if (direct) raw.push(path);
    // an api() route: its first argument is a rule
    for (const m of block.matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE): api\((\{ on: "(?:notebook|workspace|tenant)", action: "[\w.]+" \}|SELF|LIST|CUSTOM),/g)) expect(m[1]).toBeTruthy();
  }
  expect(raw.sort()).toEqual(Object.keys(RAW).sort());
});

test("every kernel-socket message has a declared action", () => {
  const needs = /const SOCKET_NEEDS = \{([^}]+)\}/.exec(app)![1];
  const declared = [...needs.matchAll(/(\w+): "([\w.]+)"/g)].map((m) => m[1]);
  const handler = app.slice(app.indexOf("async message(ws: Client, raw)"));
  const ops = [...handler.matchAll(/case "(\w+)":/g)].map((m) => m[1]);
  expect(ops.length).toBeGreaterThan(5);
  for (const op of ops) expect(declared).toContain(op);
});

test("every report-socket message has a declared action", () => {
  const needs = /const REPORT_SOCKET_NEEDS = \{([^}]+)\}/.exec(app)![1];
  const declared = [...needs.matchAll(/(\w+): "([\w.]+)"/g)].map((m) => m[1]);
  const handler = app.slice(app.indexOf("async function reportMessage("), app.indexOf("/** Open sockets by session"));
  const ops = [...handler.matchAll(/case "(\w+)":/g)].map((m) => m[1]);
  expect(ops.sort()).toEqual(declared.sort());
});
