<script lang="ts">
  import { fade } from "svelte/transition";
  import type { CellRun, Output } from "../lib/conn.svelte";
  import LoadProgress from "./LoadProgress.svelte";
  import LoadReport from "./LoadReport.svelte";
  import Result from "./Result.svelte";
  import VegaView from "./VegaView.svelte";
  import type { Term } from "../lib/search";
  import { partOf } from "../lib/report";
  import type { Part as ReportPart } from "../../../shared/report";

  interface Props {
    run: CellRun;
    cell: string;
    /** The cell's result in full, from the kernel. */
    exportUrl?: string;
    /** A search over the cell's whole result, in the kernel. */
    onsearch?: (terms: Term[]) => Promise<{ rows: number; of: number; truncated: boolean; arrow?: Uint8Array; error?: string }>;
    /** Only these parts (a report block's choice); errors and loads always show. */
    show?: ReportPart[];
    /** A chart selection named after one of these PARAMs sets it (the report). */
    params?: string[];
    onparam?: (name: string, value: unknown) => void;
    onstop?: () => void;
    /** The session runs sandboxed: explain a refused connection, and where to allow it. */
    sandbox?: { egress: string } | null;
    onsandbox?: () => void;
  }
  let { run, cell, exportUrl, onsearch, show, params, onparam, onstop, sandbox = null, onsandbox }: Props = $props();
  const NETWORK = /refused|unreachable|timed? ?out|getaddrinfo|name or service|could not resolve|nodename|no route|network/i;

  type Load = Extract<Output, { type: "load" }>;
  type Totals = Extract<Output, { type: "loads" }>;
  type Part = { kind: "out"; o: Output; i: number } | { kind: "loads"; loads: Load[]; totals?: Totals; i: number };

  // A run's loads read as one report, where the first of them landed.
  const parts = $derived.by(() => {
    const out: Part[] = [];
    let group: Extract<Part, { kind: "loads" }> | undefined;
    run.outputs.forEach((o, i) => {
      if (o.type === "load" || o.type === "loads") {
        if (!group) out.push((group = { kind: "loads", loads: [], i }));
        if (o.type === "load") group.loads.push(o);
        else group.totals = o;
      } else if (!(o.type === "error" && o.shown)) {
        const p = show?.length ? partOf(o) : null;
        if (p && !show!.includes(p)) return;
        out.push({ kind: "out", o, i });
      }
    });
    return out;
  });

  const dataUrl = (bytes: Uint8Array, mime: string) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${mime};base64,${btoa(s)}`;
  };
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
</script>

{#if parts.length || run.progress}
  <div class="outputs">
    {#each parts as part (part.i)}
      <div class="item" in:fade={{ duration: 160 }}>
        {#if part.kind === "loads"}
          <LoadReport loads={part.loads} totals={part.totals} />
        {:else}
          {@const o = part.o}
          {#if o.type === "stream"}
            <pre class:stderr={o.stream === "stderr"}>{o.text.replace(/\n$/, "")}</pre>
          {:else if o.type === "error"}
            <div class="error">
              <pre>{o.message}{o.line ? `  (line ${o.line}${o.col ? `:${o.col}` : ""})` : ""}</pre>
              {#if sandbox && NETWORK.test(o.message)}
                <p class="sandbox-hint">
                  The sandbox refuses connections it wasn't given{sandbox.egress ? `; it allows ${sandbox.egress}` : ", and this notebook allows none"}.
                  <button onclick={onsandbox}>Sandbox settings</button>
                </p>
              {/if}
              {#if o.traceback}
                <details><summary>traceback</summary><pre>{o.traceback}</pre></details>
              {/if}
            </div>
          {:else if o.type === "display"}
            {#if o.mime === "application/vnd.vegalite+json"}
              <VegaView spec={JSON.parse(text(o.data))} {params} {onparam} />
            {:else if o.mime === "image/png"}
              <img src={dataUrl(o.data, o.mime)} alt="figure from {cell}" />
            {:else if o.mime === "text/html"}
              <iframe title="output of {cell}" sandbox="allow-scripts" srcdoc={text(o.data)}></iframe>
            {:else}
              <pre>{text(o.data)}</pre>
            {/if}
          {:else if o.type === "table"}
            <!-- only the cell's own result is kept under a name the kernel can export -->
            <Result out={o} exportUrl={o.name === cell ? exportUrl : undefined} onsearch={o.name === cell ? onsearch : undefined} />
          {/if}
        {/if}
      </div>
    {/each}
    {#if run.progress && run.state === "running"}
      <LoadProgress progress={run.progress} {onstop} />
    {/if}
  </div>
{/if}

<style>
  .outputs {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 0.625rem 0 0;
  }
  .item {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 22.5rem;
    overflow: auto;
  }
  .stderr {
    color: var(--muted);
  }
  .sandbox-hint {
    margin: 0.375rem 0 0;
    font-size: 0.8125rem;
    color: var(--ink-2);
  }
  .sandbox-hint button {
    font-size: 0.8125rem;
    color: var(--accent);
  }
  .error pre {
    color: var(--critical);
  }
  details {
    margin-top: 0.25rem;
  }
  summary {
    color: var(--muted);
    font-size: 0.75rem;
    cursor: pointer;
  }
  details pre {
    color: var(--ink-2) !important;
  }
  img {
    max-width: 100%;
    align-self: flex-start;
    border-radius: 4px;
  }
  iframe {
    width: 100%;
    height: 26.25rem;
    border: 1px solid var(--hair);
    border-radius: 6px;
    background: white;
    resize: vertical;
  }
</style>
