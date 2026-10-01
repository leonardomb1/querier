// Editing a notebook together (server/collab.ts): the cells' text as a Yjs
// document shared with everyone who has the notebook open, and who is where.
// Edits merge character by character; the server writes the files. Each person's
// results stay their own (their kernel): only code and presence are shared.

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

const SYNC = 0;
const AWARENESS = 1;
const FLUSH = 3;

/** Who someone is, as the server says. */
export interface PeerUser {
  id: string;
  name: string;
  /** 0–7: their color, the same for them everywhere */
  color: number;
  /** an AI client (an MCP token) acting in the notebook: whose token it is */
  agent?: { owner: string };
}

/** A cursor or selection in a cell, as positions that follow the text as it changes. */
export interface PeerCursor {
  cell: string;
  anchor: unknown;
  head: unknown;
}

/** Someone else here: which cell they are in, and where their cursor is. */
export interface Peer {
  client: number;
  user: PeerUser;
  cell: string | null;
  cursor: PeerCursor | null;
}

export class Collab {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  /** the document has come from the server: until then editors wait */
  synced = $state(false);
  /** everyone else here (their other tabs too), in the order they came */
  peers = $state<Peer[]>([]);
  /** bumped when cells come or go, so what reads `text` sees the new ones */
  private version = $state(0);

  private ws?: WebSocket;
  private closed = false;
  private retry = 0;
  private nextFlush = 1;
  private flushes = new Map<number, () => void>();

  constructor(
    private nb: string,
    /** a cell's text changed (here or elsewhere) */
    private ontext: (cell: string, text: string) => void,
  ) {
    this.awareness.setLocalState({ cell: null, cursor: null });
    const cells = this.cells();
    cells.observe(() => this.version++);
    cells.observeDeep((events) => {
      for (const e of events) {
        const name = e.path[0];
        if (typeof name !== "string") continue;
        const text = cells.get(name);
        if (text) this.ontext(name, text.toString());
      }
    });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.send(encoding.toUint8Array(enc));
    });
    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      if (origin === "local") {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, AWARENESS);
        encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
        this.send(encoding.toUint8Array(enc));
      }
      this.readPeers();
    });
    this.connect();
  }

  private cells(): Y.Map<Y.Text> {
    return this.doc.getMap<Y.Text>("cells");
  }

  /** A cell's shared text, once the room has it. */
  text(cell: string): Y.Text | undefined {
    void this.version;
    return this.synced ? this.cells().get(cell) : undefined;
  }

  /** The cell this page is in (null: none), for the others' borders and badges. */
  setCell(cell: string | null) {
    const cur = this.awareness.getLocalState();
    if (cur?.cell === cell) return;
    this.awareness.setLocalStateField("cell", cell);
    if (!cell) this.awareness.setLocalStateField("cursor", null);
  }

  setCursor(cursor: PeerCursor | null) {
    this.awareness.setLocalStateField("cursor", cursor);
  }

  /** Everything typed here is on disk, as far as the server has it: before a run reads the files. */
  flush(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve();
    const id = this.nextFlush++;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, FLUSH);
    encoding.writeVarUint(enc, id);
    this.ws.send(encoding.toUint8Array(enc) as Uint8Array<ArrayBuffer>);
    // a server that doesn't answer doesn't hold up a run for long
    return new Promise((resolve) => {
      const done = () => (this.flushes.delete(id), resolve());
      this.flushes.set(id, done);
      setTimeout(done, 3000);
    });
  }

  close() {
    this.closed = true;
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
    this.ws?.close();
    this.awareness.destroy();
    this.doc.destroy();
  }

  private readPeers() {
    const out: Peer[] = [];
    for (const [client, s] of this.awareness.getStates()) {
      if (client === this.doc.clientID || !s?.user) continue;
      out.push({ client, user: s.user, cell: s.cell ?? null, cursor: s.cursor ?? null });
    }
    this.peers = out;
  }

  private send(data: Uint8Array) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data as Uint8Array<ArrayBuffer>);
  }

  private connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/${this.nb.split("/").map(encodeURIComponent).join("/")}/collab`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.retry = 0;
      // what this page has that the server may not (edits made while offline), then who it is
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, SYNC);
      syncProtocol.writeSyncStep1(enc, this.doc);
      ws.send(encoding.toUint8Array(enc) as Uint8Array<ArrayBuffer>);
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, AWARENESS);
      encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
      ws.send(encoding.toUint8Array(a) as Uint8Array<ArrayBuffer>);
    };
    ws.onmessage = (e) => this.handle(new Uint8Array(e.data as ArrayBuffer));
    ws.onclose = (e) => {
      // the others' presence is gone with the connection; the text stays (it syncs on reconnect)
      awarenessProtocol.removeAwarenessStates(this.awareness, [...this.awareness.getStates().keys()].filter((c) => c !== this.doc.clientID), this);
      for (const done of [...this.flushes.values()]) done();
      if (e.code === 4401 || e.code === 4404) this.closed = true;
      if (!this.closed) setTimeout(() => this.connect(), Math.min(5000, 250 * 2 ** this.retry++));
    };
    this.ws = ws;
  }

  private handle(data: Uint8Array) {
    const dec = decoding.createDecoder(data);
    const kind = decoding.readVarUint(dec);
    if (kind === SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, SYNC);
      const step = syncProtocol.readSyncMessage(dec, enc, this.doc, this);
      if (encoding.length(enc) > 1) this.send(encoding.toUint8Array(enc));
      if (step === syncProtocol.messageYjsSyncStep2 && !this.synced) {
        this.synced = true;
        this.version++;
      }
    } else if (kind === AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), this);
    } else if (kind === FLUSH) {
      this.flushes.get(decoding.readVarUint(dec))?.();
    }
  }
}
