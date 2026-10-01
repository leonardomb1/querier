<script lang="ts">
  import { marked } from "marked";
  import { tick } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { slide } from "svelte/transition";
  import { hash } from "../../../shared/hash";
  import { api, nbUrl, type Cell } from "../lib/api";
  import type { NotebookCtl } from "../lib/notebook.svelte";
  import Avatars, { people } from "./Avatars.svelte";
  import Editor, { type Mark } from "./Editor.svelte";
  import Icon from "./Icon.svelte";
  import Menu, { type MenuItem } from "./Menu.svelte";
  import { menu as menuOf } from "../lib/can";
  import Outputs from "./Outputs.svelte";

  let { ctl, cell, index }: { ctl: NotebookCtl; cell: Cell; index: number } = $props();

  let editor = $state<ReturnType<typeof Editor>>();
  let editingMd = $state(false);
  let renaming = $state(false);
  let draftName = $state("");
  let renameError = $state("");

  const name = $derived(cell.name);
  const source = $derived(ctl.sources[name] ?? cell.source);
  const run = $derived(ctl.conn.runs[name]);
  const status = $derived(run?.state ?? "idle");
  const fresh = $derived(ctl.fresh[name]);
  const fold = $derived(ctl.folds[name] ?? {});
  const selected = $derived(ctl.selected === name);
  const isMd = $derived(cell.lang === "md");
  const autofocus = $derived(ctl.focusOnMount === name);
  const showEditor = $derived(!isMd || editingMd || !source.trim() || autofocus);
  const reads = $derived(ctl.up[name] ?? []);
  // editing together: who else is in this cell (their color on its border), and its shared text
  const here = $derived(people(ctl.peersIn(name).map((p) => p.user)));
  const shared = $derived(ctl.shared(name));
  // git: how this cell differs from the last commit, and that version
  const change = $derived(ctl.changeOf(name));
  const committed = $derived(
    ctl.git?.tracked ? (change === "added" ? "" : (ctl.git.original[name] ?? null)) : null,
  );
  const showDiff = $derived(!!ctl.diffs[name] && (change === "modified" || change === "added"));
  const LETTER = { modified: "M", added: "A", moved: "R", deleted: "D" } as const;
  const WHAT = {
    modified: "Changed since the last commit",
    added: "New since the last commit",
    moved: "Moved since the last commit",
    deleted: "Deleted",
  } as const;
  const lines = $derived(source.split("\n").length);
  // what the editor underlines: the live check, the last run's errors, credentials written in
  const marks = $derived<Mark[]>(ctl.marksFor(name));
  // a live clock while running, instead of a spinner
  let now = $state(Date.now());
  let startedAt = $state(0);
  $effect(() => {
    if (status !== "running") return;
    startedAt = Date.now();
    now = startedAt;
    const t = setInterval(() => (now = Date.now()), 100);
    return () => clearInterval(t);
  });

  const outputSummary = $derived.by(() => {
    const outs = run?.outputs ?? [];
    const table = outs.find((o) => o.type === "table");
    if (table?.type === "table") return `table · ${table.rows.toLocaleString()} rows`;
    const loads = outs.filter((o) => o.type === "load").length;
    if (loads) return `${loads} ${loads === 1 ? "load" : "loads"}`;
    if (outs.some((o) => o.type === "error")) return "error";
    if (outs.some((o) => o.type === "display")) return "figure";
    return `${outs.length} outputs`;
  });

  // The controller reaches this cell's editor through here (focus, sidebar inserts).
  $effect(() => {
    ctl.editors[name] = {
      focus: async () => {
        if (isMd) editingMd = true;
        if (fold.code) ctl.fold(name, "code");
        await tick();
        editor?.focus();
      },
      insert: (text) => editor?.insert(text),
    };
    return () => delete ctl.editors[name];
  });

  $effect(() => {
    if (autofocus) queueMicrotask(() => (ctl.focusOnMount = null));
  });

  async function submitRename(e: SubmitEvent) {
    e.preventDefault();
    try {
      await ctl.rename(name, draftName.trim());
      renaming = false;
      renameError = "";
    } catch (err: any) {
      renameError = err.message;
    }
  }

  function time(ms?: number) {
    if (ms == null) return "";
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  }

  // only what they may do: viewing, running, changing (lib/can.ts)
  const ifRun = (item: MenuItem) => (ctl.mayRun ? item : false);
  const ifEdit = (item: MenuItem) => (ctl.mayEdit ? item : false);
  const menu = $derived<(MenuItem | "-")[]>(menuOf(
    ...(ctl.mayEdit && (change === "modified" || change === "added")
      ? [
          { label: showDiff ? "Hide changes" : "Show changes", run: () => (ctl.diffs[name] = !showDiff) },
          {
            label: change === "added" ? "Discard this new cell" : "Discard changes",
            danger: true,
            run: () => ctl.gitDo("Discarding", () => api.git.restore(ctl.name, "HEAD", [name]), { reload: true }),
          },
          "-" as const,
        ]
      : []),
    ifEdit({ label: ctl.inReport(name) ? "Hide from report" : "Show in report", run: () => ctl.toggleInReport(name) }),
    "-",
    ifRun({ label: "Run just this cell", run: () => ctl.run([name], { withDeps: false }), disabled: isMd }),
    ifRun({ label: "Run above", run: () => ctl.runAbove(name), disabled: index === 0 }),
    ifRun({ label: "Run this and below", run: () => ctl.runBelow(name) }),
    "-",
    { label: fold.code ? "Show code" : "Hide code", hint: "h", run: () => ctl.fold(name, "code") },
    { label: fold.output ? "Show output" : "Hide output", hint: "o", run: () => ctl.fold(name, "output"), disabled: isMd },
    ifEdit({ label: "Rename", run: () => ((draftName = name), (renaming = true)) }),
    ifEdit({ label: "Move up", hint: "⇧K", run: () => ctl.move(name, -1), disabled: index === 0 }),
    ifEdit({ label: "Move down", hint: "⇧J", run: () => ctl.move(name, 1), disabled: index === ctl.order.length - 1 }),
    ifEdit({ label: "Convert to SQL", hint: "y", run: () => ctl.setLang(name, "sql"), disabled: cell.lang === "sql" }),
    ifEdit({ label: "Convert to Python", hint: "p", run: () => ctl.setLang(name, "python"), disabled: cell.lang === "python" }),
    ifEdit({ label: "Convert to Markdown", hint: "m", run: () => ctl.setLang(name, "md"), disabled: isMd }),
    "-",
    ifEdit({ label: "Delete", hint: "d d", danger: true, run: () => ctl.remove(name) }),
  ));
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<section
  id="cell-{name}"
  class="cell {status}"
  class:md={isMd}
  class:selected
  class:editing={selected && ctl.mode === "edit"}
  class:stale={fresh === "stale"}
  onpointerdown={(e) => {
    if (!(e.target as HTMLElement).closest(".monaco-editor, .editor, button, input, select, a, .result")) ctl.select(name);
  }}
