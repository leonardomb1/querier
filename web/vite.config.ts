import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const api = `http://localhost:${process.env.PORT ?? 3000}`;

export default defineConfig({
  root: import.meta.dirname,
  plugins: [svelte()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: {
    proxy: {
      "/api": api,
      "/mcp": api,
      "/ws": { target: api.replace("http", "ws"), ws: true },
    },
  },
});
