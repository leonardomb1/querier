// A microVM's network: none unless its notebook asks for egress, and then only
// to what it names. Each VM gets a tap in the container's network namespace
// (the real host is never touched) and an nftables allow-list of ip:port (TCP).
// The VM cannot reach the container itself, and link-local (cloud metadata) is
// always refused. There is no DNS in the VM: names are resolved here and
// handed in as /etc/hosts, so DNS cannot be used to smuggle data out.
// Refused, not silently dropped: a blocked connection fails at once ("connection
// refused") instead of hanging until a driver's timeout.

import { lookup } from "node:dns/promises";

const SUBNET = "10.200.0.0/16";

async function run(argv: string[], input?: string) {
  const proc = Bun.spawn(argv, { stdin: input == null ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (input != null) {
    proc.stdin!.write(input);
    await proc.stdin!.end();
  }
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${argv.join(" ")}: ${err.trim()}`);
}

let base: Promise<void> | undefined;

/** The shared rules, once per container. */
function ensureBase() {
  base ??= run(
    ["nft", "-f", "-"],
    `
table inet querier {
  map sessions { type ifname : verdict; }
  set never { type ipv4_addr; flags interval; elements = { 169.254.0.0/16 } }
  chain forward {
    type filter hook forward priority filter; policy accept;
    iifname "qfc*" ct state established,related accept
    iifname "qfc*" ip daddr @never jump refuse
    iifname "qfc*" iifname vmap @sessions
    iifname "qfc*" jump refuse
  }
  chain refuse {
    meta l4proto tcp reject with tcp reset
    reject with icmpx admin-prohibited
  }
  # a VM talks to the outside it was allowed, never to this container
  chain input {
    type filter hook input priority filter; policy accept;
    iifname "qfc*" jump refuse
  }
}
table ip querier_nat {
  chain post {
    type nat hook postrouting priority srcnat; policy accept;
    ip saddr ${SUBNET} oifname != "qfc*" masquerade
  }
}
`,
  ).catch((e) => {
    base = undefined;
    throw e;
  });
  return base;
}

export interface Egress {
  /** `host:port`, `1.2.3.4:5432` or `10.0.0.0/8:443`. */
  targets: string[];
}

const taken = new Set<number>();

export class SandboxNet {
  private constructor(
    readonly slot: number,
    readonly tap: string,
    readonly hostIp: string,
    readonly guestIp: string,
    /** Names the VM may use, resolved here: its /etc/hosts. */
    readonly hosts: Record<string, string>,
  ) {}

  /** Kernel command line: a static address, no DHCP, no DNS. */
  get bootArgs() {
    return `ip=${this.guestIp}::${this.hostIp}:255.255.255.252::eth0:off`;
  }

  static async open(targets: string[], owner: string | null): Promise<SandboxNet> {
    await ensureBase();
    let slot = 1;
    while (taken.has(slot)) slot++;
    if (slot > 250) throw new Error("Too many sandboxes with network at once.");
    taken.add(slot);
    const tap = `qfc${slot}`;
    const hostIp = `10.200.${slot}.1`;
    const guestIp = `10.200.${slot}.2`;
    try {
      const { elements, hosts } = await resolveTargets(targets);
      await run(["ip", "tuntap", "add", "dev", tap, "mode", "tap", ...(owner ? ["user", owner] : [])]);
      await run(["ip", "addr", "add", `${hostIp}/30`, "dev", tap]);
      await run(["ip", "link", "set", tap, "up"]);
      await run(
        ["nft", "-f", "-"],
        `
add set inet querier allow_${tap} { type ipv4_addr . inet_service; flags interval; }
${elements.length ? `add element inet querier allow_${tap} { ${elements.join(", ")} }` : ""}
add chain inet querier s_${tap}
add rule inet querier s_${tap} ip daddr . tcp dport @allow_${tap} accept
add rule inet querier s_${tap} jump refuse
add element inet querier sessions { "${tap}" : jump s_${tap} }
`,
      );
      return new SandboxNet(slot, tap, hostIp, guestIp, hosts);
    } catch (e) {
      taken.delete(slot);
      await run(["ip", "link", "del", tap]).catch(() => {});
      throw e;
    }
  }

  async close() {
    const tap = this.tap;
    await run(
      ["nft", "-f", "-"],
      `
delete element inet querier sessions { "${tap}" }
delete chain inet querier s_${tap}
delete set inet querier allow_${tap}
`,
    ).catch(() => {});
    await run(["ip", "link", "del", tap]).catch(() => {});
    taken.delete(this.slot);
  }
}

/** `host:port` entries as nft elements (`ip . port`), names resolved to IPv4. */
export async function resolveTargets(targets: string[]) {
  const elements: string[] = [];
  const hosts: Record<string, string> = {};
  for (const raw of targets) {
    const m = /^\s*([^\s:]+):(\d{1,5}(?:-\d{1,5})?)\s*$/.exec(raw);
    if (!m) throw new Error(`Egress \`${raw}\` must be host:port (or host:port-port).`);
    const [, host, port] = m;
    if (/^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(host)) {
      elements.push(`${host} . ${port}`);
      continue;
    }
    const addrs = await lookup(host, { all: true, family: 4 }).catch(() => []);
    if (!addrs.length) throw new Error(`Can't resolve ${host} for the sandbox's egress.`);
    for (const a of addrs) elements.push(`${a.address} . ${port}`);
    hosts[host] = addrs[0].address;
  }
  return { elements, hosts };
}
