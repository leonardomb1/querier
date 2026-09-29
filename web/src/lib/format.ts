// Arrow values → display text, per column type.

import { type DataType, type Field, type Table, Type, tableFromIPC } from "apache-arrow";

export type Kind = "int" | "float" | "decimal" | "date" | "timestamp" | "time" | "bool" | "string" | "other";

export function kindOf(t: DataType): Kind {
  switch (t.typeId) {
    case Type.Int:
      return "int";
    case Type.Float:
      return "float";
    case Type.Decimal:
      return "decimal";
    case Type.Date:
      return "date";
    case Type.Timestamp:
      return "timestamp";
    case Type.Time:
      return "time";
    case Type.Bool:
      return "bool";
    case Type.Utf8:
    case Type.LargeUtf8:
    case Type.Dictionary:
      return "string";
    default:
      return "other";
  }
}

export const isNumeric = (k: Kind) => k === "int" || k === "float" || k === "decimal";
export const isTemporal = (k: Kind) => k === "date" || k === "timestamp";

/** A short type label for a column header. */
export function typeLabel(t: DataType): string {
  const k = kindOf(t);
  if (k === "decimal") return `decimal(${(t as any).precision},${(t as any).scale})`;
  if (k !== "other") return k;
  if (t.typeId === Type.List || t.typeId === Type.LargeList || t.typeId === Type.FixedSizeList) return "list";
  if (t.typeId === Type.Struct) return "struct";
  if (t.typeId === Type.Binary || t.typeId === Type.LargeBinary) return "bytes";
  if (t.typeId === Type.Duration) return "duration";
  return String(t).toLowerCase();
}

const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const decimalSep = new Intl.NumberFormat().formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".";
const floatFmt = [2, 4, 6].map((d) => new Intl.NumberFormat(undefined, { maximumFractionDigits: d }));

// Identifiers and years read wrong with thousands separators.
const PLAIN_INT = /(^|_)(id|year|yr|ano|code|codigo|cod)$|^(id|year)/i;

const json = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === "bigint" ? Number(x) : x instanceof Uint8Array ? `<${x.length} bytes>` : x));

const pad = (n: number | bigint, w = 2) => String(n).padStart(w, "0");

function isoTimestamp(ms: number): string {
  const d = new Date(Math.floor(ms));
  if (isNaN(+d)) return String(ms);
  const s = d.toISOString().replace("T", " ").replace("Z", "");
  const micros = Math.round((ms - Math.floor(ms)) * 1000);
  return (micros ? s + pad(micros, 3) : s).replace(/\.000$/, "");
}

/** value → text, or null for a null. */
export function formatter(field: Field): (v: any) => string | null {
  const t = field.type;
  const k = kindOf(t);
  switch (k) {
    case "int":
      if (PLAIN_INT.test(field.name)) return (v) => (v == null ? null : String(v));
      return (v) => (v == null ? null : nf.format(v));
    case "float":
      return (v) => {
        if (v == null) return null;
        if (!isFinite(v)) return String(v);
        const a = Math.abs(v);
        return floatFmt[a >= 1000 ? 0 : a >= 1 ? 1 : 2].format(v);
      };
    case "decimal": {
      const scale = (t as any).scale as number;
      return (v) => {
        if (v == null) return null;
        let s = String(v);
        const neg = s.startsWith("-");
        if (neg) s = s.slice(1);
        s = s.padStart(scale + 1, "0");
        const int = nf.format(BigInt(s.slice(0, s.length - scale)));
        const frac = scale ? decimalSep + s.slice(s.length - scale) : "";
        return (neg ? "-" : "") + int + frac;
      };
    }
    case "date":
      return (v) => (v == null ? null : new Date(v).toISOString().slice(0, 10));
    case "timestamp":
      return (v) => (v == null ? null : isoTimestamp(v));
    case "time": {
      const perSecond = [1, 1e3, 1e6, 1e9][(t as any).unit as number];
      return (v) => {
        if (v == null) return null;
        const total = Number(v) / perSecond;
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return `${pad(h)}:${pad(m)}:${pad(Math.floor(s))}${s % 1 ? (s % 1).toFixed(3).slice(1) : ""}`;
      };
    }
    case "bool":
      return (v) => (v == null ? null : String(v));
    case "string":
      return (v) => (v == null ? null : String(v));
    default:
      if (t.typeId === Type.Duration) {
        const perSecond = [1, 1e3, 1e6, 1e9][(t as any).unit as number];
        return (v) => (v == null ? null : `${floatFmt[0].format(Number(v) / perSecond)}s`);
      }
      return (v) => (v == null ? null : json(v?.toJSON ? v.toJSON() : v));
  }
}

/** A value as a number, for sorting and stats (dates and timestamps as epoch ms). */
export function numeric(field: Field): (v: any) => number | null {
  const k = kindOf(field.type);
  if (k === "decimal") {
    const scale = 10 ** (field.type as any).scale;
    return (v) => (v == null ? null : Number(String(v)) / scale);
  }
  if (k === "int" || k === "float" || k === "date" || k === "timestamp")
    return (v) => (v == null ? null : Number(v));
  return () => null;
}

const tables = new WeakMap<Uint8Array, Table>();

/** Decoded once per IPC buffer, however many components read it. */
export function arrowTable(buf: Uint8Array): Table {
  let t = tables.get(buf);
  if (!t) tables.set(buf, (t = tableFromIPC(buf)));
  return t;
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "5 minutes ago", "yesterday", or a date when it's long ago. */
export function ago(ms: number) {
  const m = Math.round((ms - Date.now()) / 60000);
  if (Math.abs(m) < 60) return m === 0 ? "just now" : rtf.format(m, "minute");
  const h = Math.round(m / 60);
  if (Math.abs(h) < 48) return rtf.format(h, "hour");
  const d = Math.round(h / 24);
  return Math.abs(d) < 60 ? rtf.format(d, "day") : new Date(ms).toLocaleDateString();
}

/** A value as a machine reads it, for copying: numbers without grouping or
 *  rounding (decimals exact, with a "."), dates and times as ISO. */
export function plainText(field: Field): (v: any) => string {
  const k = kindOf(field.type);
  const shown = formatter(field);
  if (k === "int" || k === "float") return (v) => (v == null ? "" : String(v));
  if (k === "decimal") {
    const scale = (field.type as any).scale as number;
    return (v) => {
      if (v == null) return "";
      let s = String(v);
      const neg = s.startsWith("-");
      if (neg) s = s.slice(1);
      s = s.padStart(scale + 1, "0");
      return (neg ? "-" : "") + s.slice(0, s.length - scale) + (scale ? "." + s.slice(s.length - scale) : "");
    };
  }
  return (v) => (v == null ? "" : (shown(v) ?? ""));
}
