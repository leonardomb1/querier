// A big message and small ones after it: every one arrives, in order. Sent plainly,
// Bun drops what follows a message bigger than its buffer (the page then waited
// for a run that had finished).
import { expect, test } from "bun:test";
import { deliver, drained } from "../server/socket";

test("what is sent while a socket is full waits for it to drain, in order", async () => {
  const plain: number[] = [];
  const server = Bun.serve<{ plain: boolean }>({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req, { data: { plain: new URL(req.url).searchParams.has("plain") } }) ? undefined : new Response("no")),
    websocket: {
      drain: (ws) => drained(ws),
      open(ws) {
        const big = new Uint8Array(20 * 2 ** 20);
        if (ws.data.plain) for (const d of [big, "done", "tables"]) plain.push(ws.send(d));
        else for (const d of [big, "done", "tables"]) deliver(ws, d);
      },
      message() {},
    },
  });
  const receive = async (query: string) => {
    const got: string[] = [];
    const ws = new WebSocket(`ws://localhost:${server.port}/${query}`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => got.push(typeof e.data === "string" ? e.data : `${(e.data as ArrayBuffer).byteLength} bytes`);
    for (let i = 0; i < 100 && got.length < 3; i++) await Bun.sleep(30);
    ws.close();
    return got;
  };
  // the trouble, as it is: sent plainly, what follows the big one is dropped
  expect(await receive("?plain")).toEqual([`${20 * 2 ** 20} bytes`]);
  expect(plain.slice(1)).toEqual([0, 0]);
  // through deliver: all of it, in order
  expect(await receive("")).toEqual([`${20 * 2 ** 20} bytes`, "done", "tables"]);
  server.stop(true);
});
