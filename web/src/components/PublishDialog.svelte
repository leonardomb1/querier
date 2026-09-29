<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import { ask } from "../lib/dialog.svelte";
  import { ago } from "../lib/format";
  import { viewHref } from "../lib/href";
  import type { NotebookCtl } from "../lib/notebook.svelte";
  import { session } from "../lib/session.svelte";
  import Icon from "./Icon.svelte";
  import InfoTip from "./ui/InfoTip.svelte";
  import Select from "./ui/Select.svelte";
  import OverlayPanel from "./wb/OverlayPanel.svelte";

  // Publishing a notebook's report for its viewers (who have report.view): its
  // code as it is now, frozen; whose connections it runs with; which PARAMs the
  // server sets from each viewer's tags (their rows, not everyone's); and, run
  // as its owner with nothing bound, how often the server runs it for everyone.
  let { ctl, onclose }: { ctl: NotebookCtl; onclose: () => void } = $props();

  const pub = $derived(ctl.book?.published);
  const params = $derived(ctl.book?.params ?? []);
  // svelte-ignore state_referenced_locally
  let runAs = $state<"viewer" | "owner">(ctl.book?.published?.runAs ?? "viewer");
  // svelte-ignore state_referenced_locally
  let bindings = $state<Record<string, string>>({ ...(ctl.book?.published?.bindings ?? {}) });
  // svelte-ignore state_referenced_locally
  let every = $state<number | "">(ctl.book?.published?.schedule?.every ?? "");
  let tags = $state<string[]>([]);
  let error = $state("");
  let busy = $state(false);

  onMount(() => api.access.vocabulary().then((v) => (tags = Object.keys(v.tags)), () => {}));

  const me = $derived(session.me?.name ?? session.me?.username ?? "me");
  // every PARAM chosen as bound, its tag written or not: one left blank must not publish unbound
  const bound = $derived(Object.entries(bindings));
  const blank = $derived(bound.some(([, t]) => !t.trim()));
  const schedulable = $derived(runAs === "owner" && !bound.length);
  $effect(() => {
    if (!schedulable) every = "";
  });

  const RUN_AS = $derived([
    { value: "viewer" as const, label: "Each viewer", description: "Every viewer runs it with their own connections (single sign-on): they see what their credentials reach." },
    {
      value: "owner" as const,
      label: `Me (${me})`,
      description: "It runs with your connections, for everyone who views it. They never see your credentials, and it runs the code as published, not later edits.",
    },
  ]);
  const SCHEDULES = [
    { value: "" as const, label: "Off: each viewer runs it when they open it" },
    { value: 15, label: "Every 15 minutes" },
    { value: 60, label: "Every hour" },
    { value: 360, label: "Every 6 hours" },
    { value: 1440, label: "Every day" },
  ];

  async function publish() {
    busy = true;
    error = "";
    try {
      await api.report.publish(ctl.name, { runAs, bindings: Object.fromEntries(bound.map(([p, t]) => [p, t.trim()])), schedule: every === "" ? null : { every } });
      await ctl.refresh();
      ctl.say("Published: its viewers get it as it is now.", { href: viewHref(ctl.name), label: "Open it" });
      onclose();
    } catch (e: any) {
      error = e.message;
    }
    busy = false;
  }
  async function unpublish() {
    if (!(await ask("Stop publishing this report?", { detail: "Its viewers can't open it any more, until it is published again.", ok: "Unpublish", danger: true }))) return;
    try {
      await api.report.unpublish(ctl.name);
      await ctl.refresh();
      onclose();
    } catch (e: any) {
      error = e.message;
    }
  }
</script>

