# Live Engine-Only Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Engine-Only mode into an always-on, full-screen (content-pane), visual-only live dashboard: after "Analyze" is submitted, a real Kite WebSocket tick feed drives a live candlestick chart, the full algorithm suite re-scores only on candle close, and a diverging-bar verdict meter shows direction/strength with no prose.

**Architecture:** Renderer aggregates ticks into the chart via `lightweight-charts`' native incremental update; a pure candle-bucketing module in the main process detects candle closes independently and triggers the existing sidecar persist+compute pipeline only then, pushing a fresh scorecard over a new `live:*` IPC surface. A prerequisite fix (Task 1) makes the Kite WebSocket ticker a true process-lifetime singleton, since the library that backs it keeps connection state at module scope — a defect Phase 16 never exercised because nothing there ever called `.connect()`.

**Tech Stack:** TypeScript, Electron main + renderer, Vitest, `lightweight-charts` (already a dependency, used today by `benchmarkChart.ts`), `kiteconnect`'s `KiteTicker` (already a dependency, wrapped by `kiteTicker.ts`).

## Global Constraints

- `.disconnect()` is called on the Kite ticker in exactly one place in the whole app: an `app.on("before-quit", ...)` hook. Nowhere else, ever.
- Exactly one `KiteTicker` instance exists for the process's entire lifetime.
- The full algo suite + confluence recompute happens only on candle close, never per-tick.
- No projected/forecasted future candles or price paths are rendered anywhere — direction + magnitude from the real confluence scorecard only.
- AI-Assisted mode's files are not touched by this plan.
- A live session's history entry is one message, updated in place on every candle close — never a new appended message per close.
- Full spec: `docs/superpowers/specs/2026-09-26-phase17-live-engine-only-dashboard-design.md`.

---

### Task 1: Ticker singleton + credential-refresh fix

**Files:**
- Modify: `electron-app/src/main/services/kite/kiteTicker.ts`
- Modify: `electron-app/src/main/services/kite/kiteLogin.ts`
- Modify: `electron-app/src/main/bootstrap.ts`
- Test: `electron-app/test/main/services/kite/kiteTicker.test.ts`
- Test: `electron-app/test/main/services/kite/kiteLogin.test.ts`

**Interfaces:**
- Produces: `KiteTickerClient.updateCredentialsAndConnect(apiKey, accessToken): void`; `KiteSession = { kite: KiteClient; ticker: KiteTickerClient }` (no more `close()`); `KiteLoginDeps.existingTicker?: KiteTickerClient` — consumed by Task 5 (bootstrap.ts already modified here, but Task 5 constructs the `LiveSessionRunner` that uses `session.ticker`).

- [ ] **Step 1: Update `kiteTicker.test.ts` — add the credential-refresh test**

Add this test inside the existing `describe("createKiteTicker", ...)` block in `electron-app/test/main/services/kite/kiteTicker.test.ts` (after the existing "connect() and disconnect()..." test):

```typescript
  it("updateCredentialsAndConnect() sets api_key/access_token on the underlying ticker then calls connect()", () => {
    const fake = fakeTickerLike();
    const client = createKiteTicker("k", "a", { createTicker: () => fake });

    client.updateCredentialsAndConnect("k2", "at2");

    expect(fake.api_key).toBe("k2");
    expect(fake.access_token).toBe("at2");
    expect(fake.connect).toHaveBeenCalledTimes(1);
  });
```

Also update `fakeTickerLike()`'s return type and object literal to include the two new writable fields and `connected`:

```typescript
function fakeTickerLike(): KiteTickerLike & { emit: (event: string, ...args: unknown[]) => void } {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    modeLTP: "ltp",
    modeQuote: "quote",
    modeFull: "full",
    api_key: "",
    access_token: "",
    connect: vi.fn(),
    disconnect: vi.fn(),
    connected: vi.fn().mockReturnValue(false),
    subscribe: vi.fn(),
    setMode: vi.fn(),
    autoReconnect: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    }),
    emit: (event: string, ...args: unknown[]) => {
      (handlers.get(event) ?? []).forEach((cb) => cb(...args));
    },
  };
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- kiteTicker.test.ts` (from `electron-app/`)
Expected: FAIL — `client.updateCredentialsAndConnect` is not a function; also a TS type error on `fakeTickerLike`'s missing `api_key`/`access_token`/`connected` fields (this file isn't typechecked by `vitest run` at runtime the same way `tsc` is, but the test itself calling a non-existent method fails regardless).

- [ ] **Step 3: Implement the fix in `kiteTicker.ts`**

Replace the entire contents of `electron-app/src/main/services/kite/kiteTicker.ts`:

```typescript
import { KiteTicker } from "kiteconnect";

export type TickerConnectionStatus = "connected" | "reconnecting" | "error";

export interface KiteTickerClient {
  connect(): void;
  updateCredentialsAndConnect(apiKey: string, accessToken: string): void;
  subscribe(instrumentTokens: number[], mode?: "ltp" | "quote" | "full"): void;
  onTick(handler: (ticks: unknown[]) => void): void;
  onConnectionChange(handler: (status: TickerConnectionStatus) => void): void;
  disconnect(): void;
}

// The subset of the kiteconnect npm package's real KiteTicker surface this
// wrapper depends on -- named so a test can inject a fake without importing
// the real (network-opening) class. Verified against kiteconnectjs's own
// compiled source (dist/lib/ticker.js), not guessed from docs or types.
export interface KiteTickerLike {
  connect(): void;
  disconnect(): void;
  connected(): boolean;
  subscribe(tokens: number[]): void;
  setMode(mode: string, tokens: number[]): void;
  autoReconnect(enable: boolean, maxRetry: number, maxDelaySeconds: number): void;
  on(event: string, callback: (...args: unknown[]) => void): void;
  modeLTP: string;
  modeQuote: string;
  modeFull: string;
  api_key: string;
  access_token: string;
}

export interface KiteTickerFactoryDeps {
  createTicker?: (opts: { api_key: string; access_token: string }) => KiteTickerLike;
}

function defaultCreateTicker(opts: { api_key: string; access_token: string }): KiteTickerLike {
  return new KiteTicker(opts) as unknown as KiteTickerLike;
}

export function createKiteTicker(
  apiKey: string,
  accessToken: string,
  deps: KiteTickerFactoryDeps = {},
): KiteTickerClient {
  const ticker = (deps.createTicker ?? defaultCreateTicker)({ api_key: apiKey, access_token: accessToken });
  // -1 is a footgun, not "retry forever": kiteconnectjs's attemptReconnection()
  // checks `current_reconnection_count > reconnect_max_tries` and calls
  // process.exit(1) once that's true, so with max_retry = -1 the very first
  // disconnect (0 > -1) already trips it and kills the whole Electron main
  // process. 300 is the library's own documented maximum retry count --
  // passing anything higher has no additional effect -- so it's used here
  // to get the most real reconnect attempts the library supports.
  ticker.autoReconnect(true, 300, 5);

  const tickHandlers: ((ticks: unknown[]) => void)[] = [];
  const connectionHandlers: ((status: TickerConnectionStatus) => void)[] = [];
  const notifyConnection = (status: TickerConnectionStatus): void => connectionHandlers.forEach((h) => h(status));

  ticker.on("connect", () => notifyConnection("connected"));
  ticker.on("reconnect", () => notifyConnection("reconnecting"));
  ticker.on("noreconnect", () => notifyConnection("error"));
  ticker.on("error", () => notifyConnection("error"));
  ticker.on("ticks", (...args: unknown[]) => tickHandlers.forEach((h) => h(args[0] as unknown[])));

  return {
    connect: () => ticker.connect(),
    // connect() is a no-op if the socket is already open/connecting (verified
    // against the real library source), so this is always safe to call: on
    // first-ever login it establishes the initial connection; on every later
    // re-login it just updates the credentials the library will use the next
    // time it naturally reconnects. This library's disconnect() permanently
    // disables auto-reconnect at module scope for the rest of the process
    // (see the comment on the autoReconnect() call above), so there is no way
    // to force an immediate reconnect with the new token -- only a lazy one,
    // the next time the socket drops on its own.
    updateCredentialsAndConnect: (apiKey, accessToken) => {
      ticker.api_key = apiKey;
      ticker.access_token = accessToken;
      ticker.connect();
    },
    subscribe: (instrumentTokens, mode = "full") => {
      ticker.subscribe(instrumentTokens);
      const modeValue = mode === "ltp" ? ticker.modeLTP : mode === "quote" ? ticker.modeQuote : ticker.modeFull;
      ticker.setMode(modeValue, instrumentTokens);
    },
    onTick: (handler) => tickHandlers.push(handler),
    onConnectionChange: (handler) => connectionHandlers.push(handler),
    disconnect: () => ticker.disconnect(),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- kiteTicker.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Update `kiteLogin.test.ts` — the `existingTicker` case, and drop the `close()` test**

Remove this test entirely (there is no `close()` anymore):

```typescript
  it("close() disconnects the ticker", async () => {
    const { deps, ticker } = baseDeps();
    const session = await runKiteLogin(deps);

    await session.close();

    expect(ticker.disconnect).toHaveBeenCalledTimes(1);
  });
