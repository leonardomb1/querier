<script lang="ts">
  import { onMount } from "svelte";
  import { api, type Action, type Person, type PersonDetail } from "../../lib/api";
  import { ago } from "../../lib/format";
  import { adminHref, nbHref, wsHref } from "../../lib/href";
  import Icon from "../Icon.svelte";

  // Everyone who has signed in, as policies see them: their groups and attributes
  // (tags) as of their last sign-in or refresh, and what that lets them do.
  let { query }: { query: Record<string, string> } = $props();

  let q = $state("");
  let people = $state<Person[]>([]);
  // svelte-ignore state_referenced_locally
  let selected = $state<string | null>(query.id ?? null);
  let detail = $state<PersonDetail | null>(null);
  let error = $state("");

  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const text = q;
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        api.admin.people(text).then(
          (r) => {
            people = r.people;
            if (!selected && people.length) selected = people[0].id;
          },
          (e) => (error = e.message),
        ),
      text ? 150 : 0,
    );
  });
  $effect(() => {
    const id = selected;
    detail = null;
    if (id) api.admin.person(id).then((d) => selected === id && (detail = d), (e) => (error = e.message));
  });
  onMount(() => () => clearTimeout(timer));

  // a workspace's permissions, as the role they amount to (or how many, when policies make them no role)
  function roleOf(p: Action[]): string {
    if (!p.length) return "";
    if (p.includes("workspace.manage")) return "Admin";
    if (p.includes("workspace.manageAccess")) return "Member";
    if (p.includes("notebook.create")) return "Contributor";
    if (p.includes("workspace.view")) return "Viewer";
    return `${p.length} action${p.length === 1 ? "" : "s"}`;
  }
  function shareOf(p: Action[]): string {
    if (p.includes("notebook.share")) return "Reshare";
    if (p.includes("notebook.edit")) return "Edit";
    if (p.includes("notebook.run")) return "Run";
    if (p.includes("notebook.view")) return "Read";
    return `${p.length} actions`;
  }
</script>

