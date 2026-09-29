<script lang="ts">
  import { onMount } from "svelte";
  import { isDark, tidyLogAxes, vegaConfig } from "../lib/vegatheme";

  // A Vega-Lite spec drawn with the app's theme: from Altair / df.plot in a
  // notebook or its report. vega loads on first use.
  interface Props {
    spec: Record<string, any>;
    height?: number;
    /** Selections named after these PARAMs set them: `alt.selection_point(name="region", fields=["region"])`. */
    params?: string[];
    /** A named selection picked a value (null when cleared). */
    onparam?: (name: string, value: unknown) => void;
  }
  let { spec, height, params = [], onparam }: Props = $props();

  /** A point selection's value: `{ field: [v, ...] }`; the first field's first value, if it names fields. */
  function selected(v: unknown): unknown {
    if (!v || typeof v !== "object") return null;
    const [key, vals] = Object.entries(v as Record<string, unknown>).find(([k]) => k !== "vlPoint" && !k.startsWith("_")) ?? [];
    return key && Array.isArray(vals) && vals.length ? vals[0] : null;
  }

  let host: HTMLDivElement;
  let error = $state("");

  async function draw() {
    const { default: embed } = await import("vega-embed");
    const s = $state.snapshot(spec) as Record<string, any>; // a plain copy, whether spec is reactive or not
    // fill the width we are given unless the spec fixes one; theme wins over none, not over the spec's own.
    // Only a single or layered view can: a composite one (Altair's `a | b`, `a & b`, facets) fitted to
    // the container is laid out zero wide, so it keeps its own sizes
    const composite = ["facet", "hconcat", "vconcat", "concat", "repeat"].some((k) => s[k] != null);
    if (!composite) {
      if (s.width == null) s.width = "container";
      s.autosize ??= { type: "fit-x", contains: "padding" };
    }
    if (height != null && s.height == null && !composite) s.height = height;
    s.config = mergeDeep(vegaConfig(), s.config ?? {});
    tidyLogAxes(s);
    // Altair's defaults are its own look; ours replace them unless the chart asks otherwise
    delete s.config.view?.continuousWidth;
    try {
      const result = await embed(host, s as any, {
        actions: { export: true, source: false, compiled: false, editor: false },
        renderer: "svg",
        tooltip: { theme: isDark() ? "dark" : "light" },
      });
      error = "";
      const has = (name: string) => {
        try {
          result.view.signal(name); // throws for a signal the chart doesn't have
          return true;
        } catch {
          return false;
        }
      };
      if (onparam) for (const p of params) if (has(p)) result.view.addSignalListener(p, (_: string, v: unknown) => onparam(p, selected(v)));
      return result;
    } catch (e: any) {
      error = e.message;
    }
  }

  function mergeDeep(base: any, over: any): any {
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
      out[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" ? mergeDeep(base[k], v) : v;
    }
    return out;
  }

  onMount(() => {
    let current: Awaited<ReturnType<typeof draw>>;
    let alive = true;
    const redraw = async () => {
      current?.finalize();
      const r = await draw();
      if (alive) current = r;
      else r?.finalize();
    };
    redraw();
    // follow light / dark
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", redraw);
    return () => {
      alive = false;
      mq.removeEventListener("change", redraw);
      current?.finalize();
    };
  });
</script>

<div class="vega" bind:this={host}></div>
{#if error}<pre class="error">{error}</pre>{/if}

<style>
  .vega {
    width: 100%;
    /* a composite chart keeps its own size, which may be wider than the column */
    overflow-x: auto;
  }
  .vega :global(.vega-embed) {
    width: 100%;
  }
  .vega :global(.vega-embed summary) {
    opacity: 0;
    transition: opacity 0.14s var(--ease);
  }
  .vega:hover :global(.vega-embed summary) {
    opacity: 0.7;
  }
  .error {
    color: var(--critical);
    font-size: 0.75rem;
  }
  /* the tooltip vega-embed draws, in the app's hand */
  :global(#vg-tooltip-element) {
    font-family: var(--sans) !important;
    font-size: 0.75rem !important;
    background: var(--surface) !important;
    color: var(--ink) !important;
    border: 1px solid var(--hair) !important;
    border-radius: 6px !important;
    box-shadow: var(--shadow-lg) !important;
  }
  :global(#vg-tooltip-element td.key) {
    color: var(--muted) !important;
  }
</style>
