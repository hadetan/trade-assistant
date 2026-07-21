import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// Relaxed only while the renderer is served by the Vite dev server: the strict
// production CSP (default-src 'none') would block the HMR websocket. The static
// CSP in index.html stays strict, so a missing/failed plugin fails safe.
const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: http:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, "src/main/main.ts") },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, "src/main/preload.ts") },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      modulePreload: { polyfill: false },
      rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") },
    },
    plugins: [
      {
        name: "trade-assistant-dev-csp",
        transformIndexHtml(html, ctx) {
          if (!ctx.server) return html;
          return html.replace(
            /(<meta http-equiv="Content-Security-Policy" content=")[^"]*(")/,
            `$1${DEV_CSP}$2`,
          );
        },
      },
    ],
  },
});
