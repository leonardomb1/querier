<script lang="ts">
  import { api, type ConnectionInfo } from "../../lib/api";
  import Icon from "../Icon.svelte";
  import OverlayPanel from "../wb/OverlayPanel.svelte";

  // A connection's values: its shared ones (who manages it), or one's own (a
  // per-person connection). They go in and never come back: a set one shows as
  // set, and is kept unless something new is typed or it is cleared.
  let { connection, onsaved, onclose }: { connection: ConnectionInfo; onsaved: (c: ConnectionInfo) => void; onclose: () => void } = $props();

  const own = $derived(connection.credentials === "per-user");
  const isSet = (v: string) => (own ? connection.mine : connection.set).includes(v);
  // svelte-ignore state_referenced_locally
  let values = $state<Record<string, string>>(Object.fromEntries(connection.variables.map((v) => [v, ""])));
  let cleared = $state<Record<string, boolean>>({});
  let shown = $state<Record<string, boolean>>({});
  let error = $state("");
  let busy = $state(false);

  const changes = $derived(
    Object.fromEntries([
      ...Object.entries(values).filter(([, v]) => v !== ""),
      ...Object.entries(cleared).filter(([k, c]) => c && !values[k]).map(([k]) => [k, null]),
    ]) as Record<string, string | null>,
  );

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (busy || !Object.keys(changes).length) return;
    busy = true;
    error = "";
    try {
      onsaved(own ? await api.connections.setMine(connection.id, changes) : await api.connections.setValues(connection.id, changes));
    } catch (err: any) {
      error = err.message;
    }
    busy = false;
  }
  // a password manager may offer to fill these: they aren't a login
  const guessy = (v: string) => /PASS|SECRET|TOKEN|KEY/i.test(v);
</script>

<OverlayPanel icon="key" title={own ? `Your credentials: ${connection.name}` : `Credentials: ${connection.name}`} detail={own ? "only yours: your kernels run with them" : "shared: every kernel that may use it gets them"} compact {onclose}>
  <form class="form" onsubmit={save} autocomplete="off">
    <p class="lede">
      {#if own}
        {connection.name} takes each person's own credentials. What you enter here is yours: your kernels run with it, no one else's, and it never comes back to this page.
      {:else}
        Set once for everyone who may use {connection.name}. Values never come back to this page: a set one stays as it is unless you type a new one.
      {/if}
    </p>
    {#each connection.variables as v (v)}
      <div class="row">
        <code class="name">{v}</code>
        <span class="input">
          <input
            type={shown[v] || !guessy(v) ? "text" : "password"}
            bind:value={values[v]}
            placeholder={cleared[v] ? "cleared on save" : isSet(v) ? "set: type to replace" : "not set"}
            autocomplete={guessy(v) ? "new-password" : "off"}
            spellcheck="false"
            aria-label={v}
          />
          {#if guessy(v)}
            <button type="button" class="icon" title={shown[v] ? "Hide" : "Show"} aria-label={shown[v] ? "Hide the value" : "Show the value"} onclick={() => (shown[v] = !shown[v])}>
              <Icon name={shown[v] ? "eye-closed" : "eye"} size={14} />
            </button>
          {/if}
        </span>
        {#if isSet(v)}
          <button type="button" class="link" class:on={cleared[v]} onclick={() => ((cleared[v] = !cleared[v]), (values[v] = ""))}>{cleared[v] ? "Keep" : "Clear"}</button>
        {:else}
          <span class="link-gap"></span>
        {/if}
      </div>
    {/each}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <footer>
      <span class="note">Kernels already running keep the old values until restarted.</span>
      <button type="button" class="btn" onclick={onclose}>Cancel</button>
      <button type="submit" class="primary" disabled={busy || !Object.keys(changes).length}>Save</button>
    </footer>
  </form>
</OverlayPanel>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 1rem 1.125rem;
    font-size: 0.8125rem;
  }
  .lede {
    margin: 0 0 0.25rem;
    color: var(--wb-fg-muted);
    line-height: 1.5;
  }
  .row {
    display: grid;
    grid-template-columns: 10rem minmax(0, 1fr) 3rem;
    align-items: center;
    gap: 0.5rem;
  }
  .name {
    font-size: 0.78rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .input {
    position: relative;
    display: flex;
  }
  input {
    box-sizing: border-box;
    width: 100%;
    height: 1.75rem;
    padding: 0 1.75rem 0 0.5rem;
    font: 0.8125rem var(--mono);
    color: var(--wb-fg);
    background: var(--wb-input);
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
  }
  input:focus {
    outline: none;
    border-color: var(--wb-accent);
  }
  input::placeholder {
    font-family: var(--sans);
    color: var(--wb-fg-dim);
  }
  .input .icon {
    position: absolute;
    right: 0.125rem;
    top: 0.125rem;
    width: 1.5rem;
    height: 1.5rem;
    color: var(--wb-fg-muted);
  }
  .link {
    font-size: 0.75rem;
    color: var(--wb-accent);
  }
  .link.on {
    color: var(--critical);
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
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.375rem;
  }
  .note {
    flex: 1;
    font-size: 0.75rem;
    color: var(--wb-fg-dim);
  }
  .btn {
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
</style>
