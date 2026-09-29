<script lang="ts">
  import { tick } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { fade, scale } from "svelte/transition";
  import { dialogs } from "../../lib/dialog.svelte";

  // The one place lib/dialog.svelte.ts's dialogs show: VS Code's modal dialog,
  // an icon by its kind, the question, what it means, and its buttons on the
  // right (the primary one last, red when it destroys something). Enter
  // answers yes, Escape no; focus stays inside until it is answered.
  const d = $derived(dialogs.queue[0]);

  let text = $state("");
  let touched = $state(false);
  let box = $state<HTMLDivElement>();
  let input = $state<HTMLInputElement>();
  let okButton = $state<HTMLButtonElement>();

  const problem = $derived.by(() => {
    if (!d || d.mode !== "text") return null;
    if (d.mustMatch != null && text !== d.mustMatch) return `Type ${d.mustMatch} to go on.`;
    return d.validate?.(text) ?? null;
  });

  // each new dialog: its value, and focus where it is answered; after the last,
  // focus goes back to what had it (unless the answer moved it on)
  let shown: typeof d | null = null;
  let back: HTMLElement | null = null;
  $effect(() => {
    const now = d;
    if (now === shown) return;
    if (!shown && now) back = document.activeElement as HTMLElement | null;
    shown = now;
    if (!now) {
      const el = back;
      back = null;
      queueMicrotask(() => (document.activeElement === document.body || !document.activeElement) && el?.focus?.());
      return;
    }
    text = now.value ?? "";
    touched = false;
    tick().then(() => (now.mode === "text" ? (input?.focus(), input?.select()) : okButton?.focus()));
  });

  function ok() {
    if (!d) return;
    if (d.mode === "text") {
      touched = true;
      if (problem) return;
      dialogs.answer(text);
    } else dialogs.answer(true);
  }
  function cancel() {
    if (!d) return;
    dialogs.answer(d.mode === "text" ? null : d.mode === "ask" ? false : true);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), cancel());
    else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) (e.preventDefault(), e.stopPropagation(), ok());
    else if (e.key === "Tab") {
      // keep focus in the dialog
      const f = [...(box?.querySelectorAll<HTMLElement>("input, button:not(:disabled)") ?? [])];
      const i = f.indexOf(document.activeElement as HTMLElement);
      const next = f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length];
      if (next) (e.preventDefault(), next.focus());
    }
    e.stopPropagation();
  }

  const ICON = { info: "info", warning: "warning", error: "error" } as const;
</script>

{#if d}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" transition:fade={{ duration: 120 }} onpointerdown={(e) => e.target === e.currentTarget && box?.focus()}>
    <div
      bind:this={box}
      class="dialog {d.kind}"
      role={d.mode === "notify" ? "alertdialog" : "dialog"}
      aria-modal="true"
      aria-labelledby="dlg-title"
      aria-describedby={d.detail ? "dlg-detail" : undefined}
      tabindex="-1"
      {onkeydown}
      transition:scale={{ start: 0.96, duration: 150, easing: cubicOut, opacity: 0 }}
    >
      <div class="body">
        <span class="icon codicon codicon-{ICON[d.kind]}" aria-hidden="true"></span>
        <div class="text">
          <h2 id="dlg-title">{d.title}</h2>
          {#if d.detail}<p id="dlg-detail" class="detail">{d.detail}</p>{/if}
          {#if d.mode === "text"}
            <input
              bind:this={input}
              bind:value={text}
              class:bad={touched && !!problem}
              placeholder={d.placeholder ?? d.mustMatch ?? ""}
              spellcheck="false"
              autocomplete="off"
              aria-invalid={touched && !!problem}
              oninput={() => (touched = true)}
            />
            {#if touched && problem}<p class="problem">{problem}</p>{/if}
          {/if}
        </div>
      </div>
      <footer>
        {#if d.mode !== "notify"}<button class="btn secondary" onclick={cancel}>{d.cancel}</button>{/if}
        <button bind:this={okButton} class="btn primary" class:danger={d.danger} disabled={d.mode === "text" && touched && !!problem} onclick={ok}>{d.ok}</button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 2000;
    display: grid;
    place-items: start center;
    padding: 18vh 1rem 0;
    background: color-mix(in srgb, #000 22%, transparent);
  }
  .dialog {
    width: min(28rem, 100%);
    color: var(--wb-fg);
    background: var(--wb-editor);
    border: 1px solid var(--wb-input-border);
    border-radius: 8px;
    box-shadow:
      0 16px 40px rgba(0, 0, 0, 0.32),
      0 2px 6px rgba(0, 0, 0, 0.16);
    outline: none;
    font-size: 0.8125rem;
  }
  .body {
    display: flex;
    gap: 0.875rem;
    padding: 1.125rem 1.25rem 0.75rem;
  }
  .icon {
    flex: none;
    font-size: 1.75rem !important;
    color: var(--wb-accent);
  }
  .warning .icon {
    color: var(--warning);
  }
  .error .icon {
    color: var(--critical);
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  h2 {
    margin: 0.125rem 0 0;
    font-size: 0.875rem;
    font-weight: 600;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .detail {
    margin: 0.375rem 0 0;
    line-height: 1.5;
    color: var(--wb-fg-muted);
    white-space: pre-line;
    overflow-wrap: anywhere;
  }
  input {
    display: block;
    width: 100%;
    box-sizing: border-box;
    height: 1.875rem;
    margin-top: 0.75rem;
    padding: 0 0.5rem;
    font: 0.8125rem var(--mono);
    color: var(--wb-fg);
    background: var(--wb-input);
    border: 1px solid var(--wb-input-border);
    border-radius: 4px;
  }
  input:focus {
    outline: none;
    border-color: var(--wb-accent);
  }
  input.bad {
    border-color: var(--critical);
  }
  .problem {
    margin: 0.3125rem 0 0;
    font-size: 0.75rem;
    color: var(--critical);
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.625rem 1.25rem 1rem;
  }
  .btn {
    min-width: 5rem;
    height: 1.75rem;
    padding: 0 0.875rem;
    font-size: 0.8125rem;
    border-radius: 4px;
  }
  .secondary {
    color: var(--wb-fg);
    background: transparent;
    border: 1px solid var(--wb-input-border);
  }
  .secondary:hover {
    background: var(--wb-list-hover);
  }
  .primary {
    color: #fff;
    background: var(--wb-accent);
    border: 1px solid transparent;
  }
  .primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--wb-accent) 88%, #000);
  }
  .primary.danger {
    background: var(--critical);
  }
  .primary.danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--critical) 88%, #000);
  }
  .primary:disabled {
    opacity: 0.5;
  }
  .btn:focus-visible {
    outline: 1px solid var(--wb-accent);
    outline-offset: 2px;
  }
</style>
