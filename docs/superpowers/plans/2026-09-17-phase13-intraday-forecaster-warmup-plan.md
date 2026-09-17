# Phase 13 — Intraday Candle-Forecaster Warm-Up & Live Engine-Only Trading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the four ONNX forecasters (kronos/chronos/ttm/moirai) structurally capable of producing a live forecast — by giving the live `Compute` path full OHLCV at the requested horizon, seeding a persistent per-symbol/per-interval candle store sized to each model's real `required_lookback()`, gating an Engine-Only session behind a deterministic Kite→data→market-hours readiness check, and replacing the Engine-Only Horizon toggle with a 5/10/15-minute interval picker — plus fixing the benchmark harness's `fromTs`-truncated compute window with the same "give the algorithm real trailing history" primitive.

**Architecture:** Two pure TypeScript primitives land first with no dependencies — backfill sizing (`calendarDaysForBackfill`) and an NSE trading calendar (a bundled holiday data module plus pure trading-day/session-hours predicates taking an injected `now`). The Rust protocol then changes: `AlgorithmWire` gains `required_lookback` so the Electron side can size the backfill against the real linked models rather than a hardcoded 512, and `ComputeRequest` swaps its bare `closes: Vec<f64>` for a full `candles: Vec<CandleWire>` plus an explicit `horizon`, switching `handle_request` from `MarketContext::from_closes` to `backtest::frontier::context_at` (the same call `handle_benchmark_compute` already makes) and deleting the hardcoded `Horizon::Positional`. Electron then mirrors that wire change, adds an I/O-only `topUpCandles` warm-up (one-time sized bulk backfill on an empty lake partition, delta-only fetch thereafter, both persisted through the existing idempotent `persistCandles`), and a new `assembleWarmedEnvelope` that reads the trailing window back out of the lake instead of handing over a freshly-fetched closes array. The readiness gate composes those pieces in a fixed short-circuiting order and is surfaced over IPC as a `ReadinessResult`, which the renderer renders as exactly one message. The benchmark-harness fix is fully independent and is sequenced early.

**Tech Stack:** Rust (`cargo test -p <crate>` from `rust-core/`; no new dependency — `sidecar` already depends on `algo-core`/`backtest`/`storage`/`serde`/`serde_json`/`chrono`); TypeScript, Electron 33, React 18, Vitest (`npx vitest run <path>`, `npm test`, `npm run typecheck` from `electron-app/`).

## Global Constraints

Every task's requirements implicitly include this section.

- **Hard safety invariant (non-negotiable, restated every phase):** the app NEVER places, modifies, cancels, or automates any order. This phase adds **zero** order-related surface. `kiteClient.ts`'s `KITE_READ_TOOL_NAMES` allowlist and its `KITE_WRITE_TOOL_NAMES` negative assertion are not touched by any task here.
- **No new session type, mode, or sidebar badge.** `AnalysisMode` (`rendererApi.ts:49`) stays exactly `"engine_only" | "ai_assisted"`. `HistorySidebar.tsx`, the `MODE_LABEL` badge mapping, and `HistoryStore`'s `createSession`/`response_mode` column are unchanged by every task in this plan (P13§7).
- **`ScanScheduler`'s own timer/trigger logic is not changed.** It keeps ticking on its configured interval and creating sessions via `WorthLook`/`WorthAiCall` exactly as today. It transparently gains full-OHLCV live context from Task 5 (both paths call the same `handle_request`), but gains **no** interval selection, no sized warm-up, and no market-hours gating — explicitly deferred (P13§2).
- **The AI-Assisted chat flow is untouched.** `runAiAssistedRequest` keeps calling `horizonToFetchParams` + `assembleEnvelope` (the fresh-Kite-window path); only the *shape* of what `assembleEnvelope` hands the sidecar changes (candles instead of closes, Task 6). No readiness gate, no interval picker, no warm-up runs for AI-Assisted.
- **Positional/daily ingestion and the Benchmark tool's `day` timeframe are untouched.** `bhavcopy.rs`, `ingest.rs`, and `horizonForTimeframe`/`defaultCadenceForHorizon` keep working exactly as they do. Only the *Engine-Only intake UI* loses its Positional choice.
- **The readiness gate is pure rule evaluation with zero LLM involvement**, always runs Kite-connectivity → data-readiness → market-hours in that fixed order, and short-circuits on the first failure: exactly one message is ever produced, never a checklist (P13§2 locked decision 3).
- **Silence on success.** All three checks passing produces no banner, toast, or confirmation — the session simply renders its result (P13§2 locked decision 4).
- **No wall-clock-dependent test anywhere.** Every calendar/market-hours/warm-up test injects `now` as a `Date`, per this repo's existing P11/P12 convention. No `vi.useFakeTimers()` is needed for the new pure code; it is still used where it already exists (`analysisEnvelope.test.ts`'s timeout tests).
- **No test performs** a real live Kite OAuth/MCP call, a real `claude` subprocess, a real network fetch, or a real `lightweight-charts`/`electron` runtime — everything is DI-faked or module-mocked via the established patterns (`FakeChild` for `SidecarSupervisor`, `mockSidecar()` for envelope assembly, `installBridge` for renderer components).
- **Comments:** default to none. Only add one when the *why* isn't obvious (a hidden invariant, a workaround, a formula's source). Never restate the next line; never a numbered step block. (From `CLAUDE.md`.)
- **Naming:** Rust `snake_case` functions/vars, `PascalCase` types. TypeScript `camelCase` functions/vars, `PascalCase` types/classes/React components. Wire-mirror interfaces in `sidecarProtocol.ts` keep `snake_case` field names deliberately — they mirror the bytes, not this project's TS convention (see that file's own header comment).
- **Structure:** pure logic stays separate from I/O. Every new file under `electron-app/src/main/services/market/` is either purely computational (`candleInterval.ts`, `backfillSizing.ts`, `nseHolidays.ts`, `tradingCalendar.ts`) or purely I/O-orchestrating (`candleWarmup.ts`, `readinessGate.ts`) — never both.
- **Commit convention:** each task's implementer commits as the repo's own configured git user via plain `git commit` — NEVER pass `--author`, NEVER add a `Co-Authored-By` trailer, NEVER use `--no-verify`. Conventional-commit subjects (`type(scope): message`), matching sibling plans.
- **Two toolchains, two test runners.** **Rust:** run from `rust-core/` — `cargo test -p <crate>`, `cargo test -p <crate> --test <file>`, `cargo test -p <crate> --lib`. **TypeScript:** run from `electron-app/` — `npx vitest run <path>`, `npm test`, `npm run typecheck` (`src/**` only).
- **Working-tree note:** at plan time `electron-app/` carries **uncommitted** changes to `benchmarkRunner.ts`, `benchmarkChart.ts`, `BenchmarkView.tsx`/`.css` and their three test files (the earlier session's `onProgress`-denominator, price-line/volume-format, and auto-open-popover/click-hint fixes). Every code excerpt in this plan is quoted from that **current working-tree state**, not from `HEAD`. Task 3 in particular builds on the already-fixed `onProgress`/eligible-frontier logic. Commit or stash nothing — just implement on top of what is there.

## Open items carried from P13§10 — resolved, with the decision stated

**(i) Kite's per-request historical-data range limit per interval.** *Resolved as a documented assumption with a guard test — no research spike task.* `historicalDataArchive.ts:17-26` already carries `INTERVAL_LOOKBACK_HINT_DAYS` (community-reported, explicitly unverified): `5minute: 100`, `10minute: 100`, `15minute: 200`. The largest backfill this design ever requests is 35 calendar days (15-minute at a 512-bar lookback — see Task 1's table), comfortably inside every hint. **Decision: the backfill issues a single un-chunked request.** Task 1 Step 5 adds a test asserting `calendarDaysForBackfill` never exceeds `INTERVAL_LOOKBACK_HINT_DAYS[interval]` for any interval at the largest lookback any linked forecaster declares, so if a future model with a bigger `required_lookback()` lands, that test fails loudly rather than the backfill silently coming back truncated. Verify the real limits against a live Kite session when convenient; nothing in this plan depends on that verification succeeding, only on the guard test staying green.

**(ii) Where the NSE holiday calendar lives and how it gets refreshed.** *Resolved with a concrete choice, stated here because the spec deliberately left it open.* **Decision: a TypeScript module at `electron-app/src/main/services/market/nseHolidays.ts`, not a JSON asset under `electron-app/resources/`.** Reasons: `tsconfig.json`'s `include` is `src/**/*`, so a `.ts` module is typechecked and its shape can't drift; electron-vite bundles it into `out/main` with zero packaging plumbing, where a JSON asset would need an `electron-builder.yml` `extraResources` entry, a runtime `fs.readFile`, and a file-not-found failure path; and it is ~15 date strings per year, not data that warrants a store. **Yearly refresh** = append one array under the new year's key and bump `NSE_HOLIDAY_CALENDAR_LAST_VERIFIED`. **Staleness is made visible, not silent:** `isTradingDay` degrades to weekends-only for a year the calendar doesn't cover (exactly what `ingest.rs:42-45` already does today, so this is never a regression), and `isHolidayCalendarCovered(year)` is exported so the readiness gate logs one `console.warn` naming the uncovered year instead of quietly treating Diwali as a trading day.

**(iii) Deviation from P13§4.2's "filtered to `cost === "slow"`" — stated because it is a deliberate change.** P13§4.2 sizes the backfill against the max `required_lookback()` of the *slow* (forecaster) algorithms only. This plan sizes it against the max across **all** linked algorithms (Task 8's `maxRequiredLookback`). Reason: if a build has no forecaster feature compiled in, the slow-only max is `0` and the live context window would collapse below even ichimoku's 52 bars, starving the fast indicators that do work today. Taking the max over everything is a strict superset, costs nothing (the extra candles are already in the lake), and removes the need for a hardcoded fast-algorithm floor constant. This is why Task 4 puts `required_lookback` on *every* `AlgorithmWire`, not just the slow ones.

**(iv) Deviation from P13§3's table, stated because the spec's own §9 asks for "the exact day counts from the P13§3 table".** P13§4.2's formula and P13§3's table disagree: the formula (`ceil(requiredBars / barsPerTradingDay) → ceil(tradingDays * 7 / 5) + 5`) yields **15 / 25 / 35** calendar days at 512 bars and **11 / 15 / 21** at 256 bars for 5/10/15-minute, where the table says `~12-14 / ~22-25 / ~32-35` and `~6-7 / ~11-12 / ~16-18`. The table appears to have been computed without the `HOLIDAY_BUFFER_DAYS = 5` term. **Decision: the formula in P13§4.2 is normative and the tests assert its exact outputs**; the table is the order-of-magnitude sanity check it passes. Over-fetching by a few days is harmless — surplus candles are persisted once and the gate only ever asks `have >= need`.

**(v) `Timeframe::TenMinute` does not exist in `algo-core` — a gap P13 does not mention.** `Timeframe` (`algorithm.rs:17-23`) is `Minute | FiveMinute | FifteenMinute | Day`, and `parse_timeframe` (`handlers.rs:74-81`) falls through to `Day` for anything unrecognized. A 10-minute request would therefore be labeled `"day"` on the wire **and** make `kronos_math.rs:72-75`'s `timeframe_step` advance the forecast timestamp by a day instead of ten minutes. **Decision: Task 5 adds `Timeframe::TenMinute`** and fixes the two exhaustive matches the new variant breaks. Without it the 10-minute option in P13§7's picker is quietly wrong.

## File Structure

**New — `electron-app/src/main/services/market/`** (a new directory; pure files and I/O files kept distinct per `CLAUDE.md`):
- `candleInterval.ts` (pure) — the `CandleInterval` union, its labels, NSE's 375-minute session length, `barsPerTradingDay`.
- `backfillSizing.ts` (pure) — `HOLIDAY_BUFFER_DAYS`, `calendarDaysForBackfill`, `maxRequiredLookback`.
- `nseHolidays.ts` (pure data) — `NSE_HOLIDAY_CALENDAR`, its source URL, its last-verified date.
- `tradingCalendar.ts` (pure) — `isHolidayCalendarCovered`, `isTradingDay`, `isWithinSessionHours`, `nextSessionOpen`.
- `candleWarmup.ts` (I/O) — `topUpCandles`: one-time sized backfill, then delta-only top-up.
- `readinessGate.ts` (I/O orchestration) — `ReadinessResult`, `checkEngineOnlyReadiness`.

**New — `electron-app/src/main/services/analysis/`:**
- `warmedEnvelope.ts` (I/O orchestration) — `assembleWarmedEnvelope`: top up, read the trailing window back out of the lake, send it as `candles`. Sits beside the existing `analysisEnvelope.ts` rather than branching inside it, so the AI-Assisted/positional path and the Engine-Only interval path each stay a single straight line.

**Modified — Rust (`rust-core/`):**
- `crates/algo-core/src/algorithm.rs` — `Timeframe::TenMinute`.
- `crates/algo-core/src/forecast/kronos_math.rs` — `timeframe_step`'s new arm.
- `crates/sidecar/src/protocol.rs` — `AlgorithmWire.required_lookback`; `ComputeRequest` swaps `closes` for `horizon` + `candles`.
- `crates/sidecar/src/handlers.rs` — `tag_algorithms`/`handle_list_algorithms` carry the lookback; `handle_request_with_progress` uses `context_at` and the requested horizon; `timeframe_to_wire`/`parse_timeframe` learn `10minute`.
- `crates/sidecar/tests/protocol_test.rs`, `crates/sidecar/tests/end_to_end_test.rs` — wire literals and new assertions.

**Modified — Electron main (`electron-app/src/main/`):**
- `services/sidecar/sidecarProtocol.ts` — `AlgorithmWire.required_lookback`; the `compute` request variant.
- `services/sidecar/sidecarSupervisor.ts` — `compute(symbol, timeframe, horizon, candles, onRequestId?)`.
- `services/analysis/analysisEnvelope.ts` — passes `candles` + a derived horizon instead of `closes`.
- `services/benchmark/benchmarkRunner.ts` — full-lake compute window, window-scoped frontier range.
- `ipc/benchmarkBridge.ts` — maps `required_lookback` → `requiredLookback`.
- `ipc/analysisBridge.ts` — `runAnalysisRequest` runs the gate and uses `assembleWarmedEnvelope`; new `analysis:checkReadiness` handler.
- `ipc/rendererApi.ts` — `CandleInterval`, `ReadinessResult` re-exports; `AlgorithmEntry.requiredLookback`; `AnalysisRunParams`/`AnalysisResult` engine_only shape; `RendererApi.checkReadiness`.
- `bootstrap.ts` — passes `getSession`/`kiteStatus` into the analysis bridge's new gate deps.

**Modified — Renderer (`electron-app/src/renderer/`):**
- `InstrumentSearch.tsx` — interval picker replaces the Horizon toggle.
- `App.tsx` — `onAnalyze` threads the interval; `onOpenSession` re-runs the gate; renders the readiness message.
- `AnalysisResult.tsx` — `readinessMessage` + the blocked branch.

**Modified — Tests (`electron-app/test/`, `rust-core/crates/*/tests/`):** every file touched is named in its own task.

---

### Task 1: Pure backfill sizing (`candleInterval.ts` + `backfillSizing.ts`)

The P13§4.2 formula, with no dependencies at all — it is the first task precisely because it is the easiest thing in the phase to get exactly right in isolation. Two files, not one: the interval vocabulary is consumed by the UI and the readiness gate as well as by the sizing formula, so it lives on its own.

**Files:**
- Create: `electron-app/src/main/services/market/candleInterval.ts`
- Create: `electron-app/src/main/services/market/backfillSizing.ts`
- Create: `electron-app/test/main/services/market/backfillSizing.test.ts`

**Interfaces:**
- Consumes: `INTERVAL_LOOKBACK_HINT_DAYS` from `electron-app/src/main/services/kite/historicalDataArchive.ts` (existing, unchanged) — test-only, for the guard assertion.
- Produces: `type CandleInterval = "5minute" | "10minute" | "15minute"`; `CANDLE_INTERVALS: CandleInterval[]`; `CANDLE_INTERVAL_LABEL: Record<CandleInterval, string>`; `NSE_SESSION_MINUTES = 375`; `barsPerTradingDay(interval: CandleInterval): number`; `HOLIDAY_BUFFER_DAYS = 5`; `calendarDaysForBackfill(interval: CandleInterval, requiredBars: number): number`; `maxRequiredLookback(algorithms: { requiredLookback: number }[]): number`.

