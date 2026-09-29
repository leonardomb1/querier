// A cron line in words, for the common shapes; anything else stays as cron.
// Unused for now: kept for scheduled publishing, if that is ever wanted.

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

const at = (h: string, m: string) => `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
const num = (s: string) => /^\d+$/.test(s);

export function describeCron(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = f;
  if (mon !== "*") return cron;
  const step = (s: string) => /^\*\/(\d+)$/.exec(s)?.[1];

  if (dom === "*" && dow === "*") {
    if (min === "*" && hour === "*") return "Every minute";
    if (step(min) && hour === "*") return `Every ${step(min)} minutes`;
    if (num(min) && hour === "*") return min === "0" ? "Hourly" : `Hourly at :${min.padStart(2, "0")}`;
    if (num(min) && step(hour)) return `Every ${step(hour)} hours`;
    if (num(min) && num(hour)) return `Daily at ${at(hour, min)}`;
  }
  if (num(min) && num(hour) && dom === "*") {
    if (dow === "1-5") return `Weekdays at ${at(hour, min)}`;
    if (num(dow) && +dow <= 7) return `${DAYS[+dow % 7]} at ${at(hour, min)}`;
  }
  if (num(min) && num(hour) && num(dom) && dow === "*") return `Monthly on day ${dom} at ${at(hour, min)}`;
  return cron;
}
