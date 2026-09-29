<script lang="ts">
  import { api, type ConnectionInfo } from "../../lib/api";
  import Icon from "../Icon.svelte";
  import Select from "../ui/Select.svelte";
  import OverlayPanel from "../wb/OverlayPanel.svelte";

  // A connection's definition, new or changed: its name, the variables it gives a
  // kernel, and whose credentials they are. Its values are set apart (Credentials…).
  let {
    connection = null,
    workspace,
    onsaved,
    onclose,
  }: {
    /** the one to change; none: a new one */
    connection?: ConnectionInfo | null;
    /** a new one's workspace; none: everyone's */
    workspace?: string;
    onsaved: (c: ConnectionInfo) => void;
    onclose: () => void;
  } = $props();

  type Kind = "basalt" | "token" | "custom";
  // svelte-ignore state_referenced_locally
  let name = $state(connection?.name ?? "");
  // svelte-ignore state_referenced_locally
  let description = $state(connection?.description ?? "");
  // svelte-ignore state_referenced_locally
  let credentials = $state<"shared" | "per-user">(connection?.credentials ?? "shared");
  // svelte-ignore state_referenced_locally
  let kind = $state<Kind>(connection ? "custom" : "basalt");
  // svelte-ignore state_referenced_locally
  let variables = $state<string[]>(connection ? [...connection.variables] : []);
  let error = $state("");
  let busy = $state(false);

  // the variables follow the name, as basalt names them, until they are edited by hand
  const prefix = $derived(name.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^(?=\d)/, "_"));
  const suggested = $derived(!prefix ? [] : kind === "basalt" ? [`${prefix}_USER`, `${prefix}_PASS`] : kind === "token" ? [`${prefix}_TOKEN`] : null);
  $effect(() => {
    if (suggested) variables = suggested;
  });

  const KINDS = [
    { value: "basalt" as Kind, label: "A basalt connection", description: "CREATE CONNECTION <name> reads <NAME>_USER and <NAME>_PASS by itself." },
    { value: "token" as Kind, label: "A token", description: "One variable, <NAME>_TOKEN: OPTIONS token = env('<NAME>_TOKEN'), or os.environ in Python." },
    { value: "custom" as Kind, label: "Variables of my choosing", description: "Any environment variables: a host, a key, a URL…" },
  ];
  const CREDENTIALS = [
    { value: "shared" as const, label: "Shared", description: "Set once, by who manages it; every kernel that may use it gets the same values." },
    { value: "per-user" as const, label: "Each person's own", description: "Everyone who may use it enters their own; a kernel runs with its owner's (as single sign-on would)." },
  ];

  const clean = $derived(variables.map((v) => v.trim()).filter(Boolean));
  const changesCredentials = $derived(!!connection && connection.credentials !== credentials && (connection.set.length > 0 || connection.mine.length > 0));

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (busy) return;
    busy = true;
    error = "";
    try {
      const body = { name: name.trim(), description: description.trim() || (connection ? null : undefined), variables: clean, credentials };
      onsaved(connection ? await api.connections.update(connection.id, body) : await api.connections.create({ ...body, description: body.description ?? undefined, workspace }));
    } catch (err: any) {
      error = err.message;
    }
    busy = false;
  }
</script>

<OverlayPanel icon="plug" title={connection ? `Edit connection: ${connection.name}` : "New connection"} detail={workspace ? `in the workspace ${workspace}` : connection?.workspace ? `in ${connection.workspace}` : "for everyone"} compact {onclose}>
  <form class="form" onsubmit={save}>
    <label>
      <span class="l">Name</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input bind:value={name} class="mono" spellcheck="false" autocomplete="off" placeholder="sr" autofocus />
      <span class="hint">As a notebook calls it: <code>CREATE CONNECTION {name || "sr"}</code>.</span>
    </label>

    {#if !connection}
      <div class="field">
        <span class="l">What it is</span>
        <Select bind:value={kind} options={KINDS} label="What it is" />
      </div>
    {/if}

    <div class="field">
      <span class="l">Variables a kernel gets</span>
      <div class="vars">
        {#each variables as _, i (i)}
          <span class="var">
            <input
              class="mono"
              value={variables[i]}
              spellcheck="false"
              aria-label="Variable {i + 1}"
              oninput={(e) => ((kind = "custom"), (variables[i] = e.currentTarget.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_")))}
            />
            <button type="button" class="icon" title="Remove" aria-label="Remove {variables[i]}" onclick={() => ((kind = "custom"), variables.splice(i, 1))}><Icon name="close" size={14} /></button>
          </span>
        {/each}
        <button type="button" class="btn" onclick={() => ((kind = "custom"), variables.push(""))}><Icon name="add" size={14} />Variable</button>
      </div>
    </div>

    <div class="field">
      <span class="l">Credentials</span>
      <Select bind:value={credentials} options={CREDENTIALS} label="Credentials" />
      <span class="hint">{CREDENTIALS.find((c) => c.value === credentials)?.description}</span>
      {#if changesCredentials}<span class="hint warn"><Icon name="warning" size={13} />Its values (shared, or everyone's own) are cleared: they are set again the other way.</span>{/if}
    </div>

    <label>
      <span class="l">Description <span class="opt">optional</span></span>
      <textarea bind:value={description} rows="2" placeholder="What it reaches: the StarRocks cluster, read-only…"></textarea>
    </label>

    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <footer>
      <button type="button" class="btn" onclick={onclose}>Cancel</button>
      <button type="submit" class="primary" disabled={busy || !name.trim() || !clean.length}>{connection ? "Save" : "Create"}</button>
    </footer>
  </form>
</OverlayPanel>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    padding: 1rem 1.125rem 1rem;
    font-size: 0.8125rem;
  }
  label,
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3125rem;
  }
  .l {
    font-weight: 600;
    color: var(--wb-fg);
  }
  .opt {
    font-weight: 400;
    color: var(--wb-fg-dim);
  }
  input,
  textarea {
    box-sizing: border-box;
    width: 100%;
    height: 1.75rem;
    padding: 0 0.5rem;
    font: inherit;
    color: var(--wb-fg);
    background: var(--wb-input);
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
  }
  textarea {
    height: auto;
    padding: 0.375rem 0.5rem;
    resize: vertical;
  }
  input:focus,
  textarea:focus {
    outline: none;
    border-color: var(--wb-accent);
  }
  .mono {
    font-family: var(--mono);
  }
  .field :global(.select) {
    align-self: flex-start;
    min-width: 16rem;
  }
  .hint {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    font-size: 0.75rem;
    color: var(--wb-fg-dim);
  }
  .hint.warn {
    color: var(--warning);
  }
  .vars {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .var {
    display: inline-flex;
    align-items: center;
    width: 12rem;
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
    background: var(--wb-input);
  }
  .var:focus-within {
    border-color: var(--wb-accent);
  }
  .var input {
    border: 0;
    background: none;
  }
  .var .icon {
    width: 1.5rem;
    height: 1.5rem;
    flex: none;
    color: var(--wb-fg-muted);
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    height: 1.75rem;
    padding: 0 0.75rem;
    font-size: 0.8125rem;
    color: var(--wb-fg);
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
  }
  .btn:hover {
    background: var(--wb-list-hover);
  }
  .primary {
    height: 1.75rem;
    padding: 0 0.875rem;
  }
  .error {
    margin: 0;
    padding: 0.375rem 0.5rem;
    font-size: 0.78rem;
    color: var(--critical);
    border-left: 2px solid currentColor;
    background: color-mix(in srgb, currentColor 7%, transparent);
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
</style>
