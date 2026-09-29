<script lang="ts">
  import Select from "../ui/Select.svelte";
  import { api, type SandboxSettings, type WorkspaceSummary } from "../../lib/api";
  import type { NotebookCtl } from "../../lib/notebook.svelte";
  import Icon from "../Icon.svelte";
  import { useSettings } from "./context";
  import Setting from "./Setting.svelte";
  import { MEMORY, memoryLabel, SANDBOX_DEFAULT, VCPUS } from "./shared";

  // A notebook's sandbox: the microVM's size and where it may connect. In the
  // Settings editor's Notebook scope, and in the sandbox panel (the status bar's).
  let { ctl, ws }: { ctl: NotebookCtl; ws: WorkspaceSummary | null } = $props();

  const settings = useSettings();
  const book = $derived(ctl.book);
  async function apply(patch: Parameters<typeof api.settings>[1], what: string) {
    try {
      await api.settings(ctl.name, patch);
      await ctl.refresh();
      settings.report("saved", `${what}: saved`);
      return true;
    } catch (e: any) {
      settings.report("error", e.message);
      return false;
    }
  }

  // -- sandbox
  const sandbox = $derived<SandboxSettings>(book?.sandbox ?? {});
  const inherited = $derived<SandboxSettings>(ws?.sandbox ?? {});
  const egress = $derived(sandbox.egress ?? []);
  const wsEgress = $derived(inherited.egress ?? []);
  const suggestions = $derived([...ctl.sandboxRefs].filter(([t]) => !egress.includes(t) && !wsEgress.includes(t)));
  const sandboxed = $derived(ctl.conn.info.sandbox === "firecracker");
  let sandboxChanged = $state(false);
  let egressDraft = $state("");
  async function saveSandbox(next: SandboxSettings, what: string) {
    const clean = { vcpus: next.vcpus, memory: next.memory, egress: next.egress?.length ? next.egress : undefined };
    const empty = clean.vcpus == null && clean.memory == null && !clean.egress;
    const ok = await apply({ sandbox: empty ? null : clean }, what);
    if (ok) sandboxChanged = true;
    return ok;
  }
  async function allow(target: string) {
    const t = target.trim();
    if (!t || egress.includes(t)) return;
    if (await saveSandbox({ ...sandbox, egress: [...egress, t] }, "Network")) egressDraft = "";
  }

</script>

<section class="group" id="set-nb-sandbox">
  <h2>Sandbox</h2>
  {#if ctl.conn.session === "ready" && !sandboxed}
    <p class="note"><span>The kernel runs locally, as plain processes: these apply when Querier runs from its Docker image.</span></p>
  {:else if sandboxChanged && ctl.conn.session === "ready"}
    <p class="note"><span>The running kernel still has the previous sandbox.</span><button class="btn" onclick={() => (ctl.restart(), (sandboxChanged = false))}>Restart kernel</button></p>
  {/if}
  <Setting
    id="notebook.sandbox.vcpus"
    category="Sandbox"
    label="vCPUs"
    description="Processors for this notebook's microVM."
    modified={sandbox.vcpus != null}
    onreset={() => saveSandbox({ ...sandbox, vcpus: undefined }, "vCPUs")}
  >
    <Select
      value={sandbox.vcpus ?? ""}
      options={[{ value: "" as const, label: `Workspace default (${inherited.vcpus ?? SANDBOX_DEFAULT.vcpus})` }, ...VCPUS.map((n) => ({ value: n, label: String(n) }))]}
      onchange={(v) => saveSandbox({ ...sandbox, vcpus: v === "" ? undefined : v }, "vCPUs")}
      label="vCPUs"
    />
  </Setting>
  <Setting
    id="notebook.sandbox.memory"
    category="Sandbox"
    label="Memory"
    description="Memory for this notebook's microVM."
    modified={sandbox.memory != null}
    onreset={() => saveSandbox({ ...sandbox, memory: undefined }, "Memory")}
  >
    <Select
      value={sandbox.memory ?? ""}
      options={[
        { value: "" as const, label: `Workspace default (${memoryLabel(inherited.memory ?? SANDBOX_DEFAULT.memory)})` },
        ...MEMORY.map(([mb, l]) => ({ value: mb, label: l })),
      ]}
      onchange={(v) => saveSandbox({ ...sandbox, memory: v === "" ? undefined : v }, "Memory")}
      label="Memory"
    />
  </Setting>
  <Setting
    id="notebook.sandbox.egress"
    category="Sandbox"
    label="Network"
    description="Where the kernel may connect, over TCP; everything else is refused."
    info="The workspace's destinations apply too. There is no DNS inside: names are resolved when the kernel starts."
    modified={egress.length > 0}
    onreset={() => saveSandbox({ ...sandbox, egress: undefined }, "Network")}
  >
    <ul class="list">
      {#each wsEgress as t (t)}
        <li title="Allowed for every notebook in the workspace: change it in its settings">
          <Icon name="plug" size={14} /><code class="grow">{t}</code><span class="tag">Workspace</span>
        </li>
      {/each}
      {#each egress as t (t)}
        <li>
          <Icon name="plug" size={14} /><code class="grow">{t}</code>
          <span>{ctl.sandboxRefs.get(t) ?? ""}</span>
          <button class="icon" title="Remove {t}" aria-label="Remove {t}" onclick={() => saveSandbox({ ...sandbox, egress: egress.filter((x) => x !== t) }, "Network")}><Icon name="close" size={14} /></button>
        </li>
      {/each}
    </ul>
    <form class="row" onsubmit={(e) => (e.preventDefault(), allow(egressDraft))}>
      <input class="mono" bind:value={egressDraft} placeholder="host:port, e.g. 10.140.0.7:9030" spellcheck="false" aria-label="Destination" />
      <button class="btn" type="submit" disabled={!egressDraft.trim()}>Allow</button>
    </form>
    {#if suggestions.length}
      <div class="suggest">
        <span>This notebook connects to</span>
        {#each suggestions as [t, why] (t)}
          <button class="btn" title={why} onclick={() => allow(t)}><Icon name="add" size={12} />{t}</button>
        {/each}
      </div>
    {/if}
  </Setting>
</section>

<style>
  .suggest {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.5rem;
    font-size: 0.75rem;
    color: var(--wb-fg-muted);
  }
</style>
