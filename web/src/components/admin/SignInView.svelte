<script lang="ts">
  import { onMount } from "svelte";
  import { api, type AuthSettings, type ProviderSettings } from "../../lib/api";
  import { ask, notifyError } from "../../lib/dialog.svelte";
  import Icon from "../Icon.svelte";
  import Menu from "../Menu.svelte";
  import InfoTip from "../ui/InfoTip.svelte";
  import ProviderDialog from "./ProviderDialog.svelte";
  import CodeEditorPanel from "../ui/CodeEditorPanel.svelte";
  import CodeInput from "../ui/CodeInput.svelte";
  import { adminHref } from "../../lib/href";
  import { session as signedIn } from "../../lib/session.svelte";
  import type { CedarVocabulary } from "../../lib/cedarcomplete";

  // How people sign in: the directories (LDAP, Active Directory) and OpenID
  // Connect providers (Entra, Keycloak…), in the sign-in page's order, and how
  // long a session lasts. Kept in auth.json; a change is in force at once.
  let s = $state<AuthSettings | null>(null);
  let error = $state("");
  let editing = $state<{ provider: ProviderSettings; isNew: boolean } | null>(null);
  let session = $state({ absoluteHours: 12, idleMinutes: 120, refreshMinutes: 15 });
  let sessionError = $state("");
  let sessionSaved = $state(false);

  async function load() {
    try {
      s = await api.admin.auth.get();
      session = { ...s.session };
    } catch (e: any) {
      error = e.message;
    }
  }
  onMount(load);

  const PRESETS: { label: string; make: () => ProviderSettings }[] = [
    {
      label: "Active Directory (LDAPS)",
      make: () => ({
        type: "ldap",
        id: "corp",
        label: "Corporate account",
        url: "ldaps://dc1.corp.example.com:636",
        bindDn: "CN=svc-querier,OU=Service Accounts,DC=corp,DC=example,DC=com",
        baseDn: "DC=corp,DC=example,DC=com",
        groupBaseDn: "DC=corp,DC=example,DC=com",
        attributes: { department: "department", title: "title" },
      }),
    },
    {
      label: "OpenLDAP",
      make: () => ({
        type: "ldap",
        id: "ldap",
        label: "Directory account",
        url: "ldaps://ldap.example.com:636",
        bindDn: "cn=querier,ou=services,dc=example,dc=com",
        baseDn: "ou=people,dc=example,dc=com",
        userFilter: "(&(objectClass=inetOrgPerson)(uid={username}))",
        idAttribute: "entryUUID",
        usernameAttribute: "uid",
        nameAttribute: "cn",
        attributes: {},
      }),
    },
    {
      label: "Microsoft Entra ID",
      make: () => ({
        type: "oidc",
        id: "entra",
        label: "Microsoft",
        issuer: "https://login.microsoftonline.com/<tenant-id>/v2.0",
        clientId: "",
        scopes: ["openid", "profile", "email", "offline_access", "User.Read"],
        groupsClaim: "groups",
        entraGraphOverage: true,
        attributes: {},
      }),
    },
    {
      label: "Keycloak",
      make: () => ({ type: "oidc", id: "keycloak", label: "Keycloak", issuer: "https://sso.example.com/realms/<realm>", clientId: "querier", scopes: ["openid", "profile", "email", "offline_access"], groupsClaim: "groups", attributes: {} }),
    },
    {
      label: "Another OpenID Connect provider",
      make: () => ({ type: "oidc", id: "sso", label: "Single sign-on", issuer: "https://", clientId: "", scopes: ["openid", "profile", "email", "offline_access"], attributes: {} }),
    },
  ];
  function add(make: () => ProviderSettings) {
    const p = make();
    // an id not taken yet
    const taken = new Set(s?.providers.map((x) => x.id));
    let id = p.id;
    for (let i = 2; taken.has(id); i++) id = `${p.id}-${i}`;
    editing = { provider: { ...p, id }, isNew: true };
  }

  async function remove(p: ProviderSettings) {
    const ok = await ask(`Remove ${p.label}?`, {
      detail: "Nobody can sign in with it any more, and sessions made with it end at their next refresh. Their grants and shares stay, for when it comes back with the same id.",
      ok: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.admin.auth.remove(p.id);
      await load();
    } catch (e) {
      await notifyError(`Couldn't remove ${p.label}`, e);
    }
  }
  async function move(i: number, by: number) {
    if (!s) return;
    const ids = s.providers.map((p) => p.id);
    [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
    try {
      await api.admin.auth.order(ids);
      await load();
    } catch (e) {
      await notifyError("Couldn't change the order", e);
    }
  }
  async function saveSession(e: SubmitEvent) {
    e.preventDefault();
    sessionError = "";
    try {
      session = await api.admin.auth.session(session);
      if (s) s.session = { ...session };
      sessionSaved = true;
      setTimeout(() => (sessionSaved = false), 2000);
    } catch (err: any) {
      sessionError = err.message;
    }
  }
  // -- public links to reports: off unless allowed here, and never from outside these networks
  let publicEnabled = $state(false);
  let publicNetworks = $state("");
  let publicError = $state("");
  let publicSaved = $state(false);
  $effect(() => {
    if (!s) return;
    publicEnabled = s.publicLinks?.enabled ?? false;
    publicNetworks = (s.publicLinks?.networks ?? []).join(", ");
  });
  async function savePublic(e: SubmitEvent) {
    e.preventDefault();
    publicError = "";
    try {
      const saved = await api.admin.auth.publicLinks({ enabled: publicEnabled, networks: publicNetworks.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean) });
      if (s) s.publicLinks = saved;
      publicSaved = true;
      setTimeout(() => (publicSaved = false), 2000);
    } catch (err: any) {
      publicError = err.message;
    }
  }
  // -- sites a report's side panel may show: framed unsandboxed, so only those listed here
  let embedSites = $state("");
  let embedError = $state("");
  let embedSaved = $state(false);
  $effect(() => {
    if (s) embedSites = (s.embedSites ?? []).join("\n");
  });
  async function saveEmbeds(e: SubmitEvent) {
    e.preventDefault();
    embedError = "";
    try {
      const saved = await api.admin.auth.embeds(embedSites.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean));
      if (s) s.embedSites = saved;
      signedIn.embedSites = saved;
      embedSaved = true;
      setTimeout(() => (embedSaved = false), 2000);
    } catch (err: any) {
      embedError = err.message;
    }
  }
  // -- who may sign in: a condition, written as the managed policy sign-in.cedar
  let admitting = $state(false);
  let vocabulary = $state<CedarVocabulary | null>(null);
  $effect(() => {
    if (admitting && !vocabulary) api.access.vocabulary().then((v) => (vocabulary = v), () => {});
  });
  async function setAdmission(when: string | null) {
    const a = await api.admin.auth.admission(when);
    if (s) s.admission = a;
    admitting = false;
  }
  async function letEveryoneIn() {
    const ok = await ask("Let everyone the directories accept sign in?", {
      detail: "Anyone with an account in a directory or provider here can sign in again. They still see nothing until a role, share or policy gives them access.",
      ok: "Let everyone in",
    });
    if (ok) await setAdmission(null).catch((e) => notifyError("Couldn't change it", e));
  }

  const sessionDirty = $derived(!!s && JSON.stringify(session) !== JSON.stringify(s.session));
  const where = (p: ProviderSettings) => (p.type === "ldap" ? p.url : p.issuer) ?? "";