- [ ] **Step 1: Write the failing test** — create `electron-app/test/main/services/market/backfillSizing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { barsPerTradingDay, CANDLE_INTERVALS, type CandleInterval } from "../../../../src/main/services/market/candleInterval";
import { calendarDaysForBackfill, maxRequiredLookback } from "../../../../src/main/services/market/backfillSizing";
import { INTERVAL_LOOKBACK_HINT_DAYS } from "../../../../src/main/services/kite/historicalDataArchive";

const KRONOS_LOOKBACK = 256; // kronos_math.rs:11 CTX_LEN
const TTM_MOIRAI_LOOKBACK = 512; // ttm_math.rs:20 / moirai_math.rs:13 CONTEXT_LEN

describe("barsPerTradingDay", () => {
  it("matches the P13§3 candles-per-trading-day table for NSE's 375-minute session", () => {
    expect(barsPerTradingDay("5minute")).toBe(75);
    expect(barsPerTradingDay("10minute")).toBe(37);
    expect(barsPerTradingDay("15minute")).toBe(25);
  });
});

describe("calendarDaysForBackfill", () => {
  // The P13§4.2 formula is normative; P13§3's "~N calendar days" table was
  // computed without HOLIDAY_BUFFER_DAYS and is the order-of-magnitude check
  // these numbers pass, not the assertion (see the plan's open item (iv)).
  it("sizes the largest forecaster requirement (512 bars) per interval", () => {
    expect(calendarDaysForBackfill("5minute", TTM_MOIRAI_LOOKBACK)).toBe(15);
    expect(calendarDaysForBackfill("10minute", TTM_MOIRAI_LOOKBACK)).toBe(25);
    expect(calendarDaysForBackfill("15minute", TTM_MOIRAI_LOOKBACK)).toBe(35);
  });

  it("sizes the smallest forecaster requirement (256 bars) per interval", () => {
    expect(calendarDaysForBackfill("5minute", KRONOS_LOOKBACK)).toBe(11);
    expect(calendarDaysForBackfill("10minute", KRONOS_LOOKBACK)).toBe(15);
    expect(calendarDaysForBackfill("15minute", KRONOS_LOOKBACK)).toBe(21);
  });

  it("asks for nothing when nothing is required", () => {
    expect(calendarDaysForBackfill("5minute", 0)).toBe(0);
    expect(calendarDaysForBackfill("5minute", -1)).toBe(0);
  });

  it("never requests a span wider than Kite's per-interval range hint, so the backfill stays one un-chunked call", () => {
    // Guard for the plan's open item (i): if a future forecaster's
    // required_lookback pushes any interval past its hint, this fails loudly
    // instead of the backfill silently returning a truncated window.
    for (const interval of CANDLE_INTERVALS) {
      expect(calendarDaysForBackfill(interval, TTM_MOIRAI_LOOKBACK)).toBeLessThanOrEqual(
        INTERVAL_LOOKBACK_HINT_DAYS[interval satisfies CandleInterval],
      );
    }
  });
});

describe("maxRequiredLookback", () => {
  it("takes the maximum across every linked algorithm, not just the forecasters", () => {
    expect(
      maxRequiredLookback([
        { requiredLookback: 20 },
        { requiredLookback: 512 },
        { requiredLookback: 52 },
      ]),
    ).toBe(512);
  });

  it("returns 0 for an empty registry rather than -Infinity", () => {
    expect(maxRequiredLookback([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `electron-app/`): `npx vitest run test/main/services/market/backfillSizing.test.ts`
Expected: FAIL — `Failed to resolve import ".../market/candleInterval"`; neither module exists yet.

- [ ] **Step 3: Write the interval vocabulary** — create `electron-app/src/main/services/market/candleInterval.ts`:

```ts
export type CandleInterval = "5minute" | "10minute" | "15minute";

export const CANDLE_INTERVALS: CandleInterval[] = ["5minute", "10minute", "15minute"];

export const CANDLE_INTERVAL_LABEL: Record<CandleInterval, string> = {
  "5minute": "5-minute",
  "10minute": "10-minute",
  "15minute": "15-minute",
};

// NSE's regular equity session is 09:15-15:30 IST (P13§3).
export const NSE_SESSION_MINUTES = 375;

const INTERVAL_MINUTES: Record<CandleInterval, number> = {
  "5minute": 5,
  "10minute": 10,
  "15minute": 15,
};

export function intervalMinutes(interval: CandleInterval): number {
  return INTERVAL_MINUTES[interval];
}

export function barsPerTradingDay(interval: CandleInterval): number {
  // Floor, not round: a partial trailing bar is not a bar you can rely on
  // receiving, so 375/10 counts as 37 ten-minute bars, never 38.
  return Math.floor(NSE_SESSION_MINUTES / INTERVAL_MINUTES[interval]);
}
```

- [ ] **Step 4: Write the sizing formula** — create `electron-app/src/main/services/market/backfillSizing.ts`:

```ts
import { barsPerTradingDay, type CandleInterval } from "./candleInterval";

// Covers the worst realistic run of NSE holidays inside a requested span
// (P13§4.2). Over-fetching costs one wider Kite window and some surplus rows
// the lake merges idempotently; under-fetching silently starves a forecaster.
export const HOLIDAY_BUFFER_DAYS = 5;

export function calendarDaysForBackfill(interval: CandleInterval, requiredBars: number): number {
  if (requiredBars <= 0) return 0;
  const tradingDays = Math.ceil(requiredBars / barsPerTradingDay(interval));
  return Math.ceil((tradingDays * 7) / 5) + HOLIDAY_BUFFER_DAYS;
}

export function maxRequiredLookback(algorithms: { requiredLookback: number }[]): number {
  return algorithms.reduce((max, algo) => Math.max(max, algo.requiredLookback), 0);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/main/services/market/backfillSizing.test.ts && npm run typecheck`
Expected: PASS — all seven tests, plus a clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/services/market/candleInterval.ts electron-app/src/main/services/market/backfillSizing.ts electron-app/test/main/services/market/backfillSizing.test.ts
git commit -m "feat(market): pure backfill sizing for 5/10/15-minute candle warm-up"
```

---

### Task 2: NSE trading calendar (`nseHolidays.ts` + `tradingCalendar.ts`)

The market-hours half of the readiness gate, built before the gate needs it. No trading-day-aware date math exists anywhere in this repo today (`ingest.rs:42-45` only skips Saturday/Sunday; `ingestion/time.rs` only hardcodes the 15:30 IST close instant), so this is genuinely new. Split in two: a data module that goes stale yearly, and pure predicates that never do.

**Files:**
- Create: `electron-app/src/main/services/market/nseHolidays.ts`
- Create: `electron-app/src/main/services/market/tradingCalendar.ts`
- Create: `electron-app/test/main/services/market/tradingCalendar.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `NSE_HOLIDAY_CALENDAR: Readonly<Record<string, readonly string[]>>` (keys are four-digit year strings, values are `YYYY-MM-DD` IST dates); `NSE_HOLIDAY_CALENDAR_SOURCE: string`; `NSE_HOLIDAY_CALENDAR_LAST_VERIFIED: string`; `SESSION_OPEN_MINUTES = 555`; `SESSION_CLOSE_MINUTES = 930`; `isHolidayCalendarCovered(year: number): boolean`; `isTradingDay(at: Date): boolean`; `isWithinSessionHours(at: Date): boolean`; `nextSessionOpen(at: Date): number` (epoch **seconds**).

- [ ] **Step 1: Write the failing test** — create `electron-app/test/main/services/market/tradingCalendar.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  isHolidayCalendarCovered,
  isTradingDay,
  isWithinSessionHours,
  nextSessionOpen,
} from "../../../../src/main/services/market/tradingCalendar";

// Every fixture is an explicit IST instant. Nothing here reads the wall clock.
function ist(isoWithoutZone: string): Date {
  return new Date(`${isoWithoutZone}+05:30`);
}

describe("isHolidayCalendarCovered", () => {
  it("reports 2026 covered and a year the bundled calendar has never seen uncovered", () => {
    expect(isHolidayCalendarCovered(2026)).toBe(true);
    expect(isHolidayCalendarCovered(1999)).toBe(false);
  });
});

describe("isTradingDay", () => {
  it("accepts an ordinary midweek session day", () => {
    expect(isTradingDay(ist("2026-09-17T11:00:00"))).toBe(true); // Thursday
  });

  it("rejects Saturday and Sunday", () => {
    expect(isTradingDay(ist("2026-09-19T11:00:00"))).toBe(false); // Saturday
    expect(isTradingDay(ist("2026-09-20T11:00:00"))).toBe(false); // Sunday
  });

  it("rejects a bundled-calendar holiday that falls on a weekday", () => {
    // Republic Day, a fixed-date statutory holiday NSE observes every year.
    expect(isTradingDay(ist("2026-01-26T11:00:00"))).toBe(false); // Monday
    // Gandhi Jayanti, likewise fixed-date.
    expect(isTradingDay(ist("2026-10-02T11:00:00"))).toBe(false); // Friday
  });

  it("degrades to weekends-only for a year the calendar does not cover, instead of throwing", () => {
    expect(isTradingDay(ist("1999-06-15T11:00:00"))).toBe(true); // Tuesday
    expect(isTradingDay(ist("1999-06-19T11:00:00"))).toBe(false); // Saturday
  });

  it("classifies by the IST calendar date, not the host's local one", () => {
    // 2026-09-19T02:00 IST is still 2026-09-18 20:30 UTC -- a UTC-based check
    // would call this Friday (a trading day); in IST it is Saturday.
    expect(isTradingDay(ist("2026-09-19T02:00:00"))).toBe(false);
  });
});

describe("isWithinSessionHours", () => {
  it("is true at the open, inside the session, and at the close", () => {
    expect(isWithinSessionHours(ist("2026-09-17T09:15:00"))).toBe(true);
    expect(isWithinSessionHours(ist("2026-09-17T14:00:00"))).toBe(true);
    expect(isWithinSessionHours(ist("2026-09-17T15:30:00"))).toBe(true);
  });

  it("is false pre-open and post-close", () => {
    expect(isWithinSessionHours(ist("2026-09-17T09:14:59"))).toBe(false);
    expect(isWithinSessionHours(ist("2026-09-17T15:30:01"))).toBe(false);
  });

  it("is false all day on a non-trading day, even at an in-session clock time", () => {
    expect(isWithinSessionHours(ist("2026-09-19T11:00:00"))).toBe(false); // Saturday
    expect(isWithinSessionHours(ist("2026-01-26T11:00:00"))).toBe(false); // Republic Day
  });
});

