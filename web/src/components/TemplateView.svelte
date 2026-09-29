<script lang="ts">
  import { onMount } from "svelte";
  import { nbUrl } from "../lib/api";
  import type { NotebookCtl } from "../lib/notebook.svelte";
  import { isDark } from "../lib/vegatheme";
  import { zoom } from "../lib/zoom.svelte";

  // The report as its Svelte template, in a sandboxed frame: scripts run, but with
  // no origin of their own — no access to this page, its storage or Querier's API.
  // What the template may know arrives as messages (web/src/template/runtime.svelte.ts):
  // the cells it names, the PARAM values, the theme. The one thing it can ask back
  // is to set a PARAM.
  // `token`: the frame sends no cookie, so its script is fetched with a signed token
  let { ctl, version, token, cells, onerror }: { ctl: NotebookCtl; version: string; token: string; cells: string[]; onerror?: (message: string) => void } = $props();

  let frame = $state<HTMLIFrameElement>();
  let ready = $state(false);
  let height = $state(160);

  const src = $derived(`${location.origin}${nbUrl(ctl.name)}/template.js?v=${version}&t=${encodeURIComponent(token)}${ctl.reportMode ? "&published=1" : ""}`);
  // a new bundle, a new document
  const srcdoc = $derived(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
      `<style>html,body{margin:0;background:transparent!important}#app{padding:1px 0}</style>` +
      `<script src="${src}"></` + `script></head><body><div id="app"></div></body></html>`,
  );
  $effect(() => {
    void srcdoc;
    ready = false;
  });

  /** The page's styles (theme tokens, fonts, base elements), for the frame to look the same. */
  function pageCss(): string {
    let out = "";
    for (const sheet of document.styleSheets) {
      try {
        for (const r of sheet.cssRules) out += r.cssText + "\n";
      } catch {} // another origin's sheet
    }
    return out;
  }

  const post = (m: object) => frame?.contentWindow?.postMessage(m, "*");
  const paramNames = $derived((ctl.book?.params ?? []).map((p) => p.name));
  const theme = () => (isDark() ? "dark" : "light");

  onMount(() => {
    const onmessage = (e: MessageEvent) => {
      if (!frame || e.source !== frame.contentWindow) return; // only our frame speaks here
      const m = e.data;
      switch (m?.type) {
        case "ready":
          post({ type: "init", theme: theme(), zoom: zoom.value, css: pageCss(), params: { ...ctl.params }, paramNames });
          sent.clear();
          ready = true;
          break;
        case "height":
          if (typeof m.px === "number") height = Math.max(40, Math.min(m.px, 100_000));
          break;
        case "param":
          // only the notebook's PARAMs, only as text
          if (typeof m.name === "string" && paramNames.includes(m.name)) ctl.setParam(m.name, String(m.value ?? ""));
          break;
        case "error":
          onerror?.(String(m.message ?? "the template failed"));
          break;
      }
    };
    addEventListener("message", onmessage);
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const retheme = () => post({ type: "theme", theme: theme() });
    mq.addEventListener("change", retheme);
    return () => {
      removeEventListener("message", onmessage);
      mq.removeEventListener("change", retheme);
    };
  });

  // each cell the template names, sent again when its run changes
  const sent = new Map<string, string>();
  $effect(() => {
    if (!ready) return;
    for (const c of cells) {
      const run = ctl.conn.runs[c];
      if (!run) continue;
      const sig = `${run.state}|${run.outputs.length}|${run.ms}|${run.ran?.seq}`;
      if (sent.get(c) === sig) continue;
      sent.set(c, sig);
      post({ type: "cell", cell: c, run: $state.snapshot(run) });
    }
  });
  $effect(() => {
    const params = { ...ctl.params };
    if (ready) post({ type: "params", params });
  });
</script>

<!-- allow-scripts without allow-same-origin: the template gets an opaque origin of its own -->
<iframe
  bind:this={frame}
  title="Report"
  sandbox="allow-scripts allow-popups"
  allow="clipboard-write"
  {srcdoc}
  style:height="{height}px"
  class:loading={!ready}
></iframe>

<style>
  iframe {
    display: block;
    width: 100%;
    border: 0;
    transition: opacity 0.2s var(--ease);
  }
  .loading {
    opacity: 0.4;
  }
</style>
