<script lang="ts">
  import type { NotebookCtl } from "../lib/notebook.svelte";
  import Icon from "./Icon.svelte";
  import SectionHead from "./SectionHead.svelte";

  // The template editor's sidebar, as an editor's explorer: what a template can
  // use, in sections. A click inserts it at the cursor.
  let { ctl, oninsert }: { ctl: NotebookCtl; oninsert: (text: string) => void } = $props();

  const HOOKS: { name: string; what: string; snippet: string }[] = [
    { name: "Output", what: "a cell's output: all, or parts", snippet: `<Output cell="" parts={["chart"]} />` },
    { name: "Chart", what: "a cell's chart", snippet: `<Chart cell="" />` },
    { name: "Table", what: "a cell's result table", snippet: `<Table cell="" columns={[]} />` },
    { name: "Value", what: "one number, as a KPI", snippet: `<Value cell="" column="" label="" format="compact" compare={1} />` },
    { name: "Control", what: "a PARAM's control", snippet: `<Control param="" />` },
    { name: "setParam", what: "set a PARAM from your markup", snippet: `setParam("", value)` },
  ];

  const THEME: { name: string; color: boolean }[] = [
    { name: "--ink", color: true },
    { name: "--ink-2", color: true },
    { name: "--muted", color: true },
    { name: "--accent", color: true },
    { name: "--good", color: true },
    { name: "--critical", color: true },
    { name: "--surface", color: true },
    { name: "--hair", color: true },
    { name: "--sans", color: false },
    { name: "--mono", color: false },
  ];

  const SNIPPETS: { name: string; code: string }[] = [
    {
      name: "KPI row",
      code: `<div class="kpis">
  <Value cell="" column="" label="" compare={1} />
  <Value cell="" column="" label="" compare={1} />
  <Value cell="" column="" label="" compare={1} />
</div>`,
    },
    {
      name: "Card",
      code: `<section class="card">
  <h2></h2>
  <Chart cell="" />
</section>`,
    },
    {
      name: "Two columns",
      code: `<div class="row">
  <section class="card"></section>
  <section class="card"></section>
</div>`,
    },
    {
      name: "Each row",
      code: `{#each cells..rows as row}
  <p>{row.}</p>
{/each}`,
    },
  ];

  // which sections are open, remembered in this browser
  let saved: Record<string, boolean> = {};
  try {
    saved = JSON.parse(localStorage.getItem("querier:template-sections") ?? "{}");
  } catch {}
  let open = $state<Record<string, boolean>>({ hooks: true, cells: true, params: true, theme: false, snippets: false, ...saved });
  function toggle(key: string) {
    open[key] = !open[key];
    try {
      localStorage.setItem("querier:template-sections", JSON.stringify(open));
    } catch {}
  }
  const LANG_ICON: Record<string, [string, string]> = {
    sql: ["database", "var(--wb-lang-sql)"],
    python: ["symbol-method", "var(--wb-lang-py)"],
  };
  /** An icon for a column's type, as the Data view's. */
  function typeIcon(t: string): string {
    const x = t.toLowerCase();
    if (/int|float|double|decimal|numeric|real/.test(x)) return "symbol-number";
    if (/date|time/.test(x)) return "calendar";
    if (/bool/.test(x)) return "symbol-boolean";
    if (/list|array|struct/.test(x)) return "symbol-array";
    return "symbol-string";
  }
  let expanded = $state<Record<string, boolean>>({});

  const cells = $derived((ctl.book?.cells ?? []).filter((c) => c.lang !== "md"));
  const params = $derived(ctl.book?.params ?? []);
  const tableOf = (name: string) => ctl.conn.tables.find((t) => t.name === name);
  const nf = new Intl.NumberFormat();
</script>

