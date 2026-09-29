<script lang="ts" module>
  import type { Action } from "../../lib/api";
  type Perms = { permissions?: Action[] } | null | undefined;
  // each group, and what it takes to change it (Attributes: the workspace's Admin)
  const GROUPS: { id: string; label: string; needs: Action; of?: "workspace" }[] = [
    { id: "nb-general", label: "General", needs: "notebook.edit" },
    { id: "nb-sharing", label: "Sharing", needs: "notebook.share" },
    { id: "nb-ai", label: "AI access", needs: "ai.configure" },
    { id: "nb-sandbox", label: "Sandbox", needs: "sandbox.manage" },
    { id: "nb-environment", label: "Environment", needs: "environment.manage" },
    { id: "nb-connections", label: "Connections", needs: "notebook.run" },
    { id: "nb-attributes", label: "Attributes", needs: "workspace.manage", of: "workspace" },
    { id: "nb-manage", label: "Manage", needs: "notebook.delete" },
  ];
  /** The groups they may change: the others aren't shown. */
  export const notebookToc = (book: Perms, ws: Perms) =>
    GROUPS.filter((g) => (g.of ? ws : book)?.permissions?.includes(g.needs)).map(({ id, label }) => ({ id, label }));
</script>

<script lang="ts">
  import Select from "../ui/Select.svelte";
  import { api, splitId, type AiLevel, type WorkspaceSummary } from "../../lib/api";
  import ConnectionList from "../connections/ConnectionList.svelte";
  import EnvironmentGroup from "./EnvironmentGroup.svelte";
  import { nbHref } from "../../lib/href";
  import type { NotebookCtl } from "../../lib/notebook.svelte";
  import { promptDelete, renameNotebook, slugify } from "../../lib/notebooks";
  import Icon from "../Icon.svelte";
  import ManageAccess from "../auth/ManageAccess.svelte";
  import { can } from "../../lib/can";
  import { useSettings } from "./context";
  import SandboxGroup from "./SandboxGroup.svelte";
  import Setting from "./Setting.svelte";
  import { AI_LEVELS, aiLabel } from "./shared";

  // A notebook's own settings. Each one it leaves unset follows its workspace's
  // (`ws`), and the editor says what that is.
  let { ctl, ws }: { ctl: NotebookCtl; ws: WorkspaceSummary | null } = $props();

  const settings = useSettings();
  const book = $derived(ctl.book);
  const [, folderName] = $derived(splitId(ctl.name));

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

  // -- general
  // svelte-ignore state_referenced_locally
  let title = $state(book?.title ?? "");
  // svelte-ignore state_referenced_locally
  let description = $state(book?.description ?? "");
  // svelte-ignore state_referenced_locally
  let folder = $state(folderName);
  const folderSlug = $derived(slugify(folder));
  async function rename() {
    if (!folderSlug || folderSlug === folderName) return;
    try {
      location.hash = nbHref(await renameNotebook(ctl.name, folderSlug));
    } catch (e: any) {
      settings.report("error", e.message);
    }
  }

  // -- AI access: its own level, or (null) its workspace's
  let own = $state<AiLevel | null | undefined>(undefined);
  let wsLevel = $state<AiLevel>("read");
  // svelte-ignore state_referenced_locally
  if (can(book, "ai.configure")) api.ai.level(ctl.name).then((r) => ((own = r.own), (wsLevel = r.workspace))).catch((e) => settings.report("error", e.message));
  async function setLevel(v: string) {
    const level = v === "" ? null : (v as AiLevel);
    const was = own;
    own = level;
    try {
      await api.ai.setLevel(ctl.name, level);
      settings.report("saved", "AI access: saved");
    } catch (e: any) {
      own = was;
      settings.report("error", e.message);
    }
  }

  // -- connections: what this notebook's kernel gets, for the signed-in person
  // svelte-ignore state_referenced_locally
  ctl.refreshConnections();

  let sharing = $state(false);

  // -- attributes for policies (a classification): the server keeps them, a workspace Admin sets them
  let attrs = $state<{ k: string; v: string }[] | null>(null);
  let savedAttrs = $state<Record<string, string>>({});
  const attrMap = () => Object.fromEntries((attrs ?? []).filter((a) => a.k.trim()).map((a) => [a.k.trim(), a.v]));
  const attrsDirty = $derived(attrs != null && JSON.stringify(attrMap()) !== JSON.stringify(savedAttrs));
  $effect(() => {
    if (!can(ws, "workspace.manage") || attrs) return;
    api.access
      .attributes(ctl.name)
      .then((r) => ((savedAttrs = r.attributes), (attrs = Object.entries(r.attributes).map(([k, v]) => ({ k, v })))))
      .catch((e) => settings.report("error", e.message));
  });
  async function saveAttrs(map = attrMap()) {
    try {
      await api.access.setAttributes(ctl.name, Object.keys(map).length ? map : null);
      savedAttrs = map;
      attrs = Object.entries(map).map(([k, v]) => ({ k, v }));
      settings.report("saved", "Attributes: saved");
    } catch (e: any) {
      settings.report("error", e.message);
    }
  }