describe("nextSessionOpen", () => {
  it("returns today's open when called before it on a trading day", () => {
    expect(nextSessionOpen(ist("2026-09-17T07:00:00"))).toBe(ist("2026-09-17T09:15:00").getTime() / 1000);
  });

  it("rolls to the next trading day when called after the close", () => {
    expect(nextSessionOpen(ist("2026-09-17T16:00:00"))).toBe(ist("2026-09-18T09:15:00").getTime() / 1000);
  });

  it("skips the weekend from a Friday evening", () => {
    expect(nextSessionOpen(ist("2026-09-18T16:00:00"))).toBe(ist("2026-09-21T09:15:00").getTime() / 1000);
  });

  it("skips a holiday that falls on the next weekday", () => {
    // 2026-10-01 is a Thursday; 2026-10-02 (Gandhi Jayanti, Friday) is closed,
    // so the next open after Thursday's close is Monday 2026-10-05.
    expect(nextSessionOpen(ist("2026-10-01T16:00:00"))).toBe(ist("2026-10-05T09:15:00").getTime() / 1000);
  });

  it("returns the current session's own open while the session is live, so the gate never reports a session in progress as closed", () => {
    expect(nextSessionOpen(ist("2026-09-17T11:00:00"))).toBe(ist("2026-09-17T09:15:00").getTime() / 1000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/main/services/market/tradingCalendar.test.ts`
Expected: FAIL — `Failed to resolve import ".../market/tradingCalendar"`.

- [ ] **Step 3: Write the holiday data module** — create `electron-app/src/main/services/market/nseHolidays.ts`:

```ts
// NSE trading holidays, keyed by four-digit year, values as IST calendar dates.
//
// This file goes stale every year and code cannot self-correct it: when a new
// year's circular is published, append its key here and bump
// NSE_HOLIDAY_CALENDAR_LAST_VERIFIED. A year with no key degrades to
// weekends-only (tradingCalendar.isTradingDay), never to a crash.
export const NSE_HOLIDAY_CALENDAR_SOURCE =
  "https://www.nseindia.com/resources/exchange-communication-holidays";

export const NSE_HOLIDAY_CALENDAR_LAST_VERIFIED = "2026-09-17";

export const NSE_HOLIDAY_CALENDAR: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "2026": Object.freeze([
    "2026-01-26", // Republic Day
    "2026-03-03", // Holi
    "2026-03-21", // Id-ul-Fitr (Ramzan Id)
    "2026-04-01", // Mahavir Jayanti
    "2026-04-03", // Good Friday
    "2026-04-14", // Dr. Ambedkar Jayanti
    "2026-05-01", // Maharashtra Day
    "2026-05-28", // Bakri Id
    "2026-06-26", // Muharram
    "2026-08-15", // Independence Day
    "2026-08-28", // Ganesh Chaturthi
    "2026-10-02", // Mahatma Gandhi Jayanti
    "2026-10-21", // Dussehra
    "2026-11-09", // Diwali Balipratipada
    "2026-11-24", // Guru Nanak Jayanti
    "2026-12-25", // Christmas
  ] as const),
});
```

Before committing, reconcile the movable-feast dates above against the circular at `NSE_HOLIDAY_CALENDAR_SOURCE` and correct any that differ — the two dates Task 2's tests assert on (`2026-01-26`, `2026-10-02`) are fixed-date statutory holidays and hold regardless, so a correction to the movable ones will not break the suite.

- [ ] **Step 4: Write the pure calendar predicates** — create `electron-app/src/main/services/market/tradingCalendar.ts`:

```ts
import { NSE_HOLIDAY_CALENDAR } from "./nseHolidays";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const SESSION_OPEN_MINUTES = 9 * 60 + 15;
export const SESSION_CLOSE_MINUTES = 15 * 60 + 30;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

// Kite, NSE session boundaries, and the holiday calendar are all IST; wall-clock
// components are read off a UTC-shifted clone via the UTC getters so the host
// machine's own timezone can never change the answer.
function toIst(at: Date): Date {
  return new Date(at.getTime() + IST_OFFSET_MS);
}

function istDateKey(at: Date): string {
  const ist = toIst(at);
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
}

function istMinutesOfDay(at: Date): number {
  const ist = toIst(at);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

export function isHolidayCalendarCovered(year: number): boolean {
  return Object.prototype.hasOwnProperty.call(NSE_HOLIDAY_CALENDAR, String(year));
}

export function isTradingDay(at: Date): boolean {
  const ist = toIst(at);
  const weekday = ist.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  // An uncovered year degrades to weekends-only -- exactly what ingest.rs
  // already does -- rather than throwing inside a live readiness check.
  return !(NSE_HOLIDAY_CALENDAR[String(ist.getUTCFullYear())] ?? []).includes(istDateKey(at));
}

export function isWithinSessionHours(at: Date): boolean {
  if (!isTradingDay(at)) return false;
  const minutes = istMinutesOfDay(at);
  return minutes >= SESSION_OPEN_MINUTES && minutes <= SESSION_CLOSE_MINUTES;
}

function sessionOpenEpochSeconds(at: Date): number {
  const ist = toIst(at);
  const istMidnightUtcMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  return (istMidnightUtcMs - IST_OFFSET_MS + SESSION_OPEN_MINUTES * 60 * 1000) / 1000;
}

export function nextSessionOpen(at: Date): number {
  // Inside or before today's session, "next open" is today's own open: the gate
  // only ever calls this to say when trading resumes, and a live session has
  // already resumed.
  let cursor = at;
  if (isTradingDay(cursor) && istMinutesOfDay(cursor) <= SESSION_CLOSE_MINUTES) {
    return sessionOpenEpochSeconds(cursor);
  }
  do {
    cursor = new Date(cursor.getTime() + DAY_MS);
  } while (!isTradingDay(cursor));
  return sessionOpenEpochSeconds(cursor);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/main/services/market/tradingCalendar.test.ts && npm run typecheck`
Expected: PASS — all fourteen tests, clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/services/market/nseHolidays.ts electron-app/src/main/services/market/tradingCalendar.ts electron-app/test/main/services/market/tradingCalendar.test.ts
git commit -m "feat(market): bundled NSE holiday calendar and pure trading-day/session-hours predicates"
```

---

### Task 3: Benchmark harness — full-lake compute window, window-scoped frontiers (P13§8)

Fully independent of the live-path work: it touches only `benchmarkRunner.ts` and reuses the existing `required_lookback()` gate inside `run_applicable` rather than adding anything. Sequenced third so it lands before the larger live-path chain and can be reviewed on its own. **This builds on the working tree's already-fixed `onProgress` denominator** (`progressTotal`, bounded by eligible frontiers) — do not re-derive that fix, extend it.

Today `runBenchmark` sets `series = candles.filter((c) => c.ts >= params.fromTs)` and then computes every frontier's context from `series.slice(0, i + 1)`, so a frontier near the start of a selected window gets almost no trailing history and `registry::run_applicable`'s lookback gate silently drops every algorithm whose `required_lookback()` exceeds it — the "algos: (empty), zeroed confluence" symptom that started this phase. After this task, `series` is the whole lake partition, a separate index governs which bars may be frontiers, and `result.candles` stays window-scoped so the chart renders exactly what it renders today.

**Files:**
- Modify: `electron-app/src/main/services/benchmark/benchmarkRunner.ts:80-177`
- Modify: `electron-app/test/main/services/benchmark/benchmarkRunner.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change. `runBenchmark(deps, params, onProgress?)` keeps its exact shape; `DecisionPoint.frontierIndex` changes meaning from "index into the returned `candles`" to "index into the full lake series" (verified safe: `benchmarkChart.ts:83` keys decision points by `ts`, never by `frontierIndex`, and nothing else in `src/` reads the field).

- [ ] **Step 1: Write the failing test** — in `electron-app/test/main/services/benchmark/benchmarkRunner.test.ts`, append inside the `describe("runBenchmark frontier walk", ...)` block, immediately after the existing `"bounds onProgress's total to the eligible window, not the entire remaining lake series"` test:

```ts
  it("computes a window-start frontier against the lake history BEFORE fromTs, not a truncated window", async () => {
    // 40 bars of lake history, but only the last 3 fall inside the selected
    // window. Before this fix the first frontier saw 1 bar and every algorithm
    // with a real required_lookback was silently dropped by run_applicable.
    const dayStart = 1_700_000_000;
    const candles: CandleWire[] = Array.from({ length: 40 }, (_, i) => ({
      ts: dayStart + i * DAY_SECONDS,
      open: 100 + i,
      high: 100 + i,
      low: 100 + i,
      close: 100 + i,
      volume: 100,
    }));
    const fromTs = candles[37].ts;
    const windows: number[] = [];
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles }),
        benchmarkCompute: vi.fn().mockImplementation((_s, _t, _h, window: CandleWire[]) => {
          windows.push(window.length);
          return Promise.resolve({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH });
        }),
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const result = await runBenchmark(deps, baseParams({ fromTs, toTs: 1e12, lookaheadBars: 1 }));
    // Frontiers 37 and 38 are eligible (39 has no bar at i+1); each is handed
    // everything up to and including itself, reaching back before fromTs.
    expect(windows).toEqual([38, 39]);
    // The chart still shows only the selected window.
    expect(result.candles).toHaveLength(3);
    expect(result.candles[0].ts).toBe(fromTs);
  });

  it("reports progress from zero at the window's first frontier, not from its lake index", async () => {
    const dayStart = 1_700_000_000;
    const candles: CandleWire[] = Array.from({ length: 40 }, (_, i) => ({
      ts: dayStart + i * DAY_SECONDS,
      open: 100 + i,
      high: 100 + i,
      low: 100 + i,
      close: 100 + i,
      volume: 100,
    }));
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles }),
        benchmarkCompute: vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH }),
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const progress: Array<[number, number]> = [];
    await runBenchmark(deps, baseParams({ fromTs: candles[37].ts, toTs: 1e12, lookaheadBars: 1 }), (index, total) =>
      progress.push([index, total]),
    );
    expect(progress).toEqual([[0, 2], [1, 2]]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/main/services/benchmark/benchmarkRunner.test.ts`
Expected: FAIL — the first new test gets `windows` of `[1, 2]` (the truncated window) instead of `[38, 39]`; the second gets `[[0, 2], [1, 2]]` only by accident of `fromTs`-relative indexing and may pass — the first failure is the meaningful one.

- [ ] **Step 3: Widen the compute window, scope the frontier range** — in `electron-app/src/main/services/benchmark/benchmarkRunner.ts`, replace the block from `const { candles } = await deps.sidecar.readLakeCandles(...)` down to and including `const progressTotal = ...`:

```ts
  const { candles } = await deps.sidecar.readLakeCandles(params.symbol, params.timeframe, params.source);
  // The FULL lake partition is the compute window: each frontier's
  // series.slice(0, i + 1) must legitimately reach back before fromTs, or
  // registry::run_applicable's lookback gate silently drops every algorithm
  // whose required_lookback() exceeds the truncated window (P13§8).
  const series = candles;
  // A separate index governs eligibility as a *frontier*: only bars inside
  // [fromTs, toTs) are decision points, and only those render on the chart.
  const windowStartIndex = series.findIndex((c) => c.ts >= params.fromTs);
  const firstFrontier = windowStartIndex === -1 ? series.length : windowStartIndex;
  const windowEndIndex = series.findIndex((c) => c.ts >= params.toTs);
  const boundByWindow = windowEndIndex === -1 ? series.length : windowEndIndex;
  // No upper bound from toTs on `series` itself: a day-timeframe entry's single
  // selected day is one bar, and scoring its outcome needs `lookaheadBars` MORE
  // bars beyond it.
  const boundByLookahead = Math.max(0, series.length - params.lookaheadBars);
  const progressTotal = Math.max(0, Math.min(boundByWindow, boundByLookahead) - firstFrontier);
```

Replace the loop header and the `onProgress` call:

```ts
    for (let i = firstFrontier; i < series.length; i++) {
      // A frontier must fall inside the requested window; `toTs` is exclusive
      // (start of the next day) so a candle stamped exactly at that boundary is
      // never mistaken for part of the selected day.
      if (series[i].ts >= params.toTs) break;
      // Mirror run_replay's boundary: stop once no future bar exists at i+lookahead.
      if (i + params.lookaheadBars >= series.length) break;

      onProgress?.(i - firstFrontier, progressTotal);
```

Replace the return statement:

```ts
  return { params, candles: series.slice(firstFrontier), decisionPoints, cancelled };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/main/services/benchmark/benchmarkRunner.test.ts && npm run typecheck`
Expected: PASS — the two new tests plus every pre-existing test in the file. The pre-existing `frontierIndex` assertions (`[0, 2]` and `[0, 1, 3]`) and the `result.candles` length assertions still hold because `baseParams` uses `fromTs: 0`, making `firstFrontier === 0` and `series.slice(0)` the whole series.

- [ ] **Step 5: Run the wider benchmark suite**

Run: `npx vitest run test/main/services/benchmark test/main/ipc/benchmarkBridge.test.ts test/renderer/BenchmarkView.test.tsx test/renderer/benchmarkChart.test.ts`
Expected: PASS — nothing downstream reads `frontierIndex` as an index into `result.candles`.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/services/benchmark/benchmarkRunner.ts electron-app/test/main/services/benchmark/benchmarkRunner.test.ts
git commit -m "fix(benchmark): give each frontier the lake's pre-fromTs history as compute context"
```

---

### Task 4: Sidecar — `AlgorithmWire.required_lookback` (Rust + TS mirror)

The Electron side cannot size a backfill against "whichever model needs the most" without knowing what each model needs. `handle_list_algorithms` already exists and already tags `fast`/`slow`; this adds the one number it was missing. Rust and TS land together because the TS mirror is meaningless without the Rust field and the bridge mapping is a one-line consequence.

**Files:**
- Modify: `rust-core/crates/sidecar/src/protocol.rs:166-171`
- Modify: `rust-core/crates/sidecar/src/handlers.rs:278-295`
- Modify: `rust-core/crates/sidecar/tests/protocol_test.rs`
- Modify: `rust-core/crates/sidecar/tests/end_to_end_test.rs`
- Modify: `electron-app/src/main/services/sidecar/sidecarProtocol.ts:97-100`
- Modify: `electron-app/src/main/ipc/rendererApi.ts:44-47`
- Modify: `electron-app/src/main/ipc/benchmarkBridge.ts:27-30`
- Modify: `electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts:297-307`
- Modify: `electron-app/test/main/ipc/benchmarkBridge.test.ts:57-71`
- Modify: `electron-app/test/main/ipc/rendererApi.test.ts:67-71`
- Modify: `electron-app/test/renderer/BenchmarkView.test.tsx:23-24`

**Interfaces:**
- Consumes: `algo_core::Algorithm::required_lookback` (existing trait method, `algorithm.rs:103`).
- Produces: Rust `AlgorithmWire { id: String, cost: String, required_lookback: usize }`; TS `AlgorithmWire { id: string; cost: "fast" | "slow"; required_lookback: number }`; TS `AlgorithmEntry { id: string; cost: "fast" | "slow"; requiredLookback: number }`.

- [ ] **Step 1: Write the failing Rust tests** — in `rust-core/crates/sidecar/src/handlers.rs`'s `mod tests`, append after `tag_algorithms_treats_any_slow_source_id_as_slow_even_if_the_fast_source_also_contains_it`:

```rust
    #[test]
    fn handle_list_algorithms_reports_each_algorithms_own_required_lookback() {
        let response = handle_list_algorithms(ListAlgorithmsRequest { id: 42 });
        for algo in registry::all_for_binary() {
            let wire = response
                .algorithms
                .iter()
                .find(|w| w.id == algo.id())
                .unwrap_or_else(|| panic!("id {} missing from the response", algo.id()));
            assert_eq!(
                wire.required_lookback,
                algo.required_lookback(),
                "required_lookback for {} must be the algorithm's own, not a constant",
                algo.id()
            );
        }
        // At least one algorithm in every build declares a non-zero lookback --
        // proves the field is populated, not uniformly defaulted to 0.
        assert!(response.algorithms.iter().any(|w| w.required_lookback > 0));
    }
```

In `rust-core/crates/sidecar/tests/protocol_test.rs`, replace the existing `algorithms_response_serializes_its_tagged_algorithm_list` test:

```rust
#[test]
fn algorithms_response_serializes_its_tagged_algorithm_list() {
    let json = serde_json::to_string(&ListAlgorithmsResponse {
        id: 40,
        algorithms: vec![
            AlgorithmWire { id: "sma".to_string(), cost: "fast".to_string(), required_lookback: 20 },
            AlgorithmWire { id: "kronos".to_string(), cost: "slow".to_string(), required_lookback: 256 },
        ],
    })
    .unwrap();
    assert!(json.contains("\"id\":40"));
    assert!(json.contains("\"id\":\"sma\""));
    assert!(json.contains("\"cost\":\"fast\""));
    assert!(json.contains("\"cost\":\"slow\""));
    assert!(json.contains("\"required_lookback\":20"));
    assert!(json.contains("\"required_lookback\":256"));
}
```

and replace the existing `encodes_a_tagged_algorithms_response` test:

```rust
#[test]
fn encodes_a_tagged_algorithms_response() {
    let line = encode_response(&SidecarResponse::Algorithms(ListAlgorithmsResponse {
        id: 40,
        algorithms: vec![AlgorithmWire { id: "sma".to_string(), cost: "fast".to_string(), required_lookback: 20 }],
    }));
    assert!(!line.contains('\n'));
    assert!(line.contains("\"type\":\"algorithms\""));
    assert!(line.contains("\"id\":\"sma\""));
    assert!(line.contains("\"required_lookback\":20"));
}
```

In `rust-core/crates/sidecar/tests/end_to_end_test.rs`, replace the final assertion of `list_algorithms_answers_even_with_no_lake_root`:

```rust
    assert!(algorithms.iter().all(|a| a["cost"] == "fast" || a["cost"] == "slow"));
    assert!(algorithms.iter().all(|a| a["required_lookback"].is_u64()));
```

- [ ] **Step 2: Run the Rust tests to verify they fail**

Run (from `rust-core/`): `cargo test -p sidecar`
Expected: FAIL to compile — `AlgorithmWire` has no `required_lookback` field.

- [ ] **Step 3: Add the Rust field** — in `rust-core/crates/sidecar/src/protocol.rs`, replace:

```rust
#[derive(Debug, Serialize)]
pub struct AlgorithmWire {
    pub id: String,
    /// "fast" | "slow" -- see handlers::handle_list_algorithms for the split.
    pub cost: String,
}
```

with:

```rust
#[derive(Debug, Serialize)]
pub struct AlgorithmWire {
    pub id: String,
    /// "fast" | "slow" -- see handlers::handle_list_algorithms for the split.
    pub cost: String,
    /// The algorithm's own Algorithm::required_lookback(). The Electron side
    /// sizes its warm-up backfill against the maximum of these (P13§4.2), so a
    /// newly linked model widens the fetch window without a code change here.
    pub required_lookback: usize,
}
```

In `rust-core/crates/sidecar/src/handlers.rs`, replace `tag_algorithms`:

```rust
fn tag_algorithms(fast_source: &[Box<dyn Algorithm>], slow_source: &[Box<dyn Algorithm>]) -> Vec<AlgorithmWire> {
    let slow_ids: std::collections::HashSet<&str> = slow_source.iter().map(|a| a.id()).collect();
    let mut algorithms: Vec<AlgorithmWire> = fast_source
        .iter()
        .filter(|a| !slow_ids.contains(a.id()))
        .map(|a| AlgorithmWire {
            id: a.id().to_string(),
            cost: "fast".to_string(),
            required_lookback: a.required_lookback(),
        })
        .collect();
    for algo in slow_source {
        algorithms.push(AlgorithmWire {
            id: algo.id().to_string(),
            cost: "slow".to_string(),
            required_lookback: algo.required_lookback(),
        });
    }
    algorithms.sort_by(|a, b| a.id.cmp(&b.id));
    algorithms
}
```

- [ ] **Step 4: Run the Rust tests to verify they pass**

Run: `cargo test -p sidecar`
Expected: PASS — every test in `protocol_test.rs`, `handlers.rs`, and `end_to_end_test.rs`.

- [ ] **Step 5: Write the failing TypeScript tests** — in `electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts`, replace the body of the `"resolves listAlgorithms with an algorithms response carrying the matching id"` test's stdout write and assertions:

```ts
    children[0].stdout.write(
      `${JSON.stringify({ type: "algorithms", id: 1, algorithms: [{ id: "sma", cost: "fast", required_lookback: 20 }] })}\n`,
    );
    const response = await pending;
    expect(response.type).toBe("algorithms");
    expect(response.algorithms[0].id).toBe("sma");
    expect(response.algorithms[0].required_lookback).toBe(20);
```

In `electron-app/test/main/ipc/benchmarkBridge.test.ts`, replace the `listAlgorithms` mock payload and its assertion:

```ts
    sidecar.listAlgorithms.mockResolvedValue({
      type: "algorithms",
      id: 1,
      algorithms: [
        { id: "sma", cost: "fast", required_lookback: 20 },
        { id: "kronos", cost: "slow", required_lookback: 256 },
      ],
    });
    const entries = await handlers.get("benchmark:listAlgorithms")!(fakeEvent(), undefined);
    expect(entries).toEqual([
      { id: "sma", cost: "fast", requiredLookback: 20 },
      { id: "kronos", cost: "slow", requiredLookback: 256 },
    ]);
```

In `electron-app/test/main/ipc/rendererApi.test.ts`, replace the `listAlgorithms` routing test's mock value:

```ts
    const invoke = vi.fn().mockResolvedValue([{ id: "sma", cost: "fast", requiredLookback: 20 }]);
```

In `electron-app/test/renderer/BenchmarkView.test.tsx`, replace the `ALGORITHMS` fixture entries:

```ts
  { id: "sma", cost: "fast", requiredLookback: 20 },
  { id: "kronos", cost: "slow", requiredLookback: 256 },
```

- [ ] **Step 6: Run the TypeScript tests to verify they fail**

Run (from `electron-app/`): `npx vitest run test/main/services/sidecar/sidecarSupervisor.test.ts test/main/ipc/benchmarkBridge.test.ts`
Expected: FAIL — `benchmarkBridge` returns `{ id, cost }` without `requiredLookback`; `response.algorithms[0].required_lookback` is a type error and `undefined` at runtime.

- [ ] **Step 7: Mirror the field in TypeScript** — in `electron-app/src/main/services/sidecar/sidecarProtocol.ts`, replace:

```ts
export interface AlgorithmWire {
  id: string;
  cost: "fast" | "slow";
}
```

with:

```ts
export interface AlgorithmWire {
  id: string;
  cost: "fast" | "slow";
  required_lookback: number;
}
```

In `electron-app/src/main/ipc/rendererApi.ts`, replace:

```ts
export interface AlgorithmEntry {
  id: string;
  cost: "fast" | "slow";
}
```

with:

```ts
export interface AlgorithmEntry {
  id: string;
  cost: "fast" | "slow";
  requiredLookback: number;
}
```

In `electron-app/src/main/ipc/benchmarkBridge.ts`, replace the `listAlgorithms` mapping line:

```ts
    return algorithms.map((a) => ({ id: a.id, cost: a.cost as "fast" | "slow", requiredLookback: a.required_lookback }));
```

- [ ] **Step 8: Run the TypeScript tests to verify they pass**

Run: `npx vitest run test/main/services/sidecar test/main/ipc test/renderer/BenchmarkView.test.tsx && npm run typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 9: Commit**

```bash
git add rust-core/crates/sidecar/src/protocol.rs rust-core/crates/sidecar/src/handlers.rs rust-core/crates/sidecar/tests/protocol_test.rs rust-core/crates/sidecar/tests/end_to_end_test.rs electron-app/src/main/services/sidecar/sidecarProtocol.ts electron-app/src/main/ipc/rendererApi.ts electron-app/src/main/ipc/benchmarkBridge.ts electron-app/test
git commit -m "feat(sidecar): list_algorithms reports each algorithm's required_lookback"
```

---

### Task 5: Sidecar — live `Compute` takes full OHLCV at the requested horizon (P13§5)

The structural fix: without OHLCV, kronos's `ctx.opens.len() < CTX_LEN` guard (`kronos.rs:170-175`) sends it to its neutral branch on every live tick forever, no matter how much history exists. `ComputeRequest` swaps `closes: Vec<f64>` for `horizon: String` + `candles: Vec<CandleWire>`, `handle_request_with_progress` switches from `MarketContext::from_closes` to the same `context_at` call `handle_benchmark_compute` already makes (`handlers.rs:235`), and the hardcoded `Horizon::Positional` (`handlers.rs:108`) is deleted rather than swapped for a different hardcode — `registry::run_applicable`'s `applicable_horizons()` filter already handles horizon generically. `Timeframe::TenMinute` is added here too (plan open item (v)): without it a 10-minute request is labeled `"day"` on the wire and makes kronos's `timeframe_step` advance the forecast by a day.

`protocol.rs`, `handlers.rs`, and `algorithm.rs`/`kronos_math.rs` land in one task because adding a `Timeframe` variant makes two exhaustive matches non-compiling until the same commit fixes them.

**Files:**
- Modify: `rust-core/crates/algo-core/src/algorithm.rs:17-23`
- Modify: `rust-core/crates/algo-core/src/forecast/kronos_math.rs:72-75`
- Modify: `rust-core/crates/sidecar/src/protocol.rs:3-9`
- Modify: `rust-core/crates/sidecar/src/handlers.rs:20-27,74-81,91-131`
- Modify: `rust-core/crates/sidecar/tests/protocol_test.rs`
- Modify: `rust-core/crates/sidecar/tests/end_to_end_test.rs`

**Interfaces:**
- Consumes: `backtest::frontier::context_at` (already imported in `handlers.rs:15`), `storage::Candle`.
- Produces: `Timeframe::TenMinute`; `ComputeRequest { id: u64, symbol: String, timeframe: String, horizon: String, candles: Vec<CandleWire> }` (wire field `candles`, no `closes`); `handle_request`/`handle_request_with_progress` unchanged in signature.

- [ ] **Step 1: Write the failing Rust tests** — in `rust-core/crates/sidecar/src/handlers.rs`'s `mod tests`, replace the `closes_seq`/`request` helpers and the five `handle_request` tests (`skips_algorithms_without_enough_lookback_instead_of_panicking`, `empty_closes_yields_well_formed_zeroed_response`, `sufficient_closes_runs_every_algorithm_applicable_at_that_lookback`, `handle_request_with_progress_brackets_each_algorithm_running_then_done_in_registry_order`, `widened_algo_result_carries_symbol_timeframe_horizon_and_rfc3339_timestamp`) with:

```rust
    fn request(id: u64, len: usize) -> ComputeRequest {
        ComputeRequest {
            id,
            symbol: "NSE:NEWLISTING".to_string(),
            timeframe: "day".to_string(),
            horizon: "positional".to_string(),
            candles: ohlcv_window(len),
        }
    }

    #[test]
    fn skips_algorithms_without_enough_lookback_instead_of_panicking() {
        // 15 bars: enough for every algorithm with required_lookback <= 15,
        // short of e.g. sma/ema's 20. Before the shared run_applicable gate,
        // calling sma/ema here underflowed `closes.len() - period` and panicked.
        let response = handle_request(request(42, 15));

        assert_eq!(response.id, 42);
        assert!(response.algo_results.iter().any(|r| r.algo_id == "rsi"));
        assert!(!response.algo_results.iter().any(|r| r.algo_id == "sma"));
    }

    #[test]
    fn empty_candles_yields_well_formed_zeroed_response() {
        // context_at cannot index an empty series, so an empty window returns
        // the same well-formed zeroed answer benchmark_compute already returns
        // -- the client blocks on `id` and is still owed exactly one line.
        let response = handle_request(ComputeRequest {
            id: 7,
            symbol: "NSE:NEWLISTING".to_string(),
            timeframe: "day".to_string(),
            horizon: "positional".to_string(),
            candles: Vec::new(),
        });

        assert_eq!(response.id, 7);
        assert!(response.algo_results.is_empty());
        assert_eq!(response.confluence.bullish_count, 0);
        assert_eq!(response.confluence.bearish_count, 0);
        assert_eq!(response.confluence.neutral_count, 0);
        assert!(!response.confluence.weighted_vote.is_nan());
    }

    #[test]
    fn live_compute_builds_a_full_ohlcv_context_not_a_closes_only_one() {
        // The whole point of P13§5: a volume/OHLCV-reading algorithm must be able
        // to produce a directional signal on the LIVE path. Under from_closes
        // (empty volumes) obv no-ops to Neutral no matter how much history exists.
        let response = handle_request(request(8, 60));

        let obv = response
            .algo_results
            .iter()
            .find(|r| r.algo_id == "obv")
            .expect("obv runs at 60 bars");
        assert_ne!(obv.direction, "Neutral");
    }

    #[test]
    fn live_compute_honors_the_requested_horizon_instead_of_hardcoding_positional() {
        let response = handle_request(ComputeRequest {
            id: 9,
            symbol: "NSE:NEWLISTING".to_string(),
            timeframe: "5minute".to_string(),
            horizon: "intraday".to_string(),
            candles: ohlcv_window(60),
        });

        let first = response.algo_results.first().expect("60 bars runs several algorithms");
        assert_eq!(first.horizon, "intraday");
        assert_eq!(first.timeframe, "5minute");
        assert!(response.algo_results.iter().all(|r| r.horizon == "intraday"));
    }

    #[test]
    fn live_compute_maps_the_ten_minute_timeframe_instead_of_falling_through_to_day() {
        let response = handle_request(ComputeRequest {
            id: 10,
            symbol: "NSE:NEWLISTING".to_string(),
            timeframe: "10minute".to_string(),
            horizon: "intraday".to_string(),
            candles: ohlcv_window(60),
        });

        let first = response.algo_results.first().expect("60 bars runs several algorithms");
        assert_eq!(first.timeframe, "10minute");
    }

    #[test]
    fn handle_request_with_progress_brackets_each_algorithm_running_then_done_in_registry_order() {
        let mut events: Vec<(String, bool)> = Vec::new();
        let response = handle_request_with_progress(request(1, 60), &mut |id, done| {
            events.push((id.to_string(), done))
        });
        let expected: Vec<(String, bool)> = response
            .algo_results
            .iter()
            .flat_map(|r| vec![(r.algo_id.clone(), false), (r.algo_id.clone(), true)])
            .collect();
        assert_eq!(events, expected);
    }

    #[test]
    fn widened_algo_result_carries_symbol_timeframe_horizon_and_rfc3339_timestamp() {
        let response = handle_request(request(3, 60));
        let first = response.algo_results.first().expect("60 bars runs several algorithms");

        assert_eq!(first.symbol, "NSE:NEWLISTING");
        assert_eq!(first.timeframe, "day");
        assert_eq!(first.horizon, "positional");
        assert!(first.computed_at.contains('T'));
    }
```

`ohlcv_window` is already defined in this `mod tests` (`handlers.rs:501-518`) but currently appears *after* these tests — move its definition up so it sits above `request`, or leave it where it is (Rust item order inside a module does not matter). No change to its body is needed.

In `rust-core/crates/sidecar/src/protocol.rs`'s own `mod tests` (this test lives there, not in `tests/protocol_test.rs`), replace:

```rust
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
```

with:

```rust
    #[test]
    fn parses_a_tagged_compute_request_carrying_full_ohlcv_and_a_horizon() {
        let line = r#"{"type":"compute","id":5,"symbol":"NSE:INFY","timeframe":"5minute","horizon":"intraday","candles":[{"ts":100,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":10}]}"#;
        match parse_request(line).unwrap() {
            SidecarRequest::Compute(request) => {
                assert_eq!(request.id, 5);
                assert_eq!(request.horizon, "intraday");
                assert_eq!(request.candles.len(), 1);
                assert_eq!(request.candles[0].volume, 10);
            }
            _ => panic!("expected a compute request"),
        }
    }
```

In `rust-core/crates/sidecar/tests/end_to_end_test.rs`, every `"type":"compute"` JSON literal must swap `"closes":[...]` for `"horizon":"positional","candles":[...]`. Locate each with `grep -n '"type":"compute"' rust-core/crates/sidecar/tests/end_to_end_test.rs` and rewrite each literal in place, e.g.:

```rust
    let compute = r#"{"type":"compute","id":2,"symbol":"NSE:INFY","timeframe":"day","closes":[1.0,2.0,3.0]}"#;
```

becomes:

```rust
    let compute = r#"{"type":"compute","id":2,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":100,"open":1.0,"high":1.0,"low":1.0,"close":1.0,"volume":10},{"ts":200,"open":2.0,"high":2.0,"low":2.0,"close":2.0,"volume":10},{"ts":300,"open":3.0,"high":3.0,"low":3.0,"close":3.0,"volume":10}]}"#;
```

Apply the same transformation to every other `"type":"compute"` literal in that file, preserving each one's existing `id`, `symbol`, and `timeframe`.

- [ ] **Step 2: Run the Rust tests to verify they fail**

Run (from `rust-core/`): `cargo test -p sidecar`
Expected: FAIL to compile — `ComputeRequest` has no `horizon`/`candles` fields and still has `closes`.

- [ ] **Step 3: Add `Timeframe::TenMinute`** — in `rust-core/crates/algo-core/src/algorithm.rs`, replace:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Timeframe {
    Minute,
    FiveMinute,
    FifteenMinute,
    Day,
}
```

with:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Timeframe {
    Minute,
    FiveMinute,
    TenMinute,
    FifteenMinute,
    Day,
}
```

In `rust-core/crates/algo-core/src/forecast/kronos_math.rs`, add the new arm to `timeframe_step`:

```rust
        Timeframe::TenMinute => Duration::minutes(10),
```

immediately after the `Timeframe::FiveMinute` arm.

- [ ] **Step 4: Verify algo-core compiles and its own suite is green**

Run: `cargo test -p algo-core`
Expected: PASS — the new variant is additive; no existing algorithm branches on `Timeframe` beyond the two exhaustive matches just handled.

- [ ] **Step 5: Reshape `ComputeRequest`** — in `rust-core/crates/sidecar/src/protocol.rs`, replace:

```rust
#[derive(Debug, Deserialize)]
pub struct ComputeRequest {
    pub id: u64,
    pub symbol: String,
    pub timeframe: String,
    pub closes: Vec<f64>,
}
```

with:

```rust
#[derive(Debug, Deserialize)]
pub struct ComputeRequest {
    pub id: u64,
    pub symbol: String,
    pub timeframe: String,
    /// "intraday" | "positional".
    pub horizon: String,
    /// Full OHLCV, ascending by ts; the last element is the frontier bar.
    pub candles: Vec<CandleWire>,
}
```

`CandleWire` is declared below `ComputeRequest` in this file; Rust item order is irrelevant, so no reordering is needed.

- [ ] **Step 6: Switch `handle_request_with_progress` to `context_at`** — in `rust-core/crates/sidecar/src/handlers.rs`, add the `10minute` arms to both timeframe mappers. Replace `timeframe_to_wire`:

```rust
fn timeframe_to_wire(timeframe: Timeframe) -> &'static str {
    match timeframe {
        Timeframe::Minute => "minute",
        Timeframe::FiveMinute => "5minute",
        Timeframe::TenMinute => "10minute",
        Timeframe::FifteenMinute => "15minute",
        Timeframe::Day => "day",
    }
}
```

Replace `parse_timeframe`:

```rust
fn parse_timeframe(s: &str) -> Timeframe {
    match s {
        "minute" => Timeframe::Minute,
        "5minute" => Timeframe::FiveMinute,
        "10minute" => Timeframe::TenMinute,
        "15minute" => Timeframe::FifteenMinute,
        _ => Timeframe::Day,
    }
}
```

Replace the whole body of `handle_request_with_progress`:

```rust
pub fn handle_request_with_progress(
    request: ComputeRequest,
    on_progress: &mut dyn FnMut(&str, bool),
) -> ComputeResponse {
    let candles: Vec<Candle> = request
        .candles
        .iter()
        .map(|c| Candle { ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })
        .collect();
    if candles.is_empty() {
        return empty_response(request.id);
    }
    let timeframe = parse_timeframe(&request.timeframe);
    let horizon = parse_horizon(&request.horizon);
    // Full OHLCV at the last bar, the same assembly handle_benchmark_compute
    // uses. Kronos and the other forecasters guard on opens/highs/lows/volumes
    // being populated, so a from_closes context sends them to their neutral
    // branch on every tick regardless of how much history exists (P13§1).
    let ctx = context_at(&candles, candles.len() - 1, &request.symbol, timeframe, horizon);

    // Route every compute() call through the one shared lookback gate
    // (algo_core::registry::run_applicable_with_progress) so the sidecar and
    // the backtest engine cannot drift on the insufficient-history contract.
    //
    // registry::all_for_binary() is the release-safe algo list (see its doc
    // comment in registry.rs); the sidecar must not use registry::all() alone.
    let algos = registry::all_for_binary();
    let outputs = run_applicable_with_progress(&algos, &ctx, on_progress);

    // Phase 1 uses equal weights for every algorithm; a later phase's
    // backtest engine supplies real rolling-hit-rate weights here instead.
    let weights: HashMap<&str, f64> = HashMap::new();
    let confluence = compute_confluence(&outputs, &weights);

    let algo_results = outputs.iter().map(algo_output_to_wire).collect();

    ComputeResponse { id: request.id, algo_results, confluence: confluence_to_wire(&confluence) }
}
```

Update the top `use crate::protocol::{...}` block to add `empty_response`:

```rust
use crate::protocol::{
    benchmark_empty_response, empty_response, AddWatchlistSymbolRequest, AlgoResultWire,
    AlgorithmWire, BenchmarkComputeRequest, BenchmarkComputeResponse, CandleWire, ComputeRequest,
    ComputeResponse, ConfluenceWire, EvaluateScanGateRequest, EvaluateScanGateStatelessRequest,
    LakeCandlesResponse, LakeSymbolWire, LakeSymbolsResponse, ListAlgorithmsRequest,
    ListAlgorithmsResponse, ListLakeSymbolsRequest, ListWatchlistRequest, PersistCandlesRequest,
    PersistCandlesResponse, ReadLakeCandlesRequest, RemoveWatchlistSymbolRequest, ScanGateResponse,
    WatchlistResponse,
};
```

`chrono::Utc` is no longer used by `handle_request_with_progress` (`context_at` derives `as_of` from the frontier bar's own ts). Check whether any other function in the file still uses it — `grep -n "Utc::" rust-core/crates/sidecar/src/handlers.rs` — and if not, delete the `use chrono::Utc;` line at `handlers.rs:16` so the build stays warning-free.

- [ ] **Step 7: Run the Rust tests to verify they pass**

Run: `cargo test -p sidecar && cargo test -p algo-core && cargo test -p backtest`
Expected: PASS across all three crates.

- [ ] **Step 8: Commit**

```bash
git add rust-core/crates/algo-core/src/algorithm.rs rust-core/crates/algo-core/src/forecast/kronos_math.rs rust-core/crates/sidecar/src/protocol.rs rust-core/crates/sidecar/src/handlers.rs rust-core/crates/sidecar/tests/end_to_end_test.rs
git commit -m "feat(sidecar): live compute takes full OHLCV at the requested horizon"
```

---

### Task 6: Electron — mirror the `compute` wire change through `SidecarSupervisor` and `assembleEnvelope`

The TypeScript half of Task 5. `SidecarSupervisor.compute` gains `horizon` and takes candles instead of closes; `assembleEnvelope` passes the `candles` it *already receives* from `fetchAndArchive` (which returns `{ candles, closes, persisted }` — it has been discarding the candles all along). Nothing changes about *where* the data comes from yet; that is Task 8. Keeping the source change separate is what lets this task land green with only mechanical call-site edits.

**Files:**
- Modify: `electron-app/src/main/services/sidecar/sidecarProtocol.ts:118-129`
- Modify: `electron-app/src/main/services/sidecar/sidecarSupervisor.ts:84-94`
- Modify: `electron-app/src/main/services/analysis/analysisEnvelope.ts:43-72`
- Modify: `electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts` (ten `supervisor.compute(...)` call sites)
- Modify: `electron-app/test/main/services/analysis/analysisEnvelope.test.ts`
- Modify: `electron-app/test/endToEnd.integration.test.ts:44`

**Interfaces:**
- Consumes: Task 5's Rust wire contract.
- Produces: `SidecarRequestWire`'s `compute` variant becomes `{ type: "compute"; id: number; symbol: string; timeframe: string; horizon: string; candles: CandleWire[] }`; `SidecarSupervisor.compute(symbol: string, timeframe: string, horizon: string, candles: CandleWire[], onRequestId?: (id: number) => void): Promise<ComputeResponseWire>`.

- [ ] **Step 1: Write the failing tests** — in `electron-app/test/main/services/analysis/analysisEnvelope.test.ts`, replace the first test's final assertion:

```ts
    expect(sidecar.compute).toHaveBeenCalledWith(
      "NSE:INFY",
      "day",
      "positional",
      [
        { ts: 1767205800, open: 100, high: 105, low: 99, close: 104, volume: 5000 },
        { ts: 1767292200, open: 104, high: 108, low: 103, close: 107, volume: 6000 },
      ],
      undefined,
    );
```

and append a new test at the end of the `describe("assembleEnvelope", ...)` block:

```ts
  it("sends intraday as the horizon whenever the request is not explicitly positional", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const sidecar = mockSidecar();

    await assembleEnvelope(
      { kite, sidecar: sidecar as never },
      {
        trigger: "reactive",
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        timeframe: "5minute",
        horizon_requested: "auto",
        intent_lens: "buying",
        from: "2026-01-01",
        to: "2026-01-03",
      },
    );

    expect((sidecar.compute as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2]).toBe("intraday");
  });
```

In `electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts`, replace every occurrence of `supervisor.compute("NSE:INFY", "day", [1, 2, 3])` with:

```ts
supervisor.compute("NSE:INFY", "day", "positional", [{ ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }])
```

and the one call at line 291 that passes an `onRequestId` callback with:

```ts
    supervisor.compute("NSE:INFY", "day", "positional", [{ ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }], (id) => {
```

(keep that call's existing callback body and closing punctuation exactly as they are).

In `electron-app/test/endToEnd.integration.test.ts`, replace line 44:

```ts
      const compute = await supervisor.compute("NSE:INFY", "day", "positional", archived.candles);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `electron-app/`): `npx vitest run test/main/services/analysis/analysisEnvelope.test.ts test/main/services/sidecar/sidecarSupervisor.test.ts`
Expected: FAIL — `compute` is still the 4-arg closes-based signature, so the third positional argument is an array, not `"positional"`.

- [ ] **Step 3: Update the wire type** — in `electron-app/src/main/services/sidecar/sidecarProtocol.ts`, replace the first member of the `SidecarRequestWire` union:

```ts
  | { type: "compute"; id: number; symbol: string; timeframe: string; horizon: string; candles: CandleWire[] }
```

- [ ] **Step 4: Update the supervisor** — in `electron-app/src/main/services/sidecar/sidecarSupervisor.ts`, replace the `compute` method:

```ts
  compute(
    symbol: string,
    timeframe: string,
    horizon: string,
    candles: CandleWire[],
    onRequestId?: (id: number) => void,
  ): Promise<ComputeResponseWire> {
    return this.send(
      { type: "compute", id: this.nextId, symbol, timeframe, horizon, candles },
      onRequestId,
    ) as Promise<ComputeResponseWire>;
  }
```

- [ ] **Step 5: Update `assembleEnvelope`** — in `electron-app/src/main/services/analysis/analysisEnvelope.ts`, replace the destructure of `fetchAndArchive`'s result and the `compute` call. Replace:

```ts
  const { closes } = await withTimeout(
```

with:

```ts
  const { candles } = await withTimeout(
```

and replace:

```ts
      deps.sidecar.compute(params.instrument.symbol, params.timeframe, closes, params.onComputeId),
```

with:

```ts
      deps.sidecar.compute(
        params.instrument.symbol,
        params.timeframe,
        // "auto" is an intake-side "you decide" marker, never a horizon the
        // registry's applicable_horizons() filter understands; everything that
        // is not explicitly positional is evaluated intraday.
        params.horizon_requested === "positional" ? "positional" : "intraday",
        candles,
        params.onComputeId,
      ),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/main/services/analysis test/main/services/sidecar test/main/scanScheduler.test.ts test/main/ipc/analysisBridge.test.ts && npm run typecheck`
Expected: PASS, clean typecheck. `scanScheduler` and `runAiAssistedRequest` need no edits — they call `assembleEnvelope`, whose own signature is unchanged.

- [ ] **Step 7: Commit**

```bash
git add electron-app/src/main/services/sidecar/sidecarProtocol.ts electron-app/src/main/services/sidecar/sidecarSupervisor.ts electron-app/src/main/services/analysis/analysisEnvelope.ts electron-app/test
git commit -m "feat(sidecar-supervisor): compute sends full OHLCV and an explicit horizon"
```

---

### Task 7: Warm-up — `topUpCandles` (P13§4.3)

The I/O half of the data layer: one sized bulk backfill when a `(symbol, interval)` partition is empty, a delta-only fetch from the lake's last stored timestamp thereafter. `write_sourced_candles` is already an idempotent read-merge-write keyed on `ts` (`candle_store.rs:145-155`), so a top-up may safely re-fetch the last stored bar — no off-by-one dance is needed, and the merge dedupes.

**Files:**
- Create: `electron-app/src/main/services/market/candleWarmup.ts`
- Create: `electron-app/test/main/services/market/candleWarmup.test.ts`

**Interfaces:**
- Consumes: `calendarDaysForBackfill` (Task 1); `parseKiteCandles` from `historicalDataArchive.ts` (existing export); `KiteClient.getHistoricalData`; `SidecarSupervisor.persistCandles` / `readLakeCandles`.
- Produces: `WARMUP_SOURCE = "kite"`; `interface TopUpDeps { kite: Pick<KiteClient, "getHistoricalData">; sidecar: Pick<SidecarSupervisor, "persistCandles" | "readLakeCandles"> }`; `interface TopUpParams { symbol: string; instrumentToken: string; interval: CandleInterval; requiredBars: number; now: Date }`; `interface TopUpResult { candles: CandleWire[]; fetched: number; backfilled: boolean }`; `topUpCandles(deps: TopUpDeps, params: TopUpParams): Promise<TopUpResult>`.

- [ ] **Step 1: Write the failing test** — create `electron-app/test/main/services/market/candleWarmup.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { topUpCandles, WARMUP_SOURCE } from "../../../../src/main/services/market/candleWarmup";
import type { CandleWire } from "../../../../src/main/services/sidecar/sidecarProtocol";

const NOW = new Date("2026-09-17T14:00:00+05:30");

function kiteReturning(rows: [string, number, number, number, number, number][]) {
  return { getHistoricalData: vi.fn().mockResolvedValue({ data: { candles: rows } }) };
}

function sidecarWithLake(existing: CandleWire[]) {
  const stored = [...existing];
  return {
    readLakeCandles: vi.fn(async () => ({ type: "lake_candles" as const, id: 1, candles: [...stored] })),
    persistCandles: vi.fn(async (_s: string, _t: string, candles: CandleWire[]) => {
      for (const candle of candles) {
        const at = stored.findIndex((c) => c.ts === candle.ts);
        if (at === -1) stored.push(candle);
        else stored[at] = candle;
      }
      stored.sort((a, b) => a.ts - b.ts);
      return { type: "persist_candles" as const, id: 1, written: candles.length };
    }),
  };
}

const params = {
  symbol: "NSE:INFY",
  instrumentToken: "408065",
  interval: "5minute" as const,
  requiredBars: 512,
  now: NOW,
};

describe("topUpCandles", () => {
  it("issues one sized bulk backfill when the lake partition is empty", async () => {
    const kite = kiteReturning([["2026-09-17T09:15:00+0530", 1, 2, 0.5, 1.5, 10]]);
    const sidecar = sidecarWithLake([]);

    const result = await topUpCandles({ kite, sidecar }, params);

    expect(kite.getHistoricalData).toHaveBeenCalledTimes(1);
    const call = kite.getHistoricalData.mock.calls[0][0] as { from: string; to: string; interval: string };
    expect(call.interval).toBe("5minute");
    // calendarDaysForBackfill("5minute", 512) === 15 -> 2026-09-02.
    expect(call.from).toBe("2026-09-02 14:00:00");
    expect(call.to).toBe("2026-09-17 14:00:00");
    expect(result.backfilled).toBe(true);
    expect(result.fetched).toBe(1);
  });

  it("fetches only the delta since the lake's last stored candle on a subsequent top-up", async () => {
    const lastTs = Math.floor(new Date("2026-09-17T13:30:00+05:30").getTime() / 1000);
    const kite = kiteReturning([["2026-09-17T13:35:00+0530", 1, 2, 0.5, 1.5, 10]]);
    const sidecar = sidecarWithLake([{ ts: lastTs, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);

    const result = await topUpCandles({ kite, sidecar }, params);

    const call = kite.getHistoricalData.mock.calls[0][0] as { from: string; to: string };
    expect(call.from).toBe("2026-09-17 13:30:00");
    expect(call.to).toBe("2026-09-17 14:00:00");
    expect(result.backfilled).toBe(false);
  });

  it("persists into the interval's own partition under the kite source", async () => {
    const kite = kiteReturning([["2026-09-17T09:15:00+0530", 1, 2, 0.5, 1.5, 10]]);
    const sidecar = sidecarWithLake([]);

    await topUpCandles({ kite, sidecar }, { ...params, interval: "15minute" });

    expect(sidecar.persistCandles).toHaveBeenCalledWith("NSE:INFY", "15minute", expect.any(Array), WARMUP_SOURCE);
    expect(sidecar.readLakeCandles).toHaveBeenCalledWith("NSE:INFY", "15minute", WARMUP_SOURCE);
  });

  it("returns the merged lake contents, not just what this call fetched", async () => {
    const oldTs = Math.floor(new Date("2026-09-17T09:15:00+05:30").getTime() / 1000);
    const kite = kiteReturning([["2026-09-17T13:35:00+0530", 1, 2, 0.5, 1.5, 10]]);
    const sidecar = sidecarWithLake([{ ts: oldTs, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);

    const result = await topUpCandles({ kite, sidecar }, params);

    expect(result.candles).toHaveLength(2);
    expect(result.candles[0].ts).toBe(oldTs);
  });

  it("skips the Kite call entirely when the lake is already current, instead of re-fetching a zero-width window", async () => {
    const lastTs = Math.floor(NOW.getTime() / 1000);
    const kite = kiteReturning([]);
    const sidecar = sidecarWithLake([{ ts: lastTs, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);

    const result = await topUpCandles({ kite, sidecar }, params);

    expect(kite.getHistoricalData).not.toHaveBeenCalled();
    expect(sidecar.persistCandles).not.toHaveBeenCalled();
    expect(result.fetched).toBe(0);
    expect(result.candles).toHaveLength(1);
  });

  it("propagates a persist failure instead of reporting a warm lake that was never written", async () => {
    const kite = kiteReturning([["2026-09-17T09:15:00+0530", 1, 2, 0.5, 1.5, 10]]);
    const sidecar = {
      readLakeCandles: vi.fn(async () => ({ type: "lake_candles" as const, id: 1, candles: [] })),
      persistCandles: vi.fn(async () => ({ type: "persist_candles" as const, id: 1, written: 0, error: "disk full" })),
    };

    await expect(topUpCandles({ kite, sidecar }, params)).rejects.toThrow(
      /warming NSE:INFY 5minute failed: disk full/,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/main/services/market/candleWarmup.test.ts`
Expected: FAIL — `Failed to resolve import ".../market/candleWarmup"`.

- [ ] **Step 3: Write the warm-up** — create `electron-app/src/main/services/market/candleWarmup.ts`:

```ts
import type { KiteClient } from "../kite/kiteClient";
import type { SidecarSupervisor } from "../sidecar/sidecarSupervisor";
import type { CandleWire } from "../sidecar/sidecarProtocol";
import { parseKiteCandles, type RawKiteCandle } from "../kite/historicalDataArchive";
import { calendarDaysForBackfill } from "./backfillSizing";
import type { CandleInterval } from "./candleInterval";

// The lake partition the live warm-up owns. Distinct from "bhavcopy", which the
// daily-bar ingestion path writes and this phase never touches.
export const WARMUP_SOURCE = "kite";

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface TopUpDeps {
  kite: Pick<KiteClient, "getHistoricalData">;
  sidecar: Pick<SidecarSupervisor, "persistCandles" | "readLakeCandles">;
}

export interface TopUpParams {
  symbol: string;
  instrumentToken: string;
  interval: CandleInterval;
  requiredBars: number;
  now: Date;
}

export interface TopUpResult {
  candles: CandleWire[];
  fetched: number;
  backfilled: boolean;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

// Kite's historical-data API expects IST date-time strings regardless of the
// host machine's timezone, so components are read off a UTC-shifted clone.
function formatIstDateTime(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return (
    `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())} ` +
    `${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}`
  );
}

function extractRawCandles(response: unknown): RawKiteCandle[] {
  const candles = (response as { data?: { candles?: unknown } })?.data?.candles;
  return Array.isArray(candles) ? (candles as RawKiteCandle[]) : [];
}

export async function topUpCandles(deps: TopUpDeps, params: TopUpParams): Promise<TopUpResult> {
  const existing = await deps.sidecar.readLakeCandles(params.symbol, params.interval, WARMUP_SOURCE);
  const lastTs = existing.candles.length === 0 ? null : existing.candles[existing.candles.length - 1].ts;
  const backfilled = lastTs === null;

  const from =
    lastTs === null
      ? new Date(params.now.getTime() - calendarDaysForBackfill(params.interval, params.requiredBars) * DAY_MS)
      : new Date(lastTs * 1000);

  // A zero- or negative-width window would make Kite either error or return the
  // same last bar forever; the lake is already current, so nothing to do.
  if (from.getTime() >= params.now.getTime()) {
    return { candles: existing.candles, fetched: 0, backfilled };
  }

  const response = await deps.kite.getHistoricalData({
    instrumentToken: params.instrumentToken,
    interval: params.interval,
    from: formatIstDateTime(from),
    to: formatIstDateTime(params.now),
  });
  const fetched = parseKiteCandles(extractRawCandles(response));

  if (fetched.length > 0) {
    // write_sourced_candles is a read-merge-write keyed on ts, so re-sending the
    // last stored bar is idempotent -- no from+1 arithmetic, no gap risk.
    const persisted = await deps.sidecar.persistCandles(params.symbol, params.interval, fetched, WARMUP_SOURCE);
    if (persisted.error != null) {
      throw new Error(`warming ${params.symbol} ${params.interval} failed: ${persisted.error}`);
    }
    if (persisted.written !== fetched.length) {
      throw new Error(
        `warming ${params.symbol} ${params.interval} failed: wrote ${persisted.written} of ${fetched.length} candles`,
      );
    }
  }

  const merged = await deps.sidecar.readLakeCandles(params.symbol, params.interval, WARMUP_SOURCE);
  return { candles: merged.candles, fetched: fetched.length, backfilled };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/main/services/market/candleWarmup.test.ts && npm run typecheck`
