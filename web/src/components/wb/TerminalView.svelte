<script lang="ts">
  import "@xterm/xterm/css/xterm.css";
  import { FitAddon } from "@xterm/addon-fit";
  import { Terminal } from "@xterm/xterm";
  import { onMount } from "svelte";
  import type { NotebookCtl } from "../../lib/notebook.svelte";

  // A terminal, as VS Code's: a shell in this person's kernel's microVM, over the
  // kernel socket. What it writes stays in the sandbox and is gone when the kernel
  // restarts; the notebook's files are read-only there. It lives while the
  // notebook is open (hidden when the panel shows something else).
  let { ctl, visible }: { ctl: NotebookCtl; visible: boolean } = $props();

  let host: HTMLDivElement;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let id = "";
  let running = $state(false);
  let ended = $state("");

  // VS Code's terminal colors
  const DARK = {
    black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510", blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
    brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b", brightYellow: "#f5f543", brightBlue: "#3b8eea", brightMagenta: "#d670d6", brightCyan: "#29b8db", brightWhite: "#e5e5e5",
  };
  const LIGHT = {
    black: "#000000", red: "#cd3131", green: "#00bc00", yellow: "#949800", blue: "#0451a5", magenta: "#bc05bc", cyan: "#0598bc", white: "#555555",
    brightBlack: "#666666", brightRed: "#cd3131", brightGreen: "#14ce14", brightYellow: "#b5ba00", brightBlue: "#0451a5", brightMagenta: "#bc05bc", brightCyan: "#0598bc", brightWhite: "#a5a5a5",
  };
  function theme() {
    const css = getComputedStyle(host);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const dark = getComputedStyle(document.documentElement).colorScheme.includes("dark");
    return { ...(dark ? DARK : LIGHT), background: v("--wb-side"), foreground: v("--wb-fg"), cursor: v("--wb-fg"), selectionBackground: dark ? "#264f78" : "#add6ff" };
  }

  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

  function start() {
    if (!term || !fit) return;
    ended = "";
    running = true;
    id = crypto.randomUUID().slice(0, 8);
    const mine = id;
    term.writeln(dim("A shell in your kernel's sandbox, with its connections. The notebook's files are read-only here;"));
    term.writeln(dim("what you write or install is gone when the kernel restarts (lasting packages: the notebook's Environment settings)."));
    ctl.conn.openTerminal(id, term.cols, term.rows, {
      data: (bytes) => mine === id && term?.write(bytes),
      exit: (code, message) => {
        if (mine !== id) return;
        running = false;
        ended = message ?? (code != null ? `The shell exited with code ${code}.` : "The shell ended.");
        term?.writeln("");
        term?.writeln(dim(`${ended} Press Enter to start another.`));
      },
    });
  }

  onMount(() => {
    term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: theme(),
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    // as VS Code: Ctrl+C copies what is selected (else interrupts), Ctrl+V pastes
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !(e.ctrlKey || e.metaKey)) return true;
      const key = e.key.toLowerCase();
      if (key === "c" && term!.hasSelection()) {
        navigator.clipboard?.writeText(term!.getSelection());
        term!.clearSelection();
        return false;
      }
      if (key === "v") return false; // the browser's paste reaches the terminal
      return true;
    });
    const input = term.onData((data) => {
      if (running) ctl.conn.terminalInput(id, data);
      else if (data === "\r") {
        term!.writeln("");
        start();
      }
    });
    const resized = term.onResize(({ cols, rows }) => running && ctl.conn.resizeTerminal(id, cols, rows));
    const box = new ResizeObserver(() => {
      if (host.offsetParent) fit!.fit();
    });
    box.observe(host);
    // the theme follows the page's
    const follow = () => term && (term.options.theme = theme());
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", follow);
    const attr = new MutationObserver(follow);
    attr.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    start();
    return () => {
      box.disconnect();
      attr.disconnect();
      media.removeEventListener("change", follow);
      input.dispose();
      resized.dispose();
      if (running) ctl.conn.closeTerminal(id);
      term?.dispose();
    };
  });

  // shown again: sized to the panel, and typed into
  $effect(() => {
    if (!visible || !term) return;
    requestAnimationFrame(() => {
      fit?.fit();
      term?.focus();
    });
  });

  export function restart() {
    if (running) ctl.conn.closeTerminal(id);
    running = false;
    term?.reset();
    start();
  }
</script>

<div class="terminal" class:hidden={!visible} bind:this={host}></div>

<style>
  .terminal {
    height: 100%;
    min-height: 0;
    padding: 0.25rem 0 0 0.75rem;
    background: var(--wb-side);
  }
  .terminal.hidden {
    display: none;
  }
  .terminal :global(.xterm) {
    height: 100%;
  }
  .terminal :global(.xterm-viewport) {
    background: var(--wb-side) !important;
  }
</style>
