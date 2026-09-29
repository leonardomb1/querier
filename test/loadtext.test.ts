import { expect, test } from "bun:test";
import { duration, rate, sentence } from "../web/src/lib/loadtext";

// the same cases as basalt's own obs.zig tests
test("durations and rates read as the CLI writes them", () => {
  expect(duration(771)).toBe("771ms");
  expect(duration(8_240)).toBe("8.2s");
  expect(duration(192_000)).toBe("3m 12s");
  expect(rate(2_439_024)).toBe("2.4M");
  expect(rate(48_312)).toBe("48.3k");
  expect(rate(377)).toBe("377");
});

test("the closing sentence", () => {
  const one = { loads_ok: 1, loads_failed: 0, rows_read: 20_000_000, rows_loaded: 20_000_000, lanes: 12, elapsed_ms: 8_200 };
  expect(sentence(one, "sr.bronze.orders").text).toBe("Loaded 20,000,000 rows into sr.bronze.orders in 8.2s (2.4M rows/s, 12 lanes)");
  const reduced = { loads_ok: 1, loads_failed: 0, rows_read: 4_000_000, rows_loaded: 7, lanes: 1, elapsed_ms: 1_900 };
  expect(sentence(reduced, "agg_out.csv").text).toBe("Read 4,000,000 rows, loaded 7 into agg_out.csv in 1.9s (2.1M rows/s)");
  const some = { loads_ok: 11, loads_failed: 1, rows_read: 9_482_004, rows_loaded: 9_482_004, lanes: 12, elapsed_ms: 192_000 };
  expect(sentence(some)).toEqual({ text: "Loaded 11 of 12 targets, 9,482,004 rows in 3m 12s (49.3k rows/s, 12 lanes)", failed: "1 failed" });
});
