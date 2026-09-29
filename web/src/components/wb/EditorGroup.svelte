<script lang="ts">
  import type { Side } from "../../lib/layout";
  import type { NotebookCtl } from "../../lib/notebook.svelte";
  import type { TemplateCtl } from "../../lib/template.svelte";
  import { tabKey, type Tab, type Workbench } from "../../lib/workbench.svelte";
  import Icon from "../Icon.svelte";
  import Menu, { type MenuItem } from "../Menu.svelte";
  import CellEditor from "./CellEditor.svelte";
  import NotebookEditor from "./NotebookEditor.svelte";
  import ReportEditor from "./ReportEditor.svelte";
  import TemplateEditor from "./TemplateEditor.svelte";
  import GitGraph from "../GitGraph.svelte";
  import SettingsTab from "./SettingsTab.svelte";

  // One editor group: its tabs, the active editor's actions, and the editors. Every
  // open tab stays mounted (hidden when not active), so switching keeps its state.
  // Tabs drag within the bar, to another group, or onto an edge of a group to split
  // it there; a right click has VS Code's tab menu.
  let { ctl, wb, tpl, id }: { ctl: NotebookCtl; wb: Workbench; tpl: TemplateCtl; id: number } = $props();

  const group = $derived(wb.group(id)!);
  const active = $derived(group?.tabs[group.active]);
  const activeKey = $derived(active ? tabKey(active) : "");
  const actions = $derived(wb.actions[activeKey] ?? []);
  const focusedGroup = $derived(wb.focused === id);

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
      case "settings":
        return { icon: "settings-gear", color: "var(--wb-fg-muted)", label: "Settings", title: "User, workspace and notebook settings" };
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
    wb.focused = id;
    wb.save();
  }

  // -- the tab menu (right click)
  let menu = $state<ReturnType<typeof Menu>>();
  let menuItems = $state<(MenuItem | "-")[]>([]);
  function contextMenu(e: MouseEvent, i: number) {
    e.preventDefault();
    activate(i);
    const n = group.tabs.length;
    menuItems = [
      { label: "Close", run: () => wb.close(id, i) },
      { label: "Close Others", disabled: n < 2, run: () => wb.closeOthers(id, i) },
      { label: "Close to the Right", disabled: i >= n - 1, run: () => wb.closeToRight(id, i) },
      { label: "Close All", run: () => wb.closeAll(id) },
      "-",
      { label: "Split Right", hint: "Ctrl+\\", run: () => wb.split("right", id) },
      { label: "Split Down", run: () => wb.split("down", id) },
      { label: "Split Left", run: () => wb.split("left", id) },
      { label: "Split Up", run: () => wb.split("up", id) },
    ];
    // on Linux the menu is asked for while the button is still down: its release,
    // outside the new popover, would close it at once, so it opens after
    const [x, y] = [e.clientX, e.clientY];
    if (e.buttons) addEventListener("pointerup", () => requestAnimationFrame(() => menu?.openAt(x, y)), { once: true });
    else menu?.openAt(x, y);
  }
  const groupMenu = $derived<(MenuItem | "-")[]>([
    { label: "Split Right", run: () => wb.split("right", id) },
    { label: "Split Down", run: () => wb.split("down", id) },
    "-",
    { label: "Close All", disabled: !group?.tabs.length, run: () => wb.closeAll(id) },
    { label: "Join All Groups", disabled: wb.groups.length < 2, run: () => wb.joinAll() },
    { label: "Even Out Group Sizes", disabled: wb.groups.length < 2, run: () => wb.evenOut() },
  ]);

  // -- dragging tabs: a place in this bar, or a zone of this editor area
  const DND = "application/x-querier-tab";
  let barAt = $state<number | null>(null);
  let zone = $state<Side | "center" | null>(null);
  function dragStart(e: DragEvent, i: number) {
    wb.drag = { tab: $state.snapshot(group.tabs[i]) as Tab, from: id, index: i };
    e.dataTransfer!.setData(DND, tabKey(group.tabs[i]));
    e.dataTransfer!.setData("text/plain", look(group.tabs[i]).label);
    e.dataTransfer!.effectAllowed = "move";
  }
  const dragEnd = () => ((wb.drag = null), (barAt = null), (zone = null));
  const dragging = (e: DragEvent) => !!wb.drag && !!e.dataTransfer?.types.includes(DND);

  function overTab(e: DragEvent, i: number) {
    if (!dragging(e)) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    barAt = e.clientX < r.left + r.width / 2 ? i : i + 1;
  }
  function overBar(e: DragEvent) {
    if (!dragging(e)) return;
    e.preventDefault();
    if (e.target === e.currentTarget) barAt = group.tabs.length;
  }
  function dropBar(e: DragEvent) {
    if (!wb.drag) return;
    e.preventDefault();
    const d = wb.drag;
    wb.drop({ group: id, at: barAt ?? group.tabs.length }, d.tab, d.from == null ? null : { group: d.from, index: d.index });
    dragEnd();
  }

  // the editor area: its outer thirds split it, its middle takes the tab in
  // (in the capture phase: a code editor below would take the drop as text)
  function overEditor(e: DragEvent) {
    if (!dragging(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const edge = Math.min(x, 1 - x, y, 1 - y);
    zone = edge > 0.25 ? "center" : edge === x ? "left" : edge === 1 - x ? "right" : edge === y ? "up" : "down";
  }
  function dropEditor(e: DragEvent) {
    if (!wb.drag || !zone) return;
    e.preventDefault();
    e.stopPropagation();
    const d = wb.drag;
    const from = d.from == null ? null : { group: d.from, index: d.index };
    wb.drop(zone === "center" ? { group: id } : { group: id, side: zone }, d.tab, from);
    dragEnd();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<section class="group" class:focused={focusedGroup && wb.groups.length > 1} onpointerdowncapture={() => (wb.focused = id)}>
  <div class="tabbar">
    <div class="tabs" role="tablist" tabindex="-1" bind:this={tabsEl} ondragover={overBar} ondragleave={(e) => e.target === e.currentTarget && (barAt = null)} ondrop={dropBar}>
      {#each group.tabs as t, i (tabKey(t))}
        {@const l = look(t)}
        {@const key = tabKey(t)}
        <div
          class="tab"
          class:active={i === group.active}
          class:drop-before={barAt === i}
          class:drop-after={barAt === i + 1 && i === group.tabs.length - 1}
          role="tab"
          tabindex="0"
          aria-selected={i === group.active}
          title={l.title}
          draggable="true"
          ondragstart={(e) => dragStart(e, i)}
          ondragend={dragEnd}
          ondragover={(e) => overTab(e, i)}
          onclick={() => activate(i)}
          oncontextmenu={(e) => contextMenu(e, i)}
          onkeydown={(e) => (e.key === "Enter" || e.key === " ") && activate(i)}
          onauxclick={(e) => e.button === 1 && wb.close(id, i)}
        >
          <span class="ticon" style:color={l.color}><Icon name={l.icon} size={15} /></span>
          <span class="label">{l.label}</span>
          <button
            class="close"
            class:dirty={wb.dirty[key]}
            title={wb.dirty[key] ? "Unsaved changes: close" : "Close"}
            aria-label="Close {l.label}"
            onclick={(e) => (e.stopPropagation(), wb.close(id, i))}
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
      <button
        class="icon"
        title="Split the editor right  (Ctrl+\); with Alt, down"
        aria-label="Split the editor"
        onclick={(e) => wb.split(e.altKey ? "down" : "right", id)}
      >
        <Icon name="split-horizontal" size={16} />
      </button>
      <Menu title="Views and more actions" items={groupMenu} />
    </div>
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="editors"
    ondragovercapture={overEditor}
    ondragleave={(e) => !(e.currentTarget as HTMLElement).contains(e.relatedTarget as globalThis.Node) && (zone = null)}
    ondropcapture={dropEditor}
  >
    {#if !group.tabs.length}
      <!-- every editor closed: what to open next, as VS Code's watermark -->
      <div class="watermark">
        <Icon name="notebook" size={96} />
        <dl>
          <dt>Open the notebook</dt>
          <dd><button onclick={() => wb.open({ kind: "notebook" })}>all cells</button></dd>
          <dt>Open the report</dt>
          <dd><button onclick={() => wb.open({ kind: "report" })}>report</button></dd>
          <dt>Show all commands</dt>
          <dd><button onclick={() => (ctl.palette = true)}><kbd>Ctrl</kbd>+<kbd>K</kbd></button></dd>
          <dt>Open settings</dt>
          <dd><button onclick={() => wb.openSettings()}><kbd>Ctrl</kbd>+<kbd>,</kbd></button></dd>
          <dt>Toggle the panel</dt>
          <dd><button onclick={() => wb.togglePanel()}><kbd>Ctrl</kbd>+<kbd>J</kbd></button></dd>
        </dl>
      </div>
    {/if}
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
        {:else if t.kind === "settings"}
          {#if on}<SettingsTab {ctl} {wb} />{/if}
        {:else if t.kind === "graph"}
          <div class="graph-tab"><GitGraph {ctl} onopen={(h) => (wb.commit = h)} wide /></div>
        {/if}
      </div>
    {/each}
    {#if zone}<div class="drop-zone {zone}"></div>{/if}
  </div>
</section>

<Menu trigger={false} bind:this={menu} items={menuItems} />

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
  .watermark {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2rem;
    color: color-mix(in srgb, var(--wb-fg) 8%, transparent);
    user-select: none;
  }
  .watermark dl {
    display: grid;
    grid-template-columns: auto auto;
    gap: 0.5rem 1rem;
    margin: 0;
    font-size: 0.8125rem;
  }
  .watermark dt {
    text-align: right;
    color: var(--wb-fg-muted);
  }
  .watermark dd {
    margin: 0;
  }
  .watermark dd button {
    padding: 0;
    color: var(--wb-fg-muted);
    font-size: 0.8125rem;
  }
  .watermark dd button:hover {
    background: none;
    color: var(--wb-fg);
  }
  .watermark kbd {
    font-size: 0.7rem;
  }
  .tab.drop-before::after,
  .tab.drop-after::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--wb-accent);
    z-index: 1;
  }
  .tab.drop-before::after {
    left: -1px;
  }
  .tab.drop-after::after {
    right: -1px;
  }
  .tabs {
    flex: 1;
  }
  /* where a dragged tab would land: VS Code's translucent overlay */
  .drop-zone {
    position: absolute;
    z-index: 5;
    pointer-events: none;
    background: color-mix(in srgb, var(--wb-accent) 22%, transparent);
    outline: 1px solid color-mix(in srgb, var(--wb-accent) 60%, transparent);
    outline-offset: -1px;
    transition: all 0.08s var(--ease);
  }
  .drop-zone.center {
    inset: 0;
  }
  .drop-zone.left {
    inset: 0 50% 0 0;
  }
  .drop-zone.right {
    inset: 0 0 0 50%;
  }
  .drop-zone.up {
    inset: 0 0 50% 0;
  }
  .drop-zone.down {
    inset: 50% 0 0 0;
  }
  .graph-tab {
    height: 100%;
    overflow: auto;
  }
</style>
