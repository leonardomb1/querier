// A cell against its last commit, VS Code style: a bar in the gutter beside
// added and modified lines and a mark where lines were deleted, always on; and
// on demand the inline diff, with Revert / Keep on each change.

import { presentableDiff, unifiedMergeView } from "@codemirror/merge";
import { RangeSet, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, gutter, GutterMarker } from "@codemirror/view";

class ChangeMark extends GutterMarker {
  constructor(readonly kind: "added" | "modified" | "deleted") {
    super();
  }
  eq(other: ChangeMark) {
    return other.kind === this.kind;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-git-${this.kind}`;
    return el;
  }
}
const ADDED = new ChangeMark("added");
const MODIFIED = new ChangeMark("modified");
const DELETED = new ChangeMark("deleted");

/** The committed text the editor compares against; null for a cell that is new. */
export const setOriginal = StateEffect.define<string | null>();

const original = StateField.define<string | null>({
  create: () => null,
  update: (value, tr) => {
    for (const e of tr.effects) if (e.is(setOriginal)) return e.value;
    return value;
  },
});

function marks(state: EditorState): RangeSet<GutterMarker> {
  const base = state.field(original);
  if (base == null) return RangeSet.empty;
  const doc = state.doc;
  const out: { from: number; mark: GutterMarker }[] = [];
  for (const c of presentableDiff(base, doc.toString())) {
    if (c.toB > c.fromB) {
      const kind = c.toA > c.fromA ? MODIFIED : ADDED;
      const first = doc.lineAt(c.fromB).number;
      const last = doc.lineAt(Math.max(c.fromB, c.toB - 1)).number;
      for (let n = first; n <= last; n++) out.push({ from: doc.line(n).from, mark: kind });
    } else {
      out.push({ from: doc.lineAt(Math.min(c.fromB, doc.length)).from, mark: DELETED });
    }
  }
  // one mark per line; a modification wins over a deletion on the same line
  const seen = new Map<number, GutterMarker>();
  for (const { from, mark } of out) if (!seen.has(from) || mark !== DELETED) seen.set(from, mark);
  return RangeSet.of([...seen].sort((a, b) => a[0] - b[0]).map(([from, mark]) => mark.range(from)));
}

const changeMarks = StateField.define<RangeSet<GutterMarker>>({
  create: marks,
  update: (value, tr) => (tr.docChanged || tr.effects.some((e) => e.is(setOriginal)) ? marks(tr.state) : value),
});

/** The gutter of change marks. */
export const gitGutter: Extension = [
  original,
  changeMarks,
  gutter({
    class: "cm-git-gutter",
    markers: (view) => view.state.field(changeMarks),
  }),
  EditorView.theme({
    ".cm-git-gutter": { width: "3px", marginRight: "3px" },
    ".cm-git-gutter .cm-gutterElement": { padding: "0" },
    ".cm-git-added, .cm-git-modified": { width: "3px", height: "100%" },
    ".cm-git-added": { background: "var(--git-added)" },
    ".cm-git-modified": { background: "var(--git-modified)" },
    ".cm-git-deleted": {
      width: "0",
      height: "0",
      borderTop: "4px solid transparent",
      borderBottom: "4px solid transparent",
      borderLeft: "5px solid var(--git-deleted)",
      transform: "translateY(-4px)",
    },
  }),
];

/** The inline diff against `base`: deleted lines shown in place, each change
 *  with Revert (back to the commit) and Keep. */
export function inlineDiff(base: string): Extension {
  return [
    unifiedMergeView({
      original: base,
      gutter: false,
      highlightChanges: true,
      syntaxHighlightDeletions: true,
      mergeControls: (type, action) => {
        const b = document.createElement("button");
        b.className = `cm-diff-${type}`;
        b.textContent = type === "reject" ? "Revert" : "Keep";
        b.title = type === "reject" ? "Put this back as it was in the last commit" : "Keep this change";
        b.onmousedown = action;
        return b;
      },
    }),
    EditorView.theme({
      ".cm-changedLine": { background: "var(--git-added-bg) !important" },
      ".cm-changedText": { background: "var(--git-added-text) !important" },
      ".cm-deletedChunk": { background: "var(--git-deleted-bg)", paddingLeft: "0.25rem" },
      ".cm-deletedChunk .cm-deletedText, .cm-deletedChunk del": { background: "var(--git-deleted-text)", textDecoration: "none" },
      ".cm-deletedChunk .cm-chunkButtons": { position: "absolute", right: "0.5rem", display: "flex", gap: "0.25rem" },
      ".cm-diff-reject, .cm-diff-accept": {
        font: "0.72rem var(--sans)",
        padding: "0 0.5rem",
        borderRadius: "4px",
        border: "1px solid var(--hair)",
        background: "var(--surface)",
        color: "var(--ink)",
        cursor: "pointer",
      },
    }),
  ];
}