</script>

{#snippet connInfo()}
  A connection gives a kernel environment variables: one named <code>sr</code> gives <code>SR_USER</code> and <code>SR_PASS</code>, which
  <code>CREATE CONNECTION sr</code> reads by itself; OPTIONS take <code>token = env('GH_TOKEN')</code>; Python reads <code>os.environ</code>.
  Credentials are shared, or each person's own.
{/snippet}

{#snippet attrInfo()}
  Keys: a letter, then letters, digits, <code>_ . -</code>. Values: up to 200 characters. A policy reads one as
  <code>resource.getTag("classification")</code>. Kept by the server, not in the notebook's folder, so editing or pulling it can't change them.
{/snippet}


{#if can(book, "notebook.edit")}
<section class="group" id="set-nb-general">
  <h2>General</h2>
  <Setting id="notebook.title" category="General" label="Title" description="How the notebook and its report are titled." modified={!!book && book.title !== folderName} onreset={() => apply({ title: folderName }, "Title").then(() => (title = folderName))}>
    <input bind:value={title} onchange={() => apply({ title }, "Title")} aria-label="Title" />
  </Setting>
  <Setting id="notebook.description" category="General" label="Description" description="What the notebook answers: shown under its title, in lists and on the report." modified={!!book?.description} onreset={() => apply({ description: null }, "Description").then(() => (description = ""))}>
    <textarea rows="2" bind:value={description} onchange={() => apply({ description: description.trim() || null }, "Description")} aria-label="Description"></textarea>
  </Setting>
  <Setting
    id="notebook.folder"
    category="General"
    label="Folder name"
    description="Its address and its folder on the server."
    info="Renaming keeps its AI access, shares and git history; open tabs follow it."
  >
    <div class="row">
      <input class="mono" bind:value={folder} spellcheck="false" aria-label="Folder name" onkeydown={(e) => e.key === "Enter" && rename()} />
      <button class="btn" disabled={!folderSlug || folderSlug === folderName} onclick={rename}>Rename</button>
    </div>
    {#if folderSlug && folderSlug !== folder}<p class="sub">Becomes <code>{folderSlug}</code></p>{/if}
  </Setting>
</section>
{/if}

{#if can(book, "notebook.share")}
<section class="group" id="set-nb-sharing">
  <h2>Sharing</h2>
  <Setting
    id="notebook.sharing"
    category="Sharing"
    label="Shared with"
    description="Give people, groups, or everyone matching a condition access to this notebook alone: Read, Run, Edit or Reshare. The workspace's roles apply as well."
  >
    <button class="btn" onclick={() => (sharing = true)}><Icon name="person-add" size={14} />Share…</button>
  </Setting>
</section>
{/if}

{#if can(book, "ai.configure")}
<section class="group" id="set-nb-ai">
  <h2>AI access</h2>
  <Setting
    id="notebook.ai.level"
    category="AI access"
    label="Level"
    description="What AI clients (MCP) may do in this notebook. Unset, it follows the workspace's default."
    info="Clients and their tokens are in User settings."
    modified={own != null}
    onreset={() => setLevel("")}
  >
    <Select
      value={own ?? ""}
      options={[
        { value: "" as const, label: `Workspace default (${aiLabel(wsLevel)})`, description: "Follows the workspace's default, and changes with it." },
        ...AI_LEVELS.map((l) => ({ value: l.level, label: l.label, description: l.what })),
      ]}
      onchange={(v) => setLevel(v)}
      label="Level"
      disabled={own === undefined}
    />
  </Setting>
</section>
{/if}

{#if can(book, "sandbox.manage")}
<SandboxGroup {ctl} {ws} />
{/if}

{#if can(book, "environment.manage")}
  <EnvironmentGroup scope="notebook" target={ctl.name} prefix="nb" />
{/if}

{#if can(book, "notebook.run")}
<section class="group" id="set-nb-connections">
  <h2>Connections</h2>
  {#if ctl.conn.secretsStale}
    <p class="note"><span>The running kernel still has the previous credentials.</span><button class="btn" onclick={() => ctl.restart()}>Restart kernel</button></p>
  {/if}
  <Setting
    id="notebook.connections"
    category="Connections"
    label="What your kernel gets"
    description="The connections you may use here: their variables reach your kernel, with shared credentials or your own."
    info={connInfo}
  >
    {#if ctl.unprovided.length}
      <ul class="list missing">
        {#each ctl.unprovided as [n, why] (n)}
          <li><Icon name="warning" size={14} /><code>{n}</code><span class="grow">asked for by {why}; no connection you may use gives it</span></li>
        {/each}
      </ul>
    {/if}
    <ConnectionList
      items={ctl.connections}
      refs={ctl.secretRefs}
      onchanged={() => ctl.refreshConnections()}
      empty={can(ws, "connection.manage") ? "None yet: add one in this workspace's settings." : "None you may use here. Ask the workspace's Admins or Members for one."}
    />
  </Setting>
</section>
{/if}

{#if can(ws, "workspace.manage")}
<section class="group" id="set-nb-attributes">
  <h2>Attributes</h2>
  <Setting
    id="notebook.attributes"
    category="Attributes"
    label="Tags"
    description="Tags for access policies, such as a data classification. Set by the workspace's Admins."
    info={attrInfo}
    modified={Object.keys(savedAttrs).length > 0}
    onreset={() => saveAttrs({})}
  >
    {#if attrs?.length}
      <div class="attrs">
        {#each attrs as a, i (i)}
          <input class="mono" bind:value={a.k} placeholder="key" aria-label="Key" spellcheck="false" />
          <input bind:value={a.v} placeholder="value" aria-label="Value of {a.k || 'the attribute'}" spellcheck="false" />
          <button class="icon" title="Remove" aria-label="Remove {a.k}" onclick={() => attrs!.splice(i, 1)}><Icon name="close" size={14} /></button>
        {/each}
      </div>
    {/if}
    <div class="row">
      <button class="btn" disabled={attrs == null} onclick={() => attrs!.push({ k: "", v: "" })}><Icon name="add" size={14} />Add attribute</button>
      {#if attrsDirty}<button class="btn primary" onclick={() => saveAttrs()}>Save attributes</button>{/if}
    </div>
  </Setting>
</section>
{/if}

{#if can(book, "notebook.delete")}
<section class="group" id="set-nb-manage">
  <h2>Manage</h2>
  <Setting id="notebook.delete" category="Manage" label="Delete this notebook" description="Its folder and every file in it are deleted, with its shares and AI access setting. This can't be undone.">
    <button class="btn danger" onclick={() => promptDelete(ctl.name, book?.title ?? ctl.name)}><Icon name="trash" size={14} />Delete notebook…</button>
  </Setting>
</section>
{/if}

{#if sharing}
  <ManageAccess what={{ scope: "notebook", target: ctl.name, title: book?.title ?? folderName, permissions: ws?.permissions }} onclose={() => (sharing = false)} />
{/if}

<style>
  .missing li {
    color: var(--wb-fg);
  }
  .missing :global(i) {
    color: var(--stale);
  }
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
