// Environments, built for real (uv and bun, from PyPI and npm): the folder's files, what is in force,
// "changed since applied", and packages the local kernel's Python imports.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../server/auth/db";
import { checkDependency, Environments } from "../server/environments";

const python = resolve(import.meta.dir, "../.venv/bin/python");

async function settle(envs: Environments, dir: string, target: string, kind: "python" | "js") {
  for (let i = 0; i < 600; i++) {
    const s = await envs.state(dir, target, kind);
    if (s.status !== "building") return s;
    await Bun.sleep(200);
  }
  throw new Error("still building");
}

test("dependencies: names and versions from the index; no URLs, paths or git", () => {
  for (const ok of ["pyarrow", "pyarrow>=17", "scikit-learn==1.5.2", "requests[socks]>=2,<3"]) expect(checkDependency("python", ok)).toBe(ok);
  for (const bad of ["git+https://x/y", "./local", "foo @ https://evil/x.whl", "-e ."]) expect(() => checkDependency("python", bad)).toThrow("isn't a package");
  for (const ok of ["d3", "d3@^7", "@observablehq/plot@0.6"]) expect(checkDependency("js", ok)).toBe(ok);
  for (const bad of ["github:x/y", "file:../x", "x@git+https://y"]) expect(() => checkDependency("js", bad)).toThrow("isn't a package");
});

test("python: locked into the folder, built, in force; the folder changing shows; nothing left: gone", async () => {
  const root = await mkdtemp(join(tmpdir(), "querier-env-"));
  const dir = join(root, "ws");
  await Bun.write(join(dir, ".keep"), "");
  const envs = new Environments(openDb(":memory:"), { root: join(root, "envs"), images: false, python });
  envs.apply(dir, "ws:w", "python", ["tabulate"], "corp:ana");
  expect((await envs.state(dir, "ws:w", "python")).status).toBe("building");
  const s = await settle(envs, dir, "ws:w", "python");
  expect(s).toMatchObject({ status: "ready", dependencies: ["tabulate"], changed: false, applied: { dependencies: ["tabulate"], by: "corp:ana" } });
  const built = envs.python(s.applied!.hash)!;
  const p = Bun.spawnSync([python, "-c", "import tabulate; print(tabulate.__name__)"], { env: { ...process.env, PYTHONPATH: built.dir } });
  expect(p.stdout.toString().trim()).toBe("tabulate");
  // someone edits the folder (a pull): it shows, and nothing changes until applied
  await Bun.write(join(dir, "uv.lock"), (await Bun.file(join(dir, "uv.lock")).text()) + "\n# edited\n");
  expect((await envs.state(dir, "ws:w", "python")).changed).toBe(true);
  // a package that doesn't exist: failed, with why; what was in force stays
  envs.apply(dir, "ws:w", "python", ["this-package-does-not-exist-querier"], "corp:ana");
  const failed = await settle(envs, dir, "ws:w", "python");
  expect(failed.status).toBe("failed");
  expect(failed.log).toContain("this-package-does-not-exist-querier");
  expect(failed.applied?.hash).toBe(s.applied!.hash);
  envs.apply(dir, "ws:w", "python", [], "corp:ana");
  expect((await settle(envs, dir, "ws:w", "python")).status).toBe("none");
  expect(await Bun.file(join(dir, "pyproject.toml")).exists()).toBe(false);
  await rm(root, { recursive: true, force: true });
}, 180_000);

test("js: package.json and bun.lock in the folder; node_modules built apart, install scripts off", async () => {
  const root = await mkdtemp(join(tmpdir(), "querier-env-"));
  const dir = join(root, "ws");
  await Bun.write(join(dir, ".keep"), "");
  const envs = new Environments(openDb(":memory:"), { root: join(root, "envs"), images: false, python });
  envs.apply(dir, "ws:w", "js", ["ms@^2"], "corp:ana");
  const s = await settle(envs, dir, "ws:w", "js");
  expect(s).toMatchObject({ status: "ready", dependencies: ["ms@^2"], changed: false });
  expect(await Bun.file(join(dir, "bun.lock")).exists()).toBe(true);
  expect(await Bun.file(join(dir, "node_modules/ms/package.json")).exists()).toBe(false); // not in the folder
  const nm = envs.js(s.applied!.hash)!;
  expect(await Bun.file(join(nm, "node_modules/ms/package.json")).exists()).toBe(true);
  await rm(root, { recursive: true, force: true });
}, 180_000);
