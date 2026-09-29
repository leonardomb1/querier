// Inside the Querier image: boot a notebook's microVM, run the demo, and check
// the sandbox's network policy (allowed, not allowed, metadata, the container).
//   docker run --rm --device /dev/kvm --device /dev/net/tun --cap-drop ALL --cap-add NET_ADMIN --cap-add SETUID \
//     --cap-add SETGID --cap-add CHOWN --cap-add KILL --sysctl net.ipv4.ip_forward=1 \
//     querier bun scripts/vm-smoke.ts

import { loadNotebook } from "../server/notebook";
import { FirecrackerRunner } from "../server/runner/firecracker";
import type { CellEvent } from "../server/runner/types";

const runner = new FirecrackerRunner();
const demo = await loadNotebook("test/fixtures/demo");
const say = (s: string) => console.log(s);

async function run(s: Awaited<ReturnType<typeof runner.open>>, name: string, lang: "sql" | "python", source: string) {
  const evs: CellEvent[] = [];
  for await (const ev of s.run({ name, lang, source })) evs.push(ev);
  const done = evs.find((e) => e.type === "done") as Extract<CellEvent, { type: "done" }>;
  const text = evs.flatMap((e) => (e.type === "stream" ? [e.text.trim()] : e.type === "display" ? [new TextDecoder().decode(e.data)] : e.type === "error" ? [`error: ${e.message}`] : e.type === "table" ? [`table ${e.name}: ${e.rows} rows`] : []));
  return { ok: done?.ok, text: text.join(" | ") };
}

let t = Date.now();
const s = await runner.open({ notebookDir: demo.dir, env: { SMOKE_SECRET: "only-in-memory" } });
say(`booted in ${Date.now() - t}ms: ${JSON.stringify(s.info)}`);
for (const c of demo.cells) {
  if (c.lang === "md") continue;
  const r = await run(s, c.name, c.lang, c.source);
  say(`  ${r.ok ? "ok  " : "FAIL"} ${c.name}: ${r.text.slice(0, 90)}`);
}
say(`  secret: ${(await run(s, "sec", "python", "import os\nos.environ.get('SMOKE_SECRET')")).text}`);
say(`  writes stay inside: ${(await run(s, "w", "python", "open('/notebook/new.txt','w').write('x')\nimport os\nsorted(os.listdir('/notebook'))[:3]")).text}`);
const probe = (target: string, host = JSON.stringify(target.split(":")[0])) =>
  `import socket\ns = socket.socket(); s.settimeout(3)\ntry:\n    s.connect((${host}, ${Number(target.split(":")[1])}))\n    print('reached')\nexcept Exception as e:\n    print('blocked:', type(e).__name__)`;
say(`  no egress, github.com:443: ${(await run(s, "n", "python", probe("140.82.112.3:443"))).text}`);
await s.close();

t = Date.now();
const n = await runner.open({ notebookDir: demo.dir, sandbox: { egress: ["github.com:443"], vcpus: 1, memory: 1024 } });
say(`with egress [github.com:443], booted in ${Date.now() - t}ms`);
say(`  github.com:443 (by name, from /etc/hosts): ${(await run(n, "a", "python", probe("github.com:443"))).text}`);
say(`  github.com:80 (port not allowed): ${(await run(n, "b", "python", probe("github.com:80"))).text}`);
say(`  1.1.1.1:443 (not allowed): ${(await run(n, "c", "python", probe("1.1.1.1:443"))).text}`);
say(`  169.254.169.254:80 (metadata): ${(await run(n, "d", "python", probe("169.254.169.254:80"))).text}`);
say(`  the gateway, i.e. this container, :3000: ${(await run(n, "e", "python", "import socket\ngw = open('/proc/net/route').read().split()[13]\nip = socket.inet_ntoa(bytes.fromhex(gw)[::-1])\n" + probe("x:3000", "ip"))).text}`);
say(`  no DNS: ${(await run(n, "f", "python", "import socket\ntry:\n    socket.gethostbyname('example.com'); print('resolved')\nexcept Exception as e:\n    print('no DNS:', type(e).__name__)")).text}`);
await n.close();
say("closed; left behind: " + (Bun.spawnSync(["sh", "-c", "ls /var/lib/querier/vms; ip -brief link | grep qfc; nft list map inet querier sessions 2>/dev/null | grep -c jump"]).stdout.toString().trim() || "nothing"));
