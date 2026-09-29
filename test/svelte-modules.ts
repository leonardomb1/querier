// Tests import runes modules (*.svelte.ts: $state, $derived) as the app does:
// types off, then Svelte's module compiler.
import { plugin } from "bun";
import { compileModule } from "svelte/compiler";

plugin({
  name: "svelte-modules",
  setup(b) {
    b.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => ({
      contents: compileModule(new Bun.Transpiler({ loader: "ts" }).transformSync(await Bun.file(path).text()), { filename: path, generate: "client" }).js.code,
      loader: "js",
    }));
  },
});
