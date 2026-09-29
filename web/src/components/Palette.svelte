<script lang="ts">
  import { fade, scale } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { api, type NotebookSummary } from "../lib/api";
  import type { NotebookCtl } from "../lib/notebook.svelte";
  import { CODE_FACES, fonts, UI_FACES } from "../lib/fonts.svelte";
  import { zoom } from "../lib/zoom.svelte";

  import type { Workbench } from "../lib/workbench.svelte";

  let { ctl, wb }: { ctl: NotebookCtl; wb: Workbench } = $props();

  interface Entry {
    label: string;
    group: string;
    hint?: string;
    run: () => void;
  }

  let query = $state("");
  let active = $state(0);
  let books = $state<NotebookSummary[]>([]);
  api.list().then((i) => (books = i.notebooks)).catch(() => {});

  const entries = $derived.by<Entry[]>(() => {
    const sel = ctl.selected;
    const actions: Entry[] = [
      { group: "run", label: "Run all", hint: "ctrl+shift+enter", run: () => ctl.runAll() },
      { group: "run", label: `Run stale cells${ctl.staleCount ? ` (${ctl.staleCount})` : ""}`, run: () => ctl.runStale() },
      ...(sel ? [{ group: "run", label: `Run ${sel} with what it needs`, hint: "shift+enter", run: () => ctl.run([sel]) }] : []),
      ...(sel ? [{ group: "run", label: `Run everything above ${sel}`, run: () => ctl.runAbove(sel) }] : []),
      ...(sel ? [{ group: "run", label: `Run ${sel} and below`, run: () => ctl.runBelow(sel) }] : []),
      { group: "run", label: "Stop", hint: "i i", run: () => ctl.interrupt() },
      { group: "run", label: "Restart kernel", hint: "0 0", run: () => ctl.restart() },
      { group: "cell", label: "New SQL cell", hint: "b", run: () => ctl.add("sql", sel) },
      { group: "cell", label: "New Python cell", run: () => ctl.add("python", sel) },
      { group: "cell", label: "New Markdown cell", run: () => ctl.add("md", sel) },
      { group: "view", label: "Toggle the side bar", hint: "ctrl+b", run: () => (wb.view = wb.view ? null : "explorer") },
      { group: "view", label: "Toggle the panel", hint: "ctrl+j", run: () => wb.togglePanel() },
      { group: "view", label: "Explorer", hint: "ctrl+shift+e", run: () => (wb.view = "explorer") },
      { group: "view", label: "Search", hint: "ctrl+shift+f", run: () => (wb.view = "search") },
      { group: "view", label: "Source control", hint: "ctrl+shift+g", run: () => (wb.view = "scm") },
      { group: "view", label: "Data: tables, files, connections", run: () => (wb.view = "data") },
      { group: "view", label: "Problems", run: () => wb.togglePanel("problems") },
      { group: "view", label: "Split the editor right", hint: "ctrl+\\", run: () => wb.splitRight() },
      { group: "open", label: "Open the notebook", run: () => wb.open({ kind: "notebook" }) },
      { group: "open", label: "Open the report", run: () => wb.open({ kind: "report" }) },
      ...(ctl.book?.template != null ? [{ group: "open", label: "Open report.svelte", run: () => wb.open({ kind: "template" }) }] : []),
      { group: "cell", label: "Secrets and environment variables", run: () => (ctl.secrets = true) },
      { group: "cell", label: "Sandbox: size and network", run: () => (ctl.sandbox = true) },
      { group: "cell", label: "AI clients and access (MCP)", run: () => (ctl.ai = true) },
      ...(ctl.git?.tracked
        ? [
            { group: "git", label: "Commit changes", run: () => (wb.view = "scm") },
            { group: "git", label: "Git Graph", run: () => wb.open({ kind: "graph" }) },
            { group: "git", label: "Pull", run: () => ctl.gitDo("Pulling", () => api.git.pull(ctl.name), { reload: true }) },
            { group: "git", label: "Push", run: () => ctl.gitDo("Pushing", () => api.git.push(ctl.name)) },
          ]
        : [{ group: "git", label: "Track this notebook with git", run: () => (ctl.gitPrompt = true) }]),
      { group: "view", label: "Keyboard shortcuts", hint: "?", run: () => (ctl.help = true) },
      { group: "view", label: `Zoom in (now ${Math.round(zoom.value * 100)}%)`, hint: "ctrl+=", run: zoom.in },
      { group: "view", label: "Zoom out", hint: "ctrl+-", run: zoom.out },
      { group: "view", label: "Reset zoom", hint: "ctrl+0", run: zoom.reset },
      ...UI_FACES.map((f) => ({ group: "font", label: `Interface font: ${f.label}`, hint: fonts.ui === f.id ? "current" : undefined, run: () => fonts.set("ui", f.id) })),
      ...CODE_FACES.map((f) => ({ group: "font", label: `Code font: ${f.label}`, hint: fonts.code === f.id ? "current" : undefined, run: () => fonts.set("code", f.id) })),
    ];
    const cells: Entry[] = (ctl.book?.cells ?? []).map((c) => ({
      group: "go to",
      label: c.name,
      hint: c.lang === "python" ? "py" : c.lang,
      run: () => wb.open({ kind: "cell", cell: c.name }),
    }));
    const others: Entry[] = books
      .filter((b) => b.name !== ctl.name)
      .map((b) => ({ group: "open", label: b.title, hint: b.name, run: () => (location.hash = `#/nb/${encodeURIComponent(b.name)}`) }));
    return [...actions, ...cells, ...others, { group: "open", label: "All notebooks", run: () => (location.hash = "#/") }];
  });

  /** Subsequence match; earlier and tighter matches first. */
  function score(text: string, q: string): number | null {
    if (!q) return 0;
    const t = text.toLowerCase();
    const at = t.indexOf(q);
    if (at >= 0) return at === 0 ? -1000 : -500 + at;
    let i = 0;
    let gaps = 0;
    for (const ch of q) {
      const j = t.indexOf(ch, i);
      if (j < 0) return null;
      gaps += j - i;
      i = j + 1;
    }
    return gaps;
  }

  const results = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return entries
      .map((e) => ({ e, s: score(`${e.label} ${e.group}`, q) }))
      .filter((x): x is { e: Entry; s: number } => x.s != null)
      .sort((a, b) => a.s - b.s)
      .map((x) => x.e)
      .slice(0, 50);
  });

  $effect(() => {
    void query;
    active = 0;
  });

  function choose(e?: Entry) {
    if (!e) return;
    ctl.palette = false;
    e.run();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") active = Math.min(results.length - 1, active + 1);
    else if (e.key === "ArrowUp") active = Math.max(0, active - 1);
    else if (e.key === "Enter") choose(results[active]);
    else if (e.key === "Escape") ctl.palette = false;
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" transition:fade={{ duration: 140 }} onclick={() => (ctl.palette = false)}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="palette" transition:scale={{ start: 0.97, duration: 160, easing: cubicOut }} onclick={(e) => e.stopPropagation()}>
    <!-- svelte-ignore a11y_autofocus -->
    <input placeholder="Run, jump to a cell, open a notebook…" bind:value={query} {onkeydown} autofocus />
    <ul>
      {#each results as r, i}
        <li>
          <button class:active={i === active} onpointermove={() => (active = i)} onclick={() => choose(r)}>
            <span class="group">{r.group}</span>
            <span class="label">{r.label}</span>
            {#if r.hint}<kbd>{r.hint}</kbd>{/if}
          </button>
        </li>
      {:else}
        <li class="none">nothing matches</li>
      {/each}
    </ul>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: var(--scrim);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
  }
  .palette {
    width: min(35rem, calc(100vw - 2rem));
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: 12px;
    box-shadow: var(--shadow-lg);
    overflow: hidden;
  }
  input {
    width: 100%;
    border: 0;
    border-bottom: 1px solid var(--hair);
    border-radius: 0;
    padding: 0.875rem 1rem;
    font-size: 0.9375rem;
    background: none;
    outline: none;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0.375rem;
    max-height: 50vh;
    overflow: auto;
  }
  li button {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    padding: 0.4375rem 0.625rem;
    border-radius: 6px;
    text-align: left;
    color: var(--ink);
  }
  li button:hover {
    background: none;
  }
  li button.active {
    background: var(--sel);
  }
  .group {
    width: 2.75rem;
    flex: none;
    font-size: 0.6875rem;
    color: var(--muted);
  }
  .label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .none {
    padding: 0.625rem;
    color: var(--muted);
  }
</style>
