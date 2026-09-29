// A notebook is a folder: `NN_name.{sql,py,md}` cells run in filename order,
// `notebook.json` its settings.

import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export type Lang = "sql" | "python" | "md";

export interface Cell {
  file: string;
  order: number;
  name: string;
  lang: Lang;
  source: string;
}

export interface ParamDecl {
  name: string;
  type: string;
  default?: string;
  cell: string;
}

export interface Notebook {
  name: string;
  dir: string;
  title: string;
  description?: string;
  /** The microVM it runs in: size and the network it may reach. */
  sandbox?: { vcpus?: number; memory?: number; egress?: string[] };
  /** How it reads as a report (store.ts `Report`). */
  report?: import("./store").Report;
  /** report.svelte: the report as a Svelte template, when there is one. */
  template?: string;
  cells: Cell[];
  params: ParamDecl[];
  /** Data files in the folder (and one level down), as cells would name them. */
  files: string[];
}

const CELL = /^(\d+)_([A-Za-z_]\w*)\.(sql|py|md)$/;
const DATA = /\.(csv|tsv|parquet|arrow|arrows|feather|ipc)(\.(gz|zst))?$|\.zip$/i;
const LANG = { sql: "sql", py: "python", md: "md" } as const;

export async function loadNotebook(dir: string): Promise<Notebook> {
  dir = resolve(dir);
  const files = (await readdir(dir)).sort();
  const cells: Cell[] = [];
  for (const file of files) {
    const m = CELL.exec(file);
    if (!m) continue;
    const [, order, name, ext] = m;
    cells.push({
      file,
      order: Number(order),
      name,
      lang: LANG[ext as keyof typeof LANG],
      source: await Bun.file(join(dir, file)).text(),
    });
  }
  cells.sort((a, b) => a.order - b.order || a.file.localeCompare(b.file));

  const seen = new Map<string, string>();
  for (const c of cells) {
    const prev = seen.get(c.name);
    if (prev) throw new Error(`${dir}: cells ${prev} and ${c.file} are both named \`${c.name}\``);
    seen.set(c.name, c.file);
  }

  const settingsFile = Bun.file(join(dir, "notebook.json"));
  const settings = (await settingsFile.exists()) ? await settingsFile.json() : {};
  const params = new Map<string, ParamDecl>();
  for (const c of cells) {
    if (c.lang !== "sql") continue;
    for (const p of sqlParams(c.source)) if (!params.has(p.name)) params.set(p.name, { ...p, cell: c.name });
  }

  const data: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isFile() && DATA.test(e.name)) data.push(e.name);
    else if (e.isDirectory() && !e.name.startsWith(".")) {
      for (const f of await readdir(join(dir, e.name)).catch(() => [])) if (DATA.test(f)) data.push(`${e.name}/${f}`);
    }
  }

  return {
    name: basename(dir),
    dir,
    title: settings.title ?? basename(dir),
    description: settings.description,
    sandbox: settings.sandbox,
    report: settings.report,
    template: files.includes("report.svelte") ? await Bun.file(join(dir, "report.svelte")).text() : undefined,
    cells,
    params: [...params.values()],
    files: data.sort(),
  };
}

/** `PARAM name TYPE [DEFAULT expr] [FROM ...];` declarations, comments ignored. */
export function sqlParams(source: string): Omit<ParamDecl, "cell">[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
  const out: Omit<ParamDecl, "cell">[] = [];
  for (const m of code.matchAll(/(?:^|;)\s*PARAM\s+([A-Za-z_]\w*)\s+([^;]*)/gi)) {
    const d = /^(\w+(?:\s*\([^)]*\))?)(?:\s+DEFAULT\s+(.+?))?(?:\s+FROM\s+.*)?\s*$/is.exec(m[2].trim());
    out.push({ name: m[1], type: (d?.[1] ?? m[2]).toUpperCase(), default: d?.[2]?.trim() });
  }
  return out;
}
