// A commit graph, as Git Graph draws one: commits top to bottom (git's
// topological order), each on a lane; lines run down the lanes to parents,
// bend where a branch comes in or a merge goes out.

export interface GraphCommit {
  hash: string;
  parents: string[];
}

/** A line through one row: from lane `from` at one edge to lane `to` at the node's height. */
export interface Segment {
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  lane: number;
  color: number;
  /** from the row's top edge down to the node's height */
  top: Segment[];
  /** from the node's height down to the row's bottom edge */
  bottom: Segment[];
}

export function layout(commits: GraphCommit[]): { rows: GraphRow[]; width: number } {
  // what each lane waits for next (a commit's hash), and the colour it is drawn in
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  let width = 1;
  const rows: GraphRow[] = [];
  const free = (not = -1) => {
    const i = lanes.findIndex((h, j) => h == null && j !== not);
    return i >= 0 ? i : lanes.length;
  };

  for (const c of commits) {
    const before = lanes.slice();
    const beforeColors = colors.slice();
    // its lane: the first that waits for it, else a new one (a branch tip)
    let lane = lanes.indexOf(c.hash);
    if (lane < 0) {
      lane = free();
      lanes[lane] = c.hash;
      colors[lane] = nextColor++;
    }
    const color = colors[lane];

    // coming in: every lane that waited for it joins its node; the others run through
    const top: Segment[] = [];
    before.forEach((h, i) => {
      if (h == null) return;
      top.push({ from: i, to: h === c.hash ? lane : i, color: beforeColors[i] });
      if (h === c.hash && i !== lane) lanes[i] = null;
    });

    // going out: the first parent continues its lane; a merge's others take a lane
    // that already waits for them, or a new one
    const [first, ...others] = c.parents;
    lanes[lane] = first ?? null;
    const bottom: Segment[] = [];
    if (first) bottom.push({ from: lane, to: lane, color });
    for (const p of others) {
      let at = lanes.indexOf(p);
      if (at < 0) {
        at = free(lane);
        lanes[at] = p;
        colors[at] = nextColor++;
      }
      bottom.push({ from: lane, to: at, color: colors[at] });
    }
    lanes.forEach((h, i) => {
      if (h != null && i !== lane && !bottom.some((s) => s.to === i && s.from === lane)) bottom.push({ from: i, to: i, color: colors[i] });
    });
    while (lanes.length && lanes[lanes.length - 1] == null) (lanes.pop(), colors.pop());

    width = Math.max(width, lane + 1, ...top.map((s) => Math.max(s.from, s.to) + 1), ...bottom.map((s) => Math.max(s.from, s.to) + 1));
    rows.push({ lane, color, top, bottom });
  }
  return { rows, width };
}
