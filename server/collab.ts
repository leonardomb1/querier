// Editing a notebook together: a room per notebook, shared by everyone who has it
// open (whoever may view it; only who may edit it changes it). Its cells' text is
// a Yjs document, one Y.Text per cell, so edits made at once merge character by
// character; presence (who is here, which cell they are in, their cursor) is its
// awareness. The room writes each cell to its file shortly after it changes, and
// takes in what changed the files otherwise (a pull, an AI client, a rename).
//
// The wire is y-websocket's: [0, sync message] and [1, awareness update], plus
// [3, id], answered with [3, id] once everything before it is on disk (a run
// reads the files). Only results stay each person's own: kernels aren't here.

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { Principal } from "./auth/principal";
import type { Store } from "./store";

const SYNC = 0;
const AWARENESS = 1;
const FLUSH = 3;
const PERSIST_MS = 300;

/** What the room needs of a socket. */
export interface Peer {
  send(data: Uint8Array): void;
}

/** Who someone is to the others: set here, never by their page. */
export interface Presence {
  id: string;
  name: string;
  color: number;
}

export const presenceOf = (p: Principal): Presence => ({
  id: p.id,
  name: p.name || p.username,
  color: colorOf(p.id),
});

/** One of eight colors, the same for a person everywhere. */
export function colorOf(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 8;
}

interface Member {
  presence: Presence;
  canEdit: () => boolean;
  /** the awareness client ids this socket speaks for */
  clients: Set<number>;
}

class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly members = new Map<Peer, Member>();
  private dirty = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private writing: Promise<void> = Promise.resolve();
  readonly loaded: Promise<void>;

  constructor(
    readonly nb: string,
    private store: Store,
    private saved: (nb: string) => void,
  ) {
    // the server's own presence is nobody
    this.awareness.setLocalState(null);
    this.loaded = this.reload();
    const cells = this.cells();
    cells.observeDeep((events, tx) => {
      if (tx.origin === "disk") return;
      // a cell's text changed: its key is the event's path (cells come and go through the files)
      for (const e of events) if (typeof e.path[0] === "string") this.dirty.add(e.path[0]);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.persist(), PERSIST_MS);
    });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.broadcast(encoding.toUint8Array(enc), origin);
    });
    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      this.broadcast(encoding.toUint8Array(enc), origin);
    });
  }

  cells(): Y.Map<Y.Text> {
    return this.doc.getMap<Y.Text>("cells");
  }

  private broadcast(data: Uint8Array, except?: unknown) {
    for (const peer of this.members.keys()) if (peer !== except) peer.send(data);
  }

  /** The cells' files into the document: new ones added, gone ones dropped, changed ones
   *  patched, except a cell with edits not yet written (they win; they are written next). */
  async reload() {
    const book = await this.store.load(this.nb);
    const cells = this.cells();
    this.doc.transact(() => {
      const names = new Set(book.cells.map((c) => c.name));
      for (const key of [...cells.keys()]) if (!names.has(key)) cells.delete(key);
      for (const c of book.cells) {
        const text = cells.get(c.name);
        if (!text) {
          const t = new Y.Text();
          t.insert(0, c.source);
          cells.set(c.name, t);
        } else if (!this.dirty.has(c.name)) patch(text, c.source);
      }
    }, "disk");
  }

  /** Write the changed cells to their files. */
  persist(): Promise<void> {
    clearTimeout(this.timer);
    const names = [...this.dirty];
    this.dirty.clear();
    if (!names.length) return this.writing;
    this.writing = this.writing.then(async () => {
      for (const name of names) {
        const text = this.cells().get(name);
        if (!text) continue;
        await this.store.save(this.nb, name, text.toString()).catch((e) => console.error(`collab: saving ${this.nb}/${name}:`, e.message));
      }
      this.saved(this.nb);
    });
    return this.writing;
  }

  join(peer: Peer, presence: Presence, canEdit: () => boolean) {
    this.members.set(peer, { presence, canEdit, clients: new Set() });
    // the document as it stands, and who is here
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    peer.send(encoding.toUint8Array(enc));
    const states = [...this.awareness.getStates().keys()];
    if (states.length) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, AWARENESS);
      encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(this.awareness, states));
      peer.send(encoding.toUint8Array(a));
    }
  }

  leave(peer: Peer) {
    const m = this.members.get(peer);
    this.members.delete(peer);
    if (m?.clients.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...m.clients], null);
  }

  message(peer: Peer, data: Uint8Array) {
    const m = this.members.get(peer);
    if (!m) return;
    const dec = decoding.createDecoder(data);
    const kind = decoding.readVarUint(dec);
    if (kind === SYNC) {
      const step = decoding.peekVarUint(dec);
      // their edits (a sync reply carries them too): only from who may edit
      if (step !== syncProtocol.messageYjsSyncStep1 && !m.canEdit()) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, SYNC);
      syncProtocol.readSyncMessage(dec, enc, this.doc, peer);
      if (encoding.length(enc) > 1) peer.send(encoding.toUint8Array(enc));
    } else if (kind === AWARENESS) {
      const update = this.ownPresence(m, decoding.readVarUint8Array(dec));
      if (update) awarenessProtocol.applyAwarenessUpdate(this.awareness, update, peer);
    } else if (kind === FLUSH) {
      const id = decoding.readVarUint(dec);
      this.persist().then(() => {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, FLUSH);
        encoding.writeVarUint(enc, id);
        peer.send(encoding.toUint8Array(enc));
      });
    }
  }

  /** An awareness update with who they are put in by the room: a page can say where its
   *  cursor is, not whose it is; and it speaks only for its own client ids. */
  private ownPresence(m: Member, update: Uint8Array): Uint8Array | null {
    const dec = decoding.createDecoder(update);
    const out: [number, number, string][] = [];
    const n = decoding.readVarUint(dec);
    for (let i = 0; i < n; i++) {
      const client = decoding.readVarUint(dec);
      const clock = decoding.readVarUint(dec);
      const raw = decoding.readVarString(dec);
      const theirs = m.clients.has(client);
      const someoneElses = !theirs && [...this.members.values()].some((o) => o.clients.has(client));
      if (someoneElses) continue;
      m.clients.add(client);
      const state = JSON.parse(raw);
      out.push([client, clock, JSON.stringify(state === null ? null : { ...state, user: m.presence })]);
    }
    if (!out.length) return null;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, out.length);
    for (const [client, clock, state] of out) {
      encoding.writeVarUint(enc, client);
      encoding.writeVarUint(enc, clock);
      encoding.writeVarString(enc, state);
    }
    return encoding.toUint8Array(enc);
  }

  close() {
    this.awareness.destroy();
    this.doc.destroy();
  }
}

