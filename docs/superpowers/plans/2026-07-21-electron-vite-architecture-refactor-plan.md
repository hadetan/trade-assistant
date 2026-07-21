# electron-vite Migration + VS-Code-Inspired Main-Process Architecture Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `tsc`+manual-copy build with `electron-vite`, and restructure `electron-app/src/main/`'s flat co-located-tests layout into a thin `main.ts`, a `bootstrap.ts` composition root, domain-grouped `services/`, an `ipc/` bridge layer, and a mirrored `test/main/` tree — with zero behavior change.

**Architecture:** `electron-vite` bundles the main process, bundles the preload to CommonJS (required by `sandbox: true`), and serves the renderer from a real Vite dev server with HMR while auto-restarting the main process on change. The main-process code is regrouped by domain (a composition root doing manual wiring — no DI container, no IPC-channel/proxy abstraction), and every `*.test.ts` moves out of `src/` into a `test/`-rooted mirror. This is a pure structural refactor: no feature work, no safety-logic changes, no Rust changes.

**Tech Stack:** Electron 33.2.0, TypeScript 5.7.2, `electron-vite` 2.3.0, Vite 5.4.21, Vitest 2.1.8, Node 22 (v22.22.2 on this machine).

## Global Constraints

Every task's requirements implicitly include this section.

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` must hold after the refactor. There is an explicit verification step for this: the existing `mainWindow.test.ts` must still pass unchanged in its new location, AND the built preload must be CommonJS (a sandboxed preload requires CommonJS, not ESM). These three flags are locked in from the first commit and must never regress.
- Comments: default none; only for a non-obvious *why* (a non-obvious invariant, an upstream-bug workaround, a formula's source); never restate the next line; never a numbered step-by-step block above a function (per repo `CLAUDE.md`).
- TypeScript: `camelCase` functions/variables, `PascalCase` types/classes, no Hungarian notation, no non-standard abbreviations (`oi`, `pcr`, `ltp` are fine). File names describe responsibility, not file kind (`confluence.rs`, not `utils.rs`).
- Small, focused files over large ones; pure logic separate from I/O.
- Every commit authored by `hadetan <aquibsyed83@gmail.com>` (already the repo's git identity — do NOT pass `--author` and do NOT add any trailer). No `Co-Authored-By` trailer. Never use `--no-verify`.
- TDD per step where a step calls for it. For pure file-move/rename tasks (no logic change) the "test" is that the existing test suite continues to pass **unchanged** after the move — do not invent new tests for code whose behavior is not changing.
- Dependency versions: `electron-vite@2.3.0` + `vite@5.4.21` were chosen because 2.3.0 is the newest electron-vite that peers `vite: "^4.0.0 || ^5.0.0"`, which matches the Vite 5.4.21 already resolved in the tree via `vitest@2.1.8` (peer `vite: "^5.0.0"`). electron-vite 3.x/4.x/5.x require Vite 6/6/7 and would force a `vitest` major upgrade — out of scope for a structure refactor. `@swc/core` is an *optional* peer of electron-vite and is NOT needed (electron-vite bundles its own esbuild 0.21.5, matching the tree). Because `electron-app/package.json` has no `"type": "module"`, electron-vite emits the preload as CommonJS by default — this is what `sandbox: true` requires.
- Out of scope (do NOT touch): any Rust code; the safety-critical *logic* of `kiteClient.ts` / `claudeProvider.ts` / `mcpDriftMonitor.ts` (only their file location and import paths change); the previously-documented Phase-4 prerequisites (sidecar request timeout, session-classifier fail-open default, persist-error surfacing, `driftWarning` wiring). `driftWarning` stays declared-but-unwired exactly as today.

---

## Current State (verified 2026-07-21)

- `npx tsc --noEmit` passes (exit 0). `npx vitest run` passes: 11 test files, 34 tests (10 co-located `*.test.ts` under `src/main/` + 1 top-level `test/endToEnd.integration.test.ts`). The Rust sidecar binary exists at `rust-core/target/debug/sidecar`.
- Flat `src/main/` holds 14 source files: `main.ts`, `mainWindow.ts`, `preload.ts`, `rendererApi.ts`, `sidecarProtocol.ts`, `sidecarSupervisor.ts`, `appBridge.ts`, `kiteClient.ts`, `mcpDriftMonitor.ts`, `claudeProvider.ts`, `kiteOAuth.ts`, `kiteSessionState.ts`, `historicalDataArchive.ts`, `mcpClientAdapter.ts`.
- `src/renderer/` holds `index.html` (static, references `./status.js`) and `status.ts` (imports the type `import("../main/rendererApi").RendererApi`).
- No `vite`/`electron-vite` installed yet; `vite@5.4.21` and `esbuild@0.21.5` are already present transitively via `vitest`.

### Internal import graph (source → source)

- `main.ts` → `mainWindow`, `sidecarSupervisor`, `kiteSessionState`, `appBridge`, `rendererApi` (type)
- `preload.ts` → `rendererApi`
- `sidecarSupervisor.ts` → `sidecarProtocol`, `rendererApi` (type)
- `appBridge.ts` → `rendererApi` (type)
- `mcpDriftMonitor.ts` → `kiteClient`
- `claudeProvider.ts` → `kiteClient`
- `kiteSessionState.ts` → `rendererApi` (type)
- `historicalDataArchive.ts` → `kiteClient` (type), `sidecarSupervisor` (type), `sidecarProtocol` (type)
- `mcpClientAdapter.ts` → `kiteClient` (type), `mcpDriftMonitor` (type)
- `renderer/status.ts` → `main/rendererApi` (type)
- `kiteClient.ts`, `kiteOAuth.ts`, `sidecarProtocol.ts`, `rendererApi.ts`, `mainWindow.ts` → no internal imports.

---

## File Structure (final target)

```
electron-app/
├── electron.vite.config.ts          NEW — main/preload/renderer Vite build entries + dev-only CSP
├── package.json                     MOD — scripts (dev/build/preview/start/typecheck/test), main→out/, +electron-vite +vite
├── tsconfig.json                    MOD — noEmit type-check config covering src/ + test/
├── vitest.config.ts                 MOD — discover only test/**/*.test.ts
├── .gitignore                       MOD — add out/
├── src/
│   ├── main/
│   │   ├── main.ts                  MOD — thin Electron lifecycle glue only
│   │   ├── bootstrap.ts             NEW — composition root (manual wiring)
│   │   ├── mainWindow.ts            unchanged content — stays top-level (see note A)
│   │   ├── ipc/
│   │   │   ├── preload.ts           moved from src/main/preload.ts
│   │   │   ├── appBridge.ts         moved from src/main/appBridge.ts
│   │   │   └── rendererApi.ts       moved from src/main/rendererApi.ts (see note B)
│   │   └── services/
│   │       ├── sidecar/
│   │       │   ├── sidecarSupervisor.ts
│   │       │   └── sidecarProtocol.ts
│   │       ├── kite/
│   │       │   ├── kiteClient.ts
│   │       │   ├── kiteOAuth.ts
│   │       │   ├── kiteSessionState.ts
│   │       │   ├── mcpDriftMonitor.ts
│   │       │   ├── mcpClientAdapter.ts
│   │       │   └── historicalDataArchive.ts   (see note C)
│   │       └── claude/
│   │           └── claudeProvider.ts
│   └── renderer/
│       ├── index.html               MOD — module script tag (./status.ts)
│       └── status.ts                MOD — type import path → main/ipc/rendererApi
└── test/
    ├── endToEnd.integration.test.ts stays; imports repathed
    └── main/
        ├── mainWindow.test.ts
        ├── ipc/
        │   └── rendererApi.test.ts
        └── services/
            ├── sidecar/
            │   └── sidecarSupervisor.test.ts
            ├── kite/
            │   ├── kiteClient.test.ts
            │   ├── kiteOAuth.test.ts
            │   ├── kiteSessionState.test.ts
            │   ├── mcpDriftMonitor.test.ts
            │   └── mcpClientAdapter.test.ts
            └── claude/
                └── claudeProvider.test.ts
