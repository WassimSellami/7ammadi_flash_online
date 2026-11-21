import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: fileURLToPath(new URL("../../assets", import.meta.url)),
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:8787", ws: true, changeOrigin: true },
    },
  },
  worker: { format: "es" },
  build: {
    outDir: "dist",
    manifest: true,
    target: "es2022",
    assetsInlineLimit: 4096,
    sourcemap: false,
  },
});
