<script lang="ts">
  import { fade } from "svelte/transition";
  import type { Table } from "apache-arrow";
  import { formatter, isNumeric, isTemporal, kindOf, numeric, plainText, typeLabel } from "../lib/format";
  import { copyText, writeClipboard, type Format } from "../lib/copy";
  import { highlights, marked, parseSearch, rowMatches } from "../lib/search";
  import { zoom } from "../lib/zoom.svelte";

  let {
    table,
    query = "",
    onmatches,
  }: {
    table: Table;
    query?: string;
    onmatches?: (n: number) => void;
  } = $props();

  // must match the rem heights in the styles below, at the current zoom
  const ROW = $derived(zoom.px(26));
  const HEIGHT = $derived(zoom.px(380));

  const cols = $derived(
    table.schema.fields.map((f) => {
      const fmt = formatter(f);
      const vec = table.getChild(f.name)!;
      const kind = kindOf(f.type);
      let chars = Math.max(f.name.length + 2, typeLabel(f.type).length);
      for (let i = 0; i < Math.min(table.numRows, 200); i++) chars = Math.max(chars, (fmt(vec.get(i)) ?? "null").length);
      return { field: f, name: f.name, type: typeLabel(f.type), kind, fmt, plain: plainText(f), vec, num: numeric(f), right: isNumeric(kind), width: zoom.px(Math.min(360, Math.max(56, chars * 7.6 + 22))) };
    }),
  );
  const template = $derived(`${zoom.px(48)}px ${cols.map((c) => `${c.width}px`).join(" ")}`);

  // -- sort
  let sort = $state<{ col: number; dir: 1 | -1 } | null>(null);
  function cycle(i: number) {
    sort = sort?.col !== i ? { col: i, dir: 1 } : sort.dir === 1 ? { col: i, dir: -1 } : null;
  }

  // -- rows: search (lib/search.ts), then sort, over the rows we have
  const terms = $derived(parseSearch(query, table.schema.fields.map((f) => f.name)));
  const marks = $derived(cols.map((c) => highlights(terms, c.name)));
  const indices = $derived.by(() => {
    let idx = Array.from({ length: table.numRows }, (_, i) => i);
    if (terms.length) {
      const sc = cols.map((c) => ({ ...c, numeric: c.right }));
      idx = idx.filter((i) => rowMatches(terms, sc, i));
    }
    if (sort) {
      const c = cols[sort.col];
      const dir = sort.dir;
      const key = (i: number) => {
        const v = c.vec.get(i);
        if (v == null) return null;
        return c.right || isTemporal(c.kind) ? c.num(v) : (c.fmt(v) ?? "");
      };
      const keys = new Map(idx.map((i) => [i, key(i)]));
      idx.sort((a, b) => {
        const x = keys.get(a);
        const y = keys.get(b);
        if (x == null) return y == null ? 0 : 1; // nulls last either way
        if (y == null) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * dir;
      });
    }
    return idx;
  });
  $effect(() => onmatches?.(indices.length));

  // -- virtual window
  let scrollTop = $state(0);
  const first = $derived(Math.max(0, Math.floor(scrollTop / ROW) - 10));
  const last = $derived(Math.min(indices.length, Math.ceil((scrollTop + HEIGHT) / ROW) + 10));
  const visible = $derived(indices.slice(first, last).map((row, k) => ({ row, at: first + k })));

  // -- selection: a rectangle of cells, as in a spreadsheet. Positions are in the
  // rows as shown (searched and sorted), so a new search or sort clears it.
  type Pos = { r: number; c: number };
  let anchor = $state<Pos | null>(null);
  let focus = $state<Pos | null>(null);
  let scroller = $state<HTMLDivElement>();
  const sel = $derived(
    anchor && focus
      ? { r0: Math.min(anchor.r, focus.r), r1: Math.max(anchor.r, focus.r), c0: Math.min(anchor.c, focus.c), c1: Math.max(anchor.c, focus.c) }
      : null,
  );
  const inSel = (r: number, c: number) => !!sel && r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1;
  const rowSel = (r: number) => !!sel && r >= sel.r0 && r <= sel.r1 && sel.c0 === 0 && sel.c1 === cols.length - 1;
  $effect(() => {
    void indices;
    anchor = focus = null;
  });

  function clamp(p: Pos): Pos {
    return { r: Math.max(0, Math.min(indices.length - 1, p.r)), c: Math.max(0, Math.min(cols.length - 1, p.c)) };
  }

  /** Keep the focused cell in view as the keyboard moves it. */
  function reveal(p: Pos) {
    if (!scroller) return;
    const top = p.r * ROW;
    const head = zoom.px(42);
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + ROW > scroller.scrollTop + scroller.clientHeight - head) scroller.scrollTop = top + ROW - scroller.clientHeight + head;
  }

  // dragging: from a cell (a block of cells) or the row numbers (whole rows)
  let dragRows = false;
  function hit(e: PointerEvent): Pos | null {
    const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-r]");
    if (!el || !scroller?.contains(el)) return null;
    return { r: Number(el.dataset.r), c: el.dataset.c == null ? -1 : Number(el.dataset.c) };
  }
  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    const p = hit(e);
    if (!p) return;
    e.preventDefault();
    scroller?.focus({ preventScroll: true });
    menu = null;
    dragRows = p.c < 0;
    const at = dragRows ? { r: p.r, c: cols.length - 1 } : p;
    if (e.shiftKey && anchor) focus = at;
    else {
      anchor = dragRows ? { r: p.r, c: 0 } : p;
      focus = at;
    }
    const move = (ev: PointerEvent) => {
      // near an edge, the table scrolls on under the pointer
      const box = scroller!.getBoundingClientRect();
      if (ev.clientY > box.bottom - ROW) scroller!.scrollTop += ROW;
      else if (ev.clientY < box.top + zoom.px(42) + ROW / 2) scroller!.scrollTop -= ROW;
      const q = hit(ev);
      if (!q) return;
      focus = dragRows ? { r: q.r, c: cols.length - 1 } : { r: q.r, c: q.c < 0 ? 0 : q.c };
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  }

  function keydown(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    // the notebook's shortcuts (and the page's Ctrl+A) stay out of a focused table;
    // Ctrl+K, Ctrl+B and the like still reach it
    if (!mod || ["a", "c"].includes(e.key.toLowerCase())) e.stopPropagation();
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      anchor = { r: 0, c: 0 };
      focus = { r: indices.length - 1, c: cols.length - 1 };
      return;
    }
    if (mod && e.key.toLowerCase() === "c" && sel) {
      e.preventDefault();
      copy("tsv");
      return;
    }
    if (e.key === "Escape" && (sel || menu)) {
      e.stopPropagation();
      anchor = focus = null;
      menu = null;
      return;
    }
    const step = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key] as [number, number] | undefined;
    const page = { PageUp: -1, PageDown: 1 }[e.key];
    if ((!step && !page) || !indices.length) return;
    e.preventDefault();
    const from = focus ?? { r: 0, c: 0 };
    const rows = page ? page * Math.floor(HEIGHT / ROW) : step![0] * (mod ? indices.length : 1);
    const next = clamp({ r: from.r + rows, c: from.c + (step ? step[1] * (mod ? cols.length : 1) : 0) });
    if (!e.shiftKey || !anchor) anchor = next;
    focus = next;
    reveal(next);
  }

  // -- copying the selection
  let menu = $state<{ x: number; y: number } | null>(null);
  let copied = $state("");
  let copiedTimer: ReturnType<typeof setTimeout>;

  function selection() {
    const s = sel!;
    const cs = cols.slice(s.c0, s.c1 + 1);
    const rows = indices.slice(s.r0, s.r1 + 1);
    return { cs, rows };
  }

  const text = (format: Format) => {
    const { cs, rows } = selection();
    return copyText(format, cs, rows);
  };

  async function copy(format: Format) {
    if (!sel) return;
    menu = null;
    const { cs, rows } = selection();
    try {
      await writeClipboard(text(format));
    } catch (e: any) {
      copied = `Couldn't copy: ${e.message}`;
      return;
    }
    const what = format === "sql" ? "values" : rows.length === 1 && cs.length === 1 ? "cell" : `${rows.length.toLocaleString()} row${rows.length === 1 ? "" : "s"}`;
    copied = `Copied ${what}`;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = ""), 1600);
  }

  function contextmenu(e: MouseEvent) {
    const p = hit(e as PointerEvent);
    if (!p) return;
    e.preventDefault();
    // right-click outside the selection selects what was clicked
    if (!sel || !(p.c < 0 ? rowSel(p.r) : inSel(p.r, p.c))) {
      anchor = p.c < 0 ? { r: p.r, c: 0 } : p;
      focus = p.c < 0 ? { r: p.r, c: cols.length - 1 } : p;
    }
    const box = wrapEl!.getBoundingClientRect();
    menu = { x: e.clientX - box.left, y: e.clientY - box.top };
  }
  let wrapEl = $state<HTMLDivElement>();

  // what the selection adds up to, as a spreadsheet's status bar shows
  const summary = $derived.by(() => {
    if (!sel || (sel.r0 === sel.r1 && sel.c0 === sel.c1)) return null;
    const { cs, rows } = selection();
    let count = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const c of cs) {
      if (!c.right) continue;
      for (const r of rows) {
        const x = c.num(c.vec.get(r));
        if (x == null || !Number.isFinite(x)) continue;
        count++;
        sum += x;
        if (x < min) min = x;
        if (x > max) max = x;
      }
    }
    const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    return {
      shape: `${rows.length.toLocaleString()} row${rows.length === 1 ? "" : "s"} × ${cs.length} column${cs.length === 1 ? "" : "s"}`,
      numbers: count ? [["sum", nf.format(sum)], ["avg", nf.format(sum / count)], ["min", nf.format(min)], ["max", nf.format(max)]] : [],
    };
  });

  // -- column stats, computed on first hover
  const statsCache = new WeakMap<object, Stat[]>();
  type Stat = [string, string];
  let hovered = $state<number | null>(null);
  let hoverX = $state(0);
  let hoverTimer: ReturnType<typeof setTimeout>;

  function stats(i: number): Stat[] {
    const c = cols[i];
    const cached = statsCache.get(c);
    if (cached) return cached;
    const n = table.numRows;
    let nulls = 0;
    const counts = new Map<string, number>();
    let min: any = null;
    let max: any = null;
    let sum = 0;
    let numbers = 0;
    for (let r = 0; r < n; r++) {
      const v = c.vec.get(r);
      if (v == null) {
        nulls++;
        continue;
      }
      const text = c.fmt(v) ?? "";
      counts.set(text, (counts.get(text) ?? 0) + 1);
      const x = c.right || isTemporal(c.kind) ? c.num(v) : null;
      if (x != null) {
        if (min == null || x < min[0]) min = [x, v];
        if (max == null || x > max[0]) max = [x, v];
        if (c.right) {
          sum += x;
          numbers++;
        }
      }
    }
    // one decimal, so 998 of 1,000 reads 99.8% rather than 100%
    const pct = (k: number) => (n ? `${((k / n) * 100).toFixed(1).replace(/\.0$/, "")}%` : "0%");
    const out: Stat[] = [
      ["nulls", nulls ? `${nulls.toLocaleString()} (${pct(nulls)})` : "none"],
      ["distinct", counts.size.toLocaleString()],
    ];
    if (min) out.push(["min", c.fmt(min[1]) ?? ""], ["max", c.fmt(max[1]) ?? ""]);
    if (numbers) out.push(["mean", new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(sum / numbers)]);
    if (!c.right && !isTemporal(c.kind) && counts.size < n) {
      const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3);
      for (const [v, k] of top) {
        const flat = v.replace(/\s+/g, " ").trim();
        const shown = !flat ? "(empty)" : `“${flat.length > 18 ? flat.slice(0, 17) + "…" : flat}”`;
        out.push([shown, `${k.toLocaleString()} (${pct(k)})`]);
      }
    }
    statsCache.set(c, out);
    return out;
  }

  function enter(i: number, e: PointerEvent) {
    clearTimeout(hoverTimer);
    const x = (e.currentTarget as HTMLElement).offsetLeft;
    hoverTimer = setTimeout(() => {
      hovered = i;
      hoverX = x;
    }, 350);
  }
  function leave() {
    clearTimeout(hoverTimer);
    hovered = null;
  }
