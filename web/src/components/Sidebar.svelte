<script lang="ts">
  import { api, type AiLevel } from "../lib/api";
  import type { Inspection } from "../lib/conn.svelte";
  import type { NotebookCtl } from "../lib/notebook.svelte";
  import Icon from "./Icon.svelte";
  import SectionHead from "./SectionHead.svelte";
  import SourceIcon from "./SourceIcon.svelte";

  let { ctl }: { ctl: NotebookCtl } = $props();

  let filter = $state("");
  // which sections are folded, remembered in this browser
  let folded = $state<Record<string, boolean>>({});
  try {
    folded = JSON.parse(localStorage.getItem("querier:data-folded") ?? "{}");
  } catch {}
  function fold(key: string) {
    folded[key] = !folded[key];
    try {
      localStorage.setItem("querier:data-folded", JSON.stringify(folded));
    } catch {}
  }
  /** An icon for a column's type: numbers, text, time, true/false. */
  function typeIcon(t: string): string {
    const x = t.toLowerCase();
    if (/int|float|double|decimal|numeric|real/.test(x)) return "symbol-number";
    if (/date|time/.test(x)) return "calendar";
    if (/bool/.test(x)) return "symbol-boolean";
    if (/list|array|struct|json/.test(x)) return "symbol-array";
    return "symbol-string";
  }
  const DECL_ICON: Record<string, string> = { param: "symbol-parameter", let: "symbol-constant", function: "symbol-method" };
  let aiLevel = $state<AiLevel | null>(null);
  // re-read when the dialog closes
  $effect(() => {
    if (!ctl.ai) api.ai.level(ctl.name).then((r) => (aiLevel = r.level), () => {});
  });
  let open = $state<Record<string, boolean>>({});
  // basalt answers, by the script that asked: DESCRIBE 'x.csv', SHOW TABLES FROM erp
  let answers = $state<Record<string, Inspection | "loading">>({});

  const q = $derived(filter.trim().toLowerCase());
  const match = (s: string) => !q || s.toLowerCase().includes(q);

  const tables = $derived(ctl.conn.tables.filter((t) => match(t.name) || t.columns.some((c) => match(c.name))));
  const files = $derived((ctl.book?.files ?? []).filter(match));
  // a connection shows when its name matches, or any table of its catalog (once listed)
  const connections = $derived(
    ctl.conn.declared.filter((d) => {
      if (d.kind !== "connection") return false;
      if (match(d.name)) return true;
      const a = answers[`SHOW TABLES FROM ${d.name};`];
      return !!a && a !== "loading" && !a.error && catalog(d.name, a).hits.length > 0;
    }),
  );
  let known = $state<Set<string>>(new Set());
  $effect(() => {
    void ctl.secrets; // re-read after the dialog closes
    api.secrets(ctl.name).then((r) => (known = new Set(r.secrets.map((s) => s.name)))).catch(() => {});
  });
  const missingSecrets = $derived([...ctl.secretRefs.keys()].filter((n) => !known.has(n)).length);
  const others = $derived(ctl.conn.declared.filter((d) => d.kind !== "connection" && match(d.name)));

  // a connection's catalog can hold thousands of tables: filtered, scrolled, and drawn a page at a time
  const PAGE = 200;
  let catFilter = $state<Record<string, string>>({});
  let catLimit = $state<Record<string, number>>({});
  function catalog(conn: string, a: Inspection) {
    // its own filter, else the sidebar's (unless that one matched the connection itself)
    const own = (catFilter[conn] ?? "").trim().toLowerCase();
    const f = own || (q && !conn.toLowerCase().includes(q) ? q : "");
    const rows = a.rows.map((row) => {
      const schema = col(a, row, "table_schema");
      const tname = col(a, row, "table_name") ?? col(a, row, "resource");
      const label = schema ? `${schema}.${tname}` : tname;
      return { label, ref: schema ? `${conn}.${schema}.${tname}` : `${conn}.${tname}` };
    });
    const hits = f ? rows.filter((r) => r.label.toLowerCase().includes(f)) : rows;
    return { total: rows.length, hits, shown: hits.slice(0, catLimit[conn] ?? PAGE) };
  }
  const nf = new Intl.NumberFormat();

  function ask(script: string) {
    if (answers[script] && answers[script] !== "loading" && !(answers[script] as Inspection).error) return;
    answers[script] = "loading";
    ctl.conn.inspect(script).then((a) => (answers[script] = a));
  }

  function toggle(key: string, script?: string) {
    open[key] = !open[key];
    if (open[key] && script) ask(script);
  }

  const quote = (path: string) => `'${path.replace(/'/g, "''")}'`;
  const col = (a: Inspection, row: unknown[], name: string) => row[a.columns.indexOf(name)] as string;
  const shortType = (t: string) => t.replace(/Datetime\(time_unit='(\w+)', time_zone=None\)/, "datetime").replace(/\(.*\)$/, "").toLowerCase();
  const declLabel = (d: { kind: string; name: string }) => (d.kind === "function" ? `${d.name}()` : d.kind === "param" || d.kind === "let" ? `$${d.name}` : d.name);
