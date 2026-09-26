# Phase 16 — Kite Connect Direct API Migration

Status: approved by user 2026-09-26 (brainstorming dialogue), pending implementation planning.
Author: design produced via `superpowers:brainstorming`. Section references: "§N" → master design (`2026-07-18-trade-assistant-design.md`); "P8§N" → `2026-07-28-phase8-kite-mcp-only-auth-design.md`, whose structure this document mirrors and whose entire subject matter this phase **supersedes and deletes**; "P16§N" → this document.

## P16§1 Purpose

This phase is step one of a two-part initiative: the user wants Engine-Only mode turned into an always-on, full-screen, visual-only live trading dashboard that runs continuously once a session is open, with no further prompts. That dashboard needs genuine real-time tick data. This app's sole live-data path today is the Kite MCP server (`mcp.kite.trade`), reached via two auth modes established in Phase 3 and Phase 8 (`kiteConfig.ts`'s `KiteFullConfig`/`KiteMcpOnlyConfig`) — both of which are request/response MCP tool calls, with no streaming capability of any kind, by protocol design. A tool-call model cannot carry a continuous server-push feed.

Research (2026-09-26) confirmed Zerodha's paid Kite Connect API has a genuine push WebSocket (`wss://ws.kite.trade`, official `KiteTicker`), included in the existing ₹500/month "Connect" plan (no extra streaming tier). It requires its own registered developer app and does not share credentials with the Kite MCP server's internal auth. The user explicitly chose to **fully replace Kite MCP everywhere** (not a hybrid) rather than run two parallel Kite connections, accepting that this touches the `KiteClient` interface both AI-Assisted and Engine-Only modes depend on, and accepting that the app has **zero Kite functionality of any kind** until a Kite Connect developer app is registered and its subscription is active — there is no free/MCP fallback left after this phase.

This phase delivers the replacement data/auth layer only: a native REST client behind the existing `KiteClient` abstraction, an instrument-search replacement, and a connected (but not yet consumed) WebSocket ticker. It does **not** build the live dashboard itself — that is Phase 17, blocked on this phase, and the user asked to be reminded to start it once this one ships.

A load-bearing finding that keeps this phase's risk to AI-Assisted mode low: `KiteClient` (`kiteClient.ts`) already depends only on a small `McpToolCaller` interface (`callTool(name, args)`), not on MCP itself — and Kite's MCP tools already return Kite Connect's native REST JSON untouched (confirmed by reading `historicalDataArchive.ts`/`candleWarmup.ts`: `response.data.candles` is exactly Kite Connect's own historical-candle response shape, and `instrumentParsing.ts` already tolerates a flat array, which is exactly what a REST-backed instrument search will produce). So this is a transport swap behind an existing seam, not a rewrite of response parsing.

## P16§2 Scope

**In scope:**

