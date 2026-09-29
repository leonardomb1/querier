<script lang="ts">
  import { onMount } from "svelte";
  import { api, type Action, type ConnectionInfo, type Explanation, type Person, type PolicyIndex, type ResourceRef, type WorkspaceSummary } from "../../lib/api";
  import { adminHref } from "../../lib/href";
  import Icon from "../Icon.svelte";
  import CodeInput from "../ui/CodeInput.svelte";
  import Select from "../ui/Select.svelte";

  // May this person do this to that, and why: the decision the server would make
  // now, with the policies that made it (their text, and where each comes from:
  // a role or share given in Manage access, or a policy file).
  let { query }: { query: Record<string, string> } = $props();

  let people = $state<Person[]>([]);
  let index = $state<PolicyIndex | null>(null);
  let spaces = $state<WorkspaceSummary[]>([]);
  let conns = $state<ConnectionInfo[]>([]);
  // svelte-ignore state_referenced_locally
  let principal = $state(query.principal ?? "");
  // svelte-ignore state_referenced_locally
  let action = $state<Action>((query.action as Action) ?? "notebook.run");
  let type = $state<ResourceRef["type"]>("Notebook");
  let target = $state("");
  let result = $state<Explanation | null>(null);
  let error = $state("");
  let busy = $state(false);

  onMount(async () => {
    try {
      const [p, i, w, c] = await Promise.all([api.admin.people(), api.admin.policies(), api.workspaces(), api.connections.list()]);
      people = p.people;
      index = i;
      spaces = w.workspaces;
      conns = c.connections;
      if (!principal) principal = people.find((x) => !x.sysadmin)?.id ?? people[0]?.id ?? "";
    } catch (e: any) {
      error = e.message;
    }
  });

  const types = $derived<ResourceRef["type"][]>(index?.appliesTo[action] ?? ["Notebook"]);
  // the action decides what it can be asked of
  $effect(() => {
    if (!types.includes(type)) type = types[0];
  });
  const targets = $derived.by(() => {
    if (type === "Tenant") return [{ value: "querier", label: "All of Querier" }];
    if (type === "Workspace") return spaces.map((w) => ({ value: w.name, label: w.title, hint: w.name }));
    if (type === "Notebook") return spaces.flatMap((w) => w.notebooks.map((n) => ({ value: n.id, label: n.title, hint: n.id })));
    return conns.map((c) => ({ value: c.id, label: c.name, hint: c.workspace ?? "everyone's" }));
  });
  $effect(() => {
    if (!targets.some((t) => t.value === target)) target = targets[0]?.value ?? "";
  });

  async function explain() {
    if (!principal || !target) return;
    busy = true;
    error = "";
    try {
      result = await api.admin.explain(principal, action, { type, id: target });
    } catch (e: any) {
      error = e.message;
      result = null;
    }
    busy = false;
  }
  // a new question: the old answer goes
  $effect(() => {
    void [principal, action, type, target];
    result = null;
  });

  const personOptions = $derived(people.map((p) => ({ value: p.id, label: p.name ?? p.username, hint: p.sysadmin ? "system administrator" : `${p.username} · ${p.provider}` })));
  const actionOptions = $derived((index?.actions ?? []).map((a) => ({ value: a, label: a, hint: index!.appliesTo[a].join(", ") })));
  const typeOptions = $derived(types.map((t) => ({ value: t, label: t })));
</script>

