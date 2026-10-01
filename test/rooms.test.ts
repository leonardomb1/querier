// An AI client in a notebook's room (collab.ts): whoever has the notebook open sees it there as a
// collaborator, its name and whose it is, in the cell it changed, its cursor where it changed it.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { Rooms } from "../server/collab";
import { Store } from "../server/store";

test("an AI client acting on a cell is present to the room: name, owner, cell, cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "querier-rooms-"));
  try {
    await mkdir(join(root, "w/n"), { recursive: true });
    await Bun.write(join(root, "w/workspace.json"), "{}");
    await Bun.write(join(root, "w/n/01_q.sql"), "SELECT 1;\n");
    const store = new Store(root);
    const rooms = new Rooms(store, () => {});

    // a page in the room: its copy of the text, and who it sees
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    const peer = {
      send(data: Uint8Array) {
        const dec = decoding.createDecoder(data);
        const kind = decoding.readVarUint(dec);
        if (kind === 0) syncProtocol.readSyncMessage(dec, encoding.createEncoder(), doc, "server");
        else if (kind === 1) awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), "server");
      },
    };
    await rooms.join("w/n", peer, { id: "corp:ana", provider: "corp", subject: "ana", username: "ana", name: "Ana", groups: [], attrs: {} }, () => true);
    // the page asks for the document, as a page does
    const ask = encoding.createEncoder();
    encoding.writeVarUint(ask, 0);
    syncProtocol.writeSyncStep1(ask, doc);
    rooms.message("w/n", peer, encoding.toUint8Array(ask));
    expect(doc.getMap<Y.Text>("cells").get("q")?.toString()).toBe("SELECT 1;\n");

    const agent = { id: "agent:abc", name: "Claude Code on my laptop", color: 2, agent: { owner: "Ana" } };
    const seen = () => [...awareness.getStates().values()].find((s: any) => s?.user?.id === "agent:abc") as any;
    const cursorAt = () => Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(seen().cursor.head), doc)?.index;

    await rooms.agent("w/n", agent, "q", 7);
    expect(seen()).toMatchObject({ user: { name: "Claude Code on my laptop", agent: { owner: "Ana" } }, cell: "q" });
    expect(cursorAt()).toBe(7);

    // it changes the file (as an MCP edit does): the room takes it in, and the cursor points into the new text
    await store.save("w/n", "q", "-- by the AI\nSELECT 1;\n");
    void rooms.changed("w/n");
    await rooms.agent("w/n", agent, "q", 12);
    expect(doc.getMap<Y.Text>("cells").get("q")?.toString()).toBe("-- by the AI\nSELECT 1;\n");
    expect(cursorAt()).toBe(12);

    // in no cell (a template edit): present in the notebook, no cursor
    await rooms.agent("w/n", agent, null);
    expect(seen()).toMatchObject({ cell: null, cursor: null });
    // a notebook nobody has open: nothing to show, nothing fails
    await rooms.agent("w/other", agent, "q", 0);
    rooms.drop("w/n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
