# Phase 14 — Automatic Bhavcopy Backfill for the Benchmark Tool

Status: approved by user 2026-09-18 (directive: engineer a complete, gap-free solution; no
further clarification round — this document records the resulting design and its reasoning
for future reference). Pending implementation planning.

Author: design produced via superpowers:brainstorming, triggered by a live incident: running a
kronos benchmark against `NSE:ZYDUSWELL` returned an empty result with no explanation. Direct
sidecar inspection found the symbol's entire local lake history is **8 daily candles** —
Phase 13's benchmark-harness fix (P13§8, widening the compute window to the full lake) was
working correctly; there was simply nowhere near enough real data in the lake for kronos (needs
256 bars) to ever produce a result. Section references: "P13§N" →
`docs/superpowers/specs/2026-09-17-phase13-intraday-forecaster-warmup-design.md`; "P14§N" → this
document.

## P14§1 Purpose

The Benchmark tool is a pure local-lake reader (`BenchmarkRunnerDeps`,
`electron-app/src/main/services/benchmark/benchmarkRunner.ts:76-78`, is exactly
`{ sidecar: Pick<SidecarSupervisor, "readLakeCandles" | "benchmarkCompute" |
"evaluateScanGateStateless"> }` — no network, no Kite). It can only ever show what's already in
the lake. Measured against the real data: every symbol in the local lake has roughly the same
tiny amount of history — `NSE:ZYDUSWELL`'s day/bhavcopy partition is 8 candles spanning 9 days,
and file sizes across the whole lake cluster around 1150-1166 bytes, consistent with a single
narrow demo-scale ingestion batch rather than real production depth. Against the four
forecasters' actual requirements (kronos 256, chronos 500, ttm/moirai 512 — established in
P13§3), no fix to the benchmark harness's *reading* logic can close this gap, because the data
simply was never fetched. This document engineers the fetching.