```

Add `updateCredentialsAndConnect: vi.fn()` to the fake `ticker` object in `baseDeps()`:

```typescript
function baseDeps() {
  const callTool = vi.fn().mockResolvedValue({ ok: true });
  const ticker = {
    connect: vi.fn(),
    updateCredentialsAndConnect: vi.fn(),
    disconnect: vi.fn(),
    subscribe: vi.fn(),
    onTick: vi.fn(),
    onConnectionChange: vi.fn(),
  };
  return {
    callTool,
    ticker,
    deps: {
      config: { apiKey: "k123", apiSecret: "s456", loginPort: 3000 },
      cacheDir: "/tmp/does-not-matter",
      captureRequestToken: vi.fn().mockResolvedValue("req_tok"),
      exchangeAccessToken: vi.fn().mockResolvedValue({ data: { access_token: "at_999" } }),
      postForm: vi.fn(),
      openExternal: vi.fn(),
      createRestCaller: vi.fn().mockReturnValue({ callTool }),
      createTicker: vi.fn().mockReturnValue(ticker),
    },
  };
}
```

Change the first test's assertion from checking `createTicker` was called (still true on first login) to also assert `updateCredentialsAndConnect` was called with the fresh credentials — add this line right after the existing `expect(deps.createTicker).toHaveBeenCalledWith("k123", "at_999");`:

```typescript
    expect(ticker.updateCredentialsAndConnect).toHaveBeenCalledWith("k123", "at_999");
```

Add a new test proving reuse:

```typescript
  it("reuses an existingTicker instead of constructing a new one, and updates its credentials", async () => {
    const { deps, ticker } = baseDeps();
    const existingTicker = { ...ticker, updateCredentialsAndConnect: vi.fn() };

    const session = await runKiteLogin({ ...deps, existingTicker });

    expect(deps.createTicker).not.toHaveBeenCalled();
    expect(existingTicker.updateCredentialsAndConnect).toHaveBeenCalledWith("k123", "at_999");
    expect(session.ticker).toBe(existingTicker);
  });
```

- [ ] **Step 6: Run the test to verify it fails, then passes**

Run: `npm test -- kiteLogin.test.ts` (from `electron-app/`)
Expected first: FAIL (`session.close is not a function` on the now-deleted test doesn't apply since that test was removed; the new `existingTicker` test fails because `runKiteLogin` doesn't accept/use it yet, and the updated assertion on the first test fails because `updateCredentialsAndConnect` is never called by the current implementation).

- [ ] **Step 7: Update `kiteLogin.ts`**

Replace the entire contents of `electron-app/src/main/services/kite/kiteLogin.ts`:

```typescript
import { KiteInstrumentMaster } from "./kiteInstrumentMaster";
import { createKiteRestCaller } from "./kiteRestCaller";
import { createKiteTicker } from "./kiteTicker";
import type { KiteTickerClient } from "./kiteTicker";
import { captureRequestToken, exchangeAccessToken } from "./kiteOAuth";
import { KiteClient } from "./kiteClient";
import type { KiteConfig } from "./kiteConfig";

export interface KiteLoginDeps {
  config: KiteConfig;
  cacheDir: string;
  captureRequestToken: typeof captureRequestToken;
  exchangeAccessToken: typeof exchangeAccessToken;
  postForm: (url: string, form: Record<string, string>) => Promise<unknown>;
  openExternal: (url: string) => void;
  onKiteResponse?: (response: unknown) => void;
  createRestCaller?: typeof createKiteRestCaller;
  createTicker?: typeof createKiteTicker;
  existingTicker?: KiteTickerClient;
}

export interface KiteSession {
  kite: KiteClient;
  ticker: KiteTickerClient;
}

function extractAccessToken(tokenResponse: unknown): string {
  const token = (tokenResponse as { data?: { access_token?: unknown } })?.data?.access_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("kite session/token response did not include data.access_token");
  }
  return token;
}

