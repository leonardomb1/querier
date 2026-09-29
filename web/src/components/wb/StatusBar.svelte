<script lang="ts">
  import type { NotebookCtl } from "../../lib/notebook.svelte";
  import type { TemplateCtl } from "../../lib/template.svelte";
  import type { Workbench } from "../../lib/workbench.svelte";
  import { zoom } from "../../lib/zoom.svelte";
  import Icon from "../Icon.svelte";
  import Menu from "../Menu.svelte";

  // The status bar, as VS Code's: where the kernel runs and how it is, the branch,
  // problems, what is running — and on the right, where the cursor is.
  let { ctl, wb, tpl }: { ctl: NotebookCtl; wb: Workbench; tpl: TemplateCtl } = $props();

  const session = $derived(ctl.conn.session);
  const info = $derived(ctl.conn.info);
  const vm = $derived(info.sandbox === "firecracker");
  const state = $derived(
    ctl.conn.stopped && session === "none"
      ? "Stopped: unused for a while"
      : ({ ready: "", starting: "Starting…", dead: "Stopped", offline: "Disconnected", none: "Not started" }[session as string] ?? ""),
  );
  const last = $derived(ctl.conn.metrics.points.at(-1));
  // the kernel's state is the icon's: VS Code's way, no coloured lights
  const kernelIcon = $derived(
    session === "starting"
      ? { name: "loading", spin: true }
      : session === "offline"
        ? { name: "debug-disconnect", spin: false }
        : session !== "ready"
          ? { name: "vm-outline", spin: false }
          : ctl.busy
            ? { name: vm ? "vm-running" : "server-process", spin: false }
            : { name: vm ? "vm-active" : "server-process", spin: false },
  );
  const mb = (n: number) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${Math.round(n / (1 << 20))} MB`);
  const tooltip = $derived(
    [
      `Sandbox: ${vm ? "Firecracker microVM" : "local process"}${state ? ` · ${state}` : ctl.busy ? " · running a cell" : " · idle"}`,
      session === "ready" && last ? `CPU ${last.cpu == null ? "—" : `${Math.round(last.cpu * 100)}%`} · memory ${mb(last.mem)} of ${mb(last.memTotal)}` : "",
      "Click for usage, the kernel and its settings",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const errors = $derived(ctl.problems.filter((p) => p.severity !== "warning").length + (tpl.built?.error || tpl.frameError ? 1 : 0));
  const warnings = $derived(ctl.problems.filter((p) => p.severity === "warning").length);
  const changes = $derived((ctl.git?.cells.length ?? 0) + (ctl.git?.files.length ?? 0));
  const running = $derived(Object.entries(ctl.conn.runs).find(([, r]) => r.state === "running")?.[0]);
  const queued = $derived(Object.values(ctl.conn.runs).filter((r) => r.state === "queued").length);
  const version = $derived([info.python && `Python ${info.python}`, info.basalt && `basalt ${info.basalt}`].filter(Boolean).join(" · "));
</script>

<footer class="status" style:view-transition-name="wb-status">
  <div class="left">
    <button class="sandbox" class:open={ctl.sandboxPanel} title={tooltip} aria-label="Sandbox: {state || 'running'}" onclick={() => (ctl.sandboxPanel = !ctl.sandboxPanel)}>
      <span class="kicon" class:off={session !== "ready" && session !== "starting"}><Icon name={kernelIcon.name} size={15} spin={kernelIcon.spin} /></span>
    </button>
    {#if ctl.git?.tracked}
      <button title="Source control{changes ? `: ${changes} change${changes === 1 ? "" : "s"}` : ""}" onclick={() => (wb.view = "scm")}>
        <Icon name="git-branch" size={14} />{ctl.git.branch ?? "detached"}{#if changes}<span>{changes}</span>{/if}
      </button>
    {/if}
    <button title="Problems" onclick={() => wb.togglePanel("problems")}>
      <Icon name="error" size={14} />{errors}
      <Icon name="warning" size={14} />{warnings}
    </button>
    {#if running && ctl.mayRun}
      <button title="Stop" onclick={() => ctl.interrupt()}>
        <Icon name="loading" size={14} spin />Running {running}{queued ? ` (+${queued})` : ""}
      </button>
    {:else if running}
      <span><Icon name="loading" size={14} spin />Running {running}{queued ? ` (+${queued})` : ""}</span>
    {:else if ctl.staleCount && ctl.mayRun}
      <button title="Run the outdated cells, and what they need" onclick={() => ctl.runStale()}>
        <Icon name="run-errors" size={14} />{ctl.staleCount} outdated
      </button>
    {/if}
    {#if ctl.conn.envStale && ctl.mayRun}
      <button class="warn" title="The kernel still has the previous packages: restart it" onclick={() => ctl.restart()}>Environment changed · Restart</button>
    {/if}
    {#if ctl.conn.secretsStale && ctl.mayRun}
      <button class="warn" title="The kernel still has the old credentials: restart it" onclick={() => ctl.restart()}>Credentials changed · Restart</button>
    {/if}
  </div>
  <div class="right">
    {#if wb.cursor}
      <span>Ln {wb.cursor.line}, Col {wb.cursor.col}</span>
      <span>{wb.cursor.lang}</span>
    {/if}
    <button title="Zoom: Ctrl+= / Ctrl+- (click to reset)" onclick={zoom.reset}>{Math.round(zoom.value * 100)}%</button>
  </div>
</footer>

<style>
  .status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 1.375rem;
    padding: 0 0.5rem;
    font-size: 0.75rem;
    color: var(--wb-fg);
    background: var(--wb-bar);
    border-top: 1px solid var(--wb-border);
    user-select: none;
  }
  .left,
  .right {
    display: flex;
    align-items: center;
    height: 100%;
    min-width: 0;
  }
  .status button,
  .status :global(button.text),
  .left > span,
  .right span {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    height: 100%;
    padding: 0 0.4375rem;
    border-radius: 0;
    font-size: 0.75rem;
    color: var(--wb-fg);
    white-space: nowrap;
  }
  .status button:hover,
  .status :global(button.text:hover) {
    background: var(--wb-list-hover);
  }
  /* a click is felt: the item darkens as it is pressed */
  .status button:active {
    transform: none;
    background: var(--wb-list-active);
    transition-duration: 0s;
  }
  .sandbox.open {
    background: var(--wb-list-active);
  }
  .kicon {
    position: relative;
    display: inline-flex;
  }
  .kicon.off {
    color: var(--wb-fg-muted);
  }
</style>
