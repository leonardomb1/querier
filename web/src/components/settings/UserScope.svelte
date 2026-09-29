<script lang="ts" module>
  export const USER_TOC = [
    { id: "appearance", label: "Appearance" },
    { id: "connections", label: "Connections" },
    { id: "clients", label: "AI clients" },
  ];
</script>

<script lang="ts">
  import Select from "../ui/Select.svelte";
  import { ask } from "../../lib/dialog.svelte";
  import { api, type AiClient, type ConnectionInfo } from "../../lib/api";
  import ConnectionList from "../connections/ConnectionList.svelte";
  import { writeClipboard } from "../../lib/copy";
  import { CODE_FACES, fonts, UI_FACES } from "../../lib/fonts.svelte";
  import { ago } from "../../lib/format";
  import { DEFAULT_ZOOM, zoom } from "../../lib/zoom.svelte";
  import Icon from "../Icon.svelte";
  import { useSettings } from "./context";
  import Setting from "./Setting.svelte";

  // User settings: how Querier looks in this browser, and the AI clients that may
  // reach this server over MCP (every workspace's; each notebook says what they may do).
  const settings = useSettings();

  const ZOOMS = [0.8, 0.9, 1, 1.125, 1.25, 1.375, 1.5, 1.75, 2];

  let clients = $state<AiClient[]>([]);
  let file = $state("");
  let name = $state("");
  let made = $state<{ name: string; token: string } | null>(null);
  let copied = $state("");
  async function load() {
    try {
      ({ clients, file } = await api.ai.clients());
    } catch (e: any) {
      settings.report("error", e.message);
    }
  }
  load();

  // -- connections: the per-person ones you may use (your own credentials), and everyone's you manage
  let conns = $state<ConnectionInfo[]>([]);
  let mayCreateEveryone = $state(false);
  async function loadConnections() {
    try {
      ({ connections: conns, mayCreateEveryone } = await api.connections.list());
    } catch (e: any) {
      settings.report("error", e.message);
    }
  }
  loadConnections();
  const mine = $derived(conns.filter((c) => c.credentials === "per-user" && c.permissions.includes("connection.use")));
  const everyones = $derived(conns.filter((c) => !c.workspace && c.permissions.includes("connection.manage")));

  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const r = await api.ai.createClient(name.trim());
      made = { name: r.client.name, token: r.token };
      name = "";
      await load();
    } catch (err: any) {
      settings.report("error", err.message);
    }
  }
  async function revoke(c: AiClient) {
    if (!(await ask(`Revoke “${c.name}”?`, { detail: "The AI client using its token stops working at once.", ok: "Revoke", danger: true }))) return;
    try {
      await api.ai.revoke(c.id);
      if (made?.name === c.name) made = null;
      await load();
      settings.report("saved", `${c.name}: revoked`);
    } catch (err: any) {
      settings.report("error", err.message);
    }
  }
  const url = `${location.origin}/mcp`;
  const claudeCode = $derived(made ? `claude mcp add --transport http querier ${url} --header "Authorization: Bearer ${made.token}"` : "");
  const json = $derived(made ? JSON.stringify({ mcpServers: { querier: { type: "http", url, headers: { Authorization: `Bearer ${made.token}` } } } }, null, 2) : "");
  async function copy(what: string, text: string) {
    await writeClipboard(text);
    copied = what;
    setTimeout(() => copied === what && (copied = ""), 1500);
  }
</script>

<section class="group" id="set-appearance">
  <h2>Appearance</h2>
  <Setting id="window.zoom" category="Appearance" label="Zoom" description="The size of the whole interface, in this browser. Ctrl+= and Ctrl+- step it." modified={zoom.value !== DEFAULT_ZOOM} onreset={zoom.reset}>
    <Select value={zoom.value} options={ZOOMS.map((z) => ({ value: z, label: `${Math.round(z * 100)}%`, hint: z === DEFAULT_ZOOM ? "default" : undefined }))} onchange={(z) => zoom.set(z)} label="Zoom" />
  </Setting>
  <Setting id="font.interface" category="Appearance" label="Interface font" description="The typeface of menus, labels and prose." modified={fonts.ui !== UI_FACES[0].id} onreset={() => fonts.set("ui", UI_FACES[0].id)}>
    <Select value={fonts.ui} options={UI_FACES.map((f) => ({ value: f.id, label: f.label }))} onchange={(v) => fonts.set("ui", v)} label="Interface font" />
  </Setting>
  <Setting id="font.code" category="Appearance" label="Code font" description="The typeface of cells, results and code." modified={fonts.code !== CODE_FACES[0].id} onreset={() => fonts.set("code", CODE_FACES[0].id)}>
    <Select value={fonts.code} options={CODE_FACES.map((f) => ({ value: f.id, label: f.label }))} onchange={(v) => fonts.set("code", v)} label="Code font" />
  </Setting>