export async function runKiteLogin(deps: KiteLoginDeps): Promise<KiteSession> {
  const { apiKey, apiSecret, loginPort } = deps.config;
  const loginUrl = `https://kite.zerodha.com/connect/login?api_key=${encodeURIComponent(apiKey)}&v=3`;
  const requestToken = await deps.captureRequestToken({ port: loginPort, loginUrl, openExternal: deps.openExternal });
  const tokenResponse = await deps.exchangeAccessToken({ apiKey, apiSecret, requestToken, postForm: deps.postForm });
  const accessToken = extractAccessToken(tokenResponse);

  const instrumentMaster = new KiteInstrumentMaster({ apiKey, accessToken, cacheDir: deps.cacheDir });
  const createRestCaller = deps.createRestCaller ?? createKiteRestCaller;
  const caller = createRestCaller({ apiKey, accessToken, instrumentMaster });
  const kite = new KiteClient(caller, { onResponse: deps.onKiteResponse });

  const ticker = deps.existingTicker ?? (deps.createTicker ?? createKiteTicker)(apiKey, accessToken);
  ticker.updateCredentialsAndConnect(apiKey, accessToken);

  return { kite, ticker };
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- kiteLogin.test.ts`
Expected: PASS (4 tests: the 3 original minus the deleted `close()` one, plus the new `existingTicker` one)

- [ ] **Step 9: Update `bootstrap.ts` — thread the ticker across logins, drop both `close()` call sites, add the quit hook**

In `electron-app/src/main/bootstrap.ts`:

Add `let ticker: KiteTickerClient | null = null;` alongside the existing `let session: KiteSession | null = null;` (around line 91), and add the import:

```typescript
import type { KiteTickerClient } from "./services/kite/kiteTicker";
```

Change the `sessionState.on("change", ...)` listener (currently lines 113-119) from:

```typescript
  sessionState.on("change", (status: KiteSessionStatus) => {
    if (status === "needsLogin" && session) {
      const closing = session;
      session = null;
      void closing.close().catch(() => {});
    }
  });
```

to:

```typescript
  sessionState.on("change", (status: KiteSessionStatus) => {
    if (status === "needsLogin" && session) {
      session = null;
    }
  });
```

Change the `login()` closure's session-creation block from:

```typescript
        const previousSession = session;
        const openExternal = (url: string) => shell.openExternal(url);
        const onKiteResponse = (response: unknown) => handleKiteResponse(sessionState, response);
        const newSession = await runKiteLogin({
          config,
          cacheDir: app.getPath("userData"),
          captureRequestToken,
          exchangeAccessToken,
          postForm,
          openExternal,
          onKiteResponse,
        });
        // Defense in depth: the "change" listener above already closes a
        // session as soon as it goes stale, but close whatever is still
        // referenced here too so a redundant login() call can never leak it.
        if (previousSession && previousSession !== newSession) {
          void previousSession.close().catch(() => {});
        }
        session = newSession;
        sessionState.markAuthenticated();
```

to:

```typescript
        const openExternal = (url: string) => shell.openExternal(url);
        const onKiteResponse = (response: unknown) => handleKiteResponse(sessionState, response);
        const newSession = await runKiteLogin({
          config,
          cacheDir: app.getPath("userData"),
          captureRequestToken,
          exchangeAccessToken,
          postForm,
          openExternal,
          onKiteResponse,
          existingTicker: ticker ?? undefined,
        });
        ticker = newSession.ticker;
        session = newSession;
        sessionState.markAuthenticated();
```

Add the quit hook right after `createApp()`'s other one-time event wiring (near the `supervisor.on("statusChange", ...)` block, around line 102-105):

```typescript
  app.on("before-quit", () => {
    ticker?.disconnect();
  });
```

- [ ] **Step 10: Run the full suite and typecheck**

Run: `npm run typecheck && npm test` (from `electron-app/`)
Expected: PASS. `bootstrap.test.ts` needs no new test for this step — it only ever tested the extracted pure `handleKiteResponse` function, never the `login()` closure's wiring or Electron `app`/quit-hook plumbing, matching this codebase's established precedent (Phase 8's design doc §9.3 made the same call for an equally trivial wiring change) — the `existingTicker`/quit-hook behavior is fully covered by `kiteLogin.test.ts` (Task 1 Step 5) and this codebase's existing convention of not unit-testing `createApp()`'s Electron-object wiring.

- [ ] **Step 11: Commit**

```bash
git add electron-app/src/main/services/kite/kiteTicker.ts electron-app/src/main/services/kite/kiteLogin.ts electron-app/src/main/bootstrap.ts \
  electron-app/test/main/services/kite/kiteTicker.test.ts electron-app/test/main/services/kite/kiteLogin.test.ts
git commit -m "kite: make the ticker a process-lifetime singleton, fix daily re-login credential refresh"
```

---

### Task 2: `liveCandleTracker.ts` — pure candle-close detection

**Files:**
- Create: `electron-app/src/main/services/market/liveCandleTracker.ts`
- Test: `electron-app/test/main/services/market/liveCandleTracker.test.ts`

**Interfaces:**
- Consumes: `intervalMinutes(interval: CandleInterval): number` (already exists in `electron-app/src/main/services/market/candleInterval.ts` — do not reimplement it).
- Produces: `LiveCandle { ts: number; open: number; high: number; low: number; close: number }`, `class LiveCandleTracker` with constructor `(intervalMinutes: number)` and `onTick(ts: number, price: number): LiveCandle | null` — consumed by Task 4 (`liveSessionRunner.ts`).

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/main/services/market/liveCandleTracker.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { LiveCandleTracker } from "../../../../src/main/services/market/liveCandleTracker";

// 2026-09-26 is a Saturday in real life but the tracker has no day-of-week
// logic -- it only buckets by minutes-since-IST-midnight, so any date works.
// 09:15:00 IST = 03:45:00 UTC.
const IST_0915_UTC_SECONDS = Date.UTC(2026, 8, 26, 3, 45, 0) / 1000;

describe("LiveCandleTracker", () => {
  it("returns null for every tick within the same 5-minute bucket", () => {
    const tracker = new LiveCandleTracker(5);

    expect(tracker.onTick(IST_0915_UTC_SECONDS, 100)).toBeNull();
    expect(tracker.onTick(IST_0915_UTC_SECONDS + 60, 101)).toBeNull();
    expect(tracker.onTick(IST_0915_UTC_SECONDS + 299, 99)).toBeNull();
  });

  it("returns the closed candle with correct OHLC when a tick crosses into a new bucket", () => {
    const tracker = new LiveCandleTracker(5);

    tracker.onTick(IST_0915_UTC_SECONDS, 100);
    tracker.onTick(IST_0915_UTC_SECONDS + 60, 105);
    tracker.onTick(IST_0915_UTC_SECONDS + 120, 95);
    const closed = tracker.onTick(IST_0915_UTC_SECONDS + 300, 102); // exactly 09:20:00 -- next bucket

    expect(closed).toEqual({ ts: IST_0915_UTC_SECONDS, open: 100, high: 105, low: 95, close: 95 });
  });

  it("starts a fresh forming candle after a close, using the crossing tick as its first price", () => {
    const tracker = new LiveCandleTracker(5);
    tracker.onTick(IST_0915_UTC_SECONDS, 100);
    tracker.onTick(IST_0915_UTC_SECONDS + 300, 102); // closes bucket 1, opens bucket 2 at 102

    const closedSecond = tracker.onTick(IST_0915_UTC_SECONDS + 600, 110); // closes bucket 2

    expect(closedSecond).toEqual({ ts: IST_0915_UTC_SECONDS + 300, open: 102, high: 102, low: 102, close: 102 });
  });

  it("still closes correctly across a gap in ticks (no tick lands exactly on a boundary)", () => {
    const tracker = new LiveCandleTracker(5);
    tracker.onTick(IST_0915_UTC_SECONDS, 100);
    // Next tick arrives 7 minutes later -- well past the 5-minute boundary,
    // simulating an illiquid instrument with no tick exactly at :20:00.
    const closed = tracker.onTick(IST_0915_UTC_SECONDS + 420, 108);

    expect(closed).toEqual({ ts: IST_0915_UTC_SECONDS, open: 100, high: 100, low: 100, close: 100 });
  });

  it("aligns bucket boundaries to wall-clock minutes since IST midnight, not session-open-relative offsets", () => {
    const tracker = new LiveCandleTracker(10);
    // 09:15 IST is 555 minutes since midnight -- not a multiple of 10, so the
    // first bucket for a 10-minute tracker starting at market open is
    // [09:10, 09:20), matching how Kite's own historical 10-minute bars are
    // aligned (from-midnight wall-clock marks), not [09:15, 09:25).
    tracker.onTick(IST_0915_UTC_SECONDS, 100);
    const closed = tracker.onTick(IST_0915_UTC_SECONDS + 5 * 60, 105); // 09:20:00 -- crosses into [09:20,09:30)

    expect(closed?.ts).toBe(IST_0915_UTC_SECONDS - 5 * 60); // bucket started at 09:10:00
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- liveCandleTracker.test.ts` (from `electron-app/`)
Expected: FAIL with "Cannot find module '../../../../src/main/services/market/liveCandleTracker'"

- [ ] **Step 3: Write the implementation**

Create `electron-app/src/main/services/market/liveCandleTracker.ts`:

```typescript
export interface LiveCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const IST_OFFSET_SECONDS = 5.5 * 60 * 60;

// Bucket start = floor(minutes-since-IST-midnight / intervalMinutes) *
// intervalMinutes, converted back to a unix-seconds timestamp. This matches
// how Kite's own historical 5/10/15-minute bars are aligned -- wall-clock
// marks from midnight IST, not offsets relative to the 09:15 session open --
// so a live-built candle's timestamp lines up with the already-persisted
// historical candles preceding it in the same chart.
function bucketStart(ts: number, intervalSeconds: number): number {
  const istSeconds = ts + IST_OFFSET_SECONDS;
  const secondsSinceIstMidnight = istSeconds % 86400;
  const bucketOffsetWithinDay = Math.floor(secondsSinceIstMidnight / intervalSeconds) * intervalSeconds;
  return ts - (secondsSinceIstMidnight - bucketOffsetWithinDay);
}

export class LiveCandleTracker {
  private readonly intervalSeconds: number;
  private forming: LiveCandle | null = null;

  constructor(intervalMinutes: number) {
    this.intervalSeconds = intervalMinutes * 60;
  }

  onTick(ts: number, price: number): LiveCandle | null {
    const bucket = bucketStart(ts, this.intervalSeconds);

    if (this.forming === null) {
      this.forming = { ts: bucket, open: price, high: price, low: price, close: price };
      return null;
    }

    if (this.forming.ts === bucket) {
      this.forming.high = Math.max(this.forming.high, price);
      this.forming.low = Math.min(this.forming.low, price);
      this.forming.close = price;
      return null;
    }

    const closed = this.forming;
    this.forming = { ts: bucket, open: price, high: price, low: price, close: price };
    return closed;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- liveCandleTracker.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/market/liveCandleTracker.ts electron-app/test/main/services/market/liveCandleTracker.test.ts
git commit -m "market: add pure live candle-close detection, aligned to Kite's wall-clock bucket boundaries"
```

---

### Task 3: `HistoryStore` — `appendMessage` returns an id, new `updateMessage`

**Files:**
- Modify: `electron-app/src/main/services/history/historyStore.ts`
- Test: `electron-app/test/main/services/history/historyStore.test.ts`

**Interfaces:**
- Produces: `appendMessage(params: AppendMessageParams): string` (was `void`); `updateMessage(params: UpdateMessageParams): void` where `UpdateMessageParams = { sessionId: string; messageId: string; renderedText: string; structuredPayload?: unknown }`; `HistoryMessage` gains an `id: string` field — consumed by Task 4 (`liveSessionRunner.ts`) and Task 8 (`App.tsx` reads a reopened live session's assistant-message id straight from `SessionDetail.messages`, no round-trip through `structured_payload` needed).

- [ ] **Step 0: `HistoryMessage` gains an `id` field, so a caller can later target a specific message with `updateMessage`**

In `electron-app/src/main/services/history/historyStore.ts`, change:

```typescript
export interface HistoryMessage {
  role: MessageRole;
  rendered_text: string;
  structured_payload: unknown;
  trace: TraceEvent[] | null;
  created_at: string;
}
```

to:

```typescript
export interface HistoryMessage {
  id: string;
  role: MessageRole;
  rendered_text: string;
  structured_payload: unknown;
  trace: TraceEvent[] | null;
  created_at: string;
}
```

In `getSession(id)`, change the query and row type from:

```typescript
    const rows = this.db
      .prepare(
        `SELECT role, rendered_text, structured_payload, trace, created_at FROM messages
         WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(id) as Array<{
      role: MessageRole;
      rendered_text: string;
      structured_payload: string | null;
      trace: string | null;
      created_at: string;
    }>;
```

to:

```typescript
    const rows = this.db
      .prepare(
        `SELECT id, role, rendered_text, structured_payload, trace, created_at FROM messages
         WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(id) as Array<{
      id: string;
      role: MessageRole;
      rendered_text: string;
      structured_payload: string | null;
      trace: string | null;
      created_at: string;
    }>;
```

And add `id: row.id,` as the first field in the `messages: rows.map((row) => ({ ... }))` object literal a few lines below it.

Add this test to `electron-app/test/main/services/history/historyStore.test.ts` before the other new tests in this task:

```typescript
describe("HistoryMessage.id", () => {
  it("exposes each message's own id on getSession, matching what appendMessage returned", () => {
    const store = memoryStore();
    const session = store.createSession("engine_only");
    const id = store.appendMessage({ sessionId: session.id, role: "assistant", renderedText: "x" });

    const detail = store.getSession(session.id);

    expect(detail.messages[0].id).toBe(id);
  });
});
```

Run: `npm test -- historyStore.test.ts` — verify this fails first (no `id` field/column selected yet), then passes after the change above. Fold this verification into the same RED/GREEN cycle as the rest of this task rather than a separate one.

**Note:** `App.test.tsx`, `AnalysisResult.test.tsx`, and `ChatView.test.tsx` construct `HistoryMessage`-shaped fixtures without an `id` field. This does not break typecheck (`.test.tsx` files are excluded, per Phase 16's own finding) or any *existing* test (none of those fixtures are read by code that uses `.id` yet). Only `App.test.tsx`'s cases that exercise the new live-session path (Task 8 Step 7) need an `id` added to their fixtures — leave the other two files alone.

- [ ] **Step 1: Write the failing tests**

Add these tests to `electron-app/test/main/services/history/historyStore.test.ts` (in the existing file, using its existing `memoryStore()`/`monotonicNow()` helpers already defined there — do not redefine them):

```typescript
describe("appendMessage return value", () => {
  it("returns the generated message id", () => {
    const store = memoryStore();
    const session = store.createSession("engine_only");

    const id = store.appendMessage({ sessionId: session.id, role: "user", renderedText: "hi" });

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
});

describe("updateMessage", () => {
  it("overwrites an existing message's rendered_text and structured_payload without creating a new row", () => {
    const store = memoryStore();
    const session = store.createSession("engine_only");
    const id = store.appendMessage({
      sessionId: session.id,
      role: "assistant",
      renderedText: "first",
      structuredPayload: { n: 1 },
    });

    store.updateMessage({ sessionId: session.id, messageId: id, renderedText: "second", structuredPayload: { n: 2 } });

    const detail = store.getSession(session.id);
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0].rendered_text).toBe("second");
    expect(detail.messages[0].structured_payload).toEqual({ n: 2 });
  });

  it("bumps the session's last_active_at", () => {
    const store = memoryStore();
    const session = store.createSession("engine_only");
    const id = store.appendMessage({ sessionId: session.id, role: "assistant", renderedText: "x" });
    const before = store.listSessions()[0].last_active_at;

    store.updateMessage({ sessionId: session.id, messageId: id, renderedText: "y" });

    const after = store.listSessions()[0].last_active_at;
    expect(after >= before).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- historyStore.test.ts` (from `electron-app/`)
Expected: FAIL — `appendMessage` still returns `void` (the `id` assertions fail with `typeof undefined !== "string"`), and `store.updateMessage` is not a function.

- [ ] **Step 3: Implement the changes**

In `electron-app/src/main/services/history/historyStore.ts`:

Add the new params interface, right after `AppendMessageParams`:

```typescript
export interface UpdateMessageParams {
  sessionId: string;
  messageId: string;
  renderedText: string;
  structuredPayload?: unknown;
}
```

Change the `appendMessageTxn` field's type and body to generate the id up front and return it:

```typescript
  private readonly appendMessageTxn: (params: AppendMessageParams, timestamp: string) => string;
  private readonly updateMessageTxn: (params: UpdateMessageParams, timestamp: string) => void;
```

In the constructor, change:

```typescript
    const insertMessage = this.db.prepare(
      `INSERT INTO messages (id, session_id, role, rendered_text, structured_payload, trace, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const bumpSession = this.db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?");
    this.appendMessageTxn = this.db.transaction((params: AppendMessageParams, timestamp: string) => {
      insertMessage.run(
        randomUUID(),
        params.sessionId,
        params.role,
        params.renderedText,
        params.structuredPayload === undefined ? null : JSON.stringify(params.structuredPayload),
        params.trace === undefined ? null : JSON.stringify(params.trace),
        timestamp,
      );
      bumpSession.run(timestamp, params.sessionId);
    });
```

to:

```typescript
    const insertMessage = this.db.prepare(
      `INSERT INTO messages (id, session_id, role, rendered_text, structured_payload, trace, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateMessage = this.db.prepare(
      `UPDATE messages SET rendered_text = ?, structured_payload = ? WHERE id = ?`,
    );
    const bumpSession = this.db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?");
    this.appendMessageTxn = this.db.transaction((params: AppendMessageParams, timestamp: string): string => {
      const id = randomUUID();
      insertMessage.run(
        id,
        params.sessionId,
        params.role,
        params.renderedText,
        params.structuredPayload === undefined ? null : JSON.stringify(params.structuredPayload),
        params.trace === undefined ? null : JSON.stringify(params.trace),
        timestamp,
      );
      bumpSession.run(timestamp, params.sessionId);
      return id;
    });
    this.updateMessageTxn = this.db.transaction((params: UpdateMessageParams, timestamp: string) => {
      updateMessage.run(
        params.renderedText,
        params.structuredPayload === undefined ? null : JSON.stringify(params.structuredPayload),
        params.messageId,
      );
      bumpSession.run(timestamp, params.sessionId);
    });
```

Change the public method:

```typescript
  appendMessage(params: AppendMessageParams): void {
    const timestamp = this.now().toISOString();
    this.appendMessageTxn(params, timestamp);
  }
```

to:

```typescript
  appendMessage(params: AppendMessageParams): string {
    const timestamp = this.now().toISOString();
    return this.appendMessageTxn(params, timestamp);
  }

  updateMessage(params: UpdateMessageParams): void {
    const timestamp = this.now().toISOString();
    this.updateMessageTxn(params, timestamp);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- historyStore.test.ts`
Expected: PASS (all existing tests plus the 3 new ones)

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/history/historyStore.ts electron-app/test/main/services/history/historyStore.test.ts
git commit -m "history: return the generated id from appendMessage, add updateMessage for in-place live updates"
```

---

### Task 4: `liveSessionRunner.ts` — orchestration

**Files:**
- Create: `electron-app/src/main/services/market/liveSessionRunner.ts`
- Test: `electron-app/test/main/services/market/liveSessionRunner.test.ts`

**Interfaces:**
- Consumes: `LiveCandleTracker` (Task 2); `HistoryStore.updateMessage` (Task 3); `KiteTickerClient.subscribe`/`onTick`/`onConnectionChange` (already exists); `SidecarSupervisor.persistCandles`/`compute` (already exists, signatures: `persistCandles(symbol, timeframe, candles: CandleWire[], source?): Promise<PersistCandlesResponseWire>`, `compute(symbol, timeframe, horizon, candles: CandleWire[], onRequestId?): Promise<ComputeResponseWire>`); `intervalMinutes` from `candleInterval.ts`.
- Produces: `LiveSessionRunner` with `start(params): void` / `stop(): void` — consumed by Task 5 (`liveBridge.ts`).

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/main/services/market/liveSessionRunner.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { createLiveSessionRunner } from "../../../../src/main/services/market/liveSessionRunner";

function baseDeps() {
  const tickHandlers: ((ticks: unknown[]) => void)[] = [];
  const ticker = {
    subscribe: vi.fn(),
    onTick: vi.fn((h: (ticks: unknown[]) => void) => tickHandlers.push(h)),
    onConnectionChange: vi.fn(),
  };
  const sidecar = {
    persistCandles: vi.fn().mockResolvedValue({ type: "persist_candles", id: 1, written: 1 }),
    compute: vi.fn().mockResolvedValue({
      type: "compute",
      id: 2,
      algo_results: [],
      confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 0.5 },
    }),
  };
  const history = { updateMessage: vi.fn() };
  const sendTick = vi.fn();
  const sendCandleClose = vi.fn();
  const sendStatus = vi.fn();

  return {
    tickHandlers,
    ticker,
    sidecar,
    history,
    sendTick,
    sendCandleClose,
    sendStatus,
    deps: { ticker, sidecar, history, sendTick, sendCandleClose, sendStatus },
  };
}

const START_PARAMS = {
  sessionId: "s1",
  assistantMessageId: "m1",
  instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
  interval: "5minute" as const,
};

describe("createLiveSessionRunner", () => {
  it("start() subscribes the ticker to the instrument token in full mode and wires connection status", () => {
    const { deps, ticker, sendStatus } = baseDeps();
    const runner = createLiveSessionRunner(deps);

    runner.start(START_PARAMS);

    expect(ticker.subscribe).toHaveBeenCalledWith([408065], "full");
    expect(ticker.onConnectionChange).toHaveBeenCalled();
    const statusHandler = ticker.onConnectionChange.mock.calls[0][0] as (s: string) => void;
    statusHandler("reconnecting");
    expect(sendStatus).toHaveBeenCalledWith("reconnecting");
  });

  it("forwards every tick's price/timestamp via sendTick", () => {
    const { deps, tickHandlers, sendTick } = baseDeps();
    const runner = createLiveSessionRunner(deps);
    runner.start(START_PARAMS);

    tickHandlers[0]([{ instrument_token: 408065, last_price: 101.5, exchange_timestamp: "2026-09-26T09:15:03+05:30" }]);

    expect(sendTick).toHaveBeenCalledWith({ ts: expect.any(Number), price: 101.5 });
  });

  it("on a closed candle, persists it, recomputes, updates history, and pushes the result -- in that order", async () => {
    const { deps, tickHandlers, sidecar, history, sendCandleClose } = baseDeps();
    const runner = createLiveSessionRunner(deps);
    runner.start(START_PARAMS);

    const order: string[] = [];
    sidecar.persistCandles.mockImplementation(async () => {
      order.push("persist");
      return { type: "persist_candles", id: 1, written: 1 };
    });
    sidecar.compute.mockImplementation(async () => {
      order.push("compute");
      return {
        type: "compute",
        id: 2,
        algo_results: [],
        confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 0.3 },
      };
    });
    history.updateMessage.mockImplementation(() => order.push("history"));

    // First tick opens the forming candle; a tick ~5 minutes later closes it.
    tickHandlers[0]([{ instrument_token: 408065, last_price: 100, exchange_timestamp: "2026-09-26T09:15:00+05:30" }]);
    tickHandlers[0]([{ instrument_token: 408065, last_price: 102, exchange_timestamp: "2026-09-26T09:20:00+05:30" }]);
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the async close handler settle

    expect(order).toEqual(["persist", "compute", "history"]);
    expect(sidecar.persistCandles).toHaveBeenCalledWith(
      "NSE:INFY",
      "5minute",
      [expect.objectContaining({ open: 100, close: 100 })],
      "kite",
    );
    expect(sidecar.compute).toHaveBeenCalledWith("NSE:INFY", "5minute", "intraday", [
      expect.objectContaining({ open: 100, close: 100 }),
    ]);
    expect(history.updateMessage).toHaveBeenCalledWith({
      sessionId: "s1",
      messageId: "m1",
      renderedText: "",
      structuredPayload: {
        algo_results: [],
        confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 0.3 },
      },
    });
    expect(sendCandleClose).toHaveBeenCalledWith({
      candle: expect.objectContaining({ open: 100, close: 100 }),
      algo_results: [],
      confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 0.3 },
    });
  });

  it("stop() unsubscribes and further ticks are ignored", () => {
    const { deps, tickHandlers, sendTick } = baseDeps();
    const runner = createLiveSessionRunner(deps);
    runner.start(START_PARAMS);
    runner.stop();

    tickHandlers[0]([{ instrument_token: 408065, last_price: 999, exchange_timestamp: "2026-09-26T09:15:00+05:30" }]);

    expect(sendTick).not.toHaveBeenCalled();
  });

  it("starting a new session while one is running stops the previous one first", () => {
    const { deps, tickHandlers, sendTick } = baseDeps();
    const runner = createLiveSessionRunner(deps);
    runner.start(START_PARAMS);
    runner.start({ ...START_PARAMS, sessionId: "s2", assistantMessageId: "m2" });

    tickHandlers[0]([{ instrument_token: 408065, last_price: 999, exchange_timestamp: "2026-09-26T09:15:00+05:30" }]);
    tickHandlers[1]([{ instrument_token: 408065, last_price: 111, exchange_timestamp: "2026-09-26T09:15:00+05:30" }]);

    // Only the second (current) session's tick handler is live; the first
    // session's handler was registered before stop() but the runner's
    // internal "active session" guard drops ticks routed to a stale handler.
    expect(sendTick).toHaveBeenCalledTimes(1);
    expect(sendTick).toHaveBeenCalledWith({ ts: expect.any(Number), price: 111 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- liveSessionRunner.test.ts` (from `electron-app/`)
Expected: FAIL with "Cannot find module '../../../../src/main/services/market/liveSessionRunner'"

- [ ] **Step 3: Write the implementation**

Create `electron-app/src/main/services/market/liveSessionRunner.ts`:

```typescript
import { LiveCandleTracker } from "./liveCandleTracker";
import type { LiveCandle } from "./liveCandleTracker";
import { intervalMinutes } from "./candleInterval";
import type { CandleInterval } from "./candleInterval";
import type { KiteTickerClient, TickerConnectionStatus } from "../kite/kiteTicker";
import type { SidecarSupervisor } from "../sidecar/sidecarSupervisor";
import type { HistoryStore } from "../history/historyStore";
import type { CandleWire, AlgoResultWire, ConfluenceWire } from "../sidecar/sidecarProtocol";

export interface LiveTickWire {
  ts: number;
  price: number;
}

export interface LiveInstrument {
  symbol: string;
  exchange: string;
  segment: string;
  instrumentToken: string;
}

export interface StartLiveSessionParams {
  sessionId: string;
  assistantMessageId: string;
  instrument: LiveInstrument;
  interval: CandleInterval;
}

export interface LiveSessionRunnerDeps {
  ticker: Pick<KiteTickerClient, "subscribe" | "onTick" | "onConnectionChange">;
  sidecar: Pick<SidecarSupervisor, "persistCandles" | "compute">;
  history: Pick<HistoryStore, "updateMessage">;
  sendTick: (tick: LiveTickWire) => void;
  sendCandleClose: (payload: { candle: CandleWire; algo_results: AlgoResultWire[]; confluence: ConfluenceWire }) => void;
  sendStatus: (status: TickerConnectionStatus) => void;
}

export interface LiveSessionRunner {
  start(params: StartLiveSessionParams): void;
  stop(): void;
}

function candleWire(candle: LiveCandle): CandleWire {
  return { ts: candle.ts, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: 0 };
}

// Kite ticks in "full" mode include exchange_timestamp as an ISO string;
// falls back to Date.now() if a tick ever arrives without one (LTP mode
// wouldn't have it, but this runner always subscribes in "full").
function tickTimestampSeconds(tick: Record<string, unknown>): number {
  const raw = tick.exchange_timestamp;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

export function createLiveSessionRunner(deps: LiveSessionRunnerDeps): LiveSessionRunner {
  let activeGeneration = 0;

  return {
    start(params: StartLiveSessionParams): void {
      activeGeneration += 1;
      const myGeneration = activeGeneration;
      const isActive = (): boolean => myGeneration === activeGeneration;

      const instrumentToken = Number(params.instrument.instrumentToken);
      const tracker = new LiveCandleTracker(intervalMinutes(params.interval));

      deps.ticker.subscribe([instrumentToken], "full");
      deps.ticker.onConnectionChange((status) => {
        if (isActive()) deps.sendStatus(status);
      });
      deps.ticker.onTick((ticks) => {
        if (!isActive()) return;
        const tick = (ticks as Record<string, unknown>[]).find((t) => t.instrument_token === instrumentToken);
        if (!tick || typeof tick.last_price !== "number") return;

        const ts = tickTimestampSeconds(tick);
        deps.sendTick({ ts, price: tick.last_price });

        const closed = tracker.onTick(ts, tick.last_price);
        if (closed === null) return;

        void (async () => {
          const candle = candleWire(closed);
          await deps.sidecar.persistCandles(params.instrument.symbol, params.interval, [candle], "kite");
          const computeResult = await deps.sidecar.compute(
            params.instrument.symbol,
            params.interval,
            "intraday",
            [candle],
          );
          if (!isActive()) return;
          deps.history.updateMessage({
            sessionId: params.sessionId,
            messageId: params.assistantMessageId,
            renderedText: "",
            structuredPayload: { algo_results: computeResult.algo_results, confluence: computeResult.confluence },
          });
          deps.sendCandleClose({ candle, algo_results: computeResult.algo_results, confluence: computeResult.confluence });
        })();
      });
    },

    stop(): void {
      activeGeneration += 1;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- liveSessionRunner.test.ts`
Expected: PASS (5 tests)

**Known accepted limitation, flagged rather than silently left unaddressed:** `KiteTickerClient.onTick`/`onConnectionChange` (from Task 1, unchanged from Phase 16) have no unsubscribe mechanism — each `start()` call registers a new handler that stays registered on the single shared ticker forever, even after `stop()`. The generation-guard (`activeGeneration`) makes this correctness-safe (a stale handler's work is always dropped by `isActive()`), but the handler arrays grow by one entry per `start()` call for the lifetime of the process — a real but slow memory growth, bounded in practice by how many times a user switches/reopens live sessions in one app session (tens, not thousands). Not fixed in this plan; if it matters later, the fix is giving `KiteTickerClient.onTick`/`onConnectionChange` an unsubscribe return value and calling it from `stop()`.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/market/liveSessionRunner.ts electron-app/test/main/services/market/liveSessionRunner.test.ts
git commit -m "market: add live session orchestration -- ticks to renderer, candle-close to sidecar recompute"
```

---

### Task 5: `live:*` IPC bridge + `bootstrap.ts` wiring

**Files:**
- Create: `electron-app/src/main/ipc/liveBridge.ts`
- Test: `electron-app/test/main/ipc/liveBridge.test.ts`
- Modify: `electron-app/src/main/ipc/rendererApi.ts`
- Modify: `electron-app/src/main/bootstrap.ts`
- Test: `electron-app/test/main/ipc/rendererApi.test.ts`

**Interfaces:**
- Consumes: `LiveSessionRunner` (Task 4).
- Produces: `registerLiveBridge(deps): void`; `RendererApi.startLiveSession`/`stopLiveSession`/`onLiveTick`/`onLiveCandleClose`/`onLiveStatus` — consumed by Task 8 (`LiveSessionView.tsx`).

- [ ] **Step 1: Write the failing test for `liveBridge.ts`**

Create `electron-app/test/main/ipc/liveBridge.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { registerLiveBridge } from "../../../src/main/ipc/liveBridge";

function fakeIpcMain() {
  const handlers = new Map<string, (event: unknown, args: unknown) => unknown>();
  return {
    handle: vi.fn((channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      handlers.set(channel, handler);
    }),
    invoke: (channel: string, args: unknown) => handlers.get(channel)?.(undefined, args),
  };
}

describe("registerLiveBridge", () => {
  it("wires live:start to runner.start and live:stop to runner.stop", () => {
    const ipcMain = fakeIpcMain();
    const runner = { start: vi.fn(), stop: vi.fn() };

    registerLiveBridge({ ipcMain, runner });

    const params = {
      sessionId: "s1",
      assistantMessageId: "m1",
      instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
      interval: "5minute" as const,
    };
    ipcMain.invoke("live:start", params);
    expect(runner.start).toHaveBeenCalledWith(params);

    ipcMain.invoke("live:stop", {});
    expect(runner.stop).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- liveBridge.test.ts` (from `electron-app/`)
Expected: FAIL with "Cannot find module '../../../src/main/ipc/liveBridge'"

- [ ] **Step 3: Write `liveBridge.ts`**

Create `electron-app/src/main/ipc/liveBridge.ts`:

```typescript
import type { IpcMain } from "electron";
import type { LiveSessionRunner, StartLiveSessionParams } from "../services/market/liveSessionRunner";

export interface LiveBridgeDeps {
  ipcMain: Pick<IpcMain, "handle">;
  runner: Pick<LiveSessionRunner, "start" | "stop">;
}

export function registerLiveBridge(deps: LiveBridgeDeps): void {
  deps.ipcMain.handle("live:start", (_event, params: StartLiveSessionParams) => {
    deps.runner.start(params);
  });
  deps.ipcMain.handle("live:stop", () => {
    deps.runner.stop();
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- liveBridge.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Add `live:*` to `rendererApi.ts`**

In `electron-app/src/main/ipc/rendererApi.ts`, add these exported types near the other analysis-related types (alongside `AnalysisRunParams` etc.):

```typescript
export type { LiveTickWire, StartLiveSessionParams, LiveInstrument } from "../services/market/liveSessionRunner";
import type { LiveTickWire, StartLiveSessionParams } from "../services/market/liveSessionRunner";
// CandleWire is new; AlgoResultWire/ConfluenceWire are already imported at the
// top of this file (line 4) -- do not re-import them, TS treats a second
// `import type` of the same named binding from the same module as a
// duplicate-identifier error.
import type { CandleWire } from "../services/sidecar/sidecarProtocol";
import type { TickerConnectionStatus } from "../services/kite/kiteTicker";
export type { TickerConnectionStatus } from "../services/kite/kiteTicker";

export interface LiveCandleClosePayload {
  candle: CandleWire;
  algo_results: AlgoResultWire[];
  confluence: ConfluenceWire;
}
```

Add these five methods to the `RendererApi` interface:

```typescript
  startLiveSession(params: StartLiveSessionParams): Promise<void>;
  stopLiveSession(): Promise<void>;
  onLiveTick(handler: (tick: LiveTickWire) => void): void;
  onLiveCandleClose(handler: (payload: LiveCandleClosePayload) => void): void;
  onLiveStatus(handler: (status: TickerConnectionStatus) => void): void;
```

Add their implementations to `buildRendererApi`'s returned object:

```typescript
    startLiveSession: (params) => invoke("live:start", params) as Promise<void>,
    stopLiveSession: () => invoke("live:stop") as Promise<void>,
    onLiveTick: (handler) => subscribe("live:tick", handler as (p: unknown) => void),
    onLiveCandleClose: (handler) => subscribe("live:candleClose", handler as (p: unknown) => void),
    onLiveStatus: (handler) => subscribe("live:status", handler as (p: unknown) => void),
```

- [ ] **Step 6: Update `rendererApi.test.ts`**

Add these cases to the existing test file (mirroring how `onBanner`/`onTrace` are already tested there — read the existing file for the exact fake-`invoke`/`subscribe` pattern used and match it):

```typescript
  it("startLiveSession invokes live:start with the given params", async () => {
    const { api, invoke } = build();
    const params = {
      sessionId: "s1",
      assistantMessageId: "m1",
      instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
      interval: "5minute" as const,
    };
    await api.startLiveSession(params);
    expect(invoke).toHaveBeenCalledWith("live:start", params);
  });

  it("stopLiveSession invokes live:stop", async () => {
    const { api, invoke } = build();
    await api.stopLiveSession();
    expect(invoke).toHaveBeenCalledWith("live:stop");
  });

  it("onLiveTick/onLiveCandleClose/onLiveStatus subscribe to their channels", () => {
    const { api, subscribe } = build();
    const tickHandler = vi.fn();
    const closeHandler = vi.fn();
    const statusHandler = vi.fn();

    api.onLiveTick(tickHandler);
    api.onLiveCandleClose(closeHandler);
    api.onLiveStatus(statusHandler);

    expect(subscribe).toHaveBeenCalledWith("live:tick", expect.any(Function));
    expect(subscribe).toHaveBeenCalledWith("live:candleClose", expect.any(Function));
    expect(subscribe).toHaveBeenCalledWith("live:status", expect.any(Function));
  });
```

(Adapt the `build()`/fake-invoke helper name to whatever this file's existing tests already call it — read the file first; do not introduce a second helper.)

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test -- rendererApi.test.ts`
Expected: PASS

- [ ] **Step 8: Wire it all up in `bootstrap.ts`**

In `electron-app/src/main/bootstrap.ts`, add the imports:

```typescript
import { createLiveSessionRunner } from "./services/market/liveSessionRunner";
import { registerLiveBridge } from "./ipc/liveBridge";
```

After `session`/`ticker` are declared and before the `registerAnalysisBridge` call, construct the runner (it needs `sendToRenderer`, already defined above it in the file, and `supervisor`/`history`, already constructed earlier):

```typescript
  const liveSessionRunner = createLiveSessionRunner({
    ticker: { subscribe: (...args) => session?.ticker.subscribe(...args), onTick: (...args) => session?.ticker.onTick(...args), onConnectionChange: (...args) => session?.ticker.onConnectionChange(...args) } as never,
    sidecar: supervisor,
    history,
    sendTick: (tick) => sendToRenderer("live:tick", tick),
    sendCandleClose: (payload) => sendToRenderer("live:candleClose", payload),
    sendStatus: (status) => sendToRenderer("live:status", status),
  });
```

**Judgment call, flagged for the implementer:** the `ticker` dep above needs care — `session` can be `null` before the first login, and the ticker itself only truly exists once `session.ticker` is set. Rather than the placeholder `as never` cast sketched above (which is not real code, just marking that this needs resolving), the correct approach is to defer wiring the runner until `login()` succeeds and `ticker`/`session` are non-null, e.g. move `createLiveSessionRunner(...)` to the same spot inside `login()`'s success path where `ticker = newSession.ticker;` is assigned, guarding it so the runner is (re)constructed only if it doesn't already exist yet (a re-login must not lose an in-progress live session by replacing the runner). Resolve this precisely when implementing — the test in Step 1 already proves `liveBridge.ts`/`liveSessionRunner.ts` work correctly in isolation; this step is pure wiring, and `bootstrap.ts` is not unit-tested for this kind of wiring in this codebase (Task 1 Step 10 established the same precedent). Register the bridge once, right after `registerAnalysisBridge(...)`:

```typescript
  registerLiveBridge({ ipcMain, runner: liveSessionRunner });
```

- [ ] **Step 9: Run the full suite and typecheck**

Run: `npm run typecheck && npm test` (from `electron-app/`)
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add electron-app/src/main/ipc/liveBridge.ts electron-app/src/main/ipc/rendererApi.ts electron-app/src/main/bootstrap.ts \
  electron-app/test/main/ipc/liveBridge.test.ts electron-app/test/main/ipc/rendererApi.test.ts
git commit -m "ipc: add live:* bridge (start/stop/tick/candleClose/status), wire into bootstrap"
```

---

### Task 6: `liveChart.ts` — renderer chart wrapper

**Files:**
- Create: `electron-app/src/renderer/liveChart.ts`
- Test: `electron-app/test/renderer/liveChart.test.ts`

**Interfaces:**
- Consumes: `lightweight-charts` (already a dependency; see `electron-app/src/renderer/benchmarkChart.ts` for this codebase's existing usage pattern of `createChart`/`CandlestickSeries`).
- Produces: `createLiveChart(container, initialCandles): LiveChartHandle` with `applyTick(tick)`/`applyClosedCandle(candle)`/`dispose()` — consumed by Task 8 (`LiveSessionView.tsx`).

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/renderer/liveChart.test.ts`:

```typescript
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createLiveChart } from "../../src/renderer/liveChart";

vi.mock("lightweight-charts", () => {
  const seriesUpdate = vi.fn();
  const seriesSetData = vi.fn();
  const addSeries = vi.fn(() => ({ update: seriesUpdate, setData: seriesSetData, priceLineVisible: undefined }));
  const chartRemove = vi.fn();
  const createChart = vi.fn(() => ({ addSeries, remove: chartRemove }));
  return { createChart, CandlestickSeries: "CandlestickSeries", __seriesUpdate: seriesUpdate, __seriesSetData: seriesSetData, __chartRemove: chartRemove };
});

describe("createLiveChart", () => {
  it("loads initial candles via setData", async () => {
    const { __seriesSetData } = (await import("lightweight-charts")) as unknown as { __seriesSetData: ReturnType<typeof vi.fn> };
    const container = document.createElement("div");
    const initial = [{ ts: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }];

    createLiveChart(container, initial);

    expect(__seriesSetData).toHaveBeenCalledWith([
      expect.objectContaining({ time: 1000, open: 1, high: 2, low: 0.5, close: 1.5 }),
    ]);
  });

  it("applyTick() calls series.update() with the forming bar's running OHLC", async () => {
    const { __seriesUpdate } = (await import("lightweight-charts")) as unknown as { __seriesUpdate: ReturnType<typeof vi.fn> };
    const container = document.createElement("div");
    const handle = createLiveChart(container, []);

    handle.applyTick({ ts: 1000, price: 100 }, 300); // 300 = interval in seconds (5 min)
    handle.applyTick({ ts: 1010, price: 105 }, 300);

    expect(__seriesUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ time: 1000, open: 100, high: 105, low: 100, close: 105 }));
  });

  it("applyClosedCandle() calls series.update() with the finished candle", async () => {
    const { __seriesUpdate } = (await import("lightweight-charts")) as unknown as { __seriesUpdate: ReturnType<typeof vi.fn> };
    const container = document.createElement("div");
    const handle = createLiveChart(container, []);

    handle.applyClosedCandle({ ts: 1000, open: 100, high: 106, low: 99, close: 101 });

    expect(__seriesUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ time: 1000, open: 100, high: 106, low: 99, close: 101 }));
  });

  it("dispose() removes the chart", async () => {
    const { __chartRemove } = (await import("lightweight-charts")) as unknown as { __chartRemove: ReturnType<typeof vi.fn> };
    const container = document.createElement("div");
    const handle = createLiveChart(container, []);

    handle.dispose();

    expect(__chartRemove).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- liveChart.test.ts` (from `electron-app/`)
Expected: FAIL with "Cannot find module '../../src/renderer/liveChart'"

- [ ] **Step 3: Write the implementation**

Create `electron-app/src/renderer/liveChart.ts`:

```typescript
import { createChart, CandlestickSeries, type UTCTimestamp } from "lightweight-charts";
import type { CandleWire } from "../main/services/sidecar/sidecarProtocol";
import type { LiveTickWire } from "../main/services/market/liveSessionRunner";

export interface LiveChartHandle {
  applyTick(tick: LiveTickWire, intervalSeconds: number): void;
  applyClosedCandle(candle: CandleWire): void;
  dispose(): void;
}

export function createLiveChart(container: HTMLElement, initialCandles: CandleWire[]): LiveChartHandle {
  const chart = createChart(container, { autoSize: true });
  const candleSeries = chart.addSeries(CandlestickSeries, { priceLineVisible: false });

  candleSeries.setData(
    initialCandles.map((c) => ({
      time: c.ts as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    })),
  );

  let forming: { ts: number; open: number; high: number; low: number; close: number } | null = null;

  return {
    applyTick(tick, intervalSeconds) {
      const bucket = Math.floor(tick.ts / intervalSeconds) * intervalSeconds;
      if (forming === null || forming.ts !== bucket) {
        forming = { ts: bucket, open: tick.price, high: tick.price, low: tick.price, close: tick.price };
      } else {
        forming.high = Math.max(forming.high, tick.price);
        forming.low = Math.min(forming.low, tick.price);
        forming.close = tick.price;
      }
      candleSeries.update({
        time: forming.ts as UTCTimestamp,
        open: forming.open,
        high: forming.high,
        low: forming.low,
        close: forming.close,
      });
    },
    applyClosedCandle(candle) {
      candleSeries.update({
        time: candle.ts as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      });
      forming = null;
    },
    dispose() {
      chart.remove();
    },
  };
}
```

**Note for the implementer:** `applyTick`'s bucket math here is presentation-only and intentionally simpler than `liveCandleTracker.ts`'s IST-wall-clock-aligned bucketing (Task 2) — it only needs to visually match whatever bucket the main process is *also* tracking closely enough that the chart's forming bar looks right; the authoritative close event (`applyClosedCandle`, driven by `live:candleClose`) is what actually corrects/finalizes the bar. If real-device testing (P17§11) shows any visible seam between the renderer's presentation bucketing and the main process's authoritative one, align this function's bucket math to the same `bucketStart` formula from `liveCandleTracker.ts` instead of duplicating slightly different logic — flag this as a concern in the task report either way so the controller can decide.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- liveChart.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/renderer/liveChart.ts electron-app/test/renderer/liveChart.test.ts
git commit -m "renderer: add live chart wrapper with incremental tick/candle-close updates"
```

---

### Task 7: `VerdictMeter.tsx` — the diverging bar

**Files:**
- Create: `electron-app/src/renderer/VerdictMeter.tsx`
- Test: `electron-app/test/renderer/VerdictMeter.test.tsx`

**Interfaces:**
- Produces: `VerdictMeter({ weightedVote: number })` React component — consumed by Task 8 (`LiveSessionView.tsx`).

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/renderer/VerdictMeter.test.tsx`:

```typescript
// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VerdictMeter } from "../../src/renderer/VerdictMeter";

afterEach(cleanup);

describe("VerdictMeter", () => {
  it("renders no text content at all -- direction/magnitude are visual only", () => {
    const { container } = render(<VerdictMeter weightedVote={0.62} />);
    expect(container.textContent).toBe("");
  });

  it("extends the fill to the right (bullish side) for a positive vote, sized to its magnitude", () => {
    const { container } = render(<VerdictMeter weightedVote={0.5} />);
    const fill = container.querySelector(".verdict-meter-fill") as HTMLElement;
    expect(fill.dataset.direction).toBe("bullish");
    expect(fill.style.width).toBe("25%"); // 0.5 * 50% half-track
  });

  it("extends the fill to the left (bearish side) for a negative vote", () => {
    const { container } = render(<VerdictMeter weightedVote={-0.3} />);
    const fill = container.querySelector(".verdict-meter-fill") as HTMLElement;
    expect(fill.dataset.direction).toBe("bearish");
    expect(fill.style.width).toBe("15%"); // 0.3 * 50%
  });

  it("renders a neutral (zero-width) fill at exactly zero", () => {
    const { container } = render(<VerdictMeter weightedVote={0} />);
    const fill = container.querySelector(".verdict-meter-fill") as HTMLElement;
    expect(fill.style.width).toBe("0%");
  });

  it("clamps a vote outside [-1, 1] to the track's full half-width", () => {
    const { container } = render(<VerdictMeter weightedVote={1.4} />);
    const fill = container.querySelector(".verdict-meter-fill") as HTMLElement;
    expect(fill.style.width).toBe("50%");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- VerdictMeter.test.tsx` (from `electron-app/`)
Expected: FAIL with "Cannot find module '../../src/renderer/VerdictMeter'"

- [ ] **Step 3: Write the implementation**

Create `electron-app/src/renderer/VerdictMeter.tsx`:

```typescript
import "./VerdictMeter.css";

export interface VerdictMeterProps {
  weightedVote: number; // range [-1, 1]; positive = bullish, negative = bearish
}

// Direction is encoded by which side of the fixed center line the fill
// extends toward (and the arrow glyph's own direction), never by color
// alone -- this app's real --bullish/--bearish tokens fail a red-green
// colorblind separation check (P17§6), and this meter has no text label to
// fall back on the way older, prose-based verdict text did.
export function VerdictMeter({ weightedVote }: VerdictMeterProps): JSX.Element {
  const clamped = Math.max(-1, Math.min(1, weightedVote));
  const direction = clamped > 0 ? "bullish" : clamped < 0 ? "bearish" : "neutral";
  const widthPercent = Math.abs(clamped) * 50;

  return (
    <div className="verdict-meter" role="img" aria-label={`Confluence ${direction}, strength ${Math.abs(clamped).toFixed(2)}`}>
      <div className="verdict-meter-track">
        <div className="verdict-meter-center" />
        <div
          className={`verdict-meter-fill verdict-meter-fill-${direction}`}
          data-direction={direction}
          style={{ width: `${widthPercent}%` }}
        >
          {direction !== "neutral" && (
            <span className={`verdict-meter-arrow verdict-meter-arrow-${direction}`} aria-hidden="true" />
          )}
        </div>
      </div>
    </div>
  );
}
```

Create `electron-app/src/renderer/VerdictMeter.css` (positioning only — exact colors/spacing/arrow glyph styling can draw on this app's existing `--bullish`/`--bearish`/`--space-*` tokens from `tokens.css`; left to the implementer's visual judgment within those tokens, since this is styling polish, not a behavioral requirement):

```css
.verdict-meter {
  width: 100%;
  padding: var(--space-2) var(--space-4);
}

.verdict-meter-track {
  position: relative;
  height: 12px;
  background: var(--bg-elevated);
  border-radius: var(--radius-sm);
}

.verdict-meter-center {
  position: absolute;
  left: 50%;
  top: -4px;
  bottom: -4px;
  width: 2px;
  background: var(--border-strong);
}

.verdict-meter-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
}

.verdict-meter-fill-bullish {
  background: var(--bullish);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}

.verdict-meter-fill-bearish {
  left: auto;
  right: 50%;
  background: var(--bearish);
  border-radius: var(--radius-sm) 0 0 var(--radius-sm);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- VerdictMeter.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/renderer/VerdictMeter.tsx electron-app/src/renderer/VerdictMeter.css electron-app/test/renderer/VerdictMeter.test.tsx
git commit -m "renderer: add the diverging-bar verdict meter -- direction by position, not color alone"
```

---

### Task 8: `LiveSessionView.tsx` + `App.tsx`/`InstrumentSearch.tsx` wiring

**Files:**
- Create: `electron-app/src/renderer/LiveSessionView.tsx`
- Test: `electron-app/test/renderer/LiveSessionView.test.tsx`
- Modify: `electron-app/src/renderer/App.tsx`
- Modify: `electron-app/src/renderer/InstrumentSearch.tsx`
- Test: `electron-app/test/renderer/App.test.tsx`

**Interfaces:**
- Consumes: `liveChart.ts` (Task 6), `VerdictMeter.tsx` (Task 7), `rendererApi.ts`'s `startLiveSession`/`stopLiveSession`/`onLiveTick`/`onLiveCandleClose`/`onLiveStatus` (Task 5).

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/renderer/LiveSessionView.test.tsx`:

```typescript
// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveSessionView } from "../../src/renderer/LiveSessionView";

vi.mock("../../src/renderer/liveChart", () => ({
  createLiveChart: vi.fn(() => ({ applyTick: vi.fn(), applyClosedCandle: vi.fn(), dispose: vi.fn() })),
}));

afterEach(cleanup);

function fakeBridge(overrides: Record<string, unknown> = {}) {
  return {
    startLiveSession: vi.fn().mockResolvedValue(undefined),
    stopLiveSession: vi.fn().mockResolvedValue(undefined),
    onLiveTick: vi.fn(),
    onLiveCandleClose: vi.fn(),
    onLiveStatus: vi.fn(),
    ...overrides,
  };
}

const SESSION_PROPS = {
  sessionId: "s1",
  assistantMessageId: "m1",
  instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
  interval: "5minute" as const,
  initialCandles: [],
  initialConfluence: { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 },
};

describe("LiveSessionView", () => {
  it("calls startLiveSession on mount with the session's params", () => {
    const bridge = fakeBridge();
    render(<LiveSessionView {...SESSION_PROPS} bridge={bridge} />);

    expect(bridge.startLiveSession).toHaveBeenCalledWith({
      sessionId: "s1",
      assistantMessageId: "m1",
      instrument: SESSION_PROPS.instrument,
      interval: "5minute",
    });
  });

  it("calls stopLiveSession on unmount", () => {
    const bridge = fakeBridge();
    const { unmount } = render(<LiveSessionView {...SESSION_PROPS} bridge={bridge} />);

    unmount();

    expect(bridge.stopLiveSession).toHaveBeenCalledTimes(1);
  });

  it("renders no prose text anywhere -- chart container and verdict meter only", () => {
    const bridge = fakeBridge();
    const { container } = render(<LiveSessionView {...SESSION_PROPS} bridge={bridge} />);

    // The verdict meter itself asserts zero text content elsewhere (VerdictMeter.test.tsx);
    // this asserts the view as a whole adds nothing on top of it (no headings, no captions).
    const textNodes = Array.from(container.querySelectorAll("*")).filter(
      (el) => el.children.length === 0 && el.textContent && el.textContent.trim().length > 0,
    );
    expect(textNodes).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- LiveSessionView.test.tsx` (from `electron-app/`)
Expected: FAIL with "Cannot find module '../../src/renderer/LiveSessionView'"

- [ ] **Step 3: Write the implementation**

Create `electron-app/src/renderer/LiveSessionView.tsx`:

```typescript
import { useEffect, useRef } from "react";
import { createLiveChart } from "./liveChart";
import { VerdictMeter } from "./VerdictMeter";
import { intervalMinutes } from "../main/services/market/candleInterval";
import type { CandleInterval } from "../main/services/market/candleInterval";
import type { CandleWire, ConfluenceWire } from "../main/services/sidecar/sidecarProtocol";
import type { InstrumentSelection, RendererApi } from "../main/ipc/rendererApi";
import "./LiveSessionView.css";

export interface LiveSessionViewProps {
  sessionId: string;
  assistantMessageId: string;
  instrument: InstrumentSelection;
  interval: CandleInterval;
  initialCandles: CandleWire[];
  initialConfluence: ConfluenceWire;
  bridge: Pick<RendererApi, "startLiveSession" | "stopLiveSession" | "onLiveTick" | "onLiveCandleClose" | "onLiveStatus">;
}

export function LiveSessionView(props: LiveSessionViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const weightedVoteRef = useRef(props.initialConfluence.weighted_vote);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createLiveChart(containerRef.current, props.initialCandles);
    const intervalSeconds = intervalMinutes(props.interval) * 60;

    props.bridge.onLiveTick((tick) => chart.applyTick(tick, intervalSeconds));
    props.bridge.onLiveCandleClose((payload) => {
      chart.applyClosedCandle(payload.candle);
      weightedVoteRef.current = payload.confluence.weighted_vote;
    });
    props.bridge.onLiveStatus(() => {
      // Connection status surfaces via the existing StatusDot/banner pattern
      // at the App shell level (P17§9), not inside this view -- nothing to
      // do here beyond receiving the event so it doesn't go unhandled.
    });

    void props.bridge.startLiveSession({
      sessionId: props.sessionId,
      assistantMessageId: props.assistantMessageId,
      instrument: props.instrument,
      interval: props.interval,
    });

    return () => {
      void props.bridge.stopLiveSession();
      chart.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session identity (sessionId) is this effect's real dependency; re-running it on every prop identity change would restart the live session unnecessarily.
  }, [props.sessionId]);

  return (
    <div className="live-session-view">
      <div className="live-session-chart" ref={containerRef} />
      <VerdictMeter weightedVote={weightedVoteRef.current} />
    </div>
  );
}
```

**Judgment call, flagged for the implementer:** `weightedVoteRef` is a ref, not state — updating it inside `onLiveCandleClose` will not re-render `VerdictMeter` with the new value, since refs don't trigger React re-renders. Replace it with `useState` (`const [weightedVote, setWeightedVote] = useState(props.initialConfluence.weighted_vote)`, `setWeightedVote(payload.confluence.weighted_vote)` in the close handler, pass `weightedVote` to `<VerdictMeter>`) before this task is done — the sketch above was left as a ref to flag this exact mistake for a reviewer to catch if it ships wrong; write it correctly with `useState` in the actual implementation, and add a test proving the meter's rendered fill width changes after a `live:candleClose` event fires (extend Step 1's test file with this case rather than leaving it unverified).

Create `electron-app/src/renderer/LiveSessionView.css` (layout only, following this app's existing token/spacing conventions — content pane fills available height, chart takes the bulk of it, meter is a thin strip beneath, matching the approved visual-companion mockup):

```css
.live-session-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.live-session-chart {
  flex: 1;
  min-height: 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- LiveSessionView.test.tsx`
Expected: PASS (4 tests, including the added weighted-vote-updates-on-close case from the judgment call above)

- [ ] **Step 5: Wire `App.tsx`**

In `electron-app/src/renderer/App.tsx`, replace the Engine-Only render branch:

```typescript
          {activeSession.mode === "engine_only" ? (
            <>
              <InstrumentSearch onSubmit={onAnalyze} />
              {analysisError && <Banner variant="error">{analysisError}</Banner>}
              {readiness && <Banner variant="info">{readinessMessage(readiness)}</Banner>}
              {!readiness && result && !(suppressStaleBlocked && result.mode === "engine_only_blocked") && (
                <AnalysisResultView result={result} history={history} />
              )}
            </>
          ) : (
```

to:

```typescript
          {activeSession.mode === "engine_only" ? (
            <>
              <InstrumentSearch onSubmit={onAnalyze} />
              {analysisError && <Banner variant="error">{analysisError}</Banner>}
              {readiness && <Banner variant="info">{readinessMessage(readiness)}</Banner>}
              {!readiness && result && result.mode === "engine_only" && !suppressStaleBlocked && (
                <LiveSessionView
                  sessionId={activeSession.id}
                  assistantMessageId={result.assistantMessageId}
                  instrument={result.instrument}
                  interval={result.interval}
                  initialCandles={result.initialCandles}
                  initialConfluence={result.confluence}
                  bridge={bridge()}
                />
              )}
            </>
          ) : (
```

Add the import: `import { LiveSessionView } from "./LiveSessionView";`

**Judgment call, flagged for the implementer — read carefully, this resolves a real gap found during this plan's self-review:**

`result.instrument`/`result.interval` already exist on today's `AnalysisResult`'s `engine_only` variant, but `assistantMessageId` and `initialCandles` do not, and `App.tsx`'s current `deriveEngineOnlyView(sessionDetail)` helper only returns `{ result, history }` derived from the stored messages, not a message id.

Do **not** store `assistantMessageId` inside `structured_payload` — the id is generated by `history.appendMessage()` *after* the object being appended already has to exist, so embedding the id inside its own payload requires an awkward second write. Instead, thread it through as a sibling of `result`, the same way `deriveEngineOnlyView` already threads `history` alongside `result`:

1. In `App.tsx`, extend `deriveEngineOnlyView`'s return type to also include the last assistant message's own `id` (now available on `HistoryMessage` per Task 3 Step 0) — e.g. `{ result, resultMessageId, history }`, where `resultMessageId = messages[lastAssistantIndex]?.id`.
2. Pass `assistantMessageId={resultMessageId}` to `<LiveSessionView>` instead of `result.assistantMessageId`.
3. For `initialCandles`: this one *is* legitimate to store in `structured_payload`, since it doesn't depend on its own message's id — extend `AnalysisResult`'s `engine_only` variant (in `rendererApi.ts`) and `runAnalysisRequest` (in `analysisBridge.ts`) to also return the warmed candle set already available in `readiness.warmed.candles` (see `readinessGate.ts`'s `WarmedCandles` — the exact historical candles this same request already fetched, so no second fetch is needed). Add a corresponding test to `analysisBridge.test.ts`.

Read `App.tsx`'s current `deriveEngineOnlyView`, `analysisBridge.ts`'s current `runAnalysisRequest`, and `readinessGate.ts`'s `ReadinessResult`/`WarmedCandles` types first to wire this precisely — do not guess at field names beyond what's specified here.

- [ ] **Step 6: Wire `InstrumentSearch.tsx`**

No change needed — `InstrumentSearch`'s `onSubmit` prop already is `App.tsx`'s `onAnalyze`, which already calls `bridge().runAnalysis(...)`; `LiveSessionView` itself calls `startLiveSession` on mount (Step 3), triggered by `App.tsx` rendering it once `result.mode === "engine_only"` is true after a successful analyze. Confirm this during implementation by tracing the actual data flow in the current `App.tsx`/`InstrumentSearch.tsx` — if it turns out `onAnalyze` needs an explicit additional call, add it there instead of duplicating logic in `LiveSessionView`, and update this plan step's file list accordingly in the task's report.

- [ ] **Step 7: Update `App.test.tsx`**

Add/adjust a test asserting that after a successful Engine-Only analyze, `LiveSessionView` (not `AnalysisResultView`) renders — read the existing "runs an Engine-Only analysis..." test in this file first and adapt it minimally (mock `bridge().startLiveSession`/`onLiveTick`/etc. the same way `runAnalysis`/`checkReadiness` are already mocked there) rather than rewriting the whole file's fixture setup.

- [ ] **Step 8: Run the full suite and typecheck**

Run: `npm run typecheck && npm test` (from `electron-app/`)
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add electron-app/src/renderer/LiveSessionView.tsx electron-app/src/renderer/LiveSessionView.css \
  electron-app/src/renderer/App.tsx electron-app/src/main/ipc/analysisBridge.ts electron-app/src/main/ipc/rendererApi.ts \
  electron-app/test/renderer/LiveSessionView.test.tsx electron-app/test/renderer/App.test.tsx electron-app/test/main/ipc/analysisBridge.test.ts
git commit -m "renderer: wire the live session view into Engine-Only's Analyze flow"
```

---

### Task 9: Manual verification (not automatable — requires a live, paid Kite Connect account during market hours)

- [ ] **Step 1:** Start a live Engine-Only session on a liquid NSE instrument during market hours. Confirm the chart's current bar visibly updates as ticks arrive.
- [ ] **Step 2:** Confirm a real candle close (wait for a 5-minute boundary, or use the 5-minute interval for the fastest turnaround) triggers a visible verdict-meter update, and check the candle lake / sidecar logs to confirm `persistCandles`+`compute` actually ran.
- [ ] **Step 3:** Switch to a different session, then reopen the live one. Confirm it auto-resumes tracking with no prompt.
- [ ] **Step 4:** Briefly disconnect network access. Confirm the ticker recovers automatically once connectivity returns, with no crash (the fix from Task 1 is what prevents the `process.exit(1)` footgun here).
- [ ] **Step 5:** If practical, run across a daily token-expiry boundary (or force an invalid token). Confirm re-login updates the same ticker's credentials (per Task 1) without needing an app restart, and that the live session resumes once ticks start flowing again.
- [ ] **Step 6:** Report back that this is done. This closes out the two-phase live-dashboard project the user asked to be reminded about.
