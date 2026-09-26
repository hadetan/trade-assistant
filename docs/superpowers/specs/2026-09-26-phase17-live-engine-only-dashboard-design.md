# Phase 17 — Live Engine-Only Dashboard

Status: approved by user 2026-09-26 (brainstorming dialogue, incl. a visual-companion round for the verdict meter layout), pending implementation planning.
Author: design produced via `superpowers:brainstorming`. Section references: "§N" → master design (`2026-07-18-trade-assistant-design.md`); "P16§N" → `2026-09-26-phase16-kite-connect-direct-api-design.md`, whose native Kite Connect client (merged, PR #23) this phase is the first real consumer of; "P17§N" → this document.

## P17§1 Purpose

The user's original ask: turn Engine-Only mode from a one-shot query/response tool into an always-on, full-screen, visual-only live dashboard. Once a session's setup (mode, timeframe, instrument, intent) is submitted, the chart runs continuously with no further prompts until the session/app closes, with the full algorithm suite re-scoring on every closed candle and the verdict shown purely visually — no prose, no "the algo said X" text. AI-Assisted mode is explicitly out of scope and untouched.

Phase 16 built the prerequisite — a genuine WebSocket tick feed — but deliberately built and tested `kiteTicker.ts` in isolation, connecting nothing to it (P16§7, P16§2 invariant e). This phase is that first real consumer, and in becoming one, surfaces a real defect in Phase 16's design that only matters once something actually calls `.connect()`/`.subscribe()`: **`kiteTicker.ts` currently constructs a brand-new ticker on every login and disconnects the old one first — and the underlying `kiteconnect@5.3.0` library keeps its connection state at module scope, not per-instance.** Research against the real installed library source (not docs, not the `.d.ts` types) found:

- `disconnect()` sets a module-level `should_reconnect = false` that is **never reset anywhere in the file** — not by `connect()`, not by anything else. Any ticker constructed afterward inherits this and calls `process.exit(1)` on its own very first disconnect.
- `connect()` called while a socket is already open/connecting is a **pure no-op** (an early-return guard) — it does not restart the connection with new credentials.
- There is **no public way to force-close the socket** other than the poisoning `disconnect()` — `ws` is a module-private closure variable, never exposed.
- `current_reconnection_count` **does** reset to 0 on every successful open, so a ticker that reconnects periodically throughout a trading day never actually approaches `reconnect_max_tries` (300) — that part is fine as-is.
- `api_key`/`access_token` are plain instance fields, re-read fresh on every `connect()` call (including the ones the library's own auto-reconnect timer triggers).

The only safe pattern this library version supports: **construct exactly one `KiteTicker` for the entire app process lifetime, never call `.disconnect()` on it except at final app quit, and handle daily token refresh by reassigning its credential fields directly** — the new token takes effect the next time the socket naturally reconnects (a network blip, or Kite's own server closing the old session around its daily expiry), not immediately. This is locked in as Task 1 of this phase's plan (P17§3), fixing Phase 16's login/ticker wiring before building anything on top of it.

## P17§2 Scope

**In scope:**

1. The ticker singleton + credential-refresh fix (P17§3) — touches `kiteTicker.ts`, `kiteLogin.ts`, `bootstrap.ts`.
2. Live tick → chart pipeline and candle-close → recompute pipeline (P17§4).
3. A new full-screen-in-content-pane live session view, replacing `AnalysisResultView` for the Engine-Only "Analyze" flow only (P17§7). `InstrumentSearch`/`IntentLensSelector`/`ModePicker` — unchanged (locked decision, P17§2 item 8).
4. The verdict meter — a diverging bar under the chart, direction encoded by position (not color alone), confirmed via the visual companion (P17§6).
5. A `HistoryStore.updateMessage` method so a live session's recurring recomputes update one message in place instead of appending a new one every candle close (P17§8).
6. Auto-resume: reopening a previously-started live session re-subscribes and picks back up automatically, through the same readiness gate as starting fresh (P17§7).

**Not in scope (deferred or permanently out of scope):**

- Anything in AI-Assisted mode — completely untouched.
- Multi-instrument/multi-chart dashboards — one live session tracks exactly one instrument, matching today's Engine-Only model.
- Any projected/forecasted future price path ("ghost candles") — explicitly ruled out by the user in the original brainstorming: no algo or forecaster in this codebase outputs more than a single-step direction/magnitude/confidence, and nothing here invents data the core doesn't support.
- True full-screen (sidebar/nav hidden) — explicitly declined; the live view renders in the content pane like every other screen in this app.
- Any change to the Kite Connect REST client, instrument master, or safety invariants from Phase 16 — this phase only adds a consumer of the already-built ticker.

**Locked decisions this document writes up verbatim (each an explicit user decision from the brainstorming session, including one visual-companion round):**

1. **Ticker lifecycle fix folded into this phase as Task 1**, not a separate prerequisite PR — Phase 2 is the first thing that actually exercises the connection, so the fix and its first real usage land as one reviewed unit.
2. **Architecture: renderer aggregates ticks for the chart; main process triggers compute on candle close.** Chosen over (a) main-process-aggregates-and-throttles (duplicates work `lightweight-charts` already does natively) and (b) pushing tick-aggregation into the Rust sidecar (would require a new streaming wire-protocol between Electron and the sidecar subprocess, disproportionate for a UI feature).
3. **Recompute (the full algo suite + confluence) only on candle close, never per-tick.** Ticks update the forming candle's visual shape only.
4. **Verdict meter: a diverging bar under the chart** (option A of three shown via the visual companion — a vertical thermometer gauge and a chart-overlay arrow were the other two, not chosen). Direction encoded by which side of a fixed center line the bar extends toward, length by `|weighted_vote|`, plus an arrow at the bar's tip as a redundant non-color cue — because a `dataviz` accessibility check on this app's real `--bullish`/`--bearish` colors found they **fail red-green colorblind separation** (ΔE 5.0, below even the minimum floor), and this UI removes the textual backup ("Overall read: bullish") that made that failure harmless before.
5. **History storage: one message per live session, updated in place** on every candle close (requires a new `HistoryStore.updateMessage` method) — not one appended message per close, which would flood the history table (~75 messages across one 5-minute-bar trading day).
6. **Reopening a live session auto-resumes tracking** — session being open is itself the signal to run live, per the user's original framing; no separate "resume" action.
7. **Setup flow unchanged; content-pane-only scope (sidebar stays visible)** — both confirmed explicitly rather than assumed.

## P17§3 Task 1 — the ticker singleton + credential-refresh fix

### P17§3.1 `kiteTicker.ts` changes

`KiteTickerLike` gains two writable credential fields (already present as plain instance fields on the real library, confirmed by reading its source — not previously declared on this narrow interface because nothing needed to write them):

```typescript
export interface KiteTickerLike {
  connect(): void;
  disconnect(): void;
  subscribe(tokens: number[]): void;
  setMode(mode: string, tokens: number[]): void;
  autoReconnect(enable: boolean, maxRetry: number, maxDelaySeconds: number): void;
  connected(): boolean;
  on(event: string, callback: (...args: unknown[]) => void): void;
  modeLTP: string;
  modeQuote: string;
  modeFull: string;
  api_key: string;
  access_token: string;
}
```

`KiteTickerClient` gains one method, replacing the constructor-only credential path:

```typescript
export interface KiteTickerClient {
  connect(): void;
  updateCredentialsAndConnect(apiKey: string, accessToken: string): void;
  subscribe(instrumentTokens: number[], mode?: "ltp" | "quote" | "full"): void;
  onTick(handler: (ticks: unknown[]) => void): void;
  onConnectionChange(handler: (status: TickerConnectionStatus) => void): void;
  disconnect(): void;
}
```

```typescript
updateCredentialsAndConnect(apiKey: string, accessToken: string): void {
  // connect() is a no-op if the socket is already open/connecting (verified
  // against the real library source), so this is always safe to call: on
  // first-ever login it establishes the initial connection; on every later
  // re-login it just updates the credentials the library will use the next
  // time it naturally reconnects (this library's disconnect() permanently
  // disables auto-reconnect at module scope for the rest of the process --
  // see the comment on autoReconnect() below -- so there is no way to force
  // an immediate reconnect with the new token, only a lazy one).
  ticker.api_key = apiKey;
  ticker.access_token = accessToken;
  ticker.connect();
}
```

The existing `ticker.autoReconnect(true, 300, 5)` call and its explaining comment (added in Phase 16's final-review fix batch) stay as-is — still correct, unrelated to this change.

### P17§3.2 `kiteLogin.ts` changes

`KiteSession` drops nothing and gains nothing (`{ kite, ticker }` stays as Phase 16 left it) — but `ticker` is now the *same instance* across every login within one process, not a fresh one each time:

```typescript
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
  existingTicker?: KiteTickerClient; // passed by bootstrap.ts on every login after the first
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

`close()` is removed from `KiteSession` entirely — there is nothing left to close per-login (REST calls are stateless; the ticker outlives any single login and is disconnected exactly once, at app quit, by `bootstrap.ts` directly, not through a session's `close()`).

### P17§3.3 `bootstrap.ts` changes

The `login()` closure holds the ticker reference across calls and threads it back in:

```typescript
let ticker: KiteTickerClient | null = null;
// ... inside login()'s try block, replacing the old runKiteLogin(...) call:
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
ticker = newSession.ticker; // first login: stores it; every later login: same reference back
session = newSession;
```

The old `if (previousSession && previousSession !== newSession) void previousSession.close().catch(...)` block is deleted — there is no `close()` anymore (P17§3.2). **A second, separate call site needs the same fix**, found by re-reading `bootstrap.ts`'s current (post-Phase-16) state rather than relying on this document's earlier draft: `sessionState.on("change", (status) => { if (status === "needsLogin" && session) { const closing = session; session = null; void closing.close().catch(() => {}); } })` (bootstrap.ts:113-119) fires whenever *any* live REST call detects session expiry, not only on explicit re-login. It becomes:

```typescript
sessionState.on("change", (status: KiteSessionStatus) => {
  if (status === "needsLogin" && session) {
    session = null;
  }
});
```

(nulling `session` is still necessary — that's what makes subsequent IPC calls correctly reject with "not logged in" — only the now-nonexistent `.close()` call is removed.)

A new one-time hook disconnects the ticker at process exit, the only point `.disconnect()` is ever safe to call:

```typescript
app.on("before-quit", () => {
  ticker?.disconnect();
});
```

### P17§3.4 Testing

- `kiteTicker.test.ts` — new case: `updateCredentialsAndConnect` sets both credential fields on the fake then calls `.connect()`.
- `kiteLogin.test.ts` — new case: passing `existingTicker` in deps skips constructing a new one and calls `updateCredentialsAndConnect` on the passed-in fake instead; the no-`existingTicker` (first-login) path still constructs via `createTicker`.
- `bootstrap.test.ts` — new case (or extend existing login-flow coverage): a second `login()` call reuses the same ticker reference as the first; `app.on("before-quit")` calls `disconnect()` exactly once on whatever ticker is current.

## P17§4 Live data pipeline architecture

### P17§4.1 Tick → chart (renderer-owned)

The main process forwards every tick for the subscribed instrument to the renderer, unmodified beyond extracting the one relevant tick from the ticker's per-batch array (the ticker is only ever subscribed to one instrument token in this phase — matching Engine-Only's one-instrument-at-a-time model):

```typescript
export interface LiveTickWire {
  ts: number; // unix seconds
  price: number;
}
```

The renderer feeds each tick straight into `lightweight-charts`' incremental single-point update (`candleSeries.update(bar)` — the same API `benchmarkChart.ts` already imports from this package, just called per-tick instead of via `setData` for a bulk load). The renderer keeps a small in-memory accumulator for "the currently-forming bar": on the first tick of a new interval bucket, start a new bar (`open = high = low = close = price`); on every later tick within the same bucket, update `high`/`low`/`close` and call `.update()` again with the same `time` — `lightweight-charts` overwrites the existing bar rather than adding a new one when the `time` matches. This accumulator is presentation-only and is *not* the source of truth for the persisted candle (P17§4.2 is).

### P17§4.2 Candle close → recompute (main-process-owned)

A new pure module, no I/O, with its own focused test file:

```typescript
// electron-app/src/main/services/market/liveCandleTracker.ts
export interface LiveCandle {
  ts: number; // bucket start, unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

export class LiveCandleTracker {
  constructor(private readonly intervalMinutes: number) {}

  // Bucket boundary = floor(minutes-since-IST-midnight / intervalMinutes) *
  // intervalMinutes, matching how Kite's own historical 5/10/15-minute bars
  // are aligned (wall-clock marks from midnight IST, not session-open-relative
  // offsets) -- so a live-built candle's timestamp lines up with the
  // already-persisted historical candles preceding it in the same chart.
  // Returns the just-closed candle if this tick's bucket differs from the
  // currently-forming one (bucketing forward-fills from wall-clock time, so a
  // gap in ticks -- e.g. an illiquid instrument -- still closes on schedule
  // the next tick that arrives after the boundary, not only on a tick
  // landing exactly on it), otherwise null.
  onTick(ts: number, price: number): LiveCandle | null { /* ... */ }
}
```

An orchestrating file wires this to the ticker and the sidecar (I/O-heavy, matching CLAUDE.md's pure-logic-vs-I/O split):

```typescript
// electron-app/src/main/services/market/liveSessionRunner.ts
export interface LiveSessionRunnerDeps {
  ticker: Pick<KiteTickerClient, "subscribe" | "onTick" | "onConnectionChange">;
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles">;
  history: Pick<HistoryStore, "updateMessage">;
  sendTick: (tick: LiveTickWire) => void;
  sendCandleClose: (payload: { candle: CandleWire; algo_results: AlgoResultWire[]; confluence: ConfluenceWire }) => void;
  sendStatus: (status: TickerConnectionStatus) => void;
}

export interface LiveSessionRunner {
  start(params: { sessionId: string; instrument: InstrumentRef; interval: CandleInterval; intentLens: IntentLens }): void;
  stop(): void;
}
```

`start()` subscribes the ticker to the instrument's token in `"full"` mode (LTP is the only field this phase reads today, but `"full"` is what Phase 16's wrapper already defaults to, and it costs nothing extra over the websocket), constructs a `LiveCandleTracker` for the session's interval, and wires: every tick → `sendTick` (P17§4.1) + `tracker.onTick(...)`; whenever `onTick` returns a closed candle → `sidecar.persistCandles` → `sidecar.compute` (the same two calls `historicalDataArchive.ts`/`candleWarmup.ts` already make, reused here, not reinvented) → `history.updateMessage` with the fresh snapshot → `sendCandleClose`. `stop()` unsubscribes (the ticker itself stays connected — only this session's *subscription* ends) and tears down the tracker.

Only one `LiveSessionRunner` is ever active at a time, owned by `bootstrap.ts` alongside the ticker — starting a new live session (or opening a different one) calls `.stop()` on whatever was running first (P17§7).

### P17§4.3 IPC surface

New channels, matching this codebase's existing `invoke`/push-`subscribe` pattern (`traceBridge.ts`, `benchmark:progress`):

- `live:start` (invoke) — `{ sessionId, instrument, interval, intentLens }` → starts the runner unconditionally; it does **not** re-run the readiness gate itself, since by the time anything calls it, the caller has already just confirmed readiness (either the immediately-preceding `runAnalysis` call on first start, or the existing `checkReadiness` call `App.tsx`'s reopen path already makes, P13§2 decision 5) — re-checking here would mean two readiness checks (and two Kite quote round-trips) within milliseconds of each other for no benefit.
- `live:stop` (invoke) — `{ sessionId }`.
- `live:tick` (push) → `LiveTickWire`.
- `live:candleClose` (push) → `{ candle: CandleWire; algo_results: AlgoResultWire[]; confluence: ConfluenceWire }`.
- `live:status` (push) → `TickerConnectionStatus`.

`rendererApi.ts` gains matching methods (`startLiveSession`, `stopLiveSession`, `onLiveTick`, `onLiveCandleClose`, `onLiveStatus`), built the same way every existing method in that file is.

## P17§5 Renderer — `LiveSessionView`

Replaces `AnalysisResultView` for the Engine-Only "Analyze" flow only (`App.tsx`'s `activeSession.mode === "engine_only"` branch). `InstrumentSearch`'s `onSubmit` now, after the existing `runAnalysis` call succeeds (unchanged — still produces the initial historical view + first scorecard exactly as today), also calls `bridge().startLiveSession(...)`.

- `electron-app/src/renderer/liveChart.ts` — wraps `lightweight-charts` the same way `benchmarkChart.ts` does (`createChart`, `CandlestickSeries`), but exposes an `applyTick(tick)`/`applyClosedCandle(candle)` pair instead of a one-time `setData` — the live equivalent of that file's already-proven pattern.
- `electron-app/src/renderer/VerdictMeter.tsx` — the diverging bar (P17§2 item 4): a fixed-center track, a fill `div` whose width is `|weighted_vote| * 50%` anchored to the left or right half depending on sign, an arrow glyph at the fill's leading edge, colored with the existing `--bullish`/`--bearish` tokens for reinforcement (not as the only signal, per the accessibility finding). Receives only a `weighted_vote: number` prop — no text is rendered inside it at all, matching the "no prose" requirement.
- `electron-app/src/renderer/LiveSessionView.tsx` — mounts the chart + meter, subscribes to `onLiveTick`/`onLiveCandleClose`/`onLiveStatus` on mount, calls `stopLiveSession` on unmount (covers both "navigate away" and "app closing" — React's unmount fires for both).

## P17§6 Verdict meter — accessibility

Confirmed via `dataviz`'s validator: this app's real `--bullish`/`--bearish` pair (`#16a34a`/`#dc2626` dark, `#15803d`/`#b91c1c` light) fails CVD (colorblind) separation (ΔE 5.0, below the 6–8 floor). Per the skill's non-negotiables ("identity is never color-alone"), this phase does not fix the app-wide token pair (out of scope, used elsewhere for text-paired badges where it's harmless) but ensures the meter's own direction signal never depends on it: position (which side of center) and shape (the arrow) both encode direction independently of hue.

## P17§7 Session lifecycle

1. **Start:** `InstrumentSearch`'s existing submit → `runAnalysis` (unchanged) → on success, `startLiveSession`. Readiness gate reused verbatim (`kite_not_connected`/`insufficient_history`/`market_closed` banners render exactly as today if it fails).
2. **Only one live session hot at a time:** starting a new one, or opening a different session from the sidebar, calls `stopLiveSession` for whatever was previously running before starting the new one. The ticker itself is never touched by this (P17§3) — only the per-session subscription and recompute loop stop.
3. **Reopen auto-resumes:** opening an existing live-mode session from the sidebar re-runs the readiness gate (same as today's reopen behavior, P13§2 decision 5) and, if it passes, calls `startLiveSession` again automatically — no separate resume action.
4. **App quit:** the ticker disconnects once (P17§3.3); no per-session teardown needed beyond what unmounting already does.

## P17§8 History storage

```typescript
// appendMessage's return type changes from void to string (the id it already
// generates internally via randomUUID() but previously never handed back) --
// backward compatible, since every existing call site currently discards the
// return value. New method, alongside it:
appendMessage(params: AppendMessageParams): string;
updateMessage(params: { messageId: string; renderedText: string; structuredPayload: unknown }): void;
```

A live session's turn: one `appendMessage` (role: user) at start, exactly like today's Engine-Only flow; one `appendMessage` (role: assistant) after the *first* compute, capturing its returned id; every subsequent candle-close calls `updateMessage` on that same id instead of appending — reopening the session later shows only the latest snapshot, and the message list never grows past two rows for a live session no matter how long it runs. Candle-close updates pass `renderedText: ""` (the `rendered_text` column is `NOT NULL` but an empty string is valid) since `LiveSessionView` never renders prose — only the initial assistant message (produced by the reused `runAnalysis` call, P17§7 step 1) has real generated text, and nothing displays it either; it rides along unused rather than being specially suppressed, since suppressing it would mean forking `runAnalysisRequest`'s existing behavior for no functional benefit.

## P17§9 Error handling

- **Ticker connection drops mid-session:** the library's own `autoReconnect(true, 300, 5)` (Phase 16) handles it; `live:status` pushes `"reconnecting"` → a small status indicator (reusing the existing `StatusDot` component pattern), not a blocking banner — ticks simply pause until reconnected, the chart doesn't error out.
- **`noreconnect` (all 300 retries exhausted):** `live:status` pushes `"error"`; `LiveSessionView` shows the same kind of banner the readiness gate already uses, with a manual "restart live session" action that just re-runs `startLiveSession`.
- **Market closes mid-session** (session left open overnight/across a holiday): the next tick simply never arrives — no special handling needed beyond what already happens (the chart's last candle stays as the last frame; reopening re-runs the readiness gate, which already has a `market_closed` check).
- **Rate limits:** this phase's REST call volume goes from ~1 historical fetch per manual analysis (today) to one `persistCandles`+`compute` pair per candle close (e.g., every 5 minutes for a 5-minute chart) — far under Kite's documented limits, no new throttling needed (P16§10 item 5 flagged this for "whenever Phase 17 starts calling it more often"; this phase's actual cadence turns out to still be well within bounds).

## P17§10 Testing strategy

- `liveCandleTracker.test.ts` — pure unit tests: a run of ticks within one bucket returns `null` each time except the tick that crosses into a new bucket, which returns the previous bucket's finished OHLC; a gap in ticks across a bucket boundary still closes correctly on the next tick to arrive.
- `liveSessionRunner.test.ts` — injected fakes for `ticker`/`sidecar`/`history`/the three `send*` callbacks; verifies `start()` subscribes and wires tick/close handling, `stop()` unsubscribes, and a closed candle triggers `persistCandles` → `compute` → `updateMessage` → `sendCandleClose` in that order.
- `kiteTicker.test.ts`/`kiteLogin.test.ts`/`bootstrap.test.ts` — per P17§3.4.
- Renderer: `LiveSessionView.test.tsx`/`VerdictMeter.test.tsx`/`liveChart` tests follow this codebase's existing renderer-test conventions (`@testing-library/react`, injected `bridge()` fakes) — exact cases left to the plan-writer, matching how every other renderer component in this codebase is tested.

## P17§11 Manual verification checklist

Requires a live, paid Kite Connect connection during market hours — the same real-account dependency Phase 16's own Task 9 needed.

1. Start a live Engine-Only session on a liquid instrument during market hours; confirm the chart's current bar visibly updates as ticks arrive.
2. Wait for (or force, by using a short interval) a real candle close; confirm the verdict meter updates and a `persistCandles`+`compute` round-trip actually happened (check the candle lake / logs).
3. Switch to a different session, then reopen the live one; confirm it auto-resumes without any prompt.
4. Kill network connectivity briefly; confirm `live:status` shows reconnecting, then recovers automatically once connectivity returns, with no crash.
5. Let the app run across a token-expiry boundary (or force one); confirm the existing `markNeedsLogin`/re-login flow still works, and that re-login updates the ticker's credentials without the app crashing or needing a restart.

## P17§12 Global Constraints (binding, verbatim for the plan-writer and task-implementers)

**Exact new file paths:**
- `electron-app/src/main/services/market/liveCandleTracker.ts` (+ test)
- `electron-app/src/main/services/market/liveSessionRunner.ts` (+ test)
- `electron-app/src/main/ipc/liveBridge.ts` (+ test)
- `electron-app/src/renderer/liveChart.ts`
- `electron-app/src/renderer/VerdictMeter.tsx` (+ test)
- `electron-app/src/renderer/LiveSessionView.tsx` (+ test)

**Exact modified file paths:**
- `electron-app/src/main/services/kite/kiteTicker.ts` — `updateCredentialsAndConnect`, `KiteTickerLike` gains `api_key`/`access_token`/`connected()` (P17§3.1).
- `electron-app/src/main/services/kite/kiteLogin.ts` — `existingTicker` dep, `KiteSession` drops `close()` (P17§3.2).
- `electron-app/src/main/bootstrap.ts` — ticker held across logins, `before-quit` disconnect hook, `previousSession.close()` removed (P17§3.3).
- `electron-app/src/main/services/history/historyStore.ts` — `appendMessage` returns the message id (was `void`); new `updateMessage` (P17§8).
- `electron-app/src/main/ipc/rendererApi.ts` — new `live:*` methods/types.
- `electron-app/src/renderer/App.tsx` — Engine-Only branch renders `LiveSessionView` instead of `AnalysisResultView`.
- `electron-app/src/renderer/InstrumentSearch.tsx` — `onSubmit` also triggers `startLiveSession` after a successful `runAnalysis`.

**Binding invariants:**
- (a) `.disconnect()` is called on the ticker in exactly one place in the whole app: the `before-quit` handler in `bootstrap.ts`.
- (b) Exactly one `KiteTicker` instance exists for the process's entire lifetime.
- (c) The full algo suite/confluence recompute happens only on candle close, never per-tick.
- (d) No projected/forecasted future price data is rendered anywhere — direction + magnitude from the real confluence scorecard only.
- (e) AI-Assisted mode's files are not touched by this phase.
- (f) A live session's history entry is one updated-in-place message, never an appended one per candle close.

## P17§13 Out of scope for this phase

- Any change to AI-Assisted mode.
- Multi-instrument dashboards.
- Projected/forecasted future candles.
- A true full-screen (sidebar-hidden) mode.
- Fixing the app-wide `--bullish`/`--bearish` color-pair's colorblind-separation failure at the token level (the meter works around it locally; the tokens themselves are used elsewhere and changing them is a separate, broader design decision).
