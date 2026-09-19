# Phase 13 — Intraday Candle-Forecaster Warm-Up & Live Engine-Only Trading

Status: approved by user 2026-09-17 (conversational brainstorming, triggered by a live incident: a
kronos benchmark run returned an empty result with no explanation; investigating it live surfaced a
much larger structural gap in how forecasters get historical context on both the live and benchmark
paths). Pending implementation planning.

Author: design produced via superpowers:brainstorming. Section references: "P6§N" →
`docs/superpowers/specs/2026-07-27-phase6-benchmark-ui-design.md`; "P5d§N" →
`docs/superpowers/specs/2026-07-27-phase5d-settings-scan-scheduler-design.md`; "P12§N" →
`docs/superpowers/specs/2026-09-13-phase12-benchmark-run-scoping-design.md`; "P13§N" → this document.

## P13§1 Purpose

Kronos, chronos, ttm, and moirai (the ONNX forecasters in `rust-core/crates/algo-core/src/forecast/`)
are already wired into both the live `Compute` path (`scanScheduler.ts` → `sidecar.compute`) and the
benchmark path (`benchmarkRunner.ts` → `sidecar.benchmarkCompute`). Measured against the real code,
neither path can actually make them produce a forecast, for two independent reasons:

1. **The live path hands algorithms closes only, at a hardcoded horizon.** `handle_request`
   (`rust-core/crates/sidecar/src/handlers.rs:91-131`) builds `MarketContext::from_closes(...)`
   (line 108), leaving `opens`/`highs`/`lows`/`volumes` empty, and hardcodes `Horizon::Positional`
   regardless of what was requested. Kronos requires full OHLCV (`kronos.rs:170-175` guards on
   `ctx.opens.len() < CTX_LEN`, etc.) and therefore silently falls to its no-op/neutral branch on
   every live tick, forever — independent of how much history exists.
2. **The live fetch window is undersized for every forecaster, on any interval, on any day.**
   `horizonFetchParams.ts:3-4` hardcodes `INTRADAY_LOOKBACK_DAYS = 5` and
   `POSITIONAL_LOOKBACK_DAYS = 365`, pure calendar-day arithmetic with no trading-day awareness.
   Measured against each forecaster's actual `required_lookback()` —
   kronos 256 (`kronos_math.rs:11`), chronos 500 (`chronos.rs:70`), ttm 512 (`ttm_math.rs:20,24`),
   moirai 512 (`moirai_math.rs:13`) — a 5-calendar-day intraday fetch yields at best ~225-375
   five-minute candles (NSE's 375-minute session ÷ 5 = 75 candles/trading day × 3-5 trading days in
   any 5-calendar-day span). That ceiling is below chronos/ttm/moirai's floor on every single run;
   kronos is a coin-flip depending on the week. The 365-calendar-day positional fetch (~250 trading
   days) has the identical problem for chronos/ttm/moirai (500-512 needed) and sits right at kronos's
   edge, regardless of how long the underlying stock has been listed.
3. **The benchmark harness has a related but distinct bug**: `runBenchmark`
   (`electron-app/src/main/services/benchmark/benchmarkRunner.ts:91`) filters
   `series = candles.filter(c => c.ts >= params.fromTs)`, so a frontier near the start of a selected
   window gets none of the lake's pre-existing history before `fromTs` — even though the lake already
   has it. This is why a single-day benchmark run reports "algos: " (empty) and a zeroed confluence:
   `run_applicable`'s registry filter (`registry.rs:78-93`) silently drops any algorithm whose
   `required_lookback()` exceeds the bars it was handed — it does not run-and-report-neutral, it is
   never invoked at all.

