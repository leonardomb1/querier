<script lang="ts">
  import { onMount } from "svelte";
  import type { NotebookSummary, WorkspaceIndex } from "../../lib/api";
  import { api } from "../../lib/api";
  import { adminHref, homeHref, nbHref, wsHref, type AdminSection } from "../../lib/href";
  import { confirmDeleteNotebook, deleteNotebook, renameNotebook } from "../../lib/notebooks";
  import { notifyError } from "../../lib/dialog.svelte";
  import { sidebar } from "../../lib/sidebar.svelte";
  import { zoom } from "../../lib/zoom.svelte";
  import Help from "../Help.svelte";
  import Icon from "../Icon.svelte";
  import Palette, { type Entry } from "../Palette.svelte";
  import ActivityBar from "../wb/ActivityBar.svelte";
  import TitleBar from "../wb/TitleBar.svelte";
  import Welcome from "./Welcome.svelte";
  import WorkspaceOverview from "./WorkspaceOverview.svelte";
  import SettingsEditor from "../settings/SettingsEditor.svelte";
  import UserScope, { USER_TOC } from "../settings/UserScope.svelte";
  import WorkspaceScope, { workspaceToc } from "../settings/WorkspaceScope.svelte";
  import WorkspaceTree from "./WorkspaceTree.svelte";
  import AdminConsole from "../admin/AdminConsole.svelte";
  import ManageAccess, { type AccessTarget } from "../auth/ManageAccess.svelte";
  import { can, canConfigure } from "../../lib/can";
  import { session } from "../../lib/session.svelte";

  // Home, in the same workbench as a notebook: the workspaces in the side bar,
  // the open one (its notebooks, or its settings) in the editor, the palette on
  // Ctrl+K. Going into a notebook keeps the title, activity and status bars.
  let {
    index,
    ws,
    tab,
    section = "policies",
    query = {},
  }: { index: WorkspaceIndex; ws: string | null; tab: "overview" | "settings" | "admin"; section?: AdminSection; query?: Record<string, string> } = $props();
  const mayAdmin = $derived(session.can("admin.manage"));
  const SECTION_LABEL: Record<AdminSection, string> = { policies: "Policies", explain: "Explain a decision", people: "People", audit: "Audit log", signin: "Sign-in" };

  // what the router loaded; changes here refetch it without a navigation
  let spaces = $derived(index.workspaces);
  async function refresh() {
    try {
      spaces = (await api.workspaces()).workspaces;
    } catch {}
  }
  const w = $derived(ws == null ? null : (spaces.find((x) => x.name === ws) ?? null));
  const total = $derived(spaces.reduce((n, x) => n + x.notebooks.length, 0));

  // the side bar: shown or not here, remembered in this browser; its width is the app's (sidebar.svelte.ts)
  let side = $state(true);
  try {
    const s = JSON.parse(localStorage.getItem("querier:home") ?? "{}");
    if (s.side != null) side = s.side;
  } catch {}
  const save = () => {
    try {
      localStorage.setItem("querier:home", JSON.stringify({ side }));
    } catch {}
  };
  let dragging = $state(false);
  function drag(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    const move = (ev: PointerEvent) => sidebar.set(ev.clientX - 48);
    const up = () => {
      dragging = false;
      sidebar.save();
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  }

  let tree = $state<ReturnType<typeof WorkspaceTree>>();
  let palette = $state(false);
  let help = $state(false);
  // the settings editor: which scope, and a group of it to bring into view
  let settingsScope = $state<"user" | "workspace">("workspace");
  let settingsReveal = $state<string | null>(null);
  /** Open the Settings tab: the open workspace's (or the first one's), at `scope`. */
  function openSettings(scope: "user" | "workspace" = "workspace", section: string | null = null) {
    // the user's own settings open under any workspace; a workspace's, under one they may configure
    const target = scope === "user" ? (ws ?? spaces[0]?.name) : (ws && canConfigure(w) ? ws : spaces.find(canConfigure)?.name);
    if (!target) return;
    settingsScope = scope;
    settingsReveal = section;
    location.hash = wsHref(target, "settings");
  }
  /** a notebook being moved: the quick pick of workspaces is open */
  let moving = $state<NotebookSummary | null>(null);
  /** the Manage access / Share dialog */
  let managing = $state<AccessTarget | null>(null);
  const manage = (t: AccessTarget) => {
    const x = t.scope === "workspace" ? spaces.find((y) => y.name === t.target) : spaces.flatMap((y) => y.notebooks).find((b) => b.id === t.target);
    // the dialog needs to know whether they may give Admin: the workspace's permissions
    const wsOf = spaces.find((y) => y.name === (t.scope === "workspace" ? t.target : t.target.split("/")[0]));
    managing = { ...t, permissions: t.scope === "workspace" ? wsOf?.permissions : x?.permissions };
  };

  /** New things are typed in the side bar, as a new file in VS Code's explorer. */
  function showTree(then: () => void) {
    if (!side) {
      side = true;
      save();
    }
    queueMicrotask(then);
  }
  const newNotebook = (in_: string | null = ws) => showTree(() => tree?.startNew(in_ ?? spaces[0]?.name ?? null));
  const newWorkspace = () => showTree(() => tree?.startNew(null));
  const rename = (b: NotebookSummary) => showTree(() => tree?.renameNb(b.id));

  async function remove(b: NotebookSummary) {
    if (!(await confirmDeleteNotebook(b.id, b.title))) return;
    try {
      await deleteNotebook(b.id);
      await refresh();
    } catch (e) {
      await notifyError("Couldn't delete the notebook", e);
    }
  }
  const moveTargets = $derived.by<Entry[]>(() => {
    const m = moving; // the palette closes (moving = null) before an entry runs
    return m
      ? spaces
          .filter((x) => x.name !== m.workspace && can(x, "notebook.create"))
          .map((x) => ({
            group: "move to",
            label: x.title,
            hint: `${x.name}/${m.name}`,
            run: async () => {
              try {
                await renameNotebook(m.id, m.name, x.name);
                await refresh();
              } catch (e) {
                await notifyError("Couldn't move the notebook", e);
              }
            },
          }))
      : [];
  });

  const creatable = $derived(spaces.some((x) => can(x, "notebook.create")));
  const extra = $derived<Entry[]>([
    ...(creatable ? [{ group: "workspace", label: "New Notebook…", keys: "n", icon: "new-file", run: () => newNotebook() }] : []),
    ...(session.can("workspace.create") ? [{ group: "workspace", label: "New Workspace…", icon: "new-folder", run: newWorkspace }] : []),
    ...(w && can(w, "workspace.manageAccess") ? [{ group: "workspace", label: "Manage Access…", icon: "organization", run: () => manage({ scope: "workspace", target: w.name, title: w.title }) }] : []),
    { group: "preferences", label: "Open Settings", keys: "ctrl+,", run: () => openSettings() },
    { group: "preferences", label: "Open User Settings", run: () => openSettings("user") },
    { group: "preferences", label: "AI Clients (MCP)", icon: "plug", run: () => openSettings("user", "clients") },
    ...(mayAdmin
      ? (Object.entries(SECTION_LABEL) as [AdminSection, string][]).map(([id, label]) => ({ group: "administration", label: `Administration: ${label}`, icon: "shield", run: () => (location.hash = adminHref(id)) }))
      : []),
    { group: "view", label: "Toggle Side Bar", keys: "ctrl+b", icon: "layout-sidebar-left", run: () => ((side = !side), save()) },
  ]);

  function onkeydown(e: KeyboardEvent) {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    const act = (fn: () => void) => (e.preventDefault(), e.stopPropagation(), fn());
    if (k === "k" || (e.shiftKey && k === "p")) return act(() => (palette = !palette));
    if (!e.shiftKey && k === "b") return act(() => ((side = !side), save()));
    if (e.key === ",") return act(() => openSettings());
    if (e.shiftKey && k === "e") return act(() => showTree(() => document.querySelector<HTMLElement>(".sidebar [data-row]")?.focus()));
  }

  onMount(() => {
    document.documentElement.classList.add("workbench");
    return () => document.documentElement.classList.remove("workbench");
  });

  // -- the editor's tabs, as VS Code's: a page you open is added (after the active
  // one), a tab closes on its ×; the tabs are remembered in this browser
  type TabKey = string; // "welcome" | "ws:<name>" | "settings:<name>"
  const keyOf = (ws: string | null, t: "overview" | "settings" | "admin"): TabKey =>
    t === "admin" ? "admin" : ws == null ? "welcome" : `${t === "settings" ? "settings" : "ws"}:${ws}`;
  const current = $derived(keyOf(ws, tab));
  let open = $state<TabKey[]>([]);
  try {
    open = JSON.parse(localStorage.getItem("querier:home-tabs") ?? "[]");
  } catch {}
  const saveTabs = () => {
    try {
      localStorage.setItem("querier:home-tabs", JSON.stringify(open));
    } catch {}
  };
  let lastActive: TabKey | null = null;
  $effect(() => {
    const k = current;
    // only when the page changes: a closed tab's page is still up until the next one loads
    if (k !== lastActive && !open.includes(k)) {
      const at = lastActive ? open.indexOf(lastActive) : -1;
      open.splice(at < 0 ? open.length : at + 1, 0, k);
      saveTabs();
    }
    lastActive = k;
  });
  // a workspace renamed or deleted takes its tabs with it
  $effect(() => {
    const names = new Set(spaces.map((x) => x.name));
    const kept = open.filter((k) => k === "welcome" || (k === "admin" && mayAdmin) || names.has(k.slice(k.indexOf(":") + 1)));
    if (kept.length !== open.length) {
      open = kept;
      saveTabs();
    }
  });
  function describe(k: TabKey) {
    if (k === "welcome") return { icon: "home", label: "Welcome", title: "Welcome", href: homeHref() };
    if (k === "admin") return { icon: "shield", label: "Administration", title: "Policies, decisions, people, the audit log", href: adminHref(lastSection) };
    const [kind, name] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
    const x = spaces.find((y) => y.name === name);
    return kind === "settings"
      ? { icon: "settings-gear", label: `Settings: ${x?.title ?? name}`, title: `${x?.title ?? name}: workspace settings`, href: wsHref(name, "settings") }
      : { icon: "folder-library", label: x?.title ?? name, title: `${x?.title ?? name}: its notebooks`, href: wsHref(name) };
  }
  // the Administration tab goes back to the section last open
  let lastSection = $state<AdminSection>("policies");
  $effect(() => {
    if (tab === "admin") lastSection = section;
  });
  const tabs = $derived(open.map((k) => ({ key: k, ...describe(k) })));
  /** Close a tab; the active one gives way to its neighbour (the Welcome page if it was the last). */
  function closeTab(k: TabKey) {
    const i = open.indexOf(k);
    if (i < 0) return;
    open.splice(i, 1);
    saveTabs();
    if (k !== current) return;
    const next = open[Math.min(i, open.length - 1)];
    location.hash = next ? describe(next).href : homeHref();
  }
</script>

<!-- in the capture phase: before an editor (Monaco) takes the keys it also binds, as Ctrl+K -->
<svelte:window onkeydowncapture={onkeydown} />

<div class="workbench" class:dragging style:--side="{sidebar.width}px">
  <TitleBar
    crumbs={tab === "admin" ? [{ label: "Administration", href: adminHref() }, { label: SECTION_LABEL[section] }] : w ? [{ label: w.title, href: tab === "settings" ? wsHref(w.name) : undefined, title: `${w.name}/` }, ...(tab === "settings" ? [{ label: "Settings" }] : [])] : []}
    center={w ? w.title : "Search notebooks and workspaces"}
    oncenter={() => (palette = true)}
  >
    <button class="icon" class:on={side} title="Toggle the side bar  (Ctrl+B)" aria-label="Toggle the side bar" onclick={() => ((side = !side), save())}>
      <Icon name={side ? "layout-sidebar-left" : "layout-sidebar-left-off"} size={16} />
    </button>
  </TitleBar>

  <div class="main">
    <ActivityBar
      views={[{ id: "workspaces", icon: "folder-library", title: "Workspaces  (Ctrl+Shift+E)" }]}
      active={side ? "workspaces" : null}
      onpick={() => ((side = !side), save())}
      menu={[
        { label: "Command Palette…", hint: "Ctrl+K", run: () => (palette = true) },
        "-",
        { label: "Settings", hint: "Ctrl+,", run: () => openSettings() },
        { label: "Keyboard Shortcuts", hint: "?", run: () => (help = true) },
        "-",
        { label: "AI Clients (MCP)", run: () => openSettings("user", "clients") },
        ...(mayAdmin ? ["-" as const, { label: "Administration", run: () => (location.hash = adminHref()) }] : []),
      ]}
    />
    {#if side}
      <aside class="sidebar" style:view-transition-name="wb-side">
        <WorkspaceTree bind:this={tree} {spaces} current={ws} onchanged={refresh} onmove={(b) => (moving = b)} ondelete={remove} onaccess={manage} />
      </aside>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="sash" onpointerdown={drag} ondblclick={() => sidebar.reset()}></div>
    {/if}

    <div class="editor">
      <div class="tabbar" role="tablist">
        {#each tabs as t (t.key)}
          <!-- a middle click closes, as in VS Code -->
          <a
            class="tab"
            class:active={current === t.key}
            role="tab"
            aria-selected={current === t.key}
            href={t.href}
            title={t.title}
            onauxclick={(e) => e.button === 1 && (e.preventDefault(), closeTab(t.key))}
          >
            <span class="ticon"><Icon name={t.icon} size={15} /></span>
            <span class="label">{t.label}</span>
            {#if !(tabs.length === 1 && t.key === "welcome")}
              <button
                class="close"
                title="Close"
                aria-label="Close {t.label}"
                onclick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  closeTab(t.key);
                }}><Icon name="close" size={14} /></button
              >
            {/if}
          </a>
        {/each}
      </div>
      <div class="content">
        {#if tab === "admin" && mayAdmin}
          <AdminConsole {section} {query} />
        {:else if tab === "admin"}
          <p class="no-admin">Administration is for the system administrator, and whoever a policy gives <code>admin.manage</code>.</p>
        {:else if !w}
          <Welcome
            {spaces}
            root={index.root}
            onnewworkspace={session.can("workspace.create") ? newWorkspace : undefined}
            onnewnotebook={creatable ? () => newNotebook() : undefined}
            onpalette={() => (palette = true)}
            onai={() => openSettings("user", "clients")}
          />
        {:else if tab === "settings"}
          <SettingsEditor
            scopes={[{ id: "user", label: "User" }, ...(canConfigure(w) ? [{ id: "workspace", label: "Workspace", hint: w.title }] : [])]}
            scope={canConfigure(w) ? settingsScope : "user"}
            onscope={(id) => ((settingsScope = id as "user" | "workspace"), (settingsReveal = null))}
            toc={settingsScope === "user" || !canConfigure(w) ? USER_TOC : workspaceToc(w)}
            reveal={settingsReveal}
          >
            {#if settingsScope === "user" || !canConfigure(w)}
              <UserScope />
            {:else}
              {#key w.name}<WorkspaceScope {w} onchanged={refresh} renamed={(name) => (location.hash = wsHref(name, "settings"))} />{/key}
            {/if}
          </SettingsEditor>
        {:else}
          <WorkspaceOverview
            {w}
            moveable={spaces.some((x) => x.name !== w.name && can(x, "notebook.create"))}
            onnew={() => newNotebook(w.name)}
            onrename={rename}
            onmove={(b) => (moving = b)}
            ondelete={remove}
            onaccess={manage}
          />
        {/if}
      </div>
    </div>
  </div>

  <footer class="status" style:view-transition-name="wb-status">
    <div class="left">
      <span title={index.root}><Icon name="folder-library" size={14} />{spaces.length} workspace{spaces.length === 1 ? "" : "s"} · {total} notebook{total === 1 ? "" : "s"}</span>
      {#if w}
        <a href={wsHref(w.name, "settings")} title="AI clients' default access in {w.title}"><Icon name="sparkle" size={14} />AI: {w.ai}</a>
      {/if}
    </div>
    <div class="right">
      <button title="Zoom: Ctrl+= / Ctrl+- (click to reset)" onclick={zoom.reset}>{Math.round(zoom.value * 100)}%</button>
    </div>
  </footer>
</div>

{#if palette}<Palette {extra} onclose={() => (palette = false)} placeholder="Open a notebook or a workspace, or run a command…" />{/if}
{#if moving}
  <Palette extra={moveTargets} only placeholder="Move “{moving.title}” to which workspace?" onclose={() => (moving = null)} />
{/if}
{#if help}<Help onclose={() => (help = false)} />{/if}
{#if managing}<ManageAccess what={managing} onclose={() => ((managing = null), refresh())} />{/if}

<style>
  :global(html.workbench),
  :global(html.workbench body) {
    height: 100%;
    overflow: hidden;
  }
  .workbench {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    height: 100vh;
    height: 100dvh;
    color: var(--wb-fg);
    background: var(--wb-editor);
  }
  .workbench.dragging {
    user-select: none;
  }
  .main {
    display: flex;
    min-height: 0;
  }
  .sidebar {
    width: var(--side);
    flex: none;
    min-width: 0;
    background: var(--wb-side);
    overflow: hidden;
  }
  .sash {
    position: relative;
    z-index: 2;
    flex: none;
    width: 1px;
    background: var(--wb-border);
    cursor: col-resize;
    transition: background-color 0.1s 0.15s;
  }
  .sash::after {
    content: "";
    position: absolute;
    inset: 0 -2px;
  }
  .sash:hover,
  .dragging .sash {
    background: var(--wb-accent);
  }
  .editor {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .tabbar {
    display: flex;
    flex: none;
    height: 2.1875rem;
    background: var(--wb-tab);
    border-bottom: 1px solid var(--wb-border);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tab {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex: none;
    max-width: 16rem;
    padding: 0 0.375rem 0 0.625rem;
    font-size: 0.8125rem;
    color: var(--wb-fg-muted);
    background: var(--wb-tab);
    border-right: 1px solid var(--wb-border);
    text-decoration: none;
    user-select: none;
  }
  .tab.active {
    color: var(--wb-fg);
    background: var(--wb-tab-active);
    margin-bottom: -1px;
    border-bottom: 1px solid var(--wb-tab-active);
  }
  .tab.active::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 1px;
    background: var(--wb-accent);
  }
  .tab:focus-visible {
    outline: 1px solid var(--wb-accent);
    outline-offset: -1px;
  }
  .ticon {
    display: flex;
    color: var(--wb-accent);
  }
  .label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tab:not(:has(.close)) {
    padding-right: 0.875rem;
  }
  .close {
    display: grid;
    place-items: center;
    width: 1.25rem;
    height: 1.25rem;
    padding: 0;
    border-radius: 4px;
    color: var(--wb-fg-muted);
    visibility: hidden;
  }
  .tab.active .close,
  .tab:hover .close {
    visibility: visible;
  }
  .content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    background: var(--wb-editor);
  }
  .no-admin {
    margin: 3rem auto;
    max-width: 32rem;
    text-align: center;
    font-size: 0.8125rem;
    color: var(--wb-fg-muted);
  }
  .content:has(:global(.admin)),
  .content:has(:global(.settings-editor)) {
    overflow: hidden;
  }
  .status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 1.375rem;
    padding: 0 0.5rem;
    font-size: 0.75rem;
    color: var(--wb-fg);
    background: var(--wb-bar);
    border-top: 1px solid var(--wb-border);
    user-select: none;
  }
  .left,
  .right {
    display: flex;
    align-items: center;
    height: 100%;
    min-width: 0;
  }
  .status span,
  .status a,
  .status button {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    height: 100%;
    padding: 0 0.4375rem;
    border-radius: 0;
    font-size: 0.75rem;
    color: var(--wb-fg);
    text-decoration: none;
    white-space: nowrap;
  }
  .status a:hover,
  .status button:hover {
    background: var(--wb-list-hover);
  }
  .status button:active {
    transform: none;
  }
</style>
