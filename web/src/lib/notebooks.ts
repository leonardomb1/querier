// Renaming, moving and deleting whole notebooks and workspaces, with what this
// browser keeps for a notebook (its open tabs, PARAM values, folded cells)
// following along. A notebook's id is "workspace/notebook".

import { api, splitId } from "./api";
import { ask, askText, notifyError } from "./dialog.svelte";
import { homeHref, nbHref, wsHref } from "./href";

const KEYS = ["wb", "params", "folds"];

function moveKeys(from: string, to: string | null) {
  try {
    for (const k of KEYS) {
      const v = localStorage.getItem(`querier:${k}:${from}`);
      if (v != null && to) localStorage.setItem(`querier:${k}:${to}`, v);
      localStorage.removeItem(`querier:${k}:${from}`);
    }
  } catch {}
}

/** A new folder name, and/or another workspace; the new id. */
export async function renameNotebook(from: string, name: string, workspace?: string): Promise<string> {
  const { id } = await api.renameNotebook(from, name, workspace);
  moveKeys(from, id);
  return id;
}

export async function deleteNotebook(nb: string) {
  await api.removeNotebook(nb);
  moveKeys(nb, null);
}

/** A workspace renamed: its notebooks' ids change with it. */
export async function renameWorkspace(ws: string, to: string, notebooks: string[]): Promise<string> {
  const { name } = await api.workspace.rename(ws, to);
  for (const id of notebooks) moveKeys(id, `${name}/${splitId(id)[1]}`);
  return name;
}

export async function deleteWorkspace(ws: string, notebooks: string[]) {
  await api.workspace.remove(ws, notebooks.length > 0);
  for (const id of notebooks) moveKeys(id, null);
}

/** Ask for a new folder name, rename, and go there. */
export async function promptRename(nb: string) {
  const [, name] = splitId(nb);
  const typed = await askText(`Rename the folder of “${name}”`, {
    detail: "Its address and folder on the server; the title stays.",
    value: name,
    ok: "Rename",
    validate: (v) => (slugify(v) ? null : "Type a name with a letter or a digit."),
  });
  const to = typed == null ? "" : slugify(typed);
  if (!to || to === name) return;
  try {
    location.hash = nbHref(await renameNotebook(nb, to));
  } catch (e) {
    await notifyError("Couldn't rename the notebook", e);
  }
}

/** Are they sure? Deleting a notebook, by its id and title. */
export function confirmDeleteNotebook(id: string, title: string): Promise<boolean> {
  return ask(`Delete “${title}”?`, {
    detail: `Its folder (${id}/) and every file in it are deleted, with its shares and AI access setting. This can't be undone.`,
    ok: "Delete",
    danger: true,
  });
}

/** Confirm, delete, and go back to its workspace. */
export async function promptDelete(nb: string, title: string) {
  const [ws, name] = splitId(nb);
  if (!(await confirmDeleteNotebook(`${ws}/${name}`, title))) return;
  try {
    await deleteNotebook(nb);
    location.hash = wsHref(ws);
  } catch (e) {
    await notifyError("Couldn't delete the notebook", e);
  }
}

/** Confirm (naming what goes with it), delete, and go home. */
export async function promptDeleteWorkspace(ws: string, title: string, notebooks: string[]): Promise<boolean> {
  const n = notebooks.length;
  const what = n
    ? `Its ${n} notebook${n === 1 ? "" : "s"} go with it, every file in them, and the workspace's connections and settings. This can't be undone.`
    : "Its connections and settings go with it. This can't be undone.";
  // one with notebooks: its name typed, to be sure
  const sure = n
    ? (await askText(`Delete the workspace “${title}”?`, { detail: `${what}\n\nType ${ws} to delete it.`, mustMatch: ws, ok: "Delete workspace", danger: true })) === ws
    : await ask(`Delete the workspace “${title}”?`, { detail: what, ok: "Delete workspace", danger: true });
  if (!sure) return false;
  try {
    await deleteWorkspace(ws, notebooks);
    location.hash = homeHref();
    return true;
  } catch (e) {
    await notifyError("Couldn't delete the workspace", e);
    return false;
  }
}

/** A folder name from what someone typed: lowercase, accents dropped, dashes between words. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
