<script lang="ts">
  import { fade } from "svelte/transition";
  import { api, splitId, type WorkspaceSummary } from "../../lib/api";
  import { writeClipboard } from "../../lib/copy";
  import type { NotebookCtl } from "../../lib/notebook.svelte";
  import type { Workbench } from "../../lib/workbench.svelte";
  import Icon from "../Icon.svelte";
  import TimeSeries from "../TimeSeries.svelte";
  import { provideSettings } from "../settings/context";
  import SandboxGroup from "../settings/SandboxGroup.svelte";
  import OverlayPanel from "./OverlayPanel.svelte";

  // The kernel's sandbox, from the status bar: where it runs, what it uses right
  // now and over the last minutes (scraped from the kernel as Prometheus metrics
  // every 2 s), what it can do, and its size and network settings.
  let { ctl, wb, onclose }: { ctl: NotebookCtl; wb: Workbench; onclose: () => void } = $props();

  let saved = $state<{ kind: "saved" | "error"; text: string } | null>(null);
  let timer: ReturnType<typeof setTimeout>;
  provideSettings({
    query: "",
    report(kind, text) {
      saved = { kind, text };
      clearTimeout(timer);
      if (kind === "saved") timer = setTimeout(() => (saved = null), 2500);
    },
  });

  let ws = $state<WorkspaceSummary | null>(null);
  // svelte-ignore state_referenced_locally
  api.workspace.get(splitId(ctl.name)[0]).then((w) => (ws = w)).catch(() => {});

  const session = $derived(ctl.conn.session);
  const info = $derived(ctl.conn.info);
  const vm = $derived(info.sandbox === "firecracker");
  const metrics = $derived(ctl.conn.metrics);
  const last = $derived(metrics.points.at(-1));

  const WINDOWS = [
    { s: 60, label: "1m" },
    { s: 300, label: "5m" },
    { s: 900, label: "15m" },
  ];
  let window = $state(300);
  const inWindow = $derived(metrics.points.filter((p) => p.t >= Date.now() - window * 1000));
  const cpuVals = $derived(inWindow.map((p) => p.cpu).filter((v): v is number => v != null));
  const memVals = $derived(inWindow.map((p) => p.mem));
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const peak = (xs: number[]) => (xs.length ? Math.max(...xs) : null);

  const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`);
  function bytes(n: number | null | undefined) {
    if (n == null) return "—";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
    return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
  }
  const cpus = $derived(vm ? Number(info.vcpus) || null : null);
  const where = $derived(vm ? "Firecracker microVM" : "Local process");
  const stateText = $derived(
    ({ ready: ctl.busy ? "Running a cell" : "Idle", starting: "Starting…", dead: "Stopped", offline: "Disconnected", none: "Not started" } as Record<string, string>)[session] ?? session,
  );
  const running = $derived(session === "ready");
  const kernelIcon = $derived(
    session === "starting"
      ? { name: "loading", spin: true }
      : session === "offline"
        ? { name: "debug-disconnect", spin: false }
        : !running
          ? { name: "vm-outline", spin: false }
          : ctl.busy
            ? { name: vm ? "vm-running" : "server-process", spin: false }
            : { name: vm ? "vm-active" : "server-process", spin: false },
  );
  const facts = $derived(
    [
      stateText,
      running && vm && info.vcpus ? `${info.vcpus} vCPU${info.vcpus === "1" ? "" : "s"}` : "",
      running && vm && info.memory ? bytes(Number(info.memory) * 1048576) : "",
      info.egress ? `may reach ${info.egress}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  );

  let copied = $state(false);
  async function copyEndpoint() {
    await writeClipboard(`${location.origin}/metrics`);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }
</script>

