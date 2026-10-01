<script lang="ts" module>
  import type { Kind } from "../lib/format";

  /** A column's type as an icon (codicons). */
  export const KIND_ICON: Record<Kind, string> = {
    int: "symbol-numeric",
    float: "symbol-numeric",
    decimal: "symbol-numeric",
    date: "calendar",
    timestamp: "calendar",
    time: "clock",
    bool: "symbol-boolean",
    string: "symbol-string",
    other: "symbol-misc",
  };
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import type { Term } from "../lib/search";
  import Icon from "./Icon.svelte";

  // One column's filter, as a spreadsheet's: for text, what it contains and a
  // checklist of its values; for numbers and dates, a range; for true/false, a
  // checklist. It becomes search terms (lib/search.ts), so a result longer than
  // the page holds is filtered whole, by the kernel.
  let {
    name,
    kind,
    values,
    partial,
    current,
    onapply,
    onclose,
  }: {
    name: string;
    kind: Kind;
    /** the values the page holds, most frequent first, with how often; null: empty cells */
    values: { value: string | null; count: number }[];
    /** the page holds part of the result: the checklist lists what it holds */
    partial: boolean;
    current: Term[];
    onapply: (terms: Term[]) => void;
    onclose: () => void;
  } = $props();

  const ranged = $derived(kind === "int" || kind === "float" || kind === "decimal" || kind === "date" || kind === "timestamp" || kind === "time");
  const listed = $derived(kind === "string" || kind === "bool" || kind === "other");
  const inputType = $derived(kind === "date" || kind === "timestamp" ? "date" : kind === "time" ? "time" : "number");

  // svelte-ignore state_referenced_locally
  let contains = $state(current.find((t) => t.op === "has")?.value ?? "");
  // svelte-ignore state_referenced_locally
  let from = $state(current.find((t) => t.op === ">=")?.value ?? "");
  // svelte-ignore state_referenced_locally
  let to = $state(current.find((t) => t.op === "<=")?.value ?? "");
  // svelte-ignore state_referenced_locally
  const chosen0 = current.find((t) => t.op === "in")?.values;
  // svelte-ignore state_referenced_locally
  let chosen = $state<Set<string | null>>(new Set(chosen0 ?? values.map((v) => v.value)));
  let find = $state("");
  const shown = $derived(values.filter((v) => !find || (v.value ?? "(empty)").toLowerCase().includes(find.toLowerCase())).slice(0, 300));
  const all = $derived(values.every((v) => chosen.has(v.value)));

  function toggle(v: string | null) {
    const next = new Set(chosen);
    next.has(v) ? next.delete(v) : next.add(v);
    chosen = next;
  }
  function apply() {
    const out: Term[] = [];
    if (contains.trim()) out.push({ col: name, op: "has", value: contains.trim(), not: false });
    if (ranged && from !== "") out.push({ col: name, op: ">=", value: String(from), not: false });
    if (ranged && to !== "") out.push({ col: name, op: "<=", value: String(to), not: false });
    if (listed && !all) out.push({ col: name, op: "in", value: "", values: [...chosen], not: false });
    onapply(out);
    onclose();
  }
  function clear() {
    onapply([]);
    onclose();
  }

  let box = $state<HTMLDivElement>();
  onMount(() => box?.querySelector<HTMLInputElement>("input")?.focus());
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="filter" role="dialog" aria-label="Filter {name}" tabindex="-1" bind:this={box} onkeydown={(e) => (e.key === "Escape" ? (e.stopPropagation(), onclose()) : e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type !== "checkbox" && apply())}>
  <header><Icon name={KIND_ICON[kind]} size={14} /><b title={name}>{name}</b></header>

  {#if kind === "string" || kind === "other"}
    <label class="line"><span>Contains</span><input bind:value={contains} placeholder="text" spellcheck="false" /></label>
  {/if}

  {#if ranged}
    <div class="range">
      <label class="line"><span>From</span><input type={inputType} step="any" bind:value={from} /></label>
      <label class="line"><span>To</span><input type={inputType} step="any" bind:value={to} /></label>
    </div>
  {/if}

  {#if listed && values.length}
    <div class="values">
      {#if values.length > 8}<input class="find" bind:value={find} placeholder="Find a value" spellcheck="false" aria-label="Find a value" />{/if}
      <label class="all"><input type="checkbox" checked={all} onchange={() => (chosen = all ? new Set() : new Set(values.map((v) => v.value)))} />(Select all)</label>
      <div class="list">
        {#each shown as v (v.value)}
          <label>
            <input type="checkbox" checked={chosen.has(v.value)} onchange={() => toggle(v.value)} />
            <span class="v" class:empty={v.value == null || v.value === ""}>{v.value == null ? "(empty)" : v.value === "" ? "(blank)" : v.value}</span>
            <span class="n">{v.count.toLocaleString()}</span>
          </label>
        {/each}
      </div>
      {#if partial}<p class="note">The values in the rows shown here; the filter applies to the whole result.</p>{/if}
    </div>
  {/if}

  <footer>
    <button class="btn" onclick={clear} disabled={!current.length}>Clear</button>
    <span class="grow"></span>
    <button class="btn" onclick={onclose}>Cancel</button>
    <button class="btn primary" onclick={apply} disabled={listed && !chosen.size}>Apply</button>
  </footer>
</div>

<style>
  .filter {
    position: absolute;
    top: 2.875rem;
    z-index: 12;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 16rem;
    padding: 0.625rem;
    font-size: 0.78rem;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    cursor: default;
    user-select: none;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--muted);
  }
  header b {
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .line {
    display: grid;
    grid-template-columns: 4rem minmax(0, 1fr);
    align-items: center;
    gap: 0.375rem;
    color: var(--muted);
  }
  .range {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  input:not([type="checkbox"]) {
    box-sizing: border-box;
    width: 100%;
    height: 1.625rem;
    padding: 0 0.4375rem;
    font: inherit;
    color: var(--ink);
    background: var(--page);
    border: 1px solid var(--hair);
    border-radius: 4px;
  }
  input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .values {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .values label {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-height: 1.375rem;
  }
  .all {
    color: var(--muted);
  }
  .list {
    max-height: 13rem;
    overflow: auto;
    border-top: 1px solid var(--hair);
    padding-top: 0.125rem;
  }
  .v {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .v.empty {
    font-style: italic;
    color: var(--muted);
  }
  .n {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .note {
    margin: 0.125rem 0 0;
    font-size: 0.6875rem;
    color: var(--muted);
  }
  footer {
    display: flex;
    gap: 0.375rem;
  }
  .grow {
    flex: 1;
  }
  .btn {
    height: 1.625rem;
    padding: 0 0.625rem;
    font-size: 0.78rem;
    border: 1px solid var(--hair);
    border-radius: 4px;
  }
  .btn.primary {
    color: #fff;
    background: var(--accent);
    border-color: var(--accent);
  }
</style>
