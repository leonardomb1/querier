import { expect, test } from "bun:test";
import { lineChanges } from "../web/src/lib/linediff";
import { callAt } from "../web/src/lib/basalt";
import { basaltGrammar } from "../web/src/lib/basalt-grammar";

test("a cell against its last commit: added, modified, deleted lines", () => {
  expect(lineChanges("a\nb\nc", "a\nb\nc")).toEqual({ added: [], modified: [], deleted: [] });
  expect(lineChanges("a\nb\nc", "a\nB\nc")).toEqual({ added: [], modified: [2], deleted: [] });
  expect(lineChanges("a\nc", "a\nb\nc")).toEqual({ added: [2], modified: [], deleted: [] });
  expect(lineChanges("a\nb\nc", "a\nc")).toEqual({ added: [], modified: [], deleted: [2] });
  // deleted at the end: marked past the last line
  expect(lineChanges("a\nb", "a")).toEqual({ added: [], modified: [], deleted: [2] });
  // two lines replaced by three: two changed, one added
  expect(lineChanges("x\na\nb\ny", "x\nA\nB\nC\ny")).toEqual({ added: [4], modified: [2, 3], deleted: [] });
});

test("the basalt call under the cursor, for parameter hints", () => {
  const src = "SELECT substr(name, 2, |";
  const at = callAt(src.replace("|", ""), src.indexOf("|"));
  expect(at?.fn.name).toBe("substr");
  expect(at?.arg).toBe(2);
  expect(callAt("SELECT 'substr(' || x", 18)).toBeNull();
});

test("basalt's grammar: its regexes compile", () => {
  const walk = (o: any): string[] => (o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => (["match", "begin", "end"].includes(k) ? [v as string] : walk(v))) : []);
  for (const re of walk(basaltGrammar)) expect(() => new RegExp(re.replace(/^\(\?i\)/, ""), "i")).not.toThrow();
});
