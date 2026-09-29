<script lang="ts" module>
  import type { AccessScope, Action } from "../../lib/api";
  /** What the dialog manages: a workspace's roles, or a notebook's shares. */
  export interface AccessTarget {
    scope: AccessScope;
    /** the workspace's name, or the notebook's id */
    target: string;
    title: string;
    /** what the person managing it may do there (a Member can't give Admin) */
    permissions?: Action[];
    /** a line on who has it besides these grants (a workspace connection: its Contributors) */
    detail?: string;
  }
</script>

<script lang="ts">
  import Select from "../ui/Select.svelte";
  import { onMount } from "svelte";
  import { slide } from "svelte/transition";
  import { api, CONNECTION_ROLES, SHARE_LEVELS, WORKSPACE_ROLES, type ConnectionRole, type DirectoryHits, type Grant, type ShareLevel, type Subject, type WorkspaceRole } from "../../lib/api";
  import Icon from "../Icon.svelte";
  import OverlayPanel from "../wb/OverlayPanel.svelte";
  import CodeInput from "../ui/CodeInput.svelte";
  import CodeEditorPanel from "../ui/CodeEditorPanel.svelte";
  import type { CedarVocabulary } from "../../lib/cedarcomplete";

  // Who has access, as Microsoft Fabric's "Manage access": a workspace gives
  // roles (Viewer, Contributor, Member, Admin), a notebook is shared (Read, Run,
  // Edit, Reshare), a connection has Users and Owners. Each goes to a person, a
  // directory group, everyone signed in, or everyone whose attributes match a condition.
  let { what, onclose }: { what: AccessTarget; onclose: () => void } = $props();

  type Role = WorkspaceRole | ShareLevel | ConnectionRole;
  const ws = $derived(what.scope === "workspace");
  const conn = $derived(what.scope === "connection");
  const roles = $derived<readonly Role[]>(ws ? WORKSPACE_ROLES : conn ? CONNECTION_ROLES : SHARE_LEVELS);
  const ROLE_HINT: Record<Role, string> = {
    Viewer: "Sees its notebooks and their code; can't run or change them.",
    Contributor: "Creates, edits, runs and deletes notebooks; uses its connections.",
    Member: "As Contributor, and shares notebooks, gives roles up to Member, manages its connections, sandbox and AI access.",
    Admin: "Everything, including renaming or deleting the workspace and giving Admin.",
    Read: "Sees the notebook, its code and its report.",
    Run: "As Read, and runs it.",
    Edit: "As Run, and edits it, pulls and pushes.",
    Reshare: "As Edit, and shares it with others.",
    User: "Runs with it: their kernels get its variables (their own credentials, if it is per person).",
    Owner: "As User, and changes it, its shared credentials, and who has it.",
  };
  // only a workspace's Admin gives Admin
  const mayGive = (r: Role) => r !== "Admin" || !!what.permissions?.includes("workspace.manage");
  const roleOptions = $derived(roles.map((r) => ({ value: r as Role, label: r, description: ROLE_HINT[r], disabled: !mayGive(r) })));

  let grants = $state<Grant[] | null>(null);
  let error = $state("");
  async function load() {
    try {
      grants = (await api.access.of(what.scope, what.target)).grants;
    } catch (e: any) {
      error = e.message;
    }
  }
  onMount(load);

  // -- adding: pick who, then a role
  type Pick = { subject: Subject; label: string; detail?: string; icon: string };
  let query = $state("");
  let hits = $state<DirectoryHits>({ people: [], groups: [] });
  let picked = $state<Pick | null>(null);
  let role = $state<Role>("Viewer");
  let condition = $state("");
  let busy = $state(false);
  let focused = $state(false);
  let active = $state(0);
  let input = $state<HTMLInputElement>();
  // svelte-ignore state_referenced_locally
  role = ws ? "Viewer" : conn ? "User" : "Read";

  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const q = query;
    clearTimeout(timer);
    timer = setTimeout(() => api.access.directory(q).then((h) => (hits = h), () => {}), q ? 120 : 0);
  });

  const options = $derived.by<Pick[]>(() => {
    const q = query.trim();
    const out: Pick[] = [
      ...hits.people.map((p) => ({ subject: { kind: "user", id: p.id } as Subject, label: p.name ?? p.username, detail: p.email ?? `${p.username} · ${p.provider}`, icon: "person" })),
      ...hits.groups.map((g) => ({ subject: { kind: "group", name: g } as Subject, label: g, detail: "Group", icon: "organization" })),
    ];
    // a directory group nobody from has signed in yet: named as typed
    if (q && !hits.groups.some((g) => g.toLowerCase() === q.toLowerCase())) out.push({ subject: { kind: "group", name: q }, label: q, detail: "Group, by its name in the directory", icon: "organization" });
    if (!q || "everyone".includes(q.toLowerCase())) out.push({ subject: { kind: "everyone" }, label: "Everyone signed in", detail: "Anyone who can sign in to Querier", icon: "globe" });
    out.push({ subject: { kind: "condition", when: "" }, label: "Anyone matching a condition…", detail: "By their directory attributes: department, title…", icon: "filter" });
    return out;
  });
  $effect(() => {
    options;
    active = 0;
  });

  function pick(p: Pick) {
    picked = p;
    query = "";
    focused = false;
    // a condition is written in its editor, first thing
    if (p.subject.kind === "condition") (condition = ""), (editing = true);
  }
  function onkeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") active = Math.min(options.length - 1, active + 1);
    else if (e.key === "ArrowUp") active = Math.max(0, active - 1);
    else if (e.key === "Enter" && options[active]) pick(options[active]);
    else if (e.key === "Escape" && (query || focused)) {
      e.stopPropagation();
      query ? (query = "") : input?.blur();
    } else return;
    e.preventDefault();
  }

  async function add() {
    if (!picked || busy) return;
    const subject: Subject = picked.subject.kind === "condition" ? { kind: "condition", when: condition.trim() } : picked.subject;
    if (subject.kind === "condition" && !subject.when) return void (error = "Write the condition first.");
    // someone who already has a role here: theirs changes, rather than a second one
    const had = grants?.find((g) => JSON.stringify(g.subject) === JSON.stringify(subject));
    if (had) {
      busy = true;
      await change(had, role);
      busy = false;
      if (!error) (picked = null), (condition = "");
      return;
    }
    busy = true;
    error = "";
    try {
      const g = await api.access.grant(what.scope, what.target, subject, role);
      grants = [...(grants ?? []), g];
      picked = null;
      condition = "";
    } catch (e: any) {
      error = e.message;
    }
    busy = false;
  }

  /** A new role: the new grant first, then the old one goes (never a moment without access). */
  async function change(g: Grant, to: Role) {
    if (to === g.role) return;
    error = "";
    try {
      const made = await api.access.grant(what.scope, what.target, g.subject, to);
      await api.access.revoke(what.scope, what.target, g.id);
      grants = (grants ?? []).map((x) => (x.id === g.id ? made : x));
    } catch (e: any) {
      error = e.message;
      await load();
    }
  }
  async function remove(g: Grant) {
    error = "";
    try {
      await api.access.revoke(what.scope, what.target, g.id);
      grants = (grants ?? []).filter((x) => x.id !== g.id);
    } catch (e: any) {
      error = e.message;
    }
  }

  const iconOf = (s: Subject) => (s.kind === "user" ? "person" : s.kind === "group" ? "organization" : s.kind === "everyone" ? "globe" : "filter");
  // -- a condition: suggestions from what people and resources are tagged with; checked as it is typed
  let vocabulary = $state<CedarVocabulary | null>(null);
  $effect(() => {
    if (picked?.subject.kind !== "condition" || vocabulary) return;
    api.access.vocabulary().then((v) => (vocabulary = v), () => {});
  });
  /** the condition's editor (a modal one, over this dialog) is open */
  let editing = $state(false);
  const checkCondition = async (when: string) => (await api.access.check(when)).problems;

  const EXAMPLE = 'principal.hasTag("department") && principal.getTag("department").contains("Finance")';
