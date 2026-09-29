// What each cell defines and reads (kernel/analyze.py), for ordering runs and
// marking cells stale. Runs on the host's python: it only needs the stdlib.

import { resolve } from "node:path";
import type { Cell } from "./notebook";

export interface Deps {
  defines: string[];
  reads: string[];
}

const root = resolve(import.meta.dir, "..");
const python = process.env.QUERIER_PYTHON ?? resolve(root, ".venv/bin/python");
const script = resolve(root, "kernel/analyze.py");

async function call(input: unknown): Promise<any> {
  const proc = Bun.spawn([python, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(JSON.stringify(input));
  await proc.stdin.end();
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`analyze.py: ${err.trim().split("\n").at(-1)}`);
  return JSON.parse(out);
}

const plain = (cells: Cell[]) => cells.map(({ name, lang, source }) => ({ name, lang, source }));

export function analyze(cells: Cell[]): Promise<Record<string, Deps>> {
  return call(plain(cells));
}

/** After cell `old` became `new`: the rewritten sources of the cells below that read it. */
export function renameRefs(cells: Cell[], old: string, to: string): Promise<Record<string, string>> {
  return call({ op: "rename", cells: plain(cells), old, new: to });
}
