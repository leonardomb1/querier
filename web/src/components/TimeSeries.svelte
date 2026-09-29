<script lang="ts">
  // A small time series, drawn as SVG: an area under a line over the last
  // `window` seconds (or over what there is, when there is less, 30 s at least),
  // a gap where a value is missing, a crosshair with the value and its time under
  // the pointer, and the span it covers underneath.
  let {
    points,
    window,
    max,
    format,
    color = "var(--wb-accent)",
    height = 72,
    label,
  }: {
    points: { t: number; v: number | null }[];
    /** seconds shown, ending now (or at the last point) */
    window: number;
    /** the top of the scale */
    max: number;
    format: (v: number) => string;
    color?: string;
    height?: number;
    /** what it shows, for screen readers */
    label: string;
  } = $props();

  let width = $state(300);
  let hover = $state<number | null>(null);

  const end = $derived(Math.max(Date.now(), points.at(-1)?.t ?? 0));
  const first = $derived(points.find((p) => p.v != null && p.t >= end - window * 1000)?.t);
  /** seconds shown: the window, or less while there is less history */
  const span = $derived(first == null ? window : Math.min(window, Math.max(30, Math.ceil((end - first) / 1000))));
  const start = $derived(end - span * 1000);
  const ago = (s: number) => (s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`);
  const shown = $derived(points.filter((p) => p.t >= start - 4000));
  const x = (t: number) => ((t - start) / (end - start)) * width;
  const y = (v: number) => height - 2 - (Math.min(v, max) / (max || 1)) * (height - 6);

  /** runs of consecutive values, split where one is missing */
  const runs = $derived.by(() => {
    const out: { t: number; v: number }[][] = [];
    let cur: { t: number; v: number }[] = [];
    for (const p of shown) {
      if (p.v == null) {
        if (cur.length) out.push(cur);
        cur = [];
      } else cur.push({ t: p.t, v: p.v });
    }
    if (cur.length) out.push(cur);
    return out;
  });
  const line = (r: { t: number; v: number }[]) => r.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = (r: { t: number; v: number }[]) => `${line(r)}L${x(r.at(-1)!.t).toFixed(1)},${height}L${x(r[0].t).toFixed(1)},${height}Z`;

  const at = $derived.by(() => {
    if (hover == null || !shown.length) return null;
    const t = start + (hover / width) * (end - start);
    let best = shown[0];
    for (const p of shown) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return best.v == null ? null : best;
  });
  const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const id = `ts-${Math.random().toString(36).slice(2, 8)}`;
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="ts"
  bind:clientWidth={width}
  style:height="{height}px"
  onpointermove={(e) => (hover = e.clientX - e.currentTarget.getBoundingClientRect().left)}
  onpointerleave={() => (hover = null)}
>
  <svg {width} {height} role="img" aria-label={label}>
    <defs>
      <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color={color} stop-opacity="0.32" />
        <stop offset="1" stop-color={color} stop-opacity="0.02" />
      </linearGradient>
    </defs>
    <!-- quarter lines, faint -->
    {#each [0.25, 0.5, 0.75] as f}
      <line x1="0" x2={width} y1={y(max * f)} y2={y(max * f)} class="grid" />
    {/each}
    {#each runs as r, i (i)}
      <path d={area(r)} fill="url(#{id})" />
      <path d={line(r)} fill="none" stroke={color} stroke-width="1.5" stroke-linejoin="round" />
    {/each}
    {#if at}
      <line x1={x(at.t)} x2={x(at.t)} y1="0" y2={height} class="cross" />
      <circle cx={x(at.t)} cy={y(at.v!)} r="3" fill={color} />
    {/if}
  </svg>
  <div class="axis"><span>{ago(span)}</span><span>now</span></div>
  {#if at}
    <span class="tip" style:left="{Math.min(Math.max(x(at.t), 40), width - 40)}px">{format(at.v!)} · {clock(at.t)}</span>
  {:else if !runs.length}
    <span class="empty">No data yet</span>
  {/if}
</div>

<style>
  .ts {
    position: relative;
    width: 100%;
    margin-bottom: 1.125rem;
    cursor: crosshair;
  }
  .axis {
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1.125rem;
    display: flex;
    justify-content: space-between;
    font-size: 0.68rem;
    color: var(--wb-fg-dim);
    font-variant-numeric: tabular-nums;
  }
  svg {
    display: block;
    overflow: visible;
  }
  .grid {
    stroke: var(--wb-border);
    stroke-dasharray: 2 3;
  }
  .cross {
    stroke: var(--wb-fg-muted);
    stroke-width: 1;
  }
  path {
    transition: d 0.3s var(--ease);
  }
  .tip {
    position: absolute;
    top: -1.5rem;
    transform: translateX(-50%);
    padding: 0.0625rem 0.375rem;
    border-radius: 3px;
    font-size: 0.7rem;
    white-space: nowrap;
    color: var(--wb-fg);
    background: var(--wb-editor);
    border: 1px solid var(--wb-input-border);
    pointer-events: none;
    font-variant-numeric: tabular-nums;
  }
  .empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-size: 0.75rem;
    color: var(--wb-fg-dim);
  }
</style>
