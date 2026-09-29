// The workbench around a notebook, VS Code's: an activity bar picks the side
// bar's view; editors open as tabs in groups laid out as a grid (split right or
// down, any number, resized by their sashes, tabs dragged between them); a panel
// below or beside them holds results and problems. Remembered per notebook.

import { evenOut, groupOrder, neighbour, removeFrom, sanitize, splitAt, type Node, type Side } from "./layout";

export type Tab =
  /** the cells, stacked: notebook mode */
  | { kind: "notebook" }
  /** one cell as a file: code mode */
  | { kind: "cell"; cell: string }
  /** the report, as its viewers see it */
  | { kind: "report" }
  /** report.svelte */
  | { kind: "template" }
  /** the git history as a graph, Git Graph's columns */
  | { kind: "graph" }
  /** the settings editor: user, workspace and notebook scopes */
  | { kind: "settings" };

export type View = "explorer" | "search" | "scm" | "data";
export type PanelTab = "results" | "problems";
export type PanelPosition = "bottom" | "right";

export interface Group {
  id: number;
  tabs: Tab[];
  active: number;
}

/** An action an editor puts at the right of its tab bar. */
export interface EditorAction {
  icon: string;
  title: string;
  run: () => void;
  /** a toggle that is on */
  on?: boolean;
  disabled?: boolean;
}

/** Where a dragged tab would land: into a group (at a place in its tabs), or beside it. */
export type DropZone = { group: number; at?: number } | { group: number; side: Side };

export const tabKey = (t: Tab) => (t.kind === "cell" ? `cell:${t.cell}` : t.kind);

interface Saved {
  groups: Group[];
  layout: Node;
  focused: number;
  view: View | null;
  panel: boolean;
  panelHeight: number;
  panelWidth: number;
  panelPosition: PanelPosition;
  panelMax: boolean;
  panelTab: PanelTab;
  /** before the grid: two groups side by side, divided here */
  split?: number;
}

function load(nb: string): Partial<Saved> {
  try {
    return JSON.parse(localStorage.getItem(`querier:wb:${nb}`) ?? "{}");
  } catch {
    return {};
  }
}

export class Workbench {
  groups = $state<Group[]>([{ id: 0, tabs: [{ kind: "notebook" }], active: 0 }]);
  /** how the groups share the editor area */
  layout = $state<Node>({ group: 0 });
  /** the id of the group that has focus: where an opened tab goes */
  focused = $state(0);
  view = $state<View | null>("explorer");
  panel = $state(false);
  /** px, below the editors */
  panelHeight = $state(240);
  /** px, beside them */
  panelWidth = $state(420);
  panelPosition = $state<PanelPosition>("bottom");
  /** the panel takes the whole editor area */
  panelMax = $state(false);
  panelTab = $state<PanelTab>("results");
  /** what each open editor puts in its tab bar, by tab key */
  actions = $state<Record<string, EditorAction[]>>({});
  /** tabs with unsaved changes, by tab key */
  dirty = $state<Record<string, boolean>>({});
  /** where the cursor is in the focused code editor */
  cursor = $state<{ line: number; col: number; lang: string } | null>(null);
  /** a commit shown cell by cell (the commit dialog) */
  commit = $state<string | null>(null);
  /** where text inserted from the side bar goes: the focused code editor, if any */
  inserter = $state<((text: string) => void) | null>(null);
  /** a line to bring into view when a cell's editor opens (from search or problems) */
  reveal = $state<{ cell: string; line: number; col?: number } | null>(null);
  /** the settings editor's scope, and a group of it to bring into view */
  settingsScope = $state<"user" | "workspace" | "notebook">("notebook");
  settingsReveal = $state<string | null>(null);
  /** a tab being dragged: from a group (and its place there), or from the side bar */
  drag = $state<{ tab: Tab; from: number | null; index: number } | null>(null);

  private nextId = 1;