None of this is a market-open timing problem specifically — it is broken at 2pm exactly as much as
9:15am. The real, industry-standard answer (confirmed against QuantConnect's own documented
"Warm-Up Period" feature, and Chronos/TTM's published context-length requirements) is: seed a
persistent history buffer once via a bulk historical fetch sized to what the model actually needs,
then top it up incrementally — never try to accumulate context from a cold start.

## P13§2 Scope

**In scope:**

1. A persistent per-symbol/per-interval candle store, backed by the existing DuckDB lake, with a
   one-time sized backfill and incremental top-up (P13§4).
2. Fixing the live `Compute` request/handler to carry full OHLCV at the correct requested timeframe,
   sourced from the lake, instead of a closes-only array fetched fresh from Kite every tick (P13§5).
3. A deterministic three-part readiness gate (Kite connectivity → data readiness → market hours),
   evaluated whenever an Engine-Only session is opened or reopened (P13§6).
4. Support for three intraday candle intervals — 5-minute, 10-minute, 15-minute — selectable per
   symbol at session-creation time (P13§7).
5. Removing the Positional/daily choice from the Engine-Only intake UI entirely.
6. Reusing the existing Engine-Only session type/badge/sidebar list as-is — no new session mode, no
   new UI surface beyond the interval picker replacing the horizon toggle.
7. Fixing the benchmark harness's windowing bug using the same "give the algorithm real trailing
   history, sized to its `required_lookback()`" primitive as the live path (P13§8).

**Not in scope (explicit user decisions):**

- The AI-Assisted/Claude chat flow is untouched — this phase is Engine-Only only.
- Positional (daily-bar) forecasting is removed from the Engine-Only UI. This does **not** touch
  daily-bar ingestion (`bhavcopy.rs`) or the Benchmark tool's own `day`-timeframe support, which
  remain as they are.
- No new session type, mode, or sidebar badge. `AnalysisMode` (`rendererApi.ts:49`) stays exactly
  `"engine_only" | "ai_assisted"`.
- `ScanScheduler`'s own timer/trigger logic is **not** changed in this phase — it keeps ticking on
  its existing configured interval and creating sessions via `WorthLook`/`WorthAiCall` exactly as
  today. It automatically benefits from the P13§5 live-context fix (both call the same
  `handle_request`), but adding per-watchlist-entry interval selection or market-hours gating to the
  *background* scheduler is explicitly deferred to a future phase.
- No order-placement code path is introduced anywhere — this remains permanently out of scope per
  every prior phase's standing invariant (`docs/superpowers/specs/2026-07-18-trade-assistant-design.md`
  §2/§4; `kiteClient.ts:29-36`'s write-tool negative allowlist).
- No change to Kite's rate limiting or the sequential-per-symbol tick pattern already in
  `scanScheduler.ts:83-85`.

**Locked decisions:**

1. **Warm-up architecture is "Option A"**: a persistent, incrementally-topped-up store (the existing
   lake), rejected alternatives being (B) always re-fetch the full window from Kite every check
   (wasteful, rate-limit-risky) and (C) in-memory-only cache (cold-starts on every app restart).
2. **The candle-interval picker fully replaces the Horizon toggle** in Engine-Only intake. There is
   no "Positional" option in the new UI; the three choices are 5-minute, 10-minute, 15-minute.
3. **The readiness gate always runs in the same fixed order** — Kite connectivity, then data
   readiness, then market hours — and short-circuits on the first failure. Only one message is ever
   shown at a time (the first thing actually blocking), not a checklist of all three.
4. **Silence on success.** All three gate checks passing produces no banner, toast, or confirmation
   message — the session simply shows its live data. Messaging exists only to explain why nothing is
   happening yet.
5. **The gate re-runs on every open, not just creation.** Reopening a previously-created Engine-Only
   session from the sidebar re-evaluates all three checks fresh (including a top-up attempt) rather
   than only replaying the last stored result.
6. **The benchmark harness and the live path share one "how much history does this algorithm need,
   and where do I get it" primitive**, rather than each having its own separate fetch/windowing
   logic. This is why the benchmark fix is folded into this phase instead of being a smaller
   standalone patch.

## P13§3 Real-world numbers this design is built against

| Forecaster | `required_lookback()` | Forecast horizon |
|---|---|---|
| kronos | 256 (`kronos_math.rs:11`, `CTX_LEN`) | 8 bars (`PRED_LEN`, `kronos_math.rs:16`) |
| chronos | 500 (`chronos.rs:70`, `REGISTRY_REQUIRED_LOOKBACK`) | reads 1 of 64 predicted steps (`chronos_math.rs:61-66`) |
| ttm | 512 (`ttm_math.rs:20,24`, first of `[512, 1024, 1536]`) | 96 bars (`PRED_LEN`, `ttm_math.rs:17`) |
| moirai | 512 (`moirai_math.rs:13`, `CONTEXT_LEN`) | 1 bar (`TARGET_RAW_STEP = 0`, `moirai_math.rs:34`) |

NSE's regular session is 9:15am-3:30pm IST = 375 minutes. Candles per trading day, and calendar days
needed (with a holiday/weekend buffer) to clear the largest requirement (512, for ttm/moirai) and the
smallest (256, for kronos):

| Interval | Candles/trading day | ~Calendar days for 512 | ~Calendar days for 256 |
|---|---|---|---|
| 5-minute | 75 | ~12-14 | ~6-7 |
| 10-minute | 37 | ~22-25 | ~11-12 |
| 15-minute | 25 | ~32-35 | ~16-18 |

These are the sizing inputs for the backfill formula in P13§4.2. Chronos's 500 rounds to the same
day-counts as the 512 column above (one extra trading day of margin, immaterial at this scale).

No NSE holiday calendar or trading-day-aware date math exists anywhere in this repo today —
`ingest.rs:42-45` only skips Saturday/Sunday during bhavcopy backfill (a real holiday still surfaces
as a fetchable 404, tolerated as rerunnable); `ingestion/time.rs:8-12` only hardcodes the session
*close* instant (15:30 IST) for timestamp conversion, nothing about session length or open time.

## P13§4 Data layer: persistent per-symbol/interval candle store

### P13§4.1 Storage

The existing DuckDB lake (already the target of `persistCandles`, already the source
`benchmarkRunner.ts` reads via `readLakeCandles`) is the single store for both live and benchmark
history. No new storage engine. What's missing is a read/assemble path that the *live* compute call
actually uses — today it never reads the lake at all (P13§1, finding 1).

### P13§4.2 Backfill sizing

A pure function, `calendarDaysForBackfill(interval: "5minute" | "10minute" | "15minute", requiredBars: number): number`,
implementing the P13§3 table: `tradingDays = ceil(requiredBars / barsPerTradingDay(interval))`,
`calendarDays = ceil(tradingDays * 7 / 5) + HOLIDAY_BUFFER_DAYS` (a small constant, e.g. 5, covering
the worst realistic run of holidays in the requested span). `requiredBars` is the **maximum**
`required_lookback()` across whichever forecasters are actually linked into the running sidecar
binary (discovered via the existing `listAlgorithms` call from P12§3.1, filtered to `cost === "slow"`),
so the backfill is sized to whichever model needs the most, not a hardcoded 512.

### P13§4.3 One-time backfill, then incremental top-up

For a given (symbol, interval) pair, on first use: fetch `calendarDaysForBackfill(...)` worth of
history from Kite in one call (chunking if it exceeds Kite's per-request range limit for that
interval — this limit needs verifying against the live Kite Connect API before implementation;
flagged as a research item in P13§10), persist via the existing `persistCandles`. On every subsequent
check (including every session reopen): read the lake's latest stored candle timestamp for that
(symbol, interval), fetch only candles from that point forward, persist the delta. This mirrors
`scanScheduler.ts`'s existing archive-then-compute pattern but changes what gets fetched (a small
top-up, not the whole window) and adds the one-time bulk step it currently has no equivalent of.

