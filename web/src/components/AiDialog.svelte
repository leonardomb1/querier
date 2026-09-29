<script lang="ts">
  import { cubicOut } from "svelte/easing";
  import { fade, scale, slide } from "svelte/transition";
  import { api, type AiClient, type AiLevel } from "../lib/api";
  import { writeClipboard } from "../lib/copy";
  import { ago } from "../lib/format";
  import type { NotebookCtl } from "../lib/notebook.svelte";
  import Icon from "./Icon.svelte";

  // AI tools (Claude Code, Claude Desktop, ...) reach Querier over MCP: what they
  // may do in this notebook, and the clients holding a token.
  let { ctl, onclose }: { ctl: NotebookCtl; onclose: () => void } = $props();

  const LEVELS: { level: AiLevel; label: string; what: string }[] = [
    { level: "off", label: "Off", what: "Hidden from AI clients." },
    { level: "read", label: "Read", what: "Code, how cells depend on each other, schemas and errors. No rows leave." },
    { level: "run", label: "Run", what: "Also runs cells and scratch queries, and sees their results." },
    { level: "edit", label: "Edit", what: "Also writes, renames, moves and deletes cells, and lays out the report." },
  ];

  let level = $state<AiLevel | null>(null);
  let clients = $state<AiClient[]>([]);
  let error = $state("");
  let name = $state("");
  let made = $state<{ name: string; token: string } | null>(null);
  let copied = $state("");

  async function load() {
    try {
      [{ level }, { clients }] = await Promise.all([api.ai.level(ctl.name), api.ai.clients()]);
    } catch (e: any) {
      error = e.message;
    }
  }
  load();

  async function setLevel(l: AiLevel) {
    error = "";
    const was = level;
    level = l;
    try {
      await api.ai.setLevel(ctl.name, l);
    } catch (e: any) {
      level = was;
      error = e.message;
    }
  }

  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    error = "";
    try {
      const r = await api.ai.createClient(name);
      made = { name: r.client.name, token: r.token };
      name = "";
      await load();
    } catch (e: any) {
      error = e.message;
    }
  }

  async function revoke(c: AiClient) {
    if (!confirm(`Revoke “${c.name}”? It stops working at once.`)) return;
    await api.ai.revoke(c.id).catch((e) => (error = e.message));
    await load();
  }

  const url = `${location.origin}/mcp`;
  const claudeCode = $derived(made ? `claude mcp add --transport http querier ${url} --header "Authorization: Bearer ${made.token}"` : "");
  const json = $derived(
    made ? JSON.stringify({ mcpServers: { querier: { type: "http", url, headers: { Authorization: `Bearer ${made.token}` } } } }, null, 2) : "",
  );

  async function copy(what: string, text: string) {
    await writeClipboard(text);
    copied = what;
    setTimeout(() => copied === what && (copied = ""), 1500);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") (e.stopPropagation(), onclose());
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" transition:fade={{ duration: 140 }} onclick={onclose} {onkeydown}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="dialog" role="dialog" aria-label="AI access" tabindex="-1" transition:scale={{ start: 0.97, duration: 160, easing: cubicOut }} onclick={(e) => e.stopPropagation()}>
    <header>
      <h2>AI access</h2>
      <button class="icon" aria-label="Close" onclick={onclose}><Icon name="x" /></button>
    </header>
    <p class="lede">
      AI tools such as Claude Code connect to Querier over MCP. They work through the same paths as this page, so you see
      what they run and change. Secrets never reach them.
    </p>

    <section>
      <h3>In this notebook</h3>
      <div class="levels" role="radiogroup" aria-label="Access">
        {#each LEVELS as l (l.level)}
          <button role="radio" aria-checked={level === l.level} class:on={level === l.level} onclick={() => setLevel(l.level)}>
            <span class="dot"></span>
            <span class="label">{l.label}</span>
            <span class="what">{l.what}</span>
          </button>
        {/each}
      </div>
    </section>

    <section>
      <h3>Clients</h3>
      <p class="hint">A client is one AI tool with its own token, for every notebook it's allowed into. Revoke one to cut it off.</p>
      {#if clients.length}
        <ul>
          {#each clients as c (c.id)}
            <li>
              <span class="name">{c.name}</span>
              <span class="when">{c.lastUsed ? `used ${ago(c.lastUsed)}` : "never used"}</span>
              <button class="revoke" onclick={() => revoke(c)}>Revoke</button>
            </li>
          {/each}
        </ul>
      {/if}
      <form class="add" onsubmit={create}>
        <input bind:value={name} placeholder="Name, e.g. Claude Code on my laptop" spellcheck="false" />
        <button type="submit" disabled={!name.trim()}>Add client</button>
      </form>

      {#if made}
        <div class="made" transition:slide={{ duration: 160 }}>
          <p>
            <strong>{made.name}</strong>'s token is shown only now. For Claude Code, run:
          </p>
          <div class="snippet">
            <code>{claudeCode}</code>
            <button class="icon" aria-label="Copy command" title="Copy" onclick={() => copy("cc", claudeCode)}><Icon name={copied === "cc" ? "check" : "copy"} size={14} /></button>
          </div>
          <p>Other clients (Claude Desktop, Cursor, …) take it as JSON:</p>
          <div class="snippet">
            <pre>{json}</pre>
            <button class="icon" aria-label="Copy JSON" title="Copy" onclick={() => copy("json", json)}><Icon name={copied === "json" ? "check" : "copy"} size={14} /></button>
          </div>
        </div>
      {/if}
    </section>

    {#if error}<p class="error">{error}</p>{/if}
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
    padding-top: 10vh;
  }
  .dialog {
    width: min(38rem, calc(100vw - 2rem));
    max-height: 82vh;
    overflow: auto;
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: 12px;
    box-shadow: var(--shadow-lg);
    padding: 1.25rem 1.5rem 1.5rem;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h2 {
    margin: 0;
    font-size: 1.0625rem;
    font-weight: 600;
  }
  .lede,
  .hint,
  .made p {
    font-size: 0.8125rem;
    line-height: 1.55;
    color: var(--ink-2);
    margin: 0.375rem 0 0;
  }
  .hint {
    color: var(--muted);
    margin: 0 0 0.625rem;
  }
  section {
    margin-top: 1.25rem;
  }
  h3 {
    margin: 0 0 0.5rem;
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .levels {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--hair);
    border-radius: 8px;
    overflow: hidden;
  }
  .levels button {
    display: grid;
    grid-template-columns: 1rem 3.5rem 1fr;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    text-align: left;
    border-radius: 0;
    font-size: 0.8125rem;
  }
  .levels button + button {
    border-top: 1px solid var(--hair);
  }
  .levels button.on {
    background: var(--hover);
  }
  .dot {
    width: 0.625rem;
    height: 0.625rem;
    border-radius: 50%;
    border: 1.5px solid var(--muted);
    align-self: center;
  }
  .on .dot {
    border-color: var(--accent);
    background: radial-gradient(var(--accent) 45%, transparent 50%);
  }
  .label {
    font-weight: 600;
  }
  .what {
    color: var(--muted);
    font-size: 0.78rem;
  }
  ul {
    list-style: none;
    margin: 0 0 0.625rem;
    padding: 0;
    border-top: 1px solid var(--hair);
  }
  li {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 2.25rem;
    border-bottom: 1px solid var(--hair);
    font-size: 0.8125rem;
  }
  .name {
    flex: 1;
  }
  .when {
    font-size: 0.75rem;
    color: var(--muted);
  }
  .revoke {
    font-size: 0.75rem;
    color: var(--critical);
    padding: 0.2rem 0.5rem;
  }
  .add {
    display: flex;
    gap: 0.5rem;
  }
  .add input {
    flex: 1;
    height: 2rem;
    font-size: 0.8125rem;
    padding: 0 0.625rem;
  }
  .add button {
    font-size: 0.8125rem;
    padding: 0 0.875rem;
    border: 1px solid var(--hair);
    border-radius: 6px;
  }
  .made {
    margin-top: 1rem;
    padding: 0.75rem 0.875rem;
    border: 1px solid var(--hair);
    border-radius: 8px;
  }
  .made p:first-child {
    margin-top: 0;
  }
  .snippet {
    position: relative;
    margin-top: 0.375rem;
    background: var(--hover);
    border-radius: 6px;
    padding: 0.5rem 2.25rem 0.5rem 0.625rem;
  }
  .snippet code,
  .snippet pre {
    display: block;
    margin: 0;
    font: 0.75rem/1.5 var(--mono);
    white-space: pre-wrap;
    word-break: break-all;
  }
  .snippet button {
    position: absolute;
    top: 0.3rem;
    right: 0.3rem;
  }
  .error {
    color: var(--critical);
    font-size: 0.8125rem;
  }
</style>
