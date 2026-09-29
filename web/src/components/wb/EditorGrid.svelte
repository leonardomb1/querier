<script lang="ts">
  import { layoutRects, type Sash } from "../../lib/layout";
  import type { NotebookCtl } from "../../lib/notebook.svelte";
  import type { TemplateCtl } from "../../lib/template.svelte";
  import type { Workbench } from "../../lib/workbench.svelte";
  import EditorGroup from "./EditorGroup.svelte";

  // The editor area: every group placed where the layout puts it, and a sash
  // between each pair of neighbours. Groups are positioned, not nested, so a split
  // never remounts an editor (the notebook keeps its scroll, a cell its cursor).
  let { ctl, wb, tpl, ondragging }: { ctl: NotebookCtl; wb: Workbench; tpl: TemplateCtl; ondragging: (on: boolean) => void } = $props();

  const laid = $derived(layoutRects(wb.layout));
  const pct = (n: number) => `${n * 100}%`;
  /** px: no group gets smaller than this while a sash is dragged */
  const MIN = 120;

  let area = $state<HTMLDivElement>();
  function drag(e: PointerEvent, s: Sash) {
    if (e.button !== 0) return;
    e.preventDefault();
    ondragging(true);
    const box = area!.getBoundingClientRect();
    const row = s.node.dir === "row";
    const px = (row ? box.width : box.height) * s.extent; // the split's own length, px
    const total = s.node.sizes.reduce((a, b) => a + b, 0);
    const pair = s.node.sizes[s.index] + s.node.sizes[s.index + 1];
    const start = row ? e.clientX : e.clientY;
    const a0 = s.node.sizes[s.index];
    const min = Math.min(pair / 2, (MIN / px) * total);
    const move = (ev: PointerEvent) => {
      const d = (((row ? ev.clientX : ev.clientY) - start) / px) * total;
      const a = Math.min(pair - min, Math.max(min, a0 + d));
      s.node.sizes[s.index] = a;
      s.node.sizes[s.index + 1] = pair - a;
    };
    const up = () => {
      ondragging(false);
      wb.save();
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  }
  /** a double click shares the two sides equally, as VS Code's */
  function even(s: Sash) {
    const pair = s.node.sizes[s.index] + s.node.sizes[s.index + 1];
    s.node.sizes[s.index] = s.node.sizes[s.index + 1] = pair / 2;
    wb.save();
  }
</script>

<div class="grid" bind:this={area}>
  {#each wb.groups as g (g.id)}
    {@const r = laid.groups.get(g.id)}
    {#if r}
      <div class="cell" class:at-left={r.x > 0} class:at-top={r.y > 0} style:left={pct(r.x)} style:top={pct(r.y)} style:width={pct(r.w)} style:height={pct(r.h)}>
        <EditorGroup {ctl} {wb} {tpl} id={g.id} />
      </div>
    {/if}
  {/each}
  {#each laid.sashes as s (s)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="sash"
      class:v={s.node.dir === "row"}
      class:h={s.node.dir === "col"}
      style:left={pct(s.rect.x)}
      style:top={pct(s.rect.y)}
      style:width={s.node.dir === "row" ? null : pct(s.rect.w)}
      style:height={s.node.dir === "col" ? null : pct(s.rect.h)}
      onpointerdown={(e) => drag(e, s)}
      ondblclick={() => even(s)}
    ></div>
  {/each}
</div>

<style>
  .grid {
    position: relative;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .cell {
    position: absolute;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .cell > :global(.group) {
    flex: 1;
    min-height: 0;
  }
  /* a hairline between groups: the one on the left or above draws none */
  .cell.at-left {
    border-left: 1px solid var(--wb-border);
  }
  .cell.at-top {
    border-top: 1px solid var(--wb-border);
  }
  .sash {
    position: absolute;
    z-index: 3;
    transition: background-color 0.1s 0.15s;
  }
  .sash.v {
    width: 4px;
    margin-left: -2px;
    cursor: col-resize;
  }
  .sash.h {
    height: 4px;
    margin-top: -2px;
    cursor: row-resize;
  }
  .sash:hover,
  .sash:active {
    background: var(--wb-accent);
  }
</style>
