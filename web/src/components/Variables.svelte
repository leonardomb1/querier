<script lang="ts">
  import Select from "./ui/Select.svelte";
  import type { Report } from "../lib/api";
  import type { Output } from "../lib/conn.svelte";
  import { arrowTable, formatter } from "../lib/format";
  import type { NotebookCtl } from "../lib/notebook.svelte";
  import type { Range } from "../lib/timerange";
  import Icon from "./Icon.svelte";
  import TimePicker from "./TimePicker.svelte";

  // The report's controls: its notebook's PARAMs, as text, dropdowns, or the time picker.
  let {
    ctl,
    variables,
    timePair,
    range,
    ontime,
  }: { ctl: NotebookCtl; variables: Report["variables"]; timePair: [string, string] | null; range: Range; ontime: (r: Range) => void } = $props();

  const others = $derived((ctl.book?.params ?? []).filter((p) => !timePair?.includes(p.name)));

  /** A dropdown's options: a fixed list, or the distinct values of a cell's column. */
  function optionsOf(name: string): string[] | null {
    const spec = variables?.[name];
    if (spec?.control !== "select" || !spec.source) return null;
    if ("values" in spec.source) return spec.source.values;
    const { cell, column } = spec.source;
    const out = (ctl.conn.runs[cell]?.outputs ?? []).findLast((o): o is Extract<Output, { type: "table" }> => o.type === "table" && o.name === cell);
    if (!out) return [];
    const table = arrowTable(out.arrow);
    const field = table.schema.fields.find((f) => f.name === column) ?? table.schema.fields[0];
    if (!field) return [];
    const fmt = formatter(field);
    const vec = table.getChild(field.name)!;
    const seen = new Set<string>();
    for (let i = 0; i < table.numRows && seen.size < 1000; i++) {
      const v = fmt(vec.get(i));
      if (v != null) seen.add(v);
    }
    return [...seen];
  }
  /** The empty choice: a PARAM defaulting to '' means "no filter", so it reads "All". */
  function defaultLabel(d: string | undefined): string {
    if (d == null) return "Choose…";
    const v = d.replace(/^'(.*)'$/s, "$1");
    return v === "" ? "All" : `Default (${v})`;
  }
</script>

<div class="vars">
  {#if timePair}<TimePicker {range} onchange={ontime} />{/if}
  {#each others as p (p.name)}
    {@const options = optionsOf(p.name)}
    {@const value = ctl.params[p.name] ?? ""}
    <label class="var" title="{p.type}, declared in {p.cell}">
      <span>{p.name}</span>
      {#if options}
        <Select
          {value}
          compact
          label={p.name}
          options={[
            { value: "", label: defaultLabel(p.default) },
            ...options.map((o) => ({ value: o, label: o })),
            ...(value && !options.includes(value) ? [{ value, label: value }] : []),
          ]}
          onchange={(v) => ctl.setParam(p.name, v)}
        />
      {:else}
        <input placeholder={p.default ?? "required"} {value} oninput={(e) => ctl.setParam(p.name, e.currentTarget.value)} size={Math.max(4, (value || p.default || "").length + 1)} />
      {/if}
      {#if value}
        <button class="icon clear" title="Clear" aria-label="Clear {p.name}" onclick={() => ctl.setParam(p.name, "")}><Icon name="x" size={12} /></button>
      {/if}
    </label>
  {/each}
</div>

<style>
  .vars {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
  }
  .var {
    display: inline-flex;
    align-items: center;
    height: 1.875rem;
    border: 1px solid var(--hair);
    border-radius: 6px;
    background: var(--surface);
    overflow: hidden;
  }
  .var > span {
    align-self: stretch;
    display: flex;
    align-items: center;
    padding: 0 0.5rem;
    font: 0.75rem var(--mono);
    color: var(--muted);
    background: var(--select-band);
    border-right: 1px solid var(--hair);
  }
  .var input,
  .var :global(.select) {
    border: 0;
    border-radius: 0;
    height: 100%;
    font: 0.8125rem var(--mono);
    padding: 0 0.5rem;
    background: none;
  }
  .var input:focus,
  .var :global(.select:focus-visible) {
    outline: none;
  }
  .clear {
    width: 1.5rem;
    height: 1.5rem;
    margin-right: 0.125rem;
  }
</style>
