<script lang="ts">
  import type { CedarVocabulary } from "../../lib/cedarcomplete";
  import Icon from "../Icon.svelte";
  import OverlayPanel from "../wb/OverlayPanel.svelte";
  import CodeInput, { type Problem } from "./CodeInput.svelte";

  // A value that is code, edited in a modal editor over the page, as VS Code
  // opens settings.json from its Settings: the file's name and where it lives
  // on the title bar, its breadcrumbs, then a whole editor (line numbers, the
  // minimap, IntelliSense, problems underlined as you type). Its problems and
  // the keys are along the bottom, with Apply; Escape or a click outside
  // leaves it as it was.
  let {
    file,
    detail,
    crumbs,
    value,
    lang = "cedar",
    placeholder = "",
    vocabulary = null,
    check,
    help,
    applyLabel = "Apply",
    allowEmpty = false,
    dirtyOnly = false,
    onapply,
    onclose,
  }: {
    /** the name on the title bar and the last crumb: "condition.cedar" */
    file: string;
    /** muted after it: where the value belongs */
    detail?: string;
    crumbs: string[];
    value: string;
    lang?: "cedar";
    placeholder?: string;
    vocabulary?: CedarVocabulary | null;
    /** the text's problems, asked as it is typed */
    check?: (text: string) => Promise<Problem[]>;
    /** a line on what to write, shown while nothing is wrong */
    help?: string;
    applyLabel?: string;
    /** nothing written may be applied (an empty file) */
    allowEmpty?: boolean;
    /** Apply only once something changed (saving a file) */
    dirtyOnly?: boolean;
    onapply: (value: string) => void | Promise<void>;
    onclose: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let draft = $state(value);
  let problems = $state<Problem[]>([]);
  let checking = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const text = draft;
    clearTimeout(timer);
    if (!check || !text.trim()) return void ((problems = []), (checking = false));
    checking = true;
    timer = setTimeout(async () => {
      try {
        const got = await check(text);
        // a later keystroke's answer wins
        if (draft === text) problems = got;
      } catch {}
      if (draft === text) checking = false;
    }, 300);
  });

  // warnings don't stop it; errors do (an empty file may be applied when `allowEmpty`)
  const errors = $derived(problems.filter((p) => !p.warning));
  /** what the bottom bar tells: the first error, else the first warning */
  const first = $derived(errors[0] ?? problems[0]);
  const canApply = $derived((allowEmpty || !!draft.trim()) && !errors.length && !checking && (dirtyOnly ? draft !== value : true));
  let saveError = $state("");
  async function apply() {
    if (!canApply) return;
    saveError = "";
    try {
      await onapply(allowEmpty ? draft : draft.trim());
    } catch (e: any) {
      saveError = e.message;
    }
  }

  const where = (p: Problem) => {
    if (p.start == null) return "";
    const before = draft.slice(0, p.start);
    return `${before.split("\n").length}:${p.start - before.lastIndexOf("\n")}`;
  };
</script>

<OverlayPanel icon="file-code" title={file} {detail} {onclose}>
  <div class="editor-panel">
    <nav class="crumbs" aria-label="Where">
      {#each crumbs as c, i (i)}
        <span>{c}</span><Icon name="chevron-right" size={14} />
      {/each}
      <span class="file"><Icon name="shield" size={14} />{file}</span>
    </nav>
    <div class="code">
      <CodeInput
        value={draft}
        {lang}
        onchange={(v) => (draft = v)}
        onsubmit={apply}
        onescape={onclose}
        {placeholder}
        label={file}
        {problems}
        {vocabulary}
        fill
        autofocus
      />
    </div>
    <footer>
      <span class="state" class:bad={errors.length > 0 || !!saveError} class:warn={!errors.length && problems.length > 0}>
        {#if saveError}
          <Icon name="error" size={14} /><span class="msg">{saveError}</span>
        {:else if problems.length}
          <Icon name={errors.length ? "error" : "warning"} size={14} />
          <span class="msg">
            {#if where(first)}<code>{where(first)}</code>{/if}
            {first.message}{#if first.help}<span class="help"> · {first.help}</span>{/if}
          </span>
          {#if problems.length > 1}<span class="more">+{problems.length - 1}</span>{/if}
        {:else if checking}
          <Icon name="loading" size={14} spin /><span class="msg">Checking…</span>
        {:else if draft.trim()}
          <Icon name="check" size={14} /><span class="msg">No problems</span>
        {:else if help}
          <Icon name="info" size={14} /><span class="msg">{help}</span>
        {/if}
      </span>
      <span class="keys"><kbd>Ctrl</kbd>+<kbd>Space</kbd> suggest · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> apply</span>
      <button class="btn secondary" onclick={onclose}>Cancel</button>
      <button class="btn primary" disabled={!canApply} onclick={apply}>{applyLabel}</button>
    </footer>
  </div>
</OverlayPanel>

<style>
  .editor-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .crumbs {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    flex: none;
    height: 1.625rem;
    padding: 0 0.875rem;
    font-size: 0.8125rem;
    color: var(--wb-fg-muted);
    white-space: nowrap;
    overflow: hidden;
  }
  .crumbs :global(i) {
    opacity: 0.7;
  }
  .file {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    color: var(--wb-fg);
  }
  .file :global(i) {
    color: var(--wb-accent);
    opacity: 1;
  }
  .code {
    flex: 1;
    min-height: 0;
  }
  footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: none;
    min-height: 2.5rem;
    padding: 0.375rem 0.75rem;
    font-size: 0.75rem;
    border-top: 1px solid var(--wb-border);
    background: var(--wb-bar);
  }
  .state {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex: 1;
    min-width: 0;
    color: var(--wb-fg-muted);
  }
  .state.bad {
    color: var(--critical);
  }
  .state.warn {
    color: var(--warning);
  }
  .msg {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .msg code {
    margin-right: 0.375rem;
    font-size: 0.72rem;
    opacity: 0.8;
  }
  .help {
    color: var(--wb-fg-muted);
  }
  .more {
    flex: none;
    color: var(--wb-fg-muted);
  }
  .keys {
    flex: none;
    color: var(--wb-fg-dim);
  }
  .keys kbd {
    font-size: 0.6875rem;
  }
  .btn {
    flex: none;
    height: 1.625rem;
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
  .primary:disabled {
    opacity: 0.5;
  }
</style>
