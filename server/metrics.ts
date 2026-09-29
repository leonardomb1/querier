// A kernel's resource use, as Prometheus sees it. The kernel answers a scrape
// in the text exposition format (node_exporter's names, kernel/kernel.py); a
// Monitor turns successive scrapes into points (CPU as a share, memory in bytes)
// and keeps a window of them; `exposition` serves every notebook's for an
// outside Prometheus to scrape at /metrics.

export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Prometheus text exposition (0.0.4): the samples; comments and bad lines are skipped. */
export function parseExposition(text: string): Sample[] {
  const out: Sample[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+\d+)?$/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const l of (m[2] ?? "").matchAll(/([A-Za-z_]\w*)="((?:[^"\\]|\\.)*)"/g)) labels[l[1]] = l[2].replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c));
    const value = m[3] === "+Inf" ? Infinity : m[3] === "-Inf" ? -Infinity : Number(m[3]);
    if (!Number.isNaN(value)) out.push({ name: m[1], labels, value });
  }
  return out;
}

/** What a kernel uses at one moment. */
export interface Point {
  /** epoch ms */
  t: number;
  /** a share of the machine's CPUs, 0–1; null for the first scrape (a rate needs two) */
  cpu: number | null;
  /** bytes in use, and the most there is: the VM's memory, or the host's for a local kernel */
  mem: number;
  memTotal: number;
  /** resident memory of the kernel's own processes, by process */
  rss: Record<string, number>;
}

/** "vm": the numbers are the microVM's own; "process": a local kernel, its processes on the host. */
export type Scope = "vm" | "process";

const sum = (xs: Sample[]) => xs.reduce((a, s) => a + s.value, 0);

export class Monitor {
  points: Point[] = [];
  /** the last scrape, as it came (for /metrics) */
  samples: Sample[] = [];
  private last?: { t: number; busy: number; total: number; proc: number };

  constructor(
    /** how many points are kept: at one scrape every 2 s, 450 is 15 minutes */
    readonly keep = 450,
  ) {}

  /** A new kernel: its counters start over, and the chart shows a gap. */
  restart() {
    this.last = undefined;
    if (this.points.length) this.points.push({ ...this.points.at(-1)!, t: this.points.at(-1)!.t + 1, cpu: null });
  }

  push(samples: Sample[], t: number, scope: Scope, host: { cpus: number; memory: number }): Point {
    this.samples = samples;
    const cpuSamples = samples.filter((s) => s.name === "node_cpu_seconds_total");
    const idle = sum(cpuSamples.filter((s) => s.labels.mode === "idle" || s.labels.mode === "iowait"));
    const total = sum(cpuSamples);
    const proc = sum(samples.filter((s) => s.name === "process_cpu_seconds_total"));
    const rss: Record<string, number> = {};
    for (const s of samples) if (s.name === "process_resident_memory_bytes") rss[s.labels.process ?? "kernel"] = s.value;
    const gauge = (name: string) => samples.find((s) => s.name === name)?.value ?? 0;

    let cpu: number | null = null;
    if (this.last) {
      if (scope === "vm") {
        const dt = total - this.last.total;
        cpu = dt > 0 ? (dt - (idle - (this.last.total - this.last.busy))) / dt : 0;
      } else {
        const secs = (t - this.last.t) / 1000;
        cpu = secs > 0 ? (proc - this.last.proc) / secs / Math.max(1, host.cpus) : 0;
      }
      cpu = Math.min(1, Math.max(0, cpu));
    }
    this.last = { t, busy: total - idle, total, proc };

    const memTotal = scope === "vm" ? gauge("node_memory_MemTotal_bytes") : host.memory;
    const mem = scope === "vm" ? memTotal - gauge("node_memory_MemAvailable_bytes") : Object.values(rss).reduce((a, b) => a + b, 0);
    const point: Point = { t, cpu, mem, memTotal, rss };
    this.points.push(point);
    if (this.points.length > this.keep) this.points.splice(0, this.points.length - this.keep);
    return point;
  }
}

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/** Every running kernel's latest numbers, for Prometheus to scrape. */
export function exposition(kernels: { notebook: string; user?: string; scope: Scope; point: Point }[]): string {
  const lines: string[] = [];
  const family = (name: string, kind: string, help: string, rows: [Record<string, string>, number][]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${kind}`);
    for (const [labels, v] of rows) lines.push(`${name}{${Object.entries(labels).map(([k, x]) => `${k}="${esc(x)}"`).join(",")}} ${v}`);
  };
  // each person has their own kernel of a notebook: `user` tells them apart
  const base = (k: { notebook: string; user?: string; scope: Scope }) => ({ notebook: k.notebook, ...(k.user ? { user: k.user } : {}), sandbox: k.scope === "vm" ? "firecracker" : "local" });
  family("querier_kernel_up", "gauge", "A notebook's kernel is running.", kernels.map((k) => [base(k), 1]));
  family("querier_kernel_cpu_ratio", "gauge", "Share of the kernel's CPUs in use (a local kernel: of the host's).", kernels.filter((k) => k.point.cpu != null).map((k) => [base(k), k.point.cpu!]));
  family("querier_kernel_memory_used_bytes", "gauge", "Memory in use: the microVM's, or a local kernel's processes'.", kernels.map((k) => [base(k), k.point.mem]));
  family("querier_kernel_memory_limit_bytes", "gauge", "Memory the kernel has: the microVM's, or the host's.", kernels.map((k) => [base(k), k.point.memTotal]));
  family(
    "querier_kernel_process_resident_memory_bytes",
    "gauge",
    "Resident memory of the kernel's processes.",
    kernels.flatMap((k) => Object.entries(k.point.rss).map(([process, v]) => [{ ...base(k), process }, v] as [Record<string, string>, number])),
  );
  return lines.join("\n") + "\n";
}