/** The smallest edit that makes `text` read `to`: the common start and end stay, so
 *  cursors and others' concurrent edits around a change survive it. */
export function patch(text: Y.Text, to: string) {
  const from = text.toString();
  if (from === to) return;
  let start = 0;
  while (start < from.length && start < to.length && from[start] === to[start]) start++;
  let end = 0;
  while (end < from.length - start && end < to.length - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++;
  const removed = from.length - start - end;
  if (removed) text.delete(start, removed);
  const inserted = to.slice(start, to.length - end);
  if (inserted) text.insert(start, inserted);
}

export class Rooms {
  private rooms = new Map<string, Room>();
  /** what a page sent while its room was still loading: taken in order once it has joined */
  private early = new Map<Peer, Uint8Array[]>();

  constructor(
    private store: Store,
    /** the room wrote a notebook's cells: what reads the files (its kernels' dependency graph) catches up */
    private saved: (nb: string) => void,
  ) {}

  async join(nb: string, peer: Peer, who: Principal, canEdit: () => boolean) {
    let room = this.rooms.get(nb);
    if (!room) this.rooms.set(nb, (room = new Room(nb, this.store, this.saved)));
    this.early.set(peer, []);
    await room.loaded.catch(() => {});
    const early = this.early.get(peer) ?? [];
    this.early.delete(peer);
    room.join(peer, presenceOf(who), canEdit);
    for (const data of early) room.message(peer, data);
  }

  message(nb: string, peer: Peer, data: Uint8Array) {
    const early = this.early.get(peer);
    if (early) early.push(data);
    else this.rooms.get(nb)?.message(peer, data);
  }

  /** A socket went: its presence with it; the last one out writes what is left and closes the room. */
  async leave(nb: string, peer: Peer) {
    this.early.delete(peer);
    const room = this.rooms.get(nb);
    if (!room) return;
    room.leave(peer);
    if (room.members.size) return;
    await room.persist();
    if (room.members.size) return;
    this.rooms.delete(nb);
    room.close();
  }

  /** The notebook's files changed otherwise (cells added, renamed, moved or removed, a pull, an AI client). */
  async changed(nb: string) {
    await this.rooms.get(nb)?.reload().catch((e) => console.error(`collab: reloading ${nb}:`, e.message));
  }

  /** Everything typed so far on disk: before something reads the files. */
  async flush(nb: string) {
    await this.rooms.get(nb)?.persist();
  }

  /** A notebook went away or moved: its room goes with it (the pages reconnect to the new one). */
  drop(nb: string) {
    const room = this.rooms.get(nb);
    if (!room) return;
    this.rooms.delete(nb);
    room.close();
  }

  dropWhere(match: (nb: string) => boolean) {
    for (const nb of [...this.rooms.keys()]) if (match(nb)) this.drop(nb);
  }

  /** Who is in each room, for tests. */
  present(nb: string): Presence[] {
    return [...(this.rooms.get(nb)?.members.values() ?? [])].map((m) => m.presence);
  }
}