Expected: PASS — all six tests, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/market/candleWarmup.ts electron-app/test/main/services/market/candleWarmup.test.ts
git commit -m "feat(market): sized one-time backfill plus incremental candle top-up"
```

---

### Task 8: Live context assembly from the lake — `assembleWarmedEnvelope` (P13§4.4)

The Engine-Only path stops fetching a fresh Kite window per tick and instead tops up, then reads the required trailing window straight back out of the lake — the same full-OHLCV assembly the benchmark path already uses. A new sibling file rather than a branch inside `assembleEnvelope`: the AI-Assisted/positional path keeps its single straight line, and so does this one.

**Files:**
- Create: `electron-app/src/main/services/analysis/warmedEnvelope.ts`
- Create: `electron-app/test/main/services/analysis/warmedEnvelope.test.ts`

**Interfaces:**
- Consumes: `topUpCandles` / `TopUpDeps` (Task 7); `maxRequiredLookback` (Task 1); `SidecarSupervisor.listAlgorithms` / `compute` (Tasks 4, 6); `AnalysisEnvelope`, `IntentLens` from `./contracts`; `InstrumentSelection`, `TraceEmitter` (existing).
- Produces:
  ```ts
  interface WarmedEnvelopeDeps {
    kite: Pick<KiteClient, "getHistoricalData">;
    sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles" | "readLakeCandles" | "listAlgorithms">;
  }
  interface WarmedEnvelopeParams {
    trigger: "reactive" | "proactive_scan";
    instrument: InstrumentSelection;
    interval: CandleInterval;
    intent_lens: IntentLens;
    now: Date;
    onComputeId?: (id: number) => void;
    onTrace?: TraceEmitter;
  }
  function requiredBarsFor(sidecar: Pick<SidecarSupervisor, "listAlgorithms">): Promise<number>;
  function assembleWarmedEnvelope(deps, params): Promise<AnalysisEnvelope>;
  ```

- [ ] **Step 1: Write the failing test** — create `electron-app/test/main/services/analysis/warmedEnvelope.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  assembleWarmedEnvelope,
  requiredBarsFor,
} from "../../../../src/main/services/analysis/warmedEnvelope";
import { computeResponse } from "../../../fixtures/sidecarFixtures";
import type { CandleWire } from "../../../../src/main/services/sidecar/sidecarProtocol";

