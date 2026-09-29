import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRunner } from "../server/runner/local";
import { redactor, Secrets } from "../server/secrets";

test("secrets: owner-only file, names without values, a notebook's own win", async () => {
  const dir = await mkdtemp(join(tmpdir(), "querier-secrets-"));
  const s = new Secrets(join(dir, "conf/secrets.json"));
  await s.set("sales", "global", "SR_USER", "machado");
  await s.set("sales", "global", "SR_PASS", "global-pass");
  await s.set("sales", "notebook", "SR_PASS", "sales-pass");
  await s.set("other", "notebook", "OTHER_TOKEN", "tok-123");

  expect(((await stat(s.file)).mode & 0o777).toString(8)).toBe("600");
  const listed = await s.list("sales");
  expect(listed.map(({ name, scope, shadowed }) => [name, scope, shadowed ?? false])).toEqual([
    ["SR_PASS", "notebook", false],
    ["SR_PASS", "global", true],
    ["SR_USER", "global", false],
  ]);
  expect(JSON.stringify(listed)).not.toContain("pass\""); // no values in a listing
  expect(await s.env("sales")).toEqual({ SR_USER: "machado", SR_PASS: "sales-pass" });
  expect(await s.env("other")).toEqual({ SR_USER: "machado", SR_PASS: "global-pass", OTHER_TOKEN: "tok-123" });

  await s.remove("sales", "notebook", "SR_PASS");
  expect((await s.env("sales")).SR_PASS).toBe("global-pass");
  expect(s.set("sales", "global", "1BAD", "x")).rejects.toThrow("environment variable name");
  await rm(dir, { recursive: true });
});

test("redaction masks whole values, longest first, and leaves short ones", () => {
  const r = redactor(["hunter2", "hunter2-admin", "no"]);
  expect(r("login hunter2-admin failed, then hunter2")).toBe("login •••••• failed, then ••••••");
  expect(r("no change")).toBe("no change");
});

test("a kernel sees its secrets as environment variables", async () => {
  const s = await new LocalRunner().open({ notebookDir: tmpdir(), env: { QUERIER_TEST_SECRET: "s3cret-value" } });
  try {
    const evs = [];
    for await (const ev of s.run({ name: "env", lang: "python", source: "import os\nos.environ['QUERIER_TEST_SECRET']" })) evs.push(ev);
    const shown = evs.find((e) => e.type === "display");
    expect(shown && new TextDecoder().decode((shown as any).data)).toBe("'s3cret-value'");
  } finally {
    await s.close();
  }
});