</section>

<section class="group" id="set-connections">
  <h2>Connections</h2>
  <Setting
    id="connections.mine"
    category="Connections"
    label="Your credentials"
    description="Connections that take each person's own credentials, and that you may use: what you enter is yours alone, and your kernels run with it."
    modified={mine.some((c) => c.mine.length > 0)}
  >
    <ConnectionList items={mine} onchanged={loadConnections} empty="None you may use takes your own credentials." />
  </Setting>
  {#if mayCreateEveryone || everyones.length}
    <Setting
      id="connections.everyone"
      category="Connections"
      label="Everyone's connections"
      description="Connections for every workspace's notebooks, not one workspace's. No one uses them until given them: Manage access, per connection."
      modified={everyones.length > 0}
    >
      <ConnectionList items={everyones} onchanged={loadConnections} empty="None yet." create={mayCreateEveryone ? { workspace: null } : null} />
    </Setting>
  {/if}
</section>

<section class="group" id="set-clients">
  <h2>AI clients</h2>
  <Setting
    id="ai.clients"
    info={file ? `Tokens are stored hashed, in ${file}.` : "Tokens are stored hashed on the server, and shown only once."}
    category="AI clients"
    label="Clients (MCP)"
    description="AI tools such as Claude Code reach Querier over MCP at /mcp, each with its own token, acting as you. What they may do is set per workspace and notebook (AI access)."
  >
    <ul class="list">
      {#each clients as c (c.id)}
        <li>
          <Icon name="plug" size={14} />
          <span class="grow"><code>{c.name}</code></span>
          <span>{c.lastUsed ? `used ${ago(c.lastUsed)}` : "never used"}</span>
          <button class="icon" title="Revoke {c.name}" aria-label="Revoke {c.name}" onclick={() => revoke(c)}><Icon name="trash" size={14} /></button>
        </li>
      {/each}
    </ul>
    <form class="row" onsubmit={create}>
      <input bind:value={name} placeholder="Name, e.g. Claude Code on my laptop" spellcheck="false" aria-label="Client name" />
      <button class="btn" type="submit" disabled={!name.trim()}><Icon name="add" size={14} />Add client</button>
    </form>
    {#if made}
      <div class="made">
        <p><strong>{made.name}</strong>'s token is shown only now. For Claude Code, run:</p>
        <div class="snippet">
          <code>{claudeCode}</code>
          <button class="icon" aria-label="Copy the command" title="Copy" onclick={() => copy("cc", claudeCode)}><Icon name={copied === "cc" ? "check" : "copy"} size={14} /></button>
        </div>
        <p>Other clients (Claude Desktop, Cursor, …) take it as JSON:</p>
        <div class="snippet">
          <pre>{json}</pre>
          <button class="icon" aria-label="Copy the JSON" title="Copy" onclick={() => copy("json", json)}><Icon name={copied === "json" ? "check" : "copy"} size={14} /></button>
        </div>
      </div>
    {/if}
  </Setting>
</section>

<style>
  .made {
    width: min(100%, 40rem);
    margin-top: 0.75rem;
  }
  .made p {
    margin: 0.5rem 0 0.25rem;
    color: var(--wb-fg-muted);
  }
  .snippet {
    position: relative;
    padding: 0.5rem 2rem 0.5rem 0.625rem;
    background: var(--wb-input);
    border: 1px solid var(--wb-input-border);
    border-radius: 2px;
  }
  .snippet code,
  .snippet pre {
    display: block;
    margin: 0;
    font-size: 0.75rem;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .snippet .icon {
    position: absolute;
    top: 0.25rem;
    right: 0.25rem;
    width: 1.375rem;
    height: 1.375rem;
  }
</style>
