<script lang="ts">
  import { session } from "../../lib/session.svelte";
  import Icon from "../Icon.svelte";
  import Menu, { type MenuItem } from "../Menu.svelte";

  // The activity bar, the same on every page: which view the side bar shows;
  // settings at the bottom.
  let {
    views,
    active,
    onpick,
    menu,
  }: {
    views: { id: string; icon: string; title: string; badge?: number }[];
    active: string | null;
    onpick: (id: string) => void;
    menu: (MenuItem | "-")[];
  } = $props();
</script>

<nav class="activity" aria-label="Views" style:view-transition-name="wb-activity">
  {#each views as v (v.id)}
    <button class:on={active === v.id} title={v.title} aria-label={v.title} aria-pressed={active === v.id} onclick={() => onpick(v.id)}>
      <Icon name={v.icon} size={24} />
      {#if v.badge}<span class="badge">{v.badge}</span>{/if}
    </button>
  {/each}
  <span class="spacer"></span>
  <!-- Accounts, as VS Code's: who is signed in, and signing out -->
  {#if session.me}
    <div class="gear">
      <Menu
        icon="account"
        title={`${session.me.name ?? session.me.username} (${session.me.sysadmin ? "system administrator" : session.me.provider})`}
        items={[
          { label: `${session.me.name ?? session.me.username}${session.me.email ? ` · ${session.me.email}` : ""}`, disabled: false, run: () => {} },
          "-",
          { label: "Sign Out", run: () => session.signOut() },
        ]}
      />
    </div>
  {/if}
  <div class="gear"><Menu icon="settings-gear" title="Settings" items={menu} /></div>
</nav>

<style>
  .activity {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 3rem;
    background: var(--wb-bar);
    border-right: 1px solid var(--wb-border);
  }
  .activity > button {
    position: relative;
    display: grid;
    place-items: center;
    width: 3rem;
    height: 3rem;
    padding: 0;
    border-radius: 0;
    color: var(--wb-fg-dim);
  }
  .activity > button:hover {
    background: none;
    color: var(--wb-fg);
  }
  .activity > button:active {
    transform: none;
  }
  .activity > button.on {
    color: var(--wb-fg);
  }
  .activity > button.on::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--wb-accent);
  }
  .badge {
    position: absolute;
    right: 0.375rem;
    bottom: 0.4rem;
    min-width: 1rem;
    height: 1rem;
    padding: 0 0.25rem;
    border-radius: 999px;
    font-size: 0.625rem;
    line-height: 1rem;
    text-align: center;
    color: #fff;
    background: var(--wb-badge);
  }
  .spacer {
    flex: 1;
  }
  .gear {
    padding-bottom: 0.5rem;
  }
  .gear :global(button.icon) {
    width: 3rem;
    height: 3rem;
    color: var(--wb-fg-dim);
    border-radius: 0;
  }
  .gear :global(button.icon:hover) {
    background: none;
    color: var(--wb-fg);
  }
  .gear :global(button.icon i) {
    font-size: 1.5rem !important;
  }
</style>
