<script lang="ts">
  import { cubicOut } from "svelte/easing";
  import { fade, scale, slide } from "svelte/transition";
  import type { Output } from "../lib/conn.svelte";
  import { arrowTable } from "../lib/format";
  import { parseSearch, type Term } from "../lib/search";
  import Icon from "./Icon.svelte";
  import Menu from "./Menu.svelte";
  import Table from "./Table.svelte";

  type Found = { rows: number; of: number; truncated: boolean; arrow?: Uint8Array; error?: string };
  /** `exportUrl` and `onsearch`: the kernel's copy of this result in full (a cell's own result only). */
  let {
    out,
    exportUrl,
    onsearch,
  }: { out: Extract<Output, { type: "table" }>; exportUrl?: string; onsearch?: (terms: Term[]) => Promise<Found> } = $props();

  let exporting = $state("");
  let exportError = $state("");

  // the whole result, not the rows shown here: the kernel writes the file
  async function download(format: "parquet" | "csv") {
    if (!exportUrl || exporting) return;
    exporting = format;
    exportError = "";
    try {
      const r = await fetch(`${exportUrl}${exportUrl.includes("?") ? "&" : "?"}format=${format}`);
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? r.statusText);
      const url = URL.createObjectURL(await r.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: `${out.name}.${format}` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e: any) {
      exportError = e.message;
    } finally {
      exporting = "";
    }
  }

  const table = $derived(arrowTable(out.arrow));
  const fmt = new Intl.NumberFormat();
  let query = $state("");
  let searching = $state(false);
  let matches = $state(0);

  // the page holds a preview; a search of a longer result asks the kernel for every match
  const terms = $derived(parseSearch(query, out.columns.map((c) => c.name)));
  let full = $state<{ table: ReturnType<typeof arrowTable>; rows: number; of: number; truncated: boolean } | null>(null);
  let fullError = $state("");
  let asking = $state(false);
  let searchTimer: ReturnType<typeof setTimeout>;
  $effect(() => {
    const t = terms;
    void out;
    clearTimeout(searchTimer);
    if (!onsearch || !out.truncated || !t.length) {
      full = null;
      fullError = "";
      asking = false;
      return;
    }
    asking = true;
    const asked = query;
    searchTimer = setTimeout(async () => {
      const r = await onsearch(t).catch((e) => ({ rows: 0, of: 0, truncated: false, error: e.message }) as Found);
      if (asked !== query) return; // a later search is on its way
      asking = false;
      fullError = r.error ?? "";
      full = r.error || !r.arrow ? null : { table: arrowTable(r.arrow), rows: r.rows, of: r.of, truncated: r.truncated };
    }, 300);
  });
  const shown = $derived(full?.table ?? table);

  // -- the search box, as VS Code's find widget: it slides open from its icon,
  // counts what it finds, and says how it read the query; its syntax is a click away
  let help = $state(false);
  let input = $state<HTMLInputElement>();
  function open() {
    searching = true;
    requestAnimationFrame(() => input?.focus());
  }
  function close() {
    query = "";
    searching = false;
    help = false;
  }
  const OPS: Record<string, string> = { has: "contains", "=": "=", "!=": "≠", ">": ">", ">=": "≥", "<": "<", "<=": "≤" };
  /** each term as it was understood: which column, which comparison */
  const readAs = $derived(terms.map((t) => `${t.not ? "not " : ""}${t.col ?? "any column"} ${OPS[t.op]} ${t.value}`));
  const count = $derived(query ? (full ? full.rows : asking ? null : matches) : null);
  const EXAMPLES: [string, string][] = [
    ["000600", "any column contains it"],
    ["customer:000600", "that column contains it"],
    ["state=BA", "equals (state!=BA: doesn't)"],
    ["total>1000", "compares: > >= < <="],
    ["day>=2025-01-31", "dates compare too"],
    ["-transfer", "leaves those rows out"],
    ['"two words"', "a phrase"],
  ];
</script>

