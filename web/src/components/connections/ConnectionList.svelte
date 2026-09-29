<script lang="ts">
  import { api, type ConnectionInfo } from "../../lib/api";
  import { ask, notifyError } from "../../lib/dialog.svelte";
  import Icon from "../Icon.svelte";
  import ManageAccess from "../auth/ManageAccess.svelte";
  import ConnectionForm from "./ConnectionForm.svelte";
  import CredentialsDialog from "./CredentialsDialog.svelte";

  // Connections as the settings list them: each with where it belongs, whose
  // credentials it takes and which are set, and what the signed-in person may do
  // (set their own, set the shared ones, change it, give it, delete it).
  let {
    items,
    onchanged,
    empty,
    create,
    refs,
  }: {
    items: ConnectionInfo[];
    onchanged: () => void;
    empty: string;
    /** a New connection button: where it goes (a workspace; null: everyone's); none: no button */
    create?: { workspace: string | null } | null;
    /** variables the notebook's cells ask for, and where: marks the ones it uses */
    refs?: Map<string, string>;
  } = $props();

  let editing = $state<ConnectionInfo | "new" | null>(null);
  let credentials = $state<ConnectionInfo | null>(null);
  let access = $state<ConnectionInfo | null>(null);

  const manages = (c: ConnectionInfo) => c.permissions.includes("connection.manage");
  const uses = (c: ConnectionInfo) => c.permissions.includes("connection.use");
  const missingMine = (c: ConnectionInfo) => c.credentials === "per-user" && uses(c) && c.mine.length < c.variables.length;
  const missingShared = (c: ConnectionInfo) => c.credentials === "shared" && c.set.length < c.variables.length;
  const used = (c: ConnectionInfo) => (refs ? c.variables.filter((v) => refs!.has(v)) : []);

  async function remove(c: ConnectionInfo) {
    const where = c.workspace ? `every notebook in ${c.workspace}` : "every notebook";
    if (!(await ask(`Delete the connection ${c.name}?`, { detail: `Its variables stop reaching ${where} when their kernels restart, and its credentials (shared and everyone's own) go with it.`, ok: "Delete", danger: true }))) return;
    try {
      await api.connections.remove(c.id);
      onchanged();
    } catch (e) {
      await notifyError(`Couldn't delete ${c.name}`, e);
    }
  }
  async function forgetMine(c: ConnectionInfo) {
    if (!(await ask(`Remove your credentials for ${c.name}?`, { detail: "Your kernels stop getting them when they restart.", ok: "Remove", danger: true }))) return;
    try {
      await api.connections.clearMine(c.id);
      onchanged();
    } catch (e) {
      await notifyError("Couldn't remove them", e);
    }
  }
</script>

