<script lang="ts">
  import { cubicOut } from "svelte/easing";
  import { fade, scale } from "svelte/transition";
  import { api, type SandboxSettings } from "../lib/api";
  import type { NotebookCtl } from "../lib/notebook.svelte";
  import Icon from "./Icon.svelte";

  // The notebook's microVM: its size, and the only places it may connect to.
  let { ctl, onclose }: { ctl: NotebookCtl; onclose: () => void } = $props();

  // svelte-ignore state_referenced_locally
  let s = $state<SandboxSettings>({ ...(ctl.book?.sandbox ?? {}), egress: [...(ctl.book?.sandbox?.egress ?? [])] });
  let draft = $state("");
  let error = $state("");
  let saved = $state(false);

  const sandboxed = $derived(ctl.conn.info.sandbox === "firecracker");
  const egress = $derived(s.egress ?? []);
  const suggestions = $derived([...ctl.sandboxRefs].filter(([t]) => !egress.includes(t)));

  async function save(next: SandboxSettings) {
    error = "";
    try {
      await api.settings(ctl.name, { sandbox: next });
      s = next;
      saved = true;
      await ctl.refresh();
    } catch (e: any) {
      error = e.message;
    }
  }

  function add(target: string) {
    const t = target.trim();
    if (!t || egress.includes(t)) return;
    save({ ...s, egress: [...egress, t] }).then(() => !error && (draft = ""));
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") (e.stopPropagation(), onclose());
  }

  const MEMORY: [number, string][] = [
    [512, "512 MB"],
    [1024, "1 GB"],
    [2048, "2 GB"],
    [4096, "4 GB"],
    [8192, "8 GB"],
  ];
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" transition:fade={{ duration: 140 }} onclick={onclose} {onkeydown}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="dialog" role="dialog" aria-label="Sandbox" tabindex="-1" transition:scale={{ start: 0.97, duration: 160, easing: cubicOut }} onclick={(e) => e.stopPropagation()}>
    <header>
      <h2>Sandbox</h2>
      <button class="icon" aria-label="Close" onclick={onclose}><Icon name="x" /></button>
    </header>
    <p class="lede">
      This notebook's kernel runs in its own microVM. It sees a read-only copy of the notebook's files, keeps nothing it
      writes, and has no network except the destinations below.
    </p>
    {#if !sandboxed}
      <p class="note">Running locally, as plain processes: these settings apply when Querier runs from its Docker image.</p>
    {/if}

    <section>
      <h3>Size</h3>
      <div class="row">
        <label>
          <span>vCPUs</span>
          <select value={s.vcpus ?? 2} onchange={(e) => save({ ...s, vcpus: Number(e.currentTarget.value) })}>
            {#each [1, 2, 4, 8] as n}<option value={n}>{n}</option>{/each}
          </select>
        </label>
        <label>
          <span>Memory</span>
          <select value={s.memory ?? 2048} onchange={(e) => save({ ...s, memory: Number(e.currentTarget.value) })}>
            {#each MEMORY as [mb, label]}<option value={mb}>{label}</option>{/each}
          </select>
        </label>
      </div>
    </section>

    <section>
      <h3>Network</h3>
      <p class="hint">
        {egress.length ? "TCP to these destinations only; everything else is refused. There is no DNS inside: names are resolved when the kernel starts." : "None: the kernel cannot connect anywhere. Add a destination to reach a database or an API."}
      </p>
      {#if egress.length}
        <ul>
          {#each egress as t (t)}
            <li>
              <code>{t}</code>
              <span class="why">{ctl.sandboxRefs.get(t) ?? ""}</span>
              <button class="icon" aria-label="Remove {t}" onclick={() => save({ ...s, egress: egress.filter((x) => x !== t) })}><Icon name="x" size={14} /></button>
            </li>
          {/each}
        </ul>
      {/if}
      <form
        class="add"
        onsubmit={(e) => {
          e.preventDefault();
          add(draft);
        }}
      >
        <input bind:value={draft} placeholder="host:port, e.g. 10.140.0.7:9030" spellcheck="false" />
        <button type="submit" disabled={!draft.trim()}>Allow</button>
      </form>
      {#if suggestions.length}
        <div class="suggest">
          <span>This notebook connects to</span>
          {#each suggestions as [t, why] (t)}
            <button title={why} onclick={() => add(t)}><Icon name="plus" size={12} />{t}</button>
          {/each}
        </div>
      {/if}
    </section>

    {#if error}<p class="error">{error}</p>{/if}
    {#if saved && sandboxed && ctl.conn.session === "ready"}
      <div class="restart">
        <span>The running kernel still has the previous sandbox.</span>
        <button onclick={() => (ctl.restart(), (saved = false))}>Restart kernel</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: var(--scrim);
    display: grid;
    place-items: start center;
    padding-top: 10vh;
  }
  .dialog {
    width: min(36rem, calc(100vw - 2rem));
    max-height: 82vh;
    overflow: auto;
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: 12px;
    box-shadow: var(--shadow-lg);
    padding: 1.25rem 1.5rem 1.5rem;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h2 {
    margin: 0;
    font-size: 1.0625rem;
    font-weight: 600;
  }
  .lede,
  .note,
  .hint {
    font-size: 0.8125rem;
    line-height: 1.55;
    color: var(--ink-2);
    margin: 0.375rem 0 0;
  }
  .note {
    color: var(--stale);
    margin-top: 0.75rem;
  }
  .hint {
    color: var(--muted);
    margin: 0 0 0.625rem;
  }
  section {
    margin-top: 1.25rem;
  }
  h3 {
    margin: 0 0 0.5rem;
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .row {
    display: flex;
    gap: 1rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.72rem;
    color: var(--muted);
  }
  select {
    height: 2rem;
    font-size: 0.8125rem;
    min-width: 7rem;
  }
  ul {
    list-style: none;
    margin: 0 0 0.625rem;
    padding: 0;
    border-top: 1px solid var(--hair);
  }
  li {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 2.25rem;
    border-bottom: 1px solid var(--hair);
  }
  li code {
    font-size: 0.8125rem;
  }
  .why {
    flex: 1;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .add {
    display: flex;
    gap: 0.5rem;
  }
  .add input {
    flex: 1;
    height: 2rem;
    font: 0.8125rem var(--mono);
    padding: 0 0.625rem;
  }
  .add button {
    font-size: 0.8125rem;
    padding: 0 0.875rem;
    border: 1px solid var(--hair);
    border-radius: 6px;
  }
  .suggest {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.75rem;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .suggest button {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font: 0.75rem var(--mono);
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--hair);
    border-radius: 5px;
    color: var(--ink-2);
  }
  .error {
    color: var(--critical);
    font-size: 0.8125rem;
  }
  .restart {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-top: 1.25rem;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--hair);
    border-radius: 8px;
    font-size: 0.8125rem;
    color: var(--stale);
  }
  .restart button {
    font-size: 0.8125rem;
    color: var(--ink);
  }
</style>
