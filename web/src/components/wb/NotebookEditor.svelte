<script lang="ts">
  import { cubicOut } from "svelte/easing";
  import { fly } from "svelte/transition";
  import type { Lang } from "../../lib/api";
  import type { NotebookCtl } from "../../lib/notebook.svelte";
  import type { Workbench } from "../../lib/workbench.svelte";
  import CellView from "../Cell.svelte";
  import Icon from "../Icon.svelte";

  // Notebook mode: every cell, stacked, with its output under it.
  let { ctl, wb, focused }: { ctl: NotebookCtl; wb: Workbench; focused: boolean } = $props();
  const book = $derived(ctl.book);

  $effect(() => {
    wb.actions.notebook = [
      ...(ctl.staleCount && !ctl.busy ? [{ icon: "run-errors", title: `Run the ${ctl.staleCount} outdated cells`, run: () => ctl.runStale() }] : []),
      ctl.busy
        ? { icon: "debug-stop", title: "Stop  (i i)", run: () => ctl.interrupt() }
        : { icon: "run-all", title: "Run all  (Ctrl+Shift+Enter)", run: () => ctl.runAll(), disabled: ctl.conn.session === "offline" },
      { icon: "debug-restart", title: "Restart the kernel  (0 0)", run: () => ctl.restart() },
    ];
  });

  // -- Jupyter's command mode, while this editor has focus
  let chord = "";
  let chordAt = 0;
  function typing(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    return t.closest("input, textarea, select, [contenteditable=true], .cm-editor, [role=grid], [role=dialog]") != null;
  }
  function stop(e: KeyboardEvent, fn: () => unknown) {
    e.preventDefault();
    e.stopPropagation();
    fn();
  }
  function onkeydown(e: KeyboardEvent) {
    if (!focused || e.defaultPrevented) return;
    const mod = e.metaKey || e.ctrlKey;
    const sel = ctl.selected;
    if (e.key === "Enter" && e.shiftKey && sel && !typing(e)) return stop(e, () => ctl.runAndAdvance(sel));
    if (e.key === "Enter" && mod && sel && !typing(e)) return stop(e, () => ctl.run([sel]));
    if (typing(e) || e.altKey || mod) return;
    const twice = (k: string) => {
      const hit = chord === k && Date.now() - chordAt < 600;
      chord = hit ? "" : k;
      chordAt = Date.now();
      return hit;
    };
    const lang = (): Lang => {
      const l = sel ? ctl.cell(sel)?.lang : "sql";
      return l === "md" || !l ? "sql" : l;
    };
    switch (e.key) {
      case "j":
      case "ArrowDown":
        return stop(e, () => ctl.step(1));
      case "k":
      case "ArrowUp":
        return stop(e, () => ctl.step(-1));
      case "Enter":
        if (sel) stop(e, () => ctl.select(sel, "edit"));
        return;
      case "Escape":
        return stop(e, () => ctl.select(null));
      case "a":
        return stop(e, () => (sel ? ctl.addAbove(sel, lang()) : ctl.add("sql", null)));
      case "b":
        return stop(e, () => ctl.add(lang(), sel ?? ctl.order.at(-1) ?? null));
      case "?":
        return stop(e, () => (ctl.help = true));
    }
    if (!sel) return;
    switch (e.key) {
      case "y":
        return stop(e, () => ctl.setLang(sel, "sql"));
      case "p":
        return stop(e, () => ctl.setLang(sel, "python"));
      case "m":
        return stop(e, () => ctl.setLang(sel, "md"));
      case "J":
        return stop(e, () => ctl.move(sel, 1));
      case "K":
        return stop(e, () => ctl.move(sel, -1));
      case "h":
        return stop(e, () => ctl.fold(sel, "code"));
      case "o":
        return stop(e, () => ctl.fold(sel, "output"));
      case "d":
        return stop(e, () => twice("d") && ctl.remove(sel));
      case "i":
        return stop(e, () => twice("i") && ctl.interrupt());
      case "0":
        return stop(e, () => twice("0") && ctl.restart());
    }
  }
</script>

<svelte:window {onkeydown} />

<div class="scroll">
  <div class="page">
    {#if book?.params.length}
      <div class="params">
        {#each book.params as p}
          <label title="{p.type}, declared in {p.cell}">
            <span>${p.name}</span>
            <input
              placeholder={p.default ?? "required"}
              value={ctl.params[p.name] ?? ""}
              oninput={(e) => ctl.setParam(p.name, e.currentTarget.value)}
              size={Math.max(4, (ctl.params[p.name] || p.default || "").length + 1)}
              spellcheck="false"
            />
          </label>
        {/each}
      </div>
    {/if}

    {#if ctl.notice}
      <p class="notice" transition:fly={{ y: -4, duration: 150, easing: cubicOut }}>
        {ctl.notice}
        {#if ctl.noticeLink}<a href={ctl.noticeLink.href}>{ctl.noticeLink.label}</a>{/if}
      </p>
    {/if}
    {#if ctl.error}
      <p class="error"><Icon name="error" size={14} />{ctl.error}<button class="icon" aria-label="Dismiss" onclick={() => (ctl.error = "")}><Icon name="x" size={14} /></button></p>
    {/if}

    {#if book}
      <div class="cells">
        {@render adder(null)}
        {#each book.cells as cell, i (cell.name)}
          <CellView {ctl} {cell} index={i} />
          {@render adder(cell.name)}
        {/each}
      </div>
    {/if}
  </div>
</div>

{#snippet adder(after: string | null)}
  <div class="adder" class:always={book?.cells.length === 0}>
    <button onclick={() => ctl.add("sql", after)}><Icon name="add" size={13} />SQL</button>
    <button onclick={() => ctl.add("python", after)}><Icon name="add" size={13} />Python</button>
    <button onclick={() => ctl.add("md", after)}><Icon name="add" size={13} />Markdown</button>
  </div>
{/snippet}

<style>
  .scroll {
    height: 100%;
    overflow: auto;
  }
  .page {
    max-width: 72rem;
    margin: 0 auto;
    padding: 1rem 2rem 10rem;
  }
  .params {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem 1rem;
    margin: 0 0 1rem;
  }
  .params label {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font: 0.75rem var(--mono);
    color: var(--wb-fg-muted);
  }
  .params input {
    font: 0.75rem var(--mono);
    padding: 2px 0.375rem;
    background: var(--wb-input);
    border: 1px solid var(--wb-input-border);
    border-radius: 2px;
    color: var(--wb-fg);
  }
  .notice {
    margin: 0 0 0.75rem;
    font-size: 0.8125rem;
    color: var(--ink-2);
  }
  .notice a {
    margin-left: 0.5rem;
    color: var(--wb-accent);
  }
  .error {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--critical);
    font-size: 0.8125rem;
  }
  .cells {
    display: flex;
    flex-direction: column;
  }
  /* between cells, on hover: VS Code's "+ Code  + Markdown" */
  .adder {
    display: flex;
    justify-content: center;
    gap: 0.25rem;
    height: 1.375rem;
    opacity: 0;
    transition: opacity 0.14s var(--ease);
  }
  .adder:hover,
  .adder:focus-within,
  .adder.always {
    opacity: 1;
  }
  .adder button {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: var(--wb-fg-muted);
    padding: 0 0.5rem;
    border: 1px solid var(--wb-border);
    border-radius: 3px;
    background: var(--wb-editor);
  }
  @media (max-width: 720px) {
    .page {
      padding-left: 1rem;
      padding-right: 1rem;
    }
  }
</style>
