// What the signed-in person may do to a workspace or notebook: the server sends
// each one's `permissions`, and the pages hide what isn't theirs to do. (The
// server checks again: this is only so nobody is offered a button that fails.)

import type { Action, NotebookSummary } from "./api";
import { nbHref, viewHref } from "./href";
import type { MenuItem } from "../components/Menu.svelte";

export const can = (x: { permissions?: Action[] } | null | undefined, action: Action): boolean => !!x?.permissions?.includes(action);

/** Changing a workspace's settings: any of its settings' own permissions. */
export const SETTINGS_ACTIONS: Action[] = ["workspace.manage", "workspace.manageAccess", "sandbox.manage", "environment.manage", "ai.configure", "connection.manage"];
export const canConfigure = (x: { permissions?: Action[] } | null | undefined) => SETTINGS_ACTIONS.some((a) => can(x, a));

/** A menu's items, leaving out the `false` ones and the separators they leave dangling. */
export function menu(...items: (MenuItem | "-" | false | null | undefined)[]): (MenuItem | "-")[] {
  const out: (MenuItem | "-")[] = [];
  for (const it of items) {
    if (!it) continue;
    if (it === "-" && (!out.length || out[out.length - 1] === "-")) continue;
    out.push(it);
  }
  while (out[out.length - 1] === "-") out.pop();
  return out;
}

/** Where a notebook opens: its published report, for who may view that and not run the notebook. */
export const openHref = (b: Pick<NotebookSummary, "id" | "permissions" | "published">) => (!can(b, "notebook.run") && b.published ? viewHref(b.id) : nbHref(b.id));
