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
// a terminal: a shell in the VM, with the session's environment, while nothing else runs
{
  let out = "";
  const code = await new Promise<number | null>((exit) => {
    const sh = s.shell(80, 24, { data: (b) => (out += new TextDecoder().decode(b)), exit });
    sh.write(new TextEncoder().encode('echo "user=$(id -u) cwd=$PWD secret=${SMOKE_SECRET:+set}"; exit 7\n'));
    setTimeout(() => sh.close(), 10_000);
  });
  say(`  terminal: ${out.match(/user=\S+ cwd=\S+ secret=\S*/)?.[0] ?? JSON.stringify(out.slice(-120))}, exit ${code}`);
}
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
// an environment: packages built for the guest, on a disk of their own; the notebook's slot empty
{
  const { Environments } = await import("../server/environments");
  const { openDb } = await import("../server/auth/db");
  const root = "/tmp/smoke-env";
  const envs = new Environments(openDb(":memory:"), { root: `${root}/builds`, images: true });
  await Bun.write(`${root}/ws/.keep`, "");
  t = Date.now();
  envs.apply(`${root}/ws`, "ws:smoke", "python", ["tabulate"], "smoke");
  let st = await envs.state(`${root}/ws`, "ws:smoke", "python");
  while (st.status === "building") (await Bun.sleep(200), (st = await envs.state(`${root}/ws`, "ws:smoke", "python")));
  say(`environment [tabulate]: ${st.status} in ${Date.now() - t}ms${st.log ? `: ${st.log.slice(0, 200)}` : ""}`);
  const built = envs.python(st.applied?.hash);
  const e = await runner.open({ notebookDir: demo.dir, packages: { workspace: built, notebook: null } });
  say(`  import tabulate: ${(await run(e, "t", "python", "import tabulate, sys\nprint(tabulate.__file__.split('/')[:3], [p for p in sys.path if 'env' in p])")).text}`);
  say(`  the image's own still there: ${(await run(e, "p", "python", "import polars\nprint('polars', polars.__version__)")).text}`);
  await e.close();
}
say("closed; left behind: " + (Bun.spawnSync(["sh", "-c", "ls /var/lib/querier/vms; ip -brief link | grep qfc; nft list map inet querier sessions 2>/dev/null | grep -c jump"]).stdout.toString().trim() || "nothing"));