```

**Note A — `mainWindow.ts` placement:** It stays at top-level `src/main/` beside `main.ts`/`bootstrap.ts` because it is app-shell/window configuration consumed only by the composition root, and a single 14-line options factory does not warrant its own directory.

**Note B — `rendererApi.ts` in `ipc/`:** It holds the renderer-facing contract (`AppStatus`/`BannerEvent`/`SidecarStatus`/`KiteSessionStatus` types + `buildRendererApi`) that both the preload bridge and `renderer/status.ts` consume, so `ipc/` is its natural home. It is not split further (types vs. builder) because at ~30 lines that split would be over-engineering with no reader benefit.

**Note C — `historicalDataArchive.ts` in `services/kite/`:** It is the Kite historical-data acquisition chokepoint (fetch from Kite → parse → persist). Its dependency on the sidecar is a narrow persist target (`Pick<SidecarSupervisor, "persistCandles">`), not a co-equal domain, so it belongs with the Kite services rather than in its own group. `mcpClientAdapter.ts` and `mcpDriftMonitor.ts` are both Kite/MCP concerns and live in `services/kite/` for the same reason.

### Why source moves and test moves happen together, per domain

Each restructure task has two gates: `npx tsc --noEmit`, which validates every **source** import path and source type (tests stay excluded from `tsc`, exactly as today — see the note in Task 1 Step 4 for why), and `npx vitest run`, which executes every test (a broken import in a test, or in a source file a test loads, fails module resolution and the run). Because `vitest run` must stay green every task, a domain cannot be half-moved: if `kiteClient.ts` moved but its co-located test still imported `./kiteClient`, `vitest run` would fail to load that test. So each restructure task relocates a domain's sources **and** that domain's tests together and repaths every importer, ending green. A handful of cross-group import specifiers are edited in two consecutive tasks (each edit is exact and verified by both gates); these are called out inline where they occur.

---

## Task 1: Adopt electron-vite (build tool, config, scripts)

**Files:**
- Create: `electron-app/electron.vite.config.ts`
- Modify: `electron-app/package.json`
- Modify: `electron-app/tsconfig.json`
- Modify: `electron-app/.gitignore`
- Modify: `electron-app/src/renderer/index.html`
- Modify: `electron-app/src/main/main.ts` (window-load paths only — see Step 6)
- Unchanged this task: `vitest.config.ts`, all other source, all tests (still co-located)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: build outputs at `out/main/main.js`, `out/preload/preload.js`, `out/renderer/index.html`; new npm scripts `dev`, `build`, `preview`, `start`, `typecheck`; the env contract `process.env.ELECTRON_RENDERER_URL` (set by electron-vite in dev, undefined in prod) that later tasks' `bootstrap.ts` reads.

- [ ] **Step 1: Add the dependencies**

Run (cwd `electron-app`):

```bash
npm install --save-dev electron-vite@2.3.0 vite@5.4.21
```

Expected: installs without peer-dependency errors (both `electron-vite` and `vitest` accept Vite 5). Do NOT install `@swc/core` (optional peer, unused).

- [ ] **Step 2: Write `electron.vite.config.ts`**

Create `electron-app/electron.vite.config.ts` with exactly:

```ts
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
```

- [ ] **Step 3: Rewrite `package.json`**

Replace `electron-app/package.json` with exactly:

```json
{
  "name": "trade-assistant-app",
  "version": "0.1.0",
  "private": true,
  "description": "Trade Assistant Electron shell (read-only analysis; never places orders).",
  "main": "out/main/main.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "start": "electron-vite build && electron-vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "@modelcontextprotocol/sdk": "1.12.0",
    "@types/node": "22.10.0",
    "electron": "33.2.0",
    "electron-vite": "2.3.0",
    "typescript": "5.7.2",
    "vite": "5.4.21",
    "vitest": "2.1.8"
  }
}
```

- [ ] **Step 4: Rewrite `tsconfig.json` as a no-emit type-check config**

electron-vite/esbuild now does the transpile; `tsc` is only a type-checker. Replace `electron-app/tsconfig.json` with exactly:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  },
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts", "node_modules", "out"]
}
```

