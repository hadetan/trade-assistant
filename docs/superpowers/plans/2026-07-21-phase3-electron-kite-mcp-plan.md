# Phase 3 — Electron Shell + Kite MCP Integration + Safety Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the first Electron/TypeScript process, supervise the existing Rust sidecar over its JSON-stdio protocol, and make the design's three-layer "never places an order" safety model real, testable code — so the app can log into Kite, fetch real quotes/candles through a read-only-by-construction MCP wrapper, persist every fetched candle into the Phase 1 Parquet lake, and get back algorithm results/confluence.

**Architecture:** Electron main process (TypeScript) owns every network/credential boundary (Kite MCP connection, `claude` subprocess, OAuth) and supervises a single Rust `sidecar` child process, speaking newline-delimited JSON correlated by request `id`. The renderer is a minimal, sandboxed status page — no chat UI, no markdown rendering (Phase 5). Storage stays owned by Rust: the sidecar's stdio protocol is extended in this phase with a `persist_candles` request so live Kite candles reach the existing `CandleStore` without TypeScript ever touching the Parquet lake directly. Safety is enforced structurally, not by prose: the Kite wrapper class exposes only read methods (no write method exists to call), every `claude` invocation carries the write-tool denylist plus `--strict-mcp-config`, and a `tools/list` drift monitor watches the remote surface.

**Tech Stack:** Electron 33, TypeScript 5.7 (CommonJS output), Vitest 2.1 (unit/integration), `@modelcontextprotocol/sdk` 1.12 (Streamable-HTTP MCP client), Node built-ins (`http`, `crypto`, `child_process`, `readline`). Rust side: existing `sidecar` + `storage` + `algo-core` crates, `serde`/`serde_json`, DuckDB-backed `CandleStore`.

## Global Constraints

These apply to **every** task below. Each task's requirements implicitly include this section.