<nav class="explorer" aria-label="Template explorer">
  {#snippet head(key: string, label: string, icon: string, count?: number)}
    <div class="head"><SectionHead {label} {icon} count={count ?? ""} open={open[key]} ontoggle={() => toggle(key)} /></div>
  {/snippet}

  {@render head("hooks", "Hooks", "symbol-class", HOOKS.length)}
  {#if open.hooks}
    {#each HOOKS as h (h.name)}
      <button class="item" title={h.snippet} onclick={() => oninsert(h.snippet)}>
        <span class="ic" style:color={h.name === "setParam" ? "var(--icon-fn)" : "var(--icon-class)"}><Icon name={h.name === "setParam" ? "symbol-method" : "symbol-class"} size={14} /></span>
        <span class="mono">{h.name}</span><span class="note">{h.what}</span>
      </button>
    {/each}
  {/if}

  {@render head("cells", "Cells", "table", cells.length)}
  {#if open.cells}
    {#each cells as c (c.name)}
      {@const t = tableOf(c.name)}
      <div class="item-row">
        <button class="twist-btn" aria-label="columns of {c.name}" disabled={!t} onclick={() => (expanded[c.name] = !expanded[c.name])}>
          {#if t}<span class="twist" class:open={expanded[c.name]}><Icon name="chevron-right" size={14} /></span>{/if}
        </button>
        <button class="item" title="Insert cells.{c.name}.rows" onclick={() => oninsert(`cells.${c.name}.rows`)}>
          <span class="ic" style:color={LANG_ICON[c.lang]?.[1]}><Icon name={LANG_ICON[c.lang]?.[0] ?? "file"} size={14} /></span>
          <span class="mono">{c.name}</span><span class="note">{t ? `${nf.format(t.rows)} rows` : "not run"}</span>
        </button>
      </div>
      {#if t && expanded[c.name]}
        {#each t.columns as col (col.name)}
          <button class="item sub" title="Insert {col.name}" onclick={() => oninsert(col.name)}>
            <span class="ic"><Icon name={typeIcon(col.type)} size={14} /></span>
            <span class="mono">{col.name}</span><span class="note">{col.type.replace(/\(.*\)$/, "").toLowerCase()}</span>
          </button>
        {/each}
      {/if}
    {/each}
  {/if}

  {#if params.length}
    {@render head("params", "Params", "symbol-parameter", params.length)}
    {#if open.params}
      {#each params as p (p.name)}
        <button class="item" title="Insert params.{p.name}" onclick={() => oninsert(`params.${p.name}`)}>
          <span class="ic" style:color="var(--icon-var)"><Icon name="symbol-parameter" size={14} /></span>
          <span class="mono">{p.name}</span><span class="note">{ctl.params[p.name] || p.default || ""}</span>
        </button>
      {/each}
    {/if}
  {/if}

  {@render head("theme", "Theme", "symbol-color", THEME.length)}
  {#if open.theme}
    {#each THEME as v (v.name)}
      <button class="item" title="Insert var({v.name})" onclick={() => oninsert(`var(${v.name})`)}>
        {#if v.color}<span class="swatch" style:background="var({v.name})"></span>{:else}<span class="ic"><Icon name="text-size" size={14} /></span>{/if}
        <span class="mono">{v.name}</span>
      </button>
    {/each}
  {/if}

  {@render head("snippets", "Snippets", "symbol-snippet", SNIPPETS.length)}
  {#if open.snippets}
    {#each SNIPPETS as s (s.name)}
      <button class="item" title={s.code} onclick={() => oninsert(s.code)}>
        <span class="ic"><Icon name="symbol-snippet" size={14} /></span><span>{s.name}</span>
      </button>
    {/each}
  {/if}
</nav>

<style>
  .explorer {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    padding: 0.25rem 0 1rem;
    font-size: 0.78rem;
    background: var(--page);
    border-right: 1px solid var(--hair);
  }
  .head {
    padding: 0.25rem 0.5rem 0;
  }
  .ic {
    display: flex;
    flex: none;
    color: var(--wb-fg-muted);
  }
  .twist {
    display: inline-flex;
    transition: transform 0.12s var(--ease);
  }
  .twist.open {
    transform: rotate(90deg);
  }
  .item-row {
    display: flex;
    align-items: center;
  }
  .twist-btn {
    flex: none;
    width: 1.25rem;
    height: 1.625rem;
    padding: 0;
    margin-left: 0.25rem;
    color: var(--muted);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    min-width: 0;
    height: 1.625rem;
    padding: 0 0.625rem 0 1.5rem;
    border-radius: 0;
    text-align: left;
    color: var(--ink-2);
  }
  .item-row .item {
    padding-left: 0.125rem;
  }
  .item.sub {
    padding-left: 2.75rem;
  }
  .item:hover {
    background: var(--hover);
    color: var(--ink);
  }
  .mono {
    font-family: var(--mono);
    font-size: 0.75rem;
    white-space: nowrap;
  }
  .note {
    margin-left: auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 0.7rem;
  }
  .swatch {
    flex: none;
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 3px;
    border: 1px solid var(--hair);
  }
</style>
