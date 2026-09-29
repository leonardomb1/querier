<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { fly } from "svelte/transition";
  import { splitId, type Notebook } from "../lib/api";
  import { ago } from "../lib/format";
  import { nbHref, wsHref } from "../lib/href";
  import { NotebookCtl } from "../lib/notebook.svelte";
  import { TemplateCtl } from "../lib/template.svelte";
  import { Workbench } from "../lib/workbench.svelte";
  import Icon from "./Icon.svelte";
  import Palette from "./Palette.svelte";
  import TitleBar from "./wb/TitleBar.svelte";
  import ReportEditor from "./wb/ReportEditor.svelte";

  // A published report, as its viewers get it: the report alone (no code, no
  // explorer, no panels), run in their own report kernel on the server with
  // their connections or its owner's, bound PARAMs set for them. Those who may
  // also edit the notebook get a way into it.
  let { name, book }: { name: string; book: Notebook } = $props();

  // svelte-ignore state_referenced_locally
  const ctl = new NotebookCtl(name, book, true);
  const tpl = new TemplateCtl(ctl);
  // svelte-ignore state_referenced_locally
  const wb = new Workbench(name);
  $effect(() => tpl.sync(ctl.book?.template));
  onDestroy(() => ctl.close());
  onMount(() => {
    document.documentElement.classList.add("workbench");
    return () => document.documentElement.classList.remove("workbench");
  });

  const [workspace] = $derived(splitId(name));
  const pub = $derived(ctl.book?.published);
  const actions = $derived(wb.actions.report ?? []);
  const canEdit = $derived(!!ctl.book?.permissions?.includes("notebook.edit"));
  const who = $derived(pub?.runAs === "owner" ? `as ${pub.owner}` : "as you, with your connections");
</script>

<div class="page-report">
  <TitleBar
    crumbs={[{ label: workspace, href: wsHref(workspace), title: `The workspace ${workspace}` }, { label: ctl.book?.title ?? name, title: name }, { label: "Report" }]}
    center={ctl.book?.title ?? name}
    oncenter={() => (ctl.palette = true)}
  >
    {#each actions as a (a.title)}
      <button class="icon" class:on={a.on} title={a.title} aria-label={a.title} disabled={a.disabled} onclick={a.run}><Icon name={a.icon} size={16} /></button>
    {/each}
  </TitleBar>

  <main>
    {#if ctl.notice}
      <p class="notice" role="status" transition:fly={{ y: -4, duration: 150, easing: cubicOut }}>{ctl.notice}</p>
    {/if}
    {#if ctl.error}<p class="err" role="alert"><Icon name="error" size={14} />{ctl.error}</p>{/if}
    <ReportEditor {ctl} {wb} {tpl} focused />
  </main>

  <footer class="status">
    {#if pub}
      <span title="Published {new Date(pub.at).toLocaleString()}"><Icon name="cloud" size={13} />Published by {pub.by} {ago(pub.at)}</span>
      <span title={pub.runAs === "owner" ? "It runs with its owner's connections: you never see their credentials" : "It runs with the connections you may use"}><Icon name="key" size={13} />Runs {who}</span>
      {#if book.bound?.length}<span title="Set by the server from your directory attributes"><Icon name="lock" size={13} />{book.bound.join(", ")} set for you</span>{/if}
    {/if}
    <span class="grow"></span>
    {#if canEdit}<a href={nbHref(name)} title="Open the notebook (the live version, not what is published)"><Icon name="notebook" size={13} />Open the notebook</a>{/if}
  </footer>
</div>

{#if ctl.palette}<Palette onclose={() => (ctl.palette = false)} placeholder="Open a notebook or a workspace…" />{/if}

<style>
  :global(html.workbench),
  :global(html.workbench body) {
    height: 100%;
    overflow: hidden;
  }
  .page-report {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    height: 100vh;
    height: 100dvh;
    color: var(--wb-fg);
    background: var(--wb-editor);
  }
  main {
    min-height: 0;
    overflow: auto;
  }
  .notice,
  .err {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    max-width: 72rem;
    margin: 0.75rem auto 0;
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
  }
  .notice {
    color: var(--wb-fg);
    border-left: 2px solid var(--wb-accent);
    background: color-mix(in srgb, var(--wb-accent) 6%, transparent);
  }
  .err {
    color: var(--critical);
  }
  .status {
    display: flex;
    align-items: center;
    height: 1.375rem;
    padding: 0 0.5rem;
    font-size: 0.75rem;
    background: var(--wb-bar);
    border-top: 1px solid var(--wb-border);
    user-select: none;
  }
  .status span,
  .status a {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    height: 100%;
    padding: 0 0.4375rem;
    color: var(--wb-fg);
    text-decoration: none;
    white-space: nowrap;
  }
  .status a:hover {
    background: var(--wb-list-hover);
  }
  .status .grow {
    flex: 1;
  }
</style>
