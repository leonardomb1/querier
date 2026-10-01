<script lang="ts">
  import { api, type PublicLinkInfo, type PublishedInfo } from "../lib/api";
  import { writeClipboard } from "../lib/copy";
  import { ask } from "../lib/dialog.svelte";
  import type { NotebookCtl } from "../lib/notebook.svelte";
  import Icon from "./Icon.svelte";
  import InfoTip from "./ui/InfoTip.svelte";
  import Select from "./ui/Select.svelte";

  // A published report's public link (the Publish dialog): anyone with it opens the
  // report without signing in. What they get is its last run as its owner, refreshed
  // when older than chosen; its PARAMs keep their defaults, and no code is sent. It can
  // be narrowed to networks, end on a date, ask a passcode, and be shown in other sites'
  // frames or not. The server allows links at all, and within which networks.
  let { ctl, pub }: { ctl: NotebookCtl; pub: PublishedInfo } = $props();

  // svelte-ignore state_referenced_locally
  const link0 = pub.public ?? null;
  let link = $state<PublicLinkInfo | null>(link0);
  let refresh = $state(link0?.refresh ?? 15);
  let networks = $state((link0?.networks ?? []).join(", "));
  let expires = $state(link0?.expires ? new Date(link0.expires).toISOString().slice(0, 10) : "");
  let passcode = $state("");
  let dropPasscode = $state(false);
  let embedMode = $state<"none" | "any" | "sites">(link0 ? (Array.isArray(link0.embed) ? "sites" : link0.embed) : "none");
  let sites = $state(Array.isArray(link0?.embed) ? link0.embed.join(", ") : "");
  let busy = $state(false);
  let error = $state("");
  let copied = $state(false);

  const allowed = $derived(pub.publicAllowed);
  const canBePublic = $derived(pub.runAs === "owner" && !Object.keys(pub.bindings ?? {}).length);
  const address = $derived(link ? `${location.origin}${link.path}` : "");
  const list = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

  const REFRESH = [
    { value: 5, label: "Every 5 minutes" },
    { value: 15, label: "Every 15 minutes" },
    { value: 60, label: "Every hour" },
    { value: 360, label: "Every 6 hours" },
    { value: 1440, label: "Every day" },
  ];
  const EMBED = [
    { value: "none" as const, label: "Only here", description: "No other site may show it in a frame." },
    { value: "sites" as const, label: "On these sites", description: "Only the sites listed may show it in a frame (an intranet page, a wiki)." },
    { value: "any" as const, label: "Anywhere", description: "Any site may show it in a frame." },
  ];

  async function save() {
    busy = true;
    error = "";
    const was = !!link;
    try {
      link = await api.report.setPublic(ctl.name, {
        refresh,
        networks: list(networks),
        // the end of the chosen day, where the viewer is
        expires: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
        passcode: dropPasscode ? null : passcode || undefined,
        embed: embedMode === "sites" ? list(sites) : embedMode,
      });
      passcode = "";
      dropPasscode = false;
      ctl.say(was ? "The public link's settings are saved." : "The report is public: anyone with its link opens it.");
    } catch (e: any) {
      error = e.message;
    }
    busy = false;
  }
  async function remove() {
    if (!(await ask("Remove the public link?", { detail: "It stops working at once, for everyone who has it. The report stays published for its signed-in viewers.", ok: "Remove", danger: true }))) return;
    await api.report.removePublic(ctl.name).then(() => (link = null), (e) => (error = e.message));
  }
  async function rotate() {
    if (!(await ask("Give the link a new address?", { detail: "The current address stops working at once; only who gets the new one can open it. Its settings stay.", ok: "New address", danger: true }))) return;
    await api.report.rotatePublic(ctl.name).then((l) => (link = l), (e) => (error = e.message));
  }
  async function copy() {
    await writeClipboard(address).catch(() => {});
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }
</script>

