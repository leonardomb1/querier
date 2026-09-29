<script lang="ts">
  import { onMount } from "svelte";
  import { api, type Action, type PolicyFile, type PolicyIndex } from "../../lib/api";
  import type { CedarVocabulary } from "../../lib/cedarcomplete";
  import { ask, askText, notifyError } from "../../lib/dialog.svelte";
  import Icon from "../Icon.svelte";
  import CodeEditorPanel from "../ui/CodeEditorPanel.svelte";
  import CodeInput from "../ui/CodeInput.svelte";
  import InfoTip from "../ui/InfoTip.svelte";

  // The custom policies: Cedar files in the config folder's policies/, evaluated
  // with the roles and shares people are given (a forbid wins over any permit).
  // Each opens in the modal editor, checked as it is typed; a file with errors
  // isn't saved, and a set that doesn't load keeps the last valid one in force.
  let index = $state<PolicyIndex | null>(null);
  let vocab = $state<CedarVocabulary | null>(null);
  let error = $state("");
  let editing = $state<{ name: string; text: string; isNew: boolean } | null>(null);
  let showRoles = $state(false);

  async function load() {
    try {
      index = await api.admin.policies();
    } catch (e: any) {
      error = e.message;
    }
  }
  onMount(() => {
    load();
    api.access.vocabulary().then((v) => (vocab = v), () => {});
  });

  const vocabulary = $derived<CedarVocabulary | null>(
    index ? { ...(vocab ?? { tags: {}, groups: [], resourceTags: {} }), policies: { actions: index.actions, workspaces: index.workspaces } } : null,
  );
  const count = (text: string) => (text.match(/^\s*(permit|forbid)\b/gm) ?? []).length;
  const errorsOf = (f: PolicyFile) => f.problems.filter((p) => !p.warning).length;
  const warningsOf = (f: PolicyFile) => f.problems.filter((p) => p.warning).length;

  const TEMPLATE = `// Who may do what, beyond the roles and shares given in Manage access.
// A forbid wins over any permit. Ctrl+Space suggests: actions, tags, groups.
//
// e.g. restricted notebooks: only their stewards run them
// forbid (principal, action == Action::"notebook.run", resource)
// when {
//   resource.hasTag("classification") && resource.getTag("classification").contains("restricted")
//   && !(principal in Group::"data-stewards")
// };
`;

  async function create() {
    const name = await askText("New policy file", {
      detail: "Its name: letters, digits, - and _. It is saved as <name>.cedar.",
      placeholder: "restricted-data",
      ok: "Create",
      validate: (v) => (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v.trim().replace(/\.cedar$/, "")) ? null : "Letters, digits, - and _."),
    });
    if (!name) return;
    const file = `${name.trim().replace(/\.cedar$/, "")}.cedar`;
    if (index?.files.some((f) => f.name === file)) return void (await notifyError("That file exists", `${file} is already there: open it instead.`));
    editing = { name: file, text: TEMPLATE, isNew: true };
  }
  async function remove(f: PolicyFile) {
    if (!(await ask(`Delete ${f.name}?`, { detail: `Its ${count(f.text)} polic${count(f.text) === 1 ? "y goes" : "ies go"} out of force at once.`, ok: "Delete", danger: true }))) return;
    try {
      await api.admin.remove(f.name);
      await load();
    } catch (e) {
      await notifyError(`Couldn't delete ${f.name}`, e);
    }
  }
  async function save(text: string) {
    const e = editing!;
    await api.admin.save(e.name, text);
    editing = null;
    await load();
  }

  const ROLE_GROUPS = $derived(
    index
      ? [
          { title: "Workspace roles", roles: index.roles.workspace },
          { title: "Notebook shares", roles: index.roles.share },
          { title: "Connection roles", roles: index.roles.connection },
        ]
      : [],
  );
  const short = (a: Action) => a;
</script>

