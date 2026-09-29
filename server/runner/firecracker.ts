// Kernels in Firecracker microVMs, one per notebook session.
//
// The VM boots a read-only root disk (Python, polars, basalt, the kernel agent)
// and a read-only copy of the notebook's files, with a throwaway tmpfs layer on
// top: nothing it writes reaches the host. Firecracker runs as an unprivileged
// user under its own seccomp filter. The guest dials the host over vsock; the
// first frame the host sends carries the session's secrets, which never touch
// a disk. Network exists only when the notebook allows egress (sandbox-net.ts).

import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decodeFrames, encodeFrame } from "./protocol";
import { SandboxNet } from "./sandbox-net";
import { KernelSession } from "./session";
import type { OpenOptions, Runner, Session } from "./types";

export interface FirecrackerOptions {
  firecracker?: string;
  kernel?: string;
  rootfs?: string;
  workRoot?: string;
  /** Run Firecracker as this user (when the server is root). */
  user?: string;
}

const VM = process.env.QUERIER_VM_DIR ?? "/opt/querier/vm";
/** The host port the guest's agent dials (kernel/init.py). */
const PORT = 5000;

async function sh(argv: string[]) {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${argv[0]}: ${err.trim()}`);
}

/** The notebook's files (no dotfiles: not .git) on a read-only ext4 disk. */
async function notebookDisk(src: string, dest: string, staging: string) {
  await mkdir(staging, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true })) {
    // contents only: owners and modes stay on this side
    if (!e.name.startsWith(".")) await sh(["cp", "-r", "--no-preserve=all", join(src, e.name), staging]);
  }
  const du = Bun.spawnSync(["du", "-sm", staging]).stdout.toString();
  const mb = Math.max(16, Math.ceil(Number(du.split(/\s/)[0] || 0) * 1.25) + 16);
  await sh(["mkfs.ext4", "-q", "-L", "notebook", "-d", staging, dest, `${mb}M`]);
  await rm(staging, { recursive: true, force: true });
}

/** Listen where Firecracker forwards the guest's connection to host port `PORT`
 *  (`<uds>_<port>`) and hand over the first one. The server owns the socket;
 *  Firecracker's user reaches it through the group. */
function listenVsock(path: string, onDrain: () => void) {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
  let accept!: (s: any) => void;
  const connected = new Promise<any>((r) => (accept = r));
  let taken = false;
  const listener = Bun.listen({
    unix: path,
    socket: {
      open(s) {
        if (taken) {
          s.end(); // one connection per VM
          return;
        }
        taken = true;
        accept(s);
      },
      data(_s, chunk) {
        ctrl.enqueue(new Uint8Array(chunk));
      },
      drain() {
        onDrain();
      },
      close() {
        try {
          ctrl.close();
        } catch {}
      },
    },
  });
  return { listener, stream, connected };
}

export class FirecrackerRunner implements Runner {
  private fc: string;
  private kernel: string;
  private rootfs: string;
  private workRoot: string;
  private user: string | null;

  constructor(o: FirecrackerOptions = {}) {
    this.fc = o.firecracker ?? Bun.which("firecracker") ?? "firecracker";
    this.kernel = o.kernel ?? join(VM, "vmlinux");
    this.rootfs = o.rootfs ?? join(VM, "rootfs.ext4");
    this.workRoot = o.workRoot ?? process.env.QUERIER_VM_WORK ?? "/var/lib/querier/vms";
    this.user = o.user ?? (process.getuid?.() === 0 ? "fc" : null);
  }

  async open({ notebookDir, env, sandbox }: OpenOptions): Promise<Session> {
    const id = `vm-${crypto.randomUUID().slice(0, 8)}`;
    const dir = join(this.workRoot, id);
    await mkdir(dir, { recursive: true });
    let net: SandboxNet | null = null;
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    let listener: { stop(force?: boolean): void } | null = null;
    // never throws: a failed open must say why it failed, not why cleanup did
    const cleanup = async () => {
      proc?.kill();
      listener?.stop(true);
      await net?.close().catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch((e) => console.error(`removing ${dir}:`, e.message));
    };
    const why = async () => {
      const log = await Bun.file(join(dir, "console.log")).text().catch(() => "");
      const err = await Bun.file(join(dir, "firecracker.log")).text().catch(() => "");
      return [err, log].join("\n").trim().split("\n").filter(Boolean).slice(-4).join("\n");
    };

    try {
      await notebookDisk(resolve(notebookDir), join(dir, "notebook.ext4"), join(dir, "staging"));
      if (sandbox?.egress?.length) net = await SandboxNet.open(sandbox.egress, this.user);

      // writes to the guest, respecting backpressure
      const pending: Uint8Array[] = [];
      let socket: any = null;
      const flush = () => {
        while (socket && pending.length) {
          const b = pending[0];
          const n = socket.write(b);
          if (n >= b.length) pending.shift();
          else {
            pending[0] = b.subarray(Math.max(0, n));
            return;
          }
        }
      };
      // the guest dials in: listen before it boots
      const vsock = listenVsock(join(dir, `v.sock_${PORT}`), flush);
      listener = vsock.listener;

      const config = {
        "boot-source": {
          kernel_image_path: this.kernel,
          boot_args: ["console=ttyS0 reboot=k panic=1 pci=off quiet ro root=/dev/vda init=/sbin/querier-init", net?.bootArgs]
            .filter(Boolean)
            .join(" "),
        },
        drives: [
          { drive_id: "root", path_on_host: this.rootfs, is_root_device: true, is_read_only: true },
          { drive_id: "notebook", path_on_host: join(dir, "notebook.ext4"), is_root_device: false, is_read_only: true },
        ],
        "machine-config": { vcpu_count: sandbox?.vcpus ?? 2, mem_size_mib: sandbox?.memory ?? 2048 },
        vsock: { guest_cid: 3, uds_path: join(dir, "v.sock") },
        ...(net ? { "network-interfaces": [{ iface_id: "eth0", host_dev_name: net.tap }] } : {}),
      };
      await Bun.write(join(dir, "config.json"), JSON.stringify(config));

      // the server keeps owning the VM's folder (so it can clean up); Firecracker's user
      // gets in through the group: it reads its disks and config, makes its own socket,
      // and connects to ours
      if (this.user) {
        await sh(["chown", "-R", `root:${this.user}`, dir]);
        await sh(["chmod", "0770", dir]);
        await sh(["chmod", "0640", join(dir, "notebook.ext4"), join(dir, "config.json")]);
        await sh(["chmod", "0660", join(dir, `v.sock_${PORT}`)]);
      }

      // Firecracker as the unprivileged user: leaving root drops every capability,
      // and no-new-privs (here and on the container) means it can't get one back
      const drop = this.user ? ["setpriv", `--reuid=${this.user}`, `--regid=${this.user}`, "--init-groups", "--no-new-privs", "--inh-caps=-all"] : [];
      proc = Bun.spawn([...drop, this.fc, "--no-api", "--config-file", join(dir, "config.json"), "--id", id], {
        cwd: dir,
        stdin: "ignore",
        stdout: Bun.file(join(dir, "console.log")),
        stderr: Bun.file(join(dir, "firecracker.log")),
      });
      const exited = proc.exited.then(async (code) => {
        proc = null;
        const reason = code === 0 ? undefined : `the sandbox stopped (exit ${code})${await why().then((w) => (w ? `: ${w}` : ""))}`;
        await cleanup();
        return reason;
      });

      socket = await Promise.race([
        vsock.connected,
        exited.then((r) => Promise.reject(new Error(r ?? "The sandbox stopped before it was ready."))),
        Bun.sleep(30_000).then(async () => Promise.reject(new Error(`The sandbox didn't come up in 30s.\n${await why()}`))),
      ]);
      vsock.listener.stop(false); // no second connection

      const send = (frame: Uint8Array) => {
        pending.push(frame);
        flush();
      };
      // the session's environment and names, before anything else
      send(encodeFrame({ op: "hello", env: env ?? {}, hosts: net?.hosts ?? {} }));
      const session = await KernelSession.start(id, {
        send,
        frames: decodeFrames(vsock.stream),
        exited,
        kill: () => proc?.kill(),
      });
      session.info.sandbox = "firecracker";
      session.info.egress = (sandbox?.egress ?? []).join(", ");
      return session;
    } catch (e) {
      await cleanup();
      throw e;
    }
  }
}