<div class="adm">
  <header class="adm-head">
    <div class="grow">
      <h2>Explain a decision</h2>
      <p>What the server decides now, and which policies decided it.</p>
    </div>
  </header>

  {#if error}<p class="error">{error}</p>{/if}

  <form class="ask" onsubmit={(e) => (e.preventDefault(), explain())}>
    <label>
      <span>May</span>
      <Select bind:value={principal} options={personOptions} label="Person" placeholder="someone who has signed in" />
    </label>
    <label>
      <span>do</span>
      <Select bind:value={action} options={actionOptions} label="Action" />
    </label>
    <label>
      <span>to</span>
      <span class="res">
        <Select bind:value={type} options={typeOptions} label="Kind" disabled={types.length < 2} />
        <Select bind:value={target} options={targets} label="Which" placeholder="nothing of that kind" />
      </span>
    </label>
    <button class="primary" type="submit" disabled={busy || !principal || !target}>Explain</button>
  </form>

  {#if result}
    <section class="verdict" class:allow={result.allow}>
      <Icon name={result.allow ? "pass" : "circle-slash"} size={22} />
      <div>
        <strong>{result.allow ? "Allowed" : "Denied"}</strong>
        <p>
          {#if result.errors.length}
            A policy errored while deciding, so it is denied (an error might have been a skipped forbid).
          {:else if result.allow}
            Permitted by what is listed below, and no forbid applies.
          {:else if result.reasons.length}
            Forbidden by what is listed below: a forbid wins over any permit.
          {:else}
            Nothing permits it: no role, share or policy gives it.
          {/if}
        </p>
      </div>
    </section>

    {#if result.errors.length}
      <h3>Errors</h3>
      {#each result.errors as e, i (i)}<p class="error">{e}</p>{/each}
    {/if}

    {#if result.reasons.length}
      <h3>Decided by</h3>
      {#each result.reasons as r (r.id)}
        <div class="reason">
          <p class="src"><Icon name={r.id.startsWith("grant:") ? "organization" : r.id === "sysadmin" ? "shield" : "file-code"} size={14} />{r.source}</p>
          {#if r.text}<CodeInput value={r.text} onchange={() => {}} readOnly minLines={1} maxLines={10} label="Policy" />{/if}
        </div>
      {/each}
    {/if}

    <h3>{result.principal.name ?? result.principal.username} as policies see them</h3>
    <dl class="who">
      <dt>Groups</dt>
      <dd>
        {#if result.principal.groups.length}<span class="chips">{#each result.principal.groups as g (g)}<span class="chip" title={g}>{g}</span>{/each}</span>{:else}<span class="muted">none</span>{/if}
      </dd>
      {#each Object.entries(result.principal.tags) as [k, vs] (k)}
        <dt><code>{k}</code></dt>
        <dd><span class="chips">{#each vs as v (v)}<span class="chip" title={v}>{v}</span>{/each}</span></dd>
      {/each}
    </dl>
    <p class="links">
      <a class="btn" href={adminHref("people", { id: principal })}><Icon name="person" size={14} />Their page</a>
      <a class="btn" href={adminHref("audit", { actor: principal })}><Icon name="history" size={14} />Their audit log</a>
    </p>
  {/if}
</div>

<style>
  .ask {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    border: 1px solid var(--wb-border);
    border-radius: 6px;
    background: var(--wb-bar);
  }
  .ask label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: var(--wb-fg-muted);
  }
  .ask :global(.select) {
    min-width: 10rem;
    max-width: 20rem;
  }
  .res {
    display: flex;
    gap: 0.375rem;
  }
  .verdict {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    margin-top: 1.25rem;
    padding: 0.875rem 1rem;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--critical) 45%, var(--wb-border));
    background: color-mix(in srgb, var(--critical) 6%, transparent);
  }
  .verdict :global(i) {
    color: var(--critical);
  }
  .verdict.allow {
    border-color: color-mix(in srgb, var(--git-added) 45%, var(--wb-border));
    background: color-mix(in srgb, var(--git-added) 6%, transparent);
  }
  .verdict.allow :global(i) {
    color: var(--git-added);
  }
  .verdict strong {
    font-size: 1rem;
  }
  .verdict p {
    margin: 0.125rem 0 0;
    font-size: 0.8125rem;
    color: var(--wb-fg-muted);
  }
  .reason {
    margin-bottom: 0.75rem;
  }
  .src {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0 0 0.3125rem;
    font-size: 0.8125rem;
  }
  .src :global(i) {
    color: var(--wb-fg-muted);
  }
  .who {
    display: grid;
    grid-template-columns: 9rem minmax(0, 1fr);
    gap: 0.375rem 0.75rem;
    margin: 0;
    font-size: 0.8125rem;
  }
  .who dt {
    color: var(--wb-fg-muted);
  }
  .who dd {
    margin: 0;    min-width: 0;
  }
  .who code {
    font-size: 0.75rem;
  }
  .links {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
  }
</style>
