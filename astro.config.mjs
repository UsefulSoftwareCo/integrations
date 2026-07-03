import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import { fileURLToPath } from "node:url";

const isBuild = process.argv.includes("build");
const satoriWasmEntry = fileURLToPath(new URL("./node_modules/satori/dist/index.js", import.meta.url));

// One app, one render path: the catalog pages prerender at build time, and the
// dynamic pages (discovered-surface detail, detect/discover API) render in the
// same Worker through the same layout. The custom entry (worker/entry.ts) owns
// the non-page routes (/mcp, /_i analytics proxy) and exports the MCP Durable
// Object alongside the Astro fetch handler.
export default defineConfig({
  site: "https://integrations.sh",
  output: "static",
  adapter: cloudflare({
    workerEntryPoint: {
      path: "worker/entry.ts",
      namedExports: ["McpDurableObject"],
    },
    // No astro:assets image optimization in use — favicons are plain <img>.
    imageService: "passthrough",
  }),
  integrations: [
    react(),
    // Enumerate every prerendered page (homepage, /<domain>/) so crawlers don't
    // depend on the client-rendered listing. Exclude JSON/data routes.
    sitemap({ filter: (page) => !page.includes("/api/") && !page.includes("/disc/") }),
  ],
  build: {
    format: "directory",
  },
  vite: {
    // Allow access over the tailnet (by IP or .ts.net hostname). `true`
    // disables Vite's host check — fine for a dev/preview server on a private net.
    preview: { allowedHosts: true },
    server: { allowedHosts: true },
    // react-dom's exports map otherwise resolves "worker" → server.browser.js,
    // which needs MessageChannel — absent in workerd. Pin the edge build, but
    // only for `astro build`: the dev server renders on Node, where the edge
    // file's CJS `require` breaks (and the browser build works fine).
    define: { "process.env.SATORI_STANDALONE": JSON.stringify("1") },
    resolve: {
      alias: {
        "satori/wasm": satoriWasmEntry,
        ...(isBuild ? { "react-dom/server": "react-dom/server.edge" } : {}),
      },
    },
  },
});
