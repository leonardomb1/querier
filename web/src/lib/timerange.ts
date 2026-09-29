// Grafana's relative time: `now`, `now-7d`, `now/M` (start of this month),
// `now-1M/M` (last month). Stored relative, so a refresh moves with the clock;
// resolved to the notebook's `from` / `to` PARAMs as local wall-clock text.

export interface Range {
  from: string;
  to: string;
}

export const PRESETS: [string, Range][] = [
  ["Last 15 minutes", { from: "now-15m", to: "now" }],
  ["Last 1 hour", { from: "now-1h", to: "now" }],
  ["Last 6 hours", { from: "now-6h", to: "now" }],
  ["Last 24 hours", { from: "now-24h", to: "now" }],
  ["Last 7 days", { from: "now-7d", to: "now" }],
  ["Last 30 days", { from: "now-30d", to: "now" }],
  ["Last 90 days", { from: "now-90d", to: "now" }],
  ["Last 1 year", { from: "now-1y", to: "now" }],
  ["Today", { from: "now/d", to: "now/d" }],
  ["Yesterday", { from: "now-1d/d", to: "now-1d/d" }],
  ["This month", { from: "now/M", to: "now/M" }],
  ["Last month", { from: "now-1M/M", to: "now-1M/M" }],
  ["This year", { from: "now/y", to: "now/y" }],
];

const REL = /^now(?:([+-])(\d+)([smhdwMy]))?(?:\/([dwMy]))?$/;

function shift(d: Date, sign: number, n: number, unit: string) {
  const v = sign * n;
  if (unit === "s") d.setSeconds(d.getSeconds() + v);
  else if (unit === "m") d.setMinutes(d.getMinutes() + v);
  else if (unit === "h") d.setHours(d.getHours() + v);
  else if (unit === "d") d.setDate(d.getDate() + v);
  else if (unit === "w") d.setDate(d.getDate() + 7 * v);
  else if (unit === "M") d.setMonth(d.getMonth() + v);
  else if (unit === "y") d.setFullYear(d.getFullYear() + v);
}

/** One end of a range as a Date. `end` rounds up: `now/M` as `to` is the month's last moment. */
export function resolve(spec: string, now: Date, end: boolean): Date {
  const m = REL.exec(spec.trim());
  if (!m) {
    const d = new Date(spec.replace(" ", "T"));
    return isNaN(+d) ? now : d;
  }
  const d = new Date(now);
  if (m[1]) shift(d, m[1] === "-" ? -1 : 1, Number(m[2]), m[3]);
  const round = m[4];
  if (round) {
    d.setHours(0, 0, 0, 0);
    if (round === "w") d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // weeks start on Monday
    if (round === "M" || round === "y") d.setDate(1);
    if (round === "y") d.setMonth(0);
    if (end) {
      shift(d, 1, 1, round === "d" ? "d" : round === "w" ? "w" : round);
      d.setMilliseconds(-1);
    }
  }
  return d;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A Date as a PARAM value: `YYYY-MM-DD` for a DATE, `YYYY-MM-DD HH:MM:SS` otherwise. */
export function paramText(d: Date, type: string): string {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return /^DATE\b/i.test(type) ? date : `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** How the picker labels a range: a preset's name, or its two ends. */
export function describe(r: Range, now = new Date()): string {
  const preset = PRESETS.find(([, p]) => p.from === r.from && p.to === r.to);
  if (preset) return preset[0];
  const f = (s: string, end: boolean) => paramText(resolve(s, now, end), "TIMESTAMP").replace(/ 00:00:00$/, "").replace(/:00$/, "");
  return `${f(r.from, false)} → ${f(r.to, true)}`;
}