Bhavcopy (day-timeframe, NSE's public end-of-day archive) is the one data source where this is
actually solvable on demand: it is a plain, unauthenticated per-day HTTP fetch
(`fetch_udiff_bhavcopy`, `rust-core/crates/ingestion/src/io.rs:29`, hitting
`https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{date}_F_0000.csv.zip`) that
already has a working, tested fetch-and-parse implementation in the `ingestion` crate — it is
just never invoked by the running app today (confirmed: zero references to the `ingest` binary
anywhere in `electron-app/`). **Intraday (5/10/15-minute) benchmark backfill is explicitly out of
scope** (locked decision, this document's P14§2) — the only intraday data that has ever existed
is a one-time static import of an old Kaggle/GitHub dataset (`ingest.rs:63-77`), with no
equivalent on-demand network source; solving that would mean wiring live Kite historical fetches
into a tool intentionally designed to have zero network dependency, which is a materially larger
and different problem than this one.

## P14§2 Scope

**In scope:**

1. A shared, reusable "fetch a range of bhavcopy trading days" primitive in the `ingestion` crate
   that both the existing manual `ingest` CLI and a new sidecar-internal backfill path call —
   correctly distinguishing a market-holiday 404 (skip, keep going) from a genuine fetch failure
   (stop, surface the error), which today's `IngestionError::Fetch(String)` cannot do (P14§4).
2. `sidecar` gains a dependency on the `ingestion` crate (confirmed acyclic — `ingestion` depends
   on `storage`/`chrono`/`csv`/`reqwest`/`zip`, none of which conflict, and depends on neither
   `sidecar` nor `algo-core`/`backtest`) and a new request/response pair,
   `EnsureDayBackfill`/`DayBackfillResult`, that walks backward from a symbol's existing lake
   history (or from the benchmark's requested date, if none exists) until it has collected the
   number of real trading days the selected algorithm's `required_lookback()` demands, or
   determines the symbol simply doesn't have that much listed history (P14§5).
3. `runBenchmark` (`benchmarkRunner.ts`) calls this before the frontier walk starts, on every run
   — sized to whichever single `algoId` was actually selected (Benchmark always scopes to one
   algorithm per run, unlike the live path's "size for whichever forecaster needs the most").
4. Progress is streamed during backfill (mirroring `Compute`'s existing per-algorithm progress
   pattern) through the same `onBenchmarkProgress` channel the benchmark UI already renders,
   distinguished from frontier-walk progress by a `phase` field.
5. If a symbol's real listed history genuinely falls short of what the algorithm needs even after
   exhausting backfill, `BenchmarkView` renders one clear, specific message — "NSE:XYZ has N days
   of real listed history; kronos needs 256" — instead of silently running and showing an empty
   `algos:` result. This is the same category of fix as P13's `insufficient_history` readiness
   reason, applied to the tool where the original confusing empty-result incident actually
   happened.
6. A small politeness delay between backfill requests, since a from-scratch kronos backfill is up
   to ~256 trading days (~360 calendar days accounting for weekends) of back-to-back anonymous
   HTTP requests to a public archive with zero existing throttling (confirmed:
   `ingest.rs`'s day-range loop has no delay at all today).

**Not in scope (explicit decisions):**

- Intraday benchmark backfill (P14§1). Revisit only if a live-Kite-backed intraday data source is
  independently built for some other reason.
- Proactive/bulk backfill (e.g. a "warm the whole lake" button, or the algorithm picker showing
  "will need to fetch N more days" before you press Run). Backfill stays lazy and on-demand,
  matching the live path's own warm-up philosophy (P13§4.1) — only ever fetch what a specific run
  actually needs, when it needs it.
- Changing the manual `ingest` CLI's own behavior beyond factoring its day-range loop into the new
  shared primitive; its command-line interface and output are unchanged.
- Any change to which data source populates the lake in the first place — this document is
  entirely about backfilling *more of the same kind of data* (day/bhavcopy), not adding a new
  data source.

**Locked decisions:**

1. **Backfill logic lives inside the sidecar binary, not a second spawned process.** The
   alternative — Electron shelling out to the existing `ingest` CLI as a child process — would
   reuse the CLI as-is with less Rust-side work, but means shipping, packaging, and
   dev/prod-path-resolving a second executable (mirroring the exact complexity
   `sidecarBinaryPath.ts` already exists to handle for the one binary the app currently ships).
   Linking `ingestion` into `sidecar` keeps the app single-binary and reuses the sidecar's
   existing spawn/respawn/hard-kill lifecycle for free (P14§7).
2. **Sizing is per the single selected `algo_id`**, not a max-across-all-algorithms like the live
   path (P13§4.2's `maxRequiredLookback`). The benchmark UI already requires picking exactly one
   algorithm before a run is possible (P12§2) — there is no "whichever forecaster is linked"
   ambiguity here, so sizing against anything other than the one selected algorithm's own
   `required_lookback()` would over- or under-fetch for no reason.
3. **Holiday-vs-real-failure distinction requires a new `IngestionError` variant.** Today,
   `fetch_udiff_bhavcopy`'s `.error_for_status()` call (`io.rs:37`) erases the HTTP status code
   before it ever reaches calling code — a 404 (holiday) and a 500 (real outage) both collapse
   into the same `IngestionError::Fetch(String)`. This must change: inspect `response.status()`
   before calling `.error_for_status()`, and return a distinct `IngestionError::NotFound` for 404
   specifically, so a multi-day backward walk can safely treat "skip this day" and "stop, report
   the error" as genuinely different outcomes rather than guessing from a string message.
4. **A symbol's "doesn't have this much history" case is detected structurally, not by a fixed
   calendar ceiling.** Each successfully-fetched bhavcopy day contains *every* NSE symbol for
   that day in one file (confirmed, `io.rs:8-10` and `bhavcopy.rs`'s per-row parse) — so "does
   `NSE:XYZ` have a row in this day's file" is a direct, cheap check on data already fetched for
   sizing purposes, not a separate lookup. The walk stops and reports insufficient history once it
   has seen **10 consecutive real trading days** (holidays don't count toward this) with no row
   for the target symbol — a stock that's currently listed and trading won't show 10 straight
   trading days missing from the national bhavcopy; one that's pre-IPO or delisted will. A fixed
   calendar-date ceiling (e.g. "never go back further than N years") was considered and rejected:
   it would need updating over time and doesn't actually answer the question being asked, which is
   "does this specific symbol have enough history," not "how far back are we willing to look."
5. **Progress streams during backfill; cancellation needs no new mechanism.** The sidecar's
   request loop is single-threaded and fully serial (confirmed,
   `rust-core/crates/sidecar/src/main.rs`'s documented invariant) — an unstreamed 256-request
   backfill would block every other sidecar operation, including the existing Stop button, for
   its full duration. Emitting one progress event per fetched day (matching `Compute`'s existing
   per-algorithm progress shape) keeps the UI live; the existing hard-kill-and-respawn
   `cancelCurrent()` path (P12§4.2) already handles killing a slow/stuck sidecar operation
   mid-flight and needs no changes to also cover a slow backfill.
6. **Backfilled data is written through the exact same `CandleStore::write_sourced_candles` call**
   both the manual CLI (`importer.rs:19`) and the live `PersistCandles` handler
   (`handlers.rs:150`) already use — confirmed identical function, idempotent read-merge-write
   keyed on `ts` (`candle_store.rs:138-153`). Backfilled data is permanently indistinguishable
   from manually-ingested data and benefits every future run against that symbol, not just the
   one that triggered the fetch.

## P14§3 Real-world numbers this design is built against

| Algorithm | `required_lookback()` (trading days, since day-timeframe = 1 bar/day) |
|---|---|
| kronos | 256 |
| chronos | 500 |
| ttm | 512 |
| moirai | 512 |
| fast/technical indicators | 2-52 (e.g. obv 2, ichimoku 52 — see P13§3's live-path table for the general shape; exact values already exposed per-algorithm via `AlgorithmWire.required_lookback`, P13 Task 4) |

256 trading days ≈ 360 calendar days (weekends only, no holiday buffer needed here the way P13's
`HOLIDAY_BUFFER_DAYS` was needed for calendar-day *fetch windows* — this walk counts *actual
successfully-parsed trading days*, so holidays are transparently skipped rather than budgeted
for). 512 trading days ≈ 720 calendar days, roughly two years. A from-scratch backfill for
kronos is therefore on the order of 300-400 HTTP requests; for ttm/moirai, 600-750. At a
politeness delay of ~150-250ms per request (P14§2 item 6) plus actual fetch/parse time, a
from-scratch ttm/moirai backfill is a multi-minute operation the first time it runs for a given
symbol — expected and communicated via progress, not a bug, and never repeated for that symbol
once the lake holds it.

## P14§4 Ingestion crate: holiday-aware day-range fetch primitive

New in `rust-core/crates/ingestion/src/error.rs`: `IngestionError` gains a `NotFound` variant
alongside the existing `Fetch(String)`. `io.rs:29`'s `fetch_udiff_bhavcopy` changes to inspect
`response.status()` before erasing it via `.error_for_status()` — a 404 maps to
`Err(IngestionError::NotFound)`, everything else keeps today's `Fetch(String)` behavior.

New shared function (exact module TBD by the plan — a natural home is a new
`rust-core/crates/ingestion/src/backfill.rs`), conceptually:

```rust
pub struct DayOutcome {
    pub date: NaiveDate,
    pub candle: Option<ParsedCandle>, // None if the target symbol has no row in this day's file
}

pub fn walk_trading_days_backward(
    exchange: &str,
    symbol: &str,
    start: NaiveDate,
    mut on_day: impl FnMut(DayOutcome) -> ControlFlow<()>, // caller decides when to stop
) -> Result<(), IngestionError>
```

This is the primitive both the manual `ingest` CLI's existing day-range loop and the new sidecar
handler call — the CLI's loop is refactored to use it (skip-holiday behavior it already
approximates today gets the same real distinction P14§2 item 3 introduces), and the new sidecar
handler drives it with a callback that: persists each successfully-parsed candle immediately
(so a cancelled/interrupted backfill keeps whatever it already fetched, matching P13's
"a hard-cancel discards no committed work" precedent), counts consecutive `candle: None` outcomes
on real trading days toward the "symbol has no more history" heuristic (P14§2 item 4), and stops
once either the required trading-day count is reached or that heuristic fires.

## P14§5 Sidecar: `EnsureDayBackfill` request

```rust
// protocol.rs
pub struct EnsureDayBackfillRequest {
    pub id: u64,
    pub symbol: String,
    pub algo_id: String,
}

pub struct DayBackfillResponse {
    pub id: u64,
    pub have: usize,
    pub need: usize,
    pub sufficient: bool, // false => `have` is the symbol's full available real history, capped by the "10 consecutive absent trading days" heuristic
}
```

Handler resolves `algo_id`'s `required_lookback()` from the registry (the same lookup
`handle_list_algorithms` already does, P13 Task 4), reads the symbol's current day/bhavcopy lake
depth via the existing `CandleStore` read path, and if short, drives `walk_trading_days_backward`
starting from the day before the earliest candle already in the lake (or from "today" if the lake
has nothing for this symbol yet), emitting one `progress` event per day walked
(`{"type":"progress","id":N,"step":"backfill","status":"running"}`, mirroring `Compute`'s
existing shape) until satisfied or the absent-history heuristic fires.

## P14§6 Electron: pre-flight backfill in `runBenchmark`

Before `runBenchmark`'s existing frontier loop (`benchmarkRunner.ts:80` onward) starts, one new
call: `deps.sidecar.ensureDayBackfill(params.symbol, params.algoId)`, awaited, with its own
progress events forwarded through the existing `onProgress` callback using a `phase: "backfill"`
tag alongside the existing `phase: "run"` frontier-walk progress (both variants extend the
existing `{ index, total }` shape the UI already renders a bar for) so the same progress pill
shows "Backfilling history: 143/256 days" before switching to "bar 3/8" once the actual algorithm
run starts. If the response comes back `sufficient: false`, `runBenchmark` returns immediately
with a new `BenchmarkResult` shape carrying `{ insufficientHistory: { have, need } }` instead of
running an empty frontier walk — `BenchmarkView` renders this as one clear banner (mirroring
P13's `readinessMessage` pattern) in place of the confusing empty `algos:`/zeroed-confluence
result that started this whole investigation.

## P14§7 Why this needs no new cancellation mechanism

Restated from P14§2 item 5 because it is easy to under-build here: because backfill now runs
*inside* the same sidecar process a benchmark run already uses, `SidecarSupervisor.cancelCurrent()`
— which hard-kills and respawns the sidecar child process (P12§4.2, already built, already
tested) — transparently covers a stuck-or-slow backfill with zero new code. The only new
requirement is that backfill progress actually streams (P14§5/§6), so a user watching a slow
first-time ttm/moirai backfill can see it's working and choose to cancel if they don't want to
wait, exactly as they already can for a slow benchmark compute.

## P14§8 Testing

- **Rust — `walk_trading_days_backward`**: unit tests with an injectable fetch function (not real
  network): a run of ordinary trading days count up correctly; a 404 (`NotFound`) is skipped and
  does not count toward either the required-days total or the absent-history heuristic; a
  non-404 error stops the walk and propagates; 10 consecutive real-trading-day `None` outcomes
  (with intervening holidays correctly not breaking the streak) trips the insufficient-history
  stop; a lake that already has partial history resumes correctly from the day before its
  earliest existing candle rather than re-fetching what's already present.
- **Rust — `EnsureDayBackfill` handler**: a symbol with already-sufficient lake depth returns
  `sufficient: true` immediately with zero fetch calls; a symbol needing a small top-up fetches
  only the missing days; a symbol that can never reach the requirement (all fetch attempts
  return `None` for the target row) returns `sufficient: false` with the real `have` count.
- **Rust — `io.rs`**: a mocked/injected HTTP layer confirms a 404 response maps to
  `IngestionError::NotFound` specifically, distinct from other status codes' `Fetch(String)`.
- **TS — `runBenchmark`**: a benchmark run against a symbol with insufficient history (mocked
  `ensureDayBackfill` returning `sufficient: false`) returns the `insufficientHistory` result and
  never calls `benchmarkCompute`; a sufficient-history case proceeds to the frontier walk
  unchanged from today's behavior; progress events with `phase: "backfill"` render distinctly
  from `phase: "run"` events in the existing progress pill.
- **TS — `BenchmarkView`**: renders the new insufficient-history banner with the real have/need
  numbers, in place of the summary strip and chart, when a run comes back with that result shape.
- **No test performs a real network call to NSE's archive** — this is the same class of
  "verify against the live API when convenient, but the automated suite never depends on it
  succeeding" already established for the Kite range-limit assumption in P13§10. A note in the
  plan's manual-verification checklist should confirm a real from-scratch backfill against a real
  low-history symbol once, by hand.

## P14§9 Risks

- **NSE's archive is an external dependency outside this project's control.** URL format changes,
  outages, or IP-level blocking from too-aggressive fetching are all real, un-mitigable-by-code
  risks. The politeness delay (P14§2 item 6) reduces but does not eliminate the blocking risk.
- **First-time backfill for the largest models is a multi-minute operation** (P14§3). This is
  communicated via progress, not hidden, but is a real wait a user needs to be prepared for the
  first time they benchmark a thin symbol against ttm/moirai.
- **The single-threaded sidecar is fully occupied during backfill** (P14§2 item 5) — no other
  sidecar-dependent UI action (live chat analysis, another benchmark run, watchlist scans) can
  proceed until it finishes or is cancelled. This is an existing, already-accepted architectural
  property of the sidecar (P12§1), not a new risk this phase introduces, but it is worth restating
  since backfill durations are longer than a typical single benchmark compute call.
- **The "10 consecutive absent trading days" heuristic is a judgment call, not a proof.** A
  symbol that trades very rarely (extremely low liquidity, but technically still listed) could in
  principle trip this heuristic incorrectly. This is considered acceptable: the alternative
  (walking back indefinitely) is strictly worse, and 10 consecutive real trading days with zero
  print in the national bhavcopy is already an extreme case for anything meaningfully tradeable.
