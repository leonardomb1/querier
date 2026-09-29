// Secrets: named values handed to a notebook's kernel as environment variables,
// so no cell has to hold a password. basalt reads them by its own convention (a
// connection `sr` takes SR_USER / SR_PASS, or `token = env('GH_TOKEN')` in its
// OPTIONS) and Python through os.environ.
//
// They live on the server, in one owner-only file outside the notebooks folder
// (so never in git), and never travel back to a browser: the API lists names.

import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { UserError } from "./store";

export type Scope = "global" | "notebook";

interface Entry {
  value: string;
  updated: number;
}

interface File {
  global: Record<string, Entry>;
  notebooks: Record<string, Record<string, Entry>>;
}

export interface SecretInfo {
  name: string;
  scope: Scope;
  updated: number;
  /** A notebook secret of the same name wins over this one. */
  shadowed?: boolean;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class Secrets {
  readonly file: string;
  private cache?: File;

  constructor(file = process.env.QUERIER_SECRETS ?? join(homedir(), ".config/querier/secrets.json")) {
    this.file = file;
  }

  private async read(): Promise<File> {
    if (this.cache) return this.cache;
    const f = Bun.file(this.file);
    this.cache = (await f.exists()) ? await f.json() : { global: {}, notebooks: {} };
    return this.cache!;
  }

  private async write(data: File) {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await Bun.write(this.file, JSON.stringify(data, null, 2) + "\n");
    await chmod(this.file, 0o600);
    this.cache = data;
  }

  /** Names a notebook's kernel receives, without their values. */
  async list(nb: string): Promise<SecretInfo[]> {
    const data = await this.read();
    const mine = data.notebooks[nb] ?? {};
    const out: SecretInfo[] = [];
    for (const [name, e] of Object.entries(mine)) out.push({ name, scope: "notebook", updated: e.updated });
    for (const [name, e] of Object.entries(data.global)) out.push({ name, scope: "global", updated: e.updated, shadowed: name in mine });
    return out.sort((a, b) => a.name.localeCompare(b.name) || (a.scope === "notebook" ? -1 : 1));
  }

  async set(nb: string, scope: Scope, name: string, value: string) {
    if (!NAME.test(name)) throw new UserError(`\`${name}\` can't be an environment variable name: letters, digits and _, not starting with a digit.`);
    if (!value) throw new UserError("A secret needs a value.");
    const data = structuredClone(await this.read());
    const into = scope === "global" ? data.global : (data.notebooks[nb] ??= {});
    into[name] = { value, updated: Date.now() };
    await this.write(data);
  }

  async remove(nb: string, scope: Scope, name: string) {
    const data = structuredClone(await this.read());
    if (scope === "global") delete data.global[name];
    else if (data.notebooks[nb]) {
      delete data.notebooks[nb][name];
      if (!Object.keys(data.notebooks[nb]).length) delete data.notebooks[nb];
    }
    await this.write(data);
  }

  /** The environment for `nb`'s kernel: every global secret, then its own over them. */
  async env(nb: string): Promise<Record<string, string>> {
    const data = await this.read();
    const out: Record<string, string> = {};
    for (const [k, e] of Object.entries(data.global)) out[k] = e.value;
    for (const [k, e] of Object.entries(data.notebooks[nb] ?? {})) out[k] = e.value;
    return out;
  }
}

/** Replace every secret value in `text` with a mask: longest first, so a value
 *  containing another is masked whole. Values under 4 characters are left
 *  alone — masking every "1" or "yes" would garble output for no protection. */
export function redactor(values: Iterable<string>): (text: string) => string {
  const vals = [...new Set(values)].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
  if (!vals.length) return (t) => t;
  return (text) => {
    for (const v of vals) if (text.includes(v)) text = text.split(v).join("••••••");
    return text;
  };
}
