<script lang="ts" module>
  import type { PeerUser } from "../lib/collab.svelte";

  /** Each person once, in the order they came. */
  export function people(users: PeerUser[]): PeerUser[] {
    const seen = new Map<string, PeerUser>();
    for (const u of users) if (!seen.has(u.id)) seen.set(u.id, u);
    return [...seen.values()];
  }

  const initials = (name: string) =>
    name
      .split(/[\s._@-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?";
</script>

<script lang="ts">
  import Icon from "./Icon.svelte";

  // People as small round badges in their colors (editing together): who is in a
  // cell, who has the notebook open. A few, then "+n".
  let { users, max = 4, label = "" }: { users: PeerUser[]; max?: number; label?: string } = $props();

  const shown = $derived(users.slice(0, max));
  const more = $derived(users.length - shown.length);
</script>

<span class="avatars" role="group" aria-label={label || users.map((u) => u.name).join(", ")}>
  {#each shown as u (u.id)}
    {@const who = u.agent ? `${u.name} (AI client, ${u.agent.owner}'s)` : u.name}
    <span class="avatar q-peer-c{u.color}" class:agent={!!u.agent} title={label ? `${who} ${label}` : who}>
      {#if u.agent}<Icon name="sparkle" size={11} />{:else}{initials(u.name)}{/if}
    </span>
  {/each}
  {#if more > 0}<span class="avatar more" title={users.slice(max).map((u) => u.name).join(", ")}>+{more}</span>{/if}
</span>

<style>
  .avatars {
    display: inline-flex;
    align-items: center;
  }
  .avatar {
    display: inline-grid;
    place-items: center;
    width: 1.25rem;
    height: 1.25rem;
    font: 600 0.5625rem/1 var(--sans);
    letter-spacing: 0.02em;
    color: #fff;
    background: var(--peer);
    border: 1.5px solid var(--wb-bg, var(--surface));
    border-radius: 50%;
    user-select: none;
  }
  .avatar + .avatar {
    margin-left: -0.3rem;
  }
  /* an AI client: its mark, not initials, and a square-ish badge to set it apart */
  .avatar.agent {
    border-radius: 35%;
  }
  .more {
    color: var(--wb-fg, var(--ink));
    background: var(--wb-list-hover, var(--hover));
  }
</style>
