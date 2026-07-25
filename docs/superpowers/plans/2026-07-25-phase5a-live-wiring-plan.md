# Phase 5a — Live Wiring + Engine-Only Deterministic Response Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the first live Kite OAuth login → real MCP connection → existing `assembleEnvelope` → a new pure Engine-Only deterministic prose generator, displayed in the first React UI this codebase has ever had.

**Architecture:** Add one config module and one MCP-connection module to `services/kite/`, one login-orchestration module, one pure generator to `services/analysis/`, three new IPC channels layered onto the existing status/banner bridge, and a minimal React renderer replacing the `status.ts` stub. No existing module's logic changes — `assembleEnvelope`, `KiteClient`, `kiteOAuth`, `mcpClientAdapter`, `mcpDriftMonitor`, and `SidecarSupervisor` are reused as-is. Every new module has a dependency-injection seam so no automated test touches the network or a real Kite session; the live-only integration details are a manual checklist, not an automated gate.

**Tech Stack:** Electron 33 + TypeScript (main process); React 18 + `@vitejs/plugin-react` (renderer); `@modelcontextprotocol/sdk` 1.12.0 `StreamableHTTPClientTransport` (live MCP); `dotenv` (dev-only credential loading); Vitest 2 + `@testing-library/react` + `jsdom` (tests); the reused Rust sidecar over stdio.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the Phase 5a design spec (`docs/superpowers/specs/2026-07-25-phase5a-live-wiring-design.md`) and its master design.

- The app **never places, modifies, cancels, or automates an order** — read-only analysis; the human decides everything (existing, non-negotiable).
- Deterministic-generator output is **descriptive only** (`bullish`/`bearish`/`neutral`), **never** buy/sell/hold/add/watch imperative wording — the same ethos as Claude's Verdict output (P4§8), applied here for product consistency even though there is no LLM on this path.
- `KiteClient`'s closed read-only method set **must not gain any new method**, and the real MCP connection **must route through the existing `mcpClientAdapter.ts`/`KiteClient`** — no new/parallel raw-MCP-call path that bypasses `KiteClient`'s allowlist.
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` must hold — the new React renderer must not weaken this; new IPC channels go through the existing `contextBridge`/preload pattern, with **no raw `ipcRenderer` exposure**.
- **No automated test may perform a real live Kite OAuth login or a real live MCP network call** — everything is DI-mocked per the established pattern (`sidecarSupervisor.test.ts`, `historicalDataArchive.test.ts`, `claudeProvider.test.ts` style). Live-only steps are an explicit manual checklist, not a blocking automated gate.
- TypeScript: **camelCase** functions/variables, **PascalCase** types/classes/React components, no Hungarian notation, file names describe responsibility. Comments: default none; only a non-obvious *why*; never restate the next line; never a numbered step block.
- Pure logic stays separate from I/O — the deterministic generator is **pure** (no I/O, no React, data-in/prose-out).
- Commits authored `hadetan <aquibsyed83@gmail.com>` (already the repo git config — no `--author`), **no `Co-Authored-By` trailer**, **no `--no-verify`**.
- TDD per task: a real failing test first, then implementation, for everything with a testable seam. React components get `@testing-library/react` **behavior-first** tests (what renders, what happens on interaction — not snapshot tests).
- **No new behavior beyond what the design spec specifies.** No chat history, no streaming, no markdown/DOMPurify, no settings window, no scan scheduler, no AI/Engine mode picker, no free-text intake, no `auto` horizon, no buying/selling lens step — those are 5b/5c/5d.

---

### Task 1: Kite API key/secret config + `.env` scaffolding

**Files:**
- Create: `electron-app/src/main/services/kite/kiteConfig.ts`
- Create: `electron-app/.env.example`
- Modify: `electron-app/.gitignore` (append `.env`)
- Modify: `electron-app/package.json` (add `dotenv` devDependency)
- Test: `electron-app/test/main/services/kite/kiteConfig.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `class KiteConfigError extends Error`
  - `interface KiteConfig { apiKey: string; apiSecret: string; loginPort: number }`
  - `function loadKiteConfig(env?: NodeJS.ProcessEnv): KiteConfig` — throws `KiteConfigError` on missing/empty `KITE_API_KEY`/`KITE_API_SECRET`; `loginPort` parses `KITE_LOGIN_PORT` or defaults to `3000`.

- [ ] **Step 1: Add the `dotenv` devDependency**

Run: `cd electron-app && npm install --save-dev dotenv@^16`
Expected: `package.json` `devDependencies` gains `"dotenv": "^16.x"`; `package-lock.json` updates.

- [ ] **Step 2: Write the failing test**

Create `electron-app/test/main/services/kite/kiteConfig.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { KiteConfigError, loadKiteConfig } from "../../../../src/main/services/kite/kiteConfig";

describe("loadKiteConfig", () => {
  it("parses a fully populated env", () => {
    const config = loadKiteConfig({ KITE_API_KEY: "k123", KITE_API_SECRET: "s456", KITE_LOGIN_PORT: "4100" });
    expect(config).toEqual({ apiKey: "k123", apiSecret: "s456", loginPort: 4100 });
  });

  it("defaults loginPort to 3000 when KITE_LOGIN_PORT is absent", () => {
    expect(loadKiteConfig({ KITE_API_KEY: "k", KITE_API_SECRET: "s" }).loginPort).toBe(3000);
  });

  it("throws KiteConfigError when KITE_API_KEY is missing", () => {
    expect(() => loadKiteConfig({ KITE_API_SECRET: "s" })).toThrow(KiteConfigError);
    expect(() => loadKiteConfig({ KITE_API_SECRET: "s" })).toThrow(/KITE_API_KEY is missing/);
  });

  it("throws KiteConfigError when KITE_API_SECRET is empty", () => {
    expect(() => loadKiteConfig({ KITE_API_KEY: "k", KITE_API_SECRET: "   " })).toThrow(/KITE_API_SECRET is missing/);
  });

  it("throws KiteConfigError on a non-numeric KITE_LOGIN_PORT", () => {
    expect(() => loadKiteConfig({ KITE_API_KEY: "k", KITE_API_SECRET: "s", KITE_LOGIN_PORT: "abc" })).toThrow(
      KiteConfigError,
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd electron-app && npx vitest run test/main/services/kite/kiteConfig.test.ts`
Expected: FAIL — `Failed to resolve import ".../kiteConfig"` (module does not exist yet).

- [ ] **Step 4: Write the implementation**

Create `electron-app/src/main/services/kite/kiteConfig.ts`:

