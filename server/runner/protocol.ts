// frame = u32be json_len | json | u32be bin_len | bin  (mirrors kernel/kernel.py)

export interface Frame {
  meta: any;
  data: Uint8Array;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeFrame(meta: unknown, data: Uint8Array = new Uint8Array()): Uint8Array {
  const head = enc.encode(JSON.stringify(meta));
  const out = new Uint8Array(8 + head.length + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, head.length);
  out.set(head, 4);
  view.setUint32(4 + head.length, data.length);
  out.set(data, 8 + head.length);
  return out;
}

export async function* decodeFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<Frame> {
  let buf = new Uint8Array(0);
  let pos = 0;
  for await (const chunk of stream) {
    const rest = buf.subarray(pos);
    buf = new Uint8Array(rest.length + chunk.length);
    buf.set(rest);
    buf.set(chunk, rest.length);
    pos = 0;
    for (;;) {
      const view = new DataView(buf.buffer, buf.byteOffset + pos, buf.length - pos);
      if (view.byteLength < 4) break;
      const n = view.getUint32(0);
      if (view.byteLength < 8 + n) break;
      const m = view.getUint32(4 + n);
      if (view.byteLength < 8 + n + m) break;
      const meta = JSON.parse(dec.decode(buf.subarray(pos + 4, pos + 4 + n)));
      const data = buf.slice(pos + 8 + n, pos + 8 + n + m);
      pos += 8 + n + m;
      yield { meta, data };
    }
  }
}
