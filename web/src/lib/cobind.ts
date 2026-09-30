// A Monaco editor on a cell's shared text (collab.svelte.ts): what is typed here
// goes into it, what others type comes into the editor, undo takes back only one's
// own edits, and the others' cursors and selections show in their colors with
// their names.

import type * as monaco from "monaco-editor/editor/editor.api";
import * as Y from "yjs";
import type { Collab, Peer } from "./collab.svelte";

type Monaco = typeof monaco;

/** Their names over their cursors: a rule per person here, kept in one stylesheet. */
const labels = new Map<number, string>();
function paintLabels(peers: Peer[]) {
  let el = document.getElementById("q-peer-labels") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "q-peer-labels";
    document.head.append(el);
  }
  let dirty = false;
  for (const p of peers) {
    if (labels.get(p.client) !== p.user.name) {
      labels.set(p.client, p.user.name);
      dirty = true;
    }
  }
  if (dirty) el.textContent = [...labels].map(([client, name]) => `.q-peer-n${client}::after { content: ${JSON.stringify(name)}; }`).join("\n");
}

export function bindShared(M: Monaco, editor: monaco.editor.IStandaloneCodeEditor, model: monaco.editor.ITextModel, text: Y.Text, collab: Collab, cell: string) {
  const doc = text.doc!;
  const origin = {};
  let applying = false;
  model.setEOL(M.editor.EndOfLineSequence.LF);
  if (model.getValue() !== text.toString()) {
    applying = true;
    model.setValue(text.toString());
    applying = false;
  }

  // here → shared: each change, from the end back, so the offsets hold
  const toShared = model.onDidChangeContent((e) => {
    if (applying) return;
    doc.transact(() => {
      for (const c of [...e.changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
        if (c.rangeLength) text.delete(c.rangeOffset, c.rangeLength);
        if (c.text) text.insert(c.rangeOffset, c.text);
      }
    }, origin);
  });

  // shared → here: the others' edits (and one's undo), as edits the cursors move with
  const fromShared = (event: Y.YTextEvent, tx: Y.Transaction) => {
    if (tx.origin === origin) return;
    const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
    let index = 0;
    for (const d of event.delta) {
      if (d.retain) index += d.retain;
      else if (d.delete) {
        const from = model.getPositionAt(index);
        const to = model.getPositionAt(index + d.delete);
        edits.push({ range: new M.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: "" });
        index += d.delete;
      } else if (d.insert) {
        const at = model.getPositionAt(index);
        edits.push({ range: new M.Range(at.lineNumber, at.column, at.lineNumber, at.column), text: d.insert as string });
      }
    }
    applying = true;
    model.applyEdits(edits);
    applying = false;
    paintPeers();
  };
  text.observe(fromShared);

  // undo takes back one's own edits, not the others'
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set([origin]), captureTimeout: 500 });
  const K = M.KeyCode;
  const Mod = M.KeyMod;
  const actions = [
    editor.addAction({ id: "querier.undo", label: "Undo", keybindings: [Mod.CtrlCmd | K.KeyZ], run: () => void undo.undo() }),
    editor.addAction({ id: "querier.redo", label: "Redo", keybindings: [Mod.CtrlCmd | Mod.Shift | K.KeyZ, Mod.CtrlCmd | K.KeyY], run: () => void undo.redo() }),
  ];

  // where this cursor is, for the others
  const rel = (offset: number) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, offset));
  const share = () => {
    if (!editor.hasTextFocus()) return;
    const s = editor.getSelection();
    if (!s) return;
    const anchor = model.getOffsetAt({ lineNumber: s.selectionStartLineNumber, column: s.selectionStartColumn });
    const head = model.getOffsetAt({ lineNumber: s.positionLineNumber, column: s.positionColumn });
    collab.setCursor({ cell, anchor: rel(anchor), head: rel(head) });
  };
  const subs = [
    editor.onDidChangeCursorSelection(share),
    editor.onDidFocusEditorText(() => {
      collab.setCell(cell);
      share();
    }),
    editor.onDidBlurEditorText(() => collab.setCell(null)),
  ];
  if (editor.hasTextFocus()) {
    collab.setCell(cell);
    share();
  }

  // the others' cursors and selections in this cell; a name over a cursor while it moves,
  // gone after a few still seconds (it would cover the line above)
  const marks = editor.createDecorationsCollection();
  const moved = new Map<number, { at: string; since: number }>();
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const LABEL_MS = 3000;
  const abs = (json: unknown) => {
    const p = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), doc);
    return p && p.type === text ? model.getPositionAt(p.index) : null;
  };
  function paintPeers() {
    const here = collab.peers.filter((p) => p.cursor?.cell === cell);
    paintLabels(here);
    const now = Date.now();
    let next = Infinity;
    const decos: monaco.editor.IModelDeltaDecoration[] = [];
    for (const p of here) {
      const at = JSON.stringify(p.cursor);
      const m = moved.get(p.client);
      if (!m || m.at !== at) moved.set(p.client, { at, since: now });
      const since = moved.get(p.client)!.since;
      const named = now - since < LABEL_MS;
      if (named) next = Math.min(next, since + LABEL_MS - now);
      const a = abs(p.cursor!.anchor);
      const h = abs(p.cursor!.head);
      if (!a || !h) continue;
      const [start, end] = model.getOffsetAt(a) <= model.getOffsetAt(h) ? [a, h] : [h, a];
      if (start.lineNumber !== end.lineNumber || start.column !== end.column)
        decos.push({ range: new M.Range(start.lineNumber, start.column, end.lineNumber, end.column), options: { className: `q-peer-sel q-peer-c${p.user.color}` } });
      decos.push({
        range: new M.Range(h.lineNumber, h.column, h.lineNumber, h.column),
        options: { beforeContentClassName: `q-peer-head q-peer-c${p.user.color}${named ? ` q-peer-n${p.client}` : ""}${h.lineNumber === 1 ? " q-peer-below" : ""}`, hoverMessage: { value: p.user.name }, stickiness: M.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
      });
    }
    marks.set(decos);
    // a name's time is up: painted again without it
    clearTimeout(quiet);
    if (next < Infinity) quiet = setTimeout(paintPeers, next + 20);
  }
  paintPeers();

  return {
    /** the others moved: their cursors again */
    paint: paintPeers,
    dispose() {
      clearTimeout(quiet);
      text.unobserve(fromShared);
      toShared.dispose();
      for (const s of [...subs, ...actions]) s.dispose();
      undo.destroy();
      marks.clear();
      if (editor.hasTextFocus()) collab.setCell(null);
    },
  };
}
