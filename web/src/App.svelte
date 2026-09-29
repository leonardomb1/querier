<script lang="ts">
  import ErrorPage from "./components/ErrorPage.svelte";
  import Workbench from "./components/wb/Workbench.svelte";
  import NotebookList from "./components/NotebookList.svelte";
  import Spinner from "./components/Spinner.svelte";
  import { Router } from "./lib/router.svelte";
  import { zoom } from "./lib/zoom.svelte";

  const router = new Router();

  // Ctrl+= / Ctrl+- / Ctrl+0 zoom the interface, as in VS Code
  function onkeydown(e: KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const act = { "=": zoom.in, "+": zoom.in, "-": zoom.out, "0": zoom.reset }[e.key];
    if (!act) return;
    e.preventDefault();
    act();
  }
  const route = $derived(router.route);
  // a new key per page: the page remounts, and so does its error boundary
  const key = $derived(
    route?.page === "notebook" || route?.page === "report" ? `nb:${route.name}` : route?.page,
  );
</script>

<svelte:window {onkeydown} />

{#if route}
  <div class="page" class:dim={router.slow}>
    {#key key}
      <svelte:boundary onerror={(e) => console.error(e)}>
        {#if route.page === "list"}
          <NotebookList index={route.index} />
        {:else if route.page === "notebook"}
          <Workbench name={route.name} initial={route.book} />
        {:else if route.page === "report"}
          <Workbench name={route.name} initial={route.book} open="report" />
        {:else}
          <ErrorPage status={route.status} title={route.title} message={route.message} onretry={route.retry ? router.retry : undefined} />
        {/if}

        {#snippet failed(error, reset)}
          <ErrorPage
            title="This page broke"
            message={error instanceof Error ? error.message : String(error)}
            detail={error instanceof Error ? error.stack : undefined}
            onretry={reset}
          />
        {/snippet}
      </svelte:boundary>
    {/key}
  </div>
{/if}

{#if router.slow || (!route && router.loading)}
  <div class="loading" class:boot={!route}><Spinner /></div>
{/if}

<style>
  .page {
    transition: opacity 0.2s var(--ease);
  }
  .page.dim {
    opacity: 0.5;
    pointer-events: none;
  }
  .loading {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    pointer-events: none;
    z-index: 40;
    animation: appear 0.2s var(--ease) both;
  }
  .loading.boot {
    animation-delay: 0.15s; /* first paint: only show it if loading is slow */
  }
  @keyframes appear {
    from {
      opacity: 0;
    }
  }
</style>
