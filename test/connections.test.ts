import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connections, redactor } from "../server/connections";
import { LocalRunner } from "../server/runner/local";

const all = () => true;

test("connections: an owner-only file; shared values, each person's own, the workspace's over everyone's", async () => {
  const dir = await mkdtemp(join(tmpdir(), "querier-conn-"));
  const cs = new Connections(join(dir, "conf/connections.json"));
  const sr = await cs.create({ name: "sr", variables: ["SR_USER", "SR_PASS"], credentials: "shared" }, "root");
  await cs.setValues(sr.id, { SR_USER: "svc", SR_PASS: "shared-pass" });
  const gh = await cs.create({ name: "github", workspace: "sales", variables: ["GIT_TOKEN"], credentials: "per-user" }, "root");
  await cs.setValues(gh.id, { GIT_TOKEN: "ana-token" }, "corp:ana");
  // the workspace's wins where a name is both
  const local = await cs.create({ name: "sr-sales", workspace: "sales", variables: ["SR_PASS"], credentials: "shared" }, "root");
  await cs.setValues(local.id, { SR_PASS: "sales-pass" });

  expect(((await stat(cs.file)).mode & 0o777).toString(8)).toBe("600");
  expect(await cs.env("sales", "corp:ana", all)).toEqual({ SR_USER: "svc", SR_PASS: "sales-pass", GIT_TOKEN: "ana-token" });
  expect(await cs.env("sales", "corp:bob", all)).toEqual({ SR_USER: "svc", SR_PASS: "sales-pass" }); // no token of his own
  expect(await cs.env("other", "corp:ana", all)).toEqual({ SR_USER: "svc", SR_PASS: "shared-pass" });
  // only what they may use
  expect(await cs.env("sales", "corp:ana", (c) => c.name !== "sr-sales")).toEqual({ SR_USER: "svc", SR_PASS: "shared-pass", GIT_TOKEN: "ana-token" });

  // what the API tells: which are set, never the values
  const info = await cs.info(gh, "corp:ana");
  expect(info.mine).toEqual(["GIT_TOKEN"]);
  expect(JSON.stringify(await cs.info(sr, "corp:ana"))).not.toContain("shared-pass");

  // the wrong kind of value, a bad name, a clash, a kernel's own variable
  expect(cs.setValues(sr.id, { SR_USER: "x" }, "corp:ana")).rejects.toThrow("shared");
  expect(cs.setValues(gh.id, { GIT_TOKEN: "x" })).rejects.toThrow("own");
  expect(cs.setValues(sr.id, { NOPE: "x" })).rejects.toThrow("no variable");
  expect(cs.create({ name: "SR", variables: ["A"], credentials: "shared" }, "root")).rejects.toThrow("already");
  expect(cs.create({ name: "x", variables: ["1BAD"], credentials: "shared" }, "root")).rejects.toThrow("environment variable name");
  expect(cs.create({ name: "x", variables: ["PATH"], credentials: "shared" }, "root")).rejects.toThrow("kernel's own");

  // fewer variables: their values go; other credentials: all values go
  await cs.update(sr.id, { variables: ["SR_USER"] });
  expect(await cs.env("other", "corp:ana", all)).toEqual({ SR_USER: "svc" });
  await cs.update(sr.id, { credentials: "per-user" });
  expect(await cs.env("other", "corp:ana", all)).toEqual({});

  // a workspace renamed: its connections follow; deleted: they go
  await cs.moveWorkspace("sales", "revenue");
  expect((await cs.inScope("revenue")).map((c) => c.name).sort()).toEqual(["github", "sr", "sr-sales"]);
  expect((await cs.moveWorkspace("revenue", null)).sort()).toEqual([gh.id, local.id].sort());
  expect((await cs.all()).map((c) => c.name)).toEqual(["sr"]);
  await rm(dir, { recursive: true });
});

test("redaction masks whole values, longest first, and leaves short ones", () => {
  const r = redactor(["hunter2", "hunter2-admin", "no"]);
  expect(r("login hunter2-admin failed, then hunter2")).toBe("login •••••• failed, then ••••••");
  expect(r("no change")).toBe("no change");
});

test("a kernel sees its connections as environment variables", async () => {
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
