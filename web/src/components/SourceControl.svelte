<script lang="ts">
  import { api } from "../lib/api";
  import type { NotebookCtl } from "../lib/notebook.svelte";
  import Icon from "./Icon.svelte";
  import Menu, { type MenuItem } from "./Menu.svelte";

  // The Changes tab: branch and sync, a commit box, and what changed per cell.
  let { ctl, onsettings }: { ctl: NotebookCtl; onsettings: () => void } = $props();

  const git = $derived(ctl.git);
  const count = $derived((git?.cells.length ?? 0) + (git?.files.length ?? 0));
  let message = $state("");
  let branches = $state<{ name: string; current: boolean }[]>([]);
  let newBranch = $state<string | null>(null);

  const LETTER = { modified: "M", added: "A", moved: "R", deleted: "D" } as const;

  /** A message from the changes, used when the box is left empty. */
  const suggestion = $derived.by(() => {
    if (!git) return "";
    const by = (c: string) => git.cells.filter((x) => x.change === c).map((x) => x.name);
    const parts = [
      by("modified").length && `Update ${list(by("modified"))}`,
      by("added").length && `add ${list(by("added"))}`,
      by("deleted").length && `remove ${list(by("deleted"))}`,
      by("moved").length && !by("modified").length && !by("added").length && `reorder cells`,
      !git.cells.length && git.files.length && `Update ${list(git.files.map((f) => f.path))}`,
    ].filter(Boolean) as string[];
    const text = parts.join(", ");
    return text ? text[0].toUpperCase() + text.slice(1) : "";
  });
  function list(xs: string[]) {
    return xs.length <= 3 ? xs.join(", ") : `${xs.slice(0, 2).join(", ")} and ${xs.length - 2} more`;
  }

  async function commit(e?: Event) {
    e?.preventDefault();
    const msg = message.trim() || suggestion;
    if (await ctl.gitDo("Committing", () => api.git.commit(ctl.name, msg))) {
      message = "";
      ctl.say(`Committed: ${msg}`);
    }
  }

  async function loadBranches() {
    branches = await api.git.branches(ctl.name).catch(() => []);
  }
  $effect(() => {
    void git?.branch;
    loadBranches();
  });

  const branchMenu = $derived<(MenuItem | "-")[]>([
    ...branches.map((b) => ({
      label: `${b.current ? "✓ " : ""}${b.name}`,
      disabled: b.current,
      run: () => ctl.gitDo("Switching", () => api.git.switchBranch(ctl.name, b.name), { reload: true }),
    })),
    "-",
    { label: "New branch…", run: () => (newBranch = "") },
  ]);

  const pullMenu = $derived<(MenuItem | "-")[]>([
    { label: "Pull", run: () => ctl.gitDo("Pulling", () => api.git.pull(ctl.name), { reload: true }) },
    { label: "Pull with rebase", run: () => ctl.gitDo("Pulling", () => api.git.pull(ctl.name, true), { reload: true }) },
    { label: "Fetch", run: () => ctl.gitDo("Fetching", () => api.git.fetch(ctl.name)) },
    "-",
    { label: "Remote settings…", run: onsettings },
  ]);

  async function createBranch(e: SubmitEvent) {
    e.preventDefault();
    const name = (newBranch ?? "").trim();
    if (!name) return;
    if (await ctl.gitDo("Creating branch", () => api.git.createBranch(ctl.name, name))) newBranch = null;
  }

  function open(cell: string, change: string) {
    ctl.select(cell);
    if (change === "modified" || change === "added") ctl.diffs[cell] = true;
  }

  const discard = (cells?: string[]) =>
    ctl.gitDo("Discarding", () => api.git.restore(ctl.name, "HEAD", cells), { reload: true });
</script>