const NOW = new Date("2026-09-17T14:00:00+05:30");
const INSTRUMENT = { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" };

function lakeOf(count: number): CandleWire[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: 1_700_000_000 + i * 300,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 1_000 + i,
  }));
}

function depsWith(lake: CandleWire[], algorithms = [{ id: "sma", cost: "fast", required_lookback: 20 }, { id: "kronos", cost: "slow", required_lookback: 256 }]) {
  return {
    kite: { getHistoricalData: vi.fn().mockResolvedValue({ data: { candles: [] } }) },
    sidecar: {
      listAlgorithms: vi.fn().mockResolvedValue({ type: "algorithms", id: 1, algorithms }),
      readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: lake }),
      persistCandles: vi.fn().mockResolvedValue({ type: "persist_candles", id: 1, written: 0 }),
      compute: vi.fn().mockResolvedValue(computeResponse()),
    },
  };
}

describe("requiredBarsFor", () => {
  it("takes the maximum required_lookback across every linked algorithm, fast and slow alike", async () => {
    const sidecar = {
      listAlgorithms: vi.fn().mockResolvedValue({
        type: "algorithms",
        id: 1,
        algorithms: [
          { id: "sma", cost: "fast", required_lookback: 20 },
          { id: "ttm", cost: "slow", required_lookback: 512 },
          { id: "ichimoku", cost: "fast", required_lookback: 52 },
        ],
      }),
    };
    expect(await requiredBarsFor(sidecar as never)).toBe(512);
  });
});