1. `kiteConfig.ts` — collapse to a single required shape (no more mode union): `apiKey`, `apiSecret`, `loginPort`. Missing/partial env vars throw a clear, actionable `KiteConfigError` (P16§4).
2. `kiteRestCaller.ts` (new) — an `McpToolCaller` implementation backed by direct HTTPS calls to `api.kite.trade` (P16§5).
3. `kiteInstrumentMaster.ts` (new) — daily-cached instrument master + in-memory search, replacing `search_instruments` (P16§6).
4. `kiteTicker.ts` (new) — a thin wrapper around the official `kiteconnect` npm package's `KiteTicker`, connected and exposed on `KiteSession`, with reconnect-with-backoff. **Not consumed by anything in this phase** — Phase 17 is the first consumer (P16§7).
5. `kiteLogin.ts` — `runKiteLogin` swaps its MCP connect step for constructing the new REST caller + ticker; the OAuth token exchange itself (`kiteOAuth.ts`) is unchanged (P16§8).
6. `kiteClient.ts` — drop the `login()` method and its `KITE_READ_TOOL_NAMES.login` entry (nothing calls it once the MCP-only anonymous-login flow is gone); the other 10 read methods are unchanged (P16§3).
7. **Drift-warning removal, all the way to the renderer.** With no more MCP `tools/list` to diff against, the whole added-in-Phase-3 drift concept has nothing left to check. `rendererApi.ts`'s `AppStatus.driftWarning` field and `"mcpDrift"` from `BannerKind` are removed; `bootstrap.ts`'s `driftWarning`/`dispatchBanner({kind:"mcpDrift",...})` wiring in the `login()` closure is removed; `SettingsWindow.tsx:133`'s `{status?.driftWarning && <Banner variant="warning">...}` line is removed. This is the one place this phase actually touches the renderer (P16§9).
8. **Deleted entirely:** `mcpConnection.ts`, `kiteMcpLoginFlow.ts`, `mcpDriftMonitor.ts`, `mcpClientAdapter.ts`, `runKiteMcpOnlyLogin`, `KiteMcpOnlyConfig`, the `@modelcontextprotocol/sdk` dependency, and all their tests. (Correction from an earlier draft of this doc: Phase 8's own design doc proposed an SDK-native `OAuthClientProvider`/`kiteMcpOAuthProvider.ts`/`kiteMcpOAuthCallback.ts` implementation, but the codebase as it actually stands today never built that — the shipped MCP-only mode is the simpler anonymous-connect-plus-`login`-tool-plus-poll flow in `kiteMcpLoginFlow.ts`/`mcpConnection.ts`'s `connectKiteMcpAnonymous`. There is nothing named `kiteMcpOAuthProvider.ts`/`kiteMcpOAuthCallback.ts` in the tree to delete.) MCP-only mode's entire purpose was avoiding the paid subscription, which this phase now requires unconditionally, so it has no remaining reason to exist.
9. `bootstrap.ts` — the `config.mode === "full" ? ... : ...` branch (P8§9) collapses back to a single unconditional call, mirroring the shape from before Phase 8 existed.
10. New dependency: `kiteconnect` (npm, official Zerodha package) — used only for its `KiteTicker` class, per the user's explicit choice (hand-rolled REST, official package for the WebSocket).

**Not in scope (deferred to Phase 17, or permanently out of scope):**

- Anything that *consumes* live ticks — no polling loop, no continuous re-compute, no chart, no UI change of any kind. This phase only proves the ticker connects and can be subscribed to (P16§12 manual verification).
- Any change to the no-order-placement safety invariant (§2, §4) — unaffected, restated in P16§3.
- Any Settings-UI for Kite Connect credentials — still `.env`-only (`KITE_API_KEY`/`KITE_API_SECRET`/`KITE_LOGIN_PORT`), matching every prior phase's convention.
- Token/session persistence — still none; a fresh login is required every app launch, unchanged from today.
- A mock/offline/replay mode for developing without a live paid connection. The user explicitly accepted that nothing works without the subscription; building a synthetic fallback would undercut that decision and wasn't asked for.

**Locked decisions this document writes up verbatim (each an explicit user decision from the brainstorming session):**

1. **Full replace, not hybrid.** Kite MCP is deleted everywhere, not kept alongside a new native connection. Both AI-Assisted and Engine-Only now depend unconditionally on a registered Kite Connect developer app.
2. **Zero free fallback, accepted knowingly.** Until `KITE_API_KEY`/`KITE_API_SECRET` are set to a real, paid, registered app's credentials, the app has no working Kite path at all (`loadKiteConfig` throws at startup, same fail-fast shape as pre-Phase-8, deliberately — see P16§4).
3. **Hand-rolled REST, official `kiteconnect` npm for the WebSocket only.** REST calls are plain `fetch`, matching this codebase's existing style (`kiteOAuth.ts`'s `postForm`). The ticker's binary tick-packet parsing is not hand-rolled — that's genuinely fiddly (184-byte packed structs, price scaling, field offsets) and best left to a maintained library.

## P16§3 The permanent no-order-placement safety invariant is unaffected (load-bearing)

Restated every phase touching this area, because it is the reason this phase is safe to approve despite deleting the whole MCP layer: the §2/§4 guarantee — *the app never places, modifies, cancels, or automates any order, ever* — is enforced by which methods exist on `KiteClient`, not by how the connection is authenticated or transported.

- **`KiteClient`'s method surface is the enforcement layer**, and it shrinks by exactly one method this phase (`login()`, dead code once MCP-only mode is gone) and otherwise stays byte-identical: `searchInstruments`, `getHistoricalData`, `getQuotes`, `getOHLC`, `getLTP`, `getMargins`, `getHoldings`, `getPositions`, `getProfile`, `getGtts` — 10 methods, none corresponding to any of the six `KITE_WRITE_TOOL_NAMES`.
- **`kiteRestCaller.ts` is a closed `switch` over exactly those 10 tool names.** There is no generic "call any endpoint" escape hatch — adding order-placement support would require a new named case, an obviously deliberate act, not an accidental side effect of this migration.
- **`kiteClient.test.ts`'s exact-method-count safety allowlist test** gets updated from 11 to 10 (the `login` removal) and otherwise proves the same thing it always has.