{#if !git}
  <p class="empty">Reading git…</p>
{:else if !git.tracked}
  <div class="untracked">
    <p>This notebook isn't tracked with git.</p>
    <button class="primary" onclick={() => (ctl.gitPrompt = true)}>Track with git…</button>
  </div>
{:else}
  <div class="branch-row">
    <span class="branch">
      <Icon name="branch" size={14} />
      <span class="name">{git.branch ?? "detached"}</span>
    </span>
    <Menu items={branchMenu} title="Branches" />
    <span class="spacer"></span>
    {#if git.remote}
      {#if git.behind}<span class="count" title="Commits on origin you don't have">↓{git.behind}</span>{/if}
      {#if git.ahead}<span class="count" title="Commits not yet on origin">↑{git.ahead}</span>{/if}
      <button class="small" title="Push to origin" disabled={!!ctl.gitBusy} onclick={() => ctl.gitDo("Pushing", () => api.git.push(ctl.name))}>
        Push
      </button>
      <Menu items={pullMenu} title="Pull and remote" />
    {:else}
      <button class="small" onclick={onsettings}>Add remote</button>
    {/if}
  </div>

  {#if newBranch != null}
    <form class="new-branch" onsubmit={createBranch}>
      <!-- svelte-ignore a11y_autofocus -->
      <input bind:value={newBranch} placeholder="new-branch-name" autofocus onkeydown={(e) => e.key === "Escape" && (newBranch = null)} />
      <button type="submit" class="small">Create</button>
    </form>
  {/if}

  <form class="commit" onsubmit={commit}>
    <textarea
      bind:value={message}
      placeholder={suggestion || "Message"}
      rows="2"
      onkeydown={(e) => (e.ctrlKey || e.metaKey) && e.key === "Enter" && commit(e)}
    ></textarea>
    <button type="submit" class="primary" disabled={!count || !!ctl.gitBusy} title="Ctrl+Enter">
      {ctl.gitBusy ?? (count ? `Commit ${count === 1 ? "1 change" : `${count} changes`}` : "No changes")}
    </button>
  </form>

  {#if count}
    <div class="section">
      <span>Changes</span>
      <button class="link" onclick={() => discard()} title="Put every cell back as it was in the last commit">Discard all</button>
    </div>
    <ul>
      {#each git.cells as c (c.name)}
        <li>
          <button class="entry" onclick={() => open(c.name, c.change)} disabled={c.change === "deleted"} title={c.was && c.file ? `${c.was} → ${c.file}` : (c.file ?? c.was)}>
            <span class="cellname" class:gone={c.change === "deleted"}>{c.name}</span>
            <span class="letter {c.change}">{LETTER[c.change]}</span>
          </button>
          <button class="icon undo" title={c.change === "deleted" ? "Bring it back" : "Discard changes"} onclick={() => discard([c.name])}>
            <Icon name="undo" size={13} />
          </button>
        </li>
      {/each}
      {#each git.files as f (f.path)}
        <li>
          <span class="entry file" title={f.path}>
            <span class="cellname">{f.path}</span>
            <span class="letter {f.change}">{LETTER[f.change]}</span>
          </span>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty">No changes since the last commit.</p>
  {/if}

  {#if git.head}
    <p class="last" title={git.head.hash}>Last commit: {git.head.subject}</p>
  {/if}
{/if}

<style>
  .empty,
  .untracked p {
    margin: 0.5rem 0.25rem;
    color: var(--muted);
    font-size: 0.8125rem;
  }
  .untracked {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }
  .branch-row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-height: 2rem;
  }
  .branch {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding-left: 0.25rem;
    color: var(--ink-2);
    min-width: 0;
  }
  .branch .name {
    font: 500 0.8125rem var(--mono);
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .spacer {
    flex: 1;
  }
  .count {
    font: 0.75rem var(--mono);
    color: var(--ink-2);
  }
  .small {
    font-size: 0.75rem;
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--hair);
    border-radius: 5px;
  }
  .new-branch {
    display: flex;
    gap: 0.375rem;
    margin: 0.375rem 0;
  }
  .new-branch input {
    flex: 1;
    min-width: 0;
    font: 0.8125rem var(--mono);
    height: 1.875rem;
  }
  .commit {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin: 0.625rem 0 1rem;
  }
  textarea {
    font: 0.8125rem/1.45 var(--sans);
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: 6px;
    padding: 0.4rem 0.6rem;
    resize: vertical;
  }
  textarea:focus {
    outline: 2px solid var(--sel);
    border-color: var(--accent);
  }
  .primary {
    height: 2rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--page);
    background: var(--ink);
    border-radius: 6px;
  }
  .primary:hover {
    color: var(--page);
    background: var(--ink-2);
  }
  .primary:disabled {
    color: var(--muted);
    background: var(--hover);
  }
  .section {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 0.25rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--muted);
  }
  .link {
    font-size: 0.72rem;
    color: var(--muted);
    padding: 0.125rem 0.25rem;
  }
  ul {
    list-style: none;
    margin: 0.25rem 0 0;
    padding: 0;
  }
  li {
    display: flex;
    align-items: center;
  }
  .entry {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    min-height: 1.75rem;
    padding: 0 0.375rem;
    text-align: left;
    color: var(--ink-2);
    font: 0.8125rem var(--mono);
  }
  .entry:disabled {
    opacity: 1;
  }
  .entry.file {
    font-family: var(--sans);
    font-size: 0.78rem;
  }
  .cellname {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gone {
    text-decoration: line-through;
    color: var(--muted);
  }
  .letter {
    font: 600 0.7rem var(--mono);
  }
  .letter.modified {
    color: var(--git-letter-modified);
  }
  .letter.added,
  .letter.moved {
    color: var(--git-letter-added);
  }
  .letter.deleted {
    color: var(--git-letter-deleted);
  }
  .undo {
    width: 1.625rem;
    height: 1.625rem;
    opacity: 0;
  }
  li:hover .undo,
  .undo:focus-visible {
    opacity: 1;
  }
  .last {
    margin: 1rem 0.25rem 0;
    font-size: 0.72rem;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