<OverlayPanel icon="cloud-upload" title={pub ? "Published report" : "Publish the report"} detail={ctl.book?.title} compact {onclose}>
  <div class="body">
    {#if pub}
      <p class="state">
        <Icon name="pass" size={14} />
        <span>Published by {pub.by} {ago(pub.at)}, runs as {pub.runAs === "owner" ? pub.owner : "each viewer"}{pub.schedule ? `, every ${pub.schedule.every >= 60 ? `${pub.schedule.every / 60} h` : `${pub.schedule.every} min`}` : ""}.</span>
        <a href={viewHref(ctl.name)}>Open it</a>
      </p>
      {#if pub.changed}
        <p class="changed"><Icon name="warning" size={14} />The notebook changed since: its viewers still get the published version until you publish again.</p>
      {/if}
    {:else}
      <p class="lede">
        Everyone with a view of the report (a workspace role, a share, a policy) opens it as published: its code as it is now, frozen, and its layout.
        <InfoTip text="Later edits reach them only when it is published again, so a report that runs with your credentials only runs code you published." />
      </p>
    {/if}

    <div class="field">
      <span class="l">Runs as</span>
      <Select bind:value={runAs} options={RUN_AS} label="Runs as" />
      <span class="hint">{RUN_AS.find((o) => o.value === runAs)?.description}</span>
    </div>

    {#if params.length}
      <div class="field">
        <span class="l">
          PARAMs
          <InfoTip text="A PARAM bound to a tag is set by the server, on every run, from the viewer's directory attribute: e.g. region from their region, so each sees their own rows. A viewer without the tag can't run it. Several values come joined by commas." />
        </span>
        <div class="params">
          {#each params as p (p.name)}
            <code>${p.name}</code>
            <Select
              value={bindings[p.name] != null ? "bound" : "viewer"}
              options={[
                { value: "viewer", label: "Set by the viewer" },
                { value: "bound", label: "Bound to their tag" },
              ]}
              label="How ${p.name} is set"
              onchange={(v) => (v === "bound" ? (bindings[p.name] = bindings[p.name] ?? "") : delete bindings[p.name])}
            />
            {#if bindings[p.name] != null}
              <input class="tag" list="publish-tags" bind:value={bindings[p.name]} placeholder="tag: region, department…" spellcheck="false" aria-label="Tag for ${p.name}" />
            {:else}
              <span></span>
            {/if}
          {/each}
        </div>
        <datalist id="publish-tags">{#each tags as t (t)}<option value={t}></option>{/each}</datalist>
      </div>
    {/if}

    <div class="field">
      <span class="l">Schedule</span>
      <Select bind:value={every} options={SCHEDULES} label="Schedule" disabled={!schedulable} />
      <span class="hint">
        {#if schedulable}
          The server runs it as you, and viewers open it already run; changing a control runs it for them.
        {:else if runAs !== "owner"}
          Only a report run as you can be scheduled: run as each viewer, there's no single result to keep.
        {:else}
          A report with bound PARAMs gives each viewer their own rows: it can't be scheduled.
        {/if}
      </span>
    </div>

    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <footer>
      {#if pub}<button class="btn danger-text" onclick={unpublish}>Unpublish</button>{/if}
      <span class="grow"></span>
      <button class="btn" onclick={onclose}>Cancel</button>
      <button class="primary" disabled={busy || blank} title={blank ? "Name the tag each bound PARAM takes" : undefined} onclick={publish}>{pub ? "Publish again" : "Publish"}</button>
    </footer>
  </div>
</OverlayPanel>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    padding: 1rem 1.125rem;
    font-size: 0.8125rem;
  }
  .lede {
    margin: 0;
    color: var(--wb-fg-muted);
    line-height: 1.5;
  }
  .state,
  .changed {
    display: flex;
    align-items: center;
    gap: 0.4375rem;
    margin: 0;
  }
  .state :global(i) {
    color: var(--git-added);
    flex: none;
  }
  .state span {
    flex: 1;
  }
  .state a {
    color: var(--wb-accent);
  }
  .changed {
    padding: 0.375rem 0.625rem;
    color: var(--wb-fg);
    border-left: 2px solid var(--warning);
    background: color-mix(in srgb, var(--warning) 7%, transparent);
  }
  .changed :global(i) {
    color: var(--warning);
    flex: none;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3125rem;
  }
  .l {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-weight: 600;
  }
  .field > :global(.select) {
    align-self: flex-start;
    min-width: 18rem;
  }
  .hint {
    font-size: 0.75rem;
    color: var(--wb-fg-dim);
    line-height: 1.45;
  }
  .params {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr);
    align-items: center;
    gap: 0.375rem 0.625rem;
  }
  .params code {
    font-size: 0.78rem;
  }
  .tag {
    box-sizing: border-box;
    height: 1.75rem;
    padding: 0 0.5rem;
    font: 0.8125rem var(--mono);
    color: var(--wb-fg);
    background: var(--wb-input);
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
  }
  .tag:focus {
    outline: none;
    border-color: var(--wb-accent);
  }
  .error {
    margin: 0;
    padding: 0.375rem 0.5rem;
    font-size: 0.78rem;
    color: var(--critical);
    border-left: 2px solid currentColor;
    background: color-mix(in srgb, currentColor 7%, transparent);
  }
  footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .grow {
    flex: 1;
  }
  .btn {
    height: 1.75rem;
    padding: 0 0.75rem;
    font-size: 0.8125rem;
    color: var(--wb-fg);
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
  }
  .btn:hover {
    background: var(--wb-list-hover);
  }
  .danger-text {
    color: var(--critical);
  }
  .primary {
    height: 1.75rem;
    padding: 0 0.875rem;
  }
</style>
