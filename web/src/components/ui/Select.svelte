<script lang="ts" module>
  export interface SelectOption<T> {
    value: T;
    label: string;
    /** muted, after the label: "default", a size */
    hint?: string;
    /** what it means, shown under the list while it is the active one (as VS Code's settings) */
    description?: string;
    disabled?: boolean;
  }
</script>

<script lang="ts" generics="T extends string | number">
  import { tick } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { fly } from "svelte/transition";

  // A dropdown, in place of the browser's <select>: VS Code's own look (a flat
  // box, a chevron; a list with a check on the chosen one and the active one's
  // description under it), the same in light and dark and on every platform.
  // The list is put on <body>, so no dialog or scrolling panel cuts it off.
  // Keyboard as a native one: Enter, Space or the arrows open it; arrows, Home,
  // End and typing a letter move; Enter picks; Escape and Tab close.
  let {
    value = $bindable(),
    options,
    onchange,
    disabled = false,
    label,
    title,
    placeholder = "",
    class: klass = "",
    compact = false,
  }: {
    value: T;
    options: SelectOption<T>[];
    onchange?: (value: T) => void;
    disabled?: boolean;
    /** its accessible name, when no <label> names it */
    label?: string;
    title?: string;
    /** shown when `value` is none of the options */
    placeholder?: string;
    class?: string;
    /** smaller, for toolbars */
    compact?: boolean;
  } = $props();

  const id = `sel-${Math.random().toString(36).slice(2, 8)}`;
  let open = $state(false);
  let active = $state(0);
  let trigger = $state<HTMLButtonElement>();
  let list = $state<HTMLUListElement>();
  let pos = $state<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number }>({ left: 0, width: 0, maxHeight: 300 });

  const current = $derived(options.find((o) => o.value === value));

  function place() {
    const r = trigger!.getBoundingClientRect();
    const below = innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const want = Math.min(options.length * 26 + 10, 320);
    const up = below < want && above > below;
    pos = {
      left: Math.max(4, Math.min(r.left, innerWidth - r.width - 4)),
      width: r.width,
      ...(up ? { bottom: innerHeight - r.top + 2 } : { top: r.bottom + 2 }),
      maxHeight: Math.max(120, Math.min(320, up ? above : below)),
    };
  }

  async function show() {
    if (disabled || open) return;
    place();
    active = Math.max(0, options.findIndex((o) => o.value === value));
    open = true;
    await tick();
    list?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }
  function hide(focus = true) {
    open = false;
    if (focus) trigger?.focus();
  }
  function pick(i: number) {
    const o = options[i];
    if (!o || o.disabled) return;
    hide();
    if (o.value === value) return;
    value = o.value;
    onchange?.(o.value);
  }

  /** The next enabled option from `from`, going `by`. */
  function step(from: number, by: number) {
    let i = from;
    for (let n = 0; n < options.length; n++) {
      i = Math.max(0, Math.min(options.length - 1, i + by));
      if (!options[i].disabled) return i;
      if (i === 0 || i === options.length - 1) break;
    }
    return from;
  }
  function move(to: number) {
    active = to;
    list?.querySelector<HTMLElement>(`[data-i="${to}"]`)?.scrollIntoView({ block: "nearest" });
  }

  // typing a word jumps to the option that starts with it
  let typed = "";
  let typedAt = 0;
  function typeahead(key: string) {
    const now = Date.now();
    typed = now - typedAt < 700 ? typed + key.toLowerCase() : key.toLowerCase();
    typedAt = now;
    const i = options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(typed));
    if (i >= 0) move(i);
  }

  function onkeydown(e: KeyboardEvent) {
    if (disabled) return;
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) (e.preventDefault(), show());
      return;
    }
    // the list is open: its keys are its own (a dialog under it doesn't close on Escape)
    if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), hide());
    else if (e.key === "Tab") hide(false);
    else if (e.key === "ArrowDown") (e.preventDefault(), move(step(active, 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), move(step(active, -1)));
    else if (e.key === "Home") (e.preventDefault(), move(step(-1, 1)));
    else if (e.key === "End") (e.preventDefault(), move(step(options.length, -1)));
    else if (e.key === "Enter" || e.key === " ") (e.preventDefault(), pick(active));
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) typeahead(e.key);
  }

  // a click elsewhere, the page scrolling or resizing: it closes, as a native one
  $effect(() => {
    if (!open) return;
    const away = (e: Event) => {
      const t = e.target as Node;
      if (!list?.contains(t) && !trigger?.contains(t)) hide(false);
    };
    const gone = () => hide(false);
    addEventListener("pointerdown", away, true);
    addEventListener("scroll", away, true);
    addEventListener("resize", gone);
    addEventListener("blur", gone);
    return () => {
      removeEventListener("pointerdown", away, true);
      removeEventListener("scroll", away, true);
      removeEventListener("resize", gone);
      removeEventListener("blur", gone);
    };
  });

  const portal = (node: HTMLElement) => {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  };
  const described = $derived(options[active]?.description);
</script>

