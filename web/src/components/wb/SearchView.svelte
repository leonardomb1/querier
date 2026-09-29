<script lang="ts">
  import type { NotebookCtl } from "../../lib/notebook.svelte";
  import type { TemplateCtl } from "../../lib/template.svelte";
  import type { Workbench } from "../../lib/workbench.svelte";
  import Icon from "../Icon.svelte";

  // Search across the notebook's files: its cells and report.svelte, as VS Code's.
  let { ctl, wb, tpl }: { ctl: NotebookCtl; wb: Workbench; tpl: TemplateCtl } = $props();

  let query = $state("");
  let matchCase = $state(false);
  let wholeWord = $state(false);
  let regex = $state(false);
  let collapsed = $state<Record<string, boolean>>({});
  let input = $state<HTMLInputElement>();
  // opening the view is for typing into it
  $effect(() => {
    input?.focus();
    input?.select();
  });

  type Hit = { line: number; col: number; before: string; match: string; after: string };
  type FileHits = { key: string; file: string; cell?: string; lang: string; hits: Hit[] };

  const pattern = $derived.by<RegExp | string | null>(() => {
    if (!query) return null;
    const src = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      return new RegExp(wholeWord ? `\\b(?:${src})\\b` : src, matchCase ? "g" : "gi");
    } catch (e: any) {
      return e.message as string;
    }
  });

  const results = $derived.by<FileHits[]>(() => {
    const re = pattern;
    if (!(re instanceof RegExp)) return [];
    const files: { key: string; file: string; cell?: string; lang: string; source: string }[] = [
      ...(ctl.book?.cells ?? []).map((c) => ({ key: `cell:${c.name}`, file: c.file, cell: c.name, lang: c.lang, source: ctl.sources[c.name] ?? c.source })),
      ...(ctl.book?.template != null ? [{ key: "template", file: "report.svelte", lang: "svelte", source: tpl.draft || ctl.book.template }] : []),
    ];
    const out: FileHits[] = [];
    for (const f of files) {
      const hits: Hit[] = [];
      f.source.split("\n").forEach((text, i) => {
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
          if (!m[0]) break;
          const at = m.index!;
          hits.push({ line: i + 1, col: at + 1, before: text.slice(Math.max(0, at - 24), at).trimStart(), match: m[0], after: text.slice(at + m[0].length, at + m[0].length + 60) });
          if (hits.length > 200) break;
        }
      });
      if (hits.length) out.push({ ...f, hits });
    }
    return out;
  });
  const total = $derived(results.reduce((n, f) => n + f.hits.length, 0));

  function go(f: FileHits, h: Hit) {
    if (f.cell) {
      wb.open({ kind: "cell", cell: f.cell });
      wb.reveal = { cell: f.cell, line: h.line, col: h.col };
    } else wb.open({ kind: "template" });
  }
  const ICON: Record<string, [string, string]> = {
    sql: ["database", "var(--wb-lang-sql)"],
    python: ["symbol-method", "var(--wb-lang-py)"],
    md: ["markdown", "var(--wb-fg-muted)"],
    svelte: ["file-code", "var(--wb-lang-svelte)"],
  };
</script>

<div class="view">
  <header class="title"><span>Search</span></header>
  <div class="box">
    <input bind:this={input} bind:value={query} placeholder="Search" spellcheck="false" />
    <span class="toggles">
      <button class="icon" class:on={matchCase} title="Match case" aria-pressed={matchCase} onclick={() => (matchCase = !matchCase)}><Icon name="case-sensitive" size={16} /></button>
      <button class="icon" class:on={wholeWord} title="Match whole word" aria-pressed={wholeWord} onclick={() => (wholeWord = !wholeWord)}><Icon name="whole-word" size={16} /></button>
      <button class="icon" class:on={regex} title="Use regular expression" aria-pressed={regex} onclick={() => (regex = !regex)}><Icon name="regex" size={16} /></button>
    </span>
  </div>
  {#if typeof pattern === "string"}
    <p class="note bad">{pattern}</p>
  {:else if query}
    <p class="note">{total ? `${total} result${total === 1 ? "" : "s"} in ${results.length} file${results.length === 1 ? "" : "s"}` : "No results"}</p>
  {/if}
  <div class="results">
    {#each results as f (f.key)}
      {@const [icon, color] = ICON[f.lang] ?? ICON.sql}
      <button class="file" onclick={() => (collapsed[f.key] = !collapsed[f.key])} aria-expanded={!collapsed[f.key]}>
        <span class="twist" class:open={!collapsed[f.key]}><Icon name="chevron-right" size={16} /></span>
        <span class="ic" style:color={color}><Icon name={icon} size={16} /></span>
        <span class="name">{f.file}</span>
        <span class="count">{f.hits.length}</span>
      </button>
      {#if !collapsed[f.key]}
        {#each f.hits as h, i (i)}
          <button class="hit" onclick={() => go(f, h)} title="Line {h.line}">
            <span class="text">{h.before}<mark>{h.match}</mark>{h.after}</span>
          </button>
        {/each}
      {/if}
    {/each}
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
    padding: 0 1.25rem;
    font-size: 0.6875rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--wb-fg-muted);
    flex: none;
  }
  .box {
    position: relative;
    margin: 0 0.75rem 0.375rem 1.25rem;
    flex: none;
  }
  .box input {
    width: 100%;
    height: 1.625rem;
    padding: 0 5rem 0 0.375rem;
    font-size: 0.8125rem;
    color: var(--wb-fg);
    background: var(--wb-input);
    border: 1px solid var(--wb-input-border);
    border-radius: 2px;
    outline: none;
  }
  .box input:focus {
    border-color: var(--wb-accent);
  }
  .toggles {
    position: absolute;
    right: 0.125rem;
    top: 0.125rem;
    display: flex;
    gap: 1px;
  }
  .toggles button {
    width: 1.375rem;
    height: 1.375rem;
    border-radius: 3px;
    color: var(--wb-fg-muted);
  }
  .toggles button.on {
    color: var(--wb-fg);
    background: color-mix(in srgb, var(--wb-accent) 30%, transparent);
    outline: 1px solid var(--wb-accent);
    outline-offset: -1px;
  }
  .note {
    margin: 0 0.75rem 0.375rem 1.25rem;
    font-size: 0.75rem;
    color: var(--wb-fg-muted);
  }
  .note.bad {
    color: var(--critical);
  }
  .results {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .file,
  .hit {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    width: 100%;
    height: 1.375rem;
    padding: 0 0.75rem 0 0.5rem;
    border-radius: 0;
    color: var(--wb-fg);
    text-align: left;
  }
  .file:hover,
  .hit:hover {
    background: var(--wb-list-hover);
  }
  .twist {
    display: flex;
    transition: transform 0.1s;
  }
  .twist.open {
    transform: rotate(90deg);
  }
  .ic {
    display: flex;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    margin-left: auto;
    min-width: 1.125rem;
    padding: 0 0.3rem;
    border-radius: 999px;
    font-size: 0.68rem;
    text-align: center;
    color: #fff;
    background: var(--wb-badge);
  }
  .hit {
    padding-left: 2.75rem;
  }
  .text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: pre;
    font-size: 0.78rem;
    color: var(--wb-fg-muted);
  }
  mark {
    color: var(--wb-fg);
    background: color-mix(in srgb, #ea5c00 35%, transparent);
    border-radius: 2px;
  }
</style>
