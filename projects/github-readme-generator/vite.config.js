import { defineConfig } from "vite";
import { offlinePlugin } from "./scripts/offline-plugin.mjs";
import { readFileSync } from "node:fs";
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);
export default defineConfig({
  plugins: [offlinePlugin(version)],
  base: "./",
  worker: { format: "es" },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/highlight.js/"))
            return "syntax-highlighting";
          if (
            id.includes("node_modules/marked/") ||
            id.includes("node_modules/dompurify/")
          )
            return "markdown-engine";
        },
      },
    },
  },
  test: { environment: "jsdom", include: ["tests/**/*.test.js"] },
});
