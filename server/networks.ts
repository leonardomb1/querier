// Networks as people write them (10.0.0.0/8, 192.168.1.10, 2001:db8::/32), and
// whether an address is in them: what a public link may be opened from.

import { BlockList, isIP } from "node:net";

/** "10.0.0.0/8" or an address alone, checked; throws on anything else. */
export function parseNetwork(text: string): { address: string; prefix: number; family: "ipv4" | "ipv6" } {
  const [address, bits] = text.trim().split("/");
  const v = isIP(address ?? "");
  if (!v) throw new Error(`\`${text}\` isn't a network: an address (10.1.2.3) or a range (10.0.0.0/8).`);
  const max = v === 4 ? 32 : 128;
  const prefix = bits == null || bits === "" ? max : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) throw new Error(`\`${text}\`: the range after / is 0–${max}.`);
  return { address, prefix, family: v === 4 ? "ipv4" : "ipv6" };
}

/** An address as a client comes (an IPv4 one may arrive as ::ffff:10.1.2.3). */
const bare = (ip: string) => ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");

/** Is `ip` in any of `networks`? None given: anywhere is. */
export function inNetworks(ip: string, networks: string[] | undefined): boolean {
  if (!networks?.length) return true;
  const list = new BlockList();
  for (const n of networks) {
    const { address, prefix, family } = parseNetwork(n);
    list.addSubnet(address, prefix, family);
  }
  const a = bare(ip);
  const v = isIP(a);
  return v !== 0 && list.check(a, v === 4 ? "ipv4" : "ipv6");
}

/** Is every address of `inner` in one of `outer`? (A link's networks within the server's.) */
export function withinNetworks(inner: string, outer: string[] | undefined): boolean {
  if (!outer?.length) return true;
  const n = parseNetwork(inner);
  return outer.some((o) => {
    const w = parseNetwork(o);
    return w.family === n.family && w.prefix <= n.prefix && inNetworks(n.address, [o]);
  });
}