</script>

<OverlayPanel icon={ws ? "organization" : conn ? "plug" : "person-add"} title={ws || conn ? `Manage access: ${what.title}` : `Share: ${what.title}`} compact {onclose}>
  <div class="body">
    <p class="lede">
      {#if ws}
        Roles apply to every notebook in the workspace. A notebook can also be shared on its own.
      {:else if conn}
        Who may run with this connection. {what.detail ?? ""}
      {:else}
        A share gives access to this notebook only. The workspace's roles apply as well.
      {/if}
    </p>

    <div class="add">
      {#if picked}
        <div class="picked">
          <span class="chip">
            <Icon name={picked.icon} size={14} />
            <span class="who">{picked.label}</span>
            <button class="icon x" title="Pick someone else" aria-label="Pick someone else" onclick={() => ((picked = null), queueMicrotask(() => input?.focus()))}><Icon name="close" size={12} /></button>
          </span>
          <Select bind:value={role} options={roleOptions} label="Role" />
          <button class="primary" disabled={busy || (picked.subject.kind === "condition" && !condition.trim())} onclick={add}>{ws || conn ? "Add" : "Share"}</button>
        </div>
        {#if picked.subject.kind === "condition" && condition}
          <!-- the condition as applied, coloured; its editor opens again on Edit (or a double click) -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="cond" transition:slide={{ duration: 140 }} ondblclick={() => (editing = true)}>
            <CodeInput value={condition} onchange={() => {}} label="Condition" readOnly minLines={1} maxLines={4} />
            <button class="btn edit" onclick={() => (editing = true)}><Icon name="edit" size={14} />Edit…</button>
          </div>
        {/if}
        <p class="hint">{ROLE_HINT[role]}</p>
      {:else}
        <label class="search" class:open={focused}>
          <Icon name="search" size={14} />
          <input
            bind:this={input}
            bind:value={query}
            placeholder="Add people or groups"
            spellcheck="false"
            autocomplete="off"
            role="combobox"
            aria-expanded={focused}
            aria-controls="access-options"
            onfocus={() => (focused = true)}
            onblur={() => setTimeout(() => (focused = false), 120)}
            {onkeydown}
          />
        </label>
        {#if focused}
          <ul class="options" id="access-options" role="listbox" transition:slide={{ duration: 120 }}>
            {#each options as o, i (o.label + o.detail)}
              <li role="option" aria-selected={i === active}>
                <button class:active={i === active} onmousedown={(e) => e.preventDefault()} onclick={() => pick(o)} onmouseenter={() => (active = i)}>
                  <span class="oic"><Icon name={o.icon} size={16} /></span>
                  <span class="txt"><span class="l">{o.label}</span>{#if o.detail}<span class="d">{o.detail}</span>{/if}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </div>

    {#if error}<p class="error" role="alert">{error}</p>{/if}

    <h3>{ws || conn ? "People and groups with a role" : "Shared with"}</h3>
    {#if grants == null}
      <p class="muted">{error ? "" : "Loading…"}</p>
    {:else if !grants.length}
      <p class="muted">
        {ws ? "Nobody has a role yet: only the system administrator sees this workspace." : conn ? "Nobody has a role on it of its own." : "Not shared with anyone on its own."}
      </p>
    {:else}
      <ul class="grants">
        {#each grants as g (g.id)}
          <li transition:slide={{ duration: 140 }}>
            <span class="gic"><Icon name={iconOf(g.subject)} size={16} /></span>
            <span class="txt">
              {#if g.subject.kind === "condition"}
                <span class="l">Anyone where</span><code class="when" title={g.subject.when}>{g.subject.when}</code>
              {:else}
                <span class="l">{g.label}</span>{#if g.detail}<span class="d">{g.detail}</span>{/if}
              {/if}
            </span>
            <Select value={g.role} options={roleOptions} label="Role of {g.label}" disabled={!mayGive(g.role)} compact onchange={(r) => change(g, r)} />
            <button class="icon rm" title="Remove" aria-label="Remove {g.label}" disabled={!mayGive(g.role)} onclick={() => remove(g)}><Icon name="close" size={14} /></button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</OverlayPanel>

{#if editing && picked?.subject.kind === "condition"}
  <CodeEditorPanel
    file="condition.cedar"
    detail={ws ? `who gets ${role} in the workspace ${what.title}` : conn ? `who gets ${role} of the connection ${what.title}` : `who gets ${role} on the notebook ${what.title}`}
    crumbs={ws ? [what.title, "Access", role] : conn ? ["Connections", what.title, role] : [what.title, "Sharing", role]}
    value={condition}
    placeholder={EXAMPLE}
    {vocabulary}
    check={checkCondition}
    help="Anyone whose attributes make this true. Start typing, or Ctrl+Space, for their tags and values."
    onapply={(v) => {
      condition = v;
      editing = false;
    }}
    onclose={() => {
      editing = false;
      // nothing written: back to picking someone
      if (!condition) (picked = null), queueMicrotask(() => input?.focus());
    }}
  />
{/if}

<style>
  .body {
    padding: 0.875rem 1rem 1.125rem;
    font-size: 0.8125rem;
  }
  .lede {
    margin: 0 0 0.875rem;
    color: var(--wb-fg-muted);
  }
  .add {
    position: relative;
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
  .search.open {
    border-color: var(--wb-accent);
  }
  .search input,
  .search input:focus,
  .search input:focus-visible {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    outline: 0;
    box-shadow: none;
    padding: 0;
    font: inherit;
    color: var(--wb-fg);
    background: transparent;
  }
  /* in the flow, not floating: the dialog scrolls its content, so a floating list would be cut off */
  .options {
    max-height: 15rem;
    margin: 4px 0 0;
    padding: 4px;
    overflow-y: auto;
    list-style: none;
    background: var(--wb-editor);
    border: 1px solid var(--wb-input-border);
    border-radius: 6px;
  }
  .options button {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    padding: 0.3125rem 0.5rem;
    text-align: left;
    border-radius: 4px;
    color: var(--wb-fg);
  }
  .options button.active {
    background: var(--wb-list-active);
  }
  .oic,
  .gic {
    display: flex;
    flex: none;
    color: var(--wb-fg-muted);
  }
  .txt {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .l {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .d {
    font-size: 0.75rem;
    color: var(--wb-fg-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .picked {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    flex: 1;
    min-width: 0;
    height: 1.875rem;
    padding: 0 0.25rem 0 0.5rem;
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
    background: var(--wb-list-hover);
  }
  .who {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .x {
    width: 1.25rem;
    height: 1.25rem;
    color: var(--wb-fg-muted);
  }
  .primary {
    height: 1.875rem;
    padding: 0 0.875rem;
  }
  .cond {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .cond > :global(.code-input) {
    flex: 1;
    min-width: 0;
    cursor: pointer;
  }
  .btn.edit {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    flex: none;
    height: 1.875rem;
    padding: 0 0.75rem;
    font-size: 0.8125rem;
    color: var(--wb-fg);
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
  }
  .btn.edit:hover {
    background: var(--wb-list-hover);
  }
  .hint {
    margin: 0.375rem 0 0;
    font-size: 0.75rem;
    color: var(--wb-fg-dim);
  }
  .error {
    margin: 0.625rem 0 0;
    padding: 0.375rem 0.5rem;
    font-size: 0.78rem;
    color: var(--critical);
    border-left: 2px solid currentColor;
    background: color-mix(in srgb, currentColor 7%, transparent);
  }
  h3 {
    margin: 1.25rem 0 0.375rem;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--wb-fg-muted);
  }
  .muted {
    margin: 0.25rem 0;
    color: var(--wb-fg-dim);
  }
  .grants {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .grants li {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.375rem 0.25rem;
    border-bottom: 1px solid var(--wb-border);
  }
  .grants li:last-child {
    border-bottom: 0;
  }
  .when {
    font: 0.72rem/1.4 var(--mono);
    color: var(--wb-fg-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rm {
    width: 1.5rem;
    height: 1.5rem;
    color: var(--wb-fg-muted);
    visibility: hidden;
  }
  .grants li:hover .rm,
  .rm:focus-visible {
    visibility: visible;
  }
</style>
