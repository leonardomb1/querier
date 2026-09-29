import { expect, test } from "bun:test";
import { exposition, Monitor, parseExposition } from "../server/metrics";
import { LocalRunner } from "../server/runner/local";

const scrape = (idle: number, busy: number, avail: number) => `# HELP node_cpu_seconds_total Seconds.
# TYPE node_cpu_seconds_total counter
node_cpu_seconds_total{cpu="0",mode="idle"} ${idle}
node_cpu_seconds_total{cpu="0",mode="user"} ${busy}
node_memory_MemTotal_bytes 2000
node_memory_MemAvailable_bytes ${avail}
process_cpu_seconds_total{process="kernel"} ${busy}
process_resident_memory_bytes{process="kernel"} 300
process_resident_memory_bytes{process="basalt"} 200
`;

test("the exposition format: labels, escapes, comments and junk", () => {
  expect(parseExposition('a_b{x="1",y="q\\"uote"} 2.5\n# c\nbad line\nz 3 1700000000\n')).toEqual([
    { name: "a_b", labels: { x: "1", y: 'q"uote' }, value: 2.5 },
    { name: "z", labels: {}, value: 3 },
  ]);
});

test("a VM: CPU from the change in its counters, memory in use of its own", () => {
  const m = new Monitor(3);
  const host = { cpus: 8, memory: 1e12 };
  expect(m.push(parseExposition(scrape(100, 50, 1500)), 0, "vm", host)).toMatchObject({ cpu: null, mem: 500, memTotal: 2000 });
  // 10 s of CPU time: 7.5 busy, 2.5 idle
  expect(m.push(parseExposition(scrape(102.5, 57.5, 1000)), 2000, "vm", host)).toMatchObject({ cpu: 0.75, mem: 1000, rss: { kernel: 300, basalt: 200 } });
  m.push(parseExposition(scrape(105, 60, 1000)), 4000, "vm", host);
  m.push(parseExposition(scrape(106, 61, 1000)), 6000, "vm", host);
  expect(m.points.length).toBe(3); // the window keeps 3
  m.restart(); // a new kernel: a gap, and the next point has no rate yet
  expect(m.points.at(-1)!.cpu).toBeNull();
});

test("a local kernel: its processes' CPU as a share of the host's, their memory of the host's", () => {
  const m = new Monitor();
  const host = { cpus: 4, memory: 16000 };
  m.push(parseExposition(scrape(0, 10, 0)), 0, "process", host);
  // 2 CPU-seconds in 1 s on 4 cores: half the host
  expect(m.push(parseExposition(scrape(0, 12, 0)), 1000, "process", host)).toMatchObject({ cpu: 0.5, mem: 500, memTotal: 16000 });
});

test("/metrics: every kernel, labelled by notebook", () => {
  const text = exposition([{ notebook: 'w/"nb"', scope: "vm", point: { t: 0, cpu: 0.25, mem: 5, memTotal: 10, rss: { kernel: 3 } } }]);
  expect(text).toContain('querier_kernel_cpu_ratio{notebook="w/\\"nb\\"",sandbox="firecracker"} 0.25');
  expect(text).toContain('querier_kernel_process_resident_memory_bytes{notebook="w/\\"nb\\"",sandbox="firecracker",process="kernel"} 3');
  expect(parseExposition(text).find((s) => s.name === "querier_kernel_memory_limit_bytes")?.value).toBe(10);
});

test("a real kernel answers a scrape, even while a cell runs", async () => {
  const s = await new LocalRunner().open({ notebookDir: import.meta.dir });
  try {
    const running = (async () => {
      for await (const _ of s.run({ name: "slow", lang: "python", source: "import time; time.sleep(1.5)" }));
    })();
    await Bun.sleep(300);
    const t0 = performance.now();
    const samples = parseExposition(await s.metrics());
    expect(performance.now() - t0).toBeLessThan(1000); // not queued behind the sleep
    expect(samples.some((x) => x.name === "node_cpu_seconds_total")).toBe(true);
    expect(samples.find((x) => x.name === "process_resident_memory_bytes" && x.labels.process === "kernel")!.value).toBeGreaterThan(0);
    await running;
  } finally {
    await s.close();
  }
});