## P16§4 `kiteConfig.ts` — back to a single required shape

```typescript
export class KiteConfigError extends Error {}

export interface KiteConfig {
  apiKey: string;
  apiSecret: string;
  loginPort: number;
}

const DEFAULT_LOGIN_PORT = 3000;

function parseLoginPort(env: NodeJS.ProcessEnv): number {
  const rawPort = env.KITE_LOGIN_PORT?.trim();
  const loginPort = rawPort ? Number(rawPort) : DEFAULT_LOGIN_PORT;
  if (!Number.isInteger(loginPort) || loginPort < 1 || loginPort > 65535) {
    throw new KiteConfigError(`KITE_LOGIN_PORT must be an integer between 1 and 65535, got "${rawPort}"`);
  }
  return loginPort;
}

export function loadKiteConfig(env: NodeJS.ProcessEnv = process.env): KiteConfig {
  const loginPort = parseLoginPort(env);
  const apiKey = env.KITE_API_KEY?.trim();
  const apiSecret = env.KITE_API_SECRET?.trim();
  if (!apiKey || !apiSecret) {
    throw new KiteConfigError(
      "KITE_API_KEY and KITE_API_SECRET are both required — register a Kite Connect developer app " +
        "at developers.kite.trade (₹500/month) and set both in electron-app/.env. There is no fallback mode.",
    );
  }
  return { apiKey, apiSecret, loginPort };
}
```

This is a deliberate, informed reversion of Phase 8's crash fix: Phase 8 made both-absent a valid, working mode specifically to avoid depending on the paid subscription (P8§1). This phase's whole point is that dependency, chosen knowingly (locked decision 2), so the crash-on-missing-credentials behavior returns — except now the error message explains why and what to do about it, which Phase 8's original `requireEnv` did not.

`.env.example` update (doc-only): remove the "or leave both blank for MCP-only mode" language Phase 8 added; state both are required.

## P16§5 `kiteRestCaller.ts` (new) — the REST-backed `McpToolCaller`

Single responsibility: turn `KiteClient`'s existing `callTool(name, args)` calls into direct Kite Connect REST calls, so `KiteClient` itself needs zero changes beyond dropping `login()`.

```typescript
export interface KiteRestCallerDeps {
  apiKey: string;
  accessToken: string;
  instrumentMaster: Pick<KiteInstrumentMaster, "search">;
  baseUrl?: string; // defaults to https://api.kite.trade; test seam
  fetchFn?: typeof fetch; // test seam
}

export function createKiteRestCaller(deps: KiteRestCallerDeps): McpToolCaller {
  const baseUrl = deps.baseUrl ?? "https://api.kite.trade";
  const fetchFn = deps.fetchFn ?? fetch;
  const authHeaders = {
    Authorization: `token ${deps.apiKey}:${deps.accessToken}`,
    "X-Kite-Version": "3",
  };

  async function getJson(path: string, query?: Record<string, string | string[]>): Promise<unknown> {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, v);
    }
    const response = await fetchFn(url, { headers: authHeaders });
    const body = await response.json();
    if (!response.ok) {
      // error_type/message are Kite Connect's own documented error envelope
      // shape; embedding error_type verbatim is what keeps
      // kiteSessionState.ts's looksLikeSessionExpiry matching with zero
      // changes to that file (it already regexes for "tokenexception").
      const errorType = (body as { error_type?: string })?.error_type ?? "unknown";
      const message = (body as { message?: string })?.message ?? response.statusText;
      throw new Error(`Kite API error (${response.status} ${errorType}): ${message}`);
    }
    return body;
  }

  return {
    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
      switch (name) {
        case "search_instruments":
          return { data: await deps.instrumentMaster.search(String(args.query)) };
        case "get_historical_data":
          return getJson(
            `/instruments/historical/${args.instrument_token}/${args.interval}`,
            { from: String(args.from), to: String(args.to) },
          );
        case "get_quotes":
          return getJson("/quote", { i: args.instruments as string[] });
        case "get_ohlc":
          return getJson("/quote/ohlc", { i: args.instruments as string[] });
        case "get_ltp":
          return getJson("/quote/ltp", { i: args.instruments as string[] });
        case "get_margins":
          return getJson("/user/margins");
        case "get_holdings":
          return getJson("/portfolio/holdings");
        case "get_positions":
          return getJson("/portfolio/positions");
        case "get_profile":
          return getJson("/user/profile");
        case "get_gtts":
          return getJson("/gtt/triggers");
        default:
          throw new Error(`kiteRestCaller: unsupported tool "${name}"`);
      }
    },
  };
}
```

