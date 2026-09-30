<script lang="ts">
  import Select from "../ui/Select.svelte";
  import type { AiLevel, NotebookSummary, WorkspaceSummary } from "../../lib/api";
  import { ago } from "../../lib/format";
  import { can, canConfigure, menu, openHref } from "../../lib/can";
  import { nbHref, viewHref, wsHref } from "../../lib/href";
  import type { AccessTarget } from "../auth/ManageAccess.svelte";
  import Icon from "../Icon.svelte";
  import Menu from "../Menu.svelte";

  // A workspace, as an editor: what it is, what its notebooks share, and its notebooks.
  let {
    w,
    moveable,
    onnew,
    onrename,
    onmove,
    ondelete,
    onaccess,
  }: {
    w: WorkspaceSummary;
    /** there is another workspace to move a notebook to */
    moveable: boolean;
    onnew: () => void;
    onrename: (nb: NotebookSummary) => void;
    onmove: (nb: NotebookSummary) => void;
    ondelete: (nb: NotebookSummary) => void;
    onaccess: (what: AccessTarget) => void;
  } = $props();
  const creates = $derived(can(w, "notebook.create"));
  const settings = $derived(canConfigure(w) ? wsHref(w.name, "settings") : undefined);

  let query = $state("");
  let sort = $state<"edited" | "title">("edited");
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const list = q ? w.notebooks.filter((b) => [b.title, b.name, b.description ?? ""].some((s) => s.toLowerCase().includes(q))) : [...w.notebooks];
    return sort === "title" ? list.sort((a, b) => a.title.localeCompare(b.title)) : list.sort((a, b) => b.modified - a.modified);
  });

  const AI: Record<AiLevel, string> = { off: "Off", read: "Read", run: "Run", edit: "Edit" };
  const memory = (mb: number) => (mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`);
  const sandbox = $derived.by(() => {
    const s = w.sandbox ?? {};
    const size = [s.vcpus && `${s.vcpus} vCPU`, s.memory && memory(s.memory)].filter(Boolean).join(", ");
    const net = s.egress?.length ? `${s.egress.length} destination${s.egress.length === 1 ? "" : "s"}` : "";
    return [size, net].filter(Boolean).join(" · ") || "Default";
  });
  const attributes = $derived(Object.entries(w.attributes ?? {}));

  function contents(b: NotebookSummary): string {
    const parts = [b.sql && `${b.sql} SQL`, b.python && `${b.python} Python`, b.text && `${b.text} text`].filter(Boolean);
    return parts.join(" · ") || "empty";
  }

  let list = $state<HTMLUListElement>();
  function onkeydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select, [role=tree]") || e.metaKey || e.ctrlKey || e.altKey) return;
    const rows = [...(list?.querySelectorAll<HTMLAnchorElement>("a.open") ?? [])];
    const i = rows.indexOf(document.activeElement as HTMLAnchorElement);
    const go = (k: number) => rows[Math.max(0, Math.min(rows.length - 1, k))]?.focus();
    if (e.key === "/") document.getElementById("ws-filter")?.focus();
    else if (e.key === "n" && creates) onnew();
    else if (e.key === "j" || e.key === "ArrowDown") go(i + 1);
    else if (e.key === "k" || e.key === "ArrowUp") go(i < 0 ? 0 : i - 1);
    else return;
    e.preventDefault();
  }
</script>

<svelte:window {onkeydown} />

<div class="page">
  <header class="head">
    <span class="badge"><Icon name="folder-library" size={28} /></span>
    <div class="what">
      <h1>{w.title}</h1>
      <p class="folder"><code>{w.name}/</code>{#if w.description}<span class="desc">{w.description}</span>{/if}</p>
      {#if attributes.length}
        <ul class="attrs" aria-label="Attributes">
          {#each attributes as [k, v] (k)}<li title="Attribute {k}"><Icon name="tag" size={12} /><span class="k">{k}</span><span class="v">{v}</span></li>{/each}
        </ul>
      {/if}
    </div>
    <span class="head-acts">
      {#if can(w, "workspace.manageAccess")}
        <button class="btn" onclick={() => onaccess({ scope: "workspace", target: w.name, title: w.title })}><Icon name="organization" size={14} />Manage access</button>
      {/if}
      {#if settings}<a class="btn" href={settings}><Icon name="settings-gear" size={14} />Settings</a>{/if}
    </span>
  </header>

  <dl class="facts">
    <a href={settings} title="AI clients' default access to its notebooks">
      <dt><Icon name="sparkle" size={14} />AI access</dt>
      <dd>{AI[w.ai]}</dd>
    </a>
    <a href={settings} title="What its notebooks' microVMs get, unless one sets its own">
      <dt><Icon name="vm" size={14} />Sandbox</dt>
      <dd>{sandbox}</dd>
    </a>
    <a href={settings} title="Connections are set in the workspace's settings">
      <dt><Icon name="plug" size={14} />Connections</dt>
      <dd>Its own, and everyone's</dd>
    </a>
  </dl>

  <div class="bar">
    <h2>Notebooks <span class="n">{w.notebooks.length}</span></h2>
    <label class="search">
      <Icon name="search" size={14} />
      <input id="ws-filter" bind:value={query} placeholder="Filter" spellcheck="false" onkeydown={(e) => e.key === "Escape" && ((query = ""), e.currentTarget.blur())} />
      <kbd>/</kbd>
    </label>
    <Select
      bind:value={sort}
      options={[
        { value: "edited" as const, label: "Recently edited" },
        { value: "title" as const, label: "Title" },
      ]}
      label="Sort by"
    />
    {#if creates}<button class="primary" onclick={onnew}><Icon name="add" size={14} />New notebook</button>{/if}
  </div>

  {#if shown.length}
    <ul class="list" bind:this={list}>
      {#each shown as b (b.id)}
        <li>
          <a class="open" href={openHref(b)}>
            <span class="ic" class:bad={!!b.problem}><Icon name={b.problem ? "warning" : "notebook"} size={18} /></span>
            <span class="main">
              <span class="t">{b.title}</span>
              {#if b.problem}<span class="problem">Doesn't load: {b.problem}</span>{:else if b.description}<span class="d">{b.description}</span>{/if}
            </span>
            <span class="c">{contents(b)}</span>
            <span class="e" title={b.modified ? new Date(b.modified).toLocaleString() : ""}>{b.modified ? ago(b.modified) : ""}</span>
          </a>
          <span class="acts">
            <a class="icon" href={nbHref(b.id, true)} title="Open the report" aria-label="Open the report of {b.title}"><Icon name="preview" size={16} /></a>
            <Menu
              title="Notebook"
              items={menu(
                { label: "Open", run: () => (location.hash = openHref(b)) },
                b.published && { label: "Open the published report", run: () => (location.hash = viewHref(b.id)) },
                can(b, "report.view") && { label: "Open the report", run: () => (location.hash = nbHref(b.id, true)) },
                can(b, "notebook.share") && { label: "Share…", run: () => onaccess({ scope: "notebook", target: b.id, title: b.title }) },
                "-",
                can(b, "notebook.edit") && { label: "Rename…", hint: `${b.name}/`, run: () => onrename(b) },
                moveable && can(b, "notebook.delete") && { label: "Move to workspace…", run: () => onmove(b) },
                "-",
                can(b, "notebook.delete") && { label: "Delete…", danger: true, run: () => ondelete(b) },
              )}
            />
          </span>
        </li>
      {/each}
    </ul>
  {:else if query}
    <p class="none">No notebooks match “{query}”.</p>
  {:else}
    <div class="empty">
      <Icon name="notebook" size={32} />
      <p>No notebooks in {w.title} yet.</p>
      <p class="muted">A notebook mixes SQL run by basalt, Python and notes, one file per cell. Its notebooks share this workspace's connections, sandbox and AI access.</p>
      {#if creates}<button class="primary" onclick={onnew}>Create the first one</button>{/if}
    </div>
  {/if}
</div>

<style>
  .page {
    max-width: 60rem;
    margin: 0 auto;
    padding: 2rem 2rem 5rem;
    color: var(--wb-fg);
  }
  .head {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
  }
  .badge {
    display: grid;
    place-items: center;
    width: 3.25rem;
    height: 3.25rem;
    flex: none;
    border-radius: 10px;
    color: var(--wb-accent);
    background: color-mix(in srgb, var(--wb-accent) 12%, transparent);
  }
  .what {
    flex: 1;
    min-width: 0;
  }
  h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .folder {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.625rem;
    margin: 0.125rem 0 0;
    color: var(--wb-fg-muted);
  }
  .folder code {
    font-size: 0.75rem;
    color: var(--wb-fg-dim);
  }
  .attrs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin: 0.625rem 0 0;
    padding: 0;
    list-style: none;
  }
  .attrs li {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    height: 1.375rem;
    padding: 0 0.5rem;
    border-radius: 999px;
    font-size: 0.72rem;
    color: var(--wb-fg-muted);
    border: 1px solid var(--wb-border);
  }
  .attrs .k {
    color: var(--wb-fg-dim);
  }
  .attrs .k::after {
    content: ":";
  }
  .attrs .v {
    color: var(--wb-fg);
  }
  .btn,
  .primary {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    height: 1.75rem;
    padding: 0 0.75rem;
    border-radius: 4px;
    font-size: 0.8125rem;
    white-space: nowrap;
    text-decoration: none;
  }
  .btn {
    color: var(--wb-fg);
    border: 1px solid var(--wb-border);
  }
  .btn:hover {
    background: var(--wb-list-hover);
  }
  .primary {
    color: #fff;
    background: var(--wb-accent);
  }
  .primary:hover {
    color: #fff;
    background: color-mix(in srgb, var(--wb-accent) 85%, #000);
  }
  .facts {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.75rem;
    margin: 1.5rem 0 2rem;
  }
  .facts a {
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--wb-border);
    border-radius: 6px;
    color: inherit;
    text-decoration: none;
  }
  .head-acts {
    display: flex;
    gap: 0.5rem;
    flex: none;
  }
  .facts a:not([href]) {
    cursor: default;
  }
  .facts a[href]:hover {
    border-color: color-mix(in srgb, var(--wb-accent) 60%, var(--wb-border));
  }
  .facts dt {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.72rem;
    color: var(--wb-fg-muted);
  }
  .facts dd {
    margin: 0.125rem 0 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--wb-border);
  }
  h2 {
    margin: 0 auto 0 0;
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .n {
    margin-left: 0.25rem;
    font-weight: 400;
    color: var(--wb-fg-dim);
  }
  .search {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    height: 1.75rem;
    padding: 0 0.375rem;
    color: var(--wb-fg-muted);
    background: var(--wb-input);
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
  }
  .search:focus-within {
    border-color: var(--wb-accent);
  }
  .search input {
    width: 10rem;
    padding: 0;
    border: 0;
    background: none;
    color: var(--wb-fg);
    outline: none;
  }
  .list {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .list li {
    position: relative;
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--wb-border);
  }
  .list li:hover {
    background: var(--wb-list-hover);
  }
  .open {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto 7rem;
    align-items: center;
    gap: 0.75rem;
    flex: 1;
    min-width: 0;
    padding: 0.625rem 0.5rem;
    color: inherit;
    text-decoration: none;
    outline: none;
  }
  .open:focus-visible {
    box-shadow: inset 0 0 0 1px var(--wb-accent);
  }
  .ic {
    display: flex;
    color: var(--wb-accent);
  }
  .ic.bad {
    color: var(--stale);
  }
  .main {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .t {
    font-weight: 500;
  }
  .d,
  .problem {
    font-size: 0.78rem;
    color: var(--wb-fg-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .problem {
    color: var(--stale);
  }
  .c,
  .e {
    font-size: 0.75rem;
    color: var(--wb-fg-muted);
    white-space: nowrap;
  }
  .e {
    text-align: right;
  }
  .acts {
    display: flex;
    align-items: center;
    gap: 1px;
    padding-right: 0.375rem;
    opacity: 0;
  }
  li:hover .acts,
  li:focus-within .acts,
  li:has(:global(:popover-open)) .acts {
    opacity: 1;
  }
  .acts :global(.icon) {
    display: inline-grid;
    place-items: center;
    width: 1.625rem;
    height: 1.625rem;
    color: var(--wb-fg);
    border-radius: 4px;
  }
  .none {
    padding: 1.5rem 0.5rem;
    color: var(--wb-fg-muted);
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 3rem 1rem;
    text-align: center;
    color: var(--wb-fg-muted);
  }
  .empty p {
    margin: 0.25rem 0;
    max-width: 30rem;
  }
  .empty p:first-of-type {
    color: var(--wb-fg);
  }
  .empty .primary {
    margin-top: 0.75rem;
  }
  @media (max-width: 720px) {
    .facts {
      grid-template-columns: 1fr;
    }
    .open {
      grid-template-columns: auto minmax(0, 1fr) auto;
    }
    .c {
      display: none;
    }
  }
</style>