<section class="public">
  <h3>
    <Icon name="globe" size={14} />Public link
    <InfoTip text="Anyone with the link opens the report without signing in. They get its last run as you, refreshed when older than chosen below; its PARAMs keep their defaults and no code is sent. Filter in the report itself (a template can filter its rows) rather than with controls." />
  </h3>
  {#if !allowed?.enabled}
    <p class="hint">Public links are off on this server: an administrator turns them on (Administration → Sign-in).</p>
  {:else if !canBePublic}
    <p class="hint">Only a report published to run as you, with no PARAM bound to its viewers, can be public: it has one result everyone sees.</p>
  {:else}
    {#if link}
      <div class="address">
        <code title={address}>{address}</code>
        <button class="btn" onclick={copy}><Icon name={copied ? "check" : "copy"} size={14} />{copied ? "Copied" : "Copy"}</button>
        <a class="btn" href={link.path} target="_blank" rel="noopener noreferrer"><Icon name="link-external" size={14} />Open</a>
      </div>
    {:else}
      <p class="hint">Not public: only signed-in viewers open it.</p>
    {/if}

    <div class="grid">
      <label>
        <span class="l">Refreshed</span>
        <Select bind:value={refresh} options={REFRESH} label="Refreshed" />
      </label>
      <label>
        <span class="l">Until <span class="opt">(optional)</span></span>
        <input type="date" bind:value={expires} min={new Date().toISOString().slice(0, 10)} />
      </label>
      <label class="wide">
        <span class="l">From these networks only <span class="opt">(optional)</span></span>
        <input class="mono" bind:value={networks} placeholder={allowed.networks.length ? `within ${allowed.networks.join(", ")}` : "10.0.0.0/8, 192.168.1.0/24"} spellcheck="false" />
        {#if allowed.networks.length}<span class="hint">The server allows public links from {allowed.networks.join(", ")} only.</span>{/if}
      </label>
      <label class="wide">
        <span class="l">Passcode <span class="opt">(optional)</span></span>
        <span class="row">
          <input type="password" bind:value={passcode} disabled={dropPasscode} placeholder={link?.passcode ? "set: type to change it" : "none: at least 6 characters"} autocomplete="new-password" />
          {#if link?.passcode}<label class="check"><input type="checkbox" bind:checked={dropPasscode} />Remove it</label>{/if}
        </span>
      </label>
      <label class="wide">
        <span class="l">Shown in other sites' frames</span>
        <Select bind:value={embedMode} options={EMBED} label="Shown in other sites' frames" />
        {#if embedMode === "sites"}
          <input class="mono" bind:value={sites} placeholder="https://intranet.example.com, https://wiki.example.com" spellcheck="false" aria-label="Sites that may show it" />
        {/if}
      </label>
    </div>

    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="acts">
      {#if link}
        <button class="btn danger-text" onclick={remove}>Remove link</button>
        <button class="btn" onclick={rotate} title="The current address stops working">New address</button>
      {/if}
      <span class="grow"></span>
      <button class="btn" class:primary={!link} disabled={busy || (embedMode === "sites" && !list(sites).length)} onclick={save}>{link ? "Save link settings" : "Make public"}</button>
    </div>
  {/if}
</section>

<style>
  .public {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding-top: 0.875rem;
    border-top: 1px solid var(--wb-border);
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .hint {
    margin: 0;
    font-size: 0.75rem;
    color: var(--wb-fg-muted);
  }
  .address {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }
  .address code {
    flex: 1;
    min-width: 0;
    padding: 0.3125rem 0.5rem;
    font-size: 0.75rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: var(--wb-input);
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.625rem 0.75rem;
  }
  .grid label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }
  .grid .wide {
    grid-column: 1 / -1;
  }
  .l {
    font-size: 0.75rem;
    color: var(--wb-fg-muted);
  }
  .opt {
    color: var(--wb-fg-dim);
  }
  input:not([type="checkbox"]) {
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
  input:focus {
    outline: none;
    border-color: var(--wb-accent);
  }
  .mono {
    font-family: var(--mono);
    font-size: 0.78rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }
  .row input:not([type="checkbox"]) {
    flex: 1;
    width: auto;
    min-width: 0;
  }
  .check {
    display: inline-flex !important;
    flex-direction: row !important;
    align-items: center;
    gap: 0.3125rem !important;
    white-space: nowrap;
    font-size: 0.75rem;
  }
  .acts {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .grow {
    flex: 1;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    height: 1.75rem;
    padding: 0 0.75rem;
    font-size: 0.8125rem;
    color: var(--wb-fg);
    text-decoration: none;
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
  }
  .btn:hover {
    background: var(--wb-list-hover);
  }
  .danger-text {
    color: var(--critical);
  }
  .error {
    margin: 0;
    font-size: 0.78rem;
    color: var(--critical);
  }
</style>
