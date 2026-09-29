<script lang="ts">
  import type { NotebookCtl } from "../../lib/notebook.svelte";
  import type { TemplateCtl } from "../../lib/template.svelte";
  import { tabKey, type Tab, type Workbench } from "../../lib/workbench.svelte";
  import Icon from "../Icon.svelte";
  import CellEditor from "./CellEditor.svelte";
  import NotebookEditor from "./NotebookEditor.svelte";
  import ReportEditor from "./ReportEditor.svelte";
  import TemplateEditor from "./TemplateEditor.svelte";
  import GitGraph from "../GitGraph.svelte";

  // One editor group: its tabs, the active editor's actions, and the editors. Every
  // open tab stays mounted (hidden when not active), so switching keeps its state.
  let { ctl, wb, tpl, index }: { ctl: NotebookCtl; wb: Workbench; tpl: TemplateCtl; index: number } = $props();

  const group = $derived(wb.groups[index]);
  const active = $derived(group?.tabs[group.active]);
  const activeKey = $derived(active ? tabKey(active) : "");
  const actions = $derived(wb.actions[activeKey] ?? []);
  const focusedGroup = $derived(wb.focused === index);

  const LANG_ICON = { sql: ["database", "var(--wb-lang-sql)"], python: ["symbol-method", "var(--wb-lang-py)"], md: ["markdown", "var(--wb-fg-muted)"] } as const;
  function look(t: Tab): { icon: string; color: string; label: string; title: string } {
    switch (t.kind) {
      case "notebook":
        return { icon: "notebook", color: "var(--wb-accent)", label: ctl.book?.title ?? ctl.name, title: "The notebook: every cell, with its output" };
      case "report":
        return { icon: "preview", color: "var(--wb-accent)", label: "Report", title: "The report, as its viewers see it" };
      case "template":
        return { icon: "file-code", color: "var(--wb-lang-svelte)", label: "report.svelte", title: "The report as a Svelte template" };
      case "graph":
        return { icon: "git-commit", color: "var(--wb-accent)", label: "Git Graph", title: "The history of every branch" };
      case "cell": {
        const c = ctl.cell(t.cell);
        const [icon, color] = LANG_ICON[c?.lang ?? "sql"];
        return { icon, color, label: c?.file ?? t.cell, title: c ? `${c.file} — ${t.cell}` : `${t.cell} (deleted)` };
      }
    }
  }

  // the active tab is always in view, however many are open
  let tabsEl = $state<HTMLDivElement>();
  $effect(() => {
    void group?.active;
    void group?.tabs.length;
    requestAnimationFrame(() => tabsEl?.querySelector<HTMLElement>(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  });

  function activate(i: number) {
    group.active = i;
    wb.focused = index;
    wb.save();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<section class="group" class:focused={focusedGroup && wb.groups.length > 1} onpointerdowncapture={() => (wb.focused = index)}>
  <div class="tabbar">
    <div class="tabs" role="tablist" bind:this={tabsEl}>
      {#each group.tabs as t, i (tabKey(t))}
        {@const l = look(t)}
        {@const key = tabKey(t)}
        <div
          class="tab"
          class:active={i === group.active}
          role="tab"
          tabindex="0"
          aria-selected={i === group.active}
          title={l.title}
          onclick={() => activate(i)}
          onkeydown={(e) => (e.key === "Enter" || e.key === " ") && activate(i)}
          onauxclick={(e) => e.button === 1 && wb.close(index, i)}
        >
          <span class="ticon" style:color={l.color}><Icon name={l.icon} size={15} /></span>
          <span class="label">{l.label}</span>
          <button
            class="close"
            class:dirty={wb.dirty[key]}
            title={wb.dirty[key] ? "Unsaved changes: close" : "Close"}
            aria-label="Close {l.label}"
            onclick={(e) => (e.stopPropagation(), wb.close(index, i))}
          >
            <span class="dot"></span><Icon name="close" size={14} />
          </button>
        </div>
      {/each}
    </div>
    <div class="actions">
      {#each actions as a (a.title)}
        <button class="icon" class:on={a.on} title={a.title} aria-label={a.title} disabled={a.disabled} onclick={a.run}><Icon name={a.icon} size={16} /></button>
      {/each}
      <button class="icon" title="Split the editor right" aria-label="Split the editor right" onclick={() => ((wb.focused = index), wb.splitRight())}>
        <Icon name="split-horizontal" size={16} />
      </button>
    </div>
  </div>

  <div class="editors">
    {#each group.tabs as t, i (tabKey(t))}
      {@const on = i === group.active}
      <div class="editor" class:hidden={!on}>
        {#if t.kind === "notebook"}
          <NotebookEditor {ctl} {wb} focused={on && focusedGroup} />
        {:else if t.kind === "cell"}
          {#if on}<CellEditor {ctl} {wb} cell={t.cell} focused={focusedGroup} />{/if}
        {:else if t.kind === "report"}
          <ReportEditor {ctl} {wb} {tpl} focused={on && focusedGroup} />
        {:else if t.kind === "template"}
          {#if on}<TemplateEditor {ctl} {wb} {tpl} focused={focusedGroup} />{/if}
        {:else if t.kind === "graph"}
          <div class="graph-tab"><GitGraph {ctl} onopen={(h) => (wb.commit = h)} wide /></div>
        {/if}
      </div>
    {/each}
  </div>
</section>

<style>
  .group {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--wb-editor);
  }
  .group.focused .tabbar {
    box-shadow: inset 0 -1px 0 var(--wb-border);
  }
  .tabbar {
    display: flex;
    flex: none;
    height: 2.1875rem;
    background: var(--wb-tab);
    border-bottom: 1px solid var(--wb-border);
  }
  .tabs {
    display: flex;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tab {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex: none;
    max-width: 16rem;
    padding: 0 0.375rem 0 0.625rem;
    font-size: 0.8125rem;
    color: var(--wb-fg-muted);
    background: var(--wb-tab);
    border-right: 1px solid var(--wb-border);
    cursor: pointer;
    user-select: none;
  }
  .tab.active {
    color: var(--wb-fg);
    background: var(--wb-tab-active);
    /* the active tab meets the editor: no line under it, an accent line over it */
    margin-bottom: -1px;
    border-bottom: 1px solid var(--wb-tab-active);
  }
  .tab.active::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 1px;
    background: var(--wb-accent);
  }
  .tab:focus-visible {
    outline: 1px solid var(--wb-accent);
    outline-offset: -1px;
  }
  .ticon {
    display: flex;
  }
  .label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .close {
    display: grid;
    place-items: center;
    width: 1.25rem;
    height: 1.25rem;
    padding: 0;
    border-radius: 4px;
    color: var(--wb-fg-muted);
    visibility: hidden;
  }
  .close :global(i) {
    grid-area: 1 / 1;
  }
  .dot {
    grid-area: 1 / 1;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: currentColor;
    display: none;
  }
  .tab.active .close,
  .tab:hover .close,
  .close.dirty {
    visibility: visible;
  }
  /* unsaved: a dot, which turns into the close button under the pointer */
  .close.dirty .dot {
    display: block;
  }
  .close.dirty :global(i) {
    visibility: hidden;
  }
  .close.dirty:hover .dot {
    display: none;
  }
  .close.dirty:hover :global(i) {
    visibility: visible;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 1px;
    margin-left: auto;
    padding: 0 0.375rem;
  }
  .actions button {
    width: 1.625rem;
    height: 1.625rem;
    color: var(--wb-fg);
    border-radius: 5px;
  }
  .actions button.on {
    background: var(--wb-list-active);
    outline: 1px solid var(--wb-accent);
    outline-offset: -1px;
  }
  .editors {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .editor {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }
  .editor.hidden {
    display: none;
  }
  .graph-tab {
    height: 100%;
    overflow: auto;
  }
</style>
