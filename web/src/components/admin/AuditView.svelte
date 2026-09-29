<script lang="ts">
  import { api, type AuditEntry } from "../../lib/api";
  import { ago } from "../../lib/format";
  import Icon from "../Icon.svelte";
  import Select from "../ui/Select.svelte";

  // What happened, newest first: sign-ins and their failures, denials, grants,
  // policy and connection changes, deletions. Filtered by who, what, the outcome
  // and on what; older pages load on demand.
  let { query }: { query: Record<string, string> } = $props();

  // svelte-ignore state_referenced_locally
  let actor = $state(query.actor ?? "");
  // svelte-ignore state_referenced_locally
  let action = $state(query.action ?? "");
  // svelte-ignore state_referenced_locally
  let decision = $state(query.decision ?? "");
  // svelte-ignore state_referenced_locally
  let resource = $state(query.resource ?? "");
  let entries = $state<AuditEntry[]>([]);
  let names = $state<Record<string, string>>({});
  let more = $state(true);
  let busy = $state(false);
  let error = $state("");
  let open = $state<number | null>(null);
  const PAGE = 100;

  async function load(older = false) {
    busy = true;
    error = "";
    try {
      const r = await api.admin.audit({ actor, action, decision, resource, limit: PAGE, before: older ? entries.at(-1)?.id : undefined });
      entries = older ? [...entries, ...r.entries] : r.entries;
      names = { ...names, ...r.names };
      more = r.entries.length === PAGE;
    } catch (e: any) {
      error = e.message;
    }
    busy = false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    void [actor, action, decision, resource];
    clearTimeout(timer);
    timer = setTimeout(() => load(), 200);
  });

  const DECISIONS = [
    { value: "", label: "Any outcome" },
    { value: "deny", label: "Denied" },
    { value: "allow", label: "Allowed" },
    { value: "ok", label: "Done" },
    { value: "fail", label: "Failed" },
  ];
  const who = (id?: string) => (id ? (names[id] ?? id) : "—");
  const detailText = (d?: Record<string, unknown>) => (d ? JSON.stringify(d) : "");
</script>

<div class="adm audit">
  <header class="adm-head">
    <div class="grow">
      <h2>Audit log</h2>
      <p>Sign-ins, denials and changes, newest first.</p>
    </div>
    <button class="btn" onclick={() => load()} disabled={busy} title="Load what's new"><Icon name="refresh" size={14} />Refresh</button>
  </header>

  <div class="filters">
    <input class="text" bind:value={actor} placeholder="Who (an id: corp:ana)" spellcheck="false" aria-label="Who" />
    <input class="text" bind:value={action} placeholder="What (login, grant., notebook.run…)" spellcheck="false" aria-label="What" />
    <input class="text" bind:value={resource} placeholder="On what (a part of it)" spellcheck="false" aria-label="On what" />
    <Select bind:value={decision} options={DECISIONS} label="Outcome" />
  </div>
  {#if error}<p class="error">{error}</p>{/if}

  <table>
    <thead>
      <tr><th class="t">When</th><th>Who</th><th>What</th><th>On what</th><th class="o">Outcome</th></tr>
    </thead>
    <tbody>
      {#each entries as e (e.id)}
        <tr class:deny={e.decision === "deny" || e.decision === "fail"} class:has={!!e.detail} onclick={() => e.detail && (open = open === e.id ? null : e.id)}>
          <td class="t" title={new Date(e.ts).toLocaleString()}>{ago(e.ts)}</td>
          <td title={e.actor}>
            {#if e.actor}<button class="who" onclick={(ev) => (ev.stopPropagation(), (actor = e.actor!))} title="Only {who(e.actor)}">{who(e.actor)}</button>{:else}—{/if}
          </td>
          <td><code>{e.action}</code></td>
          <td class="r"><code title={e.resource}>{e.resource ?? ""}</code></td>
          <td class="o">{e.decision === "deny" ? "Denied" : e.decision === "allow" ? "Allowed" : e.decision === "fail" ? "Failed" : e.decision === "ok" ? "Done" : ""}</td>
        </tr>
        {#if open === e.id}
          <tr class="more"><td colspan="5"><code>{detailText(e.detail)}</code></td></tr>
        {/if}
      {/each}
    </tbody>
  </table>
  {#if !entries.length && !busy}<p class="muted">Nothing matches.</p>{/if}
  {#if more && entries.length}
    <button class="btn older" onclick={() => load(true)} disabled={busy}>{busy ? "Loading…" : "Older"}</button>
  {/if}
</div>

<style>
  .audit {
    max-width: 76rem !important;
  }
  .filters {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr)) auto;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
    table-layout: fixed;
  }
  th {
    padding: 0.375rem 0.5rem;
    text-align: left;
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--wb-fg-muted);
    border-bottom: 1px solid var(--wb-border);
  }
  th.t,
  td.t {
    width: 7rem;
  }
  th.o,
  td.o {
    width: 6rem;
  }
  td {
    padding: 0.3125rem 0.5rem;
    border-bottom: 1px solid var(--wb-border);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  tr.has {
    cursor: pointer;
  }
  tr:hover td {
    background: var(--wb-list-hover);
  }
  tr.deny td.o {
    color: var(--critical);
  }
  td.t {
    color: var(--wb-fg-muted);
  }
  code {
    font-size: 0.75rem;
  }
  .r code {
    color: var(--wb-fg-muted);
  }
  .who {
    padding: 0;
    font-size: 0.8125rem;
    color: var(--wb-fg);
  }
  .who:hover {
    color: var(--wb-accent);
    text-decoration: underline;
  }
  tr.more td {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: var(--wb-bar);
  }
  .older {
    margin-top: 0.75rem;
  }
</style>
