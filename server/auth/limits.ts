// Failed logins slow down: after 5 in 10 minutes, a key (an address and a
// username) waits, 1 minute and doubling up to 30. A success clears it.

interface Entry {
  fails: number[];
  lockedUntil: number;
  locks: number;
}

export class LoginLimiter {
  private entries = new Map<string, Entry>();
  constructor(private max = 5, private windowMs = 10 * 60_000) {}

  /** ms to wait before trying again; 0 when a try is allowed */
  wait(key: string, now = Date.now()): number {
    const e = this.entries.get(key);
    return e && e.lockedUntil > now ? e.lockedUntil - now : 0;
  }

  failed(key: string, now = Date.now()) {
    const e = this.entries.get(key) ?? { fails: [], lockedUntil: 0, locks: 0 };
    e.fails = [...e.fails.filter((t) => now - t < this.windowMs), now];
    if (e.fails.length >= this.max) {
      e.lockedUntil = now + Math.min(30, 2 ** e.locks) * 60_000;
      e.locks++;
      e.fails = [];
    }
    this.entries.set(key, e);
  }

  succeeded(key: string) {
    this.entries.delete(key);
  }
}
