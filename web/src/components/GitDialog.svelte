<script lang="ts">
  import { cubicOut } from "svelte/easing";
  import { fade, scale } from "svelte/transition";
  import { api } from "../lib/api";
  import type { NotebookCtl } from "../lib/notebook.svelte";

  // Two faces: the offer to start tracking a notebook, and its git settings after.
  let { ctl, onclose }: { ctl: NotebookCtl; onclose: () => void } = $props();

  const tracked = $derived(!!ctl.git?.tracked);
  const remembered = (() => {
    try {
      return JSON.parse(localStorage.getItem("querier:git-identity") ?? "{}");
    } catch {
      return {};
    }
  })();
  // svelte-ignore state_referenced_locally
  let name = $state<string>(ctl.git?.identity.name ?? remembered.name ?? "");
  // svelte-ignore state_referenced_locally
  let email = $state<string>(ctl.git?.identity.email ?? remembered.email ?? "");
  // svelte-ignore state_referenced_locally
  let remote = $state<string>(ctl.git?.remote ?? "");
  let error = $state("");
  let busy = $state(false);

  const https = $derived(/^https?:\/\//.test(remote.trim()));

  async function track(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = "";
    try {
      await api.git.init(ctl.name, { name: name.trim(), email: email.trim(), remote: remote.trim() || undefined });
      try {
        localStorage.setItem("querier:git-identity", JSON.stringify({ name: name.trim(), email: email.trim() }));
      } catch {}
      await ctl.refreshGit();
      ctl.say("Tracking this notebook with git: everything is in the first commit.");
      onclose();
    } catch (err: any) {
      error = err.message;
    }
    busy = false;
  }

  async function saveRemote(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = "";
    if (await ctl.gitDo("Saving", () => api.git.setRemote(ctl.name, remote.trim()))) onclose();
    busy = false;
  }

  async function never() {
    await api.git.decline(ctl.name).catch(() => {});
    await ctl.refreshGit();
    onclose();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") (e.stopPropagation(), onclose());
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" transition:fade={{ duration: 140 }} onclick={onclose} {onkeydown}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="dialog"
    role="dialog"
    aria-label={tracked ? "Git settings" : "Track with git"}
    tabindex="-1"
    transition:scale={{ start: 0.97, duration: 160, easing: cubicOut }}
    onclick={(e) => e.stopPropagation()}
  >
    {#if !tracked}
      <h2>Track this notebook with git?</h2>
      <p class="lede">
        The notebook's folder becomes its own repository: you'll see what changed in each cell, commit, look back
        and restore, and sync with a remote. Code and settings are tracked; outputs never are.
      </p>
      <form onsubmit={track}>
        <div class="row">
          <label class="field grow">
            <span>Author name</span>
            <input bind:value={name} placeholder="Ada Lovelace" autocomplete="name" required />
          </label>
          <label class="field grow">
            <span>Email</span>
            <input bind:value={email} type="email" placeholder="ada@example.com" autocomplete="email" required />
          </label>
        </div>
        <label class="field">
          <span>Remote <em>optional</em></span>
          <input class="mono" bind:value={remote} placeholder="git@github.com:you/sales.git" spellcheck="false" />
        </label>
        {#if https}<p class="hint">An HTTPS remote signs in with a token: a connection giving <code>GIT_TOKEN</code> (yours, or the workspace's).</p>{/if}
        {#if error}<p class="error">{error}</p>{/if}
        <div class="buttons">
          <button type="button" class="quiet" onclick={never}>Don't ask for this notebook</button>
          <span class="spacer"></span>
          <button type="button" onclick={onclose}>Not now</button>
          <button type="submit" class="primary" disabled={busy || !name.trim() || !email.trim()}>Track with git</button>
        </div>
      </form>
    {:else}
      <h2>Git settings</h2>
      <p class="lede">
        This notebook is its own repository{ctl.git?.identity.name ? `, committing as ${ctl.git.identity.name}` : ""}.
      </p>
      <form onsubmit={saveRemote}>
        <label class="field">
          <span>Remote (origin)</span>
          <input class="mono" bind:value={remote} placeholder="git@github.com:you/sales.git" spellcheck="false" />
        </label>
        <p class="hint">
          {#if https}
            HTTPS signs in with <code>GIT_TOKEN</code> (and <code>GIT_USER</code> if your host needs one), from a connection you may use: yours, per person, or the workspace's.
          {:else}
            SSH uses the server's keys. Leave it empty to remove the remote.
          {/if}
        </p>
        {#if error}<p class="error">{error}</p>{/if}
        <div class="buttons">
          <span class="spacer"></span>
          <button type="button" onclick={onclose}>Cancel</button>
          <button type="submit" class="primary" disabled={busy}>Save</button>
        </div>
      </form>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: var(--scrim);
    display: grid;
    place-items: start center;
    padding-top: 12vh;
  }
  .dialog {
    width: min(34rem, calc(100vw - 2rem));
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: 12px;
    box-shadow: var(--shadow-lg);
    padding: 1.5rem 1.75rem 1.25rem;
  }
  h2 {
    margin: 0;
    font-size: 1.0625rem;
    font-weight: 600;
  }
  .lede {
    margin: 0.5rem 0 1.25rem;
    color: var(--ink-2);
    font-size: 0.875rem;
    line-height: 1.55;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .row {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .grow {
    flex: 1;
    min-width: 11rem;
  }
  .field > span {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--ink-2);
  }
  .field em {
    font-style: normal;
    font-weight: 400;
    color: var(--muted);
  }
  .field input {
    height: 2.25rem;
    padding: 0 0.75rem;
    font-size: 0.875rem;
    border-radius: 6px;
  }
  .mono {
    font-family: var(--mono);
  }
  .hint {
    margin: -0.5rem 0 0;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .error {
    margin: 0;
    color: var(--critical);
    font-size: 0.8125rem;
  }
  .buttons {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }
  .spacer {
    flex: 1;
  }
  .buttons button {
    height: 2.125rem;
    padding: 0 0.875rem;
    font-size: 0.8125rem;
    border-radius: 6px;
  }
  .quiet {
    color: var(--muted);
    padding: 0 !important;
  }
  .primary {
    font-weight: 500;
    color: var(--page);
    background: var(--ink);
  }
  .primary:hover {
    color: var(--page);
    background: var(--ink-2);
  }
</style>
