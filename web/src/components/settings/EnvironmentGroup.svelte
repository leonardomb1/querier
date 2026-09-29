<script lang="ts">
  import { onDestroy } from "svelte";
  import { slide } from "svelte/transition";
  import { api, type EnvState } from "../../lib/api";
  import { ago } from "../../lib/format";
  import Icon from "../Icon.svelte";
  import { useSettings } from "./context";
  import Setting from "./Setting.svelte";

  // A workspace's or notebook's environment, as settings: the Python packages its
  // kernels get and the npm packages its report templates may import. Each list is
  // edited, then applied: locked (uv.lock, bun.lock in the folder) and built on the
  // server, in force once built. What is in force, and whether the folder's files
  // have moved on since (a pull), is shown under each.
  let { scope, target, prefix }: { scope: "workspace" | "notebook"; target: string; prefix: string } = $props();

  const settings = useSettings();
  let env = $state<{ python: EnvState; js: EnvState } | null>(null);
  let drafts = $state<Record<"python" | "js", string[]>>({ python: [], js: [] });
  let adding = $state<Record<"python" | "js", string>>({ python: "", js: "" });
  let openLog = $state<Record<string, boolean>>({});
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function load(first = false) {
    try {
      env = await api.environment.get(scope, target);
      if (first) drafts = { python: [...env.python.dependencies], js: [...env.js.dependencies] };
      // a build going on: its state again shortly
      clearTimeout(timer);
      if (env.python.status === "building" || env.js.status === "building") timer = setTimeout(() => load(), 1500);
    } catch (e: any) {
      settings.report("error", e.message);
    }
  }
  // svelte-ignore state_referenced_locally
  load(true);
  onDestroy(() => clearTimeout(timer));

  function add(kind: "python" | "js") {
    const v = adding[kind].trim();
    if (!v) return;
    // a new version of one already there replaces it
    const name = (d: string) => (kind === "python" ? d.split(/[\s<>=!~[]/)[0] : d.replace(/(?<=.)@.*$/, "")).toLowerCase();
    drafts[kind] = [...drafts[kind].filter((d) => name(d) !== name(v)), v];
    adding[kind] = "";
  }
  async function apply(kind: "python" | "js", deps = drafts[kind]) {
    try {
      env = await api.environment.apply(scope, target, kind, deps);
      drafts[kind] = [...deps];
      settings.report("saved", kind === "python" ? "Python packages: building" : "Template packages: building");
      load();
    } catch (e: any) {
      settings.report("error", e.message);
    }
  }
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const dirty = (kind: "python" | "js") => !!env && !same(drafts[kind], env[kind].applied?.dependencies ?? []);

  const KINDS = $derived([
    {
      kind: "python" as const,
      id: "python",
      label: "Python packages",
      description: scope === "workspace" ? "What every notebook's kernel can import, besides polars, altair, great_tables and matplotlib." : "What this notebook's kernel can import on top of its workspace's.",
      placeholder: "pyarrow, scikit-learn==1.5.2, requests>=2",
      info: "From PyPI, as wheels (nothing is compiled). Locked with uv into pyproject.toml and uv.lock in the folder, so they travel with git; installed on the server, never in a sandbox. A notebook's packages shadow its workspace's, which shadow the image's.",
    },
    {
      kind: "js" as const,
      id: "js",
      label: "Template packages",
      description: "npm packages a report template (report.svelte) may import, bundled into it.",
      placeholder: "d3@^7, @observablehq/plot",
      info: "From npm. Locked with Bun into package.json and bun.lock in the folder; installed with their install scripts off. The template runs in a sandboxed frame with them.",
    },
  ]);
</script>

<section class="group" id="set-{prefix}-environment">
  <h2>Environment</h2>
  {#each KINDS as k (k.kind)}
    {@const s = env?.[k.kind]}
    <Setting id="{prefix === 'ws' ? 'workspace' : 'notebook'}.environment.{k.id}" category="Environment" label={k.label} description={k.description} info={k.info} modified={!!s?.applied}>
      <ul class="deps">
        {#each drafts[k.kind] as d (d)}
          <li transition:slide={{ duration: 120 }}>
            <code>{d}</code>
            {#if !s?.applied?.dependencies.includes(d)}<span class="new">not applied</span>{/if}
            <button class="icon" title="Remove" aria-label="Remove {d}" onclick={() => (drafts[k.kind] = drafts[k.kind].filter((x) => x !== d))}><Icon name="close" size={14} /></button>
          </li>
        {/each}
      </ul>
      <form class="row" onsubmit={(e) => (e.preventDefault(), add(k.kind))}>
        <input class="mono" bind:value={adding[k.kind]} placeholder={k.placeholder} spellcheck="false" aria-label="Add a package" />
        <button class="btn" type="submit" disabled={!adding[k.kind].trim()}><Icon name="add" size={14} />Add</button>
        <button class="btn primary" type="button" disabled={!dirty(k.kind) || s?.status === "building"} onclick={() => apply(k.kind)}>Apply</button>
      </form>

      {#if s}
        <p class="state" class:bad={s.status === "failed"}>
          {#if s.status === "building"}
            <Icon name="loading" size={14} spin />Locking and installing…
          {:else if s.status === "failed"}
            <Icon name="error" size={14} />It didn't build{s.applied ? ": what was in force stays" : ""}.
            <button class="link" onclick={() => (openLog[k.kind] = !openLog[k.kind])}>{openLog[k.kind] ? "Hide" : "Show"} why</button>
          {:else if s.applied}
            <Icon name="pass" size={14} />In force: {s.applied.dependencies.length} package{s.applied.dependencies.length === 1 ? "" : "s"}, applied {ago(s.applied.at)}
          {:else}
            <Icon name="info" size={14} />None{k.kind === "python" ? (scope === "workspace" ? ": the image's own" : ": the workspace's") : ""}.
          {/if}
        </p>
        {#if s.status === "failed" && openLog[k.kind] && s.log}<pre class="log" transition:slide={{ duration: 140 }}>{s.log}</pre>{/if}
        {#if s.changed && s.status !== "building"}
          <p class="changed">
            <Icon name="warning" size={14} />
            <span>The folder's files changed since they were applied (edited, or pulled): they aren't in force.</span>
            <button class="link" onclick={() => apply(k.kind, s.dependencies)}>Apply the folder's</button>
          </p>
        {/if}
      {/if}
    </Setting>
  {/each}
</section>

<style>
  .deps {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin: 0 0 0.5rem;
    padding: 0;
    list-style: none;
    width: min(100%, 40rem);
  }
  .deps li {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    max-width: 100%;
    padding: 0 0.125rem 0 0.5rem;
    background: var(--wb-list-hover);
    border-radius: 4px;
  }
  .deps code {
    font-size: 0.78rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .new {
    font-size: 0.6875rem;
    color: var(--wb-accent);
  }
  .deps .icon {
    width: 1.375rem;
    height: 1.375rem;
    color: var(--wb-fg-muted);
  }
  .state,
  .changed {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin: 0.5rem 0 0;
    font-size: 0.78rem;
    color: var(--wb-fg-muted);
  }
  .state.bad {
    color: var(--critical);
  }
  .changed {
    color: var(--warning);
  }
  .changed span {
    color: var(--wb-fg);
  }
  .link {
    padding: 0;
    font-size: 0.78rem;
    color: var(--wb-accent);
  }
  .log {
    max-height: 14rem;
    margin: 0.375rem 0 0;
    padding: 0.5rem 0.625rem;
    overflow: auto;
    font: 0.72rem/1.45 var(--mono);
    white-space: pre-wrap;
    color: var(--wb-fg);
    background: var(--wb-bar);
    border: 1px solid var(--wb-border);
    border-radius: 4px;
    width: min(100%, 44rem);
  }
</style>