<div class="adm">
  <header class="adm-head">
    <div class="grow">
      <h2>Policies</h2>
      <p>
        Cedar policies evaluated with the roles and shares given in Manage access. A <code>forbid</code> wins over any <code>permit</code>, and a policy that errors counts as a denial.
        {#if index}<InfoTip text={`Files in ${index.folder}: edit them here, or keep them in git; a change on disk is picked up at once.`} />{/if}
      </p>
    </div>
    <button class="primary" onclick={create}><Icon name="add" size={14} />New policy file</button>
  </header>

  {#if error}<p class="error">{error}</p>{/if}

  {#if index?.problems.length}
    <div class="broken" role="alert">
      <Icon name="warning" size={16} />
      <div>
        <strong>The policy files don't load together:</strong> the last set that did stays in force until they're fixed.
        <ul>
          {#each index.problems as p, i (i)}<li><code>{p.policy}</code> {p.message}</li>{/each}
        </ul>
      </div>
    </div>
  {/if}

  {#if index}
    <h3>Policy files</h3>
    {#if index.files.length}
      <ul class="files">
        {#each index.files as f (f.name)}
          <li>
            <button class="open" onclick={() => (editing = { name: f.name, text: f.text, isNew: false })}>
              <span class="ic"><Icon name="shield" size={16} /></span>
              <span class="name">{f.name}</span>
              <span class="meta">{count(f.text)} polic{count(f.text) === 1 ? "y" : "ies"}</span>
              {#if errorsOf(f)}<span class="bad"><Icon name="error" size={13} />{errorsOf(f)}</span>{/if}
              {#if warningsOf(f)}<span class="warn"><Icon name="warning" size={13} />{warningsOf(f)}</span>{/if}
            </button>
            <button class="icon" title="Delete" aria-label="Delete {f.name}" onclick={() => remove(f)}><Icon name="trash" size={14} /></button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted">None: only the roles and shares decide. A policy file adds rules they can't express, such as by attribute or classification.</p>
    {/if}

    <h3>Built in</h3>
    <p class="muted">
      {index.grants} grant{index.grants === 1 ? "" : "s"} in force, each a policy: the roles and shares given in Manage access.
      <button class="link" onclick={() => (showRoles = !showRoles)}>{showRoles ? "Hide" : "Show"} what each role gives</button>
    </p>
    {#if showRoles}
      <div class="roles">
        {#each ROLE_GROUPS as g (g.title)}
          <table>
            <caption>{g.title}</caption>
            <tbody>
              {#each Object.entries(g.roles) as [role, actions] (role)}
                <tr>
                  <th>{role}</th>
                  <td><span class="chips">{#each actions as a (a)}<span class="chip">{short(a)}</span>{/each}</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/each}
      </div>
    {/if}

    {#if index.files.length}
      <h3>In force</h3>
      {#each index.files.filter((f) => f.text.trim()) as f (f.name)}
        <p class="file-label"><code>{f.name}</code></p>
        <CodeInput value={f.text} onchange={() => {}} readOnly minLines={2} maxLines={14} label={f.name} />
      {/each}
    {/if}
  {:else if !error}
    <p class="muted">Loading…</p>
  {/if}
</div>

{#if editing && vocabulary}
  <CodeEditorPanel
    file={editing.name}
    detail={editing.isNew ? "a new policy file" : "a policy file: saved and in force at once"}
    crumbs={["Administration", "Policies"]}
    value={editing.text}
    {vocabulary}
    check={async (text) => (await api.admin.check(text)).problems}
    help="Cedar policies. Ctrl+Space for permit, forbid, actions, tags and groups."
    applyLabel="Save"
    allowEmpty
    dirtyOnly={!editing.isNew}
    onapply={save}
    onclose={() => (editing = null)}
  />
{/if}

<style>
  code {
    font-size: 0.78rem;
  }
  .broken {
    display: flex;
    gap: 0.625rem;
    padding: 0.625rem 0.875rem;
    font-size: 0.8125rem;
    color: var(--wb-fg);
    border: 1px solid color-mix(in srgb, var(--warning) 50%, var(--wb-border));
    border-radius: 5px;
    background: color-mix(in srgb, var(--warning) 7%, transparent);
  }
  .broken :global(i) {
    flex: none;
    color: var(--warning);
  }
  .broken ul {
    margin: 0.375rem 0 0;
    padding-left: 1.125rem;
  }
  .files {
    margin: 0;
    padding: 0;
    list-style: none;
    border-top: 1px solid var(--wb-border);
  }
  .files li {
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--wb-border);
  }
  .open {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    flex: 1;
    min-width: 0;
    height: 2.25rem;
    padding: 0 0.5rem;
    text-align: left;
    color: var(--wb-fg);
  }
  .open:hover {
    background: var(--wb-list-hover);
  }
  .ic {
    display: flex;
    color: var(--wb-accent);
  }
  .name {
    font-family: var(--mono);
    font-size: 0.8125rem;
  }
  .meta {
    flex: 1;
    font-size: 0.75rem;
    color: var(--wb-fg-dim);
  }
  .bad,
  .warn {
    display: inline-flex;
    align-items: center;
    gap: 0.1875rem;
    font-size: 0.75rem;
  }
  .bad {
    color: var(--critical);
  }
  .warn {
    color: var(--warning);
  }
  .files .icon {
    width: 1.75rem;
    height: 1.75rem;
    color: var(--wb-fg-muted);
  }
  .link {
    margin-left: 0.25rem;
    font-size: 0.8125rem;
    color: var(--wb-accent);
  }
  .roles {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-top: 0.5rem;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
  }
  caption {
    padding-bottom: 0.25rem;
    text-align: left;
    font-weight: 600;
  }
  th {
    width: 7rem;
    padding: 0.375rem 0.5rem 0.375rem 0;
    text-align: left;
    vertical-align: top;
    font-weight: 500;
  }
  td {
    padding: 0.3125rem 0;
    border-top: 1px solid var(--wb-border);
  }
  tr:first-child td {
    border-top: 0;
  }
  .file-label {
    margin: 0.75rem 0 0.25rem;
  }
</style>