<div class="result">
  <div class="bar">
    <span class="meta num">
      {#if out.name}<b>{out.name}</b>{/if}
      {fmt.format(out.rows)}{out.capped ? "+" : ""} rows × {out.columns.length}
      {#if out.capped}<span class="warn" title="basalt stopped the query at the row cap; later cells see only these rows">capped</span>{/if}
      {#if out.truncated}<span class="muted">· first {fmt.format(table.numRows)} here</span>{/if}
      {#if query && full}
        <span class="muted">· <b class="found">{fmt.format(full.rows)}</b> match{full.rows === 1 ? "" : "es"} in all {fmt.format(full.of)} rows{full.truncated ? `, first ${fmt.format(full.table.numRows)} here` : ""}</span>
      {:else if query && asking}
        <span class="muted">· searching all {fmt.format(out.rows)} rows…</span>
      {:else if query && out.truncated}
        <span class="muted">· in the first {fmt.format(table.numRows)}</span>
      {/if}
      {#if fullError}<span class="warn" title={fullError}>· {fullError}</span>{/if}
      {#if exporting}<span class="muted">· writing {exporting === "csv" ? "CSV" : "Parquet"}…</span>{/if}
      {#if exportError}<span class="warn" title={exportError}>· download failed: {exportError}</span>{/if}
    </span>
    <span class="tools">
      {#if searching || query}
        <div class="find" transition:slide={{ axis: "x", duration: 160, easing: cubicOut }}>
          <span class="find-ic"><Icon name="search" size={14} /></span>
          <input
            bind:this={input}
            placeholder="Search rows"
            aria-label="Search the rows"
            bind:value={query}
            spellcheck="false"
            autocomplete="off"
            onkeydown={(e) => e.key === "Escape" && (e.stopPropagation(), close())}
            onblur={(e) => !query && !(e.relatedTarget as HTMLElement | null)?.closest(".find") && close()}
          />
          {#if query}
            <span class="count" class:none={count === 0} transition:fade={{ duration: 100 }}>
              {count == null ? "…" : count === 0 ? "No results" : `${fmt.format(count)} ${count === 1 ? "row" : "rows"}`}
            </span>
          {/if}
          <button class="icon" class:on={help} title="Search syntax" aria-label="Search syntax" aria-expanded={help} onclick={() => ((help = !help), input?.focus())}>
            <Icon name="question" size={14} />
          </button>
          <button class="icon" title="Close  (Escape)" aria-label="Close the search" onclick={close}><Icon name="close" size={14} /></button>
          {#if help || (query && readAs.some((r) => !r.startsWith("any column contains")))}
            <div class="find-pop" transition:scale={{ start: 0.97, duration: 120, easing: cubicOut, opacity: 0 }}>
              {#if query && readAs.length}
                <p class="read">Read as <span>{#each readAs as r, i}{#if i}<em>and</em>{/if}<code>{r}</code>{/each}</span></p>
              {/if}
              {#if help}
                <dl>
                  {#each EXAMPLES as [ex, what] (ex)}
                    <dt><button onclick={() => ((query = ex), input?.focus())}>{ex}</button></dt>
                    <dd>{what}</dd>
                  {/each}
                </dl>
                <p class="note">Terms combine with AND. Click an example to try it.</p>
              {/if}
            </div>
          {/if}
        </div>
      {:else}
        <button class="icon" title="Search rows" aria-label="Search rows" onclick={open}><Icon name="search" size={14} /></button>
      {/if}
      {#if exportUrl && out.name}
        <Menu
          icon="download"
          title="Download all {fmt.format(out.rows)} rows"
          items={[
            { label: "Parquet", hint: "typed, compact", run: () => download("parquet") },
            { label: "CSV", hint: "for spreadsheets", run: () => download("csv") },
          ]}
        />
      {/if}
    </span>
  </div>
  <Table table={shown} {query} onmatches={(n) => (matches = n)} />
</div>

<style>
  .result {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .bar {
    min-height: 1.75rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
    color: var(--ink-2);
    flex-wrap: wrap;
  }
  .meta b {
    color: var(--ink);
    font-weight: 600;
    margin-right: 0.375rem;
  }
  .warn {
    color: var(--warning);
    margin-left: 0.25rem;
  }
  .tools {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }
  /* the search box: VS Code's find widget */
  .find {
    position: relative;
    display: flex;
    align-items: center;
    gap: 1px;
    width: 20rem;
    height: 1.625rem;
    padding: 0 0.125rem 0 0.4375rem;
    background: var(--wb-input, var(--surface));
    border: 1px solid var(--wb-input-border, var(--hair));
    border-radius: 4px;
    overflow: visible;
  }
  .find:focus-within {
    border-color: var(--wb-accent, var(--accent));
    box-shadow: 0 0 0 1px var(--wb-accent, var(--accent));
  }
  .find-ic {
    display: flex;
    color: var(--muted);
    margin-right: 0.25rem;
  }
  .find input {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: 0;
    background: none;
    font: 0.8125rem var(--sans);
    color: var(--ink);
    outline: none;
  }
  .find input::placeholder {
    color: var(--muted);
  }
  .count {
    padding: 0 0.375rem;
    font-size: 0.72rem;
    white-space: nowrap;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .count.none {
    color: var(--warning);
  }
  .find .icon {
    width: 1.375rem;
    height: 1.375rem;
    border-radius: 3px;
  }
  .find .icon.on {
    color: var(--ink);
    background: color-mix(in srgb, var(--wb-accent, var(--accent)) 25%, transparent);
  }
  .find-pop {
    position: absolute;
    top: calc(100% + 0.375rem);
    right: 0;
    z-index: 5;
    width: 22rem;
    padding: 0.5rem 0.625rem;
    font-size: 0.75rem;
    color: var(--ink-2);
    background: var(--wb-editor, var(--surface));
    border: 1px solid var(--wb-input-border, var(--hair));
    border-radius: 6px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
    transform-origin: top right;
  }
  .read {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    align-items: baseline;
    margin: 0;
    color: var(--muted);
  }
  .read span {
    display: contents;
  }
  .read code {
    padding: 0 0.3rem;
    font-size: 0.7rem;
    color: var(--ink);
    background: color-mix(in srgb, var(--ink) 8%, transparent);
    border-radius: 3px;
  }
  .read em {
    font-style: normal;
    font-size: 0.7rem;
  }
  .read + dl {
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--hair);
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.125rem 0.75rem;
    margin: 0;
  }
  dt button {
    padding: 0 0.25rem;
    font: 0.72rem var(--mono);
    color: var(--wb-accent, var(--accent));
    border-radius: 3px;
  }
  dd {
    margin: 0;
    align-self: center;
    color: var(--muted);
  }
  .note {
    margin: 0.5rem 0 0;
    font-size: 0.7rem;
    color: var(--muted);
  }
  .found {
    color: var(--ink);
    font-weight: 600;
  }
</style>
