import { mount } from "svelte";
import App from "./App.svelte";
// The default faces, bundled so they work offline and inside the VM; the others
// load when picked (lib/fonts.svelte.ts).
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import "@vscode/codicons/dist/codicon.css";
import "./app.css";
import "./lib/fonts.svelte";
import "./lib/zoom.svelte"; // sets the root size before the first paint

mount(App, { target: document.getElementById("app")! });
