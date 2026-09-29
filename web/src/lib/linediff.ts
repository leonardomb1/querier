// A cell against its last commit, line by line, for the change marks beside it
// (VS Code's "dirty diff"): which lines were added or changed, and where lines
// were deleted. A longest-common-subsequence over lines: cells are small.

export interface LineChanges {
  /** 1-based lines of the new text */
  added: number[];
  modified: number[];
  /** a line of the new text with deleted lines just above it (past the end: its line count + 1) */
  deleted: number[];
}

export function lineChanges(before: string, after: string): LineChanges {
  const a = before.split("\n");
  const b = after.split("\n");
  const out: LineChanges = { added: [], modified: [], deleted: [] };
  if (before === after) return out;
  // too big to compare cheaply: every line counts as changed
  if (a.length * b.length > 4_000_000) {
    out.modified = b.map((_, i) => i + 1);
    return out;
  }
  // lcs[i][j]: the common lines of a[i..] and b[j..]
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  // walk it, gathering runs of removed and inserted lines between common ones
  let i = 0;
  let j = 0;
  let removed = 0;
  let inserted: number[] = [];
  const flush = () => {
    // as many inserted lines as removed ones changed; the rest were added, or deleted
    const changed = Math.min(removed, inserted.length);
    out.modified.push(...inserted.slice(0, changed));
    out.added.push(...inserted.slice(changed));
    if (removed > inserted.length) out.deleted.push(j + 1);
    removed = 0;
    inserted = [];
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) inserted.push(++j);
    else {
      removed++;
      i++;
    }
  }
  flush();
  return out;
}
