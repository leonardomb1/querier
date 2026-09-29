import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const api = `http://localhost:${process.env.PORT ?? 3000}`;

export default defineConfig({
  root: import.meta.dirname,
  plugins: [svelte()],
  // Monaco (the code editor, lib/monaco.ts) is one large chunk, loaded when an editor first opens
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  server: {
    proxy: {
      "/api": api,
      "/mcp": api,
      "/ws": { target: api.replace("http", "ws"), ws: true },
    },
  },
});