</script>

<svelte:window onpointerdown={(e) => menu && !(e.target as HTMLElement).closest(".menu") && (menu = null)} />

<div class="wrap" bind:this={wrapEl}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="scroll"
    style:max-height="{HEIGHT + zoom.px(44)}px"
    onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
    role="grid"
    aria-multiselectable="true"
    tabindex="0"
    bind:this={scroller}
    onkeydown={keydown}
    oncontextmenu={contextmenu}
  >
    <div class="row head" style:grid-template-columns={template}>
      <span class="idx">#</span>
      {#each cols as c, i}
        <button
          class="th"
          class:right={c.right}
          class:sorted={sort?.col === i}
          onclick={() => cycle(i)}
          onpointerenter={(e) => enter(i, e)}
          onpointerleave={leave}
          aria-label="{c.name}, {c.type}. Sort{sort?.col === i ? (sort.dir === 1 ? ', now ascending' : ', now descending') : ''}"
        >
          <span class="th-name">
            <b>{c.name}</b>{#if sort?.col === i}<em aria-hidden="true">{sort.dir === 1 ? "↑" : "↓"}</em>{/if}
          </span>
          <i>{c.type}</i>
        </button>
      {/each}
    </div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="body" style:height="{indices.length * ROW}px" onpointerdown={down}>
      {#each visible as { row, at } (row)}
        <div class="row" class:picked={rowSel(at)} style:grid-template-columns={template} style:top="{at * ROW}px" role="row">
          <span class="idx" data-r={at} title="Select the row; drag for more">{row + 1}</span>
          {#each cols as c, ci}
            {@const v = c.fmt(c.vec.get(row))}
            <span
              class="td"
              class:right={c.right}
              class:null={v == null}
              class:sel={inSel(at, ci)}
              class:focus={focus?.r === at && focus?.c === ci}
              data-r={at}
              data-c={ci}
              title={v ?? "null"}
              role="gridcell"
              aria-selected={inSel(at, ci)}
              >{#if v != null && marks[ci].length}{#each marked(v, marks[ci]) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}{:else}{v ?? "null"}{/if}</span
            >
          {/each}
        </div>
      {/each}
    </div>
  </div>
  {#if summary || copied}
    <div class="summary" transition:fade={{ duration: 100 }}>
      {#if copied}
        <span class="copied">{copied}</span>
      {:else if summary}
        <span>{summary.shape}</span>
        {#each summary.numbers as [k, v]}<span><i>{k}</i> {v}</span>{/each}
        <span class="hint">Ctrl+C to copy · right-click for more</span>
      {/if}
    </div>
  {/if}
  {#if menu && sel}
    {@const oneCol = sel.c0 === sel.c1}
    <div class="menu" role="menu" style:left="{menu.x}px" style:top="{menu.y}px" transition:fade={{ duration: 80 }}>
      <button role="menuitem" onclick={() => copy("tsv")}>Copy <kbd>Ctrl+C</kbd></button>
      <button role="menuitem" onclick={() => copy("tsv-head")}>Copy with headers</button>
      <hr />
      <button role="menuitem" onclick={() => copy("csv")}>Copy as CSV</button>
      <button role="menuitem" onclick={() => copy("markdown")}>Copy as Markdown table</button>
      <button role="menuitem" onclick={() => copy("json")}>Copy as JSON</button>
      {#if oneCol}<button role="menuitem" onclick={() => copy("sql")}>Copy values as SQL list <kbd>IN (…)</kbd></button>{/if}
      <hr />
      <button role="menuitem" onclick={() => ((anchor = { r: 0, c: 0 }), (focus = { r: indices.length - 1, c: cols.length - 1 }), (menu = null))}>
        Select all <kbd>Ctrl+A</kbd>
      </button>
    </div>
  {/if}
  {#if hovered != null}
    <div class="stats" transition:fade={{ duration: 120 }} style:left="{Math.max(0, hoverX)}px">
      <div class="stats-title"><b>{cols[hovered].name}</b> <span>{cols[hovered].type}</span></div>
      {#each stats(hovered) as [k, v]}
        <div class="stat"><span>{k}</span><b>{v}</b></div>
      {/each}
      <div class="stats-hint">
        {sort?.col === hovered ? `Sorted ${sort.dir === 1 ? "ascending" : "descending"} · click to ${sort.dir === 1 ? "reverse" : "clear"}` : "Click to sort"}
      </div>
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
  }
  .scroll {
    overflow: auto;
    border: 1px solid var(--hair);
    border-radius: 8px;
    background: var(--surface);
    font-size: 0.7812rem;
    width: fit-content;
    max-width: 100%;
  }
  .row {
    /* as wide as all its columns: a sticky cell only sticks inside its own row's box */
    width: max-content;
    min-width: 100%;
    display: grid;
    height: 1.625rem;
    align-items: center;
    white-space: nowrap;
  }
  .td,
  .idx {
    padding: 0 0.625rem;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .head {
    position: sticky;
    top: 0;
    z-index: 1;
    height: 2.625rem;
    background: var(--surface);
    border-bottom: 1px solid var(--grid);
  }
  .th {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    height: 100%;
    line-height: 1.25;
    padding: 0 0.625rem;
    border-radius: 0;
    text-align: left;
    min-width: 0;
  }
  .th.right {
    align-items: flex-end;
  }
  /* the name gives way to "…", the sort arrow never does */
  .th-name {
    display: flex;
    align-items: baseline;
    gap: 0.25rem;
    max-width: 100%;
    min-width: 0;
  }
  .th b {
    min-width: 0;
    font-weight: 600;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .th em {
    flex: none;
    font-style: normal;
    color: var(--accent);
  }
  .th i {
    font-style: normal;
    font-size: 0.6875rem;
    color: var(--muted);
  }
  .body {
    position: relative;
    user-select: none;
    cursor: cell;
  }
  .scroll:focus {
    outline: none;
  }
  .scroll:focus-visible {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent);
  }
  mark {
    background: color-mix(in srgb, var(--warning, #eda100) 35%, transparent);
    color: inherit;
    border-radius: 2px;
  }
  .td.sel {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
  }
  /* the cell the keyboard moves from */
  .scroll:focus .td.focus {
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }
  .body .idx {
    cursor: e-resize;
  }
  .body .row.picked .idx {
    color: var(--accent);
    background: linear-gradient(color-mix(in srgb, var(--accent) 16%, transparent), color-mix(in srgb, var(--accent) 16%, transparent)), var(--surface);
  }
  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
    margin-top: 0.375rem;
    font-size: 0.72rem;
    color: var(--ink-2);
    font-variant-numeric: tabular-nums;
  }
  .summary i {
    font-style: normal;
    color: var(--muted);
  }
  .summary .hint {
    color: var(--muted);
    margin-left: auto;
  }
  .summary .copied {
    color: var(--good, var(--ink));
  }
  .menu {
    position: absolute;
    z-index: 20;
    min-width: 13rem;
    padding: 0.25rem;
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: 8px;
    box-shadow: var(--shadow-lg);
    font-size: 0.8125rem;
  }
  .menu button {
    display: flex;
    width: 100%;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.3rem 0.625rem;
    border-radius: 5px;
    text-align: left;
    color: var(--ink);
  }
  .menu button:hover,
  .menu button:focus-visible {
    background: var(--hover);
  }
  .menu kbd {
    font: 0.72rem var(--mono);
    color: var(--muted);
  }
  .menu hr {
    border: 0;
    border-top: 1px solid var(--hair);
    margin: 0.25rem 0;
  }
  .body .row {
    position: absolute;
    left: 0;
    min-width: 100%;
  }
  .body .row:nth-child(even) {
    background: color-mix(in srgb, var(--surface-2) 60%, transparent);
  }
  .body .row:hover {
    background: var(--sel);
  }
  .right {
    text-align: right;
  }
  .idx,
  .null {
    color: var(--muted);
  }
  /* the row number stays put while wide tables scroll sideways */
  .idx {
    position: sticky;
    left: 0;
    z-index: 1;
    align-self: stretch;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    font-size: 0.6875rem;
    background: var(--surface);
    box-shadow: 1px 0 0 var(--grid);
  }
  .body .row:nth-child(even) .idx {
    background: color-mix(in srgb, var(--surface-2) 60%, var(--surface));
  }
  .body .row:hover .idx {
    background: linear-gradient(var(--sel), var(--sel)), var(--surface);
  }
  .head .idx {
    z-index: 2;
  }
  .stats {
    position: absolute;
    top: 2.875rem;
    z-index: 10;
    min-width: 12.5rem;
    max-width: 17.5rem;
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: 8px;
    box-shadow: var(--shadow-lg);
    padding: 0.5rem 0.625rem;
    font-size: 0.75rem;
    pointer-events: none;
  }
  .stats-title {
    margin-bottom: 0.25rem;
  }
  .stats-title span {
    color: var(--muted);
  }
  .stat {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    color: var(--ink-2);
  }
  .stat span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .stats-hint {
    margin-top: 0.375rem;
    padding-top: 0.375rem;
    border-top: 1px solid var(--hair);
    color: var(--muted);
    font-size: 0.72rem;
  }
  .stat b {
    font-weight: 600;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
