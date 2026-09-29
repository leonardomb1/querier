<script lang="ts">
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
      const r = await fetch(`${exportUrl}?format=${format}`);
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
      {:else if query}
        <span class="muted">· {fmt.format(matches)} match{matches === 1 ? "" : "es"}{out.truncated ? ` in the first ${fmt.format(table.numRows)}` : ""}</span>
      {/if}
      {#if fullError}<span class="warn" title={fullError}>· {fullError}</span>{/if}
      {#if exporting}<span class="muted">· writing {exporting === "csv" ? "CSV" : "Parquet"}…</span>{/if}
      {#if exportError}<span class="warn" title={exportError}>· download failed: {exportError}</span>{/if}
    </span>
    <span class="tools">
      {#if searching || query}
        <!-- svelte-ignore a11y_autofocus -->
        <span class="search-box">
          <input
            class="search"
            placeholder="Search · col:text · col>10 · -text"
            title={"Search the rows:\n  000600           any column contains it\n  customer:000600  that column contains it\n  state=BA         equals (!= doesn't)\n  total>1000       compares (>, >=, <, <=; dates as 2025-01-31)\n  -transfer        leaves those out\n  \"two words\"      a phrase\nTerms combine with AND."}
            bind:value={query}
            autofocus
            spellcheck="false"
            onkeydown={(e) => e.key === "Escape" && ((query = ""), (searching = false))}
            onblur={() => !query && (searching = false)}
          />
          {#if query}<button class="icon clear" aria-label="Clear the search" onclick={() => ((query = ""), (searching = false))}><Icon name="x" size={12} /></button>{/if}
        </span>
      {:else}
        <button class="icon" title="search rows" onclick={() => (searching = true)}><Icon name="search" size={14} /></button>
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
  .search-box {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .search {
    font: 0.75rem var(--mono);
    width: 17rem;
    padding: 2px 1.5rem 2px 0.5rem;
    border-radius: 6px;
  }
  .search-box .clear {
    position: absolute;
    right: 0.125rem;
    width: 1.25rem;
    height: 1.25rem;
  }
  .found {
    color: var(--ink);
    font-weight: 600;
  }
</style>
