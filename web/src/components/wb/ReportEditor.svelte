<script lang="ts">
  import Select from "../ui/Select.svelte";
  import { marked } from "marked";
  import { untrack } from "svelte";
  import { flip } from "svelte/animate";
  import { cubicOut } from "svelte/easing";
  import { fade } from "svelte/transition";
  import { hash } from "../../../../shared/hash";
  import { WIDTHS, type Block, type Part } from "../../../../shared/report";
  import { nbUrl } from "../../lib/api";
  import { NotebookCtl, newBlockId } from "../../lib/notebook.svelte";
  import { blocksToTemplate, partsIn, templateCells } from "../../lib/report";
  import type { TemplateCtl } from "../../lib/template.svelte";
  import { paramText, resolve, type Range } from "../../lib/timerange";
  import type { Workbench } from "../../lib/workbench.svelte";
  import Icon from "../Icon.svelte";
  import Menu from "../Menu.svelte";
  import Outputs from "../Outputs.svelte";
  import Spinner from "../Spinner.svelte";
  import TemplateView from "../TemplateView.svelte";
  import Variables from "../Variables.svelte";
  import VariablesDialog from "../VariablesDialog.svelte";
  import PublishDialog from "../PublishDialog.svelte";
  import { ago } from "../../lib/format";

  // The report, as its viewers see it: blocks on a 12-column grid, each a cell's
  // output (all of it, or its chart, table or printed text) or text of its own —
  // or report.svelte, in a sandboxed frame. The controls for its PARAMs on top.
  let { ctl, wb, tpl, focused }: { ctl: NotebookCtl; wb: Workbench; tpl: TemplateCtl; focused: boolean } = $props();
  const name = $derived(ctl.name);

  const report = $derived(ctl.report);
  const cells = $derived(ctl.book?.cells ?? []);
  const blocks = $derived(ctl.blocks);
  const unused = $derived(cells.filter((c) => !ctl.inReport(c.name)));
  const langOf = (cell: string) => ctl.cell(cell)?.lang;
  let arranging = $state(false);

  // -- the template: report.svelte, shown in a sandboxed frame instead of the blocks
  const template = $derived(ctl.book?.template ?? null);
  const view = $derived(report.view ?? (template != null ? "template" : "blocks"));
  const built = $derived(tpl.built);
  const editTemplate = () => wb.open({ kind: "template" });
  async function writeTemplate() {
    const source = blocksToTemplate(
      $state.snapshot(blocks) as Block[],
      (cell) => (langOf(cell) === "md" ? (ctl.sources[cell] ?? ctl.cell(cell)?.source ?? "") : null),
      (m) => marked.parse(m) as string,
    );
    await tpl.create(source);
    wb.open({ kind: "template" });
  }
  const setView = (v: "blocks" | "template") => ctl.setReport((r) => (r.view = v));

  // -- arranging: each change is saved as the report's blocks
  const WIDTH_LABEL: Record<number, string> = { 3: "¼", 4: "⅓", 6: "½", 8: "⅔", 9: "¾", 12: "Full" };
  const PART_LABEL: Record<Part, string> = { chart: "Chart", table: "Table", text: "Printed" };

  function update(id: string, change: (b: Block) => void) {
    ctl.setBlocks((bs) => {
      const b = bs.find((x) => x.id === id);
      if (b) change(b);
      return bs;
    });
  }
  const removeBlock = (id: string) => ctl.setBlocks((bs) => bs.filter((b) => b.id !== id));
  function duplicate(id: string) {
    ctl.setBlocks((bs) => {
      const i = bs.findIndex((b) => b.id === id);
      bs.splice(i + 1, 0, { ...bs[i], id: newBlockId() });
      return bs;
    });
  }
  function shift(id: string, by: number) {
    ctl.setBlocks((bs) => {
      const i = bs.findIndex((b) => b.id === id);
      const j = Math.max(0, Math.min(bs.length - 1, i + by));
      bs.splice(j, 0, ...bs.splice(i, 1));
      return bs;
    });
  }
  const addCell = (cell: string) => ctl.setBlocks((bs) => [...bs, { id: newBlockId(), cell }]);
  function addText() {
    const id = newBlockId();
    ctl.setBlocks((bs) => [...bs, { id, text: "" }]);
    editingText = id;
  }
  let editingText = $state<string | null>(null);

  /** Show or leave out one part of a cell's output; at least one stays. */
  function togglePart(b: Block, p: Part, available: Part[]) {
    const cur = b.parts?.length ? b.parts.filter((x) => available.includes(x)) : available;
    const next = cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p];
    if (!next.length) return;
    update(b.id, (x) => (next.length === available.length ? delete x.parts : (x.parts = next)));
  }

  // dragging a block by its handle, dropped before or after another
  let grabbed = $state<string | null>(null);
  let dragging = $state<string | null>(null);
  let drop = $state<{ id: string; after: boolean } | null>(null);
  function dragover(e: DragEvent, b: Block) {
    if (!dragging || dragging === b.id) return (drop = null);
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // side by side (narrower than the row): before or after by x; stacked: by y
    const after = (b.width ?? 12) < 12 ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
    drop = { id: b.id, after };
  }
  function dropped(e: DragEvent) {
    e.preventDefault();
    const from = dragging;
    const at = drop;
    endDrag();
    if (!from || !at) return;
    ctl.setBlocks((bs) => {
      const [moved] = bs.splice(
        bs.findIndex((b) => b.id === from),
        1,
      );
      bs.splice(bs.findIndex((b) => b.id === at.id) + (at.after ? 1 : 0), 0, moved);
      return bs;
    });
  }
  function endDrag() {
    dragging = grabbed = null;
    drop = null;
  }

  // -- controls: the time range (from/to PARAMs), the others, and clicks that set one
  const params = $derived(ctl.book?.params ?? []);
  const paramNames = $derived(params.map((p) => p.name));
  const controlOf = (n: string) => report.variables?.[n]?.control;
  const timePair = $derived.by<[string, string] | null>(() => {
    const from = params.find((p) => /^from$/i.test(p.name));
    const to = params.find((p) => /^to$/i.test(p.name));
    if (!from || !to || (controlOf(from.name) ?? "time") !== "time" || (controlOf(to.name) ?? "time") !== "time") return null;
    return [from.name, to.name];
  });
  const range = $derived<Range>(report.time ?? { from: "now-7d", to: "now" });

  /** Bind the range to `from` / `to`, resolved against the clock now. */
  function applyTime() {
    if (!timePair) return;
    const now = new Date();
    timePair.forEach((n, i) => {
      const type = params.find((p) => p.name === n)?.type ?? "TIMESTAMP";
      const text = paramText(resolve(i === 0 ? range.from : range.to, now, i === 1), type);
      if (ctl.params[n] !== text) ctl.setParam(n, text);
    });
  }
  // only the range itself moves `now`: other controls changing must not shift it
  $effect(() => {
    void timePair;
    void range;
    untrack(applyTime);
  });
  const setTime = (r: Range) => ctl.setReport((x) => (x.time = r));

  /** A chart selection named after a PARAM was clicked: set it, or clear it when clicked again. */
  function onparam(param: string, value: unknown) {
    const decl = params.find((p) => p.name === param);
    if (!decl) return;
    let text = "";
    if (value != null) text = typeof value === "number" && /DATE|TIME/i.test(decl.type) ? paramText(new Date(value), decl.type) : String(value);
    ctl.setParam(param, ctl.params[param] === text ? "" : text);
  }
  let controlsOpen = $state(false);

  // -- runs: what the report shows (and what fills its dropdowns), when it is not fresh
  const targets = $derived(
    [
      ...new Set([
        ...(view === "template" ? templateCells(tpl.draft || (template ?? "")) : blocks.flatMap((b) => (b.cell ? [b.cell] : []))),
        ...Object.values(report.variables ?? {}).flatMap((v) => (v.source && "cell" in v.source ? [v.source.cell] : [])),
      ]),
    ].filter((c) => ctl.code.has(c)),
  );
  const isBusy = (c: string) => ["running", "queued"].includes(ctl.conn.runs[c]?.state ?? "");
  const busy = $derived(targets.some(isBusy));
  // a cell that just failed with this code and these values is not retried on its own
  const attempted = new Map<string, string>();
  const keyOf = (c: string) => hash(ctl.sources[c] ?? "") + JSON.stringify(ctl.bound);
  // the notebook's code when the report was last up to date: after an edit it waits for Refresh
  // rather than run code as it is typed; opening it and its controls still run what is due
  const codeNow = () => hash([...ctl.code].map((c) => `${c}\0${ctl.sources[c] ?? ctl.cell(c)?.source ?? ""}`).join("\0"));
  let settledCode = codeNow();
  let runTimer: ReturnType<typeof setTimeout>;
  $effect(() => {
    // nothing to run here (a public link's page: its last run is given)
    if (!ctl.conn.synced || !ctl.book || !ctl.mayRun) return;
    const code = codeNow();
    const due = targets.filter((c) => ctl.fresh[c] !== "fresh" && !isBusy(c) && attempted.get(c) !== keyOf(c));
    clearTimeout(runTimer);
    if (!due.length) {
      if (!targets.some(isBusy)) settledCode = code;
      return;
    }
    if (code !== settledCode) return;
    runTimer = setTimeout(() => {
      for (const c of due) attempted.set(c, keyOf(c));
      ctl.run(due);
    }, 350);
  });

  function refresh() {
    applyTime();
    settledCode = codeNow();
    for (const c of targets) attempted.set(c, keyOf(c));
    ctl.run(targets);
  }

  // -- auto-refresh while the tab is visible, and when the report last finished
  const INTERVALS: [string, number][] = [
    ["30s", 30e3],
    ["1m", 60e3],
    ["5m", 300e3],
    ["15m", 900e3],
    ["1h", 3600e3],
  ];
  $effect(() => {
    const ms = INTERVALS.find(([k]) => k === report.refresh)?.[1];
    if (!ms) return;
    const t = setInterval(() => document.visibilityState === "visible" && !busy && ctl.mayRun && refresh(), ms);
    return () => clearInterval(t);
  });
  let updatedAt = $state<number | null>(null);
  let wasBusy = false;
  $effect(() => {
    if (wasBusy && !busy) updatedAt = Date.now();
    wasBusy = busy;
  });
  let clock = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (clock = Date.now()), 15e3);
    return () => clearInterval(t);
  });
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const updated = $derived.by(() => {
    if (!updatedAt) return "";
    const m = Math.round((updatedAt - clock) / 60e3);
    return m === 0 ? "Updated just now" : `Updated ${rtf.format(m, "minute")}`;
  });

  // -- full screen: the report alone
  let kiosk = $state(false);
  let root = $state<HTMLDivElement>();
  function toggleKiosk() {
    kiosk = !kiosk;
    if (kiosk) root?.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  $effect(() => {
    const sync = () => !document.fullscreenElement && (kiosk = false);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  });
  function onkeydown(e: KeyboardEvent) {
    if (!focused || e.key !== "Escape" || (e.target as HTMLElement).closest("input, select, textarea")) return;
    if (arranging) arranging = false;
    else if (kiosk) toggleKiosk();
  }

  let publishing = $state(false);

  const exportUrl = (cell: string) => `${nbUrl(name)}/cells/${encodeURIComponent(cell)}/export${ctl.reportMode ? "?report=1" : ""}`;

  // the tab bar's actions for this editor
  $effect(() => {
    const edits = ctl.mayEdit;
    wb.actions.report = [
      { icon: "refresh", title: busy ? "Running…" : "Run the report's cells again", run: refresh, disabled: busy || !targets.length || !ctl.mayRun },
      ...(edits && view === "blocks" ? [{ icon: "edit", title: arranging ? "Done arranging" : "Arrange: what shows, and where", run: () => (arranging = !arranging), on: arranging }] : []),
      ...(edits
        ? [
            template == null
              ? { icon: "file-code", title: "Write the report as a Svelte template", run: writeTemplate }
              : { icon: "file-code", title: "Edit report.svelte", run: editTemplate },
          ]
        : []),
      ...(edits && template != null
        ? [
            view === "template"
              ? { icon: "layout", title: "Show the blocks layout instead", run: () => setView("blocks") }
              : { icon: "layout", title: "Show report.svelte instead", run: () => setView("template") },
          ]
        : []),
      // publishing it for its viewers: who may share the notebook
      ...(!ctl.reportMode && ctl.may("notebook.share") ? [{ icon: "cloud-upload", title: ctl.book?.published ? "Published: change or publish again…" : "Publish for viewers…", run: () => (publishing = true) }] : []),
      { icon: "screen-full", title: "Full screen  (Esc to leave)", run: toggleKiosk },
    ];
  });
</script>

<svelte:window {onkeydown} />

<div class="report" class:kiosk bind:this={root}>
<div class="page">
  {#if ctl.book?.description}<p class="description">{ctl.book.description}</p>{/if}

  {#if ctl.book}
    <div class="controls">
      {#if params.length}
        <Variables {ctl} variables={report.variables} {timePair} {range} ontime={setTime} />
      {/if}
      <span class="spacer"></span>
      {#if arranging && params.length}
        <button class="text" onclick={() => (controlsOpen = true)}><Icon name="settings" size={14} />Controls</button>
      {/if}
      {#if !ctl.reportMode && ctl.book.published && ctl.may("notebook.share")}
        <button class="pub" class:changed={ctl.book.published.changed} onclick={() => (publishing = true)} title="Its viewers get the published version">
          <Icon name={ctl.book.published.changed ? "warning" : "cloud"} size={13} />
          {ctl.book.published.changed ? "Changed since published" : `Published ${ago(ctl.book.published.at)}`}
        </button>
      {/if}
      {#if ctl.reportMode && ctl.book.published?.snapshotAt && !busy}
        <span class="note" title="Run by the server on a schedule, as {ctl.book.published.owner}">Updated {ago(ctl.book.published.snapshotAt)}</span>
      {:else if updated && !busy && !ctl.offline}<span class="note">{updated}</span>{/if}
      <!-- (a public link's page: the server refreshes it, as its link says) -->
      {#if !ctl.offline}<Select
        class="refresh"
        compact
        value={report.refresh ?? ""}
        title="Refresh automatically"
        label="Refresh automatically"
        disabled={!ctl.mayEdit}
        options={[{ value: "", label: "Auto-refresh off" }, ...INTERVALS.map(([k]) => ({ value: k, label: `Every ${k}` }))]}
        onchange={(v) => ctl.setReport((r) => (v ? (r.refresh = v) : delete r.refresh))}
      />{/if}
      {#if kiosk}
        <button class="icon" title="Leave full screen (Esc)" aria-label="Leave full screen" onclick={toggleKiosk}><Icon name="shrink" /></button>
      {/if}
    </div>
  {/if}

  {#if ctl.error}<p class="error">{ctl.error}</p>{/if}

  {#if view === "template"}
    {#if built?.error}
      <div class="empty">
        <p>The template doesn't build.</p>
        <p class="template-error">{built.error.line ? `line ${built.error.line} — ` : ""}{built.error.message}</p>
        <button class="chip" onclick={editTemplate}>Edit report.svelte</button>
      </div>
    {:else if built}
      <TemplateView {ctl} version={built.version} token={built.token} cells={targets} onerror={(e) => (tpl.frameError = e)} />
    {:else}
      <div class="waiting"><Spinner size={16} /></div>
    {/if}
  {:else}
  {#if !blocks.length}
    <div class="empty">
      <p>Nothing in this report yet.</p>
      <p class="muted">Add cells or text with <b>Arrange</b>, or from a cell's <b>⋯</b> menu in the notebook.</p>
    </div>
  {/if}

  <div class="blocks" class:arranging>
    {#each blocks as b, i (b.id)}
      {@const run = b.cell ? ctl.conn.runs[b.cell] : undefined}
      {@const isMd = b.cell != null && langOf(b.cell) === "md"}
      {@const available = run ? partsIn(run.outputs) : []}
      {@const missing = b.cell != null && !langOf(b.cell)}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <section
        class="block"
        class:dragging={dragging === b.id}
        class:drop-before={drop?.id === b.id && !drop.after}
        class:drop-after={drop?.id === b.id && drop.after}
        class:narrow={(b.width ?? 12) < 12}
        style:--span={b.width ?? 12}
        draggable={arranging && grabbed === b.id}
        ondragstart={(e) => {
          dragging = b.id;
          e.dataTransfer?.setData("text/plain", b.id);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        }}
        ondragover={(e) => dragover(e, b)}
        ondrop={dropped}
        ondragend={endDrag}
        animate:flip={{ duration: 200, easing: cubicOut }}
      >
        {#if arranging}
          <div class="handle" transition:fade={{ duration: 100 }}>
            <button
              class="icon grip"
              title="Drag to move"
              aria-label="Move {b.cell ?? 'text'}"
              onpointerdown={() => (grabbed = b.id)}
              onpointerup={() => !dragging && (grabbed = null)}><Icon name="grip" size={14} /></button
            >
            <span class="cell-name">{b.cell ?? "text"}</span>
            <span class="widths" role="group" aria-label="Width">
              {#each WIDTHS as w}
                <button class:on={(b.width ?? 12) === w} title="{WIDTH_LABEL[w] === 'Full' ? 'The full row' : `${WIDTH_LABEL[w]} of the row`}" onclick={() => update(b.id, (x) => (w === 12 ? delete x.width : (x.width = w)))}
                  >{WIDTH_LABEL[w]}</button
                >
              {/each}
            </span>
            <Menu
              title="Block"
              items={[
                { label: b.title == null ? "Add a title" : "Remove the title", run: () => update(b.id, (x) => (x.title == null ? (x.title = "") : delete x.title)) },
                { label: b.caption == null ? "Add a caption" : "Remove the caption", run: () => update(b.id, (x) => (x.caption == null ? (x.caption = "") : delete x.caption)) },
                "-",
                { label: "Move earlier", disabled: i === 0, run: () => shift(b.id, -1) },
                { label: "Move later", disabled: i === blocks.length - 1, run: () => shift(b.id, 1) },
                { label: "Duplicate", run: () => duplicate(b.id) },
                "-",
                { label: "Remove from the report", danger: true, run: () => removeBlock(b.id) },
              ]}
            />
          </div>
          {#if available.length > 1}
            <div class="parts" role="group" aria-label="What to show">
              {#each available as p}
                {@const on = !b.parts?.length || b.parts.includes(p)}
                <button class="chip" class:on onclick={() => togglePart(b, p, available)} aria-pressed={on}>{PART_LABEL[p]}</button>
              {/each}
            </div>
          {/if}
        {/if}

        {#if b.title != null}
          {#if arranging}
            <input class="title-edit" placeholder="Title" value={b.title} onchange={(e) => update(b.id, (x) => (x.title = e.currentTarget.value))} />
          {:else if b.title}
            <h3 class="block-title">{b.title}</h3>
          {/if}
        {/if}

        {#if b.cell == null}
          {#if arranging && editingText === b.id}
            <!-- svelte-ignore a11y_autofocus -->
            <textarea
              class="text-edit"
              value={b.text}
              placeholder="Markdown: ## a heading, **bold**, lists…"
              autofocus
              rows={Math.max(3, (b.text ?? "").split("\n").length + 1)}
              onchange={(e) => update(b.id, (x) => (x.text = e.currentTarget.value))}
              onblur={() => (editingText = null)}
            ></textarea>
          {:else}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div class="prose" class:editable={arranging} onclick={() => arranging && (editingText = b.id)}>
              {#if b.text}{@html marked.parse(b.text)}{:else if arranging}<p class="muted">Click to write…</p>{/if}
            </div>
          {/if}
        {:else if missing}
          <p class="muted small">There's no cell <code>{b.cell}</code> any more.</p>
        {:else if isMd}
          <div class="prose">{@html marked.parse(ctl.sources[b.cell] ?? ctl.cell(b.cell)?.source ?? "")}</div>
        {:else if run?.outputs.length}
          <div class:dim={isBusy(b.cell)}>
            <Outputs
              {run}
              cell={b.cell}
              show={b.parts}
              exportUrl={ctl.offline ? undefined : exportUrl(b.cell)}
              onsearch={ctl.offline ? undefined : (terms) => ctl.conn.filter(b.cell!, terms)}
              onprofile={ctl.offline ? undefined : () => ctl.conn.profile(b.cell!)}
              params={paramNames}
              {onparam}
              onstop={() => ctl.interrupt()}
            />
          </div>
        {:else if isBusy(b.cell) || !ctl.conn.synced}
          <div class="waiting"><Spinner size={16} /></div>
        {:else if arranging}
          <p class="muted small">No output.</p>
        {/if}

        {#if b.caption != null}
          {#if arranging}
            <input class="caption-edit" placeholder="Caption" value={b.caption} onchange={(e) => update(b.id, (x) => (x.caption = e.currentTarget.value))} />
          {:else if b.caption}
            <p class="caption">{b.caption}</p>
          {/if}
        {/if}
      </section>
    {/each}
  </div>

  {#if arranging}
    <div class="add-row" transition:fade={{ duration: 120 }}>
      <button class="chip" onclick={addText}><Icon name="plus" size={12} />Text</button>
      <Menu
        label="+ Cell"
        title="Add a cell's output"
        items={cells.map((c) => ({ label: c.name, hint: ctl.inReport(c.name) ? "in the report" : c.lang, run: () => addCell(c.name) }))}
      />
      {#if unused.length}
        <span class="muted">Not shown:</span>
        {#each unused as c (c.name)}
          <button class="chip" onclick={() => addCell(c.name)} title="Add to the report"><Icon name="plus" size={12} />{c.name}</button>
        {/each}
      {/if}
      {#if report.blocks}
        <button class="reset" onclick={() => ctl.setReport((r) => delete r.blocks)} title="Back to markdown and the cells nothing reads">Reset layout</button>
      {/if}
    </div>
  {/if}
  {/if}
</div>
</div>

{#if publishing}<PublishDialog {ctl} onclose={() => (publishing = false)} />{/if}
{#if controlsOpen}
  <VariablesDialog
    {ctl}
    variables={report.variables}
    onchange={(v) => ctl.setReport((r) => (Object.keys(v ?? {}).length ? (r.variables = v) : delete r.variables))}
    onclose={() => (controlsOpen = false)}
  />
{/if}

<style>
  .report {
    height: 100%;
    overflow: auto;
    background: var(--page);
  }
  .page {
    max-width: 96rem;
    margin: 0 auto;
    padding: 1rem 2rem 4rem;
  }
  .kiosk .page {
    padding-top: 1.5rem;
  }
  :global(.select.refresh) {
    height: 1.625rem;
  }
  .pub {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    height: 1.5rem;
    padding: 0 0.5rem;
    margin-right: 0.5rem;
    font-size: 0.75rem;
    color: var(--wb-fg-muted);
    border: 1px solid var(--wb-border);
    border-radius: 3px;
  }
  .pub:hover {
    color: var(--wb-fg);
    background: var(--wb-list-hover);
  }
  .pub.changed {
    color: var(--warning);
    border-color: color-mix(in srgb, var(--warning) 45%, var(--wb-border));
  }
  .note {
    color: var(--muted);
    font-size: 0.75rem;
    margin-right: 0.5rem;
  }

  .description {
    margin: 0 0 1rem;
    color: var(--ink-2);
    font-size: 0.875rem;
    max-width: 68ch;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
  }
  .spacer {
    flex: 1;
  }
  .controls .text {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8125rem;
    height: 1.875rem;
    padding: 0 0.625rem;
  }
  .error {
    color: var(--critical);
    font-size: 0.8125rem;
  }
  .empty {
    padding: 4rem 0;
    text-align: center;
  }
  .empty p {
    margin: 0.25rem 0;
  }
  .muted {
    color: var(--muted);
  }
  .small {
    font-size: 0.8125rem;
    margin: 0;
  }

  /* twelve columns: a block spans its width, and the next one sits beside it while they fit */
  .blocks {
    display: grid;
    grid-template-columns: repeat(12, minmax(0, 1fr));
    gap: 2rem 2.5rem;
  }
  .block {
    grid-column: span var(--span, 12);
    min-width: 0;
    position: relative;
  }
  @media (max-width: 56rem) {
    .block {
      grid-column: span 12;
    }
  }
  .block.dragging {
    opacity: 0.4;
  }
  .block.drop-before::before,
  .block.drop-after::after {
    content: "";
    position: absolute;
    background: var(--accent);
    border-radius: 2px;
  }
  /* stacked blocks: a line above or below; side by side: a bar at the side */
  .block:not(.narrow).drop-before::before {
    left: 0;
    right: 0;
    top: -1.1rem;
    height: 3px;
  }
  .block:not(.narrow).drop-after::after {
    left: 0;
    right: 0;
    bottom: -1.1rem;
    height: 3px;
  }
  .block.narrow.drop-before::before {
    top: 0;
    bottom: 0;
    left: -1.35rem;
    width: 3px;
  }
  .block.narrow.drop-after::after {
    top: 0;
    bottom: 0;
    right: -1.35rem;
    width: 3px;
  }
  .grip {
    cursor: grab;
    color: var(--muted);
    width: 1.5rem;
    height: 1.5rem;
  }
  .widths {
    display: inline-flex;
    border: 1px solid var(--hair);
    border-radius: 5px;
    overflow: hidden;
  }
  .widths button {
    font-size: 0.72rem;
    padding: 0.125rem 0.4rem;
    border-radius: 0;
    color: var(--muted);
    min-width: 1.6rem;
  }
  .widths button + button {
    border-left: 1px solid var(--hair);
  }
  .widths button.on {
    color: var(--ink);
    background: var(--hover);
    font-weight: 600;
  }
  .parts {
    display: flex;
    gap: 0.25rem;
    margin: -0.125rem 0 0.5rem;
  }
  .parts .chip {
    font-family: var(--sans);
    color: var(--muted);
    text-decoration: line-through;
  }
  .parts .chip.on {
    color: var(--ink);
    text-decoration: none;
    border-color: color-mix(in srgb, var(--accent) 45%, var(--hair));
  }
  .block-title {
    margin: 0 0 0.5rem;
    font-size: 1rem;
    font-weight: 600;
  }
  .caption {
    margin: 0.5rem 0 0;
    font-size: 0.78rem;
    color: var(--muted);
  }
  .title-edit,
  .caption-edit {
    width: 100%;
    margin: 0 0 0.5rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.875rem;
  }
  .title-edit {
    font-weight: 600;
  }
  .caption-edit {
    margin: 0.5rem 0 0;
    font-size: 0.78rem;
  }
  .text-edit {
    width: 100%;
    font: 0.8125rem/1.6 var(--mono);
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: 6px;
    padding: 0.5rem 0.625rem;
    resize: vertical;
  }
  .prose.editable {
    cursor: text;
    min-height: 2rem;
    border-radius: 4px;
  }
  .prose.editable:hover {
    background: var(--hover);
  }
  .template-error {
    margin: 0;
    color: var(--critical);
    font: 0.75rem var(--mono);
  }
  .add-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    margin-top: 2.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--hair);
    font-size: 0.75rem;
  }
  .add-row :global(button.text) {
    font-size: 0.75rem;
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--hair);
    border-radius: 5px;
    color: var(--ink-2);
  }
  .add-row .muted {
    margin: 0 0.25rem 0 0.75rem;
  }
  .add-row .reset {
    margin-left: auto;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .arranging .block {
    outline: 1px dashed var(--hair);
    outline-offset: 0.5rem;
    border-radius: 2px;
  }
  .handle {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-bottom: 0.5rem;
    font-size: 0.75rem;
  }
  .cell-name {
    flex: 1;
    font-family: var(--mono);
    color: var(--muted);
  }
  .dim {
    opacity: 0.55;
    transition: opacity 0.2s var(--ease);
  }
  .waiting {
    display: grid;
    place-items: center;
    min-height: 6rem;
    color: var(--muted);
  }

  .prose {
    line-height: 1.65;
    max-width: 68ch;
  }
  .prose :global(h1) {
    font-size: 1.5rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    margin: 0 0 0.5rem;
  }
  .prose :global(h2),
  .prose :global(h3) {
    font-size: 1rem;
    font-weight: 600;
    margin: 1rem 0 0.25rem;
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

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font: 0.75rem var(--mono);
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--hair);
    border-radius: 5px;
    color: var(--ink-2);
  }
</style>
