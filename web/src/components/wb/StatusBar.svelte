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
  const where = $derived(info.sandbox === "firecracker" ? "Sandbox" : "Local");
  const state = $derived(
    { ready: "", starting: "Starting…", dead: "Stopped", offline: "Disconnected", none: "Idle" }[session as string] ?? "",
  );
  const errors = $derived(ctl.problems.filter((p) => p.severity !== "warning").length + (tpl.built?.error || tpl.frameError ? 1 : 0));
  const warnings = $derived(ctl.problems.filter((p) => p.severity === "warning").length);
  const changes = $derived((ctl.git?.cells.length ?? 0) + (ctl.git?.files.length ?? 0));
  const running = $derived(Object.entries(ctl.conn.runs).find(([, r]) => r.state === "running")?.[0]);
  const queued = $derived(Object.values(ctl.conn.runs).filter((r) => r.state === "queued").length);
  const version = $derived([info.python && `Python ${info.python}`, info.basalt && `basalt ${info.basalt}`].filter(Boolean).join(" · "));
</script>

<footer class="status">
  <div class="left">
    <Menu
      label={`${where}${state ? ` · ${state}` : ""}`}
      title={`${info.sandbox === "firecracker" ? "The kernel runs in a Firecracker microVM" : "The kernel runs as a local process"}${version ? ` (${version})` : ""}${info.egress ? `; it may reach ${info.egress}` : ""}`}
      items={[
        { label: "Restart the kernel", run: () => ctl.restart() },
        { label: "Stop what is running", run: () => ctl.interrupt(), disabled: !ctl.busy },
        "-",
        { label: "Sandbox: size and network", run: () => (ctl.sandbox = true) },
        { label: "Secrets", run: () => (ctl.secrets = true) },
      ]}
    />
    {#if ctl.git?.tracked}
      <button title="Source control{changes ? `: ${changes} change${changes === 1 ? "" : "s"}` : ""}" onclick={() => (wb.view = "scm")}>
        <Icon name="git-branch" size={14} />{ctl.git.branch ?? "detached"}{#if changes}<span>{changes}</span>{/if}
      </button>
    {/if}
    <button title="Problems" onclick={() => wb.togglePanel("problems")}>
      <Icon name="error" size={14} />{errors}
      <Icon name="warning" size={14} />{warnings}
    </button>
    {#if running}
      <button title="Stop" onclick={() => ctl.interrupt()}>
        <Icon name="loading" size={14} spin />Running {running}{queued ? ` (+${queued})` : ""}
      </button>
    {:else if ctl.staleCount}
      <button title="Run the outdated cells, and what they need" onclick={() => ctl.runStale()}>
        <Icon name="run-errors" size={14} />{ctl.staleCount} outdated
      </button>
    {/if}
    {#if ctl.conn.secretsStale}
      <button class="warn" title="The kernel still has the old values: restart it" onclick={() => ctl.restart()}>Secrets changed · Restart</button>
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
  .status button:active {
    transform: none;
  }
  .warn {
    color: var(--stale) !important;
  }
</style>
