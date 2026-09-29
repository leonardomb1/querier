<script lang="ts">
  import { api, type Commit } from "../lib/api";
  import { ago } from "../lib/format";
  import { layout } from "../lib/gitgraph";
  import type { NotebookCtl } from "../lib/notebook.svelte";
  import { zoom } from "../lib/zoom.svelte";
  import Icon from "./Icon.svelte";

  // The history as a graph, as Git Graph draws it: every branch, remote and tag,
  // each commit on its lane, merges and forks where they happen. Narrow (the side
  // bar): one line per commit. Wide (its own tab): Git Graph's columns.
  let { ctl, onopen, wide = false }: { ctl: NotebookCtl; onopen: (hash: string) => void; wide?: boolean } = $props();

  let commits = $state<Commit[] | null>(null);
  $effect(() => {
    void ctl.git?.head?.hash; // reload after each commit, pull or switch
    void ctl.git?.branch;
    if (!ctl.git?.tracked) return;
    api.git.log(ctl.name).then((c) => (commits = c)).catch(() => (commits = []));
  });

  const graph = $derived(commits ? layout(commits) : { rows: [], width: 1 });
  // Git Graph's palette: a colour per lane, the same top to bottom
  const COLORS = ["#0085d9", "#d9008f", "#00c20a", "#d98500", "#a300d9", "#e03c3c", "#00b3a8", "#c738e8", "#6fb800", "#dc5b23", "#6f24d6", "#c9a400"];
  const colorOf = (i: number) => COLORS[i % COLORS.length];
  const ROW = $derived(zoom.px(22));
  const LANE = $derived(zoom.px(12));
  const x = (lane: number) => LANE * lane + LANE / 2 + 2;
  const svgWidth = $derived(x(graph.width - 1) + LANE / 2 + 4);

  /** A curve (or a straight line) from lane a at y1 to lane b at y2. */
  function path(a: number, b: number, y1: number, y2: number) {
    const x1 = x(a);
    const x2 = x(b);
    if (x1 === x2) return `M${x1} ${y1}V${y2}`;
    const m = (y1 + y2) / 2;
    return `M${x1} ${y1}C${x1} ${m} ${x2} ${m} ${x2} ${y2}`;
  }

  const REF_ICON = { head: "git-branch", branch: "git-branch", remote: "cloud", tag: "tag" } as const;
  function tip(c: Commit) {
    const when = new Date(c.date).toLocaleString();
    return `${c.subject}\n${c.author} · ${when} · ${c.short}${c.cells.length ? `\nCells: ${c.cells.join(", ")}` : ""}${c.parents.length > 1 ? `\nMerge of ${c.parents.length} parents` : ""}`;
  }
</script>