</script>

<aside>
  <div class="search">
    <Icon name="search" size={14} />
    <input placeholder="Filter" bind:value={filter} />
  </div>

  <section>
    {@render head("frames", "DataFrames", "table", String(ctl.conn.tables.length))}
    {#if !folded.frames}
    {#each tables as t (t.name)}
      {@const from = ctl.definer(t.name)}
      <div class="item">
        <button class="twist" class:open={open[`t:${t.name}`]} onclick={() => toggle(`t:${t.name}`)} aria-label="columns"><Icon name="chevron" size={12} /></button>
        <button class="label" title="insert {t.name}" onclick={() => ctl.insert(t.name)}>
          <Icon name="dataframe" size={14} /><span>{t.name}</span>
        </button>
        <span class="meta num">{t.rows.toLocaleString()}</span>
        {#if from}
          <button class="icon jump" title="Go to {from}, where it's made" onclick={() => ctl.select(from)}><Icon name="go-to-file" size={14} /></button>
        {/if}
      </div>
      {#if open[`t:${t.name}`] || (q && !match(t.name))}
        {#each t.columns.filter((c) => !q || match(t.name) || match(c.name)) as c}
          <button class="col" onclick={() => ctl.insert(c.name)}><span class="cname"><Icon name={typeIcon(c.type)} size={14} />{c.name}</span><i>{shortType(c.type)}</i></button>
        {/each}
      {/if}
    {:else}
      <p class="empty">{ctl.conn.session === "ready" ? "No DataFrames yet" : "Run a cell to see its results here"}</p>
    {/each}
    {/if}
  </section>

  {#if files.length}
    <section>
      {@render head("files", "Files", "files", String(files.length))}
      {#if !folded.files}
      {#each files as f (f)}
        {@const script = `DESCRIBE ${quote(f)};`}
        <div class="item">
          <button class="twist" class:open={open[`f:${f}`]} onclick={() => toggle(`f:${f}`, script)} aria-label="columns"><Icon name="chevron" size={12} /></button>
          <button class="label" title="insert {quote(f)}" onclick={() => ctl.insert(quote(f))}>
            <SourceIcon type={f.replace(/\.(gz|zst)$/, "").split(".").pop() ?? ""} /><span>{f}</span>
          </button>
        </div>
        {#if open[`f:${f}`]}
          {@render described(script)}
        {/if}
      {/each}
      {/if}
    </section>
  {/if}

  {#if connections.length}
    <section>
      {@render head("connections", "Connections", "database", String(connections.length))}
      {#if !folded.connections}
      {#each connections as c (c.name)}
        {@const script = `SHOW TABLES FROM ${c.name};`}
        <div class="item">
          <button class="twist" class:open={open[`c:${c.name}`]} onclick={() => toggle(`c:${c.name}`, script)} aria-label="tables"><Icon name="chevron" size={12} /></button>
          <button class="label" title={ctl.connectionTypes.get(c.name) ?? "connection"} onclick={() => ctl.insert(c.name)}>
            <SourceIcon type={ctl.connectionTypes.get(c.name) ?? ""} /><span>{c.name}</span>
          </button>
        </div>
        {#if open[`c:${c.name}`]}
          {@const a = answers[script]}
          {#if a === "loading" || !a}
            <p class="empty">asking {c.name}…</p>
          {:else if a.error}
            <p class="empty err">{a.error}</p>
          {:else}
            {@const cat = catalog(c.name, a)}
            {#if cat.total > 12}
              <div class="cat-filter">
                <Icon name="search" size={12} />
                <input
                  placeholder="Filter {nf.format(cat.total)} tables"
                  value={catFilter[c.name] ?? ""}
                  oninput={(e) => ((catFilter[c.name] = e.currentTarget.value), (catLimit[c.name] = PAGE))}
                  onkeydown={(e) => e.key === "Escape" && catFilter[c.name] && (e.stopPropagation(), (catFilter[c.name] = ""))}
                />
                {#if catFilter[c.name]}<span class="count">{nf.format(cat.hits.length)}</span>{/if}
              </div>
            {/if}
            <div class="catalog" class:long={cat.total > 12}>
              {#each cat.shown as t (t.ref)}
                <div class="item sub">
                  <button class="twist" class:open={open[`r:${t.ref}`]} onclick={() => toggle(`r:${t.ref}`, `DESCRIBE ${t.ref};`)} aria-label="columns"><Icon name="chevron" size={12} /></button>
                  <button class="label" title="insert {t.ref}" onclick={() => ctl.insert(t.ref)}><span>{t.label}</span></button>
                </div>
                {#if open[`r:${t.ref}`]}
                  {@render described(`DESCRIBE ${t.ref};`)}
                {/if}
              {:else}
                <p class="empty">{cat.total ? "no table matches" : "no tables"}</p>
              {/each}
              {#if cat.hits.length > cat.shown.length}
                <div class="more">
                  <span>{nf.format(cat.shown.length)} of {nf.format(cat.hits.length)}</span>
                  <button onclick={() => (catLimit[c.name] = cat.shown.length + PAGE)}>Show {PAGE} more</button>
                  <button onclick={() => (catLimit[c.name] = cat.hits.length)}>All</button>
                </div>
              {/if}
            </div>
          {/if}
        {/if}
      {/each}
      {/if}
    </section>
  {/if}

  <section>
    {@render head("secrets", "Secrets", "key", missingSecrets ? `${missingSecrets} not set` : "", !!missingSecrets)}
    {#if !folded.secrets}
      <button class="col decl entry" onclick={() => (ctl.secrets = true)}>
        <span class="cname"><Icon name="lock" size={14} />{ctl.secretRefs.size ? `${ctl.secretRefs.size} used by this notebook` : "Manage secrets"}</span><i>Open</i>
      </button>
    {/if}
  </section>

  <section>
    {@render head("ai", "AI access", "sparkle")}
    {#if !folded.ai}
      <button class="col decl entry" onclick={() => (ctl.ai = true)}>
        <span class="cname"><Icon name="plug" size={14} />{aiLevel === "off" ? "Off" : aiLevel ? `MCP clients can ${aiLevel}` : "MCP clients"}</span><i>Open</i>
      </button>
    {/if}
  </section>

  {#if others.length}
    <section>
      {@render head("declared", "Declared", "symbol-variable", String(others.length))}
      {#if !folded.declared}
        {#each others as d (d.kind + d.name)}
          <button class="col decl" onclick={() => ctl.insert(declLabel(d))}>
            <span class="cname"><Icon name={DECL_ICON[d.kind] ?? "symbol-misc"} size={14} />{declLabel(d)}</span><i>{d.kind}</i>
          </button>
        {/each}
      {/if}
    </section>
  {/if}
</aside>

{#snippet head(key: string, label: string, icon: string, count = "", warn = false)}
  <SectionHead {label} {icon} {count} {warn} open={!folded[key]} ontoggle={() => fold(key)} />
{/snippet}

{#snippet described(script: string)}
  {@const a = answers[script]}
  {#if a === "loading" || !a}
    <p class="empty">reading…</p>
  {:else if a.error}
    <p class="empty err">{a.error}</p>
  {:else}
    {#each a.rows as row}
      <button class="col" onclick={() => ctl.insert(col(a, row, "column"))}>
        <span class="cname"><Icon name={typeIcon(col(a, row, "type"))} size={14} />{col(a, row, "column")}</span><i>{col(a, row, "type")}</i>
      </button>
    {/each}
  {/if}
{/snippet}

<style>
  aside {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    font-size: 0.7812rem;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--muted);
    border: 1px solid var(--hair);
    border-radius: 6px;
    padding: 0 0.5rem;
    background: var(--surface);
  }
  .search input {
    border: 0;
    background: none;
    padding: 0.3125rem 0;
    width: 100%;
    font-size: 0.7812rem;
    outline: none;
  }
  .cname {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
  }
  .cname :global(i) {
    color: var(--wb-fg-muted, var(--muted));
  }
  .item {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
  }
  .item.sub {
    padding-left: 0.875rem;
  }
  .twist {
    display: grid;
    place-items: center;
    width: 1.375rem;
    height: 1.75rem;
    padding: 0;
    color: var(--muted);
  }
  .twist :global(i) {
    transition: transform 0.15s var(--ease);
  }
  .twist.open :global(i) {
    transform: rotate(90deg);
  }
  .label {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
    flex: 1;
    min-height: 1.75rem;
    padding: 0 0.375rem;
    color: var(--ink-2);
    text-align: left;
    font-family: var(--mono);
    font-size: 0.75rem;
  }
  .label span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .label :global(i) {
    color: var(--muted);
  }
  .meta {
    color: var(--muted);
    font-size: 0.6875rem;
  }
  .jump {
    width: 1.25rem;
    height: 1.25rem;
  }
  .col {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    width: 100%;
    min-height: 1.625rem;
    padding: 0 0.5rem 0 2.625rem;
    font: 0.72rem var(--mono);
    color: var(--ink-2);
    text-align: left;
  }
  .col span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .col i {
    font-style: normal;
    color: var(--muted);
    white-space: nowrap;
  }
  .decl {
    padding-left: 0.5rem;
  }
  .cat-filter {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0.125rem 0 0.25rem 1.5rem;
    padding: 0 0.5rem;
    border: 1px solid var(--hair);
    border-radius: 5px;
    color: var(--muted);
    background: var(--surface);
  }
  .cat-filter input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: none;
    padding: 0.25rem 0;
    font-size: 0.75rem;
    outline: none;
  }
  .cat-filter .count {
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
  }
  /* a long catalog scrolls in its own box, so the sections below stay in reach */
  .catalog.long {
    max-height: 20rem;
    overflow-y: auto;
    overscroll-behavior: contain;
    border-bottom: 1px solid var(--hair);
  }
  .more {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem 0.375rem 1.5rem;
    font-size: 0.72rem;
    color: var(--muted);
  }
  .more span {
    flex: 1;
    font-variant-numeric: tabular-nums;
  }
  .more button {
    font-size: 0.72rem;
    padding: 0.125rem 0.375rem;
    color: var(--accent);
  }
  /* a section's single action row: as tall as a table row */
  .entry {
    min-height: 1.75rem;
    font-family: var(--sans);
    font-size: 0.8125rem;
  }
  .empty {
    margin: 2px 0 2px 1.25rem;
    color: var(--muted);
    font-size: 0.75rem;
  }
  .err {
    color: var(--critical);
  }
</style>