describe("assembleWarmedEnvelope", () => {
  it("sends the lake's trailing required-bars window as candles, not a fresh Kite closes array", async () => {
    const deps = depsWith(lakeOf(400));

    await assembleWarmedEnvelope(deps as never, {
      trigger: "reactive",
      instrument: INSTRUMENT,
      interval: "5minute",
      intent_lens: "buying",
      now: NOW,
    });

    const [symbol, timeframe, horizon, candles] = deps.sidecar.compute.mock.calls[0];
    expect(symbol).toBe("NSE:INFY");
    expect(timeframe).toBe("5minute");
    expect(horizon).toBe("intraday");
    // requiredBars is 256 here, so the trailing 256 of the 400 stored bars.
    expect(candles).toHaveLength(256);
    expect((candles as CandleWire[])[255].ts).toBe(1_700_000_000 + 399 * 300);
    expect((candles as CandleWire[])[0].volume).toBe(1_000 + 144);
  });

  it("sends everything the lake has when it holds fewer bars than required, rather than an empty window", async () => {
    const deps = depsWith(lakeOf(40));

    await assembleWarmedEnvelope(deps as never, {
      trigger: "reactive",
      instrument: INSTRUMENT,
      interval: "5minute",
      intent_lens: "buying",
      now: NOW,
    });

    expect(deps.sidecar.compute.mock.calls[0][3]).toHaveLength(40);
  });

  it("tops up before reading, so a session reopen never computes against a stale lake", async () => {
    const deps = depsWith(lakeOf(400));

    await assembleWarmedEnvelope(deps as never, {
      trigger: "reactive",
      instrument: INSTRUMENT,
      interval: "5minute",
      intent_lens: "buying",
      now: NOW,
    });

    expect(deps.kite.getHistoricalData).toHaveBeenCalled();
    const kiteOrder = deps.kite.getHistoricalData.mock.invocationCallOrder[0];
    const computeOrder = deps.sidecar.compute.mock.invocationCallOrder[0];
    expect(kiteOrder).toBeLessThan(computeOrder);
  });

  it("reports the interval as the envelope's timeframe and intraday as its requested horizon", async () => {
    const deps = depsWith(lakeOf(400));

    const envelope = await assembleWarmedEnvelope(deps as never, {
      trigger: "reactive",
      instrument: INSTRUMENT,
      interval: "15minute",
      intent_lens: "selling",
      now: NOW,
    });

    expect(envelope.horizon_requested).toBe("intraday");
    expect(envelope.intent_lens).toBe("selling");
    expect(envelope.instrument.kite_token_asof).toBe("408065");
    expect(envelope.algo_results[0].algo_id).toBe("rsi");
    expect(envelope.overlays).toEqual({});
  });

  it("emits a sidecar error trace and rethrows when compute rejects", async () => {
    const deps = depsWith(lakeOf(400));
    deps.sidecar.compute = vi.fn().mockRejectedValue(new Error("sidecar is not running"));
    const traced: Array<{ source: string; kind: string; detail?: string }> = [];

    await expect(
      assembleWarmedEnvelope(deps as never, {
        trigger: "reactive",
        instrument: INSTRUMENT,
        interval: "5minute",
        intent_lens: "buying",
        now: NOW,
        onTrace: (e) => traced.push(e),
      }),
    ).rejects.toThrow(/sidecar is not running/);
    expect(traced).toEqual([{ source: "sidecar", kind: "error", detail: "sidecar is not running" }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/main/services/analysis/warmedEnvelope.test.ts`
Expected: FAIL — `Failed to resolve import ".../analysis/warmedEnvelope"`.

- [ ] **Step 3: Write the warmed envelope** — create `electron-app/src/main/services/analysis/warmedEnvelope.ts`:

```ts
import type { KiteClient } from "../kite/kiteClient";
import type { SidecarSupervisor } from "../sidecar/sidecarSupervisor";
import type { AnalysisEnvelope, IntentLens } from "./contracts";
import type { InstrumentSelection } from "./analysisEnvelope";
import type { TraceEmitter } from "../../ipc/rendererApi";
import type { CandleInterval } from "../market/candleInterval";
import { maxRequiredLookback } from "../market/backfillSizing";
import { topUpCandles } from "../market/candleWarmup";
import { PERSONA_TIMEOUTS_MS } from "../claude/claudeCliProvider";
import { KITE_FETCH_TIMEOUT_MS, withTimeout } from "./analysisEnvelope";

export interface WarmedEnvelopeDeps {
  kite: Pick<KiteClient, "getHistoricalData">;
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles" | "readLakeCandles" | "listAlgorithms">;
}

export interface WarmedEnvelopeParams {
  trigger: "reactive" | "proactive_scan";
  instrument: InstrumentSelection;
  interval: CandleInterval;
  intent_lens: IntentLens;
  now: Date;
  onComputeId?: (id: number) => void;
  onTrace?: TraceEmitter;
}

// Sized against EVERY linked algorithm, not just the forecasters: a build with no
// forecaster feature compiled in would otherwise report 0 and starve the fast
// indicators that do work (plan open item (iii)).
export async function requiredBarsFor(sidecar: Pick<SidecarSupervisor, "listAlgorithms">): Promise<number> {
  const { algorithms } = await sidecar.listAlgorithms();
  return maxRequiredLookback(algorithms.map((a) => ({ requiredLookback: a.required_lookback })));
}

export async function assembleWarmedEnvelope(
  deps: WarmedEnvelopeDeps,
  params: WarmedEnvelopeParams,
): Promise<AnalysisEnvelope> {
  const requiredBars = await requiredBarsFor(deps.sidecar);
  const { candles } = await withTimeout(
    topUpCandles(
      { kite: deps.kite, sidecar: deps.sidecar },
      {
        symbol: params.instrument.symbol,
        instrumentToken: params.instrument.instrumentToken,
        interval: params.interval,
        requiredBars,
        now: params.now,
      },
    ),
    KITE_FETCH_TIMEOUT_MS,
    "kite fetch",
  );

  const window = candles.slice(Math.max(0, candles.length - requiredBars));

  let compute;
  try {
    compute = await withTimeout(
      deps.sidecar.compute(params.instrument.symbol, params.interval, "intraday", window, params.onComputeId),
      PERSONA_TIMEOUTS_MS.sidecar,
      "sidecar compute",
    );
  } catch (error) {
    params.onTrace?.({ source: "sidecar", kind: "error", detail: (error as Error).message });
    throw error;
  }

  return {
    trigger: params.trigger,
    instrument: {
      symbol: params.instrument.symbol,
      exchange: params.instrument.exchange,
      segment: params.instrument.segment,
      kite_token_asof: params.instrument.instrumentToken,
    },
    horizon_requested: "intraday",
    intent_lens: params.intent_lens,
    algo_results: compute.algo_results,
    confluence: compute.confluence,
    overlays: {},
  };
}
```

- [ ] **Step 4: Export `withTimeout` from `analysisEnvelope.ts`** — it is currently a module-private helper. In `electron-app/src/main/services/analysis/analysisEnvelope.ts`, replace:

```ts
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
```

with:

```ts
export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/main/services/analysis && npm run typecheck`
Expected: PASS — all six new tests plus every pre-existing `analysisEnvelope.test.ts` test, clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/services/analysis/warmedEnvelope.ts electron-app/src/main/services/analysis/analysisEnvelope.ts electron-app/test/main/services/analysis/warmedEnvelope.test.ts
git commit -m "feat(analysis): assemble live context from the lake's warmed trailing window"
```

---

### Task 9: Deterministic readiness gate — `checkEngineOnlyReadiness` (P13§6)

Kite connectivity, then data readiness, then market hours; first failure wins and the rest never run. All I/O comes in through injected deps so every branch is a plain unit test with a fixed `now`.

**Files:**
- Create: `electron-app/src/main/services/market/readinessGate.ts`
- Create: `electron-app/test/main/services/market/readinessGate.test.ts`

**Interfaces:**
- Consumes: `KiteSessionStatus` (`rendererApi.ts:14`); `topUpCandles`/`TopUpDeps` (Task 7); `requiredBarsFor` (Task 8); `isWithinSessionHours`, `nextSessionOpen`, `isHolidayCalendarCovered` (Task 2).
- Produces:
  ```ts
  type ReadinessResult =
    | { ok: true }
    | { ok: false; reason: "kite_not_connected" }
    | { ok: false; reason: "insufficient_history"; have: number; need: number }
    | { ok: false; reason: "market_closed"; nextOpenAt: number };

  interface ReadinessDeps {
    kiteStatus: () => KiteSessionStatus;
    kite: Pick<KiteClient, "getHistoricalData"> | null;
    sidecar: Pick<SidecarSupervisor, "persistCandles" | "readLakeCandles" | "listAlgorithms">;
  }
  interface ReadinessParams { symbol: string; instrumentToken: string; interval: CandleInterval; now: Date }
  function checkEngineOnlyReadiness(deps: ReadinessDeps, params: ReadinessParams): Promise<ReadinessResult>;
  ```

- [ ] **Step 1: Write the failing test** — create `electron-app/test/main/services/market/readinessGate.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkEngineOnlyReadiness } from "../../../../src/main/services/market/readinessGate";
import type { CandleWire } from "../../../../src/main/services/sidecar/sidecarProtocol";

const IN_SESSION = new Date("2026-09-17T11:00:00+05:30"); // Thursday, mid-session
const PRE_OPEN = new Date("2026-09-17T08:00:00+05:30");
const POST_CLOSE = new Date("2026-09-17T16:00:00+05:30");
const WEEKEND = new Date("2026-09-19T11:00:00+05:30"); // Saturday
const HOLIDAY = new Date("2026-01-26T11:00:00+05:30"); // Republic Day, a Monday

const PARAMS = { symbol: "NSE:INFY", instrumentToken: "408065", interval: "5minute" as const, now: IN_SESSION };

function lakeOf(count: number): CandleWire[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: 1_700_000_000 + i * 300,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
  }));
}

function deps(overrides: { status?: "authenticated" | "needsLogin" | "unknown"; lake?: CandleWire[] } = {}) {
  const lake = overrides.lake ?? lakeOf(300);
  return {
    kiteStatus: vi.fn(() => overrides.status ?? "authenticated"),
    kite: { getHistoricalData: vi.fn().mockResolvedValue({ data: { candles: [] } }) },
    sidecar: {
      listAlgorithms: vi.fn().mockResolvedValue({
        type: "algorithms",
        id: 1,
        algorithms: [{ id: "kronos", cost: "slow", required_lookback: 256 }],
      }),
      readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: lake }),
      persistCandles: vi.fn().mockResolvedValue({ type: "persist_candles", id: 1, written: 0 }),
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("checkEngineOnlyReadiness", () => {
  it("passes all three checks silently when Kite is up, the lake is warm, and the session is live", async () => {
    expect(await checkEngineOnlyReadiness(deps() as never, PARAMS)).toEqual({ ok: true });
  });

  it("fails with kite_not_connected and short-circuits before data or time are evaluated", async () => {
    const d = deps({ status: "needsLogin" });

    expect(await checkEngineOnlyReadiness(d as never, PARAMS)).toEqual({ ok: false, reason: "kite_not_connected" });
    expect(d.sidecar.readLakeCandles).not.toHaveBeenCalled();
    expect(d.sidecar.listAlgorithms).not.toHaveBeenCalled();
    expect(d.kite.getHistoricalData).not.toHaveBeenCalled();
  });

  it("treats an unknown Kite session as not connected", async () => {
    expect(await checkEngineOnlyReadiness(deps({ status: "unknown" }) as never, PARAMS)).toEqual({
      ok: false,
      reason: "kite_not_connected",
    });
  });

  it("fails with insufficient_history carrying exact have/need counts, and never reaches the market-hours check", async () => {
    // Deliberately in-session, so a market_closed answer would prove the order wrong.
    const result = await checkEngineOnlyReadiness(deps({ lake: lakeOf(180) }) as never, PARAMS);
    expect(result).toEqual({ ok: false, reason: "insufficient_history", have: 180, need: 256 });
  });

  it("fails with market_closed and the next open before the market opens", async () => {
    const result = await checkEngineOnlyReadiness(deps() as never, { ...PARAMS, now: PRE_OPEN });
    expect(result).toEqual({
      ok: false,
      reason: "market_closed",
      nextOpenAt: new Date("2026-09-17T09:15:00+05:30").getTime() / 1000,
    });
  });

  it("fails with market_closed after the close, pointing at the next trading day", async () => {
    const result = await checkEngineOnlyReadiness(deps() as never, { ...PARAMS, now: POST_CLOSE });
    expect(result).toEqual({
      ok: false,
      reason: "market_closed",
      nextOpenAt: new Date("2026-09-18T09:15:00+05:30").getTime() / 1000,
    });
  });

  it("fails with market_closed on a weekend, pointing at Monday", async () => {
    const result = await checkEngineOnlyReadiness(deps() as never, { ...PARAMS, now: WEEKEND });
    expect(result).toEqual({
      ok: false,
      reason: "market_closed",
      nextOpenAt: new Date("2026-09-21T09:15:00+05:30").getTime() / 1000,
    });
  });

  it("fails with market_closed on a bundled-calendar holiday", async () => {
    const result = await checkEngineOnlyReadiness(deps() as never, { ...PARAMS, now: HOLIDAY });
    expect(result).toEqual({
      ok: false,
      reason: "market_closed",
      nextOpenAt: new Date("2026-01-27T09:15:00+05:30").getTime() / 1000,
    });
  });

  it("warns once about a year the bundled holiday calendar does not cover instead of silently trusting it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await checkEngineOnlyReadiness(deps() as never, { ...PARAMS, now: new Date("2030-06-18T11:00:00+05:30") });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("2030"));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/main/services/market/readinessGate.test.ts`
Expected: FAIL — `Failed to resolve import ".../market/readinessGate"`.

- [ ] **Step 3: Write the gate** — create `electron-app/src/main/services/market/readinessGate.ts`:

```ts
import type { KiteClient } from "../kite/kiteClient";
import type { SidecarSupervisor } from "../sidecar/sidecarSupervisor";
import type { KiteSessionStatus } from "../../ipc/rendererApi";
import { requiredBarsFor } from "../analysis/warmedEnvelope";
import { topUpCandles } from "./candleWarmup";
import { isHolidayCalendarCovered, isWithinSessionHours, nextSessionOpen } from "./tradingCalendar";
import { NSE_HOLIDAY_CALENDAR_SOURCE } from "./nseHolidays";
import type { CandleInterval } from "./candleInterval";

export type ReadinessResult =
  | { ok: true }
  | { ok: false; reason: "kite_not_connected" }
  | { ok: false; reason: "insufficient_history"; have: number; need: number }
  | { ok: false; reason: "market_closed"; nextOpenAt: number };

export interface ReadinessDeps {
  kiteStatus: () => KiteSessionStatus;
  kite: Pick<KiteClient, "getHistoricalData"> | null;
  sidecar: Pick<SidecarSupervisor, "persistCandles" | "readLakeCandles" | "listAlgorithms">;
}

export interface ReadinessParams {
  symbol: string;
  instrumentToken: string;
  interval: CandleInterval;
  now: Date;
}

const warnedYears = new Set<number>();

function warnOnceAboutCalendarCoverage(year: number): void {
  if (isHolidayCalendarCovered(year) || warnedYears.has(year)) return;
  warnedYears.add(year);
  console.warn(
    `market: no NSE holiday calendar bundled for ${year}; falling back to weekends-only. ` +
      `Refresh nseHolidays.ts from ${NSE_HOLIDAY_CALENDAR_SOURCE}.`,
  );
}

export async function checkEngineOnlyReadiness(
  deps: ReadinessDeps,
  params: ReadinessParams,
): Promise<ReadinessResult> {
  // Fixed order, short-circuiting on the first failure: exactly one message is
  // ever produced, never a checklist (P13§2 locked decision 3). Nothing else
  // runs without Kite -- there would be no way to fetch anything to check.
  if (deps.kiteStatus() !== "authenticated" || deps.kite === null) {
    return { ok: false, reason: "kite_not_connected" };
  }

  const need = await requiredBarsFor(deps.sidecar);
  const { candles } = await topUpCandles(
    { kite: deps.kite, sidecar: deps.sidecar },
    {
      symbol: params.symbol,
      instrumentToken: params.instrumentToken,
      interval: params.interval,
      requiredBars: need,
      now: params.now,
    },
  );
  if (candles.length < need) {
    return { ok: false, reason: "insufficient_history", have: candles.length, need };
  }

  warnOnceAboutCalendarCoverage(params.now.getFullYear());
  if (!isWithinSessionHours(params.now)) {
    return { ok: false, reason: "market_closed", nextOpenAt: nextSessionOpen(params.now) };
  }

  return { ok: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/main/services/market && npm run typecheck`
Expected: PASS — all nine gate tests plus Tasks 1/2/7's suites, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/market/readinessGate.ts electron-app/test/main/services/market/readinessGate.test.ts
git commit -m "feat(market): deterministic Kite/data/market-hours readiness gate"
```

---

### Task 10: IPC contract — interval-based `analysis:run` and a `analysis:checkReadiness` channel

`AnalysisRunParams`'s engine_only variant swaps `horizon: Horizon` for `interval: CandleInterval`, `runAnalysisRequest` runs the gate before computing and returns a blocked result instead of an `AnalysisResult` when it fails, and a new `analysis:checkReadiness` channel lets the renderer re-evaluate the gate on session reopen without also running an analysis.

**Files:**
- Modify: `electron-app/src/main/ipc/rendererApi.ts`
- Modify: `electron-app/src/main/ipc/analysisBridge.ts`
- Modify: `electron-app/src/main/bootstrap.ts:236-245`
- Modify: `electron-app/test/main/ipc/analysisBridge.test.ts`
- Modify: `electron-app/test/main/ipc/rendererApi.test.ts`
- Modify: `electron-app/test/renderer/testBridge.ts`

**Interfaces:**
- Consumes: `checkEngineOnlyReadiness`/`ReadinessResult` (Task 9); `assembleWarmedEnvelope` (Task 8).
- Produces:
  ```ts
  // rendererApi.ts
  export type { CandleInterval } from "../services/market/candleInterval";
  export type { ReadinessResult } from "../services/market/readinessGate";

  type AnalysisRunParams =
    | { mode: "engine_only"; sessionId: string; instrument: InstrumentSelection; interval: CandleInterval; intent_lens: IntentLens }
    | { mode: "ai_assisted"; sessionId: string; query: string; intent_lens: IntentLens; requestId: string };

  type AnalysisResult =
    | { mode: "engine_only"; instrument: InstrumentRef; interval: CandleInterval; response: DeterministicResponse; algo_results: AlgoResultWire[] }
    | { mode: "engine_only_blocked"; instrument: InstrumentRef; interval: CandleInterval; readiness: Extract<ReadinessResult, { ok: false }> }
    | { mode: "ai_assisted"; /* unchanged */ };

  interface ReadinessCheckParams { instrument: InstrumentSelection; interval: CandleInterval }
  // RendererApi gains: checkReadiness(params: ReadinessCheckParams): Promise<ReadinessResult>
  ```

- [ ] **Step 1: Write the failing test** — in `electron-app/test/main/ipc/analysisBridge.test.ts`, replace every engine_only `AnalysisRunParams` literal's `horizon: "positional"` with `interval: "5minute"` (three occurrences, at roughly lines 106, 119, and inside the `describeEngineOnlyQuery` test around line 18), and append a new `describe` block at the end of the file:

```ts
describe("runAnalysisRequest readiness gate", () => {
  const INSTRUMENT = { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" };
  const PARAMS = {
    mode: "engine_only" as const,
    sessionId: "sess-1",
    instrument: INSTRUMENT,
    interval: "5minute" as const,
    intent_lens: "buying" as const,
  };

  function gateDeps(readiness: import("../../../src/main/services/market/readinessGate").ReadinessResult) {
    return {
      kite: { getHistoricalData: vi.fn() },
      sidecar: {
        compute: vi.fn(),
        persistCandles: vi.fn(),
        readLakeCandles: vi.fn(),
        listAlgorithms: vi.fn(),
      },
      history: { appendMessage: vi.fn() },
      checkReadiness: vi.fn().mockResolvedValue(readiness),
      assembleEnvelope: vi.fn(),
      now: () => new Date("2026-09-17T11:00:00+05:30"),
    };
  }

  it("returns a blocked result and computes nothing when the gate fails", async () => {
    const deps = gateDeps({ ok: false, reason: "insufficient_history", have: 180, need: 256 });

    const result = await runAnalysisRequest(deps as never, PARAMS);

    expect(result).toEqual({
      mode: "engine_only_blocked",
      instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
      interval: "5minute",
      readiness: { ok: false, reason: "insufficient_history", have: 180, need: 256 },
    });
    expect(deps.assembleEnvelope).not.toHaveBeenCalled();
  });

  it("persists the blocked result as the session's assistant turn so a reopen can replay it", async () => {
    const deps = gateDeps({ ok: false, reason: "kite_not_connected" });

    await runAnalysisRequest(deps as never, PARAMS);

    const assistant = deps.history.appendMessage.mock.calls.find((c) => c[0].role === "assistant");
    expect(assistant).toBeTruthy();
    expect(assistant![0].structuredPayload.mode).toBe("engine_only_blocked");
  });

  it("runs the warmed envelope and returns an ordinary engine_only result when the gate passes", async () => {
    const deps = gateDeps({ ok: true });
    deps.assembleEnvelope = vi.fn().mockResolvedValue({
      trigger: "reactive",
      instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
      horizon_requested: "intraday",
      intent_lens: "buying",
      algo_results: [],
      confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
      overlays: {},
    });

    const result = await runAnalysisRequest(deps as never, PARAMS);

    expect(result.mode).toBe("engine_only");
    expect((result as { interval: string }).interval).toBe("5minute");
    expect(deps.assembleEnvelope).toHaveBeenCalledTimes(1);
  });
});
```

In `electron-app/test/main/ipc/rendererApi.test.ts`, add `"checkReadiness"` to the expected-method-name list around line 13, and append:

```ts
  it("routes checkReadiness through analysis:checkReadiness", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const params = {
      instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
      interval: "5minute" as const,
    };
    expect(await buildRendererApi(invoke, vi.fn()).checkReadiness(params)).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("analysis:checkReadiness", params);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/main/ipc/analysisBridge.test.ts test/main/ipc/rendererApi.test.ts`
Expected: FAIL — `runAnalysisRequest`'s deps take no `checkReadiness`/`assembleEnvelope`, `AnalysisRunParams` still requires `horizon`, and `checkReadiness` is not on `RendererApi`.

- [ ] **Step 3: Update the renderer-facing types** — in `electron-app/src/main/ipc/rendererApi.ts`, add these re-exports immediately after the existing `export type { InstrumentSelection } ...` line:

```ts
export type { CandleInterval } from "../services/market/candleInterval";
import type { CandleInterval } from "../services/market/candleInterval";
export type { ReadinessResult } from "../services/market/readinessGate";
import type { ReadinessResult } from "../services/market/readinessGate";
```

Replace `AnalysisRunParams`:

```ts
export type AnalysisRunParams =
  | { mode: "engine_only"; sessionId: string; instrument: InstrumentSelection; interval: CandleInterval; intent_lens: IntentLens }
  | { mode: "ai_assisted"; sessionId: string; query: string; intent_lens: IntentLens; requestId: string };
```

Replace `AnalysisResult`:

```ts
export type AnalysisResult =
  | {
      mode: "engine_only";
      instrument: InstrumentRef;
      interval: CandleInterval;
      response: DeterministicResponse;
      algo_results: AlgoResultWire[];
    }
  | {
      mode: "engine_only_blocked";
      instrument: InstrumentRef;
      interval: CandleInterval;
      readiness: Extract<ReadinessResult, { ok: false }>;
    }
  | {
      mode: "ai_assisted";
      instrument: InstrumentRef;
      horizon: Horizon;
      intent_lens: IntentLens;
      verdict: Verdict;
      narrative: string;
      algo_results: AlgoResultWire[];
      confluence: ConfluenceWire;
    };

export interface ReadinessCheckParams {
  instrument: InstrumentSelection;
  interval: CandleInterval;
}
```

Add to the `RendererApi` interface, immediately after `runAnalysis`:

```ts
  checkReadiness(params: ReadinessCheckParams): Promise<ReadinessResult>;
```

and to `buildRendererApi`'s returned object, immediately after the `runAnalysis` line:

```ts
    checkReadiness: (params) => invoke("analysis:checkReadiness", params) as Promise<ReadinessResult>,
```

- [ ] **Step 4: Rewire the analysis bridge** — in `electron-app/src/main/ipc/analysisBridge.ts`, replace the `RunAnalysisDeps` interface, `describeEngineOnlyQuery`, and `runAnalysisRequest`:

```ts
export interface RunAnalysisDeps {
  kite: KiteClient;
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles" | "readLakeCandles" | "listAlgorithms">;
  history: Pick<HistoryStore, "appendMessage">;
  checkReadiness: typeof checkEngineOnlyReadiness;
  assembleEnvelope: typeof assembleWarmedEnvelope;
  kiteStatus: () => KiteSessionStatus;
  now?: () => Date;
}

export function describeEngineOnlyQuery(params: Extract<AnalysisRunParams, { mode: "engine_only" }>): string {
  return `${params.instrument.symbol} · ${params.interval} · ${params.intent_lens}`;
}

export async function runAnalysisRequest(
  deps: RunAnalysisDeps,
  params: Extract<AnalysisRunParams, { mode: "engine_only" }>,
): Promise<AnalysisResult> {
  const now = deps.now?.() ?? new Date();
  deps.history.appendMessage({
    sessionId: params.sessionId,
    role: "user",
    renderedText: describeEngineOnlyQuery(params),
    structuredPayload: params,
  });

  const instrumentRef = {
    symbol: params.instrument.symbol,
    exchange: params.instrument.exchange,
    segment: params.instrument.segment,
    kite_token_asof: params.instrument.instrumentToken,
  };

  const readiness = await deps.checkReadiness(
    { kiteStatus: deps.kiteStatus, kite: deps.kite, sidecar: deps.sidecar },
    {
      symbol: params.instrument.symbol,
      instrumentToken: params.instrument.instrumentToken,
      interval: params.interval,
      now,
    },
  );
  if (!readiness.ok) {
    const blocked: AnalysisResult = {
      mode: "engine_only_blocked",
      instrument: instrumentRef,
      interval: params.interval,
      readiness,
    };
    // Persisted like any other assistant turn, so reopening the session replays
    // what blocked it before the gate re-runs against right now (P13§7).
    deps.history.appendMessage({
      sessionId: params.sessionId,
      role: "assistant",
      renderedText: describeReadiness(readiness),
      structuredPayload: blocked,
    });
    return blocked;
  }

  const envelope = await deps.assembleEnvelope(
    { kite: deps.kite, sidecar: deps.sidecar },
    {
      trigger: "reactive",
      instrument: params.instrument,
      interval: params.interval,
      intent_lens: params.intent_lens,
      now,
    },
  );
  const response = generateDeterministicResponse(envelope);
  const result: AnalysisResult = {
    mode: "engine_only",
    instrument: envelope.instrument,
    interval: params.interval,
    response,
    algo_results: envelope.algo_results,
  };
  // If assembleEnvelope throws, this second write never runs — the user
  // message is left orphaned with no assistant reply, matching ordinary
  // chat-app behavior for a failed turn rather than retracting what was
  // actually asked (P5c§7.2).
  deps.history.appendMessage({
    sessionId: params.sessionId,
    role: "assistant",
    renderedText: response.text,
    structuredPayload: result,
  });
  return result;
}
```

Add `describeReadiness` immediately above `runAnalysisRequest`:

```ts
export function describeReadiness(readiness: Extract<ReadinessResult, { ok: false }>): string {
  switch (readiness.reason) {
    case "kite_not_connected":
      return "Connect your Kite account to fetch live candles.";
    case "insufficient_history":
      return `Warming up history: ${readiness.have} of ${readiness.need} candles so far.`;
    case "market_closed":
      return `NSE is closed. Trading resumes ${new Date(readiness.nextOpenAt * 1000).toISOString()}.`;
  }
}
```

Update the top imports of `analysisBridge.ts` — remove the now-unused `horizonToFetchParams` *value* import from `runAnalysisRequest`'s path (the re-export at line 15 and `runAiAssistedRequest`'s use at line 109 both stay), and add:

```ts
import { assembleWarmedEnvelope } from "../services/analysis/warmedEnvelope";
import { checkEngineOnlyReadiness } from "../services/market/readinessGate";
import type { ReadinessResult, ReadinessCheckParams, KiteSessionStatus } from "./rendererApi";
```

Replace `AnalysisBridgeDeps` and `registerAnalysisBridge`:

```ts
export interface AnalysisBridgeDeps {
  ipcMain: Pick<IpcMain, "handle">;
  login: () => Promise<LoginResult>;
  getSession: () => KiteSession | null;
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles" | "readLakeCandles" | "listAlgorithms" | "on" | "off">;
  provider: AiAssistedProvider;
  history: Pick<HistoryStore, "appendMessage" | "getClaudeSessionId" | "setClaudeSessionId">;
  sendTrace: (event: TraceEvent) => void;
  markNeedsLogin: () => void;
  kiteStatus: () => KiteSessionStatus;
  now?: () => Date;
}

export function registerAnalysisBridge(deps: AnalysisBridgeDeps): void {
  deps.ipcMain.handle("kite:login", () => deps.login());
  deps.ipcMain.handle("kite:searchInstruments", (_event, args: { query: string }) =>
    guardSessionExpiry(deps.markNeedsLogin, requireSession(deps.getSession).kite.searchInstruments(args.query)),
  );
  deps.ipcMain.handle("analysis:checkReadiness", (_event, args: ReadinessCheckParams): Promise<ReadinessResult> =>
    checkEngineOnlyReadiness(
      { kiteStatus: deps.kiteStatus, kite: deps.getSession()?.kite ?? null, sidecar: deps.sidecar },
      {
        symbol: args.instrument.symbol,
        instrumentToken: args.instrument.instrumentToken,
        interval: args.interval,
        now: deps.now?.() ?? new Date(),
      },
    ),
  );
  deps.ipcMain.handle("analysis:run", (_event, params: AnalysisRunParams) => {
    const kite = requireSession(deps.getSession).kite;
    if (params.mode === "ai_assisted") {
      return guardSessionExpiry(
        deps.markNeedsLogin,
        runAiAssistedRequest(
          { kite, sidecar: deps.sidecar, provider: deps.provider, history: deps.history, now: deps.now },
          params,
          deps.sendTrace,
        ),
      );
    }
    return guardSessionExpiry(
      deps.markNeedsLogin,
      runAnalysisRequest(
        {
          kite,
          sidecar: deps.sidecar,
          history: deps.history,
          checkReadiness: checkEngineOnlyReadiness,
          assembleEnvelope: assembleWarmedEnvelope,
          kiteStatus: deps.kiteStatus,
          now: deps.now,
        },
        params,
      ),
    );
  });
}
```

Note that `analysis:checkReadiness` deliberately does **not** go through `requireSession` — a not-logged-in state is exactly the `kite_not_connected` answer the gate exists to give, not a thrown error the renderer has to interpret.

- [ ] **Step 5: Wire `kiteStatus` in bootstrap** — in `electron-app/src/main/bootstrap.ts`, add one line to the `registerAnalysisBridge` call:

```ts
  registerAnalysisBridge({
    ipcMain,
    login,
    getSession: () => session,
    sidecar: supervisor,
    provider,
    history,
    sendTrace: makeTraceSender(sendToRenderer),
    markNeedsLogin: () => sessionState.markNeedsLogin(),
    kiteStatus: () => sessionState.status,
  });
```

- [ ] **Step 6: Update the renderer test bridge** — in `electron-app/test/renderer/testBridge.ts`, add one entry immediately after `runAnalysis: vi.fn(),`:

```ts
    checkReadiness: vi.fn().mockResolvedValue({ ok: true }),
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/main/ipc test/main/bootstrap.test.ts && npm run typecheck`
Expected: PASS, clean typecheck. Note `scanScheduler.ts` is untouched: it calls `assembleEnvelope` (not `assembleWarmedEnvelope`) and constructs its own `AnalysisResult` with `mode: "ai_assisted"` or `mode: "engine_only"` — the latter's `horizon: SCAN_HORIZON` field must become `interval: "5minute"` to satisfy the new union. Make exactly that one-field change in `scanScheduler.ts:124-130` (`horizon: SCAN_HORIZON,` → `interval: "5minute",`) and the matching expectation in `test/main/scanScheduler.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add electron-app/src/main/ipc/rendererApi.ts electron-app/src/main/ipc/analysisBridge.ts electron-app/src/main/bootstrap.ts electron-app/src/main/scanScheduler.ts electron-app/test
git commit -m "feat(analysis): interval-based engine_only runs gated by the readiness check"
```

---

### Task 11: UI — interval picker, gate-on-open, readiness message (P13§7)

The Horizon toggle goes away entirely and three interval buttons take its place; `App.tsx` threads the interval through, re-runs the gate whenever a session is reopened, and renders exactly one message per failed check. No new component, no new session field, no sidebar change.

**Files:**
- Modify: `electron-app/src/renderer/InstrumentSearch.tsx`
- Modify: `electron-app/src/renderer/App.tsx`
- Modify: `electron-app/src/renderer/AnalysisResult.tsx`
- Modify: `electron-app/test/renderer/InstrumentSearch.test.tsx`
- Modify: `electron-app/test/renderer/App.test.tsx`
- Modify: `electron-app/test/renderer/AnalysisResult.test.tsx`

**Interfaces:**
- Consumes: `CandleInterval`, `CANDLE_INTERVALS`, `CANDLE_INTERVAL_LABEL` (Task 1); `ReadinessResult` (Task 9); `RendererApi.checkReadiness` (Task 10).
- Produces: `InstrumentSearchProps.onSubmit: (instrument: InstrumentSelection, interval: CandleInterval) => void | Promise<void>`; `readinessMessage(readiness: Extract<ReadinessResult, { ok: false }>): string` exported from `AnalysisResult.tsx`.

- [ ] **Step 1: Write the failing tests** — in `electron-app/test/renderer/InstrumentSearch.test.tsx`, replace the `"submits the selected instrument and chosen horizon"` test:

```ts
  it("submits the selected instrument and chosen candle interval", async () => {
    installBridge({
      searchInstruments: vi.fn(async () => ({
        data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      })),
    });
    const onSubmit = vi.fn();
    render(<InstrumentSearch onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/instrument search/i), { target: { value: "infy" } });
    fireEvent.click(await screen.findByRole("button", { name: "NSE:INFY" }));
    fireEvent.click(screen.getByRole("button", { name: /15-minute/i }));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        "15minute",
      ),
    );
  });

  it("offers exactly the three intraday intervals and no Horizon choice at all", () => {
    installBridge();
    render(<InstrumentSearch onSubmit={vi.fn()} />);

    expect(screen.getByRole("group", { name: /candle interval/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /5-minute/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /10-minute/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /15-minute/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /positional/i })).toBeNull();
    expect(screen.queryByRole("group", { name: /horizon/i })).toBeNull();
  });

  it("defaults to the 5-minute interval", () => {
    installBridge();
    render(<InstrumentSearch onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: /5-minute/i })).toHaveProperty("ariaPressed", "true");
  });
```

In `electron-app/test/renderer/App.test.tsx`, replace the `/positional/i` click at line 110 and the `runAnalysis` expectation at lines 113-118:

```ts
    fireEvent.click(screen.getByRole("button", { name: /15-minute/i }));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));

    await waitFor(() =>
      expect(bridge.runAnalysis).toHaveBeenCalledWith({
        mode: "engine_only",
        sessionId: "session-1",
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        interval: "15minute",
        intent_lens: "buying",
      }),
    );
```

Change the two `horizon: "positional"` fields inside the mocked `runAnalysis` results (lines ~100 and ~201) to `interval: "5minute"`, and append two new tests at the end of the top-level `describe`:

```ts
  it("renders the blocked reason and no analysis result when a run is gated", async () => {
    const bridge = installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      searchInstruments: vi.fn(async () => ({
        data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      })),
      runAnalysis: vi.fn().mockResolvedValue({
        mode: "engine_only_blocked",
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
        interval: "5minute",
        readiness: { ok: false, reason: "insufficient_history", have: 180, need: 256 },
      }),
      getSession: vi.fn().mockResolvedValue({ id: "session-1", response_mode: "engine_only", messages: [] }),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new session/i }));
    fireEvent.click(await screen.findByRole("button", { name: /engine only/i }));
    fireEvent.change(await screen.findByLabelText(/instrument search/i), { target: { value: "infy" } });
    fireEvent.click(await screen.findByRole("button", { name: "NSE:INFY" }));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));

    expect(await screen.findByText(/180 of 256 candles/i)).toBeTruthy();
    expect(bridge.runAnalysis).toHaveBeenCalled();
  });

  it("re-runs the readiness gate fresh when an existing engine_only session is reopened", async () => {
    const bridge = installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      listSessions: vi.fn().mockResolvedValue([
        { id: "s7", response_mode: "engine_only", created_at: "x", last_active_at: "x", preview: "NSE:INFY" },
      ]),
      getSession: vi.fn().mockResolvedValue({
        id: "s7",
        response_mode: "engine_only",
        messages: [
          {
            role: "user",
            rendered_text: "NSE:INFY · 5minute · buying",
            structured_payload: {
              mode: "engine_only",
              sessionId: "s7",
              instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
              interval: "5minute",
              intent_lens: "buying",
            },
          },
        ],
      }),
      checkReadiness: vi.fn().mockResolvedValue({ ok: false, reason: "kite_not_connected" }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));

    await waitFor(() =>
      expect(bridge.checkReadiness).toHaveBeenCalledWith({
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        interval: "5minute",
      }),
    );
    expect(await screen.findByText(/connect your kite account/i)).toBeTruthy();
  });