  constructor(readonly nb: string) {
    const s = load(nb);
    if (s.groups?.length) {
      // before the grid, groups had no ids: their place was their id
      const groups = s.groups.map((g, i) => ({ id: typeof g.id === "number" ? g.id : i, tabs: g.tabs ?? [], active: g.active ?? 0 }));
      const ids = new Set(groups.map((g) => g.id));
      const legacy: Node | null =
        !s.layout && groups.length === 2 ? { dir: "row", children: [{ group: groups[0].id }, { group: groups[1].id }], sizes: [s.split ?? 0.5, 1 - (s.split ?? 0.5)] } : null;
      const layout = sanitize(s.layout ?? legacy, ids);
      if (layout) {
        this.groups = groups;
        this.layout = layout;
        this.nextId = Math.max(...ids) + 1;
      }
    }
    this.focused = this.group(s.focused ?? -1) ? s.focused! : this.order()[0];
    if (s.view !== undefined) this.view = s.view;
    if (s.panel != null) this.panel = s.panel;
    if (s.panelHeight) this.panelHeight = s.panelHeight;
    if (s.panelWidth) this.panelWidth = s.panelWidth;
    if (s.panelPosition === "right" || s.panelPosition === "bottom") this.panelPosition = s.panelPosition;
    if (s.panelMax) this.panelMax = s.panelMax;
    if (s.panelTab) this.panelTab = s.panelTab;
  }

  save() {
    const s: Saved = {
      groups: $state.snapshot(this.groups) as Group[],
      layout: $state.snapshot(this.layout) as Node,
      focused: this.focused,
      view: this.view,
      panel: this.panel,
      panelHeight: this.panelHeight,
      panelWidth: this.panelWidth,
      panelPosition: this.panelPosition,
      panelMax: this.panelMax,
      panelTab: this.panelTab,
    };
    try {
      localStorage.setItem(`querier:wb:${this.nb}`, JSON.stringify(s));
    } catch {}
  }

  // -- groups

  group(id: number): Group | undefined {
    return this.groups.find((g) => g.id === id);
  }
  /** The groups' ids in reading order. */
  order(): number[] {
    return groupOrder(this.layout);
  }

  activeTab(id = this.focused): Tab | undefined {
    const g = this.group(id);
    return g?.tabs[g.active];
  }

  focus(id: number) {
    if (this.group(id)) this.focused = id;
  }

  /** A new group beside `id` on `side`, holding `tabs`; its id. */
  private addGroup(id: number, side: Side, tabs: Tab[] = []): number {
    const g: Group = { id: this.nextId++, tabs, active: 0 };
    this.groups.push(g);
    this.layout = splitAt($state.snapshot(this.layout) as Node, id, g.id, side);
    return g.id;
  }

  private dropGroup(id: number) {
    if (this.groups.length <= 1) return;
    const next = this.layout && (neighbour(this.layout, id, "left") ?? neighbour(this.layout, id, "up") ?? neighbour(this.layout, id, "right") ?? neighbour(this.layout, id, "down"));
    this.groups = this.groups.filter((g) => g.id !== id);
    this.layout = removeFrom($state.snapshot(this.layout) as Node, id) ?? { group: this.groups[0].id };
    if (this.focused === id) this.focused = next ?? this.order()[0];
  }

  /** Put `tab` in group `id` (after its active tab, or at `at`), or focus it there if it is open. */
  private place(id: number, tab: Tab, at?: number) {
    const g = this.group(id)!;
    const key = tabKey(tab);
    const found = g.tabs.findIndex((t) => tabKey(t) === key);
    if (found >= 0) {
      g.active = found;
      return;
    }
    const i = at ?? (g.tabs.length ? Math.min(g.active + 1, g.tabs.length) : 0);
    g.tabs.splice(i, 0, tab);
    g.active = i;
  }

  // -- tabs

  /** Open a tab: focus it where it is open in the target group, else add it there. The target is
   *  `group`, else the focused one; `side` opens it in the group to the right (made if there is none). */
  open(tab: Tab, { group, side = false }: { group?: number; side?: boolean } = {}) {
    let id = group ?? this.focused;
    if (!this.group(id)) id = this.order()[0];
    if (side) id = neighbour(this.layout, id, "right") ?? this.addGroup(id, "right");
    this.place(id, tab);
    this.focused = id;
    this.save();
  }

  /** Split group `id` (default: the focused one) toward `side`: the new group opens its active tab. */
  split(side: Side = "right", id = this.focused) {
    const tab = this.activeTab(id);
    const nid = this.addGroup(id, side, tab ? [structuredClone($state.snapshot(tab)) as Tab] : []);
    this.focused = nid;
    this.save();
  }
  splitRight() {
    this.split("right");
  }

  close(id: number, i: number) {
    const g = this.group(id);
    if (!g) return;
    g.tabs.splice(i, 1);
    if (g.active >= g.tabs.length || g.active > i) g.active = Math.max(0, g.active - 1);
    // an emptied group goes away, unless it is the only one: it stays, empty (its watermark shows)
    if (!g.tabs.length) this.dropGroup(id);
    this.save();
  }