- `getHistoricalData`'s response shape (`{data: {candles: [[ts,o,h,l,c,v],...]}}`) matches Kite Connect's real documented response exactly, which is what `historicalDataArchive.ts`/`candleWarmup.ts` already expect — zero changes to either file.
- `getQuotes`'s response envelope (`{data: {"NSE:INFY": {...}}}`) and `getProfile`'s (`{data: {user_id: "...", ...}}`) are likewise Kite Connect's native shapes; `classifyKiteResponse`'s `looksAuthenticated` check (`data.user_id`) keeps working unchanged against a real `get_profile` response.
- The `default` throw is the closed-surface enforcement described in P16§3 — there is no case for any write-tool name, and none can be reached without editing this switch, an obviously deliberate act.

## P16§6 `kiteInstrumentMaster.ts` (new) — replacing `search_instruments`

Kite Connect's REST API has no free-text search endpoint, only a bulk daily instrument-master dump (`GET /instruments` — a CSV of every tradable instrument across all exchanges, tens of thousands of rows, refreshed once per trading day).

```typescript
export interface KiteInstrumentRow {
  instrument_token: string;
  tradingsymbol: string;
  exchange: string;
  segment: string;
  name: string;
}

export interface KiteInstrumentMasterDeps {
  apiKey: string;
  accessToken: string;
  cacheDir: string; // electron app.getPath("userData")
  fetchFn?: typeof fetch;
  now?: () => Date;
}

export class KiteInstrumentMaster {
  // Loads the cached file if it's from today (IST trading day), else
  // re-downloads and re-parses the CSV, caching it to disk for next launch.
  // Private: search() is the only public entry point, so a caller can never
  // search a stale/never-downloaded cache by forgetting to call this first.
  private async ensureFresh(): Promise<void> { /* ... */ }

  // Awaits ensureFresh() first, then does a case-insensitive substring match
  // against tradingsymbol and name, capped at 25 results (InstrumentSearch.tsx
  // renders whatever comes back with no pagination, so the cap is what keeps
  // the result list on-screen reasonable, not a Kite-side limit).
  async search(query: string): Promise<KiteInstrumentRow[]> {
    await this.ensureFresh();
    /* ... */
  }
}
```

- Refresh cadence: once per IST trading day, checked lazily on every `search()` call via `ensureFresh()` (not a background timer) — matches this app's existing "check when needed" style (e.g. `readinessGate.ts`'s market-hours check) rather than adding a new scheduler. `ensureFresh()` itself no-ops immediately (a cheap file-mtime/date check) when the cache is already current, so this costs nothing on the common path.
- Cache location: a single JSON file under Electron's `userData` dir, e.g. `kite-instruments.json` — a new, small, single-purpose file, not shoehorned into the existing Parquet candle lake (which is a distinct, unrelated store for OHLC data per `storage`/`ingestion`).
- Search result rows map directly to `instrumentParsing.ts`'s `RawInstrument` shape (`tradingsymbol`, `exchange`, `segment`, `instrument_token`) — that file requires zero changes.

## P16§7 `kiteTicker.ts` (new) — the WebSocket, connected but unconsumed this phase

```typescript
import { KiteTicker } from "kiteconnect";

export interface KiteTickerClient {
  connect(): void;
  subscribe(instrumentTokens: number[], mode?: "ltp" | "quote" | "full"): void;
  onTick(handler: (ticks: unknown[]) => void): void;
  onConnectionChange(handler: (status: "connected" | "reconnecting" | "error") => void): void;
  disconnect(): void;
}

export function createKiteTicker(apiKey: string, accessToken: string): KiteTickerClient {
  const ticker = new KiteTicker({ api_key: apiKey, access_token: accessToken });
  // Wraps the library's 'connect'/'ticks'/'disconnect'/'error'/'reconnect'/
  // 'noreconnect' events into the narrower interface above. The library's
  // own reconnect-with-backoff is used as-is (autoReconnect: true) rather
  // than reimplemented — it already handles the drop/backoff/give-up cases
  // Kite's own docs describe.
  /* ... */
}
```

