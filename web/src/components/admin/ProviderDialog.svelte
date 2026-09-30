<script lang="ts">
  import { api, type CertificateInfo, type ProviderSettings, type ProviderTest } from "../../lib/api";
  import { writeClipboard } from "../../lib/copy";
  import Icon from "../Icon.svelte";
  import InfoTip from "../ui/InfoTip.svelte";
  import Select from "../ui/Select.svelte";
  import OverlayPanel from "../wb/OverlayPanel.svelte";

  // One identity provider's settings: a directory over LDAP(S), or an OpenID
  // Connect provider; how people are found and what of them policies see (their
  // groups, and attributes mapped to tags). Tried before it is saved: the
  // directory reached and a person looked up by name, or the issuer's discovery
  // read. Saved to auth.json and in force at once.
  let {
    provider,
    isNew,
    redirectBase,
    taken,
    onsaved,
    onclose,
  }: {
    provider: ProviderSettings;
    isNew: boolean;
    /** where people come back from an OIDC provider: this + /api/auth/oidc/<id>/callback */
    redirectBase: string;
    /** ids already used */
    taken: string[];
    onsaved: () => void;
    onclose: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let d = $state<ProviderSettings>(structuredClone($state.snapshot(provider)) as ProviderSettings);
  // svelte-ignore state_referenced_locally
  let attrs = $state<{ k: string; v: string }[]>(Object.entries(provider.attributes ?? {}).map(([k, v]) => ({ k, v })));
  // svelte-ignore state_referenced_locally
  let scopes = $state((provider.scopes ?? []).join(" "));
  const ldap = $derived(d.type === "ldap");
  const secretKey = $derived(ldap ? "bindPassword" : "clientSecret") as "bindPassword" | "clientSecret";

  // the secret: stored in auth.json (typed here; blank keeps what is stored) or an environment variable's
  // svelte-ignore state_referenced_locally
  let secretFrom = $state<"stored" | "env">((provider[ldap ? "bindPassword" : "clientSecret"] ?? "").startsWith("env:") ? "env" : "stored");
  // svelte-ignore state_referenced_locally
  let envName = $state((provider[ldap ? "bindPassword" : "clientSecret"] ?? "").replace(/^env:/, ""));
  let secretValue = $state("");
  let showSecret = $state(false);

  const idProblem = $derived(
    !isNew ? "" : !/^[a-z][a-z0-9-]{0,31}$/.test(d.id) ? "Lowercase letters, digits and -, starting with a letter." : taken.includes(d.id) || d.id === "sysadmin" ? "That id is taken." : "",
  );
  const redirectUri = $derived(`${redirectBase}/api/auth/oidc/${encodeURIComponent(d.id || "<id>")}/callback`);

  /** What is sent: the form's fields, the attributes and scopes, and the secret as chosen. */
  function draft(): ProviderSettings {
    const out: ProviderSettings = { ...$state.snapshot(d) as ProviderSettings };
    out.attributes = Object.fromEntries(attrs.filter((a) => a.k.trim()).map((a) => [a.k.trim(), a.v.trim()]));
    if (!ldap) out.scopes = scopes.split(/[\s,]+/).filter(Boolean);
    out[secretKey] = secretFrom === "env" ? (envName.trim() ? `env:${envName.trim()}` : "") : secretValue;
    for (const k of ["secretStored", "secretEnvMissing", "problem"] as const) delete out[k];
    return out;
  }

  let testing = $state(false);
  let allGroups = $state(false);
  let lookup = $state("");
  let result = $state<ProviderTest | null>(null);
  let error = $state("");
  let saving = $state(false);

  async function test() {
    testing = true;
    error = "";
    try {
      result = await api.admin.auth.test(draft(), isNew ? undefined : provider.id, ldap ? lookup : undefined);
    } catch (e: any) {
      error = e.message;
      result = null;
    }
    testing = false;
  }
  async function save() {
    saving = true;
    error = "";
    try {
      await api.admin.auth.save(d.id, draft());
      onsaved();
    } catch (e: any) {
      error = e.message;
    }
    saving = false;
  }
  const insecure = $derived(ldap && (d.url ?? "").startsWith("ldap://") && !d.startTls);

  // -- the CA certificate: a file of IT's (.pem, .crt, .cer) uploaded or its PEM pasted; read on
  // the server, and shown as what it is (whose, until when, its fingerprint) to check with IT
  let caInfo = $state<CertificateInfo[] | null>(null);
  let caError = $state("");
  let pasting = $state(false);
  let pasted = $state("");
  let pickFile = $state<HTMLInputElement>();
  // svelte-ignore state_referenced_locally
  let caPath = $state(!provider.ca && !!provider.caFile);
  async function readCa(given: { pem: string } | { der: string }) {
    caError = "";
    try {
      const r = await api.admin.auth.certificate(given);
      d.ca = r.pem;
      d.caFile = "";
      caInfo = r.certs;
      pasting = false;
      pasted = "";
      caPath = false;
    } catch (e: any) {
      caError = e.message;
    }
  }
  async function uploaded(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    (e.currentTarget as HTMLInputElement).value = "";
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    if (text.includes("-----BEGIN")) return readCa({ pem: text });
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return readCa({ der: btoa(bin) });
  }
  function removeCa() {
    d.ca = undefined;
    caInfo = null;
  }
  // the one saved: shown as what it is
  // svelte-ignore state_referenced_locally
  if (provider.ca) api.admin.auth.certificate({ pem: provider.ca }).then((r) => (caInfo = r.certs), (e) => (caError = e.message));
  const cn = (dn: string) => /CN=([^,]+)/.exec(dn)?.[1] ?? dn;
  const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
</script>

{#snippet field(label: string, info?: string)}
  <span class="l">{label}{#if info}<InfoTip text={info} />{/if}</span>
{/snippet}

<OverlayPanel icon={ldap ? "organization" : "globe"} title={isNew ? `New sign-in: ${ldap ? "directory (LDAP)" : "OpenID Connect"}` : `Sign-in: ${provider.label}`} detail={isNew ? undefined : provider.id} {onclose}>
  <div class="wrap">
  <div class="dialog">
    <div class="form">
      <section>
        <h3>How it shows</h3>
        <div class="grid">
          <label>
            {@render field("Label", "The button or form people pick on the sign-in page.")}
            <input bind:value={d.label} placeholder="Corporate account" />
          </label>
          <label>
            {@render field("Id", "Part of the id of everyone who signs in with it (id:subject): it can't change once saved.")}
            <input class="mono" bind:value={d.id} disabled={!isNew} spellcheck="false" />
            {#if idProblem}<span class="bad">{idProblem}</span>{/if}
          </label>
        </div>
      </section>

      {#if ldap}
        <section>
          <h3>The directory</h3>
          <label>
            {@render field("Address", "ldaps://host:636, or ldap://host:389 with StartTLS.")}
            <input class="mono" bind:value={d.url} placeholder="ldaps://dc1.corp.example.com:636" spellcheck="false" />
          </label>
          <div class="checks">
            <label class="check"><input type="checkbox" bind:checked={d.startTls} />StartTLS (on an ldap:// address)</label>
            {#if insecure}
              <label class="check warn"><input type="checkbox" bind:checked={d.allowInsecure} />Allow passwords in the clear (no TLS)</label>
            {/if}
          </div>
          <div class="grid">
            <div class="ca">
              {@render field("CA certificate", "The CA that signed the directory's certificate: its file from IT (.pem, .crt or .cer), or its text. The directory's certificate is always checked against it; compare the fingerprint with IT's.")}
              {#if d.ca && caInfo}
                {#each caInfo as c (c.fingerprint)}
                  <div class="cert" class:warn={!c.ca || c.expired}>
                    <Icon name={!c.ca || c.expired ? "warning" : "verified"} size={16} />
                    <div class="what">
                      <span class="name" title={c.subject}>{cn(c.subject)}</span>
                      <span class="meta">{c.expired ? "expired" : "until"} {day(c.notAfter)}{c.ca ? "" : " · not a CA: the directory's own certificate?"}</span>
                      <button class="fp mono" title="SHA-256 fingerprint: click to copy" onclick={() => writeClipboard(c.fingerprint)}>{c.fingerprint}</button>
                    </div>
                  </div>
                {/each}
                <div class="ca-acts">
                  <button class="btn" onclick={() => pickFile?.click()}>Replace</button>
                  <button class="btn" onclick={removeCa}>Remove</button>
                </div>
              {:else if caPath}
                <input class="mono" bind:value={d.caFile} placeholder="/data/config/corp-ca.pem" spellcheck="false" aria-label="A PEM file on the server" />
                <button class="link" onclick={() => ((caPath = false), (d.caFile = ""))}>Upload one instead</button>
              {:else if pasting}
                <!-- svelte-ignore a11y_autofocus -->
                <textarea class="mono" bind:value={pasted} rows="5" placeholder="-----BEGIN CERTIFICATE-----" spellcheck="false" autofocus></textarea>
                <div class="ca-acts">
                  <button class="btn primary" disabled={!pasted.trim()} onclick={() => readCa({ pem: pasted })}>Use it</button>
                  <button class="btn" onclick={() => ((pasting = false), (pasted = ""))}>Cancel</button>
                </div>
              {:else}
                <div class="ca-acts">
                  <button class="btn" onclick={() => pickFile?.click()}><Icon name="cloud-upload" size={14} />Upload…</button>
                  <button class="btn" onclick={() => (pasting = true)}>Paste</button>
                  <button class="link" onclick={() => (caPath = true)}>or a file on the server</button>
                </div>
              {/if}
              {#if caError}<span class="bad">{caError}</span>{/if}
              <input bind:this={pickFile} type="file" accept=".pem,.crt,.cer,.der,application/x-x509-ca-cert" hidden onchange={uploaded} />
            </div>
            <label>
              {@render field("Name on its certificate", "When the address names the directory otherwise (an IP, a tunnel): the name its certificate was issued to.")}
              <input class="mono" bind:value={d.tlsServerName} placeholder="dc1.corp.example.com" spellcheck="false" />
            </label>
          </div>
        </section>

        <section>
          <h3>The service account</h3>
          <p class="sub">What Querier searches with: a read-only account. Each person's password is checked by signing in as them.</p>
          <label>
            {@render field("Its DN")}
            <input class="mono" bind:value={d.bindDn} placeholder="CN=svc-querier,OU=Service Accounts,DC=corp,DC=example,DC=com" spellcheck="false" />
          </label>
          {@render secret("Its password")}
        </section>

        <section>
          <h3>Finding people</h3>
          <div class="grid">
            <label>
              {@render field("Where they are (base DN)")}
              <input class="mono" bind:value={d.baseDn} placeholder="DC=corp,DC=example,DC=com" spellcheck="false" />
            </label>
            <label>
              {@render field("Filter", "{username} is replaced by what they typed (escaped).")}
              <input class="mono" bind:value={d.userFilter} placeholder={"(&(objectClass=user)(sAMAccountName={username}))"} spellcheck="false" />
            </label>
            <label>
              {@render field("Username attribute")}
              <input class="mono" bind:value={d.usernameAttribute} placeholder="sAMAccountName" spellcheck="false" />
            </label>
            <label>
              {@render field("Stable id attribute", "What never changes for a person: objectGUID (AD), entryUUID (OpenLDAP).")}
              <input class="mono" bind:value={d.idAttribute} placeholder="objectGUID" spellcheck="false" />
            </label>
            <label>
              {@render field("Email attribute")}
              <input class="mono" bind:value={d.emailAttribute} placeholder="mail" spellcheck="false" />
            </label>
            <label>
              {@render field("Name attribute")}
              <input class="mono" bind:value={d.nameAttribute} placeholder="displayName" spellcheck="false" />
            </label>
          </div>
        </section>

        <section>
          <h3>Groups</h3>
          <div class="grid">
            <label>
              {@render field("Where groups are", "Set it to include nested groups (Active Directory): a person is in every group their groups are in.")}
              <input class="mono" bind:value={d.groupBaseDn} placeholder="DC=corp,DC=example,DC=com (or leave empty: memberOf only)" spellcheck="false" />
            </label>
            <div class="field">
              {@render field("A group's name in policies")}
              <Select
                value={d.groupName ?? "cn"}
                options={[
                  { value: "cn", label: "Its cn: finance" },
                  { value: "dn", label: "Its whole DN" },
                ]}
                onchange={(v) => (d.groupName = v === "dn" ? "dn" : undefined)}
                label="A group's name"
              />
            </div>
          </div>
          {#if d.groupBaseDn}
            <label class="check"><input type="checkbox" checked={d.nestedGroups !== false} onchange={(e) => (d.nestedGroups = e.currentTarget.checked ? undefined : false)} />Include nested groups</label>
          {/if}
        </section>
      {:else}
        <section>
          <h3>The provider</h3>
          <label>
            {@render field("Issuer", "Its address: where /.well-known/openid-configuration is. Entra: https://login.microsoftonline.com/<tenant id>/v2.0. Keycloak: https://host/realms/<realm>.")}
            <input class="mono" bind:value={d.issuer} placeholder="https://login.microsoftonline.com/<tenant-id>/v2.0" spellcheck="false" />
          </label>
          <div class="grid">
            <label>
              {@render field("Client id")}
              <input class="mono" bind:value={d.clientId} spellcheck="false" />
            </label>
            <label>
              {@render field("Scopes", "Space-separated. offline_access lets Querier read their groups again without signing them out; Entra's group overage needs GroupMember.Read.All.")}
              <input class="mono" bind:value={scopes} placeholder="openid profile email offline_access" spellcheck="false" />
            </label>
          </div>
          {@render secret("Client secret")}
          <div class="redirect">
            <span class="l">Redirect URI <span class="sub">register it with the provider</span></span>
            <span class="copy"><code>{redirectUri}</code><button class="icon" title="Copy" aria-label="Copy the redirect URI" onclick={() => writeClipboard(redirectUri)}><Icon name="copy" size={14} /></button></span>
          </div>
        </section>

        <section>
          <h3>Who they are <span class="aside">claims</span></h3>
          <div class="grid">
            <label>{@render field("Username")}<input class="mono" bind:value={d.usernameClaim} placeholder="preferred_username" spellcheck="false" /></label>
            <label>{@render field("Email")}<input class="mono" bind:value={d.emailClaim} placeholder="email" spellcheck="false" /></label>
            <label>{@render field("Name")}<input class="mono" bind:value={d.nameClaim} placeholder="name" spellcheck="false" /></label>
            <label>{@render field("Groups", "A claim that lists them: add a groups mapper in Keycloak; in Entra, the token's groups claim.")}<input class="mono" bind:value={d.groupsClaim} placeholder="groups" spellcheck="false" /></label>
          </div>
          <div class="checks">
            <label class="check"><input type="checkbox" bind:checked={d.userinfo} />Also read the userinfo endpoint</label>
            <label class="check"><input type="checkbox" bind:checked={d.entraGraphOverage} />Microsoft Entra: read groups from Graph when there are too many for the token</label>
          </div>
        </section>
      {/if}

      <section>
        <h3>Attributes <span class="aside">principal.getTag(…)</span></h3>
        <p class="sub">What policies and bound PARAMs see of a person, beyond their groups: a tag's name, and the {ldap ? "directory attribute" : "claim (dotted paths reach inside: realm_access.roles)"} it comes from.</p>
        {#if attrs.length}
          <div class="attrs">
            {#each attrs as a, i (i)}
              <input class="mono" bind:value={a.k} placeholder="department" spellcheck="false" aria-label="Tag" />
              <Icon name="arrow-left" size={14} />
              <input class="mono" bind:value={a.v} placeholder={ldap ? "department" : "department"} spellcheck="false" aria-label="From" />
              <button class="icon" title="Remove" aria-label="Remove {a.k}" onclick={() => attrs.splice(i, 1)}><Icon name="close" size={14} /></button>
            {/each}
          </div>
        {/if}
        <button class="btn" onclick={() => attrs.push({ k: "", v: "" })}><Icon name="add" size={14} />Attribute</button>
      </section>
    </div>

    <aside class="test">
      <h3>Try it</h3>
      {#if ldap}
        <p class="sub">Reaches the directory, signs in as the service account, and looks someone up as a sign-in would, without their password.</p>
        <input class="text mono" bind:value={lookup} placeholder="a username (optional)" spellcheck="false" onkeydown={(e) => e.key === "Enter" && test()} />
      {:else}
        <p class="sub">Reads the issuer's discovery document and checks the secret. Signing in with it is the rest of the test.</p>
      {/if}
      <button class="btn" onclick={test} disabled={testing}><Icon name={testing ? "loading" : "debug-start"} size={14} spin={testing} />{testing ? "Trying…" : "Try these settings"}</button>
      {#if result}
        <ol class="steps">
          {#each result.steps as s, i (i)}
            <li class:bad={!s.ok}>
              <Icon name={s.ok ? "pass" : "error"} size={14} />
              <span><span class="what">{s.what}</span>{#if s.detail}<span class="detail">{s.detail}</span>{/if}</span>
            </li>
          {/each}
        </ol>
        {#if result.principal}
          {@const p = result.principal}
          <div class="found">
            <p><strong>{p.name ?? p.username}</strong>{#if p.email} · {p.email}{/if}{#if result.disabled} · <span class="bad">disabled: can't sign in</span>{/if}</p>
            <p class="sub"><code>{p.id}</code></p>
            <p class="k">Groups</p>
            {#if p.groups.length}
              <!-- a directory can have dozens: the first few, and the rest on asking -->
              <p class="chips">
                {#each allGroups ? p.groups : p.groups.slice(0, 12) as g (g)}<span class="chip" title={g}>{g}</span>{/each}
                {#if p.groups.length > 12}
                  <button class="more" onclick={() => (allGroups = !allGroups)}>{allGroups ? "Fewer" : `Show all ${p.groups.length}`}</button>
                {/if}
              </p>
            {:else}<p class="sub">none</p>{/if}
            <p class="k">Attributes</p>
            {#if Object.keys(p.attrs).length}
              {#each Object.entries(p.attrs) as [k, vs] (k)}<p class="attr"><code>{k}</code> {vs.join(", ")}</p>{/each}
            {:else}<p class="sub">none mapped</p>{/if}
          </div>
        {/if}
      {/if}
    </aside>
  </div>
  <footer>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <span class="grow"></span>
    <button class="btn" onclick={onclose}>Cancel</button>
    <button class="primary" onclick={save} disabled={saving || !!idProblem}>{isNew ? "Add" : "Save"}</button>
  </footer>
  </div>
</OverlayPanel>

{#snippet secret(label: string)}
  <div class="field">
    {@render field(label, "Stored in auth.json (mode 600, never sent back to this page), or read from an environment variable of the server's (.env): then auth.json holds only its name.")}
    <div class="secret">
      <Select
        bind:value={secretFrom}
        options={[
          { value: "stored", label: "Stored" },
          { value: "env", label: "From an environment variable" },
        ]}
        label="Where the secret is"
      />
      {#if secretFrom === "env"}
        <input class="mono" bind:value={envName} placeholder="LDAP_BIND_PASSWORD" spellcheck="false" aria-label="Environment variable" />
      {:else}
        <span class="pw">
          <input type={showSecret ? "text" : "password"} bind:value={secretValue} placeholder={provider.secretStored && !isNew ? "stored: type to replace" : "not set"} autocomplete="new-password" spellcheck="false" aria-label={label} />
          <button class="icon" title={showSecret ? "Hide" : "Show"} aria-label={showSecret ? "Hide" : "Show"} onclick={() => (showSecret = !showSecret)}><Icon name={showSecret ? "eye-closed" : "eye"} size={14} /></button>
        </span>
      {/if}
    </div>
    {#if secretFrom === "env" && provider.secretEnvMissing && envName === (provider[secretKey] ?? "").replace(/^env:/, "")}
      <span class="bad">The server has no {envName}: add it to .env and restart.</span>
    {/if}
  </div>
{/snippet}

<style>
  /* the CA certificate: what it is, or how to give one */
  .ca {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    min-width: 0;
  }
  .cert {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
    padding: 0.5rem 0.625rem;
    color: var(--good);
    background: var(--wb-input);
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
  }
  .cert.warn {
    color: var(--warning);
  }
  .what {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    color: var(--wb-fg);
  }
  .what .name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .what .meta {
    font-size: 0.75rem;
    color: var(--wb-fg-muted);
  }
  .what .fp {
    padding: 0;
    font-size: 0.6875rem;
    text-align: left;
    color: var(--wb-fg-muted);
    word-break: break-all;
  }
  .what .fp:hover {
    color: var(--wb-fg);
  }
  .ca-acts {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .ca textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 0.375rem 0.5rem;
    resize: vertical;
    font-size: 0.72rem;
    color: var(--wb-fg);
    background: var(--wb-input);
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
  }
  .ca textarea:focus {
    outline: none;
    border-color: var(--wb-accent);
  }
  .link {
    padding: 0;
    font-size: 0.75rem;
    color: var(--wb-accent);
    align-self: flex-start;
  }
  .link:hover {
    text-decoration: underline;
  }
  .wrap {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .dialog {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 19rem;
    flex: 1;
    min-height: 0;
  }
  .form {
    padding: 0.5rem 1.25rem 1.5rem;
    overflow-y: auto;
    font-size: 0.8125rem;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 0.875rem 0 1rem;
    border-bottom: 1px solid var(--wb-border);
  }
  section:last-child {
    border-bottom: 0;
  }
  h3 {
    margin: 0;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--wb-fg-muted);
  }
  .aside {
    margin-left: 0.25rem;
    font-family: var(--mono);
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    color: var(--wb-fg-dim);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.625rem 1rem;
  }
  label,
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }
  .l {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-weight: 500;
  }
  .sub {
    margin: 0;
    font-size: 0.75rem;
    font-weight: 400;
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
  input:disabled {
    opacity: 0.6;
  }
  .mono {
    font-family: var(--mono);
    font-size: 0.78rem;
  }
  .checks {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .check {
    flex-direction: row;
    align-items: center;
    gap: 0.4375rem;
  }
  .check.warn {
    color: var(--warning);
  }
  .field :global(.select) {
    align-self: flex-start;
    min-width: 12rem;
  }
  .secret {
    display: flex;
    gap: 0.5rem;
  }
  .secret > :global(.select) {
    flex: none;
  }
  .pw {
    position: relative;
    flex: 1;
    display: flex;
  }
  .pw input {
    padding-right: 1.75rem;
  }
  .pw .icon {
    position: absolute;
    right: 0.125rem;
    top: 0.125rem;
    width: 1.5rem;
    height: 1.5rem;
    color: var(--wb-fg-muted);
  }
  .redirect {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .copy {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.25rem 0.25rem 0.5rem;
    background: var(--wb-list-hover);
    border-radius: 4px;
  }
  .copy code {
    flex: 1;
    font-size: 0.75rem;
    overflow-wrap: anywhere;
  }
  .copy .icon {
    width: 1.5rem;
    height: 1.5rem;
    flex: none;
  }
  .attrs {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.375rem;
    width: min(100%, 30rem);
  }
  .attrs :global(i) {
    color: var(--wb-fg-dim);
  }
  .attrs .icon {
    width: 1.5rem;
    height: 1.5rem;
    color: var(--wb-fg-muted);
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    align-self: flex-start;
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
  .bad {
    font-size: 0.75rem;
    color: var(--critical);
  }
  .test {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    min-width: 0;
    padding: 1.375rem 1rem;
    overflow-x: hidden;
    overflow-y: auto;
    font-size: 0.8125rem;
    border-left: 1px solid var(--wb-border);
    background: var(--wb-bar);
  }
  .steps {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .steps li {
    display: flex;
    gap: 0.4375rem;
  }
  .steps li :global(i) {
    flex: none;
    margin-top: 0.0625rem;
    color: var(--git-added);
  }
  .steps li.bad :global(i) {
    color: var(--critical);
  }
  .steps li > span {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .what {
    overflow-wrap: anywhere;
  }
  .detail {
    font-size: 0.75rem;
    color: var(--wb-fg-muted);
    overflow-wrap: anywhere;
  }
  .steps li.bad .detail {
    color: var(--critical);
  }
  .found {
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--wb-border);
    border-radius: 5px;
    background: var(--wb-editor);
  }
  .found p {
    margin: 0 0 0.25rem;
  }
  .found .k {
    margin-top: 0.5rem;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--wb-fg-muted);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .chip {
    max-width: 100%;
    padding: 0 0.375rem;
    font: 0.72rem/1.25rem var(--mono);
    background: var(--wb-list-hover);
    border-radius: 3px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .more {
    padding: 0 0.25rem;
    font-size: 0.72rem;
    line-height: 1.25rem;
    color: var(--wb-accent);
  }
  .more:hover {
    text-decoration: underline;
  }
  .found {
    min-width: 0;
  }
  .attr code {
    font-size: 0.75rem;
    color: var(--wb-fg-muted);
  }
  footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem 1rem;
    border-top: 1px solid var(--wb-border);
    background: var(--wb-bar);
  }
  footer .error {
    margin: 0;
    font-size: 0.78rem;
    color: var(--critical);
  }
  .grow {
    flex: 1;
  }
  .primary {
    height: 1.75rem;
    padding: 0 0.875rem;
  }
</style>