  closeKey(key: string) {
    for (const g of [...this.groups]) {
      const i = g.tabs.findIndex((t) => tabKey(t) === key);
      if (i >= 0) this.close(g.id, i);
    }
  }

  closeOthers(id: number, i: number) {
    const g = this.group(id);
    if (!g) return;
    g.tabs = [g.tabs[i]];
    g.active = 0;
    this.save();
  }
  closeToRight(id: number, i: number) {
    const g = this.group(id);
    if (!g) return;
    g.tabs.splice(i + 1);
    g.active = Math.min(g.active, g.tabs.length - 1);
    this.save();
  }
  closeAll(id: number) {
    const g = this.group(id);
    if (!g) return;
    g.tabs = [];
    g.active = 0;
    this.dropGroup(id);
    this.save();
  }
  /** Every editor in every group: one empty group is left. */
  closeAllGroups() {
    const keep = this.order()[0];
    this.groups = [{ id: keep, tabs: [], active: 0 }];
    this.layout = { group: keep };
    this.focused = keep;
    this.save();
  }
  /** Every group's tabs into the focused one. */
  joinAll() {
    const into = this.group(this.focused)!;
    for (const g of this.groups) if (g.id !== into.id) for (const t of g.tabs) if (!into.tabs.some((x) => tabKey(x) === tabKey(t))) into.tabs.push(t);
    this.groups = [into];
    this.layout = { group: into.id };
    this.save();
  }
  evenOut() {
    this.layout = evenOut($state.snapshot(this.layout) as Node);
    this.save();
  }

  /** A tab dropped somewhere: into a group (at a place), or beside one (a new group). The tab
   *  leaves where it came from; one dragged from the side bar is opened. */
  drop(zone: DropZone, tab: Tab, from: { group: number; index: number } | null) {
    const key = tabKey(tab);
    const source = from ? this.group(from.group) : undefined;
    if ("side" in zone) {
      // a group's only tab, split beside itself, has nowhere to go
      if (source && source.id === zone.group && source.tabs.length === 1) return;
      const nid = this.addGroup(zone.group, zone.side, [structuredClone($state.snapshot(tab)) as Tab]);
      if (source) this.removeTab(source.id, key);
      this.focused = nid;
    } else {
      const target = this.group(zone.group);
      if (!target) return;
      if (source && source.id === target.id) {
        // a move within the group
        const i = source.tabs.findIndex((t) => tabKey(t) === key);
        let to = Math.min(zone.at ?? source.tabs.length, source.tabs.length);
        if (i < 0) return;
        const [t] = source.tabs.splice(i, 1);
        if (to > i) to--;
        source.tabs.splice(to, 0, t);
        source.active = to;
      } else {
        const at = target.tabs.findIndex((t) => tabKey(t) === key);
        if (at >= 0) target.active = at;
        else this.place(target.id, structuredClone($state.snapshot(tab)) as Tab, zone.at ?? target.tabs.length);
        if (source) this.removeTab(source.id, key);
      }
      this.focused = target.id;
    }
    this.save();
  }

  private removeTab(id: number, key: string) {
    const g = this.group(id);
    if (!g) return;
    const i = g.tabs.findIndex((t) => tabKey(t) === key);
    if (i >= 0) this.close(id, i);
  }

  /** A cell was renamed: its tabs follow. */
  renamed(from: string, to: string) {
    for (const g of this.groups) for (const t of g.tabs) if (t.kind === "cell" && t.cell === from) t.cell = to;
    this.save();
  }

  /** Cells that no longer exist lose their tabs. */
  prune(cells: Set<string>) {
    for (const g of [...this.groups])
      for (let i = g.tabs.length - 1; i >= 0; i--) {
        const t = g.tabs[i];
        if (t.kind === "cell" && !cells.has(t.cell)) this.close(g.id, i);
      }
  }

  // -- side bar and panel

  showView(v: View) {
    this.view = this.view === v ? null : v;
    this.save();
  }

  togglePanel(tab?: PanelTab) {
    if (tab && (!this.panel || this.panelTab !== tab)) {
      this.panel = true;
      this.panelTab = tab;
    } else this.panel = !this.panel;
    if (!this.panel) this.panelMax = false;
    this.save();
  }
  toggleMaxPanel() {
    this.panel = true;
    this.panelMax = !this.panelMax;
    this.save();
  }
  movePanel(to: PanelPosition) {
    this.panelPosition = to;
    this.save();
  }

  openSettings(scope: "user" | "workspace" | "notebook" = "notebook", section: string | null = null) {
    this.settingsScope = scope;
    this.settingsReveal = section;
    this.open({ kind: "settings" });
  }
}
