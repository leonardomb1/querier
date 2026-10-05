<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { Notebook } from "../lib/api";
  import { ago } from "../lib/format";
  import { NotebookCtl } from "../lib/notebook.svelte";
  import { session } from "../lib/session.svelte";
  import { TemplateCtl } from "../lib/template.svelte";
  import { Workbench } from "../lib/workbench.svelte";
  import Icon from "./Icon.svelte";
  import ReportEditor from "./wb/ReportEditor.svelte";

  // A public link's report (/p/<token>): nobody signs in. What it shows is the
  // report's last run as its owner, fetched from the server (which runs it again
  // when it is older than the link allows); no kernel of the viewer's own, no code,
  // and no controls: the PARAMs keep their defaults. The server checks the link's
  // networks, expiry and passcode on every request.
  let { token }: { token: string } = $props();

  let phase = $state<"loading" | "passcode" | "error" | "ready">("loading");
  let error = $state("");
  let passcode = $state("");
  let wrong = $state("");
  let busy = $state(false);
  let ctl = $state<NotebookCtl | null>(null);
  let tpl = $state<TemplateCtl | null>(null);
  let wb = $state<Workbench | null>(null);
  let runAt = $state(0);
  let preparing = $state(false);
  let refresh = 15;
  let timer: ReturnType<typeof setTimeout>;
  let now = $state(Date.now());
  // how old the data is, told again as time passes
  const age = $derived((void now, runAt ? ago(runAt) : ""));

  // plain fetches: the app's API helper would take a 401 for "sign in"; here it means "the passcode"
  const url = (p = "") => `/api/public/${encodeURIComponent(token)}${p}`;

  async function load() {
    clearTimeout(timer);
    const r = await fetch(url(), { cache: "no-store" }).catch(() => null);
    if (!r) return fail("The server can't be reached.");
    if (r.status === 401) return void (phase = "passcode");
    if (!r.ok) return fail(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "This report can't be shown.");
    const book = (await r.json()) as Notebook & { published: { public?: { refresh: number } }; embedSites?: string[] };
    session.embedSites = book.embedSites ?? [];
    refresh = book.published?.public?.refresh ?? 15;
    ctl?.close();
    ctl = new NotebookCtl(book.name, book, true, true);
    tpl = new TemplateCtl(ctl);
    tpl.sync(book.template);
    wb = new Workbench(book.name);
    document.title = book.title || "Report";
    phase = "ready";
    await pull();
  }

  /** Its last run; while the server runs it for the first time, again shortly. */
  async function pull() {
    clearTimeout(timer);
    const r = await fetch(url("/outputs"), { cache: "no-store" }).catch(() => null);
    if (!r) return schedule(30_000);
    if (r.status === 401) return void (phase = "passcode");
    if (r.status === 202) {
      preparing = true;
      return schedule(2000);
    }
    if (!r.ok) return fail(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "This report can't be shown.");
    preparing = false;
    ctl!.conn.feed(await r.arrayBuffer());
    runAt = Number(r.headers.get("x-querier-run-at")) || Date.now();
    // a newer run once this one is past the link's age (the server runs it then); sooner while one is on its way
    const refreshing = r.headers.get("x-querier-refreshing") === "true";
    schedule(refreshing ? 5000 : Math.max(30_000, runAt + refresh * 60_000 - Date.now() + 2000));
  }
  function schedule(ms: number) {
    clearTimeout(timer);
    timer = setTimeout(() => document.visibilityState === "visible" ? pull() : schedule(ms), ms);
  }
  function fail(message: string) {
    error = message;
    phase = "error";
  }

  async function unlock(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    wrong = "";
    const r = await fetch(url("/unlock"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode }) }).catch(() => null);
    busy = false;
    if (!r) return void (wrong = "The server can't be reached.");
    if (!r.ok) return void (wrong = ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "That isn't the passcode.");
    passcode = "";
    phase = "loading";
    load();
  }

  onMount(() => {
    document.documentElement.classList.add("workbench");
    load();
    const tick = setInterval(() => (now = Date.now()), 30_000);
    return () => {
      clearInterval(tick);
      document.documentElement.classList.remove("workbench");
    };
  });
  onDestroy(() => {
    clearTimeout(timer);
    ctl?.close();
  });
</script>

<div class="public">
  {#if phase === "ready" && ctl && wb && tpl}
    <header>
      <span class="title">{ctl.book?.title}</span>
      <span class="grow"></span>
      {#if preparing}
        <span class="note"><Icon name="loading" size={13} spin />Preparing the first run…</span>
      {:else if runAt}
        <span class="note" title={new Date(runAt).toLocaleString()}>Data from {age}</span>
      {/if}
    </header>
    <main>
      <ReportEditor {ctl} {wb} {tpl} focused />
    </main>
  {:else if phase === "passcode"}
    <form class="gate" onsubmit={unlock}>
      <Icon name="lock" size={20} />
      <h1>This report needs its passcode</h1>
      <!-- svelte-ignore a11y_autofocus -->
      <input type="password" bind:value={passcode} placeholder="Passcode" autocomplete="off" autofocus aria-label="Passcode" />
      {#if wrong}<p class="bad" role="alert">{wrong}</p>{/if}
      <button class="primary" disabled={busy || !passcode}>Open</button>
    </form>
  {:else if phase === "error"}
    <div class="gate"><Icon name="circle-slash" size={20} /><p>{error}</p></div>
  {:else}
    <div class="gate"><Icon name="loading" size={20} spin /></div>
  {/if}
</div>

<style>
  .public {
    display: flex;
    flex-direction: column;
    height: 100vh;
    height: 100dvh;
    min-height: 0;
    background: var(--wb-editor);
    color: var(--wb-fg);
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    height: 2.5rem;
    padding: 0 1rem;
    flex: none;
    border-bottom: 1px solid var(--wb-border);
    background: var(--wb-bar);
  }
  .title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .grow {
    flex: 1;
  }
  .note {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    color: var(--wb-fg-muted);
  }
  main {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .gate {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    width: min(22rem, calc(100% - 2rem));
    margin: 18vh auto 0;
    text-align: center;
    color: var(--wb-fg-muted);
  }
  .gate h1 {
    margin: 0;
    font-size: 1rem;
    color: var(--wb-fg);
  }
  .gate input {
    box-sizing: border-box;
    width: 100%;
    height: 2rem;
    padding: 0 0.625rem;
    color: var(--wb-fg);
    background: var(--wb-input);
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
  }
  .gate input:focus {
    outline: none;
    border-color: var(--wb-accent);
  }
  .gate .primary {
    width: 100%;
    height: 2rem;
  }
  .bad {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--critical);
  }
</style>