<OverlayPanel icon={vm ? "vm" : "server-process"} title="Sandbox" {onclose} oneditor={ctl.may("sandbox.manage") ? () => (onclose(), wb.openSettings("notebook", "nb-sandbox")) : undefined}>
  {#snippet status()}
    {#if saved}
      <span class="saved" class:bad={saved.kind === "error"} transition:fade={{ duration: 120 }}>
        <Icon name={saved.kind === "error" ? "error" : "check"} size={14} />{saved.text}
      </span>
    {/if}
  {/snippet}
  <div class="body">
    <section class="summary">
      <span class="kicon" class:off={!running && session !== "starting"}><Icon name={kernelIcon.name} size={22} spin={kernelIcon.spin} /></span>
      <div class="what">
        <strong>{where}</strong>
        <span>{facts}</span>
        {#if info.python || info.basalt}<span class="versions">{[info.python && `Python ${info.python}`, info.polars && `polars ${info.polars}`, info.basalt && `basalt ${info.basalt}`].filter(Boolean).join(" · ")}</span>{/if}
      </div>
      <span class="acts">
        {#if ctl.busy && ctl.mayRun}<button class="btn" onclick={() => ctl.interrupt()}><Icon name="debug-stop" size={14} />Stop the cell</button>{/if}
        <button class="btn" disabled={!ctl.mayRun} onclick={() => ctl.restart()}><Icon name={running ? "debug-restart" : "debug-start"} size={14} />{running ? "Restart kernel" : "Start kernel"}</button>
      </span>
    </section>

    <section class="live">
      <header class="live-head">
        <h2>Usage</h2>
        <span class="hint">
          {#if !vm && running}The kernel's processes, on the host{:else}The microVM, as the kernel sees it{/if}: scraped every 2 s
        </span>
        <div class="seg" role="radiogroup" aria-label="Window">
          {#each WINDOWS as w (w.s)}
            <button role="radio" aria-checked={window === w.s} class:on={window === w.s} onclick={() => (window = w.s)}>{w.label}</button>
          {/each}
        </div>
      </header>
      <div class="cards">
        <div class="card">
          <div class="card-head">
            <span class="name"><Icon name="pulse" size={14} />CPU</span>
            <span class="now">{pct(last?.cpu)}</span>
          </div>
          <div class="stats">
            <span>avg {pct(avg(cpuVals))}</span><span>peak {pct(peak(cpuVals))}</span>{#if cpus}<span>of {cpus} vCPU{cpus === 1 ? "" : "s"}</span>{/if}
          </div>
          <TimeSeries label="CPU use" points={metrics.points.map((p) => ({ t: p.t, v: p.cpu }))} {window} max={1} format={pct} />
        </div>
        <div class="card">
          <div class="card-head">
            <span class="name"><Icon name="chip" size={14} />Memory</span>
            <span class="now">{bytes(last?.mem)} <small>of {bytes(last?.memTotal)}</small></span>
          </div>
          <div class="stats">
            <span>avg {bytes(avg(memVals))}</span><span>peak {bytes(peak(memVals))}</span>{#if last?.memTotal}<span>{pct(last.mem / last.memTotal)} used</span>{/if}
          </div>
          <TimeSeries
            label="Memory use"
            points={metrics.points.map((p) => ({ t: p.t, v: p.mem }))}
            {window}
            max={last?.memTotal || Math.max(1, ...memVals)}
            format={bytes}
            color="var(--wb-lang-py)"
          />
        </div>
      </div>
      {#if last && Object.keys(last.rss).length}
        <ul class="procs">
          {#each Object.entries(last.rss) as [name, v] (name)}
            <li><Icon name="symbol-event" size={14} /><span>{name === "kernel" ? "Python kernel" : name}</span><span class="v">{bytes(v)}</span></li>
          {/each}
        </ul>
      {/if}
      <p class="endpoint">
        Prometheus can scrape every kernel's numbers at <code>/metrics</code>
        <button class="icon" title="Copy the address" aria-label="Copy the metrics address" onclick={copyEndpoint}><Icon name={copied ? "check" : "copy"} size={13} /></button>
      </p>
    </section>

    <div class="settings-controls config">
      <SandboxGroup {ctl} {ws} />
    </div>
  </div>
</OverlayPanel>

<style>
  .body {
    padding: 1rem 1.5rem 2rem;
    font-size: 0.8125rem;
  }
  .summary {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--wb-border);
    border-radius: 6px;
  }
  .kicon {
    display: flex;
    flex: none;
    padding-top: 0.125rem;
    color: var(--wb-fg);
  }
  .kicon.off {
    color: var(--wb-fg-dim);
  }
  .what {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    flex: 1;
    min-width: 0;
  }
  .what strong {
    font-size: 0.875rem;
  }
  .what span {
    color: var(--wb-fg-muted);
  }
  .versions {
    font-size: 0.72rem;
    color: var(--wb-fg-dim) !important;
  }
  .acts {
    display: flex;
    gap: 0.375rem;
    flex: none;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    height: 1.625rem;
    padding: 0 0.625rem;
    border-radius: 3px;
    color: var(--wb-fg);
    background: color-mix(in srgb, var(--wb-fg) 10%, transparent);
    font-size: 0.8125rem;
  }
  .btn:hover {
    color: var(--wb-fg);
    background: color-mix(in srgb, var(--wb-fg) 16%, transparent);
  }
  .live {
    margin-top: 1.25rem;
  }
  .live-head {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    margin-bottom: 0.625rem;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  .hint {
    color: var(--wb-fg-muted);
    font-size: 0.75rem;
  }
  .seg {
    display: flex;
    margin-left: auto;
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
    overflow: hidden;
    align-self: center;
  }
  .seg button {
    height: 1.375rem;
    padding: 0 0.625rem;
    border-radius: 0;
    font-size: 0.75rem;
    color: var(--wb-fg-muted);
  }
  .seg button + button {
    border-left: 1px solid var(--wb-input-border);
  }
  .seg button.on {
    color: #fff;
    background: var(--wb-accent);
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
  }
  .card {
    padding: 0.75rem 1rem 0.625rem;
    border: 1px solid var(--wb-border);
    border-radius: 6px;
    background: color-mix(in srgb, var(--wb-fg) 2%, transparent);
  }
  .card-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .name {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--wb-fg-muted);
  }
  .now {
    font-size: 1.375rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .now small {
    font-size: 0.75rem;
    font-weight: 400;
    color: var(--wb-fg-muted);
  }
  .stats {
    display: flex;
    gap: 0.75rem;
    margin: 0.125rem 0 0.875rem;
    font-size: 0.72rem;
    color: var(--wb-fg-muted);
    font-variant-numeric: tabular-nums;
  }
  .procs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.25rem;
    margin: 0.75rem 0 0;
    padding: 0;
    list-style: none;
    color: var(--wb-fg-muted);
  }
  .procs li {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }
  .procs .v {
    color: var(--wb-fg);
    font-variant-numeric: tabular-nums;
  }
  .endpoint {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin: 0.625rem 0 0;
    font-size: 0.72rem;
    color: var(--wb-fg-dim);
  }
  .endpoint code {
    font-size: 0.7rem;
  }
  .endpoint .icon {
    width: 1.25rem;
    height: 1.25rem;
    color: var(--wb-fg-muted);
  }
  .config {
    margin: 0.5rem -1.25rem 0;
  }
  .saved {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    margin-right: 0.5rem;
    font-size: 0.75rem;
    color: var(--good);
  }
  .saved.bad {
    color: var(--critical);
  }
  @media (max-width: 760px) {
    .cards {
      grid-template-columns: 1fr;
    }
    .summary {
      flex-wrap: wrap;
    }
  }
</style>
