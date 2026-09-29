// Modal dialogs, in place of the browser's alert(), confirm() and prompt():
// each returns a promise, and one host (components/ui/Dialogs.svelte, in App)
// shows them in turn, in the app's own look.
//
//   await notify("Couldn't move it", { detail: e.message, kind: "error" });
//   if (!(await ask("Delete “Sales”?", { detail: "This can't be undone.", ok: "Delete", danger: true }))) return;
//   const name = await askText("New folder name", { value: "sales", validate: (v) => (v ? null : "Type a name.") });

export type DialogKind = "info" | "warning" | "error";

export interface DialogRequest {
  mode: "notify" | "ask" | "text";
  kind: DialogKind;
  title: string;
  /** more, under the title: what happens, why it failed */
  detail?: string;
  /** the primary button's words: "Delete", "Rename" */
  ok: string;
  cancel: string;
  /** the primary button is destructive */
  danger?: boolean;
  /** text: its starting value, a placeholder, and a check (a message: not yet) */
  value?: string;
  placeholder?: string;
  validate?: (value: string) => string | null;
  /** text: it must be typed exactly (to confirm deleting something big) */
  mustMatch?: string;
  resolve: (answer: boolean | string | null) => void;
}

interface Common {
  detail?: string;
  kind?: DialogKind;
}

class Dialogs {
  queue = $state<DialogRequest[]>([]);

  open(r: Omit<DialogRequest, "resolve">): Promise<boolean | string | null> {
    return new Promise((resolve) => this.queue.push({ ...r, resolve }));
  }

  /** Answer the dialog showing, and show the next. */
  answer(value: boolean | string | null) {
    const r = this.queue.shift();
    r?.resolve(value);
  }
}

export const dialogs = new Dialogs();

/** Tell the person something: one button. */
export function notify(title: string, o: Common & { ok?: string } = {}): Promise<void> {
  return dialogs.open({ mode: "notify", kind: o.kind ?? "info", title, detail: o.detail, ok: o.ok ?? "OK", cancel: "" }).then(() => {});
}

/** A failure, from an error or a message. */
export function notifyError(title: string, e: unknown): Promise<void> {
  return notify(title, { kind: "error", detail: e instanceof Error ? e.message : String(e) });
}

/** A yes or no: true when they chose `ok`. */
export function ask(title: string, o: Common & { ok?: string; cancel?: string; danger?: boolean } = {}): Promise<boolean> {
  return dialogs
    .open({ mode: "ask", kind: o.kind ?? (o.danger ? "warning" : "info"), title, detail: o.detail, ok: o.ok ?? "OK", cancel: o.cancel ?? "Cancel", danger: o.danger })
    .then((a) => a === true);
}

/** A line of text, or null when cancelled. */
export function askText(
  title: string,
  o: Common & { ok?: string; cancel?: string; value?: string; placeholder?: string; validate?: (v: string) => string | null; mustMatch?: string; danger?: boolean } = {},
): Promise<string | null> {
  return dialogs
    .open({
      mode: "text",
      kind: o.kind ?? (o.danger ? "warning" : "info"),
      title,
      detail: o.detail,
      ok: o.ok ?? "OK",
      cancel: o.cancel ?? "Cancel",
      danger: o.danger,
      value: o.value ?? "",
      placeholder: o.placeholder,
      validate: o.validate,
      mustMatch: o.mustMatch,
    })
    .then((a) => (typeof a === "string" ? a : null));
}
