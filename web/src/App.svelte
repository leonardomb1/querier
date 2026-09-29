<script lang="ts">
  import ErrorPage from "./components/ErrorPage.svelte";
  import Login from "./components/auth/Login.svelte";
  import { session } from "./lib/session.svelte";
  import Workbench from "./components/wb/Workbench.svelte";
  import Home from "./components/home/Home.svelte";
  import ReportPage from "./components/ReportPage.svelte";
  import Spinner from "./components/Spinner.svelte";
  import Dialogs from "./components/ui/Dialogs.svelte";
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
  // a new key per page: the page remounts, and so does its error boundary. Home is
  // one page whichever workspace is open, so its side bar stays as it is.
  const key = $derived(
    route?.page === "notebook" || route?.page === "report" ? `nb:${route.name}` : route?.page === "view" ? `view:${route.name}` : route?.page,
  );
</script>

<svelte:window {onkeydown} />

{#if route}
  <div class="page">
    {#key key}
      <svelte:boundary onerror={(e) => console.error(e)}>
        {#if route.page === "login"}
          <Login providers={route.providers} next={route.next} error={route.error} insecure={route.insecure} />
        {:else if route.page === "home"}
          <Home index={route.index} ws={route.ws} tab={route.tab} section={route.section} query={route.query} />
        {:else if route.page === "notebook"}
          <Workbench name={route.name} initial={route.book} />
        {:else if route.page === "view"}
          <ReportPage name={route.name} book={route.book} />
        {:else if route.page === "report"}
          <Workbench name={route.name} initial={route.book} open="report" />
        {:else}
          <ErrorPage
            status={route.status}
            title={route.title}
            message={route.message}
            onretry={route.retry ? router.retry : undefined}
            onsignout={route.status === 403 && session.me ? () => session.signOut() : undefined}
          />
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

<!-- a slow page load: a thin line along the top, as VS Code's progress bar; the
     page you are on stays as it is. The first load has a spinner. -->
{#if !route && router.loading}
  <div class="loading boot"><Spinner /></div>
{:else if router.slow}
  <div class="progress" role="progressbar" aria-label="Loading"></div>
{/if}

<!-- alerts, confirmations and questions (lib/dialog.svelte.ts), over any page -->
<Dialogs />

<style>
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
  .progress {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    z-index: 60;
    overflow: hidden;
    pointer-events: none;
  }
  .progress::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    width: 30%;
    background: var(--wb-accent);
    animation: progress 1s linear infinite;
  }
  @keyframes progress {
    from {
      left: -30%;
    }
    to {
      left: 100%;
    }
  }
  @keyframes appear {
    from {
      opacity: 0;
    }
  }
</style>