</script>

<div class="adm">
  <header class="adm-head">
    <div class="grow">
      <h2>Sign-in</h2>
      <p>
        The directories and identity providers people sign in with, in the sign-in page's order. A change is in force at once.
        {#if s}<InfoTip text={`Kept in ${s.file} (mode 600). A secret there may be env:NAME, read from the server's environment.`} />{/if}
      </p>
    </div>
    <Menu label="Add…" title="Add a way to sign in" items={PRESETS.map((p) => ({ label: p.label, run: () => add(p.make) }))} />
  </header>

  {#if error}<p class="error">{error}</p>{/if}

  {#if s}
    <ul class="providers">
      {#each s.providers as p, i (p.id)}
        <li>
          <span class="ic"><Icon name={p.type === "ldap" ? "organization" : "globe"} size={18} /></span>
          <button class="main" onclick={() => (editing = { provider: p, isNew: false })}>
            <span class="head">
              <span class="name">{p.label}</span>
              <span class="kind">{p.type === "ldap" ? "Directory (LDAP)" : "OpenID Connect"}</span>
              <code class="id">{p.id}</code>
            </span>
            <span class="where">{where(p)}</span>
            {#if p.problem}
              <span class="bad"><Icon name="error" size={13} />Not in use: {p.problem}</span>
            {:else if p.secretEnvMissing}
              <span class="warn"><Icon name="warning" size={13} />Its secret's environment variable isn't set on the server: signing in with it fails.</span>
            {/if}
          </button>
          <span class="acts">
            <button class="icon" title="Up" aria-label="Move {p.label} up" disabled={i === 0} onclick={() => move(i, -1)}><Icon name="arrow-up" size={14} /></button>
            <button class="icon" title="Down" aria-label="Move {p.label} down" disabled={i === s.providers.length - 1} onclick={() => move(i, 1)}><Icon name="arrow-down" size={14} /></button>
            <button class="icon" title="Edit" aria-label="Edit {p.label}" onclick={() => (editing = { provider: p, isNew: false })}><Icon name="edit" size={14} /></button>
            <button class="icon" title="Remove" aria-label="Remove {p.label}" onclick={() => remove(p)}><Icon name="trash" size={14} /></button>
          </span>
        </li>
      {/each}
      <li class="fixed">
        <span class="ic"><Icon name="shield" size={18} /></span>
        <span class="main static">
          <span class="head"><span class="name">System administrator</span><code class="id">sysadmin</code></span>
          <span class="where">
            {s.sysadmin}, {s.sysadminSource === "env" ? "from the server's .env (QUERIER_ADMIN_USER)" : "Querier's own account (its password: the account menu)"}: works when every directory is down
          </span>
        </span>
      </li>
    </ul>
    {#if !s.providers.length}<p class="muted">Only the system administrator can sign in: add a directory or an identity provider.</p>{/if}

    <h3>Who may sign in</h3>
    <div class="admission">
      {#if s.admission.custom}
        <p>
          <Icon name="shield" size={14} />Decided by <code>sign-in.cedar</code>, edited as a policy file.
          <a href={adminHref("policies")}>Open it in Policies</a>
        </p>
      {:else if s.admission.when}
        <p>Only those who match this; anyone else is refused at sign-in, and signed out as soon as they no longer match.</p>
        <CodeInput value={s.admission.when} onchange={() => {}} readOnly minLines={1} maxLines={6} label="Who may sign in" />
        <p class="acts2">
          <button class="btn" onclick={() => (admitting = true)}><Icon name="edit" size={14} />Change…</button>
          <button class="btn" onclick={letEveryoneIn}>Let everyone in</button>
        </p>
      {:else}
        <p>
          Everyone the directories and providers above accept. They see nothing until a role, share or policy gives them access.
          <InfoTip text="The system administrator can always sign in, whatever the rule: a mistake here can't lock everyone out." />
        </p>
        <p class="acts2"><button class="btn" onclick={() => (admitting = true)}><Icon name="filter" size={14} />Only some people…</button></p>
      {/if}
    </div>

    <h3>Sessions</h3>
    <form class="session" onsubmit={saveSession}>
      <label>
        <span>Longest a session lasts</span>
        <span class="n"><input class="text" type="number" min="1" max="720" bind:value={session.absoluteHours} />hours</span>
      </label>
      <label>
        <span>Signed out after unused for</span>
        <span class="n"><input class="text" type="number" min="5" max="10080" bind:value={session.idleMinutes} />minutes</span>
      </label>
      <label>
        <span>Groups and attributes read again every <InfoTip text="From the directory (LDAP) or the provider's refresh token (OIDC): a change there reaches Querier this soon, and a disabled account is signed out." /></span>
        <span class="n"><input class="text" type="number" min="1" max="1440" bind:value={session.refreshMinutes} />minutes</span>
      </label>
      <button class="primary" type="submit" disabled={!sessionDirty}>{sessionSaved ? "Saved" : "Save"}</button>
    </form>
    {#if sessionError}<p class="error">{sessionError}</p>{/if}

    <h3>Public links</h3>
    <form class="public" onsubmit={savePublic}>
      <p class="muted">
        A published report's Admin or Member can give it a link anyone opens without signing in: its last run as its owner, no code, no controls.
        <InfoTip text="Off, no public link works (they come back as they were when it is on again). Each link can narrow the networks further, end on a date, ask a passcode and be kept out of other sites' frames." />
      </p>
      <label class="check"><input type="checkbox" bind:checked={publicEnabled} />Allow public links</label>
      <label>
        <span>Only from these networks <span class="muted">(optional)</span></span>
        <input class="text mono" bind:value={publicNetworks} disabled={!publicEnabled} placeholder="anywhere: or 10.0.0.0/8, 192.168.0.0/16" spellcheck="false" />
      </label>
      <button class="primary" type="submit">{publicSaved ? "Saved" : "Save"}</button>
    </form>
    {#if publicError}<p class="error">{publicError}</p>{/if}

    <h3>Sites reports may show</h3>
    <form class="public" onsubmit={saveEmbeds}>
      <p class="muted">
        A report can open another site beside it, such as a chat or a form, from a button at its corner, on public links too.
        <InfoTip text="The site runs as itself, with its own cookies and sign-in, outside the report's sandbox: list only sites you trust. A report's panel for a site not listed here shows nothing. The site has to allow being framed by Querier's address (its Content-Security-Policy frame-ancestors)." />
      </p>
      <label>
        <span>One address per line <span class="muted">(only its origin counts)</span></span>
        <textarea class="text mono" rows="3" bind:value={embedSites} placeholder="https://chat.example.com" spellcheck="false"></textarea>
      </label>
      <button class="primary" type="submit">{embedSaved ? "Saved" : "Save"}</button>
    </form>
    {#if embedError}<p class="error">{embedError}</p>{/if}
  {:else if !error}
    <p class="muted">Loading…</p>
  {/if}
</div>

{#if admitting && s}
  <CodeEditorPanel
    file="sign-in.cedar"
    detail="who may sign in"
    crumbs={["Administration", "Sign-in"]}
    value={s.admission.when ?? ""}
    placeholder={'principal in Group::"GG_MS_PowerBI_PRO_CIT411"'}
    {vocabulary}
    check={async (text) => (await api.access.check(text)).problems}
    help={'A group (principal in Group::"…"), an attribute (principal.getTag("department")…) or a provider (principal.getTag("provider").contains("…")). Ctrl+Space suggests.'}
    applyLabel="Save"
    onapply={setAdmission}
    onclose={() => (admitting = false)}
  />
{/if}
{#if editing && s}
  <ProviderDialog
    provider={editing.provider}
    isNew={editing.isNew}
    redirectBase={s.redirectBase}
    taken={s.providers.map((p) => p.id)}
    onsaved={() => ((editing = null), load())}
    onclose={() => (editing = null)}
  />
{/if}

<style>
  /* public links: on or off, and within which networks */
  .public {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
    max-width: 40rem;
  }
  .public p {
    margin: 0;
  }
  .public label:not(.check) {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    width: 100%;
  }
  .public .mono {
    font-family: var(--mono);
    font-size: 0.78rem;
  }
  .public textarea {
    box-sizing: border-box;
    width: 100%;
    padding: 0.375rem 0.5rem;
    color: var(--wb-fg);
    background: var(--wb-input);
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
    resize: vertical;
  }
  .public textarea:focus {
    outline: none;
    border-color: var(--wb-accent);
  }
  .public .check {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }
  .providers {
    margin: 0;
    padding: 0;
    list-style: none;
    border-top: 1px solid var(--wb-border);
  }
  li {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.625rem 0.5rem;
    border-bottom: 1px solid var(--wb-border);
  }
  .ic {
    display: flex;
    padding-top: 0.125rem;
    color: var(--wb-accent);
  }
  .fixed .ic {
    color: var(--wb-fg-muted);
  }
  .main {
    display: flex;
    flex-direction: column;
    gap: 0.1875rem;
    flex: 1;
    min-width: 0;
    padding: 0;
    text-align: left;
    color: var(--wb-fg);
  }
  button.main:hover .name {
    color: var(--wb-accent);
  }
  .head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .name {
    font-size: 0.875rem;
    font-weight: 600;
  }
  .kind {
    padding: 0 0.375rem;
    font-size: 0.6875rem;
    line-height: 1.125rem;
    color: var(--wb-fg-muted);
    border: 1px solid var(--wb-border);
    border-radius: 3px;
  }
  .id {
    font-size: 0.72rem;
    color: var(--wb-fg-dim);
  }
  .where {
    font: 0.75rem var(--mono);
    color: var(--wb-fg-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fixed .where {
    font-family: var(--sans);
    white-space: normal;
  }
  .bad,
  .warn {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    font-size: 0.75rem;
  }
  .bad {
    color: var(--critical);
  }
  .warn {
    color: var(--warning);
  }
  .acts {
    display: flex;
    gap: 0.125rem;
    flex: none;
  }
  .acts .icon {
    width: 1.625rem;
    height: 1.625rem;
    color: var(--wb-fg-muted);
  }
  .acts .icon:hover:not(:disabled) {
    color: var(--wb-fg);
  }
  .admission {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    font-size: 0.8125rem;
  }
  .admission p {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin: 0;
    color: var(--wb-fg-muted);
  }
  .admission a {
    color: var(--wb-accent);
  }
  .acts2 {
    gap: 0.5rem !important;
  }
  .admission .btn,
  .acts2 .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    height: 1.75rem;
    padding: 0 0.75rem;
    font-size: 0.8125rem;
    color: var(--wb-fg);
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
  }
  .session {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 1rem 1.5rem;
    font-size: 0.8125rem;
  }
  .session label {
    display: flex;
    flex-direction: column;
    gap: 0.3125rem;
    color: var(--wb-fg-muted);
  }
  .n {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--wb-fg);
  }
  .n input {
    width: 5.5rem;
  }
  .adm-head :global(button.text) {
    height: 1.75rem;
    padding: 0 0.875rem;
    color: #fff;
    background: var(--wb-accent);
    border-radius: 4px;
  }
</style>
