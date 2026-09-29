<script lang="ts" module>
  import type { Action } from "../../lib/api";
  // each group, and what it takes to change it
  const GROUPS: { id: string; label: string; needs: Action }[] = [
    { id: "ws-general", label: "General", needs: "workspace.manage" },
    { id: "ws-access", label: "Access", needs: "workspace.manageAccess" },
    { id: "ws-ai", label: "AI access", needs: "ai.configure" },
    { id: "ws-sandbox", label: "Sandbox", needs: "sandbox.manage" },
    { id: "ws-environment", label: "Environment", needs: "environment.manage" },
    { id: "ws-connections", label: "Connections", needs: "connection.manage" },
    { id: "ws-attributes", label: "Attributes", needs: "workspace.manage" },
    { id: "ws-manage", label: "Manage", needs: "workspace.manage" },
  ];
  /** The groups they may change in `w`: the others aren't shown. */
  export const workspaceToc = (w: { permissions?: Action[] } | null) => GROUPS.filter((g) => w?.permissions?.includes(g.needs)).map(({ id, label }) => ({ id, label }));
</script>

<script lang="ts">
  import Select from "../ui/Select.svelte";
  import { api, type AiLevel, type ConnectionInfo, type SandboxSettings, type WorkspaceSummary } from "../../lib/api";
  import ConnectionList from "../connections/ConnectionList.svelte";
  import EnvironmentGroup from "./EnvironmentGroup.svelte";
  import { wsHref } from "../../lib/href";
  import { promptDeleteWorkspace, renameWorkspace, slugify } from "../../lib/notebooks";
  import Icon from "../Icon.svelte";
  import ManageAccess from "../auth/ManageAccess.svelte";
  import { can } from "../../lib/can";
  import { useSettings } from "./context";
  import Setting from "./Setting.svelte";
  import { AI_LEVELS, MEMORY, VCPUS } from "./shared";

  // A workspace's settings: what every notebook in it gets unless it sets its own.
  // A change applies at once. `renamed` says where the workspace went.
  let { w, onchanged, renamed }: { w: WorkspaceSummary; onchanged: () => Promise<void>; renamed: (name: string) => void } = $props();

  const settings = useSettings();
  async function apply(patch: Parameters<typeof api.workspace.settings>[1], what: string) {
    try {
      await api.workspace.settings(w.name, patch);
      await onchanged();
      settings.report("saved", `${what}: saved`);
      return true;
    } catch (e: any) {
      settings.report("error", e.message);
      return false;
    }
  }

  // -- general
  // svelte-ignore state_referenced_locally
  let title = $state(w.title);
  // svelte-ignore state_referenced_locally
  let description = $state(w.description ?? "");
  // svelte-ignore state_referenced_locally
  let folder = $state(w.name);
  const folderSlug = $derived(slugify(folder));
  async function rename() {
    if (!folderSlug || folderSlug === w.name) return;
    try {
      renamed(await renameWorkspace(w.name, folderSlug, w.notebooks.map((b) => b.id)));
    } catch (e: any) {
      settings.report("error", e.message);
    }
  }

  // -- sandbox
  const sandbox = $derived<SandboxSettings>(w.sandbox ?? {});
  let egressDraft = $state("");
  async function saveSandbox(next: SandboxSettings, what: string) {
    const clean = { vcpus: next.vcpus, memory: next.memory, egress: next.egress?.length ? next.egress : undefined };
    const empty = clean.vcpus == null && clean.memory == null && !clean.egress;
    return apply({ sandbox: empty ? null : clean }, what);
  }
  async function addEgress(e: SubmitEvent) {
    e.preventDefault();
    const t = egressDraft.trim();
    if (!t || sandbox.egress?.includes(t)) return;
    if (await saveSandbox({ ...sandbox, egress: [...(sandbox.egress ?? []), t] }, "Network")) egressDraft = "";
  }

  let managing = $state(false);

  // -- connections: the workspace's own (everyone's are the User settings')
  let conns = $state<ConnectionInfo[]>([]);
  async function loadConnections() {
    try {
      conns = (await api.connections.list(w.name)).connections.filter((c) => c.workspace === w.name);
    } catch (e: any) {
      settings.report("error", e.message);
    }
  }
  // svelte-ignore state_referenced_locally
  if (can(w, "connection.manage")) loadConnections();

  // -- attributes, edited as rows and saved whole
  // svelte-ignore state_referenced_locally
  let attrs = $state<{ k: string; v: string }[]>(Object.entries(w.attributes ?? {}).map(([k, v]) => ({ k, v })));
  const attrMap = () => Object.fromEntries(attrs.filter((a) => a.k.trim()).map((a) => [a.k.trim(), a.v]));
  const attrsDirty = $derived(JSON.stringify(attrMap()) !== JSON.stringify(w.attributes ?? {}));
  async function saveAttrs() {
    const map = attrMap();
    if (await apply({ attributes: Object.keys(map).length ? map : null }, "Attributes")) attrs = Object.entries(map).map(([k, v]) => ({ k, v }));
  }
