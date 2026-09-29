// The decision point every entry point asks (HTTP routes, the kernel socket's
// messages, AI clients' tools): the policy engine with the notebook world
// around it (a workspace's and a notebook's attributes, the grants, the custom
// policy files), and denials written to the audit log.

import { readdir, mkdir, rm } from "node:fs/promises";
import { UserError } from "../store";
import { join } from "node:path";
import { watch } from "node:fs";
import type { Store } from "../store";
import type { Audit } from "./audit";
import { configDir } from "./config";
import type { Grants, NotebookAttributes } from "./grants";
import { PolicyEngine, type Action, type Resource } from "./policy";
import type { Principal } from "./principal";

export const policiesDir = () => process.env.QUERIER_POLICIES ?? join(configDir, "policies");

/** A policy file's name: letters, digits, - and _, then .cedar (added if left out). */
export function policyFile(name: string): string {
  const base = name.trim().replace(/\.cedar$/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(base)) throw new UserError("A policy file's name: letters, digits, - and _ (up to 64).");
  return `${base}.cedar`;
}

/** A workspace's attributes ({ team: "finance" }) as tags ({ team: ["finance"] }). */
const asTags = (a: Record<string, string> | undefined) => Object.fromEntries(Object.entries(a ?? {}).map(([k, v]) => [k, [v]]));

export class Authz {
  readonly engine = new PolicyEngine();

  constructor(
    private store: Store,
    readonly grants: Grants,
    readonly notebookAttrs: NotebookAttributes,
    private audit: Audit,
  ) {
    this.reloadGrants();
  }

  reloadGrants() {
    const problems = this.engine.setGrants(this.grants.all());
    for (const p of problems) console.error(`policy: grant left out: ${p.policy}: ${p.message}`);
  }

  /** The custom policies: every .cedar file in the policies folder. A bad set keeps the last valid one in force. */
  async reloadCustom(): Promise<{ file: string; message: string }[]> {
    const dir = policiesDir();
    await mkdir(dir, { recursive: true });
    const files: Record<string, string> = {};
    for (const f of (await readdir(dir)).filter((f) => f.endsWith(".cedar")).sort()) files[f] = await Bun.file(join(dir, f)).text();
    const problems = this.engine.setCustom(files);
    for (const p of problems) console.error(`policy: ${p.policy}: ${p.message}`);
    return problems.map((p) => ({ file: p.policy, message: p.message }));
  }

  /** The custom policy files, as they are on disk. */
  async customFiles(): Promise<{ name: string; text: string }[]> {
    const dir = policiesDir();
    await mkdir(dir, { recursive: true });
    const out = [];
    for (const name of (await readdir(dir)).filter((f) => f.endsWith(".cedar")).sort()) out.push({ name, text: await Bun.file(join(dir, name)).text() });
    return out;
  }

  /** Write a policy file (checked first: one with errors isn't written) and put it in force. */
  async saveCustom(name: string, text: string) {
    const file = policyFile(name);
    const errors = this.engine.checkFile(text).filter((p) => !p.warning);
    if (errors.length) throw new UserError(`${file} has ${errors.length === 1 ? "a problem" : `${errors.length} problems`}: ${errors[0].message}`);
    const path = join(policiesDir(), file);
    const before = (await Bun.file(path).exists()) ? await Bun.file(path).text() : null;
    await mkdir(policiesDir(), { recursive: true });
    await Bun.write(path, text.endsWith("\n") || !text ? text : `${text}\n`);
    const problems = await this.reloadCustom();
    if (problems.length) {
      // together with the others it doesn't hold: put back what was there
      if (before == null) await rm(path, { force: true });
      else await Bun.write(path, before);
      await this.reloadCustom();
      throw new UserError(`The policies together don't validate: ${problems[0].file}: ${problems[0].message}`);
    }
    return file;
  }

  async removeCustom(name: string) {
    await rm(join(policiesDir(), policyFile(name)), { force: true });
    await this.reloadCustom();
  }

  /** Reload the custom policies whenever their folder changes (an edit, a git pull). */
  watchCustom() {
    let timer: ReturnType<typeof setTimeout>;
    try {
      watch(policiesDir(), () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.reloadCustom().catch((e) => console.error("policy:", e)), 200);
      });
    } catch (e: any) {
      console.error(`policy: not watching ${policiesDir()}: ${e.message}`);
    }
  }

  // -- resources, with what policies read of them

  tenant(): Resource {
    return { type: "Tenant", id: "querier" };
  }
  async workspace(ws: string): Promise<Resource> {
    const s = await this.store.readWorkspace(ws).catch(() => ({}) as { attributes?: Record<string, string> });
    return { type: "Workspace", id: ws, attrs: asTags(s.attributes) };
  }
  /** A connection: in its workspace (a workspace's roles reach it), or everyone's. */
  async connection(c: { id: string; workspace?: string }): Promise<Resource> {
    return { type: "Connection", id: c.id, workspace: c.workspace, workspaceAttrs: c.workspace ? (await this.workspace(c.workspace)).attrs : undefined };
  }
  async notebook(id: string): Promise<Resource> {
    const ws = id.slice(0, id.indexOf("/"));
    const w = await this.workspace(ws);
    return { type: "Notebook", id, attrs: asTags(this.notebookAttrs.get(id)), workspaceAttrs: w.attrs };
  }

  // -- decisions

  /** May `p` do `action` to `r`? A denial is audited (not a list's quiet filtering: `quiet`). */
  can(p: Principal, action: Action, r: Resource, quiet = false): boolean {
    const d = this.engine.decide(p, action, r);
    if (!d.allow && !quiet) this.audit.log({ actor: p.id, action, resource: `${r.type}:${r.id}`, decision: "deny", detail: d.errors.length ? { errors: d.errors } : undefined });
    return d.allow;
  }

  allowed(p: Principal, r: Resource): Action[] {
    return this.engine.allowed(p, r);
  }

  explain(p: Principal, action: Action, r: Resource) {
    return this.engine.decide(p, action, r);
  }
}