- `KiteSession` (`kiteLogin.ts`) gains a `ticker: KiteTickerClient` field alongside `kite: KiteClient`, constructed with the same `apiKey`/`accessToken` the REST caller uses.
- **Nothing calls `.connect()` or `.subscribe()` in this phase.** Phase 17 is the first real consumer. This phase's manual verification (P16§12) is the only place the ticker is actually exercised, to prove the wiring works before Phase 17 builds on it.

## P16§8 `kiteLogin.ts` / `kiteOAuth.ts` — what changes, what doesn't

`kiteOAuth.ts` (`captureRequestToken`, `exchangeAccessToken`, `computeKiteChecksum`) is **unchanged** — the loopback `request_token` capture and checksum exchange for `access_token` work identically regardless of what the token is then used for.

`kiteLogin.ts`'s `runKiteLogin` changes its one connection step:

```typescript
export async function runKiteLogin(deps: KiteLoginDeps): Promise<KiteSession> {
  const { apiKey, apiSecret, loginPort } = deps.config;
  const loginUrl = `https://kite.zerodha.com/connect/login?api_key=${encodeURIComponent(apiKey)}&v=3`;
  const requestToken = await deps.captureRequestToken({ port: loginPort, loginUrl, openExternal: deps.openExternal });
  const tokenResponse = await deps.exchangeAccessToken({ apiKey, apiSecret, requestToken, postForm: deps.postForm });
  const accessToken = extractAccessToken(tokenResponse);

  const instrumentMaster = new KiteInstrumentMaster({ apiKey, accessToken, cacheDir: deps.cacheDir });
  const caller = createKiteRestCaller({ apiKey, accessToken, instrumentMaster });
  const kite = new KiteClient(caller, { onResponse: deps.onKiteResponse });
  const ticker = createKiteTicker(apiKey, accessToken);
  return { kite, ticker, close: async () => ticker.disconnect() };
}
```

- `runKiteMcpOnlyLogin` is deleted along with `KiteMcpOnlyConfig` (P16§2).
- `KiteSession`'s `connection`/`drift` fields are dropped (there is no MCP connection or `tools/list` to diff against anymore); `close()` now just disconnects the ticker.
- `bootstrap.ts`'s branch (P8§9) collapses to a single unconditional `await runKiteLogin({ config, ... })` call — the ternary and the `runKiteMcpOnlyLogin` import are removed.

## P16§9 Modules that need zero change (stated explicitly)

- `kiteOAuth.ts` — unchanged (P16§8).
- `kiteSessionState.ts` (`classifyKiteResponse`, `looksLikeSessionExpiry`) — unchanged; `kiteRestCaller.ts`'s thrown error messages are constructed specifically to keep matching its existing regexes (P16§5).
- `instrumentParsing.ts` — unchanged; already tolerates the flat-array shape `kiteInstrumentMaster.search()` produces.
- `historicalDataArchive.ts`, `candleWarmup.ts`, `readinessGate.ts`, `analysisBridge.ts`, the Claude persona pipeline — unchanged; all consume `KiteClient`'s existing method surface, which is unchanged (minus `login()`, which none of them call).
- The renderer, **except one line**: `App.tsx`, `InstrumentSearch.tsx`, `AppShell.tsx`'s status dot — unchanged; none of it knows or cares how `KiteClient` is transported. `SettingsWindow.tsx` loses its one drift-warning banner line (P16§2 item 7) since there is no more MCP `tools/list` to diff against.

## P16§10 Error handling / edge cases

1. **Missing/partial `KITE_API_KEY`/`KITE_API_SECRET`.** `loadKiteConfig` throws `KiteConfigError` synchronously at startup (P16§4) — a deliberate, informed regression from Phase 8's graceful degrade, per locked decision 2.
2. **Expired/invalid `access_token` (daily expiry).** A REST call returns HTTP 403 with `error_type: "TokenException"`; `kiteRestCaller` throws an `Error` whose message embeds that string; `looksLikeSessionExpiry` matches it unchanged; `guardSessionExpiry` (`analysisBridge.ts`) calls `markNeedsLogin()` exactly as it does today.
3. **Instrument master download fails** (network error, Kite API down). `KiteInstrumentMaster.ensureFresh()` rejects; `search_instruments` surfaces that as a normal `searchError` banner in `InstrumentSearch.tsx` (existing error path, unchanged).
4. **Ticker connect/subscribe fails or drops mid-session.** Library's own `autoReconnect` handles transient drops; a `noreconnect` (give-up) event surfaces via `onConnectionChange("error")`. Since nothing consumes the ticker this phase, the only observable effect is whatever the manual verification script logs (P16§12) — Phase 17 designs the real UI-facing error surface.
5. **Rate limits.** Kite Connect's historical-data endpoint is documented at ~3 req/sec; this phase's call volume (one historical fetch per readiness check / analysis, same cadence as today) stays far under that with no new throttling code needed. Flagged for Phase 17, which will call it far more often (once per candle close).

## P16§11 Testing strategy

Matches this codebase's existing convention (Vitest, injected fakes via `vi.fn()`/seam parameters, no real network).

- `kiteConfig.test.ts` — rewritten for the single-shape return: both present → config object; either absent → throws with the new message; bad `KITE_LOGIN_PORT` → throws (existing case, kept).
- `kiteRestCaller.test.ts` (new) — one case per tool name asserting the right URL/query/method was built from a fake `fetchFn`; a non-ok response asserts the thrown message contains the raw `error_type`.
- `kiteInstrumentMaster.test.ts` (new) — fresh-cache vs stale-cache-triggers-redownload; search is case-insensitive substring match against both `tradingsymbol` and `name`; malformed/missing cache file is treated as stale, not a crash.
- `kiteTicker.test.ts` (new) — wraps a fake `KiteTicker`-shaped object (constructor-injected), asserts `connect`/`subscribe`/`onTick`/`onConnectionChange`/`disconnect` delegate correctly and that the library's `error`/`noreconnect`/`reconnect` events map to the three `onConnectionChange` states.
- `kiteLogin.test.ts` — updated: `runKiteLogin` now asserts a `KiteSession` shaped `{ kite, ticker, close }` (no more `connection`/`drift`); `runKiteMcpOnlyLogin`'s tests are deleted along with the function.
- `kiteClient.test.ts` — the exact-method-count safety allowlist test updates from 11 to 10 (P16§3); otherwise unchanged, still proving no write-tool method exists.
- **Deleted test files:** `mcpConnection.test.ts`, `kiteMcpLoginFlow.test.ts`, `mcpDriftMonitor.test.ts`, `mcpClientAdapter.test.ts`.

## P16§12 Manual verification checklist

The only real proof this works — Kite Connect's live REST/WS behavior can't be fully faked in unit tests, same principle as P8§14/§12.

1. Register a Kite Connect developer app at `developers.kite.trade` (requires the ₹500/month subscription active), set `KITE_API_KEY`/`KITE_API_SECRET` in `electron-app/.env`.
2. Launch the app with no credentials set (temporarily) — confirm it fails fast at startup with the new, actionable `KiteConfigError` message, not a silent degrade.
3. Restore credentials, launch again, click "Login to Kite" — confirm the same request_token → access_token OAuth dance works exactly as before (unchanged flow).
4. Run a real Engine-Only analysis — confirm instrument search returns real results (proves `kiteInstrumentMaster`'s download+search), and confirm the analysis produces real algo output (proves `kiteRestCaller`'s historical-data call).
5. Run the AI-Assisted chat mode end to end at least once — confirm no behavior change from today, proving the shared `KiteClient` surface swap didn't regress it.
6. Separately, a throwaway script or REPL: construct a `kiteTicker`, `.connect()`, `.subscribe([some instrument token], "full")`, log incoming ticks for ~30 seconds during market hours, confirm real, continuously-arriving price data — this is the actual proof this phase exists for, since nothing in the shipped app calls it yet.
7. Let an `access_token` sit until the next trading day (or force an invalid one) — confirm a subsequent call surfaces a "needs login" banner via the existing `markNeedsLogin` path, not an unhandled crash.

## P16§13 Global Constraints (binding, verbatim for the plan-writer and task-implementers)

**Exact new file paths:**
- `electron-app/src/main/services/kite/kiteRestCaller.ts`
- `electron-app/src/main/services/kite/kiteInstrumentMaster.ts`
- `electron-app/src/main/services/kite/kiteTicker.ts`
- `electron-app/test/main/services/kite/kiteRestCaller.test.ts`
- `electron-app/test/main/services/kite/kiteInstrumentMaster.test.ts`
- `electron-app/test/main/services/kite/kiteTicker.test.ts`

**Exact modified file paths:**
- `electron-app/src/main/services/kite/kiteConfig.ts` — single required shape, no union (P16§4).
- `electron-app/src/main/services/kite/kiteClient.ts` — drop `login()` + its `KITE_READ_TOOL_NAMES` entry; 10 methods remain (P16§3).
- `electron-app/src/main/services/kite/kiteLogin.ts` — `runKiteLogin` builds the REST caller + ticker instead of connecting MCP; `KiteSession` becomes `{ kite, ticker, close }`; `runKiteMcpOnlyLogin` deleted (P16§8).
- `electron-app/src/main/bootstrap.ts` — collapse the mode ternary back to one unconditional `runKiteLogin` call; remove the `driftWarning`/`dispatchBanner({kind:"mcpDrift",...})` wiring from the `login()` closure and `driftWarning` from `currentStatus()` (P16§8, P16§2 item 7).
- `electron-app/src/main/ipc/rendererApi.ts` — remove `AppStatus.driftWarning` and `"mcpDrift"` from `BannerKind` (P16§2 item 7).
- `electron-app/src/renderer/SettingsWindow.tsx` — remove the `{status?.driftWarning && <Banner variant="warning">...}` line (P16§2 item 7).
- `electron-app/package.json` — remove `@modelcontextprotocol/sdk`; add `kiteconnect`.
- `electron-app/.env.example` — remove MCP-only-mode language; both credentials required (P16§4).
- `electron-app/test/main/services/kite/kiteConfig.test.ts`, `kiteClient.test.ts`, `kiteLogin.test.ts` — updated cases (P16§11).

**Exact deleted file paths:**
- `electron-app/src/main/services/kite/mcpConnection.ts`
- `electron-app/src/main/services/kite/kiteMcpLoginFlow.ts`
- `electron-app/src/main/services/kite/mcpDriftMonitor.ts`
- `electron-app/src/main/services/kite/mcpClientAdapter.ts`
- All corresponding `*.test.ts` files for the above (`kiteMcpLoginFlow.test.ts`, `mcpConnection.test.ts`, `mcpDriftMonitor.test.ts`, `mcpClientAdapter.test.ts`).

**Exact `KiteConfig`/`KiteSession` shapes:**
```typescript
export interface KiteConfig { apiKey: string; apiSecret: string; loginPort: number; }
export interface KiteSession { kite: KiteClient; ticker: KiteTickerClient; close(): Promise<void>; }
```

**Binding invariants:**
- (a) `KiteClient`'s 10 remaining methods and the exact-method-count safety test are never expanded to cover a write tool (P16§3).
- (b) `kiteRestCaller`'s tool-name switch has no default/passthrough case that could reach an arbitrary Kite endpoint (P16§3, P16§5).
- (c) No token/session persistence of any kind — matches every prior phase (P16§2).
- (d) No Settings UI added — `.env` only (P16§2).
- (e) Nothing in this phase subscribes to or consumes ticks — `kiteTicker.ts` is connected and tested in isolation only; Phase 17 is the first real consumer (P16§7).
- (f) `kiteSessionState.ts`, `instrumentParsing.ts`, `historicalDataArchive.ts`, `candleWarmup.ts`, `readinessGate.ts`, `analysisBridge.ts`, and the Claude persona pipeline are not modified by this phase. The renderer is modified in exactly one place — `SettingsWindow.tsx`'s drift-warning banner line — and nowhere else (P16§9).

## P16§14 Out of scope for this phase

- The live dashboard itself (chart, continuous re-compute loop, visual verdict encoding) — Phase 17, blocked on this phase. **Remind the user to start Phase 17 once this phase ships.**
- Any Settings-UI credential management, token persistence, or multi-account support.
- Rate-limit throttling infrastructure beyond what today's call volume already needs (flagged for Phase 17, P16§10 item 5).
- A mock/offline mode for developing without a live paid Kite Connect subscription (explicitly declined by the user — locked decision 2).