</script>

{#snippet connInfo()}
  A connection gives a kernel environment variables: one named <code>sr</code> gives <code>SR_USER</code> and <code>SR_PASS</code>, which
  <code>CREATE CONNECTION sr</code> reads by itself; OPTIONS take <code>token = env('GH_TOKEN')</code>; Python reads <code>os.environ</code>.
  Credentials are shared, or each person's own.
{/snippet}

{#snippet attrInfo()}
  Keys: a letter, then letters, digits, <code>_ . -</code>. Values: up to 200 characters. A policy reads one as
  <code>resource.getTag("team")</code>.
{/snippet}


{#if can(w, "workspace.manage")}
<section class="group" id="set-ws-general">
  <h2>General</h2>
  <Setting id="workspace.title" category="General" label="Title" description="How the workspace is shown. Its folder name stays the same." modified={w.title !== w.name} onreset={() => apply({ title: w.name }, "Title").then(() => (title = w.name))}>
    <input bind:value={title} onchange={() => apply({ title }, "Title")} aria-label="Title" />
  </Setting>
  <Setting id="workspace.description" category="General" label="Description" description="What its notebooks are for, shown on its page." modified={!!w.description} onreset={() => apply({ description: null }, "Description").then(() => (description = ""))}>
    <textarea rows="2" bind:value={description} onchange={() => apply({ description: description.trim() || null }, "Description")} aria-label="Description"></textarea>
  </Setting>
  <Setting
    id="workspace.folder"
    category="General"
    label="Folder name"
    description="Its address and its folder on the server."
    info="Renaming moves its notebooks' addresses too; their connections and AI access follow, and open tabs are taken to the new place."
  >
    <div class="row">
      <input class="mono" bind:value={folder} spellcheck="false" aria-label="Folder name" onkeydown={(e) => e.key === "Enter" && rename()} />
      <button class="btn" disabled={!folderSlug || folderSlug === w.name} onclick={rename}>Rename</button>
    </div>
    {#if folderSlug && folderSlug !== folder}<p class="sub">Becomes <code>{folderSlug}</code></p>{/if}
  </Setting>
</section>
{/if}

{#if can(w, "workspace.manageAccess")}
<section class="group" id="set-ws-access">
  <h2>Access</h2>
  <Setting
    id="workspace.access"
    category="Access"
    label="People and groups"
    description="Who may see, run and change this workspace's notebooks: roles for people, directory groups, everyone, or everyone whose attributes match a condition."
  >
    <button class="btn" onclick={() => (managing = true)}><Icon name="organization" size={14} />Manage access…</button>
  </Setting>
</section>
{/if}

{#if can(w, "ai.configure")}
<section class="group" id="set-ws-ai">
  <h2>AI access</h2>
  <Setting
    id="workspace.ai.level"
    category="AI access"
    label="Default level"
    description="What AI clients connected over MCP may do in this workspace's notebooks, unless a notebook sets its own."
    modified={w.ai !== "read"}
    onreset={() => apply({ ai: "read" }, "AI access")}
  >
    <Select
      value={w.ai}
      options={AI_LEVELS.map((l) => ({ value: l.level, label: l.label, hint: l.level === "read" ? "default" : undefined, description: l.what }))}
      onchange={(v) => apply({ ai: v }, "AI access")}
      label="Default level"
    />
  </Setting>
</section>
{/if}

{#if can(w, "sandbox.manage")}
<section class="group" id="set-ws-sandbox">
  <h2>Sandbox</h2>
  <Setting id="workspace.sandbox.vcpus" category="Sandbox" label="vCPUs" description="Processors for each notebook's microVM. A notebook may set its own." modified={sandbox.vcpus != null} onreset={() => saveSandbox({ ...sandbox, vcpus: undefined }, "vCPUs")}>
    <Select
      value={sandbox.vcpus ?? ""}
      options={[{ value: "" as const, label: "Querier's default (2)" }, ...VCPUS.map((n) => ({ value: n, label: String(n) }))]}
      onchange={(v) => saveSandbox({ ...sandbox, vcpus: v === "" ? undefined : v }, "vCPUs")}
      label="vCPUs"
    />
  </Setting>
  <Setting id="workspace.sandbox.memory" category="Sandbox" label="Memory" description="Memory for each notebook's microVM. A notebook may set its own." modified={sandbox.memory != null} onreset={() => saveSandbox({ ...sandbox, memory: undefined }, "Memory")}>
    <Select
      value={sandbox.memory ?? ""}
      options={[{ value: "" as const, label: "Querier's default (2 GB)" }, ...MEMORY.map(([mb, l]) => ({ value: mb, label: l }))]}
      onchange={(v) => saveSandbox({ ...sandbox, memory: v === "" ? undefined : v }, "Memory")}
      label="Memory"
    />
  </Setting>
  <Setting
    id="workspace.sandbox.egress"
    category="Sandbox"
    label="Network"
    description="Destinations every notebook in this workspace may connect to, over TCP; everything else is refused. A notebook's own list adds to this one."
    modified={!!sandbox.egress?.length}
    onreset={() => saveSandbox({ ...sandbox, egress: undefined }, "Network")}
  >
    <ul class="list">
      {#each sandbox.egress ?? [] as t (t)}
        <li>
          <Icon name="plug" size={14} /><code class="grow">{t}</code>
          <button class="icon" title="Remove {t}" aria-label="Remove {t}" onclick={() => saveSandbox({ ...sandbox, egress: sandbox.egress!.filter((x) => x !== t) }, "Network")}><Icon name="close" size={14} /></button>
        </li>
      {/each}
    </ul>
    <form class="row" onsubmit={addEgress}>
      <input class="mono" bind:value={egressDraft} placeholder="host:port, e.g. db.internal:5432" spellcheck="false" aria-label="Destination" />
      <button class="btn" type="submit" disabled={!egressDraft.trim()}>Allow</button>
    </form>
  </Setting>
</section>
{/if}

{#if can(w, "environment.manage")}
  <EnvironmentGroup scope="workspace" target={w.name} prefix="ws" />
{/if}

{#if can(w, "connection.manage")}
<section class="group" id="set-ws-connections">
  <h2>Connections</h2>
  <Setting
    id="workspace.connections"
    category="Connections"
    label="This workspace's connections"
    description="What its notebooks' kernels may reach, and with which credentials. Its Contributors run with them."
    info={connInfo}
    modified={conns.length > 0}
  >
    <ConnectionList items={conns} onchanged={loadConnections} empty="None yet. Everyone's connections (User settings) reach its notebooks too." create={{ workspace: w.name }} />
  </Setting>
</section>
{/if}

{#if can(w, "workspace.manage")}
<section class="group" id="set-ws-attributes">
  <h2>Attributes</h2>
  <Setting
    id="workspace.attributes"
    category="Attributes"
    label="Tags"
    description="Tags describing the workspace (team, cost center, classification). Access policies can read them."
    info={attrInfo}
    modified={Object.keys(w.attributes ?? {}).length > 0}
    onreset={() => apply({ attributes: null }, "Attributes").then(() => (attrs = []))}
  >
    {#if attrs.length}
      <div class="attrs">
        {#each attrs as a, i (i)}
          <input class="mono" bind:value={a.k} placeholder="key" aria-label="Key" spellcheck="false" />
          <input bind:value={a.v} placeholder="value" aria-label="Value of {a.k || 'the attribute'}" spellcheck="false" />
          <button class="icon" title="Remove" aria-label="Remove {a.k}" onclick={() => attrs.splice(i, 1)}><Icon name="close" size={14} /></button>
        {/each}
      </div>
    {/if}
    <div class="row">
      <button class="btn" onclick={() => attrs.push({ k: "", v: "" })}><Icon name="add" size={14} />Add attribute</button>
      {#if attrsDirty}<button class="btn primary" onclick={saveAttrs}>Save attributes</button>{/if}
    </div>
  </Setting>
</section>
{/if}

{#if can(w, "workspace.manage")}
<section class="group" id="set-ws-manage">
  <h2>Manage</h2>
  <Setting
    id="workspace.delete"
    category="Manage"
    label="Delete this workspace"
    description={w.notebooks.length
      ? `Its ${w.notebooks.length} notebook${w.notebooks.length === 1 ? "" : "s"} are deleted with it, every file in them, and its connections and settings.`
      : "It holds no notebooks; its connections and settings go with it."}
  >
    <button class="btn danger" onclick={() => promptDeleteWorkspace(w.name, w.title, w.notebooks.map((b) => b.id)).then((ok) => void (ok && onchanged()))}>
      <Icon name="trash" size={14} />Delete workspace…
    </button>
  </Setting>
</section>
{/if}

{#if managing}<ManageAccess what={{ scope: "workspace", target: w.name, title: w.title, permissions: w.permissions }} onclose={() => (managing = false)} />{/if}

<style>
  .attrs {
    display: grid;
    grid-template-columns: 11rem minmax(0, 1fr) auto;
    gap: 0.375rem;
    width: min(100%, 32rem);
    margin-bottom: 0.375rem;
  }
  .attrs input {
    width: 100% !important;
  }
  .attrs .icon {
    width: 1.375rem;
    height: 1.625rem;
  }
</style>
