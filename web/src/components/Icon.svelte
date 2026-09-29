<script lang="ts" module>
  // Icons are VS Code's own, Codicons (@vscode/codicons, CC BY 4.0): the names
  // below are the app's, each mapped to its codicon; any codicon name works too.
  const MAP = {
    play: "play",
    stop: "debug-stop",
    restart: "debug-restart",
    plus: "add",
    up: "arrow-up",
    down: "arrow-down",
    trash: "trash",
    more: "ellipsis",
    sidebar: "layout-sidebar-left",
    search: "search",
    chevron: "chevron-right",
    table: "table",
    eye: "eye",
    eyeOff: "eye-closed",
    keyboard: "keyboard",
    command: "symbol-event",
    link: "link",
    database: "database",
    file: "file",
    variable: "symbol-variable",
    x: "close",
    info: "info",
    line: "graph-line",
    dataframe: "table",
    globe: "globe",
    clock: "history",
    expand: "screen-full",
    shrink: "screen-normal",
    filter: "filter",
    bars: "graph",
    stat: "symbol-number",
    hash: "symbol-number",
    code: "code",
    sparkle: "sparkle",
    copy: "copy",
    check: "check",
    download: "cloud-download",
    pencil: "edit",
    grip: "gripper",
    branch: "git-branch",
    history: "history",
    undo: "discard",
    arrowUp: "arrow-up",
    arrowDown: "arrow-down",
    settings: "settings-gear",
    fold: "fold",
    sort: "arrow-swap",
  } as const;
  export type IconName = keyof typeof MAP | (string & {});
</script>

<script lang="ts">
  import { zoom } from "../lib/zoom.svelte";

  let { name, size = 16, spin = false }: { name: IconName; size?: number; spin?: boolean } = $props();
  const glyph = $derived((MAP as Record<string, string>)[name] ?? name);
</script>

<i class="codicon codicon-{glyph}" class:codicon-modifier-spin={spin} style:font-size="{zoom.px(size)}px" aria-hidden="true"></i>

<style>
  i {
    flex: none;
    display: block;
    line-height: 1;
  }
</style>
