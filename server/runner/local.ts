// Kernels as local processes: no isolation, fast to iterate on. The microVM
// runner replaces the spawn with a guest boot; everything else is shared.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeFrames } from "./protocol";
import { KernelSession } from "./session";
import type { OpenOptions, Runner, Session } from "./types";

const root = resolve(import.meta.dir, "../..");

export interface LocalRunnerOptions {
  python?: string;
  kernel?: string;
  basalt?: string;
  workRoot?: string;
  /** Run on a copy of the notebook folder, sending output/ back as the microVM
   *  does: its file sync, without a VM (tests). */
  copy?: boolean;
}

export class LocalRunner implements Runner {
  private python: string;
  private kernel: string;
  private basalt: string;
  private workRoot: string;
  private copy: boolean;

  constructor(o: LocalRunnerOptions = {}) {
    this.python = o.python ?? process.env.QUERIER_PYTHON ?? join(root, ".venv/bin/python");
    this.kernel = o.kernel ?? join(root, "kernel/kernel.py");
    this.basalt = o.basalt ?? process.env.BASALT_BIN ?? Bun.which("basalt") ?? "basalt";
    this.workRoot = o.workRoot ?? join(tmpdir(), "querier");
    this.copy = !!o.copy;
  }

  async open({ notebookDir, env, packages }: OpenOptions): Promise<Session> {
    await Bun.$`mkdir -p ${this.workRoot}`.quiet();
    const work = await mkdtemp(join(this.workRoot, "s-"));
    let cwd = resolve(notebookDir);
    if (this.copy) {
      await Bun.$`cp -r ${cwd} ${join(work, "nb")}`.quiet();
      cwd = join(work, "nb");
    }
    const proc = Bun.spawn(
      [this.python, "-u", this.kernel, "--work", work, "--cwd", cwd, "--basalt", this.basalt, ...(this.copy ? ["--sync-output"] : [])],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          ...env,
          // the environment's packages first: the notebook's, then the workspace's, then the interpreter's own
          ...(packages?.notebook || packages?.workspace
            ? { PYTHONPATH: [packages.notebook?.dir, packages.workspace?.dir, process.env.PYTHONPATH].filter(Boolean).join(":") }
            : {}),
        },
      },
    );
    // Anything the kernel writes outside a cell (warnings, crashes) lands here.
    let stderr = "";
    (async () => {
      for await (const chunk of proc.stderr) stderr = (stderr + new TextDecoder().decode(chunk)).slice(-4000);
    })();
    const exited = proc.exited.then(async (code) => {
      await rm(work, { recursive: true, force: true });
      if (code === 0) return undefined;
      const tail = stderr.trim().split("\n").slice(-3).join("\n");
      return `kernel exited with code ${code}${tail ? `: ${tail}` : ""}`;
    });
    return KernelSession.start(work.split("/").pop()!, {
      send: (frame) => {
        proc.stdin.write(frame);
        proc.stdin.flush();
      },
      frames: decodeFrames(proc.stdout),
      exited,
      kill: () => proc.kill(),
    });
  }
}
