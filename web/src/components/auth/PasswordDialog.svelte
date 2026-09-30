<script lang="ts">
  import { api } from "../../lib/api";
  import { session } from "../../lib/session.svelte";
  import Icon from "../Icon.svelte";
  import OverlayPanel from "../wb/OverlayPanel.svelte";

  // The sysadmin's password, Querier's own account's (one from .env changes
  // there). The first sign-in, with the generated password from the log, opens
  // this to choose one's own; the account menu opens it after. The current
  // password isn't asked while it is the generated one: signing in just proved it.
  let { onclose }: { onclose: () => void } = $props();

  const MIN = 12;
  const first = $derived(!!session.password?.mustChange);
  let current = $state("");
  let next = $state("");
  let again = $state("");
  let shown = $state(false);
  let error = $state("");
  let busy = $state(false);

  const problem = $derived(
    next.length > 0 && next.length < MIN ? `At least ${MIN} characters.` : again && next !== again ? "The two don't match." : "",
  );
  const ready = $derived((first || current) && next.length >= MIN && next === again);

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (busy || !ready) return;
    busy = true;
    error = "";
    try {
      session.password = (await api.auth.changePassword(current, next)).password;
      onclose();
    } catch (err: any) {
      error = err.message;
    }
    busy = false;
  }
</script>

<OverlayPanel icon="lock" title={first ? "Choose your password" : "Change password"} detail="system administrator" compact {onclose}>
  <form class="form" onsubmit={save}>
    <p class="lede">
      {#if first}
        You signed in with the password Querier generated on its first start. Choose your own: the generated one stops working, and stops being printed to the log.
      {:else}
        Other sessions of the system administrator end; this one stays signed in.
      {/if}
    </p>
    <!-- for password managers: whose password this is -->
    <input class="hidden" type="text" autocomplete="username" value={session.me?.username ?? ""} readonly tabindex="-1" aria-hidden="true" />
    {#if !first}
      <label class="row">
        <span>Current password</span>
        <input type={shown ? "text" : "password"} bind:value={current} autocomplete="current-password" />
      </label>
    {/if}
    <label class="row">
      <span>New password</span>
      <span class="input">
        <!-- svelte-ignore a11y_autofocus -->
        <input type={shown ? "text" : "password"} bind:value={next} autocomplete="new-password" autofocus={first} placeholder="at least {MIN} characters" />
        <button type="button" class="icon" title={shown ? "Hide" : "Show"} aria-label={shown ? "Hide the passwords" : "Show the passwords"} onclick={() => (shown = !shown)}>
          <Icon name={shown ? "eye-closed" : "eye"} size={14} />
        </button>
      </span>
    </label>
    <label class="row">
      <span>Again</span>
      <input type={shown ? "text" : "password"} bind:value={again} autocomplete="new-password" />
    </label>
    {#if error || problem}<p class="error" role="alert">{error || problem}</p>{/if}
    <footer>
      <span class="note">{first ? "Lost later? Delete sysadmin.json in the config folder and restart." : ""}</span>
      <button type="button" class="btn" onclick={onclose}>{first ? "Later" : "Cancel"}</button>
      <button type="submit" class="primary" disabled={busy || !ready}>{first ? "Set password" : "Change"}</button>
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
  .hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }
  .row {
    display: grid;
    grid-template-columns: 9rem minmax(0, 1fr);
    align-items: center;
    gap: 0.5rem;
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
    min-width: 0;
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
