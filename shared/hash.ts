// FNV-1a over UTF-16 code units: the server stamps each run with the hash of
// the source it ran, and the browser compares it with what is in the editor.
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
