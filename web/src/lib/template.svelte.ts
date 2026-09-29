// report.svelte, while the workbench has the notebook open: the source being
// edited, whether it is saved, and what the server made of it (its bundle's
// version, or where it fails to build). The template tab edits it; the report
// tab shows its bundle; the status bar and Problems panel read its errors.

import { api, type TemplateError } from "./api";
import type { NotebookCtl } from "./notebook.svelte";

export class TemplateCtl {
  draft = $state("");
  dirty = $state(false);
  saving = $state(false);
  built = $state<{ version: string; error: TemplateError | null; token: string } | null>(null);
  /** an error the template threw in its frame */
  frameError = $state("");
  private timer?: ReturnType<typeof setTimeout>;
  private seen: string | null = null;

  constructor(private ctl: NotebookCtl) {}

  /** The source on disk (notebook.template): take it unless there are edits of our own. */
  sync(source: string | null | undefined) {
    if (source === this.seen) return;
    this.seen = source ?? null;
    if (source == null) {
      this.built = null;
      if (!this.dirty) this.draft = "";
      return;
    }
    if (!this.dirty) this.draft = source;
    // a published report's: built from what was published, fetched with its own token
    const b = this.ctl.book;
    if (this.ctl.reportMode) return void (this.built = b?.templateVersion ? { version: b.templateVersion, error: null, token: b.templateToken ?? "" } : null);
    api.template.get(this.ctl.name).then((r) => r.source != null && (this.built = { version: r.version!, error: r.error ?? null, token: r.token ?? "" }), () => {});
  }

  edit(source: string) {
    this.draft = source;
    this.dirty = true;
    this.frameError = "";
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), 600);
  }

  async save() {
    clearTimeout(this.timer);
    if (!this.dirty) return;
    const source = this.draft;
    this.saving = true;
    const r = await api.template.save(this.ctl.name, source).catch((e) => ({ version: this.built?.version ?? "", error: { message: e.message } as TemplateError, token: this.built?.token ?? "" }));
    this.saving = false;
    this.built = r;
    this.seen = source;
    if (this.draft === source) this.dirty = false;
  }

  async create(source: string) {
    this.draft = source;
    this.dirty = true;
    await this.save();
    await this.ctl.setReport((r) => (r.view = "template"));
    await this.ctl.refresh();
  }

  async remove() {
    clearTimeout(this.timer);
    await api.template.remove(this.ctl.name);
    this.dirty = false;
    this.draft = "";
    this.built = null;
    await this.ctl.setReport((r) => delete r.view);
    await this.ctl.refresh();
  }
}