### P13§4.4 Live context assembly

The live compute call stops building its context from a freshly-fetched Kite array
(`analysisEnvelope.ts:47-65`'s current shape) and instead reads the required trailing window straight
from the lake — the same `context_at`-style full-OHLCV assembly the benchmark path already uses
(`handlers.rs:235`, "richer than the live Compute handler's closes-only `from_closes` path" per its
own comment). This is what P13§5 wires up on the Rust side.

## P13§5 Live compute path fixes

Two structural changes to `handle_request` (`rust-core/crates/sidecar/src/handlers.rs:91-131`):

1. **Accept full OHLCV, not closes-only.** The live `ComputeRequest` gains a `candles: Vec<CandleWire>`
   field (replacing the bare `closes: Vec<f64>` it carries today), matching
   `BenchmarkComputeRequest`'s existing shape (`handlers.rs:94-101`). `handle_request` switches from
   `MarketContext::from_closes(...)` to the same `context_at(&candles, candles.len() - 1, ...)` call
   `handle_benchmark_compute` already uses (`handlers.rs:235`). This is the change that lets kronos
   structurally work live at all — it has nothing to do with how much history is available; without
   OHLCV, no amount of backfill would help.
2. **Stop hardcoding `Horizon::Positional`.** `handle_request` takes the actual requested horizon
   (now always `"intraday"` per P13§2's scope decision, but the hardcode is removed rather than
   swapped for a different hardcode, since `registry::run_applicable`'s existing
   `applicable_horizons()` filter already exists to handle this generically).

On the Electron side, `analysisEnvelope.ts`'s `assembleEnvelope` changes what it hands the sidecar:
instead of fetching straight from Kite and passing `closes` (today's behavior), it triggers the
P13§4.3 top-up (fetching only what's missing since the lake's last saved candle for this
symbol+interval), then reads back the required trailing window from the lake via the same
`readLakeCandles`-style call `benchmarkRunner.ts` already uses, and sends that as `candles`. Because
`scanScheduler.ts`'s background ticks call this same `assembleEnvelope`/`handle_request` path, they
transparently gain full-OHLCV context and correct horizon handling too, with zero changes to the
scheduler's own trigger logic (per the P13§2 scope note).

## P13§6 Deterministic readiness gate

A single function, conceptually `checkEngineOnlyReadiness(symbol, interval, now): ReadinessResult`,
run whenever an Engine-Only session is created (after symbol+interval are chosen) or reopened (before
re-rendering/re-computing):

```ts
type ReadinessResult =
  | { ok: true }
  | { ok: false; reason: "kite_not_connected" }
  | { ok: false; reason: "insufficient_history"; have: number; need: number }
  | { ok: false; reason: "market_closed"; nextOpenAt: number };
```

Checked in this fixed order, short-circuiting on the first failure (locked decision 3):

1. **Kite connectivity** — read `KiteSessionState` (`kiteSessionState.ts:67`); anything other than
   `"authenticated"` fails here with `kite_not_connected`. Nothing else runs (no point checking data
   or market hours if there's no way to fetch data at all).
2. **Data readiness** — attempt the P13§4.3 top-up; if the lake still has fewer than the required
   bars for this (symbol, interval) afterward (e.g. a newly-listed stock that has never traded enough
   days to exist), fail with `insufficient_history` (reporting exact have/need counts — this is the
   "clear message instead of a silent empty result" fix for the very bug that started this
   investigation).
3. **Market hours** — check `now` against NSE's session window (9:15am-3:30pm IST) and a bundled
   holiday calendar (a small yearly data file, needs manual refresh each year — flagged as an
   operational note in P13§10, not solved by code). Fail with `market_closed`, including when trading
   next resumes, if outside hours or on a non-trading day.

All three passing → `{ ok: true }`, and the session proceeds to live compute + render, silently
(locked decision 4). Any failure renders exactly one message in that session's view, specific to the
`reason`, and nothing is computed until it's resolved. The gate has no LLM involvement anywhere — it
is pure rule evaluation, deterministic by construction.

## P13§7 UI / session integration

- `InstrumentSearch.tsx` drops its Horizon toggle (`"intraday" | "positional"`, lines 18-19, 95-107)
  and adds an interval picker: three options, 5-minute / 10-minute / 15-minute. Symbol search
  behavior is otherwise unchanged.
- The flow stays exactly what it is today structurally: `App.tsx`'s `onNewSession` →
  `ModePicker` → `onSelectMode("engine_only")` creates an empty session immediately
  (`createSession`, unchanged) → `InstrumentSearch` renders because `activeSession.mode ===
  "engine_only"` → picking a symbol + interval and submitting calls `onAnalyze`, which now runs the
  P13§6 gate before (or instead of) calling `runAnalysis`.
- On gate failure, `onAnalyze` stores/returns the `ReadinessResult` for that session instead of a
  computed `AnalysisResult`; `AnalysisResultView` (or a small addition to it) renders the one
  matching message. No new component, no new session field beyond what's needed to carry this result
  through the existing `structured_payload` mechanism (`ScanTriggerPayload`-style, per
  `scanScheduler.ts:27-32`'s existing pattern of stashing structured data in a message payload).
- Reopening a session (`App.tsx:99-115`, `onOpenSession`) re-runs the P13§6 gate fresh rather than
  only replaying `deriveEngineOnlyView(sessionDetail)`'s last stored result — this is what makes
  "visiting a previous session" behave the way you described: it re-checks data/time state as of
  right now, not as of whenever it was last opened.
- Sidebar rendering (`HistorySidebar.tsx`), the `MODE_LABEL` badge mapping, and `HistoryStore`'s
  `createSession`/`response_mode` column are all completely unchanged — this is still, structurally,
  an ordinary Engine-Only session.

## P13§8 Benchmark harness fix

`runBenchmark` (`benchmarkRunner.ts:80-170`) stops filtering its working series down to
`c.ts >= params.fromTs` before the frontier loop starts. Instead:

- The full lake series (as returned by `readLakeCandles`, unfiltered) is kept as the source for
  **compute context** — each frontier's `series.slice(0, i + 1)` call keeps meaning "everything up to
  and including this bar," but now that slice legitimately reaches back before `fromTs` when the lake
  has that history, giving the selected algorithm real trailing context sized to its own
  `required_lookback()`, exactly like the P13§4.4 live path now does.
- A separate index — where `fromTs` starts — still governs which bars are eligible **frontiers**
  (decision points to score), and `toTs` still bounds them, exactly as today's `if (series[i].ts >=
  params.toTs) break` logic already does. Only the *compute window*'s lower bound changes; which bars
  can become decision points, and which bars render on the chart, do not.
- `onProgress`'s `total` (fixed earlier this session to bound against the eligible-frontier count
  rather than the raw series length) is recomputed against this same eligible-frontier definition —
  unaffected in shape by this change, since it was already about frontier eligibility, not compute
  window size.
- The chart (`benchmarkChart.ts`) keeps rendering only `result.candles` as already scoped — this
  change is entirely about what the algorithm sees, not what you see.

## P13§9 Testing

Per this codebase's TDD convention (no production code without a failing test first):

- **Backfill sizing**: unit tests for `calendarDaysForBackfill` covering all three intervals against
  both 256 (kronos) and 512 (ttm/moirai) requirements, asserting the exact day counts from the P13§3
  table.
- **Top-up**: unit tests (fake Kite client, fake lake) asserting a fresh (symbol, interval) triggers a
  full sized backfill, and a (symbol, interval) with existing lake history only fetches the delta
  since the last stored timestamp.
- **Live context assembly**: Rust unit test asserting `handle_request` with a populated `candles`
  field builds a full-OHLCV `MarketContext` (not `from_closes`) and respects the requested horizon
  rather than hardcoding `Positional`.
- **Readiness gate**: unit tests per branch (`kite_not_connected`, `insufficient_history` with exact
  have/need numbers, `market_closed` with a fixed injected "now" covering pre-open, post-close,
  weekend, and a holiday-calendar date, and the all-pass case), plus a test asserting check order
  (Kite failure short-circuits before data/time are even evaluated). No wall-clock-dependent test —
  "now" is always injected, per this codebase's existing P11/P12 convention.
- **Benchmark harness**: extend the existing `benchmarkRunner.test.ts` suite with a case where the
  lake has history before `fromTs` and assert a frontier near the start of the window receives that
  pre-`fromTs` history in its compute call.
- **UI**: `BenchmarkView`/`InstrumentSearch`-equivalent tests asserting the Horizon toggle is gone,
  the three interval options render, and each `ReadinessResult` reason renders its specific message
  with no result computed.

## P13§10 Risks / open items

- **Kite's per-request historical-data range limit per interval is not yet verified** against the
  real Kite Connect API for this design — if a single backfill request (e.g. ~35 calendar days of
  15-minute candles) exceeds Kite's allowed range for that interval, the backfill step needs to chunk
  into multiple sequential requests (respecting the existing 3 req/sec limit noted in
  `scanScheduler.ts:83-85`). Flagged as a pre-implementation research spike.
- **The NSE holiday calendar is a static data file that goes stale every year** — this is an
  operational maintenance point, not something code can self-correct. The plan should include exactly
  where this file lives and a visible reminder of when it needs refreshing.
- **First-time backfill cost**: adding several symbols across multiple intervals at once could queue
  a burst of sequential Kite historical fetches. Not a correctness risk given the existing rate-limit
  handling, but a latency one (the session may show "loading history" for longer than a single-symbol
  case) — worth surfacing candle-count progress in the `insufficient_history` message rather than a
  bare wait.
- **`benchmarkRunner.ts`'s test suite has existing assertions pinned to the current (buggy)
  fromTs-filtered windowing behavior** (per this session's own edits to `benchmarkRunner.test.ts`)
  and will need deliberate updates, not just new tests, during implementation.
