// Every running kernel, by whose it is: each person has their own kernel of a
// notebook (as in Microsoft Fabric), so what it holds and prints is theirs, and
// it runs with what they may use. Kernels cost a microVM each: a server-wide cap
// and a per-person one keep a busy afternoon from exhausting the host, and a
// kernel nobody has used for a while is stopped (app.ts).
//
//   QUERIER_MAX_KERNELS             running at once, everyone's (default: what the host's memory holds)
//   QUERIER_MAX_KERNELS_PER_USER    running at once, one person's (default 3)
//   QUERIER_KERNEL_IDLE_MINUTES     unused this long: stopped (default 30; 0 never)

import { totalmem } from "node:os";
import { UserError } from "./store";

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
};
const int = (v: string | undefined, fallback: number) => Math.floor(num(v, fallback));

/** As many default-sized (2 GiB) kernels as the host's memory holds, with room left for the server. */
const byMemory = () => Math.max(2, Math.floor((totalmem() - 2 * 2 ** 30) / (2 * 2 ** 30)));

export interface KernelLimits {
  total: number;
  perUser: number;
  /** ms; 0: never */
  idle: number;
}

export const limitsFromEnv = (env = process.env): KernelLimits => ({
  total: int(env.QUERIER_MAX_KERNELS, byMemory()),
  perUser: int(env.QUERIER_MAX_KERNELS_PER_USER, 3),
  // (fractions work: 0.5 is 30 s)
  idle: Math.round(num(env.QUERIER_KERNEL_IDLE_MINUTES, 30) * 60_000),
});

interface Held {
  owner: string;
  nb: string;
}

export class Kernels {
  private held = new Set<Held>();

  constructor(readonly limits: KernelLimits = limitsFromEnv()) {}

  /** A place for `owner`'s kernel of `nb`, or why there is none; call the result to give it back. */
  acquire(owner: string, nb: string): () => void {
    const mine = [...this.held].filter((h) => h.owner === owner);
    if (mine.length >= this.limits.perUser) {
      const list = mine.map((h) => h.nb).join(", ");
      throw new UserError(
        `You have ${mine.length} kernel${mine.length === 1 ? "" : "s"} running, the most one person may (${list}). Stop one (restart its kernel, or close its tabs and wait for it to go idle) and run again.`,
      );
    }
    if (this.held.size >= this.limits.total) {
      throw new UserError(`The server is running as many kernels as it can (${this.limits.total}). Try again when one stops, or ask an administrator to raise QUERIER_MAX_KERNELS.`);
    }
    const h: Held = { owner, nb };
    this.held.add(h);
    let given = false;
    return () => {
      if (given) return;
      given = true;
      this.held.delete(h);
    };
  }

  /** How many run: everyone's, or one person's. */
  count(owner?: string): number {
    return owner == null ? this.held.size : [...this.held].filter((h) => h.owner === owner).length;
  }
}
