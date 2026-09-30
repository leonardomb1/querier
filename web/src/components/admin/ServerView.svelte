<script lang="ts">
  import { onMount } from "svelte";
  import { api, type ServerStatus } from "../../lib/api";
  import { ask } from "../../lib/dialog.svelte";
  import { ago } from "../../lib/format";
  import { nbHref } from "../../lib/href";
  import { session as me } from "../../lib/session.svelte";
  import Icon from "../Icon.svelte";

  // The server as it is now: the machine (CPUs, memory, load), every running kernel
  // (whose, what kind, what it uses) with a way to stop one, and everyone signed in
  // with a way to sign them out. Read again every few seconds while shown.
  let s = $state<ServerStatus | null>(null);
  let error = $state("");
  let busy = $state<string | null>(null);

  async function load() {
    try {
      s = await api.admin.server();
      error = "";
    } catch (e: any) {
      error = e.message;
    }
  }
  onMount(() => {
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 3000);
    return () => clearInterval(t);
  });

  async function stop(k: ServerStatus["kernels"][number]) {
    const whose = k.owner ? `${k.owner.name}'s` : "the";
    if (!(await ask(`Stop ${whose} kernel of ${k.notebook}?`, { detail: "What it holds (tables, variables) is gone; their tabs are told, and their next run starts a new one.", ok: "Stop", danger: true }))) return;
    busy = k.id;
    await api.admin.stopKernel(k.id).catch((e) => (error = e.message));
    busy = null;
    load();
  }

  async function signOut(x: ServerStatus["sessions"][number]) {
    const detail = x.yours
      ? "This is your own session: you'll be back at the sign-in page."
      : `Their open tabs are disconnected at once; they can sign in again${x.who.sysadmin ? "" : " if their directory and the policies still let them"}.`;
    if (!(await ask(`Sign ${x.yours ? "yourself" : x.who.name} out?`, { detail, ok: "Sign out", danger: true }))) return;
    busy = x.id;
    await api.admin.revokeSession(x.id).catch((e) => (error = e.message));
    busy = null;
    if (x.yours) return void me.signOut();
    load();
  }

  const pct = (n: number | null | undefined) => (n == null ? "—" : `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`);
  function bytes(n: number | null | undefined) {
    if (n == null) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) (n /= 1024), i++;
    return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
  }
  function span(sec: number) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }
  const inFuture = (t: number) => span(Math.max(0, (t - Date.now()) / 1000));
  const KIND = { live: "notebook", report: "report viewer", schedule: "scheduled run" } as const;

  const memUsed = $derived(s ? s.machine.memTotal - s.machine.memFree : 0);
  const people = $derived(s ? new Set(s.sessions.map((x) => x.who.id)).size : 0);
</script>

