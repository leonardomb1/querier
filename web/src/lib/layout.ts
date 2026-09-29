// The editor area's grid, as VS Code's: a tree of splits whose leaves are editor
// groups. A split lays its children out in a row (side by side) or a column
// (stacked), each child taking its share of `sizes`. Pure: the workbench keeps
// the tree in its state; the functions here read it or return a new one.

export type Dir = "row" | "col";
export type Leaf = { group: number };
export type Split = { dir: Dir; children: Node[]; sizes: number[] };
export type Node = Leaf | Split;
export type Side = "left" | "right" | "up" | "down";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A boundary between two children of a split, to drag. */
export interface Sash {
  node: Split;
  /** between children `index` and `index + 1` */
  index: number;
  /** where it is, in fractions of the whole area (w is 0 for a row's, h for a column's) */
  rect: Rect;
  /** the split's own width (row) or height (col), in fractions of the whole area */
  extent: number;
}

export const isLeaf = (n: Node): n is Leaf => "group" in n;
const axisOf = (side: Side): Dir => (side === "left" || side === "right" ? "row" : "col");
const before = (side: Side) => side === "left" || side === "up";

/** Every group's rectangle and every sash, in fractions of the area. */
export function layoutRects(root: Node, area: Rect = { x: 0, y: 0, w: 1, h: 1 }) {
  const groups = new Map<number, Rect>();
  const sashes: Sash[] = [];
  const walk = (n: Node, r: Rect) => {
    if (isLeaf(n)) return void groups.set(n.group, r);
    const total = n.sizes.reduce((a, b) => a + b, 0) || 1;
    let at = n.dir === "row" ? r.x : r.y;
    n.children.forEach((c, i) => {
      const share = n.sizes[i] / total;
      const cr = n.dir === "row" ? { x: at, y: r.y, w: r.w * share, h: r.h } : { x: r.x, y: at, w: r.w, h: r.h * share };
      walk(c, cr);
      at += n.dir === "row" ? cr.w : cr.h;
      if (i < n.children.length - 1)
        sashes.push({
          node: n,
          index: i,
          rect: n.dir === "row" ? { x: at, y: r.y, w: 0, h: r.h } : { x: r.x, y: at, w: r.w, h: 0 },
          extent: n.dir === "row" ? r.w : r.h,
        });
    });
  };
  walk(root, area);
  return { groups, sashes };
}

/** The groups, in reading order: left to right, top to bottom. */
export function groupOrder(root: Node): number[] {
  return isLeaf(root) ? [root.group] : root.children.flatMap(groupOrder);
}

/** A new group `id` beside `target`, on `side`, taking half of its room. */
export function splitAt(root: Node, target: number, id: number, side: Side): Node {
  const dir = axisOf(side);
  const leaf: Leaf = { group: id };
  const walk = (n: Node): Node => {
    if (isLeaf(n)) return n.group === target ? { dir, children: before(side) ? [leaf, n] : [n, leaf], sizes: [1, 1] } : n;
    // the target is a child of a split along the same axis: it becomes a sibling
    const i = n.children.findIndex((c) => isLeaf(c) && c.group === target);
    if (i >= 0 && n.dir === dir) {
      const children = [...n.children];
      const sizes = [...n.sizes];
      const half = sizes[i] / 2;
      sizes.splice(i, 1, half);
      children.splice(before(side) ? i : i + 1, 0, leaf);
      sizes.splice(before(side) ? i : i + 1, 0, half);
      return { dir: n.dir, children, sizes };
    }
    return { dir: n.dir, children: n.children.map(walk), sizes: [...n.sizes] };
  };
  return walk(root);
}

/** The tree without group `id`; a split left with one child gives way to it. */
export function removeFrom(root: Node, id: number): Node | null {
  if (isLeaf(root)) return root.group === id ? null : root;
  const children: Node[] = [];
  const sizes: number[] = [];
  root.children.forEach((c, i) => {
    const kept = removeFrom(c, id);
    if (!kept) return;
    // a child split along the same axis melts into this one
    if (!isLeaf(kept) && kept.dir === root.dir) {
      const t = kept.sizes.reduce((a, b) => a + b, 0) || 1;
      kept.children.forEach((k, j) => {
        children.push(k);
        sizes.push((root.sizes[i] * kept.sizes[j]) / t);
      });
    } else {
      children.push(kept);
      sizes.push(root.sizes[i]);
    }
  });
  if (!children.length) return null;
  if (children.length === 1) return children[0];
  return { dir: root.dir, children, sizes };
}

/** The group next to `id` on `side` (the one sharing most of that edge), if any. */
export function neighbour(root: Node, id: number, side: Side): number | null {
  const { groups } = layoutRects(root);
  const r = groups.get(id);
  if (!r) return null;
  const eps = 1e-6;
  let best: number | null = null;
  let bestOverlap = 0;
  for (const [g, o] of groups) {
    if (g === id) continue;
    const touches =
      side === "right" ? Math.abs(o.x - (r.x + r.w)) < eps : side === "left" ? Math.abs(o.x + o.w - r.x) < eps : side === "down" ? Math.abs(o.y - (r.y + r.h)) < eps : Math.abs(o.y + o.h - r.y) < eps;
    if (!touches) continue;
    const overlap = axisOf(side) === "row" ? Math.min(r.y + r.h, o.y + o.h) - Math.max(r.y, o.y) : Math.min(r.x + r.w, o.x + o.w) - Math.max(r.x, o.x);
    if (overlap > bestOverlap + eps) (best = g), (bestOverlap = overlap);
  }
  return best;
}

/** Every split's children made the same size. */
export function evenOut(root: Node): Node {
  return isLeaf(root) ? root : { dir: root.dir, children: root.children.map(evenOut), sizes: root.children.map(() => 1) };
}

/** A tree that is safe to use: groups that exist, each once, sizes that are numbers. */
export function sanitize(root: unknown, ids: Set<number>): Node | null {
  const seen = new Set<number>();
  const walk = (n: any): Node | null => {
    if (n && typeof n.group === "number") return ids.has(n.group) && !seen.has(n.group) ? (seen.add(n.group), { group: n.group }) : null;
    if (!n || (n.dir !== "row" && n.dir !== "col") || !Array.isArray(n.children)) return null;
    const kids: Node[] = [];
    const sizes: number[] = [];
    n.children.forEach((c: unknown, i: number) => {
      const k = walk(c);
      if (!k) return;
      kids.push(k);
      const s = Number(n.sizes?.[i]);
      sizes.push(s > 0 && Number.isFinite(s) ? s : 1);
    });
    if (!kids.length) return null;
    return kids.length === 1 ? kids[0] : { dir: n.dir, children: kids, sizes };
  };
  const out = walk(root);
  // a group the tree forgot goes to the right, rather than vanishing
  const missing = [...ids].filter((i) => !seen.has(i));
  if (!missing.length) return out;
  const leaves: Node[] = missing.map((group) => ({ group }));
  return out ? { dir: "row", children: [out, ...leaves], sizes: [1, ...leaves.map(() => 1)] } : leaves.length === 1 ? leaves[0] : { dir: "row", children: leaves, sizes: leaves.map(() => 1) };
}
