// What more than one settings scope offers.

import type { AiLevel } from "../../lib/api";

export const AI_LEVELS: { level: AiLevel; label: string; what: string }[] = [
  { level: "off", label: "Off", what: "Hidden from AI clients." },
  { level: "read", label: "Read", what: "Code, how cells depend on each other, schemas and errors. No rows leave." },
  { level: "run", label: "Run", what: "Also runs cells and scratch queries, and sees their results." },
  { level: "edit", label: "Edit", what: "Also writes, renames, moves and deletes cells, and lays out the report." },
];
export const aiLabel = (l: AiLevel) => AI_LEVELS.find((x) => x.level === l)?.label ?? l;

export const VCPUS = [1, 2, 4, 8, 16];
export const MEMORY: [number, string][] = [
  [512, "512 MB"],
  [1024, "1 GB"],
  [2048, "2 GB"],
  [4096, "4 GB"],
  [8192, "8 GB"],
  [16384, "16 GB"],
];
export const memoryLabel = (mb: number) => MEMORY.find(([m]) => m === mb)?.[1] ?? `${mb} MB`;
/** Querier's own sandbox size, when neither a notebook nor its workspace sets one */
export const SANDBOX_DEFAULT = { vcpus: 2, memory: 2048 };

/** A select's value: "" is "the default" */
export const num = (v: string) => (v === "" ? undefined : Number(v));

/** The scopes, as the editor's tabs. */
export type Scope = "user" | "workspace" | "notebook";