<div class="adm server">
  <header class="adm-head">
    <div class="grow">
      <h2>Server</h2>
      <p>The machine, the kernels running on it, and who is signed in. Updated every few seconds.</p>
    </div>
  </header>
  {#if error}<p class="error">{error}</p>{/if}

  {#if s}
    <div class="tiles">
      <div class="tile">
        <span class="l"><Icon name="pulse" size={14} />CPU</span>
        <span class="v">{pct(s.machine.cpu)}</span>
        <span class="d">of {s.machine.cpus} CPUs · load {s.machine.load.map((x) => x.toFixed(2)).join(" ")}</span>
      </div>
      <div class="tile">
        <span class="l"><Icon name="chip" size={14} />Memory</span>
        <span class="v">{bytes(memUsed)}</span>
        <span class="d">of {bytes(s.machine.memTotal)} · {pct(memUsed / s.machine.memTotal)} used · Querier {bytes(s.machine.querierRss)}</span>
      </div>
      <div class="tile">
        <span class="l"><Icon name={s.runner === "firecracker" ? "vm" : "server-process"} size={14} />Kernels</span>
        <span class="v">{s.limits.running} <small>of {s.limits.total}</small></span>
        <span class="d">
          {s.runner === "firecracker" ? "microVMs" : "local processes"} · {s.limits.perUser} per person · {s.limits.idle ? `stopped after ${span(s.limits.idle / 1000)} unused` : "never stopped when unused"}
        </span>
      </div>
      <div class="tile">
        <span class="l"><Icon name="account" size={14} />Signed in</span>
        <span class="v">{people} <small>{people === 1 ? "person" : "people"}</small></span>
        <span class="d">{s.sessions.length} session{s.sessions.length === 1 ? "" : "s"} · up {span(s.machine.querierUptime)} (the machine {span(s.machine.uptime)})</span>
      </div>
    </div>

    <h3>Kernels</h3>
    {#if s.kernels.length}
      <table>
        <thead>
          <tr><th>Notebook</th><th>Whose</th><th class="n">State</th><th class="n">CPU</th><th class="n">Memory</th><th class="n">Started</th><th class="n">Last used</th><th class="n">Tabs</th><th class="a"></th></tr>
        </thead>
        <tbody>
          {#each s.kernels as k (k.id)}
            <tr>
              <td><a href={nbHref(k.notebook)} title={k.notebook}>{k.notebook}</a>{#if k.kind !== "live"}<span class="tag">{KIND[k.kind]}</span>{/if}</td>
              <td title={k.owner?.id}>{k.owner?.name ?? "—"}</td>
              <td class="n"><span class="state {k.state}">{k.state}</span></td>
              <td class="n">{pct(k.point?.cpu)}</td>
              <td class="n" title={k.point ? `${bytes(k.point.mem)} of ${bytes(k.point.memTotal)}` : ""}>{bytes(k.point?.mem)}</td>
              <td class="n">{k.startedAt ? ago(k.startedAt) : "—"}</td>
              <td class="n">{ago(k.lastUsed)}</td>
              <td class="n" title="{k.tabs} open tab{k.tabs === 1 ? '' : 's'}, {k.terminals} terminal{k.terminals === 1 ? '' : 's'}">{k.tabs}{#if k.terminals}<span class="term" title="terminals"><Icon name="terminal" size={12} />{k.terminals}</span>{/if}</td>
              <td class="a"><button class="btn" disabled={busy === k.id} onclick={() => stop(k)}>Stop</button></td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <p class="muted">No kernel is running.</p>
    {/if}

    <h3>Sessions</h3>
    <table>
      <thead>
        <tr><th>Who</th><th>Signed in with</th><th class="n t">Since</th><th class="n t">Last seen</th><th class="n">Ends in</th><th class="n o" title="open tabs and connections">Open</th><th class="a"></th></tr>
      </thead>
      <tbody>
        {#each s.sessions as x (x.id)}
          <tr>
            <td title={x.who.id}>{x.who.sysadmin ? x.who.username : x.who.name}{#if x.yours}<span class="tag">you, here</span>{/if}</td>
            <td>{x.who.sysadmin ? "built-in account" : `${x.who.username} · ${x.provider}`}</td>
            <td class="n t" title={new Date(x.created).toLocaleString()}>{ago(x.created)}</td>
            <td class="n t" title={new Date(x.lastSeen).toLocaleString()}>{ago(x.lastSeen)}</td>
            <td class="n" title={new Date(x.expires).toLocaleString()}>{inFuture(x.expires)}</td>
            <td class="n o" title="open tabs and connections">{x.sockets}</td>
            <td class="a"><button class="btn" disabled={busy === x.id} onclick={() => signOut(x)}>Sign out</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="note">Prometheus can scrape every kernel's numbers at <code>/metrics</code>.</p>
  {:else if !error}
    <p class="muted">Loading…</p>
  {/if}
</div>

<style>
  .server {
    max-width: 76rem !important;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
    gap: 0.625rem;
    margin-bottom: 1.25rem;
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
    padding: 0.75rem 0.875rem;
    background: var(--wb-bar);
    border: 1px solid var(--wb-border);
    border-radius: 6px;
  }
  .tile .l {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    color: var(--wb-fg-muted);
  }
  .tile .v {
    font-size: 1.375rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .tile .v small {
    font-size: 0.8125rem;
    font-weight: 400;
    color: var(--wb-fg-muted);
  }
  .tile .d {
    font-size: 0.72rem;
    color: var(--wb-fg-muted);
    overflow-wrap: anywhere;
  }
  /* fixed columns: a long name is cut short, and the buttons stay in view */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
    margin-bottom: 1.25rem;
    table-layout: fixed;
  }
  th {
    padding: 0.375rem 0.5rem;
    text-align: left;
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--wb-fg-muted);
    border-bottom: 1px solid var(--wb-border);
    white-space: nowrap;
  }
  td {
    padding: 0.3125rem 0.5rem;
    border-bottom: 1px solid var(--wb-border);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  tr:hover td {
    background: var(--wb-list-hover);
  }
  .n {
    width: 5.25rem;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .n.o {
    width: 3.5rem;
  }
  .n.t {
    width: 7rem;
  }
  .a {
    width: 5.75rem;
    text-align: right;
  }
  td a {
    color: var(--wb-fg);
  }
  td a:hover {
    color: var(--wb-accent);
  }
  .tag {
    margin-left: 0.5rem;
    padding: 0 0.375rem;
    font-size: 0.6875rem;
    color: var(--wb-fg-muted);
    border: 1px solid var(--wb-border);
    border-radius: 3px;
  }
  .state.running {
    color: var(--good);
  }
  .state.starting {
    color: var(--warning);
  }
  .state.idle {
    color: var(--wb-fg-muted);
  }
  .term {
    display: inline-flex;
    align-items: center;
    gap: 0.125rem;
    margin-left: 0.375rem;
    color: var(--wb-fg-muted);
  }
  .muted,
  .note {
    font-size: 0.8125rem;
    color: var(--wb-fg-muted);
  }
  .note code {
    font-size: 0.75rem;
  }
  .error {
    color: var(--critical);
  }
</style>
