<script lang="ts">
  import { siApachearrow, siApacheparquet, siMysql, siPostgresql } from "simple-icons";
  import { LOGOS as MORE } from "../lib/logos";
  import { zoom } from "../lib/zoom.svelte";
  import Icon from "./Icon.svelte";

  // What a data source is, at a glance: its logo (Simple Icons, CC0; SQL Server
  // and StarRocks from lib/logos.ts, MIT), a generic mark otherwise. Logos keep
  // their brand colours, lifted in dark mode so they read on a dark surface; a
  // black (or grey) mark takes the text colour, so it inverts with the theme.
  let { type, size = 14 }: { type: string; size?: number } = $props();

  const SIMPLE: Record<string, { path: string; title: string; hex: string }> = {
    postgres: siPostgresql,
    postgresql: siPostgresql,
    mysql: siMysql,
    parquet: siApacheparquet,
    arrow: siApachearrow,
    feather: siApachearrow,
    ipc: siApachearrow,
    arrows: siApachearrow,
  };

  const key = $derived(type.toLowerCase());
  const logo = $derived(SIMPLE[key]);
  const more = $derived(MORE[key]);
  /** A colour with hardly any hue is drawn in the text colour instead. */
  function tint(hex: string | null | undefined) {
    const h = (hex ?? "").replace("#", "");
    if (h.length !== 6) return null;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return Math.max(r, g, b) - Math.min(r, g, b) < 32 ? null : `#${h}`;
  }
  const px = $derived(zoom.px(size));
</script>

{#if logo}
  {@const c = tint(logo.hex)}
  <svg class="logo" width={px} height={px} viewBox="0 0 24 24" fill="currentColor" role="img" aria-label={logo.title}>
    <title>{logo.title}</title>
    <path d={logo.path} class:brand={c} style:--c={c} />
  </svg>
{:else if more}
  <svg class="logo" width={px} height={px} viewBox={more.viewBox} fill="currentColor" role="img" aria-label={more.title}>
    <title>{more.title}</title>
    {#each more.paths as p}
      {@const c = tint(p.fill)}
      <path d={p.d} class:brand={c} style:--c={c} />
    {/each}
  </svg>
{:else if key === "http"}
  <span title="HTTP" class="plain"><Icon name="globe" {size} /></span>
{:else if ["csv", "tsv", "zip", "gz", "zst"].includes(key)}
  <span title={key.toUpperCase()} class="plain"><Icon name="file" {size} /></span>
{:else}
  <span title={type} class="plain"><Icon name="database" {size} /></span>
{/if}

<style>
  .logo,
  .plain {
    flex: none;
    display: inline-flex;
  }
  .logo {
    color: var(--ink-2);
  }
  .plain {
    color: var(--muted);
  }
  .brand {
    fill: oklch(from var(--c) min(l, 0.78) c h);
  }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme="light"])) .brand {
      fill: oklch(from var(--c) max(l, 0.72) c h);
    }
  }
  :global(:root[data-theme="dark"]) .brand {
    fill: oklch(from var(--c) max(l, 0.72) c h);
  }
</style>
