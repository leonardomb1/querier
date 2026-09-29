<script lang="ts">
  import { api, type NotebookSummary, type WorkspaceSummary } from "../../lib/api";
  import { can, canConfigure, menu, openHref } from "../../lib/can";
  import { nbHref, viewHref, wsHref } from "../../lib/href";
  import { promptDeleteWorkspace, renameNotebook, renameWorkspace, slugify } from "../../lib/notebooks";
  import Icon from "../Icon.svelte";
  import Menu from "../Menu.svelte";
  import type { AccessTarget } from "../auth/ManageAccess.svelte";
  import { session } from "../../lib/session.svelte";
  import { notifyError } from "../../lib/dialog.svelte";

  // The side bar at home, as VS Code's explorer: workspaces, their notebooks under
  // them. New ones and renames are typed in place; a notebook dragged onto another
  // workspace moves there.
  let {
    spaces,
    current,
    onchanged,
    onmove,
    ondelete,
    onaccess,
  }: {
    spaces: WorkspaceSummary[];
    /** the workspace open in the editor */
    current: string | null;
    onchanged: () => Promise<void>;
    /** "Move to…": pick a workspace for it */
    onmove: (nb: NotebookSummary) => void;
    ondelete: (nb: NotebookSummary) => void;
    /** "Manage access…", "Share…" */
    onaccess: (what: AccessTarget) => void;
  } = $props();

  // which workspaces are open, remembered in this browser
  let open = $state<Record<string, boolean>>({});
  try {
    open = JSON.parse(localStorage.getItem("querier:home-tree") ?? "{}");
  } catch {}
  const isOpen = (ws: string) => open[ws] ?? (ws === current || spaces.length <= 3);
  function setOpen(ws: string, v: boolean) {
    open[ws] = v;
    try {
      localStorage.setItem("querier:home-tree", JSON.stringify(open));
    } catch {}
  }
  // the workspace you are in shows its notebooks
  $effect(() => {
    if (current && open[current] === false) setOpen(current, true);
  });

  let filter = $state("");
  const q = $derived(filter.trim().toLowerCase());
  const match = (b: NotebookSummary) => !q || [b.title, b.name, b.description ?? ""].some((s) => s.toLowerCase().includes(q));
  const shown = $derived(
    spaces
      .map((w) => ({ w, books: w.notebooks.filter(match) }))
      .filter(({ w, books }) => !q || books.length || w.title.toLowerCase().includes(q) || w.name.includes(q)),
  );

  // -- typing in place: a new workspace or notebook, or a new folder name
  type Edit = { kind: "new-ws" } | { kind: "new-nb"; ws: string } | { kind: "rename-ws"; ws: string } | { kind: "rename-nb"; id: string };
  let edit = $state<Edit | null>(null);
  let text = $state("");
  let error = $state("");
  let busy = false;
  const slug = $derived(slugify(text));

  // what they may do: the rest isn't offered
  const creatable = $derived(spaces.filter((x) => can(x, "notebook.create")));
  const canMove = (b: NotebookSummary) => can(b, "notebook.delete") && creatable.some((x) => x.name !== b.workspace);
  const canRename = (b: NotebookSummary) => can(b, "notebook.edit");

  /** Type a new notebook's title in `ws` (or the first workspace they may add to), or (null) a new workspace's name. */
  export function startNew(ws: string | null) {
    error = "";
    text = "";
    if (ws == null) return void (session.can("workspace.create") && (edit = { kind: "new-ws" }));
    if (!creatable.some((x) => x.name === ws)) ws = creatable[0]?.name ?? null;
    if (ws == null) return;
    setOpen(ws, true);
    edit = { kind: "new-nb", ws };
  }
  /** Type a new folder name for a notebook, by id, in place. */
  export function renameNb(id: string) {
    const b = spaces.flatMap((x) => x.notebooks).find((x) => x.id === id);
    if (!b || !canRename(b)) return;
    setOpen(id.split("/")[0], true);
    startRename({ kind: "rename-nb", id }, id.split("/")[1]);
  }
  function startRename(e: Edit & { kind: "rename-ws" | "rename-nb" }, name: string) {
    error = "";
    text = name;
    edit = e;
  }
  function cancel() {
    edit = null;
    error = "";
  }

  async function commit() {
    const e = edit;
    if (!e || busy) return;
    if (!slug) return cancel();
    busy = true;
    error = "";
    try {
      if (e.kind === "new-ws") {
        const { name } = await api.workspace.create(slug, text.trim());
        await onchanged();
        location.hash = wsHref(name);
      } else if (e.kind === "new-nb") {
        const { id } = await api.create(e.ws, slug, text.trim());
        location.hash = nbHref(id);
      } else if (e.kind === "rename-ws") {
        if (slug !== e.ws) {
          const w = spaces.find((x) => x.name === e.ws)!;
          const name = await renameWorkspace(e.ws, slug, w.notebooks.map((b) => b.id));
          setOpen(name, isOpen(e.ws));
          // the page moves first (it reloads the list); else only the list changes
          if (current === e.ws) location.hash = wsHref(name);
          else await onchanged();
        }
      } else {
        const [ws, name] = e.id.split("/");
        if (slug !== name) {
          await renameNotebook(e.id, slug, ws);
          await onchanged();
        }
      }
      edit = null;
    } catch (err: any) {
      error = err.message;
    }
    busy = false;
  }

  // -- a notebook dragged onto a workspace moves there
  const DND = "application/x-querier-notebook";
  let dropTarget = $state<string | null>(null);
  function dragStart(e: DragEvent, b: NotebookSummary) {
    e.dataTransfer!.setData(DND, b.id);
    e.dataTransfer!.setData("text/plain", b.id);
    e.dataTransfer!.effectAllowed = "move";
  }
  function dragOver(e: DragEvent, ws: string) {
    if (!e.dataTransfer?.types.includes(DND) || !creatable.some((x) => x.name === ws)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    dropTarget = ws;
  }
  async function drop(e: DragEvent, ws: string) {
    const id = e.dataTransfer?.getData(DND);
    dropTarget = null;
    if (!id) return;
    e.preventDefault();
    const [from, name] = id.split("/");
    if (from === ws || !creatable.some((x) => x.name === ws)) return;
    try {
      await renameNotebook(id, name, ws);
      setOpen(ws, true);
      await onchanged();
    } catch (err) {
      await notifyError("Couldn't move the notebook", err);
    }
  }

  // -- arrows move through the rows; left and right fold and unfold
  let tree = $state<HTMLDivElement>();
  function onkeydown(e: KeyboardEvent) {
    const rows = [...tree!.querySelectorAll<HTMLElement>("[data-row]")];
    const i = rows.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const row = rows[i];
    const ws = row.dataset.ws;
    if (e.key === "ArrowDown") rows[Math.min(rows.length - 1, i + 1)].focus();
    else if (e.key === "ArrowUp") rows[Math.max(0, i - 1)].focus();
    else if (e.key === "ArrowRight" && ws && row.dataset.kind === "ws") setOpen(ws, true);
    else if (e.key === "ArrowLeft" && ws) {
      if (row.dataset.kind === "ws") setOpen(ws, false);
      else rows.find((r) => r.dataset.kind === "ws" && r.dataset.ws === ws)?.focus();
    } else if (e.key === "F2" && ws) {
      if (row.dataset.kind === "ws") can(spaces.find((x) => x.name === ws), "workspace.manage") && startRename({ kind: "rename-ws", ws }, ws);
      else renameNb(row.dataset.id!);
    } else return;
    e.preventDefault();
  }

  const collapseAll = () => spaces.forEach((w) => setOpen(w.name, false));
  const focusInput = (el: HTMLInputElement) => {
    el.focus();
    el.select();
  };
</script>

{#snippet input(label: string, indent: number, icon: string)}
  <div class="row editing" style:--indent={indent}>
    <span class="ic"><Icon name={icon} size={16} /></span>
    <input
      use:focusInput
      bind:value={text}
      aria-label={label}
      placeholder={label}
      spellcheck="false"
      class:bad={!!error}
      onkeydown={(e) => {
        if (e.key === "Enter") (e.preventDefault(), commit());
        if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), cancel());
      }}
      onblur={() => !busy && (text.trim() && !error ? commit() : cancel())}
    />
  </div>
  {#if error}
    <p class="msg bad" style:--indent={indent}>{error}</p>
  {:else if slug && slug !== text.trim()}
    <p class="msg" style:--indent={indent}>Folder: <code>{slug}</code></p>
  {/if}
{/snippet}

<div class="view">
  <header class="title">
    <span>Workspaces</span>
    <span class="tools">
      {#if creatable.length}
        <button class="icon" title="New notebook" aria-label="New notebook" onclick={() => startNew(current ?? creatable[0].name)}>
          <Icon name="new-file" size={16} />
        </button>
      {/if}
      {#if session.can("workspace.create")}
        <button class="icon" title="New workspace" aria-label="New workspace" onclick={() => startNew(null)}><Icon name="new-folder" size={16} /></button>
      {/if}
      <button class="icon" title="Collapse all" aria-label="Collapse all" onclick={collapseAll}><Icon name="collapse-all" size={16} /></button>
    </span>
  </header>
  <div class="filter">
    <Icon name="filter" size={14} />
    <input bind:value={filter} placeholder="Filter notebooks" spellcheck="false" onkeydown={(e) => e.key === "Escape" && (filter = "")} />
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="tree" role="tree" tabindex="-1" aria-label="Workspaces" bind:this={tree} {onkeydown}>
    {#if edit?.kind === "new-ws"}{@render input("Workspace name", 0, "folder-library")}{/if}

    {#each shown as { w, books } (w.name)}
      {@const expanded = !!q || isOpen(w.name)}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="row ws"
        class:active={current === w.name}
        class:drop={dropTarget === w.name}
        style:--indent={0}
        ondragover={(e) => dragOver(e, w.name)}
        ondragleave={() => dropTarget === w.name && (dropTarget = null)}
        ondrop={(e) => drop(e, w.name)}
      >
        {#if edit?.kind === "rename-ws" && edit.ws === w.name}
          <span class="twist"></span>
          <span class="ic"><Icon name="folder-library" size={16} /></span>
          <input
            use:focusInput
            bind:value={text}
            aria-label="New folder name for {w.title}"
            spellcheck="false"
            class:bad={!!error}
            onkeydown={(e) => {
              if (e.key === "Enter") (e.preventDefault(), commit());
              if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), cancel());
            }}
            onblur={() => !busy && cancel()}
          />
        {:else}
          <button class="twist" aria-label={expanded ? "Collapse" : "Expand"} tabindex="-1" onclick={() => setOpen(w.name, !expanded)}>
            <span class="chev" class:open={expanded}><Icon name="chevron-right" size={16} /></span>
          </button>
          <a
            class="label"
            href={wsHref(w.name)}
            data-row
            data-kind="ws"
            data-ws={w.name}
            role="treeitem"
            aria-selected={current === w.name}
            aria-expanded={expanded}
            title={w.description || w.title}
            onclick={() => setOpen(w.name, true)}
          >
            <span class="ic" style:color="var(--wb-accent)"><Icon name={expanded ? "folder-opened" : "folder-library"} size={16} /></span>
            <span class="name">{w.title}</span>
            {#if slugify(w.title) !== w.name}<span class="hint">{w.name}</span>{/if}
          </a>
          <span class="inline">
            {#if can(w, "notebook.create")}
              <button class="icon" title="New notebook in {w.title}" aria-label="New notebook in {w.title}" onclick={() => startNew(w.name)}><Icon name="add" size={16} /></button>
            {/if}
            {#if canConfigure(w)}
              <a class="icon" href={wsHref(w.name, "settings")} title="Settings of {w.title}" aria-label="Settings of {w.title}"><Icon name="settings-gear" size={16} /></a>
            {/if}
            <Menu
              title="Workspace"
              items={menu(
                { label: "Open", run: () => (location.hash = wsHref(w.name)) },
                canConfigure(w) && { label: "Settings", run: () => (location.hash = wsHref(w.name, "settings")) },
                can(w, "workspace.manageAccess") && { label: "Manage access…", run: () => onaccess({ scope: "workspace", target: w.name, title: w.title }) },
                can(w, "notebook.create") && { label: "New notebook", run: () => startNew(w.name) },
                "-",
                can(w, "workspace.manage") && { label: "Rename…", hint: "F2", run: () => startRename({ kind: "rename-ws", ws: w.name }, w.name) },
                can(w, "workspace.manage") && {
                  label: "Delete…",
                  danger: true,
                  run: () => promptDeleteWorkspace(w.name, w.title, w.notebooks.map((b) => b.id)).then((ok) => void (ok && onchanged())),
                },
              )}
            />
          </span>
          <span class="count">{w.notebooks.length}</span>
        {/if}
      </div>
      {#if edit?.kind === "rename-ws" && edit.ws === w.name && error}<p class="msg bad" style:--indent={0}>{error}</p>{/if}

      {#if expanded}
        {#if edit?.kind === "new-nb" && edit.ws === w.name}{@render input("Notebook title", 1, "notebook")}{/if}
        {#each books as b (b.id)}
          {#if edit?.kind === "rename-nb" && edit.id === b.id}
            {@render input(`New folder name for ${b.title}`, 1, "notebook")}
          {:else}
            <div class="row nb" style:--indent={1} draggable={canMove(b)} ondragstart={(e) => canMove(b) && dragStart(e, b)} role="none">
              <a class="label" href={openHref(b)} data-row data-kind="nb" data-ws={w.name} data-id={b.id} role="treeitem" aria-selected="false" title={b.description || b.title}>
                <span class="ic" class:bad={!!b.problem}><Icon name={b.problem ? "warning" : "notebook"} size={16} /></span>
                <span class="name">{b.title}</span>
              </a>
              <span class="inline">
                <a class="icon" href={nbHref(b.id, true)} title="Open the report" aria-label="Open the report of {b.title}"><Icon name="preview" size={16} /></a>
                <Menu
                  title="Notebook"
                  items={menu(
                    { label: "Open", run: () => (location.hash = openHref(b)) },
                    b.published && { label: "Open the published report", run: () => (location.hash = viewHref(b.id)) },
                    can(b, "report.view") && { label: "Open the report", run: () => (location.hash = nbHref(b.id, true)) },
                    can(b, "notebook.share") && { label: "Share…", run: () => onaccess({ scope: "notebook", target: b.id, title: b.title }) },
                    "-",
                    canRename(b) && { label: "Rename…", hint: "F2", run: () => startRename({ kind: "rename-nb", id: b.id }, b.name) },
                    canMove(b) && { label: "Move to workspace…", run: () => onmove(b) },
                    "-",
                    can(b, "notebook.delete") && { label: "Delete…", danger: true, run: () => ondelete(b) },
                  )}
                />
              </span>
            </div>
          {/if}
        {/each}
        {#if !books.length && can(w, "notebook.create") && !(edit?.kind === "new-nb" && edit.ws === w.name)}
          <button class="row empty" style:--indent={1} onclick={() => startNew(w.name)}>
            <span class="ic"><Icon name="add" size={14} /></span><span class="name">New notebook</span>
          </button>
        {/if}
      {/if}
    {/each}

    {#if q && !shown.length}<p class="msg">Nothing matches “{filter}”.</p>{/if}
  </div>
</div>

<style>
  .view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    font-size: 0.8125rem;
  }
  .title {
    display: flex;
    align-items: center;
    height: 2.1875rem;
    padding: 0 0.5rem 0 1.25rem;
    font-size: 0.6875rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--wb-fg-muted);
    flex: none;
  }
  .tools {
    margin-left: auto;
    display: flex;
    gap: 1px;
  }
  .tools .icon {
    width: 1.375rem;
    height: 1.375rem;
    color: var(--wb-fg);
  }
  .filter {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0 0.75rem 0.375rem 1.25rem;
    padding: 0 0.375rem;
    height: 1.625rem;
    color: var(--wb-fg-muted);
    background: var(--wb-input);
    border: 1px solid var(--wb-input-border);
    border-radius: 2px;
    flex: none;
  }
  .filter:focus-within {
    border-color: var(--wb-accent);
  }
  .filter input {
    flex: 1;
    min-width: 0;
    padding: 0;
    border: 0;
    background: none;
    color: var(--wb-fg);
    font-size: 0.8125rem;
    outline: none;
  }
  .tree {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-bottom: 1rem;
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    width: 100%;
    height: 1.375rem;
    padding: 0 0.5rem 0 calc(0.5rem + var(--indent) * 1.25rem);
    color: var(--wb-fg);
    border-radius: 0;
  }
  .row:hover {
    background: var(--wb-list-hover);
  }
  .row.active {
    background: var(--wb-list-active);
  }
  .row:focus-within {
    outline: 1px solid var(--wb-accent);
    outline-offset: -1px;
  }
  .row.drop {
    background: color-mix(in srgb, var(--wb-accent) 22%, transparent);
    outline: 1px dashed var(--wb-accent);
    outline-offset: -1px;
  }
  .row.nb {
    padding-left: calc(1.5rem + var(--indent) * 1.25rem);
  }
  .row.nb[draggable="true"] {
    cursor: grab;
  }
  .twist {
    display: grid;
    place-items: center;
    width: 1rem;
    height: 1rem;
    padding: 0;
    flex: none;
    color: var(--wb-fg);
  }
  .twist:hover {
    background: none;
  }
  .chev {
    display: flex;
    transition: transform 0.1s;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .label {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex: 1;
    min-width: 0;
    height: 100%;
    color: inherit;
    text-decoration: none;
    outline: none;
  }
  .ic {
    display: flex;
    flex: none;
    color: var(--wb-fg-muted);
  }
  .ic.bad {
    color: var(--stale);
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint {
    font-size: 0.72rem;
    color: var(--wb-fg-dim);
    white-space: nowrap;
  }
  .count {
    min-width: 1.125rem;
    padding: 0 0.3rem;
    border-radius: 999px;
    font-size: 0.68rem;
    line-height: 1rem;
    text-align: center;
    color: var(--wb-fg-muted);
    background: color-mix(in srgb, var(--wb-fg) 10%, transparent);
  }
  .inline {
    display: none;
    align-items: center;
    gap: 1px;
  }
  .row:hover .inline,
  .row:focus-within .inline {
    display: flex;
  }
  .row:hover .count,
  .row:focus-within .count {
    display: none;
  }
  .inline :global(.icon) {
    display: inline-grid;
    place-items: center;
    width: 1.375rem;
    height: 1.375rem;
    padding: 0;
    color: var(--wb-fg);
    border-radius: 4px;
  }
  .inline :global(.icon:hover) {
    background: color-mix(in srgb, var(--wb-fg) 12%, transparent);
  }
  .row.editing {
    padding-left: calc(1.5rem + var(--indent) * 1.25rem);
  }
  .row input {
    flex: 1;
    min-width: 0;
    height: 1.25rem;
    padding: 0 0.25rem;
    font-size: 0.8125rem;
    color: var(--wb-fg);
    background: var(--wb-input);
    border: 1px solid var(--wb-accent);
    border-radius: 0;
    outline: none;
  }
  .row input.bad {
    border-color: var(--critical);
  }
  .row.empty {
    padding-left: calc(1.5rem + var(--indent) * 1.25rem);
    color: var(--wb-fg-dim);
    text-align: left;
  }
  .row.empty:hover {
    color: var(--wb-fg);
  }
  .msg {
    margin: 0.125rem 0.75rem 0.25rem calc(1.5rem + var(--indent, 0) * 1.25rem);
    font-size: 0.72rem;
    color: var(--wb-fg-muted);
  }
  .msg.bad {
    padding: 0.25rem 0.375rem;
    color: var(--wb-fg);
    background: color-mix(in srgb, var(--critical) 18%, transparent);
    border: 1px solid var(--critical);
  }
  .msg code {
    font-size: 0.72rem;
  }
</style>