**Coding conventions (from `CLAUDE.md`, verbatim):**
- **Comments:** default to no comments. Only add one when the *why* isn't obvious from the code itself: a non-obvious invariant, a workaround for a specific upstream bug, a formula's source. Never write a comment that just restates what the next line does, and never write a numbered "1. do X, 2. do Y" comment block above a function.
- **TypeScript naming:** `camelCase` functions/variables, `PascalCase` types/classes, no Hungarian notation, no abbreviations that aren't already standard in this codebase's domain (`oi`, `pcr`, `ltp` are fine — they're Kite/options-market terms used throughout the design doc).
- **Rust naming:** `snake_case` functions/variables, `PascalCase` types, one clear responsibility per file.
- **File names describe what the file is responsible for, not what kind of file it is** (`confluence.rs`, not `utils.rs` or `helpers.rs`; `kiteClient.ts`, not `apiUtils.ts`). No `utils.ts`/`helpers.ts`.
- **Small, focused files over large ones.** If a file starts doing two unrelated things, split it. Pure logic (no I/O) lives separately from I/O/side-effecting code.

**Wire-protocol naming exception:** TypeScript interfaces that mirror the Rust sidecar's `serde` JSON contract keep the Rust field names (`snake_case`: `algo_results`, `bullish_count`, `algo_id`) so the JSON on the wire matches byte-for-byte. This is the one place `snake_case` is correct in TS, and it must carry a one-line "mirrors the Rust serde contract" comment (a legitimate non-obvious *why*).

**Git / commit rules (inherited by every implementer subagent):**
- Every commit is authored by `hadetan <aquibsyed83@gmail.com>`. The repo's git config is already set to this author — **do not pass `--author` and do not add a `Co-Authored-By` trailer.**
- **Never use `--no-verify`.** Hooks run on every commit.
- Commit messages follow Conventional Commits (`feat:`, `test:`, `fix:`, `chore:`, `docs:`).

**Security posture (§8.2, non-negotiable from the first commit — never retrofitted):**
- Every `BrowserWindow`: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- The renderer reaches the main process only through `contextBridge.exposeInMainWorld` backed by named `ipcRenderer.invoke`/`ipcMain.handle` wrappers. The raw `ipcRenderer` module is never exposed.
- The renderer has no network access to Kite, ever — all outbound Kite/MCP/`claude` calls are funneled through main.

**The hard non-negotiable (§2, §4):** the app never places, modifies, cancels, or automates any order. No method, code path, button, or "human-confirmed send" flow for this exists anywhere. This is enforced by three independent layers (Task 5 = layer 1 method-absence, Task 7 = layer 2 CLI denylist, Task 6 = layer 3 drift detection), each with a test that fails loudly if the guarantee regresses.

**Networking crate rule (§11):** any *Rust* networking dependency uses `rustls`, never `native-tls`/`openssl`. Phase 3 adds no new Rust networking (all network I/O is in Node/Electron main), so this is a no-op here but stated so no task introduces `openssl` by reflex.

**Empirical-validation rule (§14, item 2):** Kite's per-interval historical lookback caps are **not** hardcoded from community-sourced numbers as authoritative. Where a cap value is needed (Task 9) it is a clearly-labeled unverified hint plus a manual verification step against the live API, not a trusted constant.

---

## File Structure

New Electron app under `electron-app/` (does not exist yet — Task 1 scaffolds it). One extended Rust crate (`sidecar`).

**Rust (extended):**
- `rust-core/crates/sidecar/Cargo.toml` — add `storage` dependency.
- `rust-core/crates/sidecar/src/protocol.rs` — add `PersistCandlesRequest`, `CandleWire`, `PersistCandlesResponse`, and the tagged `SidecarRequest`/`SidecarResponse` enums; `encode_response` takes `&SidecarResponse`.
- `rust-core/crates/sidecar/src/handlers.rs` — add `handle_persist`.
- `rust-core/crates/sidecar/src/main.rs` — parse `--lake-root`, open `CandleStore`, route by request type.

**Electron main (`electron-app/src/main/`):**
- `mainWindow.ts` — pure `mainWindowOptions(preloadPath)` returning secure `BrowserWindowConstructorOptions`.
- `rendererApi.ts` — pure `buildRendererApi(invoke, subscribe)` factory (the exact surface exposed to the renderer).
- `preload.ts` — wires `rendererApi` to `contextBridge`/`ipcRenderer` (thin, electron-only, manually verified).
- `sidecarProtocol.ts` — TS mirror of the Rust wire types + line framing helpers.
- `sidecarSupervisor.ts` — spawns/supervises the sidecar binary; `compute`/`persistCandles`.
- `kiteClient.ts` — read-only-by-construction MCP wrapper (safety layer 1).
- `mcpDriftMonitor.ts` — `tools/list` diff (safety layer 3).
- `claudeProvider.ts` — `claude` subprocess scaffolding with the denylist flags (safety layer 2). **Scaffolding only — no persona pipeline (Phase 4).**
- `kiteOAuth.ts` — loopback-server request-token capture + checksum + access-token exchange.
- `kiteSessionState.ts` — daily-session-expiry classification + banner state (§5.1).
- `historicalDataArchive.ts` — the single fetch-and-archive chokepoint (§10.2): fetch via `kiteClient`, persist every candle via the sidecar, return closes.
- `appBridge.ts` — `ipcMain.handle` wiring + startup orchestration (electron-only, manually verified).
- `main.ts` — Electron entry (electron-only, manually verified).

**Electron renderer (`electron-app/src/renderer/`):**
- `index.html` — minimal status page shell.
- `status.ts` — renders sidecar/Kite/drift banners from the bridge (no markdown).

**Tests** are colocated as `*.test.ts` next to each module (Vitest default glob).

---

## Task 1: Electron scaffold + secure window factory

**Files:**
- Create: `electron-app/package.json`
- Create: `electron-app/tsconfig.json`
- Create: `electron-app/vitest.config.ts`
- Create: `electron-app/.gitignore`
- Create: `electron-app/src/main/mainWindow.ts`
- Create: `electron-app/src/main/rendererApi.ts`
- Create: `electron-app/src/main/preload.ts`
- Create: `electron-app/src/main/main.ts`
- Create: `electron-app/src/renderer/index.html`
- Create: `electron-app/src/renderer/status.ts`
- Test: `electron-app/src/main/mainWindow.test.ts`
- Test: `electron-app/src/main/rendererApi.test.ts`

**Interfaces:**
- Produces:
  - `mainWindowOptions(preloadPath: string): Electron.BrowserWindowConstructorOptions` (in `mainWindow.ts`) — always `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webPreferences.preload = preloadPath`.
  - `buildRendererApi(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>, subscribe: (channel: string, handler: (payload: unknown) => void) => void): RendererApi` (in `rendererApi.ts`) where `RendererApi = { getStatus(): Promise<AppStatus>; onBanner(handler: (banner: BannerEvent) => void): void }`.
  - Types `AppStatus`, `BannerEvent` (in `rendererApi.ts`), consumed by Tasks 9–10.

- [ ] **Step 1: Create `electron-app/package.json`**

```json
{
  "name": "trade-assistant-app",
  "version": "0.1.0",
  "private": true,
  "description": "Trade Assistant Electron shell (read-only analysis; never places orders).",
  "main": "dist/main/main.js",
  "scripts": {
    "build": "tsc && node -e \"const fs=require('fs');fs.mkdirSync('dist/renderer',{recursive:true});fs.copyFileSync('src/renderer/index.html','dist/renderer/index.html')\"",
    "test": "vitest run",
    "start": "npm run build && electron ."
  },
  "devDependencies": {
    "@modelcontextprotocol/sdk": "1.12.0",
    "@types/node": "22.10.0",
    "electron": "33.2.0",
    "typescript": "5.7.2",
    "vitest": "2.1.8"
  }
}
```

- [ ] **Step 2: Create `electron-app/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2022", "DOM"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts", "node_modules", "dist"]
}
```

- [ ] **Step 3: Create `electron-app/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Create `electron-app/.gitignore`**

```gitignore
node_modules/
dist/
```

- [ ] **Step 5: Write the failing test for `rendererApi.ts`**

`electron-app/src/main/rendererApi.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { buildRendererApi } from "./rendererApi";

describe("buildRendererApi", () => {
  it("exposes exactly getStatus and onBanner, and never leaks the raw transport", () => {
    const invoke = vi.fn().mockResolvedValue({ sidecar: "up" });
    const subscribe = vi.fn();
    const api = buildRendererApi(invoke, subscribe);

    expect(Object.keys(api).sort()).toEqual(["getStatus", "onBanner"]);
    expect((api as Record<string, unknown>).ipcRenderer).toBeUndefined();
    expect((api as Record<string, unknown>).invoke).toBeUndefined();
  });

  it("routes getStatus through the injected invoke on the status:get channel", async () => {
    const invoke = vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null });
    const api = buildRendererApi(invoke, vi.fn());

    const status = await api.getStatus();

    expect(invoke).toHaveBeenCalledWith("status:get");
    expect(status.sidecar).toBe("up");
  });

  it("registers onBanner against the banner subscribe channel", () => {
    const subscribe = vi.fn();
    const api = buildRendererApi(vi.fn(), subscribe);
    const handler = vi.fn();

    api.onBanner(handler);

    expect(subscribe).toHaveBeenCalledWith("banner:push", handler);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd electron-app && npx vitest run src/main/rendererApi.test.ts`
Expected: FAIL — `Cannot find module './rendererApi'` (or "buildRendererApi is not a function").

- [ ] **Step 7: Implement `electron-app/src/main/rendererApi.ts`**

```typescript
export type SidecarStatus = "up" | "down" | "restarting";
export type KiteSessionStatus = "authenticated" | "needsLogin" | "unknown";

export interface AppStatus {
  sidecar: SidecarStatus;
  kiteSession: KiteSessionStatus;
  driftWarning: string | null;
}

export type BannerKind = "kiteLogin" | "mcpDrift" | "sidecarDown";

export interface BannerEvent {
  kind: BannerKind;
  message: string;
}

export interface RendererApi {
  getStatus(): Promise<AppStatus>;
  onBanner(handler: (banner: BannerEvent) => void): void;
}

export function buildRendererApi(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  subscribe: (channel: string, handler: (payload: unknown) => void) => void,
): RendererApi {
  return {
    getStatus: () => invoke("status:get") as Promise<AppStatus>,
    onBanner: (handler) => subscribe("banner:push", handler as (payload: unknown) => void),
  };
}
```

- [ ] **Step 8: Write the failing test for `mainWindow.ts`**

`electron-app/src/main/mainWindow.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { mainWindowOptions } from "./mainWindow";

describe("mainWindowOptions", () => {
  it("locks the security posture on for every window", () => {
    const options = mainWindowOptions("/abs/path/preload.js");

    expect(options.webPreferences?.contextIsolation).toBe(true);
    expect(options.webPreferences?.sandbox).toBe(true);
    expect(options.webPreferences?.nodeIntegration).toBe(false);
    expect(options.webPreferences?.preload).toBe("/abs/path/preload.js");
  });
});
```

- [ ] **Step 9: Run test to verify it fails**

Run: `cd electron-app && npx vitest run src/main/mainWindow.test.ts`
Expected: FAIL — `Cannot find module './mainWindow'`.

- [ ] **Step 10: Implement `electron-app/src/main/mainWindow.ts`**

```typescript
import type { BrowserWindowConstructorOptions } from "electron";

export function mainWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 900,
    height: 640,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  };
}
```

- [ ] **Step 11: Create the thin electron-only wiring files (not unit-tested; manually verified in Task 10)**

`electron-app/src/main/preload.ts`:

```typescript
import { contextBridge, ipcRenderer } from "electron";
import { buildRendererApi } from "./rendererApi";

const api = buildRendererApi(
  (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  (channel, handler) => {
    ipcRenderer.on(channel, (_event, payload) => handler(payload));
  },
);

contextBridge.exposeInMainWorld("tradeAssistant", api);
```

`electron-app/src/main/main.ts`:

```typescript
import { app, BrowserWindow } from "electron";
import path from "node:path";
import { mainWindowOptions } from "./mainWindow";

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow(mainWindowOptions(path.join(__dirname, "preload.js")));
  window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  return window;
}

app.whenReady().then(() => {
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

`electron-app/src/renderer/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; object-src 'none'" />
    <title>Trade Assistant</title>
  </head>
  <body>
    <h1>Trade Assistant</h1>
    <div id="status">Loading…</div>
    <div id="banners"></div>
    <script src="./status.js"></script>
  </body>
</html>
```

`electron-app/src/renderer/status.ts`:

```typescript
const api = (window as unknown as { tradeAssistant: import("../main/rendererApi").RendererApi }).tradeAssistant;

async function render(): Promise<void> {
  const status = await api.getStatus();
  const el = document.getElementById("status");
  if (el) el.textContent = `sidecar: ${status.sidecar} | kite: ${status.kiteSession}`;
}

api.onBanner((banner) => {
  const el = document.getElementById("banners");
  if (!el) return;
  const line = document.createElement("div");
  line.textContent = `[${banner.kind}] ${banner.message}`;
  el.appendChild(line);
});

render();
```

- [ ] **Step 12: Install dependencies and run the full suite**

Run: `cd electron-app && npm install && npx vitest run`
Expected: PASS — 4 tests across `rendererApi.test.ts` and `mainWindow.test.ts`.

- [ ] **Step 13: Verify the TypeScript build compiles**

Run: `cd electron-app && npx tsc --noEmit`
Expected: exit code 0, no output.

- [ ] **Step 14: Commit**

```bash
git add electron-app/package.json electron-app/package-lock.json electron-app/tsconfig.json electron-app/vitest.config.ts electron-app/.gitignore electron-app/src
git commit -m "feat(electron): scaffold secure Electron shell with contextIsolation/sandbox from first commit"
```

---

## Task 2: Extend the Rust sidecar protocol to persist live candles

Rationale: the design's ownership table (§3) makes the Rust sidecar the sole owner of the candle store; TypeScript must never open the Parquet lake. The current stdio protocol is compute-only (`ComputeRequest` → `ComputeResponse`) and the `sidecar` crate does not even depend on `storage`. To satisfy §10.2 ("every candle fetched from live Kite is also written into the `CandleStore`"), the protocol gains a second request type — `persist_candles` — routed to `CandleStore::write_sourced_candles(symbol, timeframe, "kite", …)`.

**Files:**
- Modify: `rust-core/crates/sidecar/Cargo.toml`
- Modify: `rust-core/crates/sidecar/src/protocol.rs`
- Modify: `rust-core/crates/sidecar/src/handlers.rs`
- Modify: `rust-core/crates/sidecar/src/main.rs`

**Interfaces:**
- Consumes: existing `handle_request(ComputeRequest) -> ComputeResponse` (`handlers.rs`); `storage::{Candle, CandleStore}`.
- Produces (the wire contract Task 3's `sidecarProtocol.ts` mirrors verbatim):
  - Request enum tag `"type"`: `"compute"` carries `{ id: u64, symbol, timeframe, closes: [f64] }`; `"persist_candles"` carries `{ id: u64, symbol, timeframe, source, candles: [{ ts: i64, open, high, low, close, volume: i64 }] }`.
  - Response enum tag `"type"`: `"compute"` carries `{ id, algo_results, confluence }` (unchanged fields); `"persist_candles"` carries `{ id, written: usize, error?: string }`.
  - `handle_persist(store: &CandleStore, request: PersistCandlesRequest) -> PersistCandlesResponse`.

- [ ] **Step 1: Add the `storage` dependency**

Edit `rust-core/crates/sidecar/Cargo.toml`, under `[dependencies]`, add:

```toml
storage = { path = "../storage" }
```

- [ ] **Step 2: Write the failing protocol test**

In `rust-core/crates/sidecar/src/protocol.rs`, replace the existing `#[cfg(test)] mod tests { … }` block with:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_response_wraps_as_a_tagged_compute_response_carrying_the_id() {
        let response = SidecarResponse::Compute(empty_response(99));
        let line = encode_response(&response);
        assert!(line.contains("\"id\":99"));
        assert!(line.contains("\"type\":\"compute\""));
        assert!(!line.contains('\n'));
    }

    #[test]
    fn parses_a_tagged_compute_request() {
        let line = r#"{"type":"compute","id":5,"symbol":"NSE:INFY","timeframe":"day","closes":[1.0,2.0]}"#;
        match parse_request(line).unwrap() {
            SidecarRequest::Compute(request) => {
                assert_eq!(request.id, 5);
                assert_eq!(request.closes, vec![1.0, 2.0]);
            }
            _ => panic!("expected a compute request"),
        }
    }

    #[test]
    fn parses_a_tagged_persist_candles_request() {
        let line = r#"{"type":"persist_candles","id":6,"symbol":"NSE:INFY","timeframe":"day","source":"kite","candles":[{"ts":1710000000,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100}]}"#;
        match parse_request(line).unwrap() {
            SidecarRequest::PersistCandles(request) => {
                assert_eq!(request.id, 6);
                assert_eq!(request.source, "kite");
                assert_eq!(request.candles.len(), 1);
                assert_eq!(request.candles[0].volume, 100);
            }
            _ => panic!("expected a persist_candles request"),
        }
    }

    #[test]
    fn persist_response_omits_error_field_when_none() {
        let response = SidecarResponse::PersistCandles(PersistCandlesResponse {
            id: 6,
            written: 1,
            error: None,
        });
        let line = encode_response(&response);
        assert!(line.contains("\"type\":\"persist_candles\""));
        assert!(line.contains("\"written\":1"));
        assert!(!line.contains("error"));
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd rust-core && cargo test -p sidecar --lib protocol`
Expected: FAIL — compile errors (`SidecarRequest`, `SidecarResponse`, `PersistCandlesResponse`, `parse_request` return type unknown).

- [ ] **Step 4: Implement the protocol changes**

In `rust-core/crates/sidecar/src/protocol.rs`, add the new types and change `parse_request`/`encode_response`. Keep the existing `ComputeRequest`, `AlgoResultWire`, `ConfluenceWire`, `ComputeResponse`, and `empty_response` exactly as they are. Add:

```rust
#[derive(Debug, Deserialize)]
pub struct CandleWire {
    pub ts: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: i64,
}

#[derive(Debug, Deserialize)]
pub struct PersistCandlesRequest {
    pub id: u64,
    pub symbol: String,
    pub timeframe: String,
    pub source: String,
    pub candles: Vec<CandleWire>,
}

#[derive(Debug, Serialize)]
pub struct PersistCandlesResponse {
    pub id: u64,
    pub written: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarRequest {
    Compute(ComputeRequest),
    PersistCandles(PersistCandlesRequest),
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarResponse {
    Compute(ComputeResponse),
    PersistCandles(PersistCandlesResponse),
}
```

Then change the two free functions:

```rust
pub fn parse_request(line: &str) -> serde_json::Result<SidecarRequest> {
    serde_json::from_str(line)
}

pub fn encode_response(response: &SidecarResponse) -> String {
    serde_json::to_string(response).expect("SidecarResponse always serializes")
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd rust-core && cargo test -p sidecar --lib protocol`
Expected: PASS — 4 protocol tests.

- [ ] **Step 6: Write the failing `handle_persist` test**

In `rust-core/crates/sidecar/src/handlers.rs`, append to the existing `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn handle_persist_writes_candles_that_read_back_from_the_kite_source() {
        use storage::CandleStore;
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        let store = CandleStore::open(dir.path()).unwrap();

        let request = crate::protocol::PersistCandlesRequest {
            id: 11,
            symbol: "NSE:INFY".to_string(),
            timeframe: "day".to_string(),
            source: "kite".to_string(),
            candles: vec![crate::protocol::CandleWire {
                ts: 1_710_000_000,
                open: 1.0,
                high: 2.0,
                low: 0.5,
                close: 1.5,
                volume: 100,
            }],
        };

        let response = handle_persist(&store, request);

        assert_eq!(response.id, 11);
        assert_eq!(response.written, 1);
        assert!(response.error.is_none());

        let stored = store.read_sourced_candles("NSE:INFY", "day", "kite").unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].close, 1.5);
    }
```

Add `tempfile` to `rust-core/crates/sidecar/Cargo.toml` under a `[dev-dependencies]` section if not already present:

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd rust-core && cargo test -p sidecar --lib handlers::tests::handle_persist_writes`
Expected: FAIL — `handle_persist` not found.

- [ ] **Step 8: Implement `handle_persist`**

In `rust-core/crates/sidecar/src/handlers.rs`, update the top `use` line and add the function above the `#[cfg(test)]` block:

```rust
use crate::protocol::{AlgoResultWire, ComputeRequest, ComputeResponse, ConfluenceWire, PersistCandlesRequest, PersistCandlesResponse};
use storage::{Candle, CandleStore};
```

```rust
pub fn handle_persist(store: &CandleStore, request: PersistCandlesRequest) -> PersistCandlesResponse {
    let candles: Vec<Candle> = request
        .candles
        .iter()
        .map(|c| Candle {
            ts: c.ts,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
        })
        .collect();

    match store.write_sourced_candles(&request.symbol, &request.timeframe, &request.source, &candles) {
        Ok(()) => PersistCandlesResponse { id: request.id, written: candles.len(), error: None },
        Err(e) => PersistCandlesResponse { id: request.id, written: 0, error: Some(e.to_string()) },
    }
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `cd rust-core && cargo test -p sidecar --lib handlers::tests::handle_persist_writes`
Expected: PASS.

- [ ] **Step 10: Update `main.rs` to parse `--lake-root`, open the store, and route by type**

Replace the body of `rust-core/crates/sidecar/src/main.rs` with:

```rust
use sidecar::handlers::{handle_persist, handle_request};
use sidecar::protocol::{
    empty_response, encode_response, parse_request, PersistCandlesResponse, SidecarRequest, SidecarResponse,
};
use std::io::{self, BufRead, Write};
use std::panic::{self, AssertUnwindSafe};
use std::path::PathBuf;
use storage::CandleStore;

fn lake_root_from_args() -> Option<PathBuf> {
    let mut args = std::env::args();
    while let Some(arg) = args.next() {
        if arg == "--lake-root" {
            return args.next().map(PathBuf::from);
        }
    }
    None
}

/// This process is a long-lived sidecar: Electron spawns one instance and
/// drives it for a whole session. A single malformed-but-well-typed request
/// (e.g. a compute algorithm panicking on an edge case we didn't anticipate)
/// must never take the whole loop down with it -- so every per-request call
/// is isolated with `catch_unwind`.
fn main() {
    let store = lake_root_from_args()
        .and_then(|root| CandleStore::open(&root).ok());

    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = line.expect("stdin must be readable");
        if line.trim().is_empty() {
            continue;
        }

        let request = match parse_request(&line) {
            Ok(request) => request,
            Err(_) => continue,
        };

        let response = match request {
            SidecarRequest::Compute(compute) => {
                let id = compute.id;
                let result = panic::catch_unwind(AssertUnwindSafe(|| handle_request(compute)));
                match result {
                    Ok(response) => SidecarResponse::Compute(response),
                    Err(_) => {
                        eprintln!("sidecar: compute request {id} panicked; returning an empty response");
                        SidecarResponse::Compute(empty_response(id))
                    }
                }
            }
            SidecarRequest::PersistCandles(persist) => {
                let id = persist.id;
                match store.as_ref() {
                    Some(store) => {
                        let result = panic::catch_unwind(AssertUnwindSafe(|| handle_persist(store, persist)));
                        match result {
                            Ok(response) => SidecarResponse::PersistCandles(response),
                            Err(_) => {
                                eprintln!("sidecar: persist request {id} panicked");
                                SidecarResponse::PersistCandles(PersistCandlesResponse {
                                    id,
                                    written: 0,
                                    error: Some("persist panicked".to_string()),
                                })
                            }
                        }
                    }
                    None => SidecarResponse::PersistCandles(PersistCandlesResponse {
                        id,
                        written: 0,
                        error: Some("no --lake-root configured".to_string()),
                    }),
                }
            }
        };

        writeln!(stdout, "{}", encode_response(&response)).expect("stdout must be writable");
        stdout.flush().expect("stdout must flush");
    }
}
```

- [ ] **Step 11: Run the whole sidecar suite and build the binary**

Run: `cd rust-core && cargo test -p sidecar && cargo build -p sidecar`
Expected: PASS — all protocol/handler tests green; `target/debug/sidecar` builds.

- [ ] **Step 12: Manually confirm the round-trip over stdio**

Run:
```bash
cd rust-core && printf '%s\n%s\n' \
  '{"type":"persist_candles","id":1,"symbol":"NSE:INFY","timeframe":"day","source":"kite","candles":[{"ts":1710000000,"open":1,"high":2,"low":0.5,"close":1.5,"volume":100}]}' \
  '{"type":"compute","id":2,"symbol":"NSE:INFY","timeframe":"day","closes":[100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115]}' \
  | ./target/debug/sidecar --lake-root /tmp/ta-lake-smoke
```
Expected: two JSON lines — first `{"type":"persist_candles","id":1,"written":1}`, second `{"type":"compute","id":2,"algo_results":[…],"confluence":{…}}`.

- [ ] **Step 13: Commit**

```bash
git add rust-core/crates/sidecar/Cargo.toml rust-core/crates/sidecar/src/protocol.rs rust-core/crates/sidecar/src/handlers.rs rust-core/crates/sidecar/src/main.rs
git commit -m "feat(sidecar): add persist_candles request routing live Kite candles to CandleStore"
```

---

## Task 3: Sidecar supervisor (spawn, NDJSON framing, correlation, auto-restart)

**Files:**
- Create: `electron-app/src/main/sidecarProtocol.ts`
- Create: `electron-app/src/main/sidecarSupervisor.ts`
- Test: `electron-app/src/main/sidecarSupervisor.test.ts`

**Interfaces:**
- Consumes: the Rust wire contract from Task 2.
- Produces:
  - `sidecarProtocol.ts` wire types: `CandleWire`, `AlgoResultWire`, `ConfluenceWire`, `ComputeResponseWire`, `PersistCandlesResponseWire`, `SidecarResponseWire`, `SidecarRequestWire`; and `encodeRequest(request: SidecarRequestWire): string`.
  - `sidecarSupervisor.ts`: `class SidecarSupervisor` with `constructor(options: SidecarSupervisorOptions)`, `start(): void`, `stop(): Promise<void>`, `compute(symbol: string, timeframe: string, closes: number[]): Promise<ComputeResponseWire>`, `persistCandles(symbol: string, timeframe: string, candles: CandleWire[], source?: string): Promise<PersistCandlesResponseWire>`, and `on(event: "statusChange", handler: (status: SidecarStatus) => void)`. `SidecarSupervisorOptions = { binaryPath: string; lakeRoot: string; spawnFn?: SpawnFn }` where `SpawnFn = (command: string, args: string[]) => ChildProcessLike`.

- [ ] **Step 1: Implement `sidecarProtocol.ts` (no separate test — exercised by the supervisor test)**

`electron-app/src/main/sidecarProtocol.ts`:

```typescript
// These interfaces mirror the Rust sidecar's serde JSON contract verbatim
// (rust-core/crates/sidecar/src/protocol.rs); field names stay snake_case to
// match the bytes on the wire, not this project's TS naming convention.
export interface CandleWire {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AlgoResultWire {
  algo_id: string;
  direction: string;
  confidence: number;
  evidence: string[];
}

export interface ConfluenceWire {
  bullish_count: number;
  bearish_count: number;
  neutral_count: number;
  weighted_vote: number;
}

export interface ComputeResponseWire {
  type: "compute";
  id: number;
  algo_results: AlgoResultWire[];
  confluence: ConfluenceWire;
}

export interface PersistCandlesResponseWire {
  type: "persist_candles";
  id: number;
  written: number;
  error?: string;
}

export type SidecarResponseWire = ComputeResponseWire | PersistCandlesResponseWire;

export type SidecarRequestWire =
  | { type: "compute"; id: number; symbol: string; timeframe: string; closes: number[] }
  | { type: "persist_candles"; id: number; symbol: string; timeframe: string; source: string; candles: CandleWire[] };

export function encodeRequest(request: SidecarRequestWire): string {
  return `${JSON.stringify(request)}\n`;
}
```

- [ ] **Step 2: Write the failing supervisor test**

`electron-app/src/main/sidecarSupervisor.test.ts`:

```typescript
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { SidecarSupervisor } from "./sidecarSupervisor";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  kill(): void {
    this.killed = true;
    this.emit("exit", 0, null);
  }
}

function makeSupervisor() {
  const children: FakeChild[] = [];
  const spawnFn = (_command: string, _args: string[]) => {
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ReturnType<typeof spawnFn>;
  };
  const supervisor = new SidecarSupervisor({ binaryPath: "/fake/sidecar", lakeRoot: "/fake/lake", spawnFn });
  supervisor.start();
  return { supervisor, children };
}

function readRequests(child: FakeChild): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    let buffer = "";
    child.stdin.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n").filter((line) => line.length > 0);
      if (lines.length >= 1) resolve(lines.map((line) => JSON.parse(line)));
    });
  });
}