<button
  bind:this={trigger}
  type="button"
  class="select {klass}"
  class:open
  class:compact
  {disabled}
  {title}
  role="combobox"
  aria-label={label}
  aria-haspopup="listbox"
  aria-expanded={open}
  aria-controls={id}
  aria-activedescendant={open ? `${id}-${active}` : undefined}
  onclick={() => (open ? hide() : show())}
  {onkeydown}
>
  <!-- every label in one cell: the box is as wide as the longest, as a native one -->
  <span class="sizer">
    {#each options as o, i (i)}<span class="ghost" aria-hidden="true">{o.label}</span>{/each}
    <span class="ghost" aria-hidden="true">{placeholder}</span>
    <span class="value" class:placeholder={!current}>{current?.label ?? placeholder}</span>
  </span>
  <svg class="chev" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" stroke-width="1.2" /></svg>
</button>

{#if open}
  <div
    use:portal
    class="select-pop"
    style:left="{pos.left}px"
    style:top={pos.top != null ? `${pos.top}px` : undefined}
    style:bottom={pos.bottom != null ? `${pos.bottom}px` : undefined}
    style:min-width="{pos.width}px"
    in:fly={{ y: pos.bottom != null ? 4 : -4, duration: 120, easing: cubicOut }}
  >
    <ul bind:this={list} {id} role="listbox" aria-label={label} style:max-height="{pos.maxHeight}px">
      {#each options as o, i (i)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id="{id}-{i}"
          data-i={i}
          role="option"
          aria-selected={o.value === value}
          aria-disabled={o.disabled}
          class:active={i === active}
          class:disabled={o.disabled}
          onpointermove={() => !o.disabled && (active = i)}
          onpointerdown={(e) => e.preventDefault()}
          onclick={() => pick(i)}
        >
          <span class="check">
            {#if o.value === value}<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>{/if}
          </span>
          <span class="label">{o.label}</span>
          {#if o.hint}<span class="hint">{o.hint}</span>{/if}
        </li>
      {/each}
    </ul>
    {#if described}<p class="desc">{described}</p>{/if}
  </div>
{/if}

<style>
  .select {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    max-width: 100%;
    height: 1.75rem;
    padding: 0 0.25rem 0 0.5rem;
    font: inherit;
    font-size: 0.8125rem;
    text-align: left;
    color: var(--wb-fg, var(--ink));
    background: var(--wb-input, var(--surface));
    border: 1px solid var(--wb-input-border, var(--hair));
    border-radius: 4px;
    cursor: pointer;
    transition: border-color 0.12s;
  }
  .select.compact {
    height: 1.5rem;
    font-size: 0.75rem;
  }
  .select:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--wb-accent, var(--accent)) 45%, var(--wb-input-border, var(--hair)));
  }
  .select:focus-visible,
  .select.open {
    outline: none;
    border-color: var(--wb-accent, var(--accent));
  }
  .select:active {
    transform: none;
  }
  .select:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .sizer {
    display: grid;
    flex: 1;
    min-width: 0;
  }
  .sizer > span {
    grid-area: 1 / 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ghost {
    visibility: hidden;
    height: 0;
  }
  .placeholder {
    color: var(--wb-fg-dim, var(--muted));
  }
  .chev {
    flex: none;
    color: var(--wb-fg-muted, var(--ink-2));
    transition: transform 0.15s var(--ease, ease);
  }
  .open .chev {
    transform: rotate(180deg);
  }

  .select-pop {
    position: fixed;
    z-index: 1000;
    max-width: min(28rem, calc(100vw - 8px));
    font-size: 0.8125rem;
    color: var(--wb-fg, var(--ink));
    background: var(--wb-editor, var(--surface));
    border: 1px solid var(--wb-input-border, var(--hair));
    border-radius: 6px;
    box-shadow:
      0 8px 24px rgba(0, 0, 0, 0.22),
      0 1px 3px rgba(0, 0, 0, 0.12);
    overflow: hidden;
  }
  ul {
    margin: 0;
    padding: 4px;
    list-style: none;
    overflow-y: auto;
  }
  li {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    height: 1.625rem;
    padding: 0 0.625rem 0 0.25rem;
    border-radius: 4px;
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
  }
  li.active {
    color: var(--wb-fg, var(--ink));
    background: var(--wb-list-active, var(--hover));
  }
  li.disabled {
    opacity: 0.45;
    cursor: default;
  }
  .check {
    display: grid;
    place-items: center;
    flex: none;
    width: 1.125rem;
    color: var(--wb-accent, var(--accent));
  }
  .label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hint {
    padding-left: 1rem;
    font-size: 0.75rem;
    color: var(--wb-fg-dim, var(--muted));
  }
  .desc {
    margin: 0;
    padding: 0.4375rem 0.75rem 0.5rem;
    font-size: 0.75rem;
    line-height: 1.45;
    white-space: normal;
    color: var(--wb-fg-muted, var(--ink-2));
    border-top: 1px solid var(--wb-border, var(--hair));
  }
</style>
