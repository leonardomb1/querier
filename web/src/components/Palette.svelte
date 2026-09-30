<script lang="ts" module>
  export interface Entry {
    label: string;
    group: string;
    /** a detail shown after the label, muted: a path, an id, "current" */
    hint?: string;
    /** its keyboard shortcut, drawn as key caps: "ctrl+shift+enter", or a chord "i i" */
    keys?: string;
    /** a codicon; else the group's */
    icon?: string;
    /** what it takes: left out of the notebook's palette when they may not */
    needs?: import("../lib/api").Action;
    run: () => void;
  }
</script>

<script lang="ts">
  import { backdrop } from "../lib/backdrop";
  import { openHref } from "../lib/can";
  import { onMount, tick } from "svelte";
  import { fade, scale } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { api, type WorkspaceSummary } from "../lib/api";
  import { homeHref, nbHref, wsHref } from "../lib/href";
  import type { NotebookCtl } from "../lib/notebook.svelte";
  import { CODE_FACES, fonts, UI_FACES } from "../lib/fonts.svelte";
  import { zoom } from "../lib/zoom.svelte";
  import type { Workbench } from "../lib/workbench.svelte";
  import { promptDelete, promptRename } from "../lib/notebooks";
  import Icon from "./Icon.svelte";

  // The command palette, as VS Code's Quick Open: commands, cells, notebooks and
  // workspaces, what was used lately first. In a notebook, its commands too; at
  // home, what the home page adds (`extra`). `only`: a quick pick of `extra`.
  let {
    ctl,
    wb,
    extra = [],
    only = false,
    placeholder = "Type a command, a cell or a notebook",
    onclose,
  }: { ctl?: NotebookCtl; wb?: Workbench; extra?: Entry[]; only?: boolean; placeholder?: string; onclose: () => void } = $props();

  let query = $state("");
  let active = $state(0);
  let spaces = $state<WorkspaceSummary[]>([]);
  // svelte-ignore state_referenced_locally
  if (!only) api.workspaces().then((i) => (spaces = i.workspaces)).catch(() => {});

  const GROUP_ICON: Record<string, string> = {
    run: "play",
    cell: "add",
    view: "layout",
    open: "notebook",
    workspace: "folder-library",
    preferences: "settings-gear",
    git: "source-control",
    notebook: "notebook",
    font: "text-size",
    "go to": "symbol-file",
    "move to": "folder-library",
  };
  const GROUP_LABEL: Record<string, string> = { "go to": "cells", open: "notebooks", workspace: "workspaces" };
  const LANG_ICON: Record<string, string> = { sql: "database", python: "symbol-method", md: "markdown" };

  const general = (): Entry[] => [
    { group: "view", label: `Zoom In (now ${Math.round(zoom.value * 100)}%)`, keys: "ctrl+=", icon: "zoom-in", run: zoom.in },
    { group: "view", label: "Zoom Out", keys: "ctrl+-", icon: "zoom-out", run: zoom.out },
    { group: "view", label: "Reset Zoom", keys: "ctrl+0", run: zoom.reset },
    ...UI_FACES.map((f) => ({ group: "font", label: `Interface Font: ${f.label}`, hint: fonts.ui === f.id ? "current" : undefined, run: () => fonts.set("ui", f.id) })),
    ...CODE_FACES.map((f) => ({ group: "font", label: `Code Font: ${f.label}`, hint: fonts.code === f.id ? "current" : undefined, run: () => fonts.set("code", f.id) })),
  ];

  /** Every notebook but this one, and every workspace. */
  const places = (): Entry[] => [
    ...spaces.flatMap((w) =>
      w.notebooks.filter((b) => b.id !== ctl?.name).map((b) => ({ group: "open", label: b.title, hint: b.id, run: () => (location.hash = openHref(b)) })),
    ),
    ...spaces.map((w) => ({ group: "workspace", label: w.title, hint: `${w.name} · ${w.notebooks.length} notebook${w.notebooks.length === 1 ? "" : "s"}`, run: () => (location.hash = wsHref(w.name)) })),
    { group: "workspace", label: "All Workspaces", icon: "home", run: () => (location.hash = homeHref()) },
  ];

  const entries = $derived.by<Entry[]>(() => {
    if (only) return extra;
    if (!ctl || !wb) return [...extra, ...places(), ...general()];
    const sel = ctl.selected;
    const actions: Entry[] = [
      { group: "run", label: "Run All", keys: "ctrl+shift+enter", icon: "run-all", needs: "notebook.run" as const, run: () => ctl.runAll() },
      { group: "run", label: `Run Stale Cells${ctl.staleCount ? ` (${ctl.staleCount})` : ""}`, icon: "run-errors", needs: "notebook.run" as const, run: () => ctl.runStale() },
      ...(sel ? [{ group: "run", label: `Run ${sel} With What It Needs`, keys: "shift+enter", needs: "notebook.run" as const, run: () => ctl.run([sel]) }] : []),
      ...(sel ? [{ group: "run", label: `Run Everything Above ${sel}`, icon: "run-above", needs: "notebook.run" as const, run: () => ctl.runAbove(sel) }] : []),
      ...(sel ? [{ group: "run", label: `Run ${sel} and Below`, icon: "run-below", needs: "notebook.run" as const, run: () => ctl.runBelow(sel) }] : []),
      { group: "run", label: "Stop", keys: "i i", icon: "debug-stop", needs: "notebook.run" as const, run: () => ctl.interrupt() },
      { group: "run", label: "Restart Kernel", keys: "0 0", icon: "debug-restart", needs: "notebook.run" as const, run: () => ctl.restart() },
      { group: "run", label: "Sandbox: Usage and Kernel", icon: "vm", run: () => (ctl.sandboxPanel = true) },
      { group: "cell", label: "New SQL Cell", keys: "b", icon: "database", needs: "notebook.edit" as const, run: () => ctl.add("sql", sel) },
      { group: "cell", label: "New Python Cell", icon: "symbol-method", needs: "notebook.edit" as const, run: () => ctl.add("python", sel) },
      { group: "cell", label: "New Markdown Cell", icon: "markdown", needs: "notebook.edit" as const, run: () => ctl.add("md", sel) },
      { group: "view", label: "Toggle Side Bar", keys: "ctrl+b", icon: "layout-sidebar-left", run: () => (wb.view = wb.view ? null : "explorer") },
      { group: "view", label: "Toggle Panel", keys: "ctrl+j", icon: "layout-panel", run: () => wb.togglePanel() },
      { group: "view", label: "Explorer", keys: "ctrl+shift+e", icon: "files", run: () => (wb.view = "explorer") },
      { group: "view", label: "Search", keys: "ctrl+shift+f", icon: "search", run: () => (wb.view = "search") },
      { group: "view", label: "Source Control", keys: "ctrl+shift+g", icon: "source-control", run: () => (wb.view = "scm") },
      { group: "view", label: "Data: Tables, Files, Connections", icon: "database", run: () => (wb.view = "data") },
      { group: "view", label: "Problems", icon: "warning", run: () => wb.togglePanel("problems") },
      { group: "view", label: "Terminal: A Shell in Your Kernel's Sandbox", keys: "ctrl+`", icon: "terminal", needs: "notebook.shell" as const, run: () => wb.togglePanel("terminal") },
      { group: "view", label: "Split Editor Right", keys: "ctrl+\\", icon: "split-horizontal", run: () => wb.split("right") },
      { group: "view", label: "Split Editor Down", keys: "ctrl+alt+\\", icon: "split-vertical", run: () => wb.split("down") },
      { group: "view", label: "Split Editor Left", icon: "split-horizontal", run: () => wb.split("left") },
      { group: "view", label: "Split Editor Up", icon: "split-vertical", run: () => wb.split("up") },
      { group: "view", label: "Join All Editor Groups", run: () => wb.joinAll() },
      { group: "view", label: "Even Out Editor Group Sizes", run: () => wb.evenOut() },
      { group: "view", label: "Close All Editors", icon: "close-all", run: () => wb.closeAllGroups() },
      { group: "view", label: wb.panelMax ? "Restore Panel Size" : "Maximize Panel Size", icon: wb.panelMax ? "chevron-down" : "chevron-up", run: () => wb.toggleMaxPanel() },
      { group: "view", label: wb.panelPosition === "right" ? "Move Panel to the Bottom" : "Move Panel to the Right", run: () => wb.movePanel(wb.panelPosition === "right" ? "bottom" : "right") },
      { group: "view", label: "Keyboard Shortcuts", keys: "?", icon: "keyboard", run: () => (ctl.help = true) },
      { group: "open", label: "Open the Notebook", icon: "notebook", run: () => wb.open({ kind: "notebook" }) },
      { group: "open", label: "Open the Report", icon: "preview", run: () => wb.open({ kind: "report" }) },
      ...(ctl.book?.template != null ? [{ group: "open", label: "Open report.svelte", icon: "file-code", run: () => wb.open({ kind: "template" }) }] : []),
      { group: "preferences", label: "Open Settings", keys: "ctrl+,", run: () => ctl.openSettings() },
      { group: "preferences", label: "Connections and Credentials", icon: "plug", needs: "notebook.run" as const, run: () => ctl.openSettings("nb-connections") },
      { group: "preferences", label: "Sandbox: Size and Network", icon: "vm", needs: "sandbox.manage" as const, run: () => ctl.openSettings("nb-sandbox") },
      { group: "preferences", label: "AI Access", icon: "sparkle", needs: "ai.configure" as const, run: () => ctl.openSettings("nb-ai") },
      { group: "preferences", label: "AI Clients (MCP)", icon: "plug", run: () => ctl.openSettings("clients", "user") },
      { group: "preferences", label: "Workspace Settings", icon: "folder-library", run: () => ctl.openSettings(undefined, "workspace") },
      ...(ctl.git?.tracked
        ? [
            { group: "git", label: "Commit Changes", icon: "check", needs: "notebook.edit" as const, run: () => (wb.view = "scm") },
            { group: "git", label: "Git Graph", icon: "git-commit", run: () => wb.open({ kind: "graph" }) },
            { group: "git", label: "Pull", icon: "repo-pull", needs: "git.pull" as const, run: () => ctl.gitDo("Pulling", () => api.git.pull(ctl.name), { reload: true }) },
            { group: "git", label: "Push", icon: "repo-push", needs: "git.push" as const, run: () => ctl.gitDo("Pushing", () => api.git.push(ctl.name)) },
          ]
        : [{ group: "git", label: "Track This Notebook With Git", needs: "notebook.edit" as const, run: () => (ctl.gitPrompt = true) }]),
      { group: "notebook", label: "Share Notebook…", icon: "person-add", needs: "notebook.share" as const, run: () => (ctl.sharing = true) },
      { group: "notebook", label: "Rename Notebook…", hint: `${ctl.name}/`, icon: "edit", needs: "notebook.edit" as const, run: () => promptRename(ctl.name) },
      { group: "notebook", label: "Delete Notebook…", icon: "trash", needs: "notebook.delete" as const, run: () => promptDelete(ctl.name, ctl.book?.title ?? ctl.name) },
      ...general(),
    ];
    const cells: Entry[] = (ctl.book?.cells ?? []).map((c) => ({
      group: "go to",
      label: c.name,
      hint: c.file,
      icon: LANG_ICON[c.lang],
      run: () => wb.open({ kind: "cell", cell: c.name }),
    }));
    return [...actions.filter((e) => !e.needs || ctl.may(e.needs)), ...cells, ...places()];
  });

  // -- what was used lately comes first (in this browser)
  const RECENT = "querier:palette-recent";
  let recent: string[] = [];
  try {
    recent = JSON.parse(localStorage.getItem(RECENT) ?? "[]");
  } catch {}
  const idOf = (e: Entry) => `${e.group}\u0000${e.label}`;
  function remember(e: Entry) {
    recent = [idOf(e), ...recent.filter((r) => r !== idOf(e))].slice(0, 5);
    try {
      localStorage.setItem(RECENT, JSON.stringify(recent));
    } catch {}
  }

  /** Where `q` matches `text`: its characters' positions (a substring first, else a subsequence); null if not. */
  function matchOf(text: string, q: string): number[] | null {
    if (!q) return [];
    const t = text.toLowerCase();
    const at = t.indexOf(q);
    if (at >= 0) return [...q].map((_, i) => at + i);
    const out: number[] = [];
    let i = 0;
    for (const ch of q) {
      const j = t.indexOf(ch, i);
      if (j < 0) return null;
      out.push(j);
      i = j + 1;
    }
    return out;
  }
  /** Earlier and tighter matches first; the label counts more than the group or detail. */
  function score(e: Entry, q: string): { s: number; hits: number[] } | null {
    const m = matchOf(e.label, q);
    if (m) {
      const spread = m.length ? m.at(-1)! - m[0] : 0;
      return { s: (m[0] ?? 0) * 2 + spread - (m.length && m[0] === 0 ? 100 : 0), hits: m };
    }
    return matchOf(`${e.group} ${e.hint ?? ""}`, q) ? { s: 1000, hits: [] } : null;
  }

  type Row = { e: Entry; hits: number[]; head?: string };
  const rows = $derived.by<Row[]>(() => {
    const q = query.trim().toLowerCase();
    if (q) {
      return entries
        .map((e) => ({ e, m: score(e, q) }))
        .filter((x) => x.m)
        .sort((a, b) => a.m!.s - b.m!.s)
        .slice(0, 60)
        .map((x) => ({ e: x.e, hits: x.m!.hits }));
    }
    // nothing typed: what was used lately, then everything by group, each group headed
    const out: Row[] = [];
    const lately = recent.map((r) => entries.find((e) => idOf(e) === r)).filter((e): e is Entry => !!e);
    lately.forEach((e, i) => out.push({ e, hits: [], head: i === 0 ? "recently used" : undefined }));
    let last = "";
    for (const e of entries) {
      if (lately.includes(e)) continue;
      out.push({ e, hits: [], head: e.group !== last ? (GROUP_LABEL[e.group] ?? e.group) : undefined });
      last = e.group;
    }
    return out;
  });

  $effect(() => {
    void query;
    active = 0;
  });

  // focused a frame late: a menu that opened this gives focus back to its button as it closes
  let input = $state<HTMLInputElement>();
  let list = $state<HTMLUListElement>();
  onMount(() => {
    input?.focus();
    const raf = requestAnimationFrame(() => input?.focus());
    return () => cancelAnimationFrame(raf);
  });

  function choose(e?: Entry) {
    if (!e) return;
    if (!only) remember(e);
    onclose();
    e.run();
  }

  function move(to: number) {
    active = Math.max(0, Math.min(rows.length - 1, to));
    tick().then(() => list?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" }));
  }
  function onkeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") move(active + 1 >= rows.length ? 0 : active + 1);
    else if (e.key === "ArrowUp") move(active - 1 < 0 ? rows.length - 1 : active - 1);
    else if (e.key === "PageDown") move(active + 10);
    else if (e.key === "PageUp") move(active - 10);
    else if (e.key === "Home" && e.ctrlKey) move(0);
    else if (e.key === "End" && e.ctrlKey) move(rows.length - 1);
    else if (e.key === "Enter") choose(rows[active]?.e);
    else if (e.key === "Escape") onclose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  /** A label cut where it matched, to bold those characters. */
  function pieces(text: string, hits: number[]): { t: string; on: boolean }[] {
    if (!hits.length) return [{ t: text, on: false }];
    const set = new Set(hits);
    const out: { t: string; on: boolean }[] = [];
    for (let i = 0; i < text.length; i++) {
      const on = set.has(i);
      if (out.length && out.at(-1)!.on === on) out.at(-1)!.t += text[i];
      else out.push({ t: text[i], on });
    }
    return out;
  }
  /** "ctrl+shift+enter" → [["Ctrl","Shift","Enter"]]; "i i" → [["I"],["I"]] */
  const KEY: Record<string, string> = { ctrl: "Ctrl", shift: "Shift", alt: "Alt", meta: "⌘", enter: "Enter", "\\": "\\" };
  const chords = (keys: string) => keys.split(" ").map((c) => c.split(/\+(?!$)/).map((k) => KEY[k] ?? (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))));
  // closes on a click on the backdrop, not on a drag that ends there (lib/backdrop.ts)
  const shut = backdrop(() => onclose());
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" transition:fade={{ duration: 100 }} {...shut}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="palette" role="dialog" tabindex="-1" aria-label="Command palette" transition:scale={{ start: 0.98, duration: 140, easing: cubicOut, opacity: 0 }} onclick={(e) => e.stopPropagation()}>
    <div class="box">
      <input
        {placeholder}
        bind:value={query}
        {onkeydown}
        bind:this={input}
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant="palette-{active}"
        spellcheck="false"
        autocomplete="off"
      />
    </div>
    <ul id="palette-list" role="listbox" bind:this={list}>
      {#each rows as r, i (idOf(r.e) + i)}
        <li role="presentation" class:headed={!!r.head && i > 0}>
          <button
            id="palette-{i}"
            role="option"
            aria-selected={i === active}
            data-i={i}
            class:active={i === active}
            onpointermove={() => (active = i)}
            onclick={() => choose(r.e)}
          >
            <span class="ic"><Icon name={r.e.icon ?? GROUP_ICON[r.e.group] ?? "symbol-event"} size={16} /></span>
            <span class="label">{#each pieces(r.e.label, r.hits) as p}{#if p.on}<b>{p.t}</b>{:else}{p.t}{/if}{/each}</span>
            {#if r.e.hint}<span class="detail">{r.e.hint}</span>{/if}
            <span class="right">
              {#if r.head}<span class="head">{r.head}</span>{/if}
              {#if r.e.keys}
                <span class="keys" aria-label="Shortcut {r.e.keys}">
                  {#each chords(r.e.keys) as chord, c}
                    {#if c}<span class="then"></span>{/if}
                    {#each chord as k, j}{#if j}<span class="plus">+</span>{/if}<kbd>{k}</kbd>{/each}
                  {/each}
                </span>
              {/if}
            </span>
          </button>
        </li>
      {:else}
        <li class="none">No matching commands</li>
      {/each}
    </ul>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    /* just under the title bar, as VS Code's */
    padding-top: 2.5rem;
  }
  .palette {
    width: min(40rem, calc(100vw - 2rem));
    color: var(--wb-fg);
    background: var(--wb-side);
    border: 1px solid var(--wb-input-border);
    border-radius: 8px;
    box-shadow:
      0 12px 28px rgba(0, 0, 0, 0.35),
      0 2px 6px rgba(0, 0, 0, 0.18);
    overflow: hidden;
    transform-origin: top center;
  }
  .box {
    padding: 0.5rem 0.5rem 0.375rem;
  }
  input {
    width: 100%;
    height: 1.875rem;
    padding: 0 0.5rem;
    font-size: 0.875rem;
    color: var(--wb-fg);
    background: var(--wb-input);
    border: 1px solid var(--wb-input-border);
    border-radius: 3px;
    outline: none;
  }
  input:focus {
    border-color: var(--wb-accent);
    box-shadow: 0 0 0 1px var(--wb-accent);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0 0.375rem 0.375rem;
    max-height: min(26rem, 60vh);
    overflow-y: auto;
    scroll-padding: 0.25rem;
  }
  /* a new group: a hairline above it */
  li.headed {
    margin-top: 0.25rem;
    padding-top: 0.25rem;
    border-top: 1px solid var(--wb-border);
  }
  li button {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    min-height: 1.875rem;
    padding: 0 0.625rem;
    border-radius: 4px;
    text-align: left;
    font-size: 0.8125rem;
    color: var(--wb-fg);
    transition: none;
  }
  li button:hover {
    background: none;
    color: var(--wb-fg);
  }
  li button.active {
    color: var(--wb-fg);
    background: var(--wb-list-active);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--wb-accent) 55%, transparent);
  }
  /* a pick is felt before the palette goes */
  li button:active {
    transform: none;
    background: color-mix(in srgb, var(--wb-accent) 35%, var(--wb-list-active));
  }
  .ic {
    display: flex;
    flex: none;
    color: var(--wb-fg-muted);
  }
  .active .ic {
    color: var(--wb-fg);
  }
  .label {
    flex: none;
    max-width: 65%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .label b {
    font-weight: 600;
    color: var(--wb-accent);
  }
  .active .label b {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .detail {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.75rem;
    color: var(--wb-fg-muted);
  }
  .right {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    margin-left: auto;
    flex: none;
  }
  .head {
    font-size: 0.72rem;
    color: var(--wb-fg-dim);
  }
  .keys {
    display: flex;
    align-items: center;
    gap: 0.1875rem;
  }
  .keys kbd {
    min-width: 1.25rem;
    padding: 0.0625rem 0.3125rem;
    font: 0.6875rem/1.3 var(--sans);
    text-align: center;
    color: var(--wb-fg);
    background: color-mix(in srgb, var(--wb-fg) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--wb-fg) 18%, transparent);
    border-bottom-width: 2px;
    border-radius: 3px;
  }
  .plus {
    font-size: 0.6875rem;
    color: var(--wb-fg-dim);
  }
  .then {
    width: 0.25rem;
  }
  .none {
    padding: 0.75rem 0.625rem;
    font-size: 0.8125rem;
    color: var(--wb-fg-muted);
  }
</style>
