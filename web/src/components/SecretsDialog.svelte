<script lang="ts">
  import { cubicOut } from "svelte/easing";
  import { fade, scale, slide } from "svelte/transition";
  import { api, type SecretInfo } from "../lib/api";
  import type { NotebookCtl } from "../lib/notebook.svelte";
  import Icon from "./Icon.svelte";

  let { ctl }: { ctl: NotebookCtl } = $props();

  let file = $state("");
  let list = $state<SecretInfo[]>([]);
  let error = $state("");

  // the add / replace form
  let name = $state("");
  let value = $state("");
  let scope = $state<SecretInfo["scope"]>("notebook");
  let reveal = $state(false);
  let help = $state(false);
  let saving = $state(false);
  let valueInput = $state<HTMLInputElement>();

  async function load() {
    try {
      ({ file, secrets: list } = await api.secrets(ctl.name));
    } catch (e: any) {
      error = e.message;
    }
  }
  load();

  const set = $derived(new Set(list.filter((s) => !s.shadowed).map((s) => s.name)));
  const missing = $derived([...ctl.secretRefs].filter(([n]) => !set.has(n)));

  function prefill(n: string, s: SecretInfo["scope"] = "notebook") {
    name = n;
    scope = s;
    value = "";
    queueMicrotask(() => valueInput?.focus());
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!name || !value || saving) return;
    saving = true;
    error = "";
    try {
      await api.setSecret(ctl.name, name, value, scope);
      name = value = "";
      await load();
    } catch (err: any) {
      error = err.message;
    }
    saving = false;
  }

  async function remove(s: SecretInfo) {
    try {
      await api.removeSecret(ctl.name, s.name, s.scope);
      await load();
    } catch (err: any) {
      error = err.message;
    }
  }

  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" }); // the UI's language
  function ago(ms: number) {
    const m = Math.round((ms - Date.now()) / 60000);
    if (Math.abs(m) < 60) return m === 0 ? "just now" : rtf.format(m, "minute");
    const h = Math.round(m / 60);
    return Math.abs(h) < 48 ? rtf.format(h, "hour") : rtf.format(Math.round(h / 24), "day");
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") (e.stopPropagation(), (ctl.secrets = false));
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" transition:fade={{ duration: 140 }} onclick={() => (ctl.secrets = false)} {onkeydown}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="dialog"
    role="dialog"
    aria-label="Secrets"
    tabindex="-1"
    transition:scale={{ start: 0.97, duration: 160, easing: cubicOut }}
    onclick={(e) => e.stopPropagation()}
  >
    <header>
      <div class="title">
        <h2>Secrets</h2>
        <button
          class="icon info"
          class:on={help}
          title="How cells read secrets"
          aria-label="How cells read secrets"
          aria-expanded={help}
          onclick={() => (help = !help)}
        >
          <Icon name="info" size={17} />
        </button>
      </div>
      <p>Passwords and tokens for this notebook, given to its cells as environment variables.</p>
    </header>

    {#if help}
      <div class="help" transition:slide={{ duration: 160, easing: cubicOut }}>
        <dl>
          <dt>basalt connection</dt>
          <dd><code>CREATE CONNECTION sr …</code> reads <code>SR_USER</code> and <code>SR_PASS</code> by itself: leave <code>user</code> and <code>password</code> out.</dd>
          <dt>Other options</dt>
          <dd><code>token = env('GH_TOKEN')</code> inside a connection's <code>OPTIONS</code>.</dd>
          <dt>Python</dt>
          <dd><code>os.environ["GH_TOKEN"]</code></dd>
        </dl>
        {#if file}<p class="file">Stored on the server in <code>{file}</code>, never in a notebook, and masked in cell output.</p>{/if}
      </div>
    {/if}

    {#if ctl.conn.secretsStale}
      <div class="notice">
        <span>The running kernel still has the previous values.</span>
        <button onclick={() => ctl.restart()}>Restart kernel</button>
      </div>
    {/if}

    {#if missing.length}
      <section>
        <h3>Asked for by this notebook, not set</h3>
        <ul>
          {#each missing as [n, why] (n)}
            <li>
              <span class="who">
                <code class="name">{n}</code>
                <span class="meta">{why}</span>
              </span>
              <button class="act" onclick={() => prefill(n)}>Set</button>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <section>
      <h3>Set</h3>
      {#if list.length}
        <ul>
          {#each list as s (s.scope + s.name)}
            <li class:shadowed={s.shadowed}>
              <span class="who">
                <code class="name">{s.name}</code>
                <span class="meta">
                  {s.scope === "notebook" ? "This notebook" : "All notebooks"}{s.shadowed ? ", overridden here" : ""} · {ago(s.updated)}
                </span>
              </span>
              <button class="act" onclick={() => prefill(s.name, s.scope)}>Replace</button>
              <button class="act danger" onclick={() => remove(s)}>Delete</button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="empty">Nothing set yet.</p>
      {/if}
    </section>

    <form onsubmit={save}>
      <div class="row">
        <label class="field grow">
          <span>Name</span>
          <input
            class="mono"
            placeholder="SR_PASS"
            bind:value={name}
            oninput={() => (name = name.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
            spellcheck="false"
            autocomplete="off"
          />
        </label>
        <div class="field">
          <span>Available to</span>
          <div class="seg" role="radiogroup" aria-label="Available to">
            <button type="button" role="radio" aria-checked={scope === "notebook"} class:on={scope === "notebook"} onclick={() => (scope = "notebook")}>
              This notebook
            </button>
            <button type="button" role="radio" aria-checked={scope === "global"} class:on={scope === "global"} onclick={() => (scope = "global")}>
              All notebooks
            </button>
          </div>
        </div>
      </div>
      <label class="field">
        <span>Value</span>
        <span class="value">
          <input
            class="mono"
            bind:this={valueInput}
            type={reveal ? "text" : "password"}
            placeholder="Never shown again after saving"
            bind:value
            autocomplete="new-password"
            spellcheck="false"
          />
          <button type="button" class="reveal" onclick={() => (reveal = !reveal)}>{reveal ? "Hide" : "Show"}</button>
        </span>
      </label>
      {#if error}<p class="error">{error}</p>{/if}
      <div class="buttons">
        {#if name || value}<button type="button" onclick={() => (name = value = "")}>Clear</button>{/if}
        <button type="submit" class="primary" disabled={!name || !value || saving}>Save secret</button>
      </div>
    </form>

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
    padding-top: 8vh;
  }
  .dialog {
    width: min(40rem, calc(100vw - 2rem));
    max-height: 84vh;
    overflow: auto;
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: 12px;
    box-shadow: var(--shadow-lg);
    padding: 1.5rem 1.75rem 1.25rem;
  }
  header h2 {
    margin: 0;
    font-size: 1.0625rem;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  header p {
    margin: 0.375rem 0 0;
    color: var(--ink-2);
    font-size: 0.875rem;
    line-height: 1.55;
  }
  .notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-top: 1.25rem;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--hair);
    border-radius: 8px;
    font-size: 0.8125rem;
    color: var(--stale);
  }
  .notice button {
    font-size: 0.8125rem;
    color: var(--ink);
  }
  section {
    margin-top: 1.5rem;
  }
  h3 {
    margin: 0 0 0.5rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--muted);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--hair);
  }
  li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 3.25rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--hair);
  }
  .who {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }
  .name {
    font-size: 0.8125rem;
    font-weight: 600;
  }
  li.shadowed .name {
    text-decoration: line-through;
    color: var(--muted);
  }
  .meta {
    font-size: 0.75rem;
    color: var(--muted);
  }
  .act {
    font-size: 0.8125rem;
    padding: 0.25rem 0.625rem;
  }
  .danger {
    color: var(--critical);
  }
  .empty {
    margin: 0;
    padding: 0.75rem 0;
    color: var(--muted);
    font-size: 0.875rem;
    border-top: 1px solid var(--hair);
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-top: 1.75rem;
    padding: 1.125rem 1.25rem;
    border: 1px solid var(--hair);
    border-radius: 10px;
    background: var(--surface-2);
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
  .field.grow {
    flex: 1;
    min-width: 12rem;
  }
  .field > span:first-child {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--ink-2);
  }
  .field input {
    height: 2.25rem;
    padding: 0 0.75rem;
    font-size: 0.875rem;
    border-radius: 6px;
    background: var(--surface);
  }
  .mono {
    font-family: var(--mono);
  }
  .seg {
    display: inline-flex;
    height: 2.25rem;
    padding: 2px;
    border: 1px solid var(--hair);
    border-radius: 6px;
    background: var(--surface);
  }
  .seg button {
    padding: 0 0.875rem;
    font-size: 0.8125rem;
    border-radius: 4px;
    color: var(--ink-2);
  }
  .seg button.on {
    background: var(--pressed);
    color: var(--ink);
    box-shadow: 0 0 0 1px var(--hair);
  }
  .value {
    display: flex;
    align-items: center;
    height: 2.25rem;
    border: 1px solid var(--hair);
    border-radius: 6px;
    background: var(--surface);
  }
  .value:focus-within {
    border-color: var(--ring);
  }
  .value input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    background: none;
  }
  .value input:focus {
    outline: none;
  }
  .reveal {
    flex: none;
    margin-right: 0.25rem;
    padding: 0.25rem 0.625rem;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .buttons button {
    height: 2.125rem;
    padding: 0 0.875rem;
    font-size: 0.8125rem;
    border-radius: 6px;
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
  .error {
    margin: 0;
    color: var(--critical);
    font-size: 0.8125rem;
  }

  .title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .info {
    width: 1.875rem;
    height: 1.875rem;
    margin-right: -0.375rem;
  }
  .info.on {
    color: var(--ink);
    background: var(--pressed);
  }
  .help {
    margin-top: 1rem;
    padding: 0.875rem 1rem;
    border: 1px solid var(--hair);
    border-radius: 8px;
    font-size: 0.8125rem;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.625rem 1.25rem;
    margin: 0;
  }
  dt {
    color: var(--ink-2);
    font-weight: 500;
  }
  dd {
    margin: 0;
    color: var(--ink-2);
    line-height: 1.55;
  }
  code {
    font-size: 0.78rem;
  }
  .file {
    margin: 0.875rem 0 0;
    color: var(--muted);
    font-size: 0.75rem;
    line-height: 1.55;
    word-break: break-all;
  }
</style>