<div class="adm people">
  <header class="adm-head">
    <div class="grow">
      <h2>People</h2>
      <p>Everyone who has signed in, as policies see them: groups and attributes from their directory, as of their last sign-in.</p>
    </div>
  </header>
  {#if error}<p class="error">{error}</p>{/if}

  <div class="split">
    <div class="list">
      <label class="search"><Icon name="search" size={14} /><input bind:value={q} placeholder="Name, email, group…" spellcheck="false" aria-label="Search people" /></label>
      <ul>
        {#each people as p (p.id)}
          <li>
            <button class:on={selected === p.id} onclick={() => (selected = p.id)}>
              <span class="n">{p.name ?? p.username}</span>
              <span class="d">{p.sysadmin ? "system administrator" : `${p.username} · ${p.provider}`}</span>
            </button>
          </li>
        {:else}
          <li class="muted pad">{q ? "Nobody matches." : "Nobody has signed in yet."}</li>
        {/each}
      </ul>
    </div>

    <div class="detail">
      {#if detail}
        {@const p = detail.principal}
        <div class="who">
          <span class="avatar"><Icon name="person" size={22} /></span>
          <div>
            <h3 class="name">{p.name ?? p.username}</h3>
            <p class="muted">
              <code>{p.id}</code>{#if p.email} · {p.email}{/if}{#if p.lastLogin} · signed in {ago(p.lastLogin)}{/if}
            </p>
          </div>
        </div>
        <p class="links">
          <a class="btn" href={adminHref("explain", { principal: p.id })}><Icon name="question" size={14} />Explain a decision</a>
          <a class="btn" href={adminHref("audit", { actor: p.id })}><Icon name="history" size={14} />Audit log</a>
        </p>

        <h3>Groups</h3>
        {#if p.groups.length}<span class="chips">{#each p.groups as g (g)}<span class="chip" title={g}>{g}</span>{/each}</span>{:else}<p class="muted">None.</p>{/if}

        <h3>Attributes <span class="aside">principal.getTag(…)</span></h3>
        <dl class="tags">
          {#each Object.entries(detail.tags) as [k, vs] (k)}
            <dt><code>{k}</code></dt>
            <dd><span class="chips">{#each vs as v (v)}<span class="chip" title={v}>{v}</span>{/each}</span></dd>
          {/each}
        </dl>

        <h3>May do</h3>
        {#if p.sysadmin}
          <p class="muted">Everything: the system administrator isn't asked of any policy.</p>
        {:else}
          {#if detail.tenant.length}<p class="line"><strong>Everywhere:</strong> <span class="chips">{#each detail.tenant as a (a)}<span class="chip">{a}</span>{/each}</span></p>{/if}
          {#if detail.workspaces.length}
            <ul class="access">
              {#each detail.workspaces as w (w.name)}
                <li>
                  <a href={wsHref(w.name)}><Icon name="folder-library" size={14} />{w.title}</a>
                  {#if w.permissions.length}<span class="role">{roleOf(w.permissions)}</span>{:else}<span class="muted">shared notebooks only</span>{/if}
                  {#if w.notebooks.length && !w.permissions.includes("notebook.view")}
                    <ul>
                      {#each w.notebooks as n (n.id)}
                        <li><a href={nbHref(n.id)}><Icon name="notebook" size={13} />{n.title}</a><span class="role">{shareOf(n.permissions)}</span></li>
                      {/each}
                    </ul>
                  {/if}
                </li>
              {/each}
            </ul>
          {:else}
            <p class="muted">Nothing: no role, share or policy gives them anything yet.</p>
          {/if}
        {/if}
      {:else if selected}
        <p class="muted">Loading…</p>
      {/if}
    </div>
  </div>
</div>

<style>
  .people {
    max-width: 72rem !important;
  }
  .split {
    display: grid;
    grid-template-columns: 17rem minmax(0, 1fr);
    gap: 1.5rem;
    align-items: start;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    height: 1.875rem;
    padding: 0 0.5rem;
    color: var(--wb-fg-muted);
    background: var(--wb-input);
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
  }
  .search:focus-within {
    border-color: var(--wb-accent);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: 0;
    padding: 0;
    font: inherit;
    font-size: 0.8125rem;
    color: var(--wb-fg);
    background: none;
  }
  .list ul {
    margin: 0.5rem 0 0;
    padding: 0;
    list-style: none;
    max-height: calc(100vh - 16rem);
    overflow-y: auto;
  }
  .list button {
    display: flex;
    flex-direction: column;
    width: 100%;
    padding: 0.375rem 0.5rem;
    text-align: left;
    border-radius: 4px;
    color: var(--wb-fg);
  }
  .list button:hover {
    background: var(--wb-list-hover);
  }
  .list button.on {
    background: var(--wb-list-active);
  }
  .n {
    font-size: 0.8125rem;
  }
  .d {
    font-size: 0.72rem;
    color: var(--wb-fg-dim);
  }
  .pad {
    padding: 0.5rem;
  }
  .who {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .avatar {
    display: grid;
    place-items: center;
    width: 2.75rem;
    height: 2.75rem;
    border-radius: 50%;
    color: var(--wb-fg-muted);
    background: var(--wb-list-hover);
  }
  h3.name {
    margin: 0 !important;
    font-size: 1rem !important;
    text-transform: none !important;
    letter-spacing: 0 !important;
    color: var(--wb-fg) !important;
  }
  .who p {
    margin: 0.125rem 0 0;
  }
  code {
    font-size: 0.75rem;
  }
  .links {
    display: flex;
    gap: 0.5rem;
    margin: 0.875rem 0 0;
  }
  .aside {
    margin-left: 0.375rem;
    font-family: var(--mono);
    text-transform: none;
    letter-spacing: 0;
    font-weight: 400;
    color: var(--wb-fg-dim);
  }
  .tags {
    display: grid;
    grid-template-columns: 9rem minmax(0, 1fr);
    gap: 0.375rem 0.75rem;
    margin: 0;
    font-size: 0.8125rem;
  }
  .tags dd {
    margin: 0;    min-width: 0;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
  }
  .access,
  .access ul {
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 0.8125rem;
  }
  .access > li {
    padding: 0.375rem 0;
    border-bottom: 1px solid var(--wb-border);
  }
  .access ul {
    padding: 0.25rem 0 0 1.25rem;
  }
  .access a {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--wb-fg);
    text-decoration: none;
  }
  .access a:hover {
    text-decoration: underline;
  }
  .role {
    margin-left: 0.5rem;
    padding: 0 0.375rem;
    font-size: 0.72rem;
    color: var(--wb-fg-muted);
    border: 1px solid var(--wb-border);
    border-radius: 3px;
  }
</style>
