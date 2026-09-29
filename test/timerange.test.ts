import { expect, test } from "bun:test";
import { describe, paramText, resolve } from "../web/src/lib/timerange";

const now = new Date(2026, 8, 28, 15, 30, 45); // Mon 28 Sep 2026, 15:30:45 local

test("relative ends resolve like Grafana's", () => {
  const at = (s: string, end = false) => paramText(resolve(s, now, end), "TIMESTAMP");
  expect(at("now")).toBe("2026-09-28 15:30:45");
  expect(at("now-7d")).toBe("2026-09-21 15:30:45");
  expect(at("now-15m")).toBe("2026-09-28 15:15:45");
  expect(at("now/d")).toBe("2026-09-28 00:00:00");
  expect(at("now/d", true)).toBe("2026-09-28 23:59:59");
  expect(at("now/M")).toBe("2026-09-01 00:00:00");
  expect(at("now-1M/M", true)).toBe("2026-08-31 23:59:59");
  expect(at("now/w")).toBe("2026-09-28 00:00:00");
  expect(at("now/y")).toBe("2026-01-01 00:00:00");
  expect(at("2026-01-15 08:00:00")).toBe("2026-01-15 08:00:00");
});

test("params take a DATE or a TIMESTAMP; presets have names", () => {
  expect(paramText(resolve("now-30d", now, false), "DATE")).toBe("2026-08-29");
  expect(describe({ from: "now-7d", to: "now" }, now)).toBe("Last 7 days");
  expect(describe({ from: "2026-01-01 00:00:00", to: "2026-01-31 12:00:00" }, now)).toBe("2026-01-01 → 2026-01-31 12:00");
});
