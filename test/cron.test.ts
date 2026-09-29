import { expect, test } from "bun:test";
import { describeCron } from "../web/src/lib/cron";

test("common cron shapes read as words", () => {
  expect(describeCron("0 * * * *")).toBe("Hourly");
  expect(describeCron("15 * * * *")).toBe("Hourly at :15");
  expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
  expect(describeCron("0 */6 * * *")).toBe("Every 6 hours");
  expect(describeCron("30 6 * * *")).toBe("Daily at 06:30");
  expect(describeCron("0 7 * * 1-5")).toBe("Weekdays at 07:00");
  expect(describeCron("0 9 * * 1")).toBe("Mondays at 09:00");
  expect(describeCron("0 0 1 * *")).toBe("Monthly on day 1 at 00:00");
  expect(describeCron("5 4 * 1 *")).toBe("5 4 * 1 *");
  expect(describeCron("nonsense")).toBe("nonsense");
});
