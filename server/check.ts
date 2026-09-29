// basalt's check without a kernel: the CLI, told which tables the notebook's
// other cells make (--known). What the running kernel's check would also know —
// connections, params and LETs from earlier cells — it can't, so a problem that
// is only "that connection is declared elsewhere" is left out.

import type { Diagnostic } from "./runner/types";

export const BASALT = process.env.BASALT_BIN ?? Bun.which("basalt") ?? "basalt";

export async function checkCli(source: string, known: string[], connections: Set<string>): Promise<Diagnostic[]> {
  const args = [BASALT, "check", "-", "--format", "json", ...(known.length ? ["--known", known.join(",")] : [])];
  const proc = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(source);
  await proc.stdin.end();
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let diags: Diagnostic[];
  try {
    diags = JSON.parse(out || "[]");
  } catch {
    throw new Error(`basalt check failed: ${err.trim() || out.trim()}`);
  }
  return diags.filter((d) => {
    const m = /unknown (?:connection|source) `([^`.]+)/.exec(d.msg ?? "");
    return !(m && connections.has(m[1].toLowerCase()));
  });
}
