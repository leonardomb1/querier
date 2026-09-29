import { expect, test } from "bun:test";
import { copyText, type CopyColumn } from "../web/src/lib/copy";

const col = (name: string, values: any[], right = false): CopyColumn => ({
  name,
  right,
  plain: (v) => (v == null ? "" : String(v)),
  fmt: (v) => (v == null ? null : right ? Number(v).toLocaleString("en") : String(v)),
  vec: { get: (i) => values[i] },
});
const cols = [col("region", ["north", 'say "hi"', "a\tb", null, "o'neil"]), col("revenue", [1234.5, 2, 3, 4, 5], true)];

test("TSV pastes into spreadsheet cells: tabs, quotes and newlines are quoted", () => {
  expect(copyText("tsv", cols, [0, 1, 2])).toBe('north\t1234.5\n"say ""hi"""\t2\n"a\tb"\t3');
  expect(copyText("tsv-head", cols, [0])).toBe("region\trevenue\nnorth\t1234.5");
  expect(copyText("tsv", cols, [3])).toBe("\t4"); // null is an empty cell
});

test("CSV, Markdown and JSON", () => {
  expect(copyText("csv", cols, [0, 1])).toBe('region,revenue\nnorth,1234.5\n"say ""hi""",2');
  expect(copyText("markdown", cols, [0])).toBe("| region | revenue |\n| --- | ---: |\n| north | 1,234.5 |");
  expect(JSON.parse(copyText("json", cols, [0, 3]))).toEqual([
    { region: "north", revenue: 1234.5 },
    { region: null, revenue: 4 },
  ]);
  // integers past 2^53 stay exact, as strings
  expect(JSON.parse(copyText("json", [col("id", ["9007199254740993"], true)], [0]))).toEqual([{ id: "9007199254740993" }]);
});

test("a column as a SQL list: distinct, quoted, nulls left out", () => {
  expect(copyText("sql", [cols[0]], [0, 0, 3, 4])).toBe("('north', 'o''neil')");
  expect(copyText("sql", [cols[1]], [0, 1, 1])).toBe("(1234.5, 2)");
});
