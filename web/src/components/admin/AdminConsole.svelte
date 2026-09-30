<script lang="ts">
  import { adminHref, type AdminSection } from "../../lib/href";
  import Icon from "../Icon.svelte";
  import AuditView from "./AuditView.svelte";
  import ExplainView from "./ExplainView.svelte";
  import PeopleView from "./PeopleView.svelte";
  import PoliciesView from "./PoliciesView.svelte";
  import ServerView from "./ServerView.svelte";
  import SignInView from "./SignInView.svelte";

  // Administration, as an editor at home: who may do what (the policy files),
  // why a decision went as it did, who people are to the policies (their groups
  // and attributes), and what happened (the audit log). The sysadmin's, or
  // whoever a policy gives admin.manage.
  let { section, query }: { section: AdminSection; query: Record<string, string> } = $props();

  const SECTIONS: { id: AdminSection; label: string; icon: string; what: string }[] = [
    { id: "policies", label: "Policies", icon: "shield", what: "Who may do what, beyond roles and shares" },
    { id: "explain", label: "Explain a decision", icon: "question", what: "May this person do this, and why" },
    { id: "people", label: "People", icon: "person", what: "Who has signed in, as policies see them" },
    { id: "audit", label: "Audit log", icon: "history", what: "Sign-ins, denials, changes" },
    { id: "signin", label: "Sign-in", icon: "key", what: "Directories and identity providers, sessions" },
    { id: "server", label: "Server", icon: "server", what: "The machine, running kernels, who is signed in" },
  ];
</script>

<div class="admin">
  <nav aria-label="Administration">
    <h1>Administration</h1>
    {#each SECTIONS as s (s.id)}
      <a href={adminHref(s.id)} class:on={section === s.id} aria-current={section === s.id ? "page" : undefined} title={s.what}>
        <Icon name={s.icon} size={16} />{s.label}
      </a>
    {/each}
  </nav>
  <main>
    {#key section}
      {#if section === "policies"}
        <PoliciesView />
      {:else if section === "explain"}
        <ExplainView {query} />
      {:else if section === "people"}
        <PeopleView {query} />
      {:else if section === "signin"}
        <SignInView />
      {:else if section === "server"}
        <ServerView />
      {:else}
        <AuditView {query} />
      {/if}
    {/key}
  </main>
</div>

<style>
  .admin {
    display: grid;
    grid-template-columns: 13.5rem minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    color: var(--wb-fg);
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 1.25rem 0.5rem;
    border-right: 1px solid var(--wb-border);
    overflow-y: auto;
  }
  h1 {
    margin: 0 0 0.75rem;
    padding: 0 0.625rem;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--wb-fg-muted);
  }
  nav a {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    height: 1.75rem;
    padding: 0 0.625rem;
    font-size: 0.8125rem;
    color: var(--wb-fg);
    text-decoration: none;
    border-radius: 4px;
  }
  nav a :global(i) {
    color: var(--wb-fg-muted);
  }
  nav a:hover {
    background: var(--wb-list-hover);
  }
  nav a.on {
    background: var(--wb-list-active);
  }
  nav a.on :global(i) {
    color: var(--wb-accent);
  }
  main {
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
  }
  /* what every section is laid out with */
  main :global(.adm) {
    max-width: 64rem;
    padding: 1.5rem 2rem 4rem;
  }
  main :global(.adm-head) {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    margin-bottom: 1.25rem;
  }
  main :global(.adm-head h2) {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
  }
  main :global(.adm-head p) {
    margin: 0.25rem 0 0;
    font-size: 0.8125rem;
    color: var(--wb-fg-muted);
  }
  main :global(.adm-head .grow) {
    flex: 1;
    min-width: 0;
  }
  main :global(.adm h3) {
    margin: 1.75rem 0 0.5rem;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--wb-fg-muted);
  }
  main :global(.adm .btn) {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    height: 1.75rem;
    padding: 0 0.75rem;
    font-size: 0.8125rem;
    color: var(--wb-fg);
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
    white-space: nowrap;
    text-decoration: none;
  }
  main :global(.adm .btn:hover) {
    background: var(--wb-list-hover);
  }
  main :global(.adm .primary) {
    height: 1.75rem;
    padding: 0 0.875rem;
  }
  main :global(.adm input.text) {
    box-sizing: border-box;
    height: 1.75rem;
    padding: 0 0.5rem;
    font: inherit;
    font-size: 0.8125rem;
    color: var(--wb-fg);
    background: var(--wb-input);
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
  }
  main :global(.adm input.text:focus) {
    outline: none;
    border-color: var(--wb-accent);
  }
  main :global(.adm .chips) {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  main :global(.adm .chip) {
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0 0.375rem;
    font: 0.72rem/1.25rem var(--mono);
    background: var(--wb-list-hover);
    border-radius: 3px;
  }
  main :global(.adm .muted) {
    color: var(--wb-fg-dim);
    font-size: 0.8125rem;
  }
  main :global(.adm .error) {
    margin: 0.5rem 0;
    padding: 0.375rem 0.625rem;
    font-size: 0.8125rem;
    color: var(--critical);
    border-left: 2px solid currentColor;
    background: color-mix(in srgb, currentColor 7%, transparent);
  }
</style>
