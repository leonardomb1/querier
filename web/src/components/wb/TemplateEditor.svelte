<script lang="ts">
  import type { Mark } from "../Editor.svelte";
  import type { NotebookCtl } from "../../lib/notebook.svelte";
  import type { TemplateCtl } from "../../lib/template.svelte";
  import { templateCompletion, templateHover, type TemplateData } from "../../lib/templatecomplete";
  import type { Workbench } from "../../lib/workbench.svelte";
  import Editor from "../Editor.svelte";

  // report.svelte: the report as a Svelte template. Its preview is the report tab,
  // beside it; the explorer offers the hooks, cells and theme it can use.
  let { ctl, wb, tpl, focused }: { ctl: NotebookCtl; wb: Workbench; tpl: TemplateCtl; focused: boolean } = $props();
  let editor = $state<ReturnType<typeof Editor>>();

  // what completion and hover know: the cells (with the columns the kernel holds) and the PARAMs
  const data = (): TemplateData => ({
    cells: (ctl.book?.cells ?? [])
      .filter((c) => c.lang !== "md")
      .map((c) => {
        const t = ctl.conn.tables.find((x) => x.name === c.name);
        return { name: c.name, rows: t?.rows, columns: t?.columns ?? [] };
      }),
    params: (ctl.book?.params ?? []).map((p) => ({ name: p.name, type: p.type, value: ctl.params[p.name] ?? "" })),
  });
  const complete = templateCompletion(data);
  const marks = $derived<Mark[]>(tpl.built?.error?.line ? [{ line: tpl.built.error.line, col: tpl.built.error.col, message: tpl.built.error.message }] : []);

  $effect(() => {
    wb.dirty.template = tpl.dirty;
    wb.actions.template = [
      { icon: "open-preview", title: "Open the report to the side", run: () => wb.open({ kind: "report" }, { side: true }) },
      { icon: "save", title: "Save  (Ctrl+S)", run: () => tpl.save(), disabled: !tpl.dirty },
      {
        icon: "trash",
        title: "Delete report.svelte (the blocks layout stays)",
        run: async () => {
          if (!confirm("Delete report.svelte? The blocks layout stays.")) return;
          await tpl.remove();
          wb.closeKey("template");
        },
      },
    ];
  });
  // the explorer's hooks and cells go in here while it has focus
  $effect(() => {
    if (!focused) return;
    wb.inserter = (t) => editor?.insert(t);
    wb.cursor = { line: 1, col: 1, lang: "Svelte" };
    return () => {
      if (wb.inserter) wb.inserter = null;
    };
  });
</script>

<Editor
  bind:this={editor}
  value={tpl.draft}
  lang="svelte"
  {marks}
  onchange={(s) => tpl.edit(s)}
  onsave={() => tpl.save()}
  oncursor={(line, col) => (wb.cursor = { line, col, lang: "Svelte" })}
  templateCompletion={complete}
  hover={(_, word) => templateHover(word, data())}
  fill
  wrap={false}
/>