>
  <header>
    {#if renaming}
      <form onsubmit={submitRename}>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="rename"
          bind:value={draftName}
          autofocus
          onblur={() => (renaming = false)}
          onkeydown={(e) => e.key === "Escape" && (renaming = false)}
        />
      </form>
      {#if renameError}<span class="err">{renameError}</span>{/if}
    {:else}
      <button class="name" title={ctl.mayEdit ? "Rename. Other cells refer to it by this name." : "Other cells refer to it by this name."} disabled={!ctl.mayEdit} onclick={() => ((draftName = name), (renaming = true))}>{name}</button>
    {/if}
    <span class="lang">{isMd ? "markdown" : cell.lang === "python" ? "python" : "sql"}</span>
    {#if change}
      <button
        class="change {change}"
        class:on={showDiff}
        title="{WHAT[change]}{change === 'modified' || change === 'added' ? (showDiff ? ' · click to hide the diff' : ' · click to see the diff') : ''}"
        onclick={() => (change === "modified" || change === "added") && (ctl.diffs[name] = !showDiff)}
      >
        {LETTER[change]}
      </button>
    {/if}
    {#if reads.length}
      <span class="reads">
        from
        {#each reads as r, i}
          <button class="ref" onclick={() => ctl.select(r)}>{r}</button>{i < reads.length - 1 ? "," : ""}
        {/each}
      </span>
    {/if}

    <span class="status num">
      {#if status === "running"}
        <span class="live">{((now - startedAt) / 1000).toFixed(1)}s</span>
      {:else if status === "queued"}
        Queued
      {:else if status === "error"}
        <span class="bad">Failed</span>
      {:else if fresh === "stale"}
        <span class="stale" title="Its code, a param it reads, or a cell it reads changed since it last ran.">Outdated</span>
      {:else if status === "ok"}
        {time(run?.ms)}
      {/if}
    </span>

    <span class="actions">
      {#if !isMd && ctl.mayRun}
        {#if status === "running" || status === "queued"}
          <button class="icon stop" title="Stop  (i i)" aria-label="Stop" onclick={() => ctl.interrupt()}><Icon name="stop" size={12} /></button>
        {:else}
          <button class="icon run" title="Run  ⇧↵" aria-label="Run" onclick={() => ctl.run([name])}><Icon name="play" size={13} /></button>
        {/if}
      {:else if isMd && ctl.mayEdit}
        <!-- (pressed without taking focus from the editor: its blur would close it first, and the click reopen it) -->
        <button class="text" onpointerdown={(e) => e.preventDefault()} onclick={() => (editingMd ? (editingMd = false) : ctl.select(name, "edit"))}>{editingMd ? "Done" : "Edit"}</button>
      {/if}
      <Menu items={menu} />
    </span>
  </header>

  {#if fold.code}
    <button class="folded" onclick={() => ctl.fold(name, "code")}>
      {lines} {lines === 1 ? "line" : "lines"} hidden
    </button>
  {:else if showEditor}
    <div class="code {here.length ? `peered q-peer-c${here[0].color}` : ''}" transition:slide={{ duration: 150, easing: cubicOut }}>
      {#if here.length}<span class="peers"><Avatars users={here} label="is editing" /></span>{/if}
      <Editor
        bind:this={editor}
        value={source}
        lang={cell.lang}
        {shared}
        readOnly={!ctl.mayEdit || ctl.waitingFor(name)}
        {marks}
        {autofocus}
        onchange={(s) => ctl.edit(name, s)}
        onrun={(advance) => {
          if (isMd) editingMd = false;
          advance ? ctl.runAndAdvance(name) : ctl.run([name]);
        }}
        onfocus={() => {
          if (isMd) editingMd = true; // typing never flips it to the rendered view
          ctl.selected = name;
          ctl.mode = "edit";
          ctl.lastEditor = name;
        }}
        onblur={() => {
          if (ctl.selected === name) ctl.mode = "command";
          if (isMd && source.trim()) editingMd = false;
        }}
        complete={ctl.mayRun ? (lang, src, pos) => ctl.conn.complete(lang, src, pos) : undefined}
        hover={(_, word) => ctl.hoverInfo(word)}
        original={committed}
        {showDiff}
      />
    </div>
  {:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="prose {here.length ? `peered q-peer-c${here[0].color}` : ''}" ondblclick={() => ctl.select(name, "edit")}>
      {#if here.length}<span class="peers"><Avatars users={here} label="is editing" /></span>{/if}
      {@html marked.parse(source)}
    </div>
  {/if}

  {#if run && !isMd && (run.outputs.length || run.progress)}
    {#if fold.output}
      <button class="folded out" onclick={() => ctl.fold(name, "output")}>
        Output hidden · {outputSummary}
      </button>
    {:else}
      <div class="out" transition:slide={{ duration: 150, easing: cubicOut }}>
        <Outputs
          {run}
          cell={name}
          exportUrl="{nbUrl(ctl.name)}/cells/{encodeURIComponent(name)}/export"
          onsearch={(terms) => ctl.conn.filter(name, terms)}
          onprofile={() => ctl.conn.profile(name)}
          onstop={() => ctl.interrupt()}
          sandbox={ctl.conn.info.sandbox ? { egress: ctl.conn.info.egress ?? "" } : null}
          onsandbox={() => ctl.openSettings("nb-sandbox")}
        />
      </div>
    {/if}
  {/if}
</section>

<style>
  .cell {
    position: relative;
    padding: 0.25rem 0.5rem 0.625rem;
    margin: 0 -0.5rem;
    border-radius: 8px;
    transition: background-color 0.15s var(--ease);
  }
  .cell.selected {
    background: var(--select-band);
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    height: 1.75rem;
    padding-top: 0.25rem;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .md header {
    opacity: 0;
    transition: opacity 0.14s var(--ease);
  }
  .md:hover header,
  .md.selected header {
    opacity: 1;
  }
  .name {
    font: 600 0.7812rem var(--mono);
    color: var(--ink);
    padding: 0 0.1875rem;
    margin-left: -0.1875rem;
  }
  .rename {
    font: 0.7812rem var(--mono);
    width: 11.25rem;
    padding: 0 0.25rem;
  }
  /* the git letter, colored as VS Code's explorer */
  .change {
    font: 600 0.7rem var(--mono);
    padding: 0 0.3rem;
    border-radius: 3px;
    line-height: 1.4;
  }
  .change.modified {
    color: var(--git-letter-modified);
  }
  .change.added,
  .change.moved {
    color: var(--git-letter-added);
  }
  .change.on {
    background: var(--pressed);
  }
  .reads {
    display: inline-flex;
    align-items: center;
    gap: 0.1875rem;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  .ref {
    font: 0.75rem var(--mono);
    color: var(--ink-2);
    padding: 0 1px;
    text-decoration: underline;
    text-decoration-color: var(--axis);
    text-underline-offset: 3px;
  }
  .ref:hover {
    background: none;
    text-decoration-color: currentColor;
  }
  .status {
    margin-left: auto;
    white-space: nowrap;
    line-height: 1;
  }
  .live {
    color: var(--ink-2);
  }
  .bad {
    color: var(--critical);
  }
  .stale {
    color: var(--stale);
  }
  .actions {
    display: flex;
    align-items: center;
    opacity: 0;
    transition: opacity 0.14s var(--ease);
  }
  .cell:hover .actions,
  .cell.selected .actions,
  .cell:focus-within .actions {
    opacity: 1;
  }
  .actions .run {
    color: var(--run);
  }
  .actions .run:hover {
    color: var(--run);
    filter: brightness(1.2);
  }
  .actions .stop {
    color: var(--critical);
  }
  .running .actions,
  .queued .actions {
    opacity: 1;
  }
  .actions .text {
    font-size: 0.75rem;
  }
  .err {
    color: var(--critical);
  }

  .code {
    border: 1px solid var(--hair);
    border-radius: 6px;
    overflow: hidden;
    transition: border-color 0.1s;
  }
  .editing .code {
    border-color: var(--ring);
  }
  /* someone else is in this cell: their color around it, their badge on its corner */
  .code.peered,
  .prose.peered {
    position: relative;
    overflow: visible;
    border-color: var(--peer);
    box-shadow: 0 0 0 1px var(--peer);
  }
  .prose.peered {
    border: 1px solid var(--peer);
    border-radius: 6px;
  }
  /* beside the box's top-left corner, in the gutter: not over the cell's name or its code */
  .peers {
    position: absolute;
    top: 0.3125rem;
    right: calc(100% + 0.375rem);
    z-index: 3;
    line-height: 0;
  }
  .error .code {
    border-color: color-mix(in srgb, var(--critical) 40%, var(--hair));
  }
  .out {
    padding: 2px 0 0;
  }
  .folded {
    display: block;
    width: 100%;
    padding: 0.3125rem 0.625rem;
    border: 1px dashed var(--hair);
    border-radius: 6px;
    font-size: 0.75rem;
    color: var(--muted);
    text-align: left;
  }
  .folded.out {
    margin-top: 0.5rem;
  }
  .prose {
    padding: 0 2px;
    line-height: 1.65;
    max-width: 68ch;
  }
  .prose :global(h1) {
    font-size: 1.375rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    margin: 0 0 0.375rem;
  }
  .prose :global(h2),
  .prose :global(h3) {
    font-size: 0.9375rem;
    font-weight: 600;
    margin: 0.75rem 0 0.25rem;
  }
  .prose :global(p),
  .prose :global(li) {
    margin: 0.25rem 0;
    color: var(--ink-2);
  }
  .prose :global(code) {
    font-size: 0.7812rem;
    background: var(--surface-2);
    padding: 1px 0.25rem;
    border-radius: 3px;
  }
</style>