(Only emit options changed vs. the original: removed `outDir`/`rootDir`/`declaration`/`sourceMap`, added `noEmit`, swapped the excluded build dir `dist`→`out`. The scope is preserved exactly — `tsc` checks source and continues to EXCLUDE `*.test.ts`. This is deliberate: the co-located tests contain pre-existing patterns that `strict` `tsc` rejects but Vitest's esbuild transpile accepts — e.g. `rendererApi.test.ts`'s `api as Record<string, unknown>` cast [TS2352] and `sidecarSupervisor.test.ts`'s implicitly-typed `spawnFn` [TS7023]. The spec requires tests to move byte-identical except for import specifiers, so they must not be type-checked or edited to satisfy `tsc`. Test import paths are instead validated by the `npx vitest run` gate in every task, which fails module resolution on a bad path.)

- [ ] **Step 5: Add `out/` to `.gitignore`**

Edit `electron-app/.gitignore` to:

```
node_modules/
dist/
out/
```

- [ ] **Step 6: Point `main.ts` window creation at electron-vite output paths**

electron-vite output is `out/{main,preload,renderer}/`. From `out/main/`, the preload is `../preload/preload.js` and the packaged renderer is `../renderer/index.html`; in dev the renderer is served from `process.env.ELECTRON_RENDERER_URL`. In `src/main/main.ts`, change the preload path and the renderer load.

Old (line 29):

```ts
  const window = new BrowserWindow(mainWindowOptions(path.join(__dirname, "preload.js")));
```

New:

```ts
  const window = new BrowserWindow(mainWindowOptions(path.join(__dirname, "..", "preload", "preload.js")));
```

Old (line 40):

```ts
  window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
```

New:

```ts
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) window.loadURL(rendererUrl);
  else window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
```

(The default sidecar binary path `path.join(__dirname, "..", "..", "..", "rust-core", ...)` is unchanged: `out/main` sits at the same depth under `electron-app/` as the old `dist/main`, so three `..` still resolves to the repo root.)

- [ ] **Step 7: Make `index.html` a Vite module entry**

In `electron-app/src/renderer/index.html`, change the script tag so Vite treats `status.ts` as the module entry.

Old (line 12):

```html
    <script src="./status.js"></script>
```

New:

```html
    <script type="module" src="./status.ts"></script>
```

- [ ] **Step 8: Build and verify the preload is CommonJS**

Run (cwd `electron-app`):

```bash
npx electron-vite build
```

Expected: build succeeds; `out/main/main.js`, `out/preload/preload.js`, `out/renderer/index.html` exist. Confirm the preload filename is `.js` (not `.mjs`) and its contents are CommonJS:

```bash
ls out/preload/
grep -nE "require\(|module\.exports|Object\.defineProperty\(exports" out/preload/preload.js
grep -nEc "^\s*(import|export) " out/preload/preload.js
```

Expected: `out/preload/` contains `preload.js` (no `.mjs`); the first grep prints at least one match (e.g. `require("electron")`, since `externalizeDepsPlugin` keeps `electron` external); the second grep prints `0` (no top-level ESM `import`/`export`). Together this proves the sandbox-safe CommonJS preload.

- [ ] **Step 9: Type-check and run the existing suite**

```bash
npx tsc --noEmit
npx vitest run
```

Expected: `tsc --noEmit` prints nothing and exits 0. `vitest run` reports `Test Files 11 passed`, `Tests 34 passed` (tests are still co-located this task; `vitest.config.ts` is unchanged and already globs both `src/**/*.test.ts` and `test/**/*.test.ts`).

- [ ] **Step 10: Commit**

All commands in this plan run with the working directory at `electron-app/`. Commit:

```bash
git add electron.vite.config.ts package.json package-lock.json tsconfig.json .gitignore src/renderer/index.html src/main/main.ts
git commit -m "build(electron-app): adopt electron-vite for main/preload/renderer bundling"
```

---

## Task 2: Thin `main.ts`, extract `bootstrap.ts` composition root

**Files:**
- Create: `electron-app/src/main/bootstrap.ts`
- Modify: `electron-app/src/main/main.ts`
- No test file (following the existing convention: `main.ts`/`preload.ts` have no unit test because they are thin Electron-only wiring; `bootstrap.ts` is the composition root and is likewise covered by `electron-vite build` + the dev smoke check, not a unit test — see Global Constraints on pure-wiring tasks).

**Interfaces:**
- Consumes (at flat locations this task): `SidecarSupervisor` from `./sidecarSupervisor`; `KiteSessionState` from `./kiteSessionState`; `registerStatusBridge` from `./appBridge`; `mainWindowOptions` from `./mainWindow`; `AppStatus`/`BannerEvent`/`SidecarStatus` from `./rendererApi`.
- Produces: `createApp(): AppRuntime` where `interface AppRuntime { start(): void; stop(): void }`. `start()` calls `supervisor.start()` then creates the main window; `stop()` calls `supervisor.stop()`. Later tasks repath only `bootstrap.ts`'s import specifiers as its dependencies move — `main.ts` is not touched again.

This is a behavior-preserving extraction: the exact logic currently inline in `main.ts` moves into `bootstrap.ts`. `driftWarning` remains a declared-but-unwired `let` (do NOT wire it).

- [ ] **Step 1: Create `bootstrap.ts`**

Create `electron-app/src/main/bootstrap.ts` with exactly:

```ts
import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { mainWindowOptions } from "./mainWindow";
import { SidecarSupervisor } from "./sidecarSupervisor";
import { KiteSessionState } from "./kiteSessionState";
import { registerStatusBridge } from "./appBridge";
import type { AppStatus, BannerEvent, SidecarStatus } from "./rendererApi";

export interface AppRuntime {
  start(): void;
  stop(): void;
}

export function createApp(): AppRuntime {
  const supervisor = new SidecarSupervisor({
    binaryPath:
      process.env.SIDECAR_BINARY ??
      path.join(__dirname, "..", "..", "..", "rust-core", "target", "debug", "sidecar"),
    lakeRoot: process.env.TRADE_ASSISTANT_LAKE ?? path.join(app.getPath("userData"), "candle-lake"),
  });
  const sessionState = new KiteSessionState();

  let sidecarStatus: SidecarStatus = "down";
  let driftWarning: string | null = null;
  const bannerHandlers: ((banner: BannerEvent) => void)[] = [];

  supervisor.on("statusChange", (status: SidecarStatus) => {
    sidecarStatus = status;
  });
  sessionState.on("banner", (banner: BannerEvent) =>
    bannerHandlers.forEach((handler) => handler(banner)),
  );

  const currentStatus = (): AppStatus => ({
    sidecar: sidecarStatus,
    kiteSession: sessionState.status,
    driftWarning,
  });

  const createMainWindow = (): BrowserWindow => {
    const window = new BrowserWindow(
      mainWindowOptions(path.join(__dirname, "..", "preload", "preload.js")),
    );
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|mailto):/.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    registerStatusBridge({
      ipcMain,
      getStatus: currentStatus,
      onBanner: (handler) => bannerHandlers.push(handler),
      sendToRenderer: (channel, payload) => window.webContents.send(channel, payload),
    });
    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl) window.loadURL(rendererUrl);
    else window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
    return window;
  };

  return {
    start: () => {
      supervisor.start();
      createMainWindow();
    },
    stop: () => {
      supervisor.stop();
    },
  };
}
```

- [ ] **Step 2: Replace `main.ts` with thin lifecycle glue**

Replace the entire contents of `electron-app/src/main/main.ts` with exactly:

```ts
import { app } from "electron";
import { createApp } from "./bootstrap";

const runtime = createApp();

app.whenReady().then(() => {
  runtime.start();
});

app.on("window-all-closed", () => {
  runtime.stop();
  if (process.platform !== "darwin") app.quit();
});
```

- [ ] **Step 3: Type-check, build, and run the suite**

```bash
npx tsc --noEmit
npx electron-vite build
npx vitest run
```

Expected: `tsc --noEmit` clean; `electron-vite build` succeeds (`out/main/main.js` now bundles `bootstrap.ts`); `vitest run` reports `11 passed` / `34 passed` (no test references `main.ts`/`bootstrap.ts`, so counts are unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/main/main.ts src/main/bootstrap.ts
git commit -m "refactor(electron-app): extract composition root into bootstrap.ts"
```

---

## Task 3: Move the renderer bridge into `ipc/`

**Files:**
- Move: `src/main/rendererApi.ts` → `src/main/ipc/rendererApi.ts`
- Move: `src/main/appBridge.ts` → `src/main/ipc/appBridge.ts`
- Move: `src/main/preload.ts` → `src/main/ipc/preload.ts`
- Move: `src/main/rendererApi.test.ts` → `test/main/ipc/rendererApi.test.ts`
- Modify (importers): `src/main/bootstrap.ts`, `src/main/sidecarSupervisor.ts`, `src/main/kiteSessionState.ts`, `src/renderer/status.ts`, `electron.vite.config.ts`

**Interfaces:**
- Produces: `rendererApi` at `src/main/ipc/rendererApi.ts`; `appBridge` (`registerStatusBridge`) at `src/main/ipc/appBridge.ts`; preload entry at `src/main/ipc/preload.ts`.
- `appBridge.ts` and `preload.ts` keep importing `./rendererApi` (all three land in the same `ipc/` directory), so those specifiers do NOT change.

- [ ] **Step 1: Create directories and move files**

Run (cwd `electron-app`):

```bash
mkdir -p src/main/ipc test/main/ipc
git mv src/main/rendererApi.ts src/main/ipc/rendererApi.ts
git mv src/main/appBridge.ts src/main/ipc/appBridge.ts
git mv src/main/preload.ts src/main/ipc/preload.ts
git mv src/main/rendererApi.test.ts test/main/ipc/rendererApi.test.ts
```

- [ ] **Step 2: Repath the importers still outside `ipc/`**

`src/main/bootstrap.ts` — change two lines:

Old:

```ts
import { registerStatusBridge } from "./appBridge";
import type { AppStatus, BannerEvent, SidecarStatus } from "./rendererApi";
```

New:

```ts
import { registerStatusBridge } from "./ipc/appBridge";
import type { AppStatus, BannerEvent, SidecarStatus } from "./ipc/rendererApi";
```

`src/main/sidecarSupervisor.ts` (still flat this task) — change the type import:

Old:

```ts
import type { SidecarStatus } from "./rendererApi";
```

New:

```ts
import type { SidecarStatus } from "./ipc/rendererApi";
```

`src/main/kiteSessionState.ts` (still flat this task) — change the type import:

Old:

```ts
import type { BannerEvent, KiteSessionStatus } from "./rendererApi";
```

New:

```ts
import type { BannerEvent, KiteSessionStatus } from "./ipc/rendererApi";
```

`src/renderer/status.ts` — change the inline type import (line 1):

Old:

```ts
const api = (window as unknown as { tradeAssistant: import("../main/rendererApi").RendererApi }).tradeAssistant;
```

New:

```ts
const api = (window as unknown as { tradeAssistant: import("../main/ipc/rendererApi").RendererApi }).tradeAssistant;
```

- [ ] **Step 3: Repath the relocated test**

`test/main/ipc/rendererApi.test.ts` — change the import (line 2):

Old:

```ts
import { buildRendererApi } from "./rendererApi";
```

New:

```ts
import { buildRendererApi } from "../../../src/main/ipc/rendererApi";
```

- [ ] **Step 4: Update the preload build entry in `electron.vite.config.ts`**

Old:

```ts
    build: {
      rollupOptions: { input: resolve(__dirname, "src/main/preload.ts") },
    },
```

New (the `preload` section only):

```ts
    build: {
      rollupOptions: { input: resolve(__dirname, "src/main/ipc/preload.ts") },
    },
```

- [ ] **Step 5: Type-check, run the suite, rebuild, re-verify preload CJS**

```bash
npx tsc --noEmit
npx vitest run
npx electron-vite build
grep -nEc "^\s*(import|export) " out/preload/preload.js
```

Expected: `tsc --noEmit` clean; `vitest run` `11 passed` / `34 passed` (`rendererApi.test.ts` now runs from `test/main/ipc/`); build succeeds; the grep prints `0` (preload still CommonJS after the move).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(electron-app): move renderer bridge into ipc/"
```

---

## Task 4: Move sidecar modules into `services/sidecar/`

**Files:**
- Move: `src/main/sidecarProtocol.ts` → `src/main/services/sidecar/sidecarProtocol.ts`
- Move: `src/main/sidecarSupervisor.ts` → `src/main/services/sidecar/sidecarSupervisor.ts`
- Move: `src/main/sidecarSupervisor.test.ts` → `test/main/services/sidecar/sidecarSupervisor.test.ts`
- Modify (importers): `src/main/bootstrap.ts`, `src/main/historicalDataArchive.ts` (still flat), `test/endToEnd.integration.test.ts`

**Interfaces:**
- Produces: `SidecarSupervisor` at `src/main/services/sidecar/sidecarSupervisor.ts`; wire types (`CandleWire`, `ComputeResponseWire`, `PersistCandlesResponseWire`, `SidecarRequestWire`, `SidecarResponseWire`, `encodeRequest`) at `src/main/services/sidecar/sidecarProtocol.ts`.
- `sidecarSupervisor.ts` keeps importing `./sidecarProtocol` (same dir), so that specifier does NOT change.

- [ ] **Step 1: Create directories and move files**

```bash
mkdir -p src/main/services/sidecar test/main/services/sidecar
git mv src/main/sidecarProtocol.ts src/main/services/sidecar/sidecarProtocol.ts
git mv src/main/sidecarSupervisor.ts src/main/services/sidecar/sidecarSupervisor.ts
git mv src/main/sidecarSupervisor.test.ts test/main/services/sidecar/sidecarSupervisor.test.ts
```

- [ ] **Step 2: Fix `sidecarSupervisor.ts`'s rendererApi import for its new depth**

In Task 3 this line became `./ipc/rendererApi` while the file was flat; from `services/sidecar/` it must go up two levels. In `src/main/services/sidecar/sidecarSupervisor.ts`:

Old:

```ts
import type { SidecarStatus } from "./ipc/rendererApi";
```

New:

```ts
import type { SidecarStatus } from "../../ipc/rendererApi";
```

- [ ] **Step 3: Repath `bootstrap.ts` and `historicalDataArchive.ts`**

`src/main/bootstrap.ts` — change:

Old:

```ts
import { SidecarSupervisor } from "./sidecarSupervisor";
```

New:

```ts
import { SidecarSupervisor } from "./services/sidecar/sidecarSupervisor";
```

`src/main/historicalDataArchive.ts` (still flat this task) — change two type imports:

Old:

```ts
import type { SidecarSupervisor } from "./sidecarSupervisor";
import type { CandleWire } from "./sidecarProtocol";
```

New:

```ts
import type { SidecarSupervisor } from "./services/sidecar/sidecarSupervisor";
import type { CandleWire } from "./services/sidecar/sidecarProtocol";
```

- [ ] **Step 4: Repath the relocated test and the e2e test**

`test/main/services/sidecar/sidecarSupervisor.test.ts` — change:

Old:

```ts
import { SidecarSupervisor } from "./sidecarSupervisor";
```

New:

```ts
import { SidecarSupervisor } from "../../../../src/main/services/sidecar/sidecarSupervisor";
```

`test/endToEnd.integration.test.ts` — change only the sidecar import (line 7):

Old:

```ts
import { SidecarSupervisor } from "../src/main/sidecarSupervisor";
```

New:

```ts
import { SidecarSupervisor } from "../src/main/services/sidecar/sidecarSupervisor";
```

- [ ] **Step 5: Type-check and run the suite**

```bash
npx tsc --noEmit
npx vitest run
```

Expected: `tsc --noEmit` clean; `vitest run` `11 passed` / `34 passed` (`sidecarSupervisor.test.ts` runs from its new home; the e2e test still finds the real sidecar binary).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(electron-app): move sidecar modules into services/sidecar/"
```

---

## Task 5: Move Kite modules into `services/kite/`

**Files:**
- Move sources: `kiteClient.ts`, `kiteOAuth.ts`, `kiteSessionState.ts`, `mcpDriftMonitor.ts`, `mcpClientAdapter.ts`, `historicalDataArchive.ts` → `src/main/services/kite/`
- Move tests: the five corresponding `*.test.ts` → `test/main/services/kite/`
- Modify (importers): `src/main/claudeProvider.ts` (still flat), `src/main/bootstrap.ts`, `test/endToEnd.integration.test.ts`

**Interfaces:**
- Produces (all under `src/main/services/kite/`): `KiteClient` + `KITE_READ_TOOL_NAMES` + `KITE_WRITE_TOOL_NAMES` + `McpToolCaller` + `HistoricalDataParams` (`kiteClient.ts`); `computeKiteChecksum`/`captureRequestToken`/`exchangeAccessToken` (`kiteOAuth.ts`); `KiteSessionState`/`classifyKiteResponse` (`kiteSessionState.ts`); `EXPECTED_KITE_TOOLS`/`diffToolList`/`checkKiteToolDrift`/`DriftResult`/`ToolListing` (`mcpDriftMonitor.ts`); `toToolCaller`/`toToolListing` (`mcpClientAdapter.ts`); `fetchAndArchive`/`parseKiteCandles`/`INTERVAL_LOOKBACK_HINT_DAYS`/`FetchAndArchiveDeps`/`FetchAndArchiveParams`/`RawKiteCandle` (`historicalDataArchive.ts`).
- Intra-group specifiers that do NOT change (all same-directory now): `mcpDriftMonitor.ts`→`./kiteClient`, `mcpClientAdapter.ts`→`./kiteClient` & `./mcpDriftMonitor`, `historicalDataArchive.ts`→`./kiteClient`.

- [ ] **Step 1: Create directories and move files**

```bash
mkdir -p src/main/services/kite test/main/services/kite
git mv src/main/kiteClient.ts src/main/services/kite/kiteClient.ts
git mv src/main/kiteOAuth.ts src/main/services/kite/kiteOAuth.ts
git mv src/main/kiteSessionState.ts src/main/services/kite/kiteSessionState.ts
git mv src/main/mcpDriftMonitor.ts src/main/services/kite/mcpDriftMonitor.ts
git mv src/main/mcpClientAdapter.ts src/main/services/kite/mcpClientAdapter.ts
git mv src/main/historicalDataArchive.ts src/main/services/kite/historicalDataArchive.ts
git mv src/main/kiteClient.test.ts test/main/services/kite/kiteClient.test.ts
git mv src/main/kiteOAuth.test.ts test/main/services/kite/kiteOAuth.test.ts
git mv src/main/kiteSessionState.test.ts test/main/services/kite/kiteSessionState.test.ts
git mv src/main/mcpDriftMonitor.test.ts test/main/services/kite/mcpDriftMonitor.test.ts
git mv src/main/mcpClientAdapter.test.ts test/main/services/kite/mcpClientAdapter.test.ts
git mv src/main/historicalDataArchive.test.ts test/main/services/kite/historicalDataArchive.test.ts
```

- [ ] **Step 2: Fix cross-directory specifiers inside the moved sources**

`src/main/services/kite/kiteSessionState.ts` — its rendererApi import (set to `./ipc/rendererApi` in Task 3) now needs two levels up:

Old:

```ts
import type { BannerEvent, KiteSessionStatus } from "./ipc/rendererApi";
```

New:

```ts
import type { BannerEvent, KiteSessionStatus } from "../../ipc/rendererApi";
```

`src/main/services/kite/historicalDataArchive.ts` — its sidecar imports (set to `./services/sidecar/...` in Task 4) are now siblings under `services/`:

Old:

```ts
import type { SidecarSupervisor } from "./services/sidecar/sidecarSupervisor";
import type { CandleWire } from "./services/sidecar/sidecarProtocol";
```

New:

```ts
import type { SidecarSupervisor } from "../sidecar/sidecarSupervisor";
import type { CandleWire } from "../sidecar/sidecarProtocol";
```

(`kiteClient.ts`, `kiteOAuth.ts` have no internal imports; `mcpDriftMonitor.ts`, `mcpClientAdapter.ts`, and `historicalDataArchive.ts`'s `./kiteClient` are all same-directory — no change.)

- [ ] **Step 3: Repath the cross-group importers still outside `services/kite/`**

`src/main/claudeProvider.ts` (still flat this task) — change:

Old:

```ts
import { KITE_READ_TOOL_NAMES, KITE_WRITE_TOOL_NAMES } from "./kiteClient";
```

New:

```ts
import { KITE_READ_TOOL_NAMES, KITE_WRITE_TOOL_NAMES } from "./services/kite/kiteClient";
```

`src/main/bootstrap.ts` — change:

Old:

```ts
import { KiteSessionState } from "./kiteSessionState";
```

New:

```ts
import { KiteSessionState } from "./services/kite/kiteSessionState";
```

- [ ] **Step 4: Repath the relocated tests**

`test/main/services/kite/kiteClient.test.ts` (line 2):

```ts
import { KiteClient, KITE_READ_TOOL_NAMES, KITE_WRITE_TOOL_NAMES } from "../../../../src/main/services/kite/kiteClient";
```

`test/main/services/kite/kiteOAuth.test.ts` (line 3):

```ts
import { captureRequestToken, computeKiteChecksum, exchangeAccessToken } from "../../../../src/main/services/kite/kiteOAuth";
```

`test/main/services/kite/kiteSessionState.test.ts` (line 2):

```ts
import { KiteSessionState, classifyKiteResponse } from "../../../../src/main/services/kite/kiteSessionState";
```

`test/main/services/kite/mcpDriftMonitor.test.ts` (line 2):

```ts
import { EXPECTED_KITE_TOOLS, checkKiteToolDrift, diffToolList } from "../../../../src/main/services/kite/mcpDriftMonitor";
```

`test/main/services/kite/mcpClientAdapter.test.ts` (line 2):

```ts
import { toToolCaller, toToolListing } from "../../../../src/main/services/kite/mcpClientAdapter";
```

`test/main/services/kite/historicalDataArchive.test.ts` (lines 2–4):

```ts
import { fetchAndArchive, parseKiteCandles } from "../../../../src/main/services/kite/historicalDataArchive";
import { KiteClient } from "../../../../src/main/services/kite/kiteClient";
import type { CandleWire } from "../../../../src/main/services/sidecar/sidecarProtocol";
```

- [ ] **Step 5: Repath the e2e test's Kite imports**

`test/endToEnd.integration.test.ts` — change lines 6 and 8 (the sidecar import was already fixed in Task 4):

Old:

```ts
import { KiteClient } from "../src/main/kiteClient";
...
import { fetchAndArchive } from "../src/main/historicalDataArchive";
```

New:

```ts
import { KiteClient } from "../src/main/services/kite/kiteClient";
...
import { fetchAndArchive } from "../src/main/services/kite/historicalDataArchive";
```

- [ ] **Step 6: Type-check and run the suite**

```bash
npx tsc --noEmit
npx vitest run
```

Expected: `tsc --noEmit` clean; `vitest run` `11 passed` / `34 passed` (all five relocated Kite unit tests plus the e2e test run from their new import paths).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(electron-app): move kite modules into services/kite/"
```

---

## Task 6: Move the Claude provider into `services/claude/` and relocate the window test

**Files:**
- Move: `src/main/claudeProvider.ts` → `src/main/services/claude/claudeProvider.ts`
- Move: `src/main/claudeProvider.test.ts` → `test/main/services/claude/claudeProvider.test.ts`
- Move: `src/main/mainWindow.test.ts` → `test/main/mainWindow.test.ts` (source `mainWindow.ts` stays at `src/main/`)

**Interfaces:**
- Produces: `KITE_READ_TOOL_ALLOWLIST`/`KITE_WRITE_TOOL_DENYLIST`/`buildClaudeArgs`/`spawnClaude` at `src/main/services/claude/claudeProvider.ts`.
- After this task, no `*.test.ts` remains under `src/`.

- [ ] **Step 1: Create directories and move files**

```bash
mkdir -p src/main/services/claude test/main/services/claude test/main
git mv src/main/claudeProvider.ts src/main/services/claude/claudeProvider.ts
git mv src/main/claudeProvider.test.ts test/main/services/claude/claudeProvider.test.ts
git mv src/main/mainWindow.test.ts test/main/mainWindow.test.ts
```

- [ ] **Step 2: Fix `claudeProvider.ts`'s kiteClient import for its new location**

In Task 5 this line became `./services/kite/kiteClient` while the file was flat; from `services/claude/` the Kite client is a sibling under `services/`. In `src/main/services/claude/claudeProvider.ts`:

Old:

```ts
import { KITE_READ_TOOL_NAMES, KITE_WRITE_TOOL_NAMES } from "./services/kite/kiteClient";
```

New:

```ts
import { KITE_READ_TOOL_NAMES, KITE_WRITE_TOOL_NAMES } from "../kite/kiteClient";
```

- [ ] **Step 3: Repath the relocated tests**

`test/main/services/claude/claudeProvider.test.ts` — change lines 2–3:

Old:

```ts
import { KITE_READ_TOOL_NAMES, KITE_WRITE_TOOL_NAMES } from "./kiteClient";
import { KITE_READ_TOOL_ALLOWLIST, KITE_WRITE_TOOL_DENYLIST, buildClaudeArgs, spawnClaude } from "./claudeProvider";
```

New:

```ts
import { KITE_READ_TOOL_NAMES, KITE_WRITE_TOOL_NAMES } from "../../../../src/main/services/kite/kiteClient";
import { KITE_READ_TOOL_ALLOWLIST, KITE_WRITE_TOOL_DENYLIST, buildClaudeArgs, spawnClaude } from "../../../../src/main/services/claude/claudeProvider";
```

`test/main/mainWindow.test.ts` — change line 2:

Old:

```ts
import { mainWindowOptions } from "./mainWindow";
```

New:

```ts
import { mainWindowOptions } from "../../src/main/mainWindow";
```

- [ ] **Step 4: Type-check and run the suite**

```bash
npx tsc --noEmit
npx vitest run
```

Expected: `tsc --noEmit` clean; `vitest run` `11 passed` / `34 passed`. `src/main/` now contains only source: `main.ts`, `bootstrap.ts`, `mainWindow.ts`, `ipc/`, `services/`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(electron-app): move claude provider into services/claude/ and relocate window test"
```

---

## Task 7: Point Vitest at `test/`, prove no tests under `src/`, and run full verification

**Files:**
- Modify: `electron-app/vitest.config.ts`

**Interfaces:**
- Consumes: the final directory layout from Tasks 3–6.
- Produces: nothing new; this task is the acceptance gate.

- [ ] **Step 1: Narrow Vitest discovery to the `test/` tree**

Replace `electron-app/vitest.config.ts` with exactly:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: Prove nothing under `src/` is a test file**

```bash
find src -name '*.test.ts'
```

Expected: no output (empty). If any path prints, that file was missed in Tasks 3–6 — relocate it before continuing.

- [ ] **Step 3: Ensure the real Rust sidecar binary exists (rebuild only if missing)**

The e2e test spawns `rust-core/target/debug/sidecar` and skips itself if absent. The Rust code is untouched by this plan; only build the binary if it is missing.

```bash
test -x ../rust-core/target/debug/sidecar && echo "sidecar present" || (cd ../rust-core && cargo build --bin sidecar)
```

Expected: `sidecar present`, or a successful `cargo build` producing `../rust-core/target/debug/sidecar`.

- [ ] **Step 4: Full type-check and full test run (incl. e2e against the real sidecar)**

```bash
npx tsc --noEmit
npx vitest run
```

Expected: `tsc --noEmit` clean; `vitest run` reports `Test Files 11 passed`, `Tests 34 passed`, and the e2e case `end-to-end: fetch -> archive -> compute` runs (not skipped) and passes.

- [ ] **Step 5: Production build + confirm preload is still CommonJS (sandbox posture)**

```bash
npx electron-vite build
ls out/preload/
grep -nE "require\(|module\.exports|Object\.defineProperty\(exports" out/preload/preload.js
grep -nEc "^\s*(import|export) " out/preload/preload.js
```

Expected: build succeeds; `out/preload/` holds `preload.js` (no `.mjs`); the first grep matches (CommonJS markers present); the second grep prints `0` (no top-level ESM). This confirms the sandbox-safe preload after the full restructure.

- [ ] **Step 6: Confirm the locked security posture**

```bash
npx vitest run test/main/mainWindow.test.ts
```

Expected: passes — it asserts `contextIsolation === true`, `sandbox === true`, `nodeIntegration === false`, and the injected preload path. Together with Step 5's CommonJS proof, this discharges the Global-Constraint security check.

- [ ] **Step 7: Dev smoke check (real window), then stop the process**

The machine has a real display, so `electron-vite dev` can open a window. Run it in the foreground:

```bash
npx electron-vite dev
```

Expected within a few seconds:
- the terminal prints the Vite dev-server address (e.g. `Local:   http://localhost:5173/`) and starts Electron with no crash/stack trace;
- an Electron window titled "Trade Assistant" opens and its body shows `sidecar: <status> | kite: <status>` (the renderer loaded from the dev server via `ELECTRON_RENDERER_URL` and called `getStatus()` over IPC).

Then STOP it: press `Ctrl+C` in that terminal and confirm the window closes and the process exits. If any process lingers, run:

```bash
pkill -f electron-vite || true
```

Do not leave the dev process running.

- [ ] **Step 8: Commit**

```bash
git add vitest.config.ts
git commit -m "test(electron-app): point vitest at test/ tree and verify full refactor"
```

---

## Acceptance Criteria (whole plan)

- `npx electron-vite build` succeeds; `out/preload/preload.js` is CommonJS (no `.mjs`, no top-level `import`/`export`).
- `npx tsc --noEmit` is clean over `src/` (source; `*.test.ts` stays excluded, as today); `npx vitest run` executes and validates the `test/` tree.
- `npx vitest run` passes all 34 tests across 11 files (10 relocated unit tests + 1 e2e), discovering only `test/**/*.test.ts`; `find src -name '*.test.ts'` is empty.
- `npx electron-vite dev` brings up the app and renders the status line, then stops cleanly.
- `contextIsolation`/`sandbox`/`nodeIntegration` posture unchanged (asserted by `mainWindow.test.ts` + CommonJS preload proof).
- No Rust changes; no behavior change; `driftWarning` remains declared-but-unwired; the safety-critical logic of `kiteClient.ts`/`claudeProvider.ts`/`mcpDriftMonitor.ts` changed only in file location and import paths.