```typescript
export class KiteConfigError extends Error {}

export interface KiteConfig {
  apiKey: string;
  apiSecret: string;
  loginPort: number;
}

const DEFAULT_LOGIN_PORT = 3000;

export function loadKiteConfig(env: NodeJS.ProcessEnv = process.env): KiteConfig {
  const apiKey = env.KITE_API_KEY?.trim();
  if (!apiKey) {
    throw new KiteConfigError("KITE_API_KEY is missing — create electron-app/.env from .env.example");
  }
  const apiSecret = env.KITE_API_SECRET?.trim();
  if (!apiSecret) {
    throw new KiteConfigError("KITE_API_SECRET is missing — create electron-app/.env from .env.example");
  }
  const rawPort = env.KITE_LOGIN_PORT?.trim();
  const loginPort = rawPort ? Number(rawPort) : DEFAULT_LOGIN_PORT;
  if (!Number.isInteger(loginPort) || loginPort < 0) {
    throw new KiteConfigError(`KITE_LOGIN_PORT must be a non-negative integer, got "${rawPort}"`);
  }
  return { apiKey, apiSecret, loginPort };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd electron-app && npx vitest run test/main/services/kite/kiteConfig.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Create `.env.example` and gitignore `.env`**

Create `electron-app/.env.example`:

```
# Kite Connect developer-console credentials (dev-only; never committed).
# Copy this file to electron-app/.env and fill in real values.
KITE_API_KEY=your_kite_connect_api_key
KITE_API_SECRET=your_kite_connect_api_secret
# Loopback OAuth redirect port; must match the redirect_url registered in the Kite console.
KITE_LOGIN_PORT=3000
```

Append `.env` to `electron-app/.gitignore` so it reads:

```
node_modules/
dist/
out/
.env
```

- [ ] **Step 7: Verify `.env` is ignored and typecheck**

Run: `cd electron-app && printf 'KITE_API_KEY=x\n' > .env && git check-ignore .env && rm .env && npm run typecheck`
Expected: `git check-ignore` prints `.env` (ignored); `typecheck` passes with no errors.

- [ ] **Step 8: Commit**

```bash
git add electron-app/src/main/services/kite/kiteConfig.ts electron-app/test/main/services/kite/kiteConfig.test.ts electron-app/.env.example electron-app/.gitignore electron-app/package.json electron-app/package-lock.json
git commit -m "feat(kite): load API key/secret config from gitignored .env"
```

---

### Task 2: Real MCP connection module

**Files:**
- Create: `electron-app/src/main/services/kite/mcpConnection.ts`
- Test: `electron-app/test/main/services/kite/mcpConnection.test.ts`

**Interfaces:**
- Consumes: `toToolCaller`, `toToolListing` from `services/kite/mcpClientAdapter.ts`; `McpToolCaller` from `kiteClient.ts`; `ToolListing` from `mcpDriftMonitor.ts`.
- Produces:
  - `interface McpConnection { caller: McpToolCaller; listing: ToolListing; close(): Promise<void> }`
  - `interface ConnectKiteMcpDeps { apiKey: string; accessToken: string; url?: string; createClient?: (params: { url: string; headers: Record<string, string> }) => Promise<SdkLikeClient> }`
  - `function connectKiteMcp(deps: ConnectKiteMcpDeps): Promise<McpConnection>` — builds the header `{ Authorization: \`token ${apiKey}:${accessToken}\` }`, defaults `url` to `"https://mcp.kite.trade/mcp"`, adapts the client via `toToolCaller`/`toToolListing`, and forwards `close()`.

**Grounded SDK shapes (read from `node_modules/@modelcontextprotocol/sdk@1.12.0`):**
- `StreamableHTTPClientTransport` constructor: `constructor(url: URL, opts?: StreamableHTTPClientTransportOptions)` where `StreamableHTTPClientTransportOptions.requestInit?: RequestInit` — the token header goes in `opts.requestInit.headers`.
- `Client` constructor: `constructor(_clientInfo: Implementation, options?: ClientOptions)`; exposes `connect(transport, options?)`, `close(): Promise<void>` (via `Protocol`), `callTool(params, ...)`, `listTools(params?, ...)`. It already satisfies the adapter's structural `{ callTool({name,arguments}) }` / `{ listTools() }` interfaces — no shim.

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/main/services/kite/mcpConnection.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { connectKiteMcp } from "../../../../src/main/services/kite/mcpConnection";

function fakeClient() {
  return {
    callTool: vi.fn().mockResolvedValue({ ok: true }),
    listTools: vi.fn().mockResolvedValue({ tools: [{ name: "login" }, { name: "get_ltp" }] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("connectKiteMcp", () => {
  it("passes the Authorization header and default url to createClient", async () => {
    const client = fakeClient();
    const createClient = vi.fn().mockResolvedValue(client);

    await connectKiteMcp({ apiKey: "K", accessToken: "T", createClient });

    expect(createClient).toHaveBeenCalledWith({
      url: "https://mcp.kite.trade/mcp",
      headers: { Authorization: "token K:T" },
    });
  });

  it("adapts callTool and listTools through mcpClientAdapter", async () => {
    const client = fakeClient();
    const conn = await connectKiteMcp({ apiKey: "K", accessToken: "T", createClient: async () => client });

    await conn.caller.callTool("get_ltp", { instruments: ["NSE:INFY"] });
    expect(client.callTool).toHaveBeenCalledWith({ name: "get_ltp", arguments: { instruments: ["NSE:INFY"] } });
    expect(await conn.listing.listTools()).toEqual(["login", "get_ltp"]);
  });

  it("forwards close() to the underlying client", async () => {
    const client = fakeClient();
    const conn = await connectKiteMcp({ apiKey: "K", accessToken: "T", createClient: async () => client });

    await conn.close();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("honours a custom url", async () => {
    const createClient = vi.fn().mockResolvedValue(fakeClient());
    await connectKiteMcp({ apiKey: "K", accessToken: "T", url: "https://example.test/mcp", createClient });
    expect(createClient).toHaveBeenCalledWith({ url: "https://example.test/mcp", headers: { Authorization: "token K:T" } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron-app && npx vitest run test/main/services/kite/mcpConnection.test.ts`
Expected: FAIL — cannot resolve import `.../mcpConnection`.

- [ ] **Step 3: Write the implementation**

Create `electron-app/src/main/services/kite/mcpConnection.ts`:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { toToolCaller, toToolListing } from "./mcpClientAdapter";
import type { McpToolCaller } from "./kiteClient";
import type { ToolListing } from "./mcpDriftMonitor";

const DEFAULT_MCP_URL = "https://mcp.kite.trade/mcp";

interface SdkLikeClient {
  callTool(a: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  listTools(): Promise<{ tools: { name: string }[] }>;
  close(): Promise<void>;
}

export interface McpConnection {
  caller: McpToolCaller;
  listing: ToolListing;
  close(): Promise<void>;
}

export interface ConnectKiteMcpDeps {
  apiKey: string;
  accessToken: string;
  url?: string;
  createClient?: (params: { url: string; headers: Record<string, string> }) => Promise<SdkLikeClient>;
}

async function defaultCreateClient(params: { url: string; headers: Record<string, string> }): Promise<SdkLikeClient> {
  // Lazy require keeps this module importable under Vitest's node env without an
  // electron runtime; the real path runs only in the packaged/dev app.
  const { app } = require("electron") as typeof import("electron");
  const transport = new StreamableHTTPClientTransport(new URL(params.url), {
    requestInit: { headers: params.headers },
  });
  const client = new Client({ name: "trade-assistant", version: app.getVersion() }, {});
  await client.connect(transport);
  return client as unknown as SdkLikeClient;
}

export async function connectKiteMcp(deps: ConnectKiteMcpDeps): Promise<McpConnection> {
  const url = deps.url ?? DEFAULT_MCP_URL;
  const headers = { Authorization: `token ${deps.apiKey}:${deps.accessToken}` };
  const createClient = deps.createClient ?? defaultCreateClient;
  const client = await createClient({ url, headers });
  return {
    caller: toToolCaller(client),
    listing: toToolListing(client),
    close: () => client.close(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron-app && npx vitest run test/main/services/kite/mcpConnection.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `cd electron-app && npm run typecheck`
Expected: passes (the real `Client`/`StreamableHTTPClientTransport` satisfy `SdkLikeClient` structurally).

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/services/kite/mcpConnection.ts electron-app/test/main/services/kite/mcpConnection.test.ts
git commit -m "feat(kite): real MCP connection over SDK StreamableHTTP transport"
```

---

### Task 3: Login-flow orchestration module

**Files:**
- Create: `electron-app/src/main/services/kite/kiteLogin.ts`
- Test: `electron-app/test/main/services/kite/kiteLogin.test.ts`

**Interfaces:**
- Consumes: `KiteConfig` (Task 1); `captureRequestToken`, `exchangeAccessToken` from `kiteOAuth.ts`; `KiteClient` from `kiteClient.ts`; `connectKiteMcp`, `McpConnection`, `ConnectKiteMcpDeps` (Task 2); `checkKiteToolDrift`, `DriftResult`, `ToolListing` from `mcpDriftMonitor.ts`.
- Produces:
  - `interface KiteLoginDeps { config: KiteConfig; captureRequestToken: typeof captureRequestToken; exchangeAccessToken: typeof exchangeAccessToken; postForm: (url: string, form: Record<string, string>) => Promise<unknown>; openExternal: (url: string) => void; connectMcp?: (d: ConnectKiteMcpDeps) => Promise<McpConnection>; checkDrift?: (listing: ToolListing) => Promise<DriftResult> }`
  - `interface KiteSession { kite: KiteClient; connection: McpConnection; drift: DriftResult; close(): Promise<void> }`
  - `function runKiteLogin(deps: KiteLoginDeps): Promise<KiteSession>`

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/main/services/kite/kiteLogin.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { runKiteLogin } from "../../../../src/main/services/kite/kiteLogin";
import type { McpConnection } from "../../../../src/main/services/kite/mcpConnection";

function fakeConnection(): McpConnection {
  return {
    caller: { callTool: vi.fn().mockResolvedValue({ ok: true }) },
    listing: { listTools: vi.fn().mockResolvedValue(["login", "get_ltp"]) },
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function baseDeps() {
  const connection = fakeConnection();
  return {
    connection,
    deps: {
      config: { apiKey: "k123", apiSecret: "s456", loginPort: 3000 },
      captureRequestToken: vi.fn().mockResolvedValue("req_tok"),
      exchangeAccessToken: vi.fn().mockResolvedValue({ data: { access_token: "at_999" } }),
      postForm: vi.fn(),
      openExternal: vi.fn(),
      connectMcp: vi.fn().mockResolvedValue(connection),
      checkDrift: vi.fn().mockResolvedValue({ added: [], removed: [], hasDrift: false }),
    },
  };
}

describe("runKiteLogin", () => {
  it("runs capture -> exchange -> connect -> drift and returns a KiteClient session", async () => {
    const { deps, connection } = baseDeps();

    const session = await runKiteLogin(deps);

    expect(deps.captureRequestToken).toHaveBeenCalledWith({
      port: 3000,
      loginUrl: "https://kite.zerodha.com/connect/login?api_key=k123&v=3",
      openExternal: deps.openExternal,
    });
    expect(deps.exchangeAccessToken).toHaveBeenCalledWith({
      apiKey: "k123",
      apiSecret: "s456",
      requestToken: "req_tok",
      postForm: deps.postForm,
    });
    expect(deps.connectMcp).toHaveBeenCalledWith({ apiKey: "k123", accessToken: "at_999" });
    expect(deps.checkDrift).toHaveBeenCalledWith(connection.listing);
    expect(session.connection).toBe(connection);
    expect(session.drift.hasDrift).toBe(false);

    await session.kite.getLTP(["NSE:INFY"]);
    expect(connection.caller.callTool).toHaveBeenCalledWith("get_ltp", { instruments: ["NSE:INFY"] });
  });

  it("surfaces detected drift on the returned session", async () => {
    const { deps } = baseDeps();
    deps.checkDrift = vi.fn().mockResolvedValue({ added: ["new_tool"], removed: [], hasDrift: true });

    const session = await runKiteLogin(deps);
    expect(session.drift).toEqual({ added: ["new_tool"], removed: [], hasDrift: true });
  });

  it("rejects with a clear error when the token exchange has no access_token", async () => {
    const { deps } = baseDeps();
    deps.exchangeAccessToken = vi.fn().mockResolvedValue({ data: {} });

    await expect(runKiteLogin(deps)).rejects.toThrow(/did not include data.access_token/);
    expect(deps.connectMcp).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron-app && npx vitest run test/main/services/kite/kiteLogin.test.ts`
Expected: FAIL — cannot resolve import `.../kiteLogin`.

- [ ] **Step 3: Write the implementation**

Create `electron-app/src/main/services/kite/kiteLogin.ts`:

```typescript
import type { KiteConfig } from "./kiteConfig";
import { captureRequestToken, exchangeAccessToken } from "./kiteOAuth";
import { KiteClient } from "./kiteClient";
import { connectKiteMcp } from "./mcpConnection";
import type { ConnectKiteMcpDeps, McpConnection } from "./mcpConnection";
import { checkKiteToolDrift } from "./mcpDriftMonitor";
import type { DriftResult, ToolListing } from "./mcpDriftMonitor";

export interface KiteLoginDeps {
  config: KiteConfig;
  captureRequestToken: typeof captureRequestToken;
  exchangeAccessToken: typeof exchangeAccessToken;
  postForm: (url: string, form: Record<string, string>) => Promise<unknown>;
  openExternal: (url: string) => void;
  connectMcp?: (d: ConnectKiteMcpDeps) => Promise<McpConnection>;
  checkDrift?: (listing: ToolListing) => Promise<DriftResult>;
}

export interface KiteSession {
  kite: KiteClient;
  connection: McpConnection;
  drift: DriftResult;
  close(): Promise<void>;
}

function extractAccessToken(tokenResponse: unknown): string {
  const token = (tokenResponse as { data?: { access_token?: unknown } })?.data?.access_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("kite session/token response did not include data.access_token");
  }
  return token;
}

export async function runKiteLogin(deps: KiteLoginDeps): Promise<KiteSession> {
  const connectMcp = deps.connectMcp ?? connectKiteMcp;
  const checkDrift = deps.checkDrift ?? checkKiteToolDrift;
  const { apiKey, apiSecret, loginPort } = deps.config;

  const loginUrl = `https://kite.zerodha.com/connect/login?api_key=${apiKey}&v=3`;
  const requestToken = await deps.captureRequestToken({ port: loginPort, loginUrl, openExternal: deps.openExternal });
  const tokenResponse = await deps.exchangeAccessToken({ apiKey, apiSecret, requestToken, postForm: deps.postForm });
  const accessToken = extractAccessToken(tokenResponse);

  const connection = await connectMcp({ apiKey, accessToken });
  const kite = new KiteClient(connection.caller);
  const drift = await checkDrift(connection.listing);

  return { kite, connection, drift, close: connection.close };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron-app && npx vitest run test/main/services/kite/kiteLogin.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/kite/kiteLogin.ts electron-app/test/main/services/kite/kiteLogin.test.ts
git commit -m "feat(kite): orchestrate OAuth -> token -> MCP connect -> drift login flow"
```

---

### Task 4: Engine-Only deterministic response generator

**Files:**
- Create: `electron-app/src/main/services/analysis/deterministicResponseGenerator.ts`
- Test: `electron-app/test/main/services/analysis/deterministicResponseGenerator.test.ts`

**Interfaces:**
- Consumes: `Direction`, `Conviction`, `AnalysisEnvelope` from `services/analysis/contracts.ts`; `AlgoResultWire`, `ConfluenceWire` from `services/sidecar/sidecarProtocol.ts`.
- Produces:
  - `interface DeterministicResponse { direction: Direction; conviction: Conviction; text: string; confluence: ConfluenceWire }`
  - `function generateDeterministicResponse(envelope: AnalysisEnvelope, opts?: { variant?: "concise" | "full" }): DeterministicResponse` (default variant `"concise"`).

**Templating rules (from P5a§7):** direction from `confluence.weighted_vote` with a `±0.05` deadband; conviction from the count agreement ratio (`dominant/total`: `≥0.66` high, `≥0.5` medium, else low; `total===0` → low) — **not** any per-algo `confidence`; per-algo lines lowercase the wire's `"Bullish"` casing; concise cites the top 3 by `|magnitude|` (ties by `confidence`), full cites every entry; a confluence summary line; a fixed descriptive closing line. **No fragment is ever an imperative directive.**

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/main/services/analysis/deterministicResponseGenerator.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { generateDeterministicResponse } from "../../../../src/main/services/analysis/deterministicResponseGenerator";
import type { AnalysisEnvelope } from "../../../../src/main/services/analysis/contracts";
import type { AlgoResultWire, ConfluenceWire } from "../../../../src/main/services/sidecar/sidecarProtocol";

const IMPERATIVE = /\b(buy|sell|hold|add|reduce|book|exit|enter|watch)\b/i;

function algo(id: string, direction: string, magnitude: number, confidence: number): AlgoResultWire {
  return {
    algo_id: id,
    symbol: "NSE:INFY",
    timeframe: "day",
    horizon: "positional",
    direction,
    magnitude,
    confidence,
    evidence: [`${id} evidence`],
    computed_at: "2026-07-25T00:00:00+00:00",
  };
}

function envelope(algo_results: AlgoResultWire[], confluence: ConfluenceWire): AnalysisEnvelope {
  return {
    trigger: "reactive",
    instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
    horizon_requested: "positional",
    intent_lens: "buying",
    algo_results,
    confluence,
    overlays: {},
  };
}

describe("generateDeterministicResponse", () => {
  it("maps a bullish-heavy scorecard to bullish/high", () => {
    const env = envelope(
      [algo("rsi", "Bullish", 0.6, 0.71), algo("macd", "Bullish", 0.4, 0.6)],
      { bullish_count: 4, bearish_count: 1, neutral_count: 0, weighted_vote: 0.62 },
    );
    const out = generateDeterministicResponse(env);
    expect(out.direction).toBe("bullish");
    expect(out.conviction).toBe("high");
    expect(out.text).toContain("weighted vote +0.62");
  });

  it("maps a bearish-heavy scorecard to bearish", () => {
    const env = envelope([algo("rsi", "Bearish", 0.5, 0.7)], {
      bullish_count: 1,
      bearish_count: 4,
      neutral_count: 0,
      weighted_vote: -0.6,
    });
    expect(generateDeterministicResponse(env).direction).toBe("bearish");
  });

  it("treats a near-zero vote as neutral with low conviction", () => {
    const env = envelope([algo("rsi", "Neutral", 0.01, 0.5)], {
      bullish_count: 2,
      bearish_count: 2,
      neutral_count: 1,
      weighted_vote: 0.02,
    });
    const out = generateDeterministicResponse(env);
    expect(out.direction).toBe("neutral");
    expect(out.conviction).toBe("low");
  });

  it("handles an empty envelope without throwing", () => {
    const out = generateDeterministicResponse(
      envelope([], { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 }),
    );
    expect(out.direction).toBe("neutral");
    expect(out.conviction).toBe("low");
    expect(out.text.length).toBeGreaterThan(0);
  });

  it("normalizes wire casing and cites algorithms by id", () => {
    const env = envelope([algo("rsi", "Bullish", 0.6, 0.71)], {
      bullish_count: 1,
      bearish_count: 0,
      neutral_count: 0,
      weighted_vote: 1,
    });
    const out = generateDeterministicResponse(env);
    expect(out.text).toContain("rsi reads a bullish signal");
    expect(out.text).not.toContain("Bullish");
  });

  it("cites more algorithms in full than concise", () => {
    const algos = [
      algo("a", "Bullish", 0.9, 0.9),
      algo("b", "Bullish", 0.8, 0.8),
      algo("c", "Bearish", 0.7, 0.7),
      algo("d", "Neutral", 0.6, 0.6),
      algo("e", "Bullish", 0.5, 0.5),
    ];
    const env = envelope(algos, { bullish_count: 3, bearish_count: 1, neutral_count: 1, weighted_vote: 0.3 });
    const concise = generateDeterministicResponse(env, { variant: "concise" }).text.split("\n").length;
    const full = generateDeterministicResponse(env, { variant: "full" }).text.split("\n").length;
    expect(full).toBeGreaterThan(concise);
  });

  it("never emits an imperative trade directive", () => {
    const cases = [
      envelope([algo("rsi", "Bullish", 0.6, 0.7)], { bullish_count: 5, bearish_count: 0, neutral_count: 0, weighted_vote: 0.9 }),
      envelope([algo("rsi", "Bearish", 0.6, 0.7)], { bullish_count: 0, bearish_count: 5, neutral_count: 0, weighted_vote: -0.9 }),
      envelope([algo("rsi", "Neutral", 0.0, 0.5)], { bullish_count: 2, bearish_count: 2, neutral_count: 1, weighted_vote: 0 }),
    ];
    for (const env of cases) {
      expect(generateDeterministicResponse(env, { variant: "full" }).text).not.toMatch(IMPERATIVE);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron-app && npx vitest run test/main/services/analysis/deterministicResponseGenerator.test.ts`
Expected: FAIL — cannot resolve import `.../deterministicResponseGenerator`.

- [ ] **Step 3: Write the implementation**

Create `electron-app/src/main/services/analysis/deterministicResponseGenerator.ts`:

```typescript
import type { AnalysisEnvelope, Conviction, Direction } from "./contracts";
import type { AlgoResultWire, ConfluenceWire } from "../sidecar/sidecarProtocol";

export interface DeterministicResponse {
  direction: Direction;
  conviction: Conviction;
  text: string;
  confluence: ConfluenceWire;
}

const DIRECTION_DEADBAND = 0.05;
const CONCISE_TOP_N = 3;
const CLOSING_LINE = "Descriptive analysis only — verify every figure in Kite yourself before making any decision.";

function directionFromVote(vote: number): Direction {
  if (vote > DIRECTION_DEADBAND) return "bullish";
  if (vote < -DIRECTION_DEADBAND) return "bearish";
  return "neutral";
}

function convictionFromCounts(c: ConfluenceWire): Conviction {
  const total = c.bullish_count + c.bearish_count + c.neutral_count;
  if (total === 0) return "low";
  const ratio = Math.max(c.bullish_count, c.bearish_count, c.neutral_count) / total;
  if (ratio >= 0.66) return "high";
  if (ratio >= 0.5) return "medium";
  return "low";
}

function formatVote(vote: number): string {
  return `${vote >= 0 ? "+" : ""}${vote.toFixed(2)}`;
}

function rankByMagnitude(results: AlgoResultWire[]): AlgoResultWire[] {
  return [...results].sort((a, b) => {
    const byMagnitude = Math.abs(b.magnitude) - Math.abs(a.magnitude);
    return byMagnitude !== 0 ? byMagnitude : b.confidence - a.confidence;
  });
}

function algoLine(result: AlgoResultWire): string {
  const direction = result.direction.toLowerCase();
  return `${result.algo_id} reads a ${direction} signal (confidence ${result.confidence.toFixed(2)}): ${result.evidence.join("; ")}`;
}

export function generateDeterministicResponse(
  envelope: AnalysisEnvelope,
  opts: { variant?: "concise" | "full" } = {},
): DeterministicResponse {
  const variant = opts.variant ?? "concise";
  const confluence = envelope.confluence;
  const direction = directionFromVote(confluence.weighted_vote);
  const conviction = convictionFromCounts(confluence);

  const ranked = rankByMagnitude(envelope.algo_results);
  const cited = variant === "full" ? ranked : ranked.slice(0, CONCISE_TOP_N);

  const headline = `Overall read: ${direction} (${conviction} conviction).`;
  const summary =
    `Confluence: ${confluence.bullish_count} bullish / ${confluence.bearish_count} bearish / ` +
    `${confluence.neutral_count} neutral, weighted vote ${formatVote(confluence.weighted_vote)}.`;

  const text = [headline, ...cited.map(algoLine), summary, CLOSING_LINE].join("\n");
  return { direction, conviction, text, confluence };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron-app && npx vitest run test/main/services/analysis/deterministicResponseGenerator.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/analysis/deterministicResponseGenerator.ts electron-app/test/main/services/analysis/deterministicResponseGenerator.test.ts
git commit -m "feat(analysis): engine-only deterministic prose generator"
```

---

### Task 5: Renderer IPC contract additions

**Files:**
- Modify: `electron-app/src/main/ipc/rendererApi.ts`
- Modify (update existing assertion): `electron-app/test/main/ipc/rendererApi.test.ts`

**Interfaces:**
- Consumes: `DeterministicResponse` (Task 4); `AlgoResultWire` from `sidecarProtocol.ts`; `InstrumentRef` from `analysis/contracts.ts`.
- Produces (added to `rendererApi.ts`, the shared main↔renderer contract — chosen over the generator file so all three new IPC channel types live in the one module both preload and React import; the imports below are all `import type`, erased at runtime, so no main-only code leaks into the preload bundle):
  - `type Horizon = "intraday" | "positional"`
  - `interface InstrumentSelection { symbol: string; exchange: string; segment: string; instrumentToken: string }`
  - `interface AnalysisRunParams { instrument: InstrumentSelection; horizon: Horizon }`
  - `interface AnalysisResult { mode: "engine_only"; instrument: InstrumentRef; horizon: Horizon; response: DeterministicResponse; algo_results: AlgoResultWire[] }`
  - `type LoginResult = { status: "authenticated" } | { status: "error"; message: string }`
  - `RendererApi` gains `login(): Promise<LoginResult>`, `searchInstruments(query: string): Promise<unknown>`, `runAnalysis(params: AnalysisRunParams): Promise<AnalysisResult>`.
  - `buildRendererApi` wires `login` → `invoke("kite:login")`, `searchInstruments` → `invoke("kite:searchInstruments", { query })`, `runAnalysis` → `invoke("analysis:run", params)`.

- [ ] **Step 1: Update the existing failing test**

The current `rendererApi.test.ts` asserts the api has exactly `["getStatus","onBanner"]`. Update that assertion and add routing tests. Replace the file body of `electron-app/test/main/ipc/rendererApi.test.ts` with:

```typescript
import { describe, expect, it, vi } from "vitest";
import { buildRendererApi } from "../../../src/main/ipc/rendererApi";

describe("buildRendererApi", () => {
  it("exposes exactly the five bridge methods and never leaks the raw transport", () => {
    const api = buildRendererApi(vi.fn().mockResolvedValue({}), vi.fn());
    expect(Object.keys(api).sort()).toEqual(["getStatus", "login", "onBanner", "runAnalysis", "searchInstruments"]);
    expect((api as Record<string, unknown>).ipcRenderer).toBeUndefined();
    expect((api as Record<string, unknown>).invoke).toBeUndefined();
  });

  it("routes getStatus through status:get", async () => {
    const invoke = vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null });
    await buildRendererApi(invoke, vi.fn()).getStatus();
    expect(invoke).toHaveBeenCalledWith("status:get");
  });

  it("registers onBanner against the banner:push channel", () => {
    const subscribe = vi.fn();
    const handler = vi.fn();
    buildRendererApi(vi.fn(), subscribe).onBanner(handler);
    expect(subscribe).toHaveBeenCalledWith("banner:push", handler);
  });

  it("routes login through kite:login", async () => {
    const invoke = vi.fn().mockResolvedValue({ status: "authenticated" });
    expect(await buildRendererApi(invoke, vi.fn()).login()).toEqual({ status: "authenticated" });
    expect(invoke).toHaveBeenCalledWith("kite:login");
  });

  it("routes searchInstruments through kite:searchInstruments with a query payload", async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    await buildRendererApi(invoke, vi.fn()).searchInstruments("infy");
    expect(invoke).toHaveBeenCalledWith("kite:searchInstruments", { query: "infy" });
  });

  it("routes runAnalysis through analysis:run with the params payload", async () => {
    const invoke = vi.fn().mockResolvedValue({ mode: "engine_only" });
    const params = {
      instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
      horizon: "positional" as const,
    };
    await buildRendererApi(invoke, vi.fn()).runAnalysis(params);
    expect(invoke).toHaveBeenCalledWith("analysis:run", params);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron-app && npx vitest run test/main/ipc/rendererApi.test.ts`
Expected: FAIL — `api.login is not a function` / `Object.keys` mismatch.

- [ ] **Step 3: Write the implementation**

Replace the contents of `electron-app/src/main/ipc/rendererApi.ts` with:

```typescript
import type { DeterministicResponse } from "../services/analysis/deterministicResponseGenerator";
import type { InstrumentRef } from "../services/analysis/contracts";
import type { AlgoResultWire } from "../services/sidecar/sidecarProtocol";

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

export type Horizon = "intraday" | "positional";

export interface InstrumentSelection {
  symbol: string;
  exchange: string;
  segment: string;
  instrumentToken: string;
}

export interface AnalysisRunParams {
  instrument: InstrumentSelection;
  horizon: Horizon;
}

export interface AnalysisResult {
  mode: "engine_only";
  instrument: InstrumentRef;
  horizon: Horizon;
  response: DeterministicResponse;
  algo_results: AlgoResultWire[];
}

export type LoginResult = { status: "authenticated" } | { status: "error"; message: string };

export interface RendererApi {
  getStatus(): Promise<AppStatus>;
  onBanner(handler: (banner: BannerEvent) => void): void;
  login(): Promise<LoginResult>;
  searchInstruments(query: string): Promise<unknown>;
  runAnalysis(params: AnalysisRunParams): Promise<AnalysisResult>;
}

export function buildRendererApi(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  subscribe: (channel: string, handler: (payload: unknown) => void) => void,
): RendererApi {
  return {
    getStatus: () => invoke("status:get") as Promise<AppStatus>,
    onBanner: (handler) => subscribe("banner:push", handler as (payload: unknown) => void),
    login: () => invoke("kite:login") as Promise<LoginResult>,
    searchInstruments: (query) => invoke("kite:searchInstruments", { query }),
    runAnalysis: (params) => invoke("analysis:run", params) as Promise<AnalysisResult>,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron-app && npx vitest run test/main/ipc/rendererApi.test.ts && npm run typecheck`
Expected: PASS (6 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/ipc/rendererApi.ts electron-app/test/main/ipc/rendererApi.test.ts
git commit -m "feat(ipc): add login/searchInstruments/runAnalysis to renderer contract"
```

---

### Task 6: Analysis-run logic + IPC bridge registration

**Files:**
- Create: `electron-app/src/main/ipc/analysisBridge.ts`
- Test: `electron-app/test/main/ipc/analysisBridge.test.ts`

**Interfaces:**
- Consumes: `AnalysisRunParams`, `AnalysisResult`, `Horizon`, `LoginResult` (Task 5); `KiteClient` from `kiteClient.ts`; `SidecarSupervisor` from `sidecarSupervisor.ts`; `KiteSession` (Task 3); `assembleEnvelope` from `analysisEnvelope.ts`; `generateDeterministicResponse` (Task 4).
- Produces:
  - `interface HorizonFetchParams { timeframe: string; from: string; to: string }`
  - `function horizonToFetchParams(horizon: Horizon, now: Date): HorizonFetchParams` — `intraday` → `"5minute"` over a ~5-day datetime window; `positional` → `"day"` over a ~365-day date window (bounded by `INTERVAL_LOOKBACK_HINT_DAYS`).
  - `interface RunAnalysisDeps { kite: KiteClient; sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles">; now?: () => Date }`
  - `function runAnalysisRequest(deps: RunAnalysisDeps, params: AnalysisRunParams): Promise<AnalysisResult>` — passes fixed `trigger: "reactive"` and placeholder `intent_lens: "buying"` (P5a§12 tension 1) into `assembleEnvelope`, then generates.
  - `interface AnalysisBridgeDeps { ipcMain: Pick<IpcMain, "handle">; login: () => Promise<LoginResult>; getSession: () => KiteSession | null; sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles">; now?: () => Date }`
  - `function registerAnalysisBridge(deps: AnalysisBridgeDeps): void` — registers `kite:login`, `kite:searchInstruments`, `analysis:run`; the two data channels throw if `getSession()` is null.

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/main/ipc/analysisBridge.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { horizonToFetchParams, registerAnalysisBridge, runAnalysisRequest } from "../../../src/main/ipc/analysisBridge";
import { KiteClient } from "../../../src/main/services/kite/kiteClient";
import type { CandleWire } from "../../../src/main/services/sidecar/sidecarProtocol";
import type { KiteSession } from "../../../src/main/services/kite/kiteLogin";

function historicalResponse() {
  return {
    data: {
      candles: [
        ["2026-01-02T00:00:00+0530", 100, 105, 99, 104, 5000],
        ["2026-01-03T00:00:00+0530", 104, 108, 103, 107, 6000],
      ],
    },
  };
}

function computeResponse() {
  return {
    type: "compute" as const,
    id: 1,
    algo_results: [
      {
        algo_id: "rsi",
        symbol: "NSE:INFY",
        timeframe: "day",
        horizon: "positional",
        direction: "Bullish",
        magnitude: 0.4,
        confidence: 0.6,
        evidence: ["RSI 62"],
        computed_at: "2026-07-25T00:00:00+00:00",
      },
    ],
    confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
  };
}

function mockSidecar() {
  return {
    persistCandles: vi.fn(async (_s: string, _t: string, candles: CandleWire[]) => ({
      type: "persist_candles" as const,
      id: 1,
      written: candles.length,
    })),
    compute: vi.fn(async () => computeResponse()),
  };
}

describe("horizonToFetchParams", () => {
  const now = new Date("2026-07-25T10:30:00+05:30");

  it("maps intraday to a 5minute datetime window", () => {
    const params = horizonToFetchParams("intraday", now);
    expect(params.timeframe).toBe("5minute");
    expect(params.from).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(params.to).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("maps positional to a day date window", () => {
    const params = horizonToFetchParams("positional", now);
    expect(params.timeframe).toBe("day");
    expect(params.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(params.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("runAnalysisRequest", () => {
  it("assembles an envelope and returns a generated engine_only result", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const sidecar = mockSidecar();

    const result = await runAnalysisRequest(
      { kite, sidecar: sidecar as never },
      { instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" }, horizon: "positional" },
    );

    expect(result.mode).toBe("engine_only");
    expect(result.horizon).toBe("positional");
    expect(result.instrument.kite_token_asof).toBe("408065");
    expect(result.response.direction).toBe("bullish");
    expect(result.algo_results[0].algo_id).toBe("rsi");
    expect(sidecar.compute).toHaveBeenCalledWith("NSE:INFY", "day", [104, 107]);
  });
});

describe("registerAnalysisBridge", () => {
  function harness(session: KiteSession | null) {
    const handlers = new Map<string, (event: unknown, arg: unknown) => unknown>();
    const login = vi.fn().mockResolvedValue({ status: "authenticated" });
    registerAnalysisBridge({
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn as never) } as never,
      login,
      getSession: () => session,
      sidecar: mockSidecar() as never,
    });
    return { handlers, login };
  }

  it("routes kite:login to the injected login effect", async () => {
    const { handlers, login } = harness(null);
    await handlers.get("kite:login")!(null, undefined);
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("rejects searchInstruments and analysis:run when there is no session", async () => {
    const { handlers } = harness(null);
    expect(() => handlers.get("kite:searchInstruments")!(null, { query: "infy" })).toThrow(/not logged in/);
    expect(() =>
      handlers.get("analysis:run")!(null, {
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        horizon: "positional",
      }),
    ).toThrow(/not logged in/);
  });

  it("forwards searchInstruments to the live session's KiteClient", async () => {
    const callTool = vi.fn().mockResolvedValue({ data: [] });
    const session = { kite: new KiteClient({ callTool }) } as KiteSession;
    const { handlers } = harness(session);
    await handlers.get("kite:searchInstruments")!(null, { query: "infy" });
    expect(callTool).toHaveBeenCalledWith("search_instruments", { query: "infy" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron-app && npx vitest run test/main/ipc/analysisBridge.test.ts`
Expected: FAIL — cannot resolve import `.../analysisBridge`.

- [ ] **Step 3: Write the implementation**

Create `electron-app/src/main/ipc/analysisBridge.ts`:

```typescript
import type { IpcMain } from "electron";
import type { AnalysisRunParams, AnalysisResult, Horizon, LoginResult } from "./rendererApi";
import type { KiteClient } from "../services/kite/kiteClient";
import type { KiteSession } from "../services/kite/kiteLogin";
import type { SidecarSupervisor } from "../services/sidecar/sidecarSupervisor";
import { assembleEnvelope } from "../services/analysis/analysisEnvelope";
import { generateDeterministicResponse } from "../services/analysis/deterministicResponseGenerator";

const INTRADAY_LOOKBACK_DAYS = 5;
const POSITIONAL_LOOKBACK_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface HorizonFetchParams {
  timeframe: string;
  from: string;
  to: string;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDateTime(d: Date): string {
  return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function horizonToFetchParams(horizon: Horizon, now: Date): HorizonFetchParams {
  if (horizon === "intraday") {
    const from = new Date(now.getTime() - INTRADAY_LOOKBACK_DAYS * DAY_MS);
    return { timeframe: "5minute", from: formatDateTime(from), to: formatDateTime(now) };
  }
  const from = new Date(now.getTime() - POSITIONAL_LOOKBACK_DAYS * DAY_MS);
  return { timeframe: "day", from: formatDate(from), to: formatDate(now) };
}

export interface RunAnalysisDeps {
  kite: KiteClient;
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles">;
  now?: () => Date;
}

export async function runAnalysisRequest(deps: RunAnalysisDeps, params: AnalysisRunParams): Promise<AnalysisResult> {
  const now = deps.now?.() ?? new Date();
  const { timeframe, from, to } = horizonToFetchParams(params.horizon, now);
  const envelope = await assembleEnvelope(
    { kite: deps.kite, sidecar: deps.sidecar },
    {
      trigger: "reactive",
      instrument: params.instrument,
      timeframe,
      horizon_requested: params.horizon,
      // 5a templates only over algo_results/confluence; intent_lens is unused here
      // and passed fixed to satisfy the required envelope field (P5a§12 tension 1).
      intent_lens: "buying",
      from,
      to,
    },
  );
  const response = generateDeterministicResponse(envelope);
  return {
    mode: "engine_only",
    instrument: envelope.instrument,
    horizon: params.horizon,
    response,
    algo_results: envelope.algo_results,
  };
}

export interface AnalysisBridgeDeps {
  ipcMain: Pick<IpcMain, "handle">;
  login: () => Promise<LoginResult>;
  getSession: () => KiteSession | null;
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles">;
  now?: () => Date;
}

function requireSession(getSession: () => KiteSession | null): KiteSession {
  const session = getSession();
  if (!session) throw new Error("not logged in to Kite");
  return session;
}

export function registerAnalysisBridge(deps: AnalysisBridgeDeps): void {
  deps.ipcMain.handle("kite:login", () => deps.login());
  deps.ipcMain.handle("kite:searchInstruments", (_event, args: { query: string }) =>
    requireSession(deps.getSession).kite.searchInstruments(args.query),
  );
  deps.ipcMain.handle("analysis:run", (_event, params: AnalysisRunParams) =>
    runAnalysisRequest({ kite: requireSession(deps.getSession).kite, sidecar: deps.sidecar, now: deps.now }, params),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron-app && npx vitest run test/main/ipc/analysisBridge.test.ts && npm run typecheck`
Expected: PASS (7 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/ipc/analysisBridge.ts electron-app/test/main/ipc/analysisBridge.test.ts
git commit -m "feat(ipc): analysis-run logic and login/search/analysis bridge handlers"
```

---

### Task 7: Bootstrap & main-process integration

**Files:**
- Modify: `electron-app/src/main/bootstrap.ts`
- (No change to `main.ts` — it already calls `runtime.stop()` on `window-all-closed`, and `stop()` now also closes the session.)

**Interfaces:**
- Consumes: `loadKiteConfig` (Task 1); `runKiteLogin`, `KiteSession` (Task 3); `registerAnalysisBridge` (Task 6); `captureRequestToken`, `exchangeAccessToken` from `kiteOAuth.ts`; `LoginResult`, `BannerEvent` from `rendererApi.ts`.
- Produces: no new exported types. `createApp` calls `loadKiteConfig()` at startup (fails loudly if `.env` is absent), holds `let session: KiteSession | null`, exposes a real `login` effect (runs `runKiteLogin`, pushes an `mcpDrift` banner + sets `driftWarning` on drift, calls `sessionState.markAuthenticated()`/`markNeedsLogin()`), registers the analysis bridge, and tears the session down in `stop()`.

This task is integration glue over already-unit-tested seams (`runKiteLogin`, `runAnalysisRequest`, `registerAnalysisBridge`); it imports `electron` and constructs real objects, so — like the existing untested `bootstrap.ts`/`main.ts` — it is verified by typecheck + the full suite + the Task 10 manual checklist rather than a new unit test.

- [ ] **Step 1: Rewrite `bootstrap.ts`**

Replace the contents of `electron-app/src/main/bootstrap.ts` with:

```typescript
import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { mainWindowOptions } from "./mainWindow";
import { SidecarSupervisor } from "./services/sidecar/sidecarSupervisor";
import { KiteSessionState } from "./services/kite/kiteSessionState";
import { loadKiteConfig } from "./services/kite/kiteConfig";
import { runKiteLogin } from "./services/kite/kiteLogin";
import type { KiteSession } from "./services/kite/kiteLogin";
import { captureRequestToken, exchangeAccessToken } from "./services/kite/kiteOAuth";
import { registerStatusBridge } from "./ipc/appBridge";
import { registerAnalysisBridge } from "./ipc/analysisBridge";
import type { AppStatus, BannerEvent, LoginResult, SidecarStatus } from "./ipc/rendererApi";

export interface AppRuntime {
  start(): void;
  stop(): void;
}

async function postForm(url: string, form: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Kite-Version": "3" },
    body: new URLSearchParams(form).toString(),
  });
  return response.json();
}

export function createApp(): AppRuntime {
  const config = loadKiteConfig();
  const supervisor = new SidecarSupervisor({
    binaryPath:
      process.env.SIDECAR_BINARY ??
      path.join(__dirname, "..", "..", "..", "rust-core", "target", "debug", "sidecar"),
    lakeRoot: process.env.TRADE_ASSISTANT_LAKE ?? path.join(app.getPath("userData"), "candle-lake"),
  });
  const sessionState = new KiteSessionState();

  let sidecarStatus: SidecarStatus = "down";
  let driftWarning: string | null = null;
  let session: KiteSession | null = null;
  const bannerHandlers: ((banner: BannerEvent) => void)[] = [];

  supervisor.on("statusChange", (status: SidecarStatus) => {
    sidecarStatus = status;
  });
  sessionState.on("banner", (banner: BannerEvent) => bannerHandlers.forEach((handler) => handler(banner)));

  const currentStatus = (): AppStatus => ({ sidecar: sidecarStatus, kiteSession: sessionState.status, driftWarning });

  const login = async (): Promise<LoginResult> => {
    try {
      session = await runKiteLogin({
        config,
        captureRequestToken,
        exchangeAccessToken,
        postForm,
        openExternal: (url) => shell.openExternal(url),
      });
      if (session.drift.hasDrift) {
        driftWarning = `MCP tools changed: added [${session.drift.added.join(", ")}], removed [${session.drift.removed.join(", ")}]`;
        const banner: BannerEvent = { kind: "mcpDrift", message: driftWarning };
        bannerHandlers.forEach((handler) => handler(banner));
      }
      sessionState.markAuthenticated();
      return { status: "authenticated" };
    } catch (error) {
      sessionState.markNeedsLogin();
      return { status: "error", message: (error as Error).message };
    }
  };

  const createMainWindow = (): BrowserWindow => {
    const window = new BrowserWindow(mainWindowOptions(path.join(__dirname, "..", "preload", "preload.js")));
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
    registerAnalysisBridge({ ipcMain, login, getSession: () => session, sidecar: supervisor });
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
      void session?.close();
      supervisor.stop();
    },
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd electron-app && npm run typecheck`
Expected: passes.

- [ ] **Step 3: Run the full suite (nothing regressed)**

Run: `cd electron-app && npm test`
Expected: all existing + new tests PASS (bootstrap is not imported by any test, so a missing `.env` does not affect the suite).

- [ ] **Step 4: Commit**

```bash
git add electron-app/src/main/bootstrap.ts
git commit -m "feat(app): wire config load, live login session, and analysis bridge in bootstrap"
```

---

### Task 8: React tooling + App shell

**Files:**
- Modify: `electron-app/package.json` (react/react-dom deps + React/testing devDeps)
- Modify: `electron-app/electron.vite.config.ts` (`react()` renderer plugin)
- Modify: `electron-app/vitest.config.ts` (`react()` plugin + `.tsx` include glob)
- Modify: `electron-app/tsconfig.json` (`"jsx": "react-jsx"`)
- Modify: `electron-app/src/renderer/index.html` (`#root` + `main.tsx`, `style-src 'self'`)
- Create: `electron-app/src/renderer/main.tsx`
- Create: `electron-app/src/renderer/App.tsx`
- Create: `electron-app/src/renderer/style.css`
- Delete: `electron-app/src/renderer/status.ts`
- Test: `electron-app/test/renderer/App.test.tsx`

**Interfaces:**
- Consumes: `RendererApi`, `AppStatus`, `BannerEvent`, `LoginResult` (Task 5) — types only, via `window.tradeAssistant`.
- Produces: `function App(): JSX.Element` (default-less named export) rendering the status line, banner list, and a **Login to Kite** button; the analysis form area is empty until Task 9 fills it. The bridge is read lazily via a `bridge()` helper so tests can install `window.tradeAssistant` before render.

- [ ] **Step 1: Install React + test tooling**

Run:
```bash
cd electron-app && npm install --save react@^18 react-dom@^18 && npm install --save-dev @types/react@^18 @types/react-dom@^18 @vitejs/plugin-react @testing-library/react@^16 @testing-library/dom jsdom
```
Expected: `dependencies` gains `react`, `react-dom`; `devDependencies` gains the rest.

- [ ] **Step 2: Configure the build, test runner, and TS for JSX**

In `electron-app/electron.vite.config.ts`, add the import and the plugin. Add near the top:

```typescript
import react from "@vitejs/plugin-react";
```

and change the renderer `plugins` array to include `react()` alongside the existing dev-CSP plugin:

```typescript
    plugins: [
      react(),
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
```

Replace the contents of `electron-app/vitest.config.ts` with:

```typescript
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
```

In `electron-app/tsconfig.json`, add `"jsx": "react-jsx"` to `compilerOptions` and add `"**/*.test.tsx"` to `exclude`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2022", "DOM"],
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  },
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts", "**/*.test.tsx", "node_modules", "out"]
}
```

- [ ] **Step 3: Write the failing component test**

Create `electron-app/test/renderer/App.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/App";

afterEach(cleanup);

function installBridge(overrides: Record<string, unknown> = {}) {
  const bridge = {
    getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "needsLogin", driftWarning: null }),
    onBanner: vi.fn(),
    login: vi.fn().mockResolvedValue({ status: "authenticated" }),
    searchInstruments: vi.fn().mockResolvedValue({ data: [] }),
    runAnalysis: vi.fn(),
    ...overrides,
  };
  (window as unknown as { tradeAssistant: unknown }).tradeAssistant = bridge;
  return bridge;
}

describe("App", () => {
  it("renders the status line from the bridge", async () => {
    installBridge();
    render(<App />);
    expect(await screen.findByText(/sidecar: up \| kite: needsLogin/)).toBeTruthy();
  });

  it("shows the Login button before authentication and no analysis form", async () => {
    installBridge();
    render(<App />);
    expect(await screen.findByRole("button", { name: /login to kite/i })).toBeTruthy();
    expect(screen.queryByLabelText(/instrument search/i)).toBeNull();
  });

  it("logs in and reflects authenticated status", async () => {
    const bridge = installBridge({
      getStatus: vi
        .fn()
        .mockResolvedValueOnce({ sidecar: "up", kiteSession: "needsLogin", driftWarning: null })
        .mockResolvedValueOnce({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /login to kite/i }));
    await waitFor(() => expect(bridge.login).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/kite: authenticated/)).toBeTruthy();
  });

  it("shows the returned error message when login fails", async () => {
    installBridge({ login: vi.fn().mockResolvedValue({ status: "error", message: "no session" }) });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /login to kite/i }));
    expect(await screen.findByText(/no session/)).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd electron-app && npx vitest run test/renderer/App.test.tsx`
Expected: FAIL — cannot resolve import `.../App`.

- [ ] **Step 5: Write `App.tsx`, `main.tsx`, `style.css`, and update `index.html`**

Create `electron-app/src/renderer/App.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { AppStatus, BannerEvent, RendererApi } from "../main/ipc/rendererApi";

function bridge(): RendererApi {
  return (window as unknown as { tradeAssistant: RendererApi }).tradeAssistant;
}

export function App(): JSX.Element {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [banners, setBanners] = useState<BannerEvent[]>([]);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    void bridge()
      .getStatus()
      .then(setStatus);
    bridge().onBanner((banner) => setBanners((prev) => [...prev, banner]));
  }, []);

  const onLogin = async (): Promise<void> => {
    setLoggingIn(true);
    setLoginError(null);
    const result = await bridge().login();
    setLoggingIn(false);
    if (result.status === "authenticated") setStatus(await bridge().getStatus());
    else setLoginError(result.message);
  };

  const authenticated = status?.kiteSession === "authenticated";

  return (
    <main className="app">
      <h1>Trade Assistant</h1>
      <div className="status">
        {status ? `sidecar: ${status.sidecar} | kite: ${status.kiteSession}` : "Loading…"}
      </div>
      <ul className="banners">
        {banners.map((banner, index) => (
          <li key={index}>
            [{banner.kind}] {banner.message}
          </li>
        ))}
      </ul>
      {!authenticated && (
        <button type="button" onClick={onLogin} disabled={loggingIn}>
          {loggingIn ? "Logging in…" : "Login to Kite"}
        </button>
      )}
      {loginError && <div className="error">{loginError}</div>}
    </main>
  );
}
```

Create `electron-app/src/renderer/main.tsx`:

```tsx
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";

const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
```

Create `electron-app/src/renderer/style.css`:

```css
body {
  font-family: system-ui, sans-serif;
  margin: 0;
  padding: 1.5rem;
}

.app h1 {
  font-size: 1.25rem;
}

.status {
  color: #444;
  margin-bottom: 0.75rem;
}

.banners {
  list-style: none;
  padding: 0;
  color: #92400e;
}

.error {
  color: #b91c1c;
  margin-top: 0.5rem;
}

.analysis-form,
.analysis-result {
  margin-top: 1.25rem;
}

.results {
  list-style: none;
  padding: 0;
}
```

Replace the contents of `electron-app/src/renderer/index.html` with:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'self'; style-src 'self'; object-src 'none'"
    />
    <title>Trade Assistant</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

Delete the old stub:

```bash
git rm electron-app/src/renderer/status.ts
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd electron-app && npx vitest run test/renderer/App.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 7: Typecheck and build the renderer**

Run: `cd electron-app && npm run typecheck && npm run build`
Expected: typecheck clean; `electron-vite build` produces `out/renderer` with the React bundle and no CSP/JSX errors.

- [ ] **Step 8: Commit**

```bash
git add electron-app/package.json electron-app/package-lock.json electron-app/electron.vite.config.ts electron-app/vitest.config.ts electron-app/tsconfig.json electron-app/src/renderer/index.html electron-app/src/renderer/main.tsx electron-app/src/renderer/App.tsx electron-app/src/renderer/style.css electron-app/test/renderer/App.test.tsx
git rm electron-app/src/renderer/status.ts
git commit -m "feat(renderer): React tooling and App shell with login button and status"
```

---

### Task 9: React analysis components (instrument search, horizon, result)

**Files:**
- Create: `electron-app/src/renderer/InstrumentSearch.tsx`
- Create: `electron-app/src/renderer/AnalysisResult.tsx`
- Modify: `electron-app/src/renderer/App.tsx` (render the form when authenticated; run analysis; show result)
- Test: `electron-app/test/renderer/InstrumentSearch.test.tsx`
- Test: `electron-app/test/renderer/AnalysisResult.test.tsx`
- Test (extend): `electron-app/test/renderer/App.test.tsx`

**Interfaces:**
- Consumes: `RendererApi`, `InstrumentSelection`, `Horizon`, `AnalysisResult` (Task 5).
- Produces:
  - `function parseInstruments(raw: unknown): InstrumentSelection[]` — defensively reads an array from `raw.data` (Kite REST convention; exact live shape is a manual-verify item) and maps each to `{ symbol: "<exchange>:<tradingsymbol>", exchange, segment, instrumentToken }`.
  - `interface InstrumentSearchProps { onSubmit: (instrument: InstrumentSelection, horizon: Horizon) => void }`
  - `function InstrumentSearch(props: InstrumentSearchProps): JSX.Element` — debounced (300ms) search input, a results list, a horizon radio group (`intraday` | `positional`), and a Submit button.
  - `interface AnalysisResultViewProps { result: AnalysisResult }`
  - `function AnalysisResultView(props: AnalysisResultViewProps): JSX.Element` — renders `response.text` as a plain text node plus the raw confluence numbers. (Named `AnalysisResultView` to avoid colliding with the `AnalysisResult` type it imports.)

- [ ] **Step 1: Write the failing component tests**

Create `electron-app/test/renderer/InstrumentSearch.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstrumentSearch, parseInstruments } from "../../src/renderer/InstrumentSearch";

afterEach(cleanup);

function installBridge(searchImpl: (q: string) => Promise<unknown>) {
  (window as unknown as { tradeAssistant: unknown }).tradeAssistant = {
    getStatus: vi.fn(),
    onBanner: vi.fn(),
    login: vi.fn(),
    searchInstruments: vi.fn(searchImpl),
    runAnalysis: vi.fn(),
  };
}

describe("parseInstruments", () => {
  it("maps the Kite search payload to InstrumentSelection[]", () => {
    const parsed = parseInstruments({
      data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
    });
    expect(parsed).toEqual([{ symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" }]);
  });

  it("returns [] for an unrecognized payload", () => {
    expect(parseInstruments({ nope: true })).toEqual([]);
  });
});

describe("InstrumentSearch", () => {
  it("debounces the query and lists results", async () => {
    installBridge(async () => ({
      data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
    }));
    render(<InstrumentSearch onSubmit={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/instrument search/i), { target: { value: "infy" } });
    expect(await screen.findByRole("button", { name: "NSE:INFY" })).toBeTruthy();
  });

  it("submits the selected instrument and chosen horizon", async () => {
    installBridge(async () => ({
      data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
    }));
    const onSubmit = vi.fn();
    render(<InstrumentSearch onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/instrument search/i), { target: { value: "infy" } });
    fireEvent.click(await screen.findByRole("button", { name: "NSE:INFY" }));
    fireEvent.click(screen.getByLabelText(/positional/i));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        "positional",
      ),
    );
  });
});
```

Create `electron-app/test/renderer/AnalysisResult.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AnalysisResultView } from "../../src/renderer/AnalysisResult";
import type { AnalysisResult } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);

const result: AnalysisResult = {
  mode: "engine_only",
  instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
  horizon: "positional",
  response: {
    direction: "bullish",
    conviction: "high",
    text: "Overall read: bullish (high conviction).\nConfluence: 4 bullish / 1 bearish / 0 neutral, weighted vote +0.62.",
    confluence: { bullish_count: 4, bearish_count: 1, neutral_count: 0, weighted_vote: 0.62 },
  },
  algo_results: [],
};

describe("AnalysisResultView", () => {
  it("renders the prose and the raw confluence numbers", () => {
    render(<AnalysisResultView result={result} />);
    expect(screen.getByText(/Overall read: bullish/)).toBeTruthy();
    expect(screen.getByText("bullish")).toBeTruthy();
    expect(screen.getByText("0.62")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd electron-app && npx vitest run test/renderer/InstrumentSearch.test.tsx test/renderer/AnalysisResult.test.tsx`
Expected: FAIL — cannot resolve `.../InstrumentSearch` and `.../AnalysisResult`.

- [ ] **Step 3: Write `InstrumentSearch.tsx` and `AnalysisResult.tsx`**

Create `electron-app/src/renderer/InstrumentSearch.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { Horizon, InstrumentSelection, RendererApi } from "../main/ipc/rendererApi";

function bridge(): RendererApi {
  return (window as unknown as { tradeAssistant: RendererApi }).tradeAssistant;
}

interface RawInstrument {
  tradingsymbol?: string;
  symbol?: string;
  exchange?: string;
  segment?: string;
  instrument_token?: number | string;
}

export function parseInstruments(raw: unknown): InstrumentSelection[] {
  const list = (raw as { data?: unknown })?.data ?? raw;
  if (!Array.isArray(list)) return [];
  return list
    .map((entry: RawInstrument) => {
      const tradingsymbol = String(entry.tradingsymbol ?? entry.symbol ?? "");
      const exchange = String(entry.exchange ?? "");
      return {
        symbol: exchange && tradingsymbol ? `${exchange}:${tradingsymbol}` : tradingsymbol,
        exchange,
        segment: String(entry.segment ?? ""),
        instrumentToken: String(entry.instrument_token ?? ""),
      };
    })
    .filter((instrument) => instrument.symbol.length > 0);
}

export interface InstrumentSearchProps {
  onSubmit: (instrument: InstrumentSelection, horizon: Horizon) => void;
}

const SEARCH_DEBOUNCE_MS = 300;

export function InstrumentSearch({ onSubmit }: InstrumentSearchProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<InstrumentSelection[]>([]);
  const [selected, setSelected] = useState<InstrumentSelection | null>(null);
  const [horizon, setHorizon] = useState<Horizon>("intraday");

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setResults(parseInstruments(await bridge().searchInstruments(query)));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <section className="analysis-form">
      <input
        aria-label="instrument search"
        placeholder="Search instrument"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul className="results">
        {results.map((instrument) => (
          <li key={instrument.instrumentToken}>
            <button type="button" onClick={() => setSelected(instrument)}>
              {instrument.symbol}
            </button>
          </li>
        ))}
      </ul>
      <fieldset>
        <legend>Horizon</legend>
        <label>
          <input type="radio" name="horizon" checked={horizon === "intraday"} onChange={() => setHorizon("intraday")} />
          Intraday
        </label>
        <label>
          <input type="radio" name="horizon" checked={horizon === "positional"} onChange={() => setHorizon("positional")} />
          Positional
        </label>
      </fieldset>
      <button type="button" disabled={!selected} onClick={() => selected && onSubmit(selected, horizon)}>
        Analyze {selected ? selected.symbol : ""}
      </button>
    </section>
  );
}
```

Create `electron-app/src/renderer/AnalysisResult.tsx`:

```tsx
import type { AnalysisResult } from "../main/ipc/rendererApi";

export interface AnalysisResultViewProps {
  result: AnalysisResult;
}

export function AnalysisResultView({ result }: AnalysisResultViewProps): JSX.Element {
  const { response } = result;
  return (
    <section className="analysis-result">
      <p className="prose">{response.text}</p>
      <dl className="confluence">
        <div>
          <dt>Direction</dt>
          <dd>{response.direction}</dd>
        </div>
        <div>
          <dt>Conviction</dt>
          <dd>{response.conviction}</dd>
        </div>
        <div>
          <dt>Bullish</dt>
          <dd>{response.confluence.bullish_count}</dd>
        </div>
        <div>
          <dt>Bearish</dt>
          <dd>{response.confluence.bearish_count}</dd>
        </div>
        <div>
          <dt>Neutral</dt>
          <dd>{response.confluence.neutral_count}</dd>
        </div>
        <div>
          <dt>Weighted vote</dt>
          <dd>{response.confluence.weighted_vote}</dd>
        </div>
      </dl>
    </section>
  );
}
```

- [ ] **Step 4: Wire the components into `App.tsx`**

In `electron-app/src/renderer/App.tsx`, add the imports:

```tsx
import { InstrumentSearch } from "./InstrumentSearch";
import { AnalysisResultView } from "./AnalysisResult";
import type { AnalysisResult, Horizon, InstrumentSelection, RendererApi } from "../main/ipc/rendererApi";
```

(replacing the existing `import type { AppStatus, BannerEvent, RendererApi } from "../main/ipc/rendererApi";` line with one that also imports `AppStatus` and `BannerEvent` — i.e. `import type { AnalysisResult, AppStatus, BannerEvent, Horizon, InstrumentSelection, RendererApi } from "../main/ipc/rendererApi";`).

Add result state and a submit handler inside `App`, after the `loginError` state:

```tsx
  const [result, setResult] = useState<AnalysisResult | null>(null);

  const onAnalyze = async (instrument: InstrumentSelection, horizon: Horizon): Promise<void> => {
    setResult(await bridge().runAnalysis({ instrument, horizon }));
  };
```

Replace the JSX between the `loginError` line and the closing `</main>` so the authenticated form and result render:

```tsx
      {loginError && <div className="error">{loginError}</div>}
      {authenticated && <InstrumentSearch onSubmit={onAnalyze} />}
      {result && <AnalysisResultView result={result} />}
    </main>
```

- [ ] **Step 5: Extend the App test for the end-to-end analysis render**

Append this test inside the `describe("App", …)` block in `electron-app/test/renderer/App.test.tsx`:

```tsx
  it("runs an analysis when authenticated and renders the prose", async () => {
    installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      searchInstruments: vi.fn().mockResolvedValue({
        data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      }),
      runAnalysis: vi.fn().mockResolvedValue({
        mode: "engine_only",
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
        horizon: "positional",
        response: {
          direction: "bullish",
          conviction: "high",
          text: "Overall read: bullish (high conviction).",
          confluence: { bullish_count: 4, bearish_count: 1, neutral_count: 0, weighted_vote: 0.62 },
        },
        algo_results: [],
      }),
    });
    render(<App />);

    fireEvent.change(await screen.findByLabelText(/instrument search/i), { target: { value: "infy" } });
    fireEvent.click(await screen.findByRole("button", { name: "NSE:INFY" }));
    fireEvent.click(screen.getByLabelText(/positional/i));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));

    expect(await screen.findByText(/Overall read: bullish/)).toBeTruthy();
  });
```

- [ ] **Step 6: Run the renderer tests to verify they pass**

Run: `cd electron-app && npx vitest run test/renderer`
Expected: PASS (App: 5 tests; InstrumentSearch: 4; AnalysisResult: 1).

- [ ] **Step 7: Typecheck and build**

Run: `cd electron-app && npm run typecheck && npm run build`
Expected: clean typecheck; successful renderer build.

- [ ] **Step 8: Commit**

```bash
git add electron-app/src/renderer/InstrumentSearch.tsx electron-app/src/renderer/AnalysisResult.tsx electron-app/src/renderer/App.tsx electron-app/test/renderer/InstrumentSearch.test.tsx electron-app/test/renderer/AnalysisResult.test.tsx electron-app/test/renderer/App.test.tsx
git commit -m "feat(renderer): instrument search, horizon selector, and analysis result view"
```

---

### Task 10: End-to-end integration test + manual verification checklist

**Files:**
- Modify: `electron-app/test/endToEnd.integration.test.ts` (also run the deterministic generator over the assembled envelope)

**Interfaces:**
- Consumes: `assembleEnvelope` from `analysisEnvelope.ts`; `generateDeterministicResponse` (Task 4). No new production code.

- [ ] **Step 1: Extend the end-to-end integration test**

Add these imports to the top of `electron-app/test/endToEnd.integration.test.ts`:

```typescript
import { assembleEnvelope } from "../src/main/services/analysis/analysisEnvelope";
import { generateDeterministicResponse } from "../src/main/services/analysis/deterministicResponseGenerator";
```

Add this test inside the existing `describe.skipIf(!existsSync(SIDECAR))(…)` block, after the existing `it(…)`:

```typescript
  it("generates non-directive engine-only prose from a real assembled envelope", async () => {
    const lake = mkdtempSync(path.join(tmpdir(), "ta-e2e-gen-"));
    const supervisor = new SidecarSupervisor({ binaryPath: SIDECAR, lakeRoot: lake });
    supervisor.start();

    try {
      const envelope = await assembleEnvelope(
        { kite: recordedKite(), sidecar: supervisor },
        {
          trigger: "reactive",
          instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
          timeframe: "day",
          horizon_requested: "positional",
          intent_lens: "buying",
          from: "2026-01-01",
          to: "2026-01-20",
        },
      );

      const response = generateDeterministicResponse(envelope);

      expect(Number.isNaN(response.confluence.weighted_vote)).toBe(false);
      expect(["bullish", "bearish", "neutral"]).toContain(response.direction);
      expect(response.text).not.toMatch(/\b(buy|sell|hold|add|reduce|book|exit|enter|watch)\b/i);
    } finally {
      await supervisor.stop();
    }
  });
```

- [ ] **Step 2: Run the whole suite**

Run: `cd electron-app && npm test`
Expected: all tests PASS. The new e2e test runs only when the sidecar binary exists (`describe.skipIf`), matching the existing gate; it never touches live Kite.

- [ ] **Step 3: Run the automatable golden-path manual checks**

Copy the example env and launch:

```bash
cd electron-app && cp .env.example .env && npm start
```

Confirm by hand (P5a§11 automatable golden path):
- The window opens; in DevTools console `window.tradeAssistant` is an object, and `window.require` / `window.ipcRenderer` are both `undefined` (security posture holds).
- The status line renders (`sidecar: … | kite: …`); the **Login to Kite** button is present; before login, the instrument search input is not shown.

Then remove the throwaway `.env`:

```bash
cd electron-app && rm .env
```

- [ ] **Step 4: Record the live-Kite follow-ups (manual, non-blocking — requires a real paid Kite Connect account)**

These are a checklist to run when a live session is available; they are **not** an automated gate for calling 5a done (P5a§11):
- Click **Login** → confirm the loopback + system-browser OAuth flow: the real system browser opens the Kite login URL, redirects to `http://127.0.0.1:<port>/…`, `request_token` is captured, the "you can close this tab" page shows.
- Confirm `exchangeAccessToken` returns a real `access_token` from `/session/token`.
- Confirm `connectKiteMcp` connects to `https://mcp.kite.trade/mcp` and that the `Authorization: token api_key:access_token` header is **actually honored** by the hosted server (P5a§5 / tension 2). If not, record what the hosted MCP actually expects (e.g. its own `login`-tool OAuth) — the one integration detail 5a cannot verify offline.
- Run `checkKiteToolDrift` against the **live** `tools/list`; record any tool names beyond `EXPECTED_KITE_TOOLS` and pin them into that baseline (feeds Phase 3 Task 5 Step 6) — the first real execution of layer-3 drift detection.
- Confirm the raw `search_instruments` payload shape matches `parseInstruments`' assumptions (`data: [{ tradingsymbol, exchange, segment, instrument_token }]`); adjust `parseInstruments` if the live shape differs.
- Search a real instrument, run an analysis for both horizons, confirm the prose + confluence render from live data.
- Confirm daily-token expiry (~6 AM next day): a stale session surfaces the "Kite needs login today." banner and re-login restores it.

- [ ] **Step 5: Commit**

```bash
git add electron-app/test/endToEnd.integration.test.ts
git commit -m "test(e2e): run engine-only generator over the assembled envelope"
```

---

## Self-Review

Run after the plan is written; fix inline. (Completed by the plan author against `docs/superpowers/specs/2026-07-25-phase5a-live-wiring-design.md`.)

**1. Spec coverage** — every P5a section maps to a task:
- P5a§4 (kiteConfig/.env/dotenv/.gitignore) → Task 1.
- P5a§5 (mcpConnection over SDK Client + StreamableHTTP) → Task 2.
- P5a§6.1 (runKiteLogin orchestration + drift step) → Task 3.
- P5a§6.2 (bootstrap session state, drift banner, markAuthenticated/markNeedsLogin, teardown) → Task 7.
- P5a§6.3 (three IPC channels; RendererApi/preload; analysisBridge) → Tasks 5 (contract) + 6 (handlers) + 7 (wiring).
- P5a§7 (deterministic generator, wording ethos) → Task 4.
- P5a§8.1/8.2 (React components; horizon→params) → Tasks 8 (shell) + 9 (search/horizon/result); horizon mapping in Task 6.
- P5a§8.3 (CSP style-src, no DOMPurify/markdown, plain text nodes) → Task 8.
- P5a§8.4 (AnalysisResult open contract) → Task 5.
- P5a§9 (React/testing tooling) → Task 8.
- P5a§10 (testing approach, per-module seams, e2e extension) → Tasks 1–10; e2e in Task 10.
- P5a§11 (manual checklist) → Task 10.
- P5a§12 tensions (lens deferred / header unverified / no auto / no DOMPurify / no mode picker) → honored: fixed `intent_lens: "buying"` (Task 6), two-option horizon only (Tasks 6/9), header manual-verify (Task 10), plain-text render (Task 8/9), Engine-Only-only UI (Task 8). No gaps found.

**2. Placeholder scan** — no `TBD`/`TODO`/"add error handling"/"similar to Task N"/"write tests for the above" remain; every code step contains complete code; every test step contains real assertions.

**3. Type consistency** — verified across tasks:
- IPC channel names identical everywhere: `kite:login`, `kite:searchInstruments`, `analysis:run` (Tasks 5 buildRendererApi, 6 registerAnalysisBridge, 8/9 via bridge).
- `LoginResult` (`{ status: "authenticated" } | { status: "error"; message }`) defined in Task 5, produced by `login` in Task 7, consumed by `App` in Task 8 — shapes match.
- `AnalysisRunParams` (`{ instrument: InstrumentSelection; horizon: Horizon }`) defined Task 5, consumed by `runAnalysisRequest`/handler Task 6 and `App.onAnalyze` Task 9 — match; `InstrumentSelection` is exactly `AssembleEnvelopeParams.instrument`'s `{ symbol, exchange, segment, instrumentToken }`, so `assembleEnvelope` accepts it unchanged.
- `AnalysisResult` fields (`mode`, `instrument: InstrumentRef`, `horizon`, `response: DeterministicResponse`, `algo_results: AlgoResultWire[]`) defined Task 5, produced Task 6, consumed by `AnalysisResultView` Task 9 — match.
- `DeterministicResponse` (`direction`, `conviction`, `text`, `confluence: ConfluenceWire`) defined Task 4, referenced Tasks 5/9 — consistent.
- `KiteSession` (`kite`, `connection`, `drift`, `close`) defined Task 3, consumed Tasks 6/7 — match; `runKiteLogin` returns it, `getSession()` yields it, `session.kite.searchInstruments` used in the handler.
- `McpConnection` (`caller`, `listing`, `close`) defined Task 2, consumed Task 3 — match.
- `connectKiteMcp({ apiKey, accessToken })` call (Task 3) matches `ConnectKiteMcpDeps` (Task 2).
- Fix applied during review: `vitest.config.ts` `include` widened to also match `*.test.tsx` (Task 8 Step 2) — without it the renderer tests would silently not run.
- Fix applied during review: the analysis result component is exported as `AnalysisResultView` (not `AnalysisResult`) to avoid colliding with the imported `AnalysisResult` type (Task 9).
