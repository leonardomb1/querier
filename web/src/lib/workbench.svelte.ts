// The workbench around a notebook, VS Code's: an activity bar picks the side
// bar's view, editors open as tabs in one or two groups side by side, a panel
// below them holds results and problems. Remembered per notebook.

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
  | { kind: "graph" };

export type View = "explorer" | "search" | "scm" | "data";
export type PanelTab = "results" | "problems";

export interface Group {
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

export const tabKey = (t: Tab) => (t.kind === "cell" ? `cell:${t.cell}` : t.kind);

interface Saved {
  groups: Group[];
  focused: number;
  view: View | null;
  sideWidth: number;
  panel: boolean;
  panelHeight: number;
  panelTab: PanelTab;
  split: number;
}

function load(nb: string): Partial<Saved> {
  try {
    return JSON.parse(localStorage.getItem(`querier:wb:${nb}`) ?? "{}");
  } catch {
    return {};
  }
}

export class Workbench {
  groups = $state<Group[]>([{ tabs: [{ kind: "notebook" }], active: 0 }]);
  /** the group that has focus: where an opened tab goes */
  focused = $state(0);
  view = $state<View | null>("explorer");
  /** px */
  sideWidth = $state(260);
  panel = $state(false);
  /** px */
  panelHeight = $state(240);
  panelTab = $state<PanelTab>("results");
  /** where two editor groups divide, as a fraction of the width */
  split = $state(0.5);
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

  constructor(readonly nb: string) {
    const s = load(nb);
    if (s.groups?.length) this.groups = s.groups.slice(0, 2);
    this.focused = Math.min(s.focused ?? 0, this.groups.length - 1);
    if (s.view !== undefined) this.view = s.view;
    if (s.sideWidth) this.sideWidth = s.sideWidth;
    if (s.panel != null) this.panel = s.panel;
    if (s.panelHeight) this.panelHeight = s.panelHeight;
    if (s.panelTab) this.panelTab = s.panelTab;
    if (s.split) this.split = s.split;
  }

  save() {
    const s: Saved = {
      groups: $state.snapshot(this.groups) as Group[],
      focused: this.focused,
      view: this.view,
      sideWidth: this.sideWidth,
      panel: this.panel,
      panelHeight: this.panelHeight,
      panelTab: this.panelTab,
      split: this.split,
    };
    try {
      localStorage.setItem(`querier:wb:${this.nb}`, JSON.stringify(s));
    } catch {}
  }

  activeTab(g = this.focused): Tab | undefined {
    const group = this.groups[g];
    return group?.tabs[group.active];
  }

  /** Open a tab: focus it where it is open, else add it to `group` (default: the focused one). */
  open(tab: Tab, { group, side = false }: { group?: number; side?: boolean } = {}) {
    let g = side ? this.otherGroup() : (group ?? this.focused);
    const key = tabKey(tab);
    const at = this.groups[g].tabs.findIndex((t) => tabKey(t) === key);
    if (at >= 0) this.groups[g].active = at;
    else {
      // after the active tab; first, in an empty group
      const group = this.groups[g];
      const i = group.tabs.length ? Math.min(group.active + 1, group.tabs.length) : 0;
      group.tabs.splice(i, 0, tab);
      group.active = i;
    }
    this.focused = g;
    this.save();
  }

  /** The group to the right, made if there is none yet. */
  private otherGroup(): number {
    if (this.groups.length === 1) this.groups.push({ tabs: [], active: 0 });
    return this.focused === 0 ? 1 : 0;
  }

  close(g: number, i: number) {
    const group = this.groups[g];
    group.tabs.splice(i, 1);
    if (group.active >= group.tabs.length || group.active > i) group.active = Math.max(0, group.active - 1);
    // an emptied second group goes away; the first keeps the notebook at least
    if (!group.tabs.length) {
      if (this.groups.length > 1) {
        this.groups.splice(g, 1);
        this.focused = 0;
      } else group.tabs.push({ kind: "notebook" });
    }
    this.save();
  }

  closeKey(key: string) {
    for (let g = this.groups.length - 1; g >= 0; g--) {
      const i = this.groups[g].tabs.findIndex((t) => tabKey(t) === key);
      if (i >= 0) this.close(g, i);
    }
  }

  /** Split the focused group's tab into a new group on the right. */
  splitRight() {
    const tab = this.activeTab();
    if (!tab) return;
    this.open(structuredClone($state.snapshot(tab)) as Tab, { side: true });
  }

  /** A cell was renamed: its tabs follow. */
  renamed(from: string, to: string) {
    for (const g of this.groups) for (const t of g.tabs) if (t.kind === "cell" && t.cell === from) t.cell = to;
    this.save();
  }

  /** Cells that no longer exist lose their tabs. */
  prune(cells: Set<string>) {
    for (let g = this.groups.length - 1; g >= 0; g--)
      for (let i = this.groups[g].tabs.length - 1; i >= 0; i--) {
        const t = this.groups[g].tabs[i];
        if (t.kind === "cell" && !cells.has(t.cell)) this.close(g, i);
      }
  }

  showView(v: View) {
    this.view = this.view === v ? null : v;
    this.save();
  }

  togglePanel(tab?: PanelTab) {
    if (tab && (!this.panel || this.panelTab !== tab)) {
      this.panel = true;
      this.panelTab = tab;
    } else this.panel = !this.panel;
    this.save();
  }
}