describe("SidecarSupervisor", () => {
  it("passes --lake-root when spawning", () => {
    const args: string[] = [];
    const spawnFn = (_command: string, spawnArgs: string[]) => {
      args.push(...spawnArgs);
      return new FakeChild() as unknown as ReturnType<typeof spawnFn>;
    };
    const supervisor = new SidecarSupervisor({ binaryPath: "/fake/sidecar", lakeRoot: "/fake/lake", spawnFn });
    supervisor.start();
    expect(args).toEqual(["--lake-root", "/fake/lake"]);
  });

  it("resolves a compute request with the response carrying the matching id", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.compute("NSE:INFY", "day", [1, 2, 3]);

    await requestsSeen;
    children[0].stdout.write(
      `${JSON.stringify({ type: "compute", id: 1, algo_results: [], confluence: { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 } })}\n`,
    );

    const response = await pending;
    expect(response.id).toBe(1);
    expect(response.type).toBe("compute");
  });

  it("routes interleaved out-of-order responses to the correct waiting promise", async () => {
    const { supervisor, children } = makeSupervisor();
    const first = supervisor.compute("NSE:INFY", "day", [1, 2, 3]);
    const second = supervisor.persistCandles("NSE:INFY", "day", [
      { ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ]);

    children[0].stdout.write(`${JSON.stringify({ type: "persist_candles", id: 2, written: 1 })}\n`);
    children[0].stdout.write(
      `${JSON.stringify({ type: "compute", id: 1, algo_results: [], confluence: { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 } })}\n`,
    );

    expect((await second).written).toBe(1);
    expect((await first).id).toBe(1);
  });

  it("rejects in-flight requests and respawns when the child exits unexpectedly", async () => {
    const { supervisor, children } = makeSupervisor();
    const pending = supervisor.compute("NSE:INFY", "day", [1, 2, 3]);

    children[0].emit("exit", 1, null);

    await expect(pending).rejects.toThrow(/sidecar exited/);
    // Respawn is on a RESTART_BACKOFF_MS timer, so wait past it before asserting.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(children.length).toBe(2);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd electron-app && npx vitest run src/main/sidecarSupervisor.test.ts`
Expected: FAIL — `Cannot find module './sidecarSupervisor'`.

- [ ] **Step 4: Implement `sidecarSupervisor.ts`**

`electron-app/src/main/sidecarSupervisor.ts`:

```typescript
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import {
  CandleWire,
  ComputeResponseWire,
  PersistCandlesResponseWire,
  SidecarRequestWire,
  SidecarResponseWire,
  encodeRequest,
} from "./sidecarProtocol";
import type { SidecarStatus } from "./rendererApi";

interface ChildProcessLike extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  kill(signal?: string): void;
}

type SpawnFn = (command: string, args: string[]) => ChildProcessLike;

export interface SidecarSupervisorOptions {
  binaryPath: string;
  lakeRoot: string;
  spawnFn?: SpawnFn;
}

interface Pending {
  resolve: (response: SidecarResponseWire) => void;
  reject: (error: Error) => void;
}

const RESTART_BACKOFF_MS = 500;

export class SidecarSupervisor extends EventEmitter {
  private readonly binaryPath: string;
  private readonly lakeRoot: string;
  private readonly spawnFn: SpawnFn;
  private child: ChildProcessLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stdoutBuffer = "";
  private stopped = false;

  constructor(options: SidecarSupervisorOptions) {
    super();
    this.binaryPath = options.binaryPath;
    this.lakeRoot = options.lakeRoot;
    this.spawnFn = options.spawnFn ?? ((command, args) => spawn(command, args) as unknown as ChildProcessLike);
  }

  start(): void {
    this.stopped = false;
    this.spawnChild();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.child?.kill();
    this.child = null;
  }

  compute(symbol: string, timeframe: string, closes: number[]): Promise<ComputeResponseWire> {
    return this.send({ type: "compute", id: this.nextId, symbol, timeframe, closes }) as Promise<ComputeResponseWire>;
  }

  persistCandles(
    symbol: string,
    timeframe: string,
    candles: CandleWire[],
    source = "kite",
  ): Promise<PersistCandlesResponseWire> {
    return this.send({
      type: "persist_candles",
      id: this.nextId,
      symbol,
      timeframe,
      source,
      candles,
    }) as Promise<PersistCandlesResponseWire>;
  }

  private send(request: SidecarRequestWire): Promise<SidecarResponseWire> {
    const id = this.nextId++;
    request.id = id;
    return new Promise<SidecarResponseWire>((resolve, reject) => {
      if (!this.child) {
        reject(new Error("sidecar is not running"));
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(encodeRequest(request));
    });
  }

  private spawnChild(): void {
    const child = this.spawnFn(this.binaryPath, ["--lake-root", this.lakeRoot]);
    this.child = child;
    this.emitStatus("up");

    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk.toString()));
    child.on("exit", (code: number | null) => this.onExit(code));
  }

  private onStdout(text: string): void {
    this.stdoutBuffer += text;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim().length > 0) this.dispatch(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    const response = JSON.parse(line) as SidecarResponseWire;
    const waiting = this.pending.get(response.id);
    if (!waiting) return;
    this.pending.delete(response.id);
    waiting.resolve(response);
  }

  private onExit(code: number | null): void {
    this.child = null;
    const error = new Error(`sidecar exited (code ${code ?? "null"})`);
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();

    if (this.stopped) {
      this.emitStatus("down");
      return;
    }
    this.emitStatus("restarting");
    setTimeout(() => {
      if (!this.stopped) this.spawnChild();
    }, RESTART_BACKOFF_MS);
  }

  private emitStatus(status: SidecarStatus): void {
    this.emit("statusChange", status);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd electron-app && npx vitest run src/main/sidecarSupervisor.test.ts`
Expected: PASS — 4 tests. (The auto-restart test deliberately waits 700ms — past `RESTART_BACKOFF_MS` of 500ms — before asserting the respawn produced a second child.)

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/sidecarProtocol.ts electron-app/src/main/sidecarSupervisor.ts electron-app/src/main/sidecarSupervisor.test.ts
git commit -m "feat(electron): supervise Rust sidecar over NDJSON stdio with id-correlated requests and auto-restart"
```

---

## Task 4: Kite MCP read-only client wrapper (safety layer 1) + allowlist test

This is the single most safety-critical file in the phase. The class exposes exactly the 11 read methods named in §4; **no method for any of the six write/GTT-write tools exists**, and a test asserts the method set exactly so a future refactor can never silently add a write path.

**Files:**
- Create: `electron-app/src/main/kiteClient.ts`
- Test: `electron-app/src/main/kiteClient.test.ts`

**Interfaces:**
- Consumes: an injected `McpToolCaller` (so the class is testable without the network — the real MCP `Client` from `@modelcontextprotocol/sdk` is adapted to this in Task 10).
- Produces:
  - `interface McpToolCaller { callTool(name: string, args: Record<string, unknown>): Promise<unknown> }`.
  - `class KiteClient` with exactly these methods: `searchInstruments(query: string)`, `getHistoricalData(params: HistoricalDataParams)`, `getQuotes(instruments: string[])`, `getOHLC(instruments: string[])`, `getLTP(instruments: string[])`, `getMargins()`, `getHoldings()`, `getPositions()`, `getProfile()`, `getGtts()`, `login()`.
  - `interface HistoricalDataParams { instrumentToken: string; interval: string; from: string; to: string }`.
  - Exported constants `KITE_READ_TOOL_NAMES` (the camelCase→snake_case map) and `KITE_WRITE_TOOL_NAMES` (the 6 forbidden names) — reused by Tasks 5 and 6.

- [ ] **Step 1: Write the failing allowlist test**

`electron-app/src/main/kiteClient.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { KiteClient, KITE_READ_TOOL_NAMES, KITE_WRITE_TOOL_NAMES } from "./kiteClient";

const EXPECTED_METHODS = [
  "getGtts",
  "getHistoricalData",
  "getHoldings",
  "getLTP",
  "getMargins",
  "getOHLC",
  "getPositions",
  "getProfile",
  "getQuotes",
  "login",
  "searchInstruments",
];

function methodNames(): string[] {
  return Object.getOwnPropertyNames(KiteClient.prototype)
    .filter((name) => name !== "constructor")
    .sort();
}

describe("KiteClient safety allowlist", () => {
  it("exposes exactly the eleven read-tool methods and no others", () => {
    expect(methodNames()).toEqual(EXPECTED_METHODS);
  });

  it("exposes no method whose name matches any write/GTT-write tool", () => {
    const forbiddenMethodNames = ["placeOrder", "modifyOrder", "cancelOrder", "placeGttOrder", "modifyGttOrder", "deleteGttOrder"];
    for (const forbidden of forbiddenMethodNames) {
      expect(methodNames()).not.toContain(forbidden);
    }
  });

  it("maps no method to a write MCP tool name", () => {
    const mappedToolNames = Object.values(KITE_READ_TOOL_NAMES);
    for (const writeTool of KITE_WRITE_TOOL_NAMES) {
      expect(mappedToolNames).not.toContain(writeTool);
    }
  });

  it("calls the correct read tool name for each method", async () => {
    const callTool = vi.fn().mockResolvedValue({ ok: true });
    const client = new KiteClient({ callTool });

    await client.getQuotes(["NSE:INFY"]);
    expect(callTool).toHaveBeenCalledWith("get_quotes", { instruments: ["NSE:INFY"] });

    await client.getHistoricalData({ instrumentToken: "408065", interval: "day", from: "2026-01-01", to: "2026-01-10" });
    expect(callTool).toHaveBeenLastCalledWith("get_historical_data", {
      instrument_token: "408065",
      interval: "day",
      from: "2026-01-01",
      to: "2026-01-10",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron-app && npx vitest run src/main/kiteClient.test.ts`
Expected: FAIL — `Cannot find module './kiteClient'`.

- [ ] **Step 3: Implement `kiteClient.ts`**

`electron-app/src/main/kiteClient.ts`:

```typescript
export interface McpToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface HistoricalDataParams {
  instrumentToken: string;
  interval: string;
  from: string;
  to: string;
}

// The camelCase wrapper method -> Kite MCP tool name mapping. This object is
// the complete set of tools this app is allowed to call; the allowlist test
// asserts none of KITE_WRITE_TOOL_NAMES ever appears among these values.
export const KITE_READ_TOOL_NAMES = {
  searchInstruments: "search_instruments",
  getHistoricalData: "get_historical_data",
  getQuotes: "get_quotes",
  getOHLC: "get_ohlc",
  getLTP: "get_ltp",
  getMargins: "get_margins",
  getHoldings: "get_holdings",
  getPositions: "get_positions",
  getProfile: "get_profile",
  getGtts: "get_gtts",
  login: "login",
} as const;

// Never reachable through any method here (§4). Present only so tests and the
// claude denylist (Task 6) can reference the exact forbidden names.
export const KITE_WRITE_TOOL_NAMES = [
  "place_order",
  "modify_order",
  "cancel_order",
  "place_gtt_order",
  "modify_gtt_order",
  "delete_gtt_order",
] as const;

export class KiteClient {
  private readonly caller: McpToolCaller;

  constructor(caller: McpToolCaller) {
    this.caller = caller;
  }

  searchInstruments(query: string): Promise<unknown> {
    return this.caller.callTool(KITE_READ_TOOL_NAMES.searchInstruments, { query });
  }

  getHistoricalData(params: HistoricalDataParams): Promise<unknown> {
    return this.caller.callTool(KITE_READ_TOOL_NAMES.getHistoricalData, {
      instrument_token: params.instrumentToken,
      interval: params.interval,
      from: params.from,
      to: params.to,
    });
  }

  getQuotes(instruments: string[]): Promise<unknown> {
    return this.caller.callTool(KITE_READ_TOOL_NAMES.getQuotes, { instruments });
  }

  getOHLC(instruments: string[]): Promise<unknown> {
    return this.caller.callTool(KITE_READ_TOOL_NAMES.getOHLC, { instruments });
  }

  getLTP(instruments: string[]): Promise<unknown> {
    return this.caller.callTool(KITE_READ_TOOL_NAMES.getLTP, { instruments });
  }

  getMargins(): Promise<unknown> {
    return this.caller.callTool(KITE_READ_TOOL_NAMES.getMargins, {});
  }

  getHoldings(): Promise<unknown> {
    return this.caller.callTool(KITE_READ_TOOL_NAMES.getHoldings, {});
  }

  getPositions(): Promise<unknown> {
    return this.caller.callTool(KITE_READ_TOOL_NAMES.getPositions, {});
  }

  getProfile(): Promise<unknown> {
    return this.caller.callTool(KITE_READ_TOOL_NAMES.getProfile, {});
  }

  getGtts(): Promise<unknown> {
    return this.caller.callTool(KITE_READ_TOOL_NAMES.getGtts, {});
  }

  login(): Promise<unknown> {
    return this.caller.callTool(KITE_READ_TOOL_NAMES.login, {});
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron-app && npx vitest run src/main/kiteClient.test.ts`
Expected: PASS — 4 tests, including the exact-method-set assertion.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/kiteClient.ts electron-app/src/main/kiteClient.test.ts
git commit -m "feat(electron): read-only Kite MCP wrapper with exact-method-set allowlist test (safety layer 1)"
```

---

## Task 5: Kite MCP `tools/list` drift monitor (safety layer 3)

`tools/list` needs no authenticated session (§4 sequencing note), so this is buildable and testable before Kite login exists. The diff logic is tested against fixtures; the pinned baseline is the 22 tool names named in §4/§5.1, with an explicit step to capture the live snapshot (the design observed 24 tools) and record any additional names.

**Files:**
- Create: `electron-app/src/main/mcpDriftMonitor.ts`
- Test: `electron-app/src/main/mcpDriftMonitor.test.ts`

**Interfaces:**
- Consumes: `KITE_WRITE_TOOL_NAMES` from `kiteClient.ts`.
- Produces:
  - `EXPECTED_KITE_TOOLS: readonly string[]` — the pinned baseline.
  - `interface DriftResult { added: string[]; removed: string[]; hasDrift: boolean }`.
  - `function diffToolList(liveToolNames: string[]): DriftResult`.
  - `interface ToolListing { listTools(): Promise<string[]> }`.
  - `async function checkKiteToolDrift(listing: ToolListing): Promise<DriftResult>`.

- [ ] **Step 1: Write the failing test**

`electron-app/src/main/mcpDriftMonitor.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { EXPECTED_KITE_TOOLS, checkKiteToolDrift, diffToolList } from "./mcpDriftMonitor";

describe("mcpDriftMonitor", () => {
  it("reports no drift when the live list matches the pinned baseline exactly", () => {
    const result = diffToolList([...EXPECTED_KITE_TOOLS]);
    expect(result.hasDrift).toBe(false);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it("flags a newly-appearing tool as drift", () => {
    const result = diffToolList([...EXPECTED_KITE_TOOLS, "place_basket_order"]);
    expect(result.hasDrift).toBe(true);
    expect(result.added).toEqual(["place_basket_order"]);
  });

  it("flags a disappearing tool as drift", () => {
    const shrunk = [...EXPECTED_KITE_TOOLS].filter((name) => name !== "get_quotes");
    const result = diffToolList(shrunk);
    expect(result.hasDrift).toBe(true);
    expect(result.removed).toEqual(["get_quotes"]);
  });

  it("runs against an injected listing without needing an authenticated session", async () => {
    const listing = { listTools: async () => [...EXPECTED_KITE_TOOLS] };
    const result = await checkKiteToolDrift(listing);
    expect(result.hasDrift).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron-app && npx vitest run src/main/mcpDriftMonitor.test.ts`
Expected: FAIL — `Cannot find module './mcpDriftMonitor'`.

- [ ] **Step 3: Implement `mcpDriftMonitor.ts`**

`electron-app/src/main/mcpDriftMonitor.ts`:

```typescript
import { KITE_WRITE_TOOL_NAMES } from "./kiteClient";

// Baseline pinned from the tool names enumerated in the design doc's §4/§5.1.
// The design observed 24 tools live on 2026-07-18; this list names the 22 that
// are documented by name. Step: capture the live tools/list and append any
// additional names it returns (see Task 5 Step 6), so the monitor's baseline
// reflects the real remote surface rather than only the documented subset.
export const EXPECTED_KITE_TOOLS: readonly string[] = [
  "login",
  "get_quotes",
  "get_ltp",
  "get_ohlc",
  "get_historical_data",
  "search_instruments",
  "get_profile",
  "get_margins",
  "get_holdings",
  "get_positions",
  "get_mf_holdings",
  "get_orders",
  "get_trades",
  "get_order_history",
  "get_order_trades",
  "get_gtts",
  ...KITE_WRITE_TOOL_NAMES,
];

export interface DriftResult {
  added: string[];
  removed: string[];
  hasDrift: boolean;
}

export interface ToolListing {
  listTools(): Promise<string[]>;
}

export function diffToolList(liveToolNames: string[]): DriftResult {
  const expected = new Set<string>(EXPECTED_KITE_TOOLS);
  const live = new Set(liveToolNames);
  const added = liveToolNames.filter((name) => !expected.has(name)).sort();
  const removed = [...expected].filter((name) => !live.has(name)).sort();
  return { added, removed, hasDrift: added.length > 0 || removed.length > 0 };
}

export async function checkKiteToolDrift(listing: ToolListing): Promise<DriftResult> {
  return diffToolList(await listing.listTools());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron-app && npx vitest run src/main/mcpDriftMonitor.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/mcpDriftMonitor.ts electron-app/src/main/mcpDriftMonitor.test.ts
git commit -m "feat(electron): Kite MCP tools/list drift monitor with fixture-tested diff (safety layer 3)"
```

- [ ] **Step 6: (Manual, deferred until an MCP connection exists in Task 10) capture the live baseline**

After Task 10 wires a real MCP client, run the app once, call `tools/list`, and if it returns tool names not in `EXPECTED_KITE_TOOLS`, append them to that constant and commit with message `chore(electron): pin live Kite MCP tools/list baseline`. This is monitoring a remote surface already observed to drift (§4) — not a one-time check.

---

## Task 6: `claude` subprocess scaffolding with denylist flags (safety layer 2)

**Scaffolding only.** No `Provider` interface, no `AnalysisEnvelope`/`Verdict`, no persona pipeline — all Phase 4. This task proves only that every `claude` invocation carries the write-tool denylist and `--strict-mcp-config`.

**Files:**
- Create: `electron-app/src/main/claudeProvider.ts`
- Test: `electron-app/src/main/claudeProvider.test.ts`

**Interfaces:**
- Consumes: `KITE_WRITE_TOOL_NAMES` from `kiteClient.ts`.
- Produces:
  - `KITE_WRITE_TOOL_DENYLIST: string` — the comma-joined `mcp__kite__*` names.
  - `function buildClaudeArgs(prompt: string, extraArgs?: string[]): string[]` — always includes `--disallowedTools <denylist>` (adjacent) and `--strict-mcp-config`, regardless of `extraArgs`.
  - `function spawnClaude(prompt: string, extraArgs?: string[], spawnFn?: SpawnFn): ChildProcessLike`.

- [ ] **Step 1: Write the failing test**

`electron-app/src/main/claudeProvider.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { KITE_WRITE_TOOL_DENYLIST, buildClaudeArgs, spawnClaude } from "./claudeProvider";

function assertDenylistPresent(args: string[]): void {
  const flagIndex = args.indexOf("--disallowedTools");
  expect(flagIndex).toBeGreaterThanOrEqual(0);
  expect(args[flagIndex + 1]).toBe(KITE_WRITE_TOOL_DENYLIST);
  expect(args).toContain("--strict-mcp-config");
}

describe("claude subprocess scaffolding", () => {
  it("names all six write tools in the denylist", () => {
    expect(KITE_WRITE_TOOL_DENYLIST).toBe(
      "mcp__kite__place_order,mcp__kite__modify_order,mcp__kite__cancel_order,mcp__kite__place_gtt_order,mcp__kite__modify_gtt_order,mcp__kite__delete_gtt_order",
    );
  });

  it("always includes the denylist and strict-mcp-config for a plain prompt", () => {
    assertDenylistPresent(buildClaudeArgs("analyze INFY"));
  });

  it("keeps the denylist intact even when caller-supplied extra args try to re-allow tools", () => {
    const args = buildClaudeArgs("analyze INFY", ["--allowedTools", "mcp__kite__place_order"]);
    assertDenylistPresent(args);
  });

  it("passes the denylist through to the spawned process argv", () => {
    const spawnFn = vi.fn().mockReturnValue({});
    spawnClaude("analyze INFY", [], spawnFn);
    const [, argv] = spawnFn.mock.calls[0];
    assertDenylistPresent(argv);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron-app && npx vitest run src/main/claudeProvider.test.ts`
Expected: FAIL — `Cannot find module './claudeProvider'`.

- [ ] **Step 3: Implement `claudeProvider.ts`**

`electron-app/src/main/claudeProvider.ts`:

```typescript
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { KITE_WRITE_TOOL_NAMES } from "./kiteClient";

type SpawnFn = (command: string, args: string[]) => ChildProcess;

// Every claude invocation carries this denylist plus --strict-mcp-config so no
// other MCP config source can silently reintroduce a write capability (§4,
// layer 2). Built from the same forbidden tool names the Kite wrapper refuses
// to expose, prefixed with the CLI's mcp__<server>__<tool> form.
export const KITE_WRITE_TOOL_DENYLIST = KITE_WRITE_TOOL_NAMES.map((name) => `mcp__kite__${name}`).join(",");

export function buildClaudeArgs(prompt: string, extraArgs: string[] = []): string[] {
  return [
    "--disallowedTools",
    KITE_WRITE_TOOL_DENYLIST,
    "--strict-mcp-config",
    ...extraArgs,
    "--print",
    prompt,
  ];
}

export function spawnClaude(
  prompt: string,
  extraArgs: string[] = [],
  spawnFn: SpawnFn = (command, args) => spawn(command, args),
): ChildProcess {
  return spawnFn("claude", buildClaudeArgs(prompt, extraArgs));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron-app && npx vitest run src/main/claudeProvider.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/claudeProvider.ts electron-app/src/main/claudeProvider.test.ts
git commit -m "feat(electron): claude subprocess scaffolding enforcing write-tool denylist + strict-mcp-config (safety layer 2)"
```

---

## Task 7: Kite OAuth loopback capture + checksum + access-token exchange

Implements §8.3's resolved design: a short-lived loopback HTTP server on the registered `http://127.0.0.1:<port>` redirect, the login URL opened in the real system browser (injected `openExternal`), a one-shot handler capturing `request_token`, and the §5.1 `access_token` exchange (`checksum = SHA-256(api_key + request_token + api_secret)`). The `openExternal` and HTTP-POST dependencies are injected so the deterministic parts are unit-testable without a live Kite account or a browser.

**Files:**
- Create: `electron-app/src/main/kiteOAuth.ts`
- Test: `electron-app/src/main/kiteOAuth.test.ts`

**Interfaces:**
- Produces:
  - `function computeKiteChecksum(apiKey: string, requestToken: string, apiSecret: string): string` (SHA-256 hex).
  - `interface RequestTokenCaptureOptions { port: number; loginUrl: string; openExternal: (url: string) => void }`.
  - `function captureRequestToken(options: RequestTokenCaptureOptions): Promise<string>`.
  - `interface AccessTokenExchange { apiKey: string; apiSecret: string; requestToken: string; postForm: (url: string, form: Record<string, string>) => Promise<unknown> }`.
  - `async function exchangeAccessToken(exchange: AccessTokenExchange): Promise<unknown>`.

- [ ] **Step 1: Write the failing test**

`electron-app/src/main/kiteOAuth.test.ts`:

```typescript
import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { captureRequestToken, computeKiteChecksum, exchangeAccessToken } from "./kiteOAuth";

describe("kiteOAuth", () => {
  it("computes the SHA-256 checksum of api_key + request_token + api_secret", () => {
    expect(computeKiteChecksum("api_key_123", "req_token_456", "api_secret_789")).toBe(
      "418ae5b66b62dd350659ba76f255776f36c668bd16a5fe31924a261b717e8e72",
    );
  });

  it("opens the login URL in the system browser and resolves with the captured request_token", async () => {
    const openExternal = vi.fn((url: string) => {
      const target = new URL(url);
      const port = Number(target.searchParams.get("port"));
      http.get(`http://127.0.0.1:${port}/callback?request_token=abc123&action=login&status=success`, (res) => {
        res.resume();
      });
    });

    const token = await captureRequestToken({
      port: 0,
      loginUrl: "https://kite.zerodha.com/connect/login?v=3&api_key=api_key_123",
      openExternal,
    });

    expect(token).toBe("abc123");
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it("posts the checksum-signed form to the session/token endpoint", async () => {
    const postForm = vi.fn().mockResolvedValue({ data: { access_token: "at_999" } });
    const result = await exchangeAccessToken({
      apiKey: "api_key_123",
      apiSecret: "api_secret_789",
      requestToken: "req_token_456",
      postForm,
    });

    expect(postForm).toHaveBeenCalledWith("https://api.kite.trade/session/token", {
      api_key: "api_key_123",
      request_token: "req_token_456",
      checksum: "418ae5b66b62dd350659ba76f255776f36c668bd16a5fe31924a261b717e8e72",
    });
    expect(result).toEqual({ data: { access_token: "at_999" } });
  });
});
```

Note on the capture test: it passes `port: 0` (OS-assigned port) but the injected `openExternal` needs the real port. The implementation must therefore bind first, read the assigned port from the server's `address()`, and inject it into the URL it opens. The test's `openExternal` reads a `port` query param the implementation appends to `loginUrl` — see Step 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron-app && npx vitest run src/main/kiteOAuth.test.ts`
Expected: FAIL — `Cannot find module './kiteOAuth'`.

- [ ] **Step 3: Implement `kiteOAuth.ts`**

`electron-app/src/main/kiteOAuth.ts`:

```typescript
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Kite Connect session checksum (§5.1): SHA-256 of the concatenation, hex.
export function computeKiteChecksum(apiKey: string, requestToken: string, apiSecret: string): string {
  return createHash("sha256").update(`${apiKey}${requestToken}${apiSecret}`).digest("hex");
}

export interface RequestTokenCaptureOptions {
  port: number;
  loginUrl: string;
  openExternal: (url: string) => void;
}

const CLOSE_TAB_PAGE = "<!doctype html><meta charset=utf-8><title>Trade Assistant</title><body>Login captured. You can close this tab.</body>";

export function captureRequestToken(options: RequestTokenCaptureOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const requestToken = url.searchParams.get("request_token");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(CLOSE_TAB_PAGE);
      server.close();
      if (requestToken) resolve(requestToken);
      else reject(new Error("callback did not include request_token"));
    });

    server.on("error", reject);

    server.listen(options.port, "127.0.0.1", () => {
      const assignedPort = (server.address() as AddressInfo).port;
      const separator = options.loginUrl.includes("?") ? "&" : "?";
      options.openExternal(`${options.loginUrl}${separator}port=${assignedPort}`);
    });
  });
}

export interface AccessTokenExchange {
  apiKey: string;
  apiSecret: string;
  requestToken: string;
  postForm: (url: string, form: Record<string, string>) => Promise<unknown>;
}

export function exchangeAccessToken(exchange: AccessTokenExchange): Promise<unknown> {
  const checksum = computeKiteChecksum(exchange.apiKey, exchange.requestToken, exchange.apiSecret);
  return exchange.postForm("https://api.kite.trade/session/token", {
    api_key: exchange.apiKey,
    request_token: exchange.requestToken,
    checksum,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron-app && npx vitest run src/main/kiteOAuth.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/kiteOAuth.ts electron-app/src/main/kiteOAuth.test.ts
git commit -m "feat(electron): Kite OAuth loopback request-token capture + checksum session exchange"
```

---

## Task 8: Daily-session-expiry detection + banner state (§5.1)

The access token is force-invalidated daily ~6 AM (§5.1). The app must detect an expired/absent session — a `TokenException`/HTTP 403, or the MCP `login` tool's auth-gate response — and surface a "Kite needs login today" banner rather than silently failing or fabricating data.

**Files:**
- Create: `electron-app/src/main/kiteSessionState.ts`
- Test: `electron-app/src/main/kiteSessionState.test.ts`

**Interfaces:**
- Consumes: `KiteSessionStatus` and `BannerEvent` from `rendererApi.ts`.
- Produces:
  - `function classifyKiteResponse(response: unknown): KiteSessionStatus`.
  - `class KiteSessionState extends EventEmitter` with `get status(): KiteSessionStatus`, `observe(response: unknown): void`, `markAuthenticated(): void`, `markNeedsLogin(): void`; emits `"change"` with a `KiteSessionStatus` and `"banner"` with a `BannerEvent` when it transitions into `needsLogin`.

- [ ] **Step 1: Write the failing test**

`electron-app/src/main/kiteSessionState.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { KiteSessionState, classifyKiteResponse } from "./kiteSessionState";

describe("classifyKiteResponse", () => {
  it("treats a TokenException error payload as needsLogin", () => {
    expect(classifyKiteResponse({ error_type: "TokenException", message: "Invalid token" })).toBe("needsLogin");
  });

  it("treats an HTTP 403 shape as needsLogin", () => {
    expect(classifyKiteResponse({ status: 403 })).toBe("needsLogin");
  });

  it("treats the MCP login auth-gate text as needsLogin", () => {
    expect(classifyKiteResponse({ content: [{ type: "text", text: "Please login to Kite first to continue." }] })).toBe(
      "needsLogin",
    );
  });

  it("treats a normal profile payload as authenticated", () => {
    expect(classifyKiteResponse({ data: { user_id: "AB1234", user_name: "Trader" } })).toBe("authenticated");
  });
});

describe("KiteSessionState", () => {
  it("emits a banner when transitioning into needsLogin", () => {
    const state = new KiteSessionState();
    const bannerHandler = vi.fn();
    state.on("banner", bannerHandler);

    state.observe({ error_type: "TokenException" });

    expect(state.status).toBe("needsLogin");
    expect(bannerHandler).toHaveBeenCalledWith({ kind: "kiteLogin", message: expect.stringContaining("Kite") });
  });

  it("does not re-emit the banner while already in needsLogin", () => {
    const state = new KiteSessionState();
    const bannerHandler = vi.fn();
    state.on("banner", bannerHandler);

    state.observe({ status: 403 });
    state.observe({ status: 403 });

    expect(bannerHandler).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron-app && npx vitest run src/main/kiteSessionState.test.ts`
Expected: FAIL — `Cannot find module './kiteSessionState'`.

- [ ] **Step 3: Implement `kiteSessionState.ts`**

`electron-app/src/main/kiteSessionState.ts`:

```typescript
import { EventEmitter } from "node:events";
import type { BannerEvent, KiteSessionStatus } from "./rendererApi";

function containsLoginGateText(response: Record<string, unknown>): boolean {
  const content = response.content;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" && /log ?in/i.test(text) && /kite/i.test(text);
  });
}

// The exact live shape of an unauthenticated MCP login-gate response must be
// confirmed empirically (§4 notes it is a functional "please log in" response,
// not a protocol error); these markers cover the documented TokenException /
// 403 / gate-text forms. Extend with the real shape once observed in Task 10.
export function classifyKiteResponse(response: unknown): KiteSessionStatus {
  if (typeof response !== "object" || response === null) return "unknown";
  const record = response as Record<string, unknown>;

  if (record.error_type === "TokenException") return "needsLogin";
  if (record.status === 403) return "needsLogin";
  if (containsLoginGateText(record)) return "needsLogin";

  return "authenticated";
}

export class KiteSessionState extends EventEmitter {
  private current: KiteSessionStatus = "unknown";

  get status(): KiteSessionStatus {
    return this.current;
  }

  observe(response: unknown): void {
    this.transition(classifyKiteResponse(response));
  }

  markAuthenticated(): void {
    this.transition("authenticated");
  }

  markNeedsLogin(): void {
    this.transition("needsLogin");
  }

  private transition(next: KiteSessionStatus): void {
    if (next === this.current) return;
    this.current = next;
    this.emit("change", next);
    if (next === "needsLogin") {
      const banner: BannerEvent = { kind: "kiteLogin", message: "Kite needs login today." };
      this.emit("banner", banner);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron-app && npx vitest run src/main/kiteSessionState.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/kiteSessionState.ts electron-app/src/main/kiteSessionState.test.ts
git commit -m "feat(electron): daily Kite session-expiry classification with needs-login banner (§5.1)"
```

---

## Task 9: Fetch-and-archive chokepoint — every live candle persisted (§10.2)

The single place live historical data enters the app. `fetchAndArchive` fetches via the read-only `KiteClient`, parses Kite's offset-aware `+0530` timestamps, persists **every** fetched candle to the Parquet lake through the sidecar (source `"kite"`), and returns the closes for compute. Persisting on the same path as fetching makes "every fetched candle is archived" a structural guarantee, not a step a caller can forget. Lookback caps are unverified hints (§14, item 2), not authoritative constants.

**Files:**
- Create: `electron-app/src/main/historicalDataArchive.ts`
- Test: `electron-app/src/main/historicalDataArchive.test.ts`

**Interfaces:**
- Consumes: `KiteClient` (Task 4), `SidecarSupervisor` (Task 3), `CandleWire` (Task 3).
- Produces:
  - `interface RawKiteCandle { 0: string; 1: number; 2: number; 3: number; 4: number; 5: number }` (Kite's array-of-arrays candle: `[timestamp, open, high, low, close, volume]`).
  - `function parseKiteCandles(raw: RawKiteCandle[]): CandleWire[]` — offset-aware timestamp → epoch seconds.
  - `const INTERVAL_LOOKBACK_HINT_DAYS: Record<string, number>` — labeled unverified.
  - `interface FetchAndArchiveDeps { kite: KiteClient; sidecar: SidecarSupervisor }`.
  - `interface FetchAndArchiveParams { symbol: string; instrumentToken: string; timeframe: string; from: string; to: string }`.
  - `async function fetchAndArchive(deps: FetchAndArchiveDeps, params: FetchAndArchiveParams): Promise<{ candles: CandleWire[]; closes: number[]; persisted: number }>`.

- [ ] **Step 1: Write the failing test**

`electron-app/src/main/historicalDataArchive.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { fetchAndArchive, parseKiteCandles } from "./historicalDataArchive";
import { KiteClient } from "./kiteClient";
import type { CandleWire } from "./sidecarProtocol";

describe("parseKiteCandles", () => {
  it("parses the +0530 offset timestamp offset-aware into epoch seconds", () => {
    const candles = parseKiteCandles([["2026-01-02T09:15:00+0530", 100, 105, 99, 104, 5000]]);
    // 2026-01-02T09:15:00+0530 == 2026-01-02T03:45:00Z == 1767325500 epoch seconds.
    expect(candles[0].ts).toBe(1767325500);
    expect(candles[0].close).toBe(104);
    expect(candles[0].volume).toBe(5000);
  });
});

describe("fetchAndArchive", () => {
  it("persists every fetched candle and returns the closes", async () => {
    const callTool = vi.fn().mockResolvedValue({
      data: {
        candles: [
          ["2026-01-02T00:00:00+0530", 100, 105, 99, 104, 5000],
          ["2026-01-03T00:00:00+0530", 104, 108, 103, 107, 6000],
        ],
      },
    });
    const kite = new KiteClient({ callTool });

    const persisted: CandleWire[] = [];
    const sidecar = {
      persistCandles: vi.fn(async (_symbol: string, _tf: string, candles: CandleWire[]) => {
        persisted.push(...candles);
        return { type: "persist_candles" as const, id: 1, written: candles.length };
      }),
    };

    const result = await fetchAndArchive(
      { kite, sidecar: sidecar as never },
      { symbol: "NSE:INFY", instrumentToken: "408065", timeframe: "day", from: "2026-01-01", to: "2026-01-03" },
    );

    expect(result.candles.length).toBe(2);
    expect(result.persisted).toBe(2);
    expect(persisted.length).toBe(2);
    expect(result.closes).toEqual([104, 107]);
    expect(sidecar.persistCandles).toHaveBeenCalledWith("NSE:INFY", "day", result.candles, "kite");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron-app && npx vitest run src/main/historicalDataArchive.test.ts`
Expected: FAIL — `Cannot find module './historicalDataArchive'`.

- [ ] **Step 3: Implement `historicalDataArchive.ts`**

`electron-app/src/main/historicalDataArchive.ts`:

```typescript
import type { KiteClient } from "./kiteClient";
import type { SidecarSupervisor } from "./sidecarSupervisor";
import type { CandleWire } from "./sidecarProtocol";

export type RawKiteCandle = [string, number, number, number, number, number];

// Community-reported per-interval lookback caps (§5.1). NOT authoritative: the
// design (§14, item 2) requires validating these against the live API before
// trusting them. Used only as an initial chunk-size hint; the real cap is
// discovered by observing the API's own truncation/empty responses.
export const INTERVAL_LOOKBACK_HINT_DAYS: Record<string, number> = {
  minute: 60,
  "3minute": 100,
  "5minute": 100,
  "10minute": 100,
  "15minute": 200,
  "30minute": 200,
  "60minute": 400,
  day: 2000,
};

export function parseKiteCandles(raw: RawKiteCandle[]): CandleWire[] {
  return raw.map((row) => ({
    // Date.parse on an offset-bearing ISO-8601 string is offset-aware; never
    // strip the +0530 to naive (a documented time-corruption bug class, §5.2).
    ts: Math.floor(Date.parse(row[0]) / 1000),
    open: row[1],
    high: row[2],
    low: row[3],
    close: row[4],
    volume: row[5],
  }));
}

function extractRawCandles(response: unknown): RawKiteCandle[] {
  const candles = (response as { data?: { candles?: unknown } })?.data?.candles;
  return Array.isArray(candles) ? (candles as RawKiteCandle[]) : [];
}

export interface FetchAndArchiveDeps {
  kite: KiteClient;
  sidecar: Pick<SidecarSupervisor, "persistCandles">;
}

export interface FetchAndArchiveParams {
  symbol: string;
  instrumentToken: string;
  timeframe: string;
  from: string;
  to: string;
}

export async function fetchAndArchive(
  deps: FetchAndArchiveDeps,
  params: FetchAndArchiveParams,
): Promise<{ candles: CandleWire[]; closes: number[]; persisted: number }> {
  const response = await deps.kite.getHistoricalData({
    instrumentToken: params.instrumentToken,
    interval: params.timeframe,
    from: params.from,
    to: params.to,
  });

  const candles = parseKiteCandles(extractRawCandles(response));
  const persistResult = await deps.sidecar.persistCandles(params.symbol, params.timeframe, candles, "kite");
  const closes = candles.map((candle) => candle.close);

  return { candles, closes, persisted: persistResult.written };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron-app && npx vitest run src/main/historicalDataArchive.test.ts`
Expected: PASS — 2 tests.

The single-request fetch above satisfies Phase 3's DoD (fetch → persist → compute) and makes candle persistence a structural guarantee. Two spec items intentionally stay out of this committed code because they require a live paid Kite session that does not exist at plan-execution time, and are tracked in Task 10 Step 8's live-Kite manual checklist instead of being hardcoded now: (a) throttling to Kite's 3 req/sec historical limit (§5.1), needed only once multi-chunk fetching across many symbols is added (Phase 5's scan scheduler); and (b) empirically validating the lookback caps (§14, item 2) rather than trusting `INTERVAL_LOOKBACK_HINT_DAYS`, whose in-code comment already marks it non-authoritative.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/historicalDataArchive.ts electron-app/src/main/historicalDataArchive.test.ts
git commit -m "feat(electron): fetch-and-archive chokepoint persisting every live Kite candle to the lake (§10.2)"
```

---

## Task 10: Startup orchestration, IPC bridge, minimal status UI, end-to-end proof

Ties everything together: an MCP-client adapter, `ipcMain.handle` wiring, startup that spawns the sidecar and runs the drift check, and an end-to-end integration test proving the DoD path (fetch → persist → compute → confluence) against the **real** built sidecar binary with recorded Kite candles. The electron-only wiring (`appBridge.ts`, updated `main.ts`) is verified manually per §13.

**Files:**
- Create: `electron-app/src/main/mcpClientAdapter.ts`
- Create: `electron-app/src/main/appBridge.ts`
- Modify: `electron-app/src/main/main.ts`
- Test: `electron-app/src/main/mcpClientAdapter.test.ts`
- Test: `electron-app/test/endToEnd.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–9.
- Produces:
  - `mcpClientAdapter.ts`: `function toToolCaller(client: { callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<unknown> }): McpToolCaller` and `function toToolListing(client: { listTools(): Promise<{ tools: { name: string }[] }> }): ToolListing`.
  - `appBridge.ts`: `function registerStatusBridge(deps: StatusBridgeDeps): void` where `StatusBridgeDeps = { ipcMain; getStatus: () => AppStatus; onBanner: (handler: (banner: BannerEvent) => void) => void; sendToRenderer: (channel: string, payload: unknown) => void }`.

- [ ] **Step 1: Write the failing adapter test**

`electron-app/src/main/mcpClientAdapter.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { toToolCaller, toToolListing } from "./mcpClientAdapter";

describe("mcpClientAdapter", () => {
  it("adapts callTool(name, args) to the SDK's { name, arguments } shape", async () => {
    const client = { callTool: vi.fn().mockResolvedValue({ ok: true }) };
    const caller = toToolCaller(client);

    await caller.callTool("get_quotes", { instruments: ["NSE:INFY"] });

    expect(client.callTool).toHaveBeenCalledWith({ name: "get_quotes", arguments: { instruments: ["NSE:INFY"] } });
  });

  it("adapts listTools() to a flat array of tool names", async () => {
    const client = { listTools: vi.fn().mockResolvedValue({ tools: [{ name: "login" }, { name: "get_ltp" }] }) };
    const listing = toToolListing(client);

    expect(await listing.listTools()).toEqual(["login", "get_ltp"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron-app && npx vitest run src/main/mcpClientAdapter.test.ts`
Expected: FAIL — `Cannot find module './mcpClientAdapter'`.

- [ ] **Step 3: Implement `mcpClientAdapter.ts`**

`electron-app/src/main/mcpClientAdapter.ts`:

```typescript
import type { McpToolCaller } from "./kiteClient";
import type { ToolListing } from "./mcpDriftMonitor";

interface SdkCallClient {
  callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

interface SdkListClient {
  listTools(): Promise<{ tools: { name: string }[] }>;
}

export function toToolCaller(client: SdkCallClient): McpToolCaller {
  return {
    callTool: (name, args) => client.callTool({ name, arguments: args }),
  };
}

export function toToolListing(client: SdkListClient): ToolListing {
  return {
    listTools: async () => (await client.listTools()).tools.map((tool) => tool.name),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron-app && npx vitest run src/main/mcpClientAdapter.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Implement `appBridge.ts` and update `main.ts` (electron-only wiring — verified manually in Step 8)**

`electron-app/src/main/appBridge.ts`:

```typescript
import type { IpcMain } from "electron";
import type { AppStatus, BannerEvent } from "./rendererApi";

export interface StatusBridgeDeps {
  ipcMain: IpcMain;
  getStatus: () => AppStatus;
  onBanner: (handler: (banner: BannerEvent) => void) => void;
  sendToRenderer: (channel: string, payload: unknown) => void;
}

export function registerStatusBridge(deps: StatusBridgeDeps): void {
  deps.ipcMain.handle("status:get", () => deps.getStatus());
  deps.onBanner((banner) => deps.sendToRenderer("banner:push", banner));
}
```

Update `electron-app/src/main/main.ts` to spawn the supervisor, run the drift check, and register the bridge:

```typescript
import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { mainWindowOptions } from "./mainWindow";
import { SidecarSupervisor } from "./sidecarSupervisor";
import { KiteSessionState } from "./kiteSessionState";
import { registerStatusBridge } from "./appBridge";
import type { AppStatus, BannerEvent, SidecarStatus } from "./rendererApi";

const supervisor = new SidecarSupervisor({
  binaryPath: process.env.SIDECAR_BINARY ?? path.join(__dirname, "..", "..", "..", "rust-core", "target", "debug", "sidecar"),
  lakeRoot: process.env.TRADE_ASSISTANT_LAKE ?? path.join(app.getPath("userData"), "candle-lake"),
});
const sessionState = new KiteSessionState();

let sidecarStatus: SidecarStatus = "down";
let driftWarning: string | null = null;
const bannerHandlers: ((banner: BannerEvent) => void)[] = [];

supervisor.on("statusChange", (status: SidecarStatus) => {
  sidecarStatus = status;
});
sessionState.on("banner", (banner: BannerEvent) => bannerHandlers.forEach((handler) => handler(banner)));

function currentStatus(): AppStatus {
  return { sidecar: sidecarStatus, kiteSession: sessionState.status, driftWarning };
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow(mainWindowOptions(path.join(__dirname, "preload.js")));
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
  window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  return window;
}

app.whenReady().then(() => {
  supervisor.start();
  createMainWindow();
});

app.on("window-all-closed", () => {
  supervisor.stop();
  if (process.platform !== "darwin") app.quit();
});
```

- [ ] **Step 6: Write the end-to-end integration test against the real sidecar binary**

`electron-app/test/endToEnd.integration.test.ts`:

```typescript
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KiteClient } from "../src/main/kiteClient";
import { SidecarSupervisor } from "../src/main/sidecarSupervisor";
import { fetchAndArchive } from "../src/main/historicalDataArchive";

const SIDECAR = path.resolve(__dirname, "..", "..", "rust-core", "target", "debug", "sidecar");

// Recorded Kite get_historical_data payload shape (array-of-arrays candles).
// No live Kite account needed: the read wrapper's callTool is stubbed with a
// recorded response, and the real Rust binary does the persist + compute.
function recordedKite(): KiteClient {
  const closes = Array.from({ length: 20 }, (_v, i) => 100 + i);
  const candles = closes.map((close, i) => [
    `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00+0530`,
    close - 1,
    close + 1,
    close - 2,
    close,
    1000 + i,
  ]);
  return new KiteClient({ callTool: async () => ({ data: { candles } }) });
}

describe.skipIf(!existsSync(SIDECAR))("end-to-end: fetch -> archive -> compute", () => {
  it("persists live-shaped candles and returns confluence from the real sidecar", async () => {
    const lake = mkdtempSync(path.join(tmpdir(), "ta-e2e-"));
    const supervisor = new SidecarSupervisor({ binaryPath: SIDECAR, lakeRoot: lake });
    supervisor.start();

    try {
      const archived = await fetchAndArchive(
        { kite: recordedKite(), sidecar: supervisor },
        { symbol: "NSE:INFY", instrumentToken: "408065", timeframe: "day", from: "2026-01-01", to: "2026-01-20" },
      );

      expect(archived.persisted).toBe(20);

      const compute = await supervisor.compute("NSE:INFY", "day", archived.closes);
      expect(compute.type).toBe("compute");
      expect(compute.algo_results.length).toBeGreaterThan(0);
      expect(compute.algo_results.some((r) => r.algo_id === "rsi")).toBe(true);
      expect(Number.isNaN(compute.confluence.weighted_vote)).toBe(false);
    } finally {
      await supervisor.stop();
    }
  });
});
```

- [ ] **Step 7: Build the sidecar and run the end-to-end test**

Run:
```bash
cd rust-core && cargo build -p sidecar
cd ../electron-app && npx vitest run test/endToEnd.integration.test.ts
```
Expected: PASS — 1 test (not skipped, because the binary now exists); `persisted === 20`, `algo_results` non-empty and includes `rsi`, `weighted_vote` not NaN.

- [ ] **Step 8: Manual verification per §13 (golden path, run once)**

Run: `cd electron-app && npm start`
Confirm by observation:
- The window opens with `contextIsolation`/`sandbox` on (DevTools console: `window.tradeAssistant` exists, `window.require` is `undefined`, `window.ipcRenderer` is `undefined`).
- The status line shows `sidecar: up`.
- Forcing a `needsLogin` classification (temporarily feed `sessionState.observe({ status: 403 })` from a debug hook) surfaces the "Kite needs login today" banner.
- **Live-Kite follow-ups** (only when a paid Kite Connect session is available): drive `captureRequestToken`/`exchangeAccessToken` once to confirm the loopback redirect + system-browser flow; call `tools/list` and record any names beyond `EXPECTED_KITE_TOOLS` (Task 5 Step 6); and validate `INTERVAL_LOOKBACK_HINT_DAYS` empirically (Task 9 Step 5) before trusting any cap.

- [ ] **Step 9: Run the entire suite (Rust + TS) and commit**

Run:
```bash
cd rust-core && cargo test -p sidecar
cd ../electron-app && npx vitest run && npx tsc --noEmit
```
Expected: all green; `tsc --noEmit` exits 0.

```bash
git add electron-app/src/main/mcpClientAdapter.ts electron-app/src/main/mcpClientAdapter.test.ts electron-app/src/main/appBridge.ts electron-app/src/main/main.ts electron-app/test/endToEnd.integration.test.ts
git commit -m "feat(electron): wire startup orchestration, IPC status bridge, and end-to-end fetch/persist/compute proof"
```

---

## Definition of Done (Phase 3)

- The app logs into Kite (loopback + system browser, Task 7), fetches real quotes/historical candles through the read-only-by-construction MCP wrapper (Task 4), persists every fetched candle into the Phase 1 Parquet `CandleStore` (Tasks 2 + 9), hands closes to the sidecar over stdio, and gets back algorithm results/confluence (Tasks 3 + 10) — proven end-to-end by `endToEnd.integration.test.ts` against the real binary.
- The Kite wrapper's exposed method set is asserted exactly, failing loudly if a write-tool method is ever added (Task 4). Every `claude` invocation carries the six-tool denylist + `--strict-mcp-config` (Task 6). The `tools/list` drift monitor fires on any unexpected tool (Task 5).
- Electron security posture (`contextIsolation`/`sandbox`/`nodeIntegration:false`, no raw `ipcRenderer` exposure) holds from the first commit (Task 1), asserted by `mainWindowOptions.test.ts` and `rendererApi.test.ts`.
- Daily-session-expiry detection surfaces a "Kite needs login today" banner (Task 8).
