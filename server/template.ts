// A notebook's report template (report.svelte in its folder), compiled with
// Svelte and bundled with the runtime it imports as "querier"
// (web/src/template/) into one script for a sandboxed frame.
//
// The template is the notebook author's code and runs only in the viewer's
// browser, inside a frame with no access to Querier's page or origin. Here it
// is only compiled and bundled — nothing of it runs on the server — and so it
// may import nothing but "svelte" and "querier": no packages, no files, and no
// import attributes (Bun runs a `with { type: "macro" }` import at bundle time).

import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compile, compileModule } from "svelte/compiler";

const WEB = resolve(import.meta.dir, "../web/src");
const RUNTIME = join(WEB, "template");
const CACHE = resolve(import.meta.dir, "../.cache/templates");

export interface TemplateError {
  message: string;
  line?: number;
  col?: number;
}

export type Built = { js: string; error?: undefined } | { js?: undefined; error: TemplateError };

/** Everything the bundle is made of, so a change to the runtime rebuilds templates. */
let runtimeHash: Promise<string> | undefined;
async function runtimeVersion(): Promise<string> {
  runtimeHash ??= (async () => {
    const h = new Bun.CryptoHasher("sha1");
    const walk = async (dir: string) => {
      for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (/\.(ts|svelte|css)$/.test(e.name)) h.update(await Bun.file(p).text());
      }
    };
    await walk(WEB);
    return h.digest("hex").slice(0, 12);
  })();
  return runtimeHash;
}

/** The version a template's bundle has: its source and the runtime's. */
export async function templateVersion(source: string): Promise<string> {
  return new Bun.CryptoHasher("sha1").update(source).update(await runtimeVersion()).digest("hex").slice(0, 16);
}

const ALLOWED = /^(svelte(\/.*)?|querier)$/;

/** What the compiled template imports, if it is anything but svelte and querier. */
function forbidden(js: string): string | null {
  if (/\bimport\s*\(/.test(js)) return "a template can't import at run time (import())";
  for (const m of js.matchAll(/\b(?:import|export)\b[^;'"]*?\bfrom\s*(['"])([^'"]+)\1\s*(with|assert)?/g)) {
    if (m[3]) return `a template can't use import attributes (${m[3]} { ... })`;
    if (!ALLOWED.test(m[2])) return `a template may import only "svelte" and "querier", not "${m[2]}"`;
  }
  for (const m of js.matchAll(/\bimport\s*(['"])([^'"]+)\1/g)) if (!ALLOWED.test(m[2])) return `a template may import only "svelte" and "querier", not "${m[2]}"`;
  return null;
}

const svelte = {
  name: "svelte",
  setup(b: any) {
    b.onResolve({ filter: /^querier$/ }, () => ({ path: join(RUNTIME, "index.ts") }));
    b.onLoad({ filter: /\.svelte$/ }, async ({ path }: { path: string }) => ({
      contents: compile(await Bun.file(path).text(), { filename: path, generate: "client", css: "injected" }).js.code,
      loader: "js",
    }));
    // runes modules (zoom.svelte.ts): types off first, then Svelte's module compiler
    b.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }: { path: string }) => ({
      contents: compileModule(new Bun.Transpiler({ loader: "ts" }).transformSync(await Bun.file(path).text()), { filename: path, generate: "client" }).js.code,
      loader: "js",
    }));
  },
};

const built = new Map<string, Promise<Built>>();

export function buildTemplate(source: string): Promise<Built> {
  return templateVersion(source).then((v) => {
    let p = built.get(v);
    if (!p) {
      p = build(source, v);
      built.set(v, p);
      if (built.size > 50) built.delete(built.keys().next().value!);
    }
    return p;
  });
}

async function build(source: string, version: string): Promise<Built> {
  let js: string;
  try {
    js = compile(source, { filename: "report.svelte", generate: "client", css: "injected" }).js.code;
  } catch (e: any) {
    return { error: { message: e.message?.split("\n")[0] ?? String(e), line: e.start?.line, col: e.start?.column != null ? e.start.column + 1 : undefined } };
  }
  const no = forbidden(js);
  if (no) return { error: { message: no } };

  // bundled from inside the project, where "svelte" resolves
  const dir = join(CACHE, version);
  await mkdir(dir, { recursive: true });
  try {
    await Bun.write(join(dir, "report.js"), js);
    await Bun.write(
      join(dir, "entry.ts"),
      `import { mount } from "svelte";\nimport Report from "./report.js";\nimport { start } from ${JSON.stringify(join(RUNTIME, "runtime.svelte.ts"))};\nstart((target, props) => mount(Report, { target, props }));\n`,
    );
    const out = await Bun.build({ entrypoints: [join(dir, "entry.ts")], format: "iife", target: "browser", minify: true, plugins: [svelte] });
    if (!out.success) return { error: { message: out.logs.map(String).join("\n").split("\n")[0] || "the template didn't build" } };
    return { js: await out.outputs[0].text() };
  } catch (e: any) {
    return { error: { message: String(e?.message ?? e).split("\n")[0] } };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
