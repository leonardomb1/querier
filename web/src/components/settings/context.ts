// What a settings editor shares with its settings: the search, so each setting
// can hide itself, and a way to say a change was saved or refused.

import { getContext, setContext } from "svelte";

export interface SettingsCtx {
  /** the search box, lowercased: words, `@modified`, `@id:<id>` */
  readonly query: string;
  report(kind: "saved" | "error", text: string): void;
}

const KEY = Symbol("settings");
export const provideSettings = (ctx: SettingsCtx) => setContext(KEY, ctx);
export const useSettings = () => getContext<SettingsCtx>(KEY);

/** Whether a setting shows for the search. */
export function matches(query: string, s: { id: string; label: string; category: string; description?: string; modified?: boolean }): boolean {
  let words = query.trim();
  if (!words) return true;
  if (/(^|\s)@modified(\s|$)/.test(words)) {
    if (!s.modified) return false;
    words = words.replace(/(^|\s)@modified(\s|$)/, " ").trim();
  }
  const id = /(^|\s)@id:(\S+)/.exec(words);
  if (id) {
    if (!s.id.toLowerCase().startsWith(id[2])) return false;
    words = words.replace(id[0], " ").trim();
  }
  const hay = `${s.category} ${s.label} ${s.description ?? ""} ${s.id}`.toLowerCase();
  return words.split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}