```

In `electron-app/test/renderer/AnalysisResult.test.tsx`, change every engine_only fixture's `horizon: "positional"` to `interval: "5minute"`, and append:

```ts
  it("renders one specific message per readiness reason and no confluence badges", () => {
    render(
      <AnalysisResultView
        result={{
          mode: "engine_only_blocked",
          instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
          interval: "5minute",
          readiness: { ok: false, reason: "market_closed", nextOpenAt: 1_790_000_000 },
        }}
      />,
    );
    expect(screen.getByText(/nse is closed/i)).toBeTruthy();
    expect(screen.queryByText(/bullish/i)).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/renderer/InstrumentSearch.test.tsx test/renderer/App.test.tsx test/renderer/AnalysisResult.test.tsx`
Expected: FAIL — no `/15-minute/` button exists, `runAnalysis` is still called with `horizon`, `checkReadiness` is never invoked, and `AnalysisResultView` returns `null` for the blocked mode.

- [ ] **Step 3: Replace the Horizon toggle with an interval picker** — in `electron-app/src/renderer/InstrumentSearch.tsx`, replace the `Horizon` import, the two module constants, the props interface, the `horizon` state, the `onSubmit` call, and the toggle markup:

```ts
import type { CandleInterval, InstrumentSelection } from "../main/ipc/rendererApi";
import { CANDLE_INTERVALS, CANDLE_INTERVAL_LABEL } from "../main/services/market/candleInterval";
```

```ts
export interface InstrumentSearchProps {
  onSubmit: (instrument: InstrumentSelection, interval: CandleInterval) => void | Promise<void>;
}

const SEARCH_DEBOUNCE_MS = 300;
```

(delete the `HORIZON_LABEL` and `HORIZONS` constants entirely)

```ts
  const [interval, setInterval] = useState<CandleInterval>("5minute");
```

```ts
      await onSubmit(selected, interval);
```

```tsx
      <div className="horizon-toggle" role="group" aria-label="Candle interval">
        {CANDLE_INTERVALS.map((value) => (
          <Button
            key={value}
            variant={interval === value ? "primary" : "secondary"}
            size="sm"
            aria-pressed={interval === value}
            onClick={() => setInterval(value)}
          >
            {CANDLE_INTERVAL_LABEL[value]}
          </Button>
        ))}
      </div>
```

(the `.horizon-toggle` class is kept — it is a layout rule in `InstrumentSearch.css`, not a horizon-specific one, and renaming it is churn this phase does not need)

- [ ] **Step 4: Render the readiness message** — in `electron-app/src/renderer/AnalysisResult.tsx`, add the exported helper and the blocked branch:

```tsx
import type { AnalysisResult, HistoryMessage, ReadinessResult } from "../main/ipc/rendererApi";
import { Banner } from "./ui/Banner";
```

```tsx
export function readinessMessage(readiness: Extract<ReadinessResult, { ok: false }>): string {
  switch (readiness.reason) {
    case "kite_not_connected":
      return "Connect your Kite account to fetch live candles for this symbol.";
    case "insufficient_history":
      return `Warming up history — ${readiness.have} of ${readiness.need} candles so far. This symbol needs more trading history before any forecast can run.`;
    case "market_closed":
      return `NSE is closed. Trading resumes ${new Date(readiness.nextOpenAt * 1000).toLocaleString()}.`;
  }
}
```

Replace the early return at the top of `AnalysisResultView`:

```tsx
export function AnalysisResultView({ result, history = [] }: AnalysisResultViewProps): JSX.Element | null {
  if (result.mode === "engine_only_blocked") {
    return <Banner variant="info">{readinessMessage(result.readiness)}</Banner>;
  }
  if (result.mode !== "engine_only") return null;
  const { response } = result;
```

If `Banner`'s `variant` union does not include `"info"`, use `"warning"` — check `electron-app/src/renderer/ui/Banner.tsx`'s own prop type and pick whichever non-error variant it declares.

- [ ] **Step 5: Thread the interval and re-run the gate on reopen** — in `electron-app/src/renderer/App.tsx`, replace the `Horizon` import with `CandleInterval` and `ReadinessResult` in the type import list, add one state field, and replace `onAnalyze` and the tail of `onOpenSession`:

```tsx
  const [readiness, setReadiness] = useState<Extract<ReadinessResult, { ok: false }> | null>(null);
```

```tsx
  const onAnalyze = async (instrument: InstrumentSelection, interval: CandleInterval): Promise<void> => {
    if (!activeSession) return;
    setAnalysisError(null);
    setReadiness(null);
    try {
      await bridge().runAnalysis({ mode: "engine_only", sessionId: activeSession.id, instrument, interval, intent_lens: intentLens });
      setSessionDetail(await bridge().getSession(activeSession.id));
    } catch (error) {
      setAnalysisError((error as Error).message);
    }
  };
```

In `onOpenSession`, add `setReadiness(null);` beside the existing `setAnalysisError(null);`, and replace the trailing `lastUserMessage` block:

```tsx
    const lastUserMessage = [...detail.messages].reverse().find((m) => m.role === "user");
    if (lastUserMessage) {
      const payload = lastUserMessage.structured_payload as AnalysisRunParams;
      setIntentLens(payload.intent_lens);
      // The gate is re-evaluated as of right now, not replayed from whenever this
      // session was last open: data and market state both move (P13§2 decision 5).
      if (payload.mode === "engine_only") {
        const fresh = await bridge().checkReadiness({ instrument: payload.instrument, interval: payload.interval });
        setReadiness(fresh.ok ? null : fresh);
      }
    }
```

Replace the engine_only render branch:

```tsx
          {activeSession.mode === "engine_only" ? (
            <>
              <InstrumentSearch onSubmit={onAnalyze} />
              {analysisError && <Banner variant="error">{analysisError}</Banner>}
              {readiness && <Banner variant="info">{readinessMessage(readiness)}</Banner>}
              {!readiness && result && <AnalysisResultView result={result} history={history} />}
            </>
          ) : (
```

and add the import:

```tsx
import { AnalysisResultView, readinessMessage } from "./AnalysisResult";
```

(use the same non-error `Banner` variant chosen in Step 4)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/renderer && npm run typecheck`
Expected: PASS — the whole renderer suite, clean typecheck.

- [ ] **Step 7: Run the entire project suite**

Run (from `electron-app/`): `npm test`; then (from `rust-core/`): `cargo test`
Expected: PASS everywhere.

- [ ] **Step 8: Commit**

```bash
git add electron-app/src/renderer/InstrumentSearch.tsx electron-app/src/renderer/App.tsx electron-app/src/renderer/AnalysisResult.tsx electron-app/test/renderer
git commit -m "feat(ui): candle-interval picker replaces the Horizon toggle, gate result rendered per session"
```

---

## Manual verification checklist (not a task — never blocks phase completion)

Mirrors the Phase 6/11/12 precedent: an automatable golden path plus live follow-ups needing a real sidecar binary and a real Kite session.

**Automatable (mocked bridge + `npm start`):**
- Creating an Engine-Only session shows three interval buttons (5-minute / 10-minute / 15-minute), 5-minute preselected, and no Positional option anywhere.
- Running with Kite disconnected shows exactly one message ("Connect your Kite account…") and no confluence badges, no partial result.
- Reopening a previously-blocked session re-issues `analysis:checkReadiness` (visible in the main-process log) rather than replaying the stored message.
- A benchmark run over a single day inside a long lake partition reports an advancing `bar i/N` where `N` is the day's own frontier count, and the chart still shows only that day.

**Live follow-ups (real sidecar binary + a real Kite session — never a blocker for calling Phase 13 done):**
- First analysis of a fresh symbol at 15-minute triggers one backfill request covering ~35 calendar days and completes without a Kite range error — the single check that validates open item (i). If it errors, `calendarDaysForBackfill`'s output must be chunked against the real limit in `candleWarmup.ts`; nothing else in the design changes.
- A second analysis of the same symbol minutes later issues a delta-only fetch (a handful of candles), not another full backfill.
- With the lake warm and the market open, confirm at least one forecaster (`kronos`/`chronos`/`ttm`/`moirai`, whichever the build links) now appears in the live `algo_results` with a non-Neutral direction — the end-to-end proof that P13§1's finding 1 is actually fixed.
- Run outside market hours and confirm the "NSE is closed, trading resumes …" message names the correct next session, including across a weekend and the next holiday in the bundled calendar.
- Confirm a newly listed symbol with genuinely short history reports `insufficient_history` with real have/need counts instead of an empty result — the exact bug that started this phase.

---

## Self-Review

**1. Spec coverage:**
- P13§4.1 (the existing DuckDB lake is the single store; no new storage engine) → no task introduces one; `topUpCandles` (Task 7) writes exclusively through the existing `persistCandles`/`readLakeCandles` pair.
- P13§4.2 (`calendarDaysForBackfill`, the formula, `HOLIDAY_BUFFER_DAYS`, sizing against linked models rather than a hardcoded 512) → Task 1, plus Task 4 (the `required_lookback` wire field that makes "whichever needs the most" knowable) and Task 8's `requiredBarsFor`. The "filtered to `cost === "slow"`" clause is deliberately widened; see open item (iii).
- P13§4.3 (one-time sized backfill, then delta-only top-up from the lake's last stored ts, chunking if Kite's range limit demands it) → Task 7; chunking resolved as unnecessary with a guard test, open item (i).
- P13§4.4 / P13§5 (live compute reads the trailing window from the lake, full-OHLCV `context_at`, no hardcoded `Horizon::Positional`) → Task 5 (Rust), Task 6 (TS mirror), Task 8 (lake-sourced assembly).
- P13§6 (three-part gate, fixed order, short-circuit, exact have/need, `nextOpenAt`, market-hours + holiday calendar, injected `now`) → Task 2 (calendar) + Task 9 (gate).
- P13§7 (interval picker replaces the Horizon toggle, gate runs before `runAnalysis`, blocked result carried through the existing message-payload mechanism, gate re-runs on reopen, sidebar/badge/`HistoryStore` untouched) → Task 10 (IPC + persisted blocked turn) + Task 11 (UI).
- P13§8 (full-lake compute window, separate frontier-eligibility index, `onProgress` recomputed against that same definition, chart still window-scoped) → Task 3.
- P13§9 testing: sizing tests across all three intervals at 256 and 512 → Task 1 Step 1. Top-up fresh-vs-delta with fake Kite and fake lake → Task 7 Step 1. Rust full-OHLCV + requested-horizon assertions → Task 5 Step 1. Gate per-branch tests with injected `now` covering pre-open, post-close, weekend, holiday, all-pass, plus a check-order short-circuit test → Task 9 Step 1. Benchmark pre-`fromTs` history test → Task 3 Step 1. UI tests asserting the Horizon toggle is gone, three intervals render, and each reason renders its own message → Task 11 Step 1.
- P13§10 risks: Kite range limit → open item (i), resolved as an assumption with a failing-loudly guard test. Holiday-calendar staleness → open item (ii), resolved with a concrete file location, a refresh procedure, a weekends-only degradation, and a one-shot console warning (Task 2 + Task 9). First-time backfill latency → surfaced as candle-count progress inside the `insufficient_history` message (Task 11's `readinessMessage`), exactly as §10 asks. `benchmarkRunner.test.ts`'s assertions pinned to the buggy windowing → Task 3 Step 4 states explicitly which existing assertions survive unchanged (all of them, because `baseParams` uses `fromTs: 0`) rather than leaving the implementer to discover it.
- Not-in-scope items (AI-Assisted untouched, daily ingestion untouched, no new session type/mode/badge, `ScanScheduler` timer logic unchanged, no order path, no rate-limit change) → stated in Global Constraints; no task touches any of them. `scanScheduler.ts`'s single one-field edit in Task 10 Step 7 is a type-union consequence, not a behavior change, and is called out as such.

**2. Placeholder scan:** every code step shows complete, compilable content quoted against the actual current working-tree contents of each file. The two places where the implementer must supply judgment rather than transcribe are both explicit and bounded: Task 2 Step 3's movable-feast holiday dates (with the authoritative source named, and the two dates the tests assert on chosen specifically to be fixed-date so a correction cannot break the suite), and Task 5 Step 1's `end_to_end_test.rs` literal rewrites (with the exact transformation and one worked example given, and a `grep` command to enumerate the rest). No "TBD", "handle edge cases", or "similar to Task N" appears anywhere.

**3. Type consistency:** `CandleInterval = "5minute" | "10minute" | "15minute"` is identical across Tasks 1, 7, 8, 9, 10, 11 and matches the Rust `parse_timeframe` arms added in Task 5. `requiredBars`/`requiredLookback`/`required_lookback` are consistently the camelCase form in app types (`AlgorithmEntry.requiredLookback`, `maxRequiredLookback`, `TopUpParams.requiredBars`) and the snake_case form only on the wire mirror (`AlgorithmWire.required_lookback`), matching `sidecarProtocol.ts`'s own documented convention. `ReadinessResult`'s four variants are byte-identical between the spec's P13§6 block, Task 9's definition, Task 10's `AnalysisResult` extraction, and Task 11's `readinessMessage` switch. `SidecarSupervisor.compute`'s 5-arg shape `(symbol, timeframe, horizon, candles, onRequestId?)` matches across Task 6's definition, its test edits, and Task 8's call. `topUpCandles(deps, params) → { candles, fetched, backfilled }` matches across Tasks 7, 8, and 9. `assembleWarmedEnvelope`'s params object is identical between Task 8's definition and Task 10's `runAnalysisRequest` call site.

**4. Judgment calls made during planning** — the five open items at the top of this document (Kite range limit, holiday-calendar location, all-algorithms vs slow-only sizing, formula-over-table, `Timeframe::TenMinute`) are each stated as a decision with its reason, not silently resolved. Two further smaller ones: (a) `analysis:checkReadiness` deliberately bypasses `requireSession` so a logged-out state produces the `kite_not_connected` *answer* rather than a thrown "not logged in to Kite" the renderer would have to special-case; (b) `assembleWarmedEnvelope` is a new sibling file rather than a branch inside `assembleEnvelope`, so the AI-Assisted/positional path keeps its single straight line — at the cost of a small amount of duplicated envelope-construction shape, which is the trade `CLAUDE.md`'s one-responsibility-per-file rule points at.
