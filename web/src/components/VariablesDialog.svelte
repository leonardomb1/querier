<script lang="ts">
  import { cubicOut } from "svelte/easing";
  import { fade, scale } from "svelte/transition";
  import type { Report, VarSpec } from "../lib/api";
  import type { NotebookCtl } from "../lib/notebook.svelte";
  import Icon from "./Icon.svelte";

  // How each PARAM shows in the report.
  let {
    ctl,
    variables,
    onchange,
    onclose,
  }: { ctl: NotebookCtl; variables: Report["variables"]; onchange: (vars: Report["variables"]) => void; onclose: () => void } = $props();

  const params = $derived(ctl.book?.params ?? []);
  const cells = $derived(ctl.book?.cells.filter((c) => c.lang !== "md") ?? []);
  const isTime = (name: string) => /^(from|to)$/i.test(name);

  function set(name: string, spec: VarSpec | null) {
    const next = { ...(variables ?? {}) };
    if (spec) next[name] = spec;
    else delete next[name];
    onchange(next);
  }

  function control(name: string): VarSpec["control"] {
    return variables?.[name]?.control ?? (isTime(name) ? "time" : "text");
  }

  function columnsOf(cell: string): string[] {
    const out = (ctl.conn.runs[cell]?.outputs ?? []).findLast((o) => o.type === "table" && o.name === cell);
    return out?.type === "table" ? out.columns.map((c) => c.name) : [];
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") (e.stopPropagation(), onclose());
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" transition:fade={{ duration: 140 }} onclick={onclose} {onkeydown}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="dialog" role="dialog" aria-label="Variables" tabindex="-1" transition:scale={{ start: 0.97, duration: 160, easing: cubicOut }} onclick={(e) => e.stopPropagation()}>
    <header>
      <h2>Variables</h2>
      <button class="icon" aria-label="Close" onclick={onclose}><Icon name="x" /></button>
    </header>
    <p class="lede">The notebook's <code>PARAM</code>s, as the report shows them. A pair named <code>from</code> / <code>to</code> becomes the time picker.</p>

    {#if !params.length}
      <p class="empty">This notebook declares no <code>PARAM</code>s. Add one to a SQL cell, e.g. <code>PARAM region STRING DEFAULT 'north';</code></p>
    {/if}

    {#each params as p (p.name)}
      {@const c = control(p.name)}
      {@const spec = variables?.[p.name]}
      <section>
        <div class="head">
          <code class="name">${p.name}</code>
          <span class="type">{p.type}</span>
          <select
            value={c}
            onchange={(e) => {
              const v = e.currentTarget.value as VarSpec["control"];
              set(p.name, v === (isTime(p.name) ? "time" : "text") ? null : { control: v, source: v === "select" ? { values: [] } : undefined });
            }}
          >
            <option value="text">Text box</option>
            <option value="select">Dropdown</option>
            {#if isTime(p.name)}<option value="time">Time picker</option>{/if}
          </select>
        </div>
        {#if c === "select"}
          {@const src = spec?.source}
          <div class="source">
            <label>
              <span>Options</span>
              <select
                value={src && "cell" in src ? src.cell : ""}
                onchange={(e) => set(p.name, { control: "select", source: e.currentTarget.value ? { cell: e.currentTarget.value } : { values: [] } })}
              >
                <option value="">A fixed list</option>
                {#each cells as cell}<option value={cell.name}>From cell {cell.name}</option>{/each}
              </select>
            </label>
            {#if src && "cell" in src}
              <label>
                <span>Column</span>
                <select value={src.column ?? ""} onchange={(e) => set(p.name, { control: "select", source: { cell: src.cell, column: e.currentTarget.value || undefined } })}>
                  <option value="">The first</option>
                  {#each columnsOf(src.cell) as col}<option value={col}>{col}</option>{/each}
                </select>
              </label>
            {:else}
              <label class="grow">
                <span>Values, one per line</span>
                <textarea
                  rows="3"
                  value={src && "values" in src ? src.values.join("\n") : ""}
                  onchange={(e) => set(p.name, { control: "select", source: { values: e.currentTarget.value.split("\n").map((v) => v.trim()).filter(Boolean) } })}
                ></textarea>
              </label>
            {/if}
          </div>
        {/if}
      </section>
    {/each}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: var(--scrim);
    display: grid;
    place-items: start center;
    padding-top: 10vh;
  }
  .dialog {
    width: min(36rem, calc(100vw - 2rem));
    max-height: 80vh;
    overflow: auto;
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: 12px;
    box-shadow: var(--shadow-lg);
    padding: 1.25rem 1.5rem 1.5rem;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h2 {
    margin: 0;
    font-size: 1.0625rem;
    font-weight: 600;
  }
  .lede,
  .empty {
    margin: 0.375rem 0 1rem;
    font-size: 0.8125rem;
    color: var(--ink-2);
    line-height: 1.55;
  }
  section {
    padding: 0.875rem 0;
    border-top: 1px solid var(--hair);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }
  .name {
    font-weight: 600;
    font-size: 0.8125rem;
  }
  .type {
    flex: 1;
    font-size: 0.72rem;
    color: var(--muted);
  }
  .head select,
  .source select {
    height: 1.875rem;
    font-size: 0.8125rem;
  }
  .source {
    display: flex;
    gap: 0.75rem;
    margin-top: 0.625rem;
    flex-wrap: wrap;
  }
  .source label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.72rem;
    color: var(--muted);
  }
  .grow {
    flex: 1;
  }
  textarea {
    font: 0.8125rem var(--mono);
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: 6px;
    padding: 0.375rem 0.5rem;
  }
  code {
    font-size: 0.78rem;
  }
</style>