{#if items.length}
  <ul class="conns">
    {#each items as c (c.id)}
      <li>
        <span class="ic"><Icon name="plug" size={16} /></span>
        <div class="main">
          <div class="head">
            <span class="name">{c.name}</span>
            <span class="tag">{c.workspace ? "This workspace" : "Everyone's"}</span>
            <span class="tag">{c.credentials === "per-user" ? "Each person's own credentials" : "Shared credentials"}</span>
          </div>
          {#if c.description}<p class="desc">{c.description}</p>{/if}
          <p class="vars">
            {#each c.variables as v (v)}
              {@const has = c.credentials === "per-user" ? c.mine.includes(v) : c.set.includes(v)}
              <code class:unset={!has} title={has ? (c.credentials === "per-user" ? "Yours is set" : "Set") : c.credentials === "per-user" ? "You haven't set yours" : "Not set"}>
                {#if has}<Icon name="check" size={12} />{/if}{v}
              </code>
            {/each}
          </p>
          {#if used(c).length}<p class="note">This notebook reads {used(c).join(", ")}.</p>{/if}
          {#if missingMine(c)}
            <p class="note warn"><Icon name="warning" size={13} />Your own credentials aren't set: your kernels run without them.</p>
          {:else if missingShared(c) && uses(c)}
            <p class="note warn"><Icon name="warning" size={13} />{manages(c) ? "Not all of its values are set." : "Not all of its values are set: ask who manages it."}</p>
          {/if}
        </div>
        <div class="acts">
          {#if c.credentials === "per-user" && uses(c)}
            <button class="btn" onclick={() => (credentials = c)}>{c.mine.length ? "Your credentials…" : "Enter yours…"}</button>
            {#if c.mine.length}<button class="icon" title="Remove your credentials" aria-label="Remove your credentials for {c.name}" onclick={() => forgetMine(c)}><Icon name="trash" size={14} /></button>{/if}
          {:else if c.credentials === "shared" && manages(c)}
            <button class="btn" onclick={() => (credentials = c)}>Credentials…</button>
          {/if}
          {#if manages(c)}
            <button class="icon" title="Edit" aria-label="Edit {c.name}" onclick={() => (editing = c)}><Icon name="edit" size={14} /></button>
            <button class="icon" title="Who may use it" aria-label="Manage access to {c.name}" onclick={() => (access = c)}><Icon name="organization" size={14} /></button>
            <button class="icon" title="Delete" aria-label="Delete {c.name}" onclick={() => remove(c)}><Icon name="trash" size={14} /></button>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{:else}
  <p class="empty">{empty}</p>
{/if}
{#if create}
  <button class="btn add" onclick={() => (editing = "new")}><Icon name="add" size={14} />New connection…</button>
{/if}

{#if editing}
  <ConnectionForm
    connection={editing === "new" ? null : editing}
    workspace={editing === "new" ? (create?.workspace ?? undefined) : undefined}
    onsaved={(c) => {
      const made = editing === "new";
      editing = null;
      onchanged();
      // a new shared one: its values next
      if (made && c.credentials === "shared") credentials = c;
    }}
    onclose={() => (editing = null)}
  />
{/if}
{#if credentials}
  <CredentialsDialog connection={credentials} onsaved={() => ((credentials = null), onchanged())} onclose={() => (credentials = null)} />
{/if}
{#if access}
  <ManageAccess
    what={{
      scope: "connection",
      target: access.id,
      title: access.name,
      permissions: access.permissions,
      detail: access.workspace ? `The workspace's Contributors use it and its Members manage it, besides these.` : "Everyone's: only these, and the system administrator.",
    }}
    onclose={() => ((access = null), onchanged())}
  />
{/if}

<style>
  .conns {
    margin: 0 0 0.5rem;
    padding: 0;
    list-style: none;
    width: min(100%, 44rem);
  }
  li {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    padding: 0.625rem 0.25rem;
    border-bottom: 1px solid var(--wb-border);
  }
  li:first-child {
    border-top: 1px solid var(--wb-border);
  }
  .ic {
    display: flex;
    padding-top: 0.125rem;
    color: var(--wb-accent);
  }
  .main {
    flex: 1;
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .name {
    font-weight: 600;
    font-family: var(--mono);
    font-size: 0.8125rem;
  }
  .tag {
    padding: 0 0.375rem;
    font-size: 0.6875rem;
    line-height: 1.125rem;
    color: var(--wb-fg-muted);
    border: 1px solid var(--wb-border);
    border-radius: 3px;
  }
  .desc {
    margin: 0.25rem 0 0;
    font-size: 0.78rem;
    color: var(--wb-fg-muted);
  }
  .vars {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3125rem;
    margin: 0.375rem 0 0;
  }
  .vars code {
    display: inline-flex;
    align-items: center;
    gap: 0.1875rem;
    padding: 0 0.3125rem;
    font-size: 0.72rem;
    line-height: 1.25rem;
    background: var(--wb-list-hover);
    border-radius: 3px;
  }
  .vars code :global(i) {
    color: var(--wb-accent);
  }
  .vars code.unset {
    color: var(--wb-fg-dim);
    background: none;
    border: 1px dashed var(--wb-border);
  }
  .note {
    display: flex;
    align-items: center;
    gap: 0.3125rem;
    margin: 0.375rem 0 0;
    font-size: 0.75rem;
    color: var(--wb-fg-muted);
  }
  .note.warn {
    color: var(--warning);
  }
  .acts {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    flex: none;
  }
  .acts .icon {
    width: 1.625rem;
    height: 1.625rem;
    color: var(--wb-fg-muted);
  }
  .acts .icon:hover {
    color: var(--wb-fg);
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    height: 1.625rem;
    padding: 0 0.625rem;
    font-size: 0.78rem;
    color: var(--wb-fg);
    border: 1px solid var(--wb-input-border);
    border-radius: 3px;
    white-space: nowrap;
  }
  .btn:hover {
    background: var(--wb-list-hover);
  }
  .btn.add {
    margin-top: 0.25rem;
  }
  .empty {
    margin: 0 0 0.5rem;
    font-size: 0.8125rem;
    color: var(--wb-fg-dim);
  }
</style>