{#if !ctl.git?.tracked}
  <p class="empty">History starts once the notebook is tracked with git.</p>
{:else if !commits}
  <p class="empty">Reading history…</p>
{:else if !commits.length}
  <p class="empty">No commits yet.</p>
{:else}
  <ol class="graph" class:wide style:--row="{ROW}px">
    {#if wide}
      <li class="columns" aria-hidden="true">
        <span style:width="{Math.max(svgWidth, 48)}px">Graph</span><span class="grow">Description</span><span class="c-date">Date</span><span class="c-author">Author</span><span class="c-hash">Commit</span>
      </li>
    {/if}
    {#each commits as c, i (c.hash)}
      {@const r = graph.rows[i]}
      <li>
        <button onclick={() => onopen(c.hash)} title={tip(c)}>
          <svg width={wide ? Math.max(svgWidth, 48) : svgWidth} height={ROW} aria-hidden="true">
            {#each r.top as s}<path d={path(s.from, s.to, 0, ROW / 2)} stroke={colorOf(s.color)} />{/each}
            {#each r.bottom as s}<path d={path(s.from, s.to, ROW / 2, ROW)} stroke={colorOf(s.color)} />{/each}
            {#if c.head}
              <circle cx={x(r.lane)} cy={ROW / 2} r={LANE / 2.6} fill="var(--wb-side, var(--page))" stroke={colorOf(r.color)} stroke-width="2" />
            {:else}
              <circle cx={x(r.lane)} cy={ROW / 2} r={LANE / 3.4} fill={colorOf(r.color)} />
            {/if}
          </svg>
          <span class="desc">
            {#each c.refs as ref (ref.kind + ref.name)}
              <span class="ref {ref.kind}" style:--c={colorOf(r.color)} title={ref.kind === "head" ? `${ref.name}, checked out` : ref.name}>
                <Icon name={REF_ICON[ref.kind]} size={12} />{ref.name}
              </span>
            {/each}
            <span class="subject" class:merge={c.parents.length > 1}>{c.subject}</span>
          </span>
          {#if wide}
            <span class="c-date">{new Date(c.date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
            <span class="c-author">{c.author}</span>
            <span class="c-hash">{c.short}</span>
          {:else}
            <span class="when">{ago(c.date)}</span>
          {/if}
        </button>
      </li>
    {/each}
  </ol>
{/if}

<style>
  .empty {
    margin: 0.5rem 0.25rem;
    color: var(--wb-fg-muted, var(--muted));
    font-size: 0.8125rem;
  }
  ol {
    list-style: none;
    margin: 0 0 0 -0.5rem;
    padding: 0;
  }
  button {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    width: 100%;
    height: var(--row);
    padding: 0 0.375rem 0 0;
    border-radius: 0;
    text-align: left;
    color: var(--wb-fg, var(--ink));
    font-size: 0.8125rem;
  }
  button:hover {
    background: var(--wb-list-hover, var(--hover));
  }
  button:active {
    transform: none;
  }
  svg {
    flex: none;
    display: block;
    overflow: visible;
  }
  svg path {
    fill: none;
    stroke-width: 2;
  }
  .desc {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .subject {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .subject.merge {
    color: var(--wb-fg-muted, var(--muted));
  }
  .ref {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    flex: none;
    max-width: 9rem;
    height: 1.125rem;
    padding: 0 0.3rem;
    border-radius: 3px;
    font-size: 0.7rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--wb-fg, var(--ink));
    border: 1px solid color-mix(in srgb, var(--c) 70%, transparent);
    background: color-mix(in srgb, var(--c) 18%, transparent);
  }
  .ref.head {
    font-weight: 600;
    background: color-mix(in srgb, var(--c) 35%, transparent);
  }
  .ref.remote,
  .ref.tag {
    border-style: dashed;
    background: none;
  }
  .when {
    flex: none;
    font-size: 0.7rem;
    color: var(--wb-fg-dim, var(--muted));
  }
  /* in the side bar, the date gives way first */
  ol:not(.wide) {
    container-type: inline-size;
  }
  @container (max-width: 17rem) {
    .when {
      display: none;
    }
  }
  /* the tab: Git Graph's columns */
  .wide {
    margin: 0;
  }
  .wide button {
    gap: 0.75rem;
    padding-right: 1rem;
  }
  .columns {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    height: 1.75rem;
    padding-right: 1rem;
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--wb-fg-muted, var(--muted));
    border-bottom: 1px solid var(--wb-border, var(--hair));
    position: sticky;
    top: 0;
    background: var(--wb-editor, var(--page));
    z-index: 1;
  }
  .columns span:first-child {
    flex: none;
    padding-left: 0.5rem;
  }
  .grow {
    flex: 1;
  }
  .c-date,
  .c-author,
  .c-hash {
    flex: none;
    font-size: 0.78rem;
    color: var(--wb-fg-muted, var(--muted));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .c-date {
    width: 10.5rem;
  }
  .c-author {
    width: 9rem;
  }
  .c-hash {
    width: 4.5rem;
    font-family: var(--mono);
  }
</style>
