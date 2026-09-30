// Sending on a socket without losing anything. Bun (uWebSockets) buffers what a
// socket can't take yet, up to a limit (16 MB), and past it *drops* what is sent:
// a big result's table would go out and the small "done" after it would not, and
// the page would wait for a run that had finished. So what is sent while a socket
// is full waits here, in order, until Bun says it drained. A socket that stops
// reading altogether is closed rather than queued for without end.

import type { ServerWebSocket } from "bun";

type Data = string | Uint8Array;
const size = (d: Data) => (typeof d === "string" ? d.length * 2 : d.byteLength);
/** what one socket may have waiting before it is taken for gone */
const MAX_WAITING = 256 * 2 ** 20;

const waiting = new WeakMap<ServerWebSocket<any>, { items: Data[]; bytes: number }>();

/** Send on `ws`, after whatever is waiting for it. */
export function deliver(ws: ServerWebSocket<any>, data: Data) {
  const q = waiting.get(ws);
  if (q) {
    q.items.push(data);
    q.bytes += size(data);
    if (q.bytes > MAX_WAITING) {
      waiting.delete(ws);
      ws.close(4408, "not reading what it is sent");
    }
    return;
  }
  const sent = ws.send(data);
  // -1: taken, but it is full now: what follows waits. 0: not taken: it waits, and what follows
  if (sent === -1) waiting.set(ws, { items: [], bytes: 0 });
  else if (sent === 0 && ws.readyState === 1) waiting.set(ws, { items: [data], bytes: size(data) });
}

/** Bun's `drain`: the socket took what it had; send what waits, until it is full again. */
export function drained(ws: ServerWebSocket<any>) {
  const q = waiting.get(ws);
  if (!q) return;
  while (q.items.length) {
    const sent = ws.send(q.items[0]);
    if (sent === 0) return; // still full: the next drain
    q.bytes -= size(q.items.shift()!);
    if (sent === -1) return; // taken, and full again
  }
  waiting.delete(ws);
}
