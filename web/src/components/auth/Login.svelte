<script lang="ts">
  import { onMount } from "svelte";
  import { api, type SignIn } from "../../lib/api";
  import { session } from "../../lib/session.svelte";
  import Icon from "../Icon.svelte";

  // Signing in: a button per OIDC provider (Microsoft Entra, Keycloak…), and a
  // username and password for a directory (Active Directory) or the sysadmin.
  let { providers, next, error: given, insecure }: { providers: SignIn[]; next: string; error: string; insecure: boolean } = $props();

  // svelte-ignore state_referenced_locally
  const redirects = providers.filter((p) => p.kind === "redirect");
  // svelte-ignore state_referenced_locally
  const passwords = providers.filter((p) => p.kind === "password");
  // the directory first; the sysadmin last, as the way in when the others are down
  let via = $state(passwords[0]?.id ?? "sysadmin");
  let username = $state("");
  let password = $state("");
  let busy = $state(false);
  // svelte-ignore state_referenced_locally
  let error = $state(given);
  let userInput = $state<HTMLInputElement>();
  onMount(() => userInput?.focus());

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!username || !password || busy) return;
    busy = true;
    error = "";
    try {
      await api.auth.login(via, username, password);
      await session.load();
      location.hash = next;
    } catch (err: any) {
      error = err.message;
      password = "";
      busy = false;
    }
  }
  const start = (p: SignIn) => `/api/auth/oidc/${encodeURIComponent(p.id)}/start?next=${encodeURIComponent(next)}`;
  const ICON: Record<string, string> = { oidc: "key", ldap: "organization", sysadmin: "shield" };
</script>

<main class="login">
  <div class="card">
    <header>
      <Icon name="notebook" size={28} />
      <h1>querier</h1>
    </header>
    <p class="lede">Sign in to continue</p>

    {#if error}
      <p class="error" role="alert"><Icon name="error" size={14} />{error}</p>
    {/if}

    {#if redirects.length}
      <div class="sso">
        {#each redirects as p (p.id)}
          <a class="btn sso-btn" href={start(p)}><Icon name={ICON[p.type]} size={16} />Continue with {p.label}</a>
        {/each}
      </div>
      {#if passwords.length}<div class="or"><span>or</span></div>{/if}
    {/if}

    {#if passwords.length}
      {#if passwords.length > 1}
        <div class="via" role="tablist" aria-label="Sign in with">
          {#each passwords as p (p.id)}
            <button role="tab" class:on={via === p.id} aria-selected={via === p.id} onclick={() => ((via = p.id), (error = ""))}>
              <Icon name={ICON[p.type]} size={14} />{p.label}
            </button>
          {/each}
        </div>
      {/if}
      {#if insecure}
        <p class="warn"><Icon name="warning" size={14} />This page isn't served over HTTPS: passwords would travel in the clear, so the server refuses them.</p>
      {/if}
      <form onsubmit={submit}>
        <label>
          <span>{via === "sysadmin" ? "Administrator" : "Username"}</span>
          <input bind:this={userInput} bind:value={username} autocomplete="username" spellcheck="false" autocapitalize="off" />
        </label>
        <label>
          <span>Password</span>
          <input type="password" bind:value={password} autocomplete="current-password" />
        </label>
        <button class="btn primary" type="submit" disabled={!username || !password || busy}>
          {#if busy}<Icon name="loading" size={14} spin />Signing in…{:else}Sign in{/if}
        </button>
      </form>
    {/if}
  </div>
</main>

<style>
  .login {
    min-height: 100vh;
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 1.5rem;
    color: var(--wb-fg);
    background: var(--wb-editor);
  }
  .card {
    width: min(23rem, 100%);
    padding: 1.75rem 1.75rem 1.5rem;
    background: var(--wb-side);
    border: 1px solid var(--wb-border);
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
    animation: rise 0.22s var(--ease) both;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(0.375rem) scale(0.99);
    }
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--wb-accent);
  }
  h1 {
    margin: 0;
    font-size: 1.375rem;
    font-weight: 500;
    letter-spacing: -0.01em;
    color: var(--wb-fg);
  }
  .lede {
    margin: 0.25rem 0 1.25rem;
    color: var(--wb-fg-muted);
    font-size: 0.875rem;
  }
  .error,
  .warn {
    display: flex;
    align-items: flex-start;
    gap: 0.375rem;
    margin: 0 0 1rem;
    padding: 0.5rem 0.625rem;
    font-size: 0.8125rem;
    border-radius: 4px;
  }
  .error {
    color: var(--wb-fg);
    background: color-mix(in srgb, var(--critical) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--critical) 50%, transparent);
  }
  .error :global(i) {
    color: var(--critical);
    margin-top: 0.1rem;
  }
  .warn {
    color: var(--wb-fg);
    background: color-mix(in srgb, var(--stale) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--stale) 45%, transparent);
  }
  .sso {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    height: 2.125rem;
    padding: 0 0.875rem;
    font-size: 0.875rem;
    border-radius: 4px;
    text-decoration: none;
  }
  .sso-btn {
    color: var(--wb-fg);
    background: var(--wb-input);
    border: 1px solid var(--wb-input-border);
  }
  .sso-btn:hover {
    border-color: var(--wb-accent);
  }
  .sso-btn:active {
    transform: scale(0.99);
  }
  .or {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 1.125rem 0;
    font-size: 0.75rem;
    color: var(--wb-fg-dim);
  }
  .or::before,
  .or::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--wb-border);
  }
  .via {
    display: flex;
    gap: 1rem;
    margin-bottom: 0.875rem;
    border-bottom: 1px solid var(--wb-border);
  }
  .via button {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0;
    margin-bottom: -1px;
    border-radius: 0;
    font-size: 0.8125rem;
    color: var(--wb-fg-muted);
    border-bottom: 1px solid transparent;
  }
  .via button:hover {
    background: none;
    color: var(--wb-fg);
  }
  .via button.on {
    color: var(--wb-fg);
    border-bottom-color: var(--wb-accent);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.78rem;
    color: var(--wb-fg-muted);
  }
  input {
    height: 2rem;
    padding: 0 0.5rem;
    font-size: 0.875rem;
    color: var(--wb-fg);
    background: var(--wb-input);
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
  }
  input:focus {
    outline: none;
    border-color: var(--wb-accent);
    box-shadow: 0 0 0 1px var(--wb-accent);
  }
  .primary {
    margin-top: 0.25rem;
    color: #fff;
    background: var(--wb-accent);
  }
  .primary:hover {
    color: #fff;
    background: color-mix(in srgb, var(--wb-accent) 85%, #000);
  }
</style>
