# Phase 14 — Automatic Bhavcopy Backfill for the Benchmark Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Benchmark run against a thin-history symbol fetch the day/bhavcopy history the selected algorithm actually needs — on demand, inside the existing sidecar process — and, when the symbol genuinely does not have that much listed history, say so in one clear sentence instead of returning an empty `algos:` result.

**Architecture:** Three layers, bottom-up. (1) The `ingestion` crate learns to tell a market-holiday 404 apart from a real fetch failure (`IngestionError::NotFound`), and gains a new `backfill.rs` holding two pure-ish primitives: `fetch_trading_day` (weekend/holiday → `Closed`, everything else → the day's raw CSV bytes) and `walk_trading_days_backward` (walks calendar days backward, skipping non-trading days, handing each real trading day's parsed row for one symbol to a caller-supplied `ControlFlow` callback). The existing `ingest` CLI's day-range loop is refactored onto `fetch_trading_day`, so the holiday distinction is shared rather than duplicated. (2) The `sidecar` crate takes a direct dependency on `ingestion` (already transitively present via `backtest`) and gains an `EnsureDayBackfill` request whose handler resolves the requested algorithm's `required_lookback()` from the registry, reads the symbol's current day/bhavcopy lake depth, and — if short — drives `walk_trading_days_backward` from the day before the lake's earliest candle (or from today, if the lake has nothing), persisting each fetched candle immediately through the same `CandleStore::write_sourced_candles` the CLI and `PersistCandles` already use, emitting one counted progress line per persisted day, and stopping on whichever of three conditions fires first: the requirement is met, ten consecutive real trading days have shown no row for the symbol, or thirty consecutive weekday fetches came back 404 — the walker's own bound against an archive that has stopped answering (decision (xviii)). (3) Electron mirrors the wire type, `runBenchmark` calls the backfill as a pre-flight before the frontier walk — only for a `("day", "bhavcopy")` entry — and forwards its progress through the *existing* `onBenchmarkProgress` IPC channel tagged `phase: "backfill"`, and `BenchmarkView` renders either the phase-aware progress pill or a single shortfall banner whose wording says which of the two shortfalls happened.

**Tech Stack:** Rust (`cargo test -p <crate>` from `rust-core/`; one new inter-crate path dependency, `sidecar → ingestion`, no new third-party crates); TypeScript, Electron 33, React 18, Vitest (`npx vitest run <path>`, `npm test`, `npm run typecheck` from `electron-app/`).

## Global Constraints

Every task's requirements implicitly include this section.

- **Hard safety invariant (non-negotiable, restated every phase):** the app NEVER places, modifies, cancels, or automates any order. This phase adds **zero** order-related surface. Nothing here touches `kiteClient.ts`, its `KITE_READ_TOOL_NAMES` allowlist, or its `KITE_WRITE_TOOL_NAMES` negative assertion.
- **Intraday backfill is out of scope** (P14§1, P14§2). No task fetches, or plans to fetch, 5/10/15-minute or `minute`-timeframe data. The only timeframe/source pair this phase ever writes is `("day", "bhavcopy")`.
- **No proactive or bulk backfill** (P14§2 "not in scope"). Backfill is lazy and per-run: it happens when a specific benchmark run needs it, sized to the one algorithm that run selected, and never pre-warms anything.
- **No second spawned process** (P14§2 locked decision 1). The backfill runs inside the existing `sidecar` binary. No task adds an executable, a packaging entry, or a path-resolution helper.
- **No new cancellation mechanism** (P14§7). `SidecarSupervisor.cancelCurrent()` already hard-kills and respawns the child; no task adds a cancel token, an abort signal, or a cooperative-cancellation flag to Rust.
- **No new progress mechanism** (P14§2 item 4). Backfill progress rides the *existing* sidecar `progress` line and the *existing* `benchmark:progress` IPC channel and `onBenchmarkProgress` renderer subscription. No new IPC channel, no second EventEmitter event name.
- **Backfilled data is written through `CandleStore::write_sourced_candles` and nothing else** (P14§2 locked decision 6). It is permanently indistinguishable from CLI-ingested data.
- **No test performs a real network call to NSE's archive.** Every Rust test that would otherwise fetch injects a `FnMut(&str, NaiveDate) -> Result<Vec<u8>, IngestionError>` closure. The one existing network-touching test, `ingestion/tests/fetch_smoke_test.rs`, stays `#[ignore]`d and untouched.
- **No wall-clock-dependent test anywhere.** `handle_ensure_day_backfill` takes `today: NaiveDate` as an explicit parameter; only `main.rs` reads the real clock. This mirrors the injected-`now` convention P11/P12/P13 already established on the TypeScript side.
- **Comments:** default to none. Only add one when the *why* isn't obvious (a hidden invariant, a workaround, a formula's source). Never restate the next line; never a numbered step block. (From `CLAUDE.md`.)
- **Naming:** Rust `snake_case` functions/vars, `PascalCase` types. TypeScript `camelCase` functions/vars, `PascalCase` types/classes/React components. Wire-mirror interfaces in `sidecarProtocol.ts` keep `snake_case` field names deliberately — they mirror the bytes, not this project's TS convention (see that file's own header comment).
- **Structure:** pure logic stays separate from I/O. `ingestion/src/backfill.rs` performs **no** network call and **no** sleep of its own — both are supplied by the caller's injected fetch closure. `sidecar/src/day_backfill.rs` is the one new file that orchestrates store I/O plus the injected fetch, and it lives beside `handlers.rs` rather than inside it.
- **Commit convention:** each task's implementer commits as the repo's own configured git user via plain `git commit` — NEVER pass `--author`, NEVER add a `Co-Authored-By` trailer, NEVER use `--no-verify`. Conventional-commit subjects (`type(scope): message`), matching sibling plans.
- **Two toolchains, two test runners.** **Rust:** run from `rust-core/` — `cargo test -p <crate>`, `cargo test -p <crate> --lib`, `cargo test -p <crate> --test <file>`. **TypeScript:** run from `electron-app/` — `npx vitest run <path>`, `npm test`, `npm run typecheck`.
- **`npm run typecheck` checks production code only — it is not a safety net for test-file edits.** It is plain `tsc --noEmit`, and `electron-app/tsconfig.json` sets `include: ["src/**/*"]` with `exclude: ["**/*.test.ts", "**/*.test.tsx", …]`, so **no test file is ever type-checked**. A missed edit in a test fixture (this plan asks for several mechanical ones) therefore surfaces only as a runtime vitest failure — `deps.sidecar.ensureDayBackfill is not a function`, `undefined` reads — never as a typecheck error. The safety net for test-file completeness is **running the affected test file(s) and seeing them pass**, which every task's steps already do; `typecheck`'s job here is confirming the `src/**` production change compiles.
- **Working-tree note:** at plan time `electron-app/` carries **uncommitted** changes to `benchmarkRunner.ts`, `benchmarkChart.ts`, `BenchmarkView.tsx`/`.css` and their three test files, and `docs/.../phase13-...-plan.md`. Every code excerpt in this plan is quoted from that **current working-tree state** on branch `phase13-intraday-forecaster-warmup`, not from a clean `HEAD`. Commit or stash nothing — implement on top of what is there.

## Drift found against the design spec's citations (corrected here, not propagated)

The spec was written the same day, but four of its line citations and one of its claims are already off. Every task below uses the corrected reality.

1. **`io.rs:29` → actually `io.rs:31`.** `fetch_udiff_bhavcopy`'s `pub fn` line is 31; lines 27-30 are its doc comment. Cited in P14§1 and P14§4.
2. **`io.rs:37` (the `.error_for_status()` call) → actually `io.rs:40`.** The `client.get(&url)` chain starts at 37; `.and_then(|r| r.error_for_status())` is line 40. Cited in P14§2 locked decision 3. Task 1 rewrites the whole chain, so the exact line stops mattering, but do not go hunting at 37.
3. **`io.rs:8-10` is cited in P14§2 locked decision 4 as evidence that "each bhavcopy day contains every NSE symbol in one file."** Lines 8-10 are the NSE URL-format arm of `bhavcopy_url`; they are evidence of nothing of the kind. The real evidence is `bhavcopy.rs:44-64` — one `for record in reader.records()` loop over the whole file emitting one `ParsedCandle` per `SctySrs == "EQ"` row, with the symbol taken from each row's `TckrSymb`. The decision is correct; its citation is not.
4. **`benchmarkRunner.ts:80` is cited in P14§6 as "runBenchmark's existing frontier loop".** Line 80 is the `export async function runBenchmark(` signature; the frontier `for` loop is at line 108. The pre-flight call this plan adds goes at the very top of the function body (line 85, before `readLakeCandles`), which is where P14§6's prose actually points.
5. **P14§2 item 2 understates the dependency check.** It says `sidecar` gaining `ingestion` is "confirmed acyclic". It is — but more strongly than stated: `backtest/Cargo.toml` **already** declares `ingestion = { path = "../ingestion" }`, and `sidecar` already depends on `backtest`, so `ingestion` is already in the sidecar binary's build graph transitively. Task 5's Cargo change adds zero new compilation units and cannot introduce a cycle, because `ingestion`'s only intra-workspace dependency is `storage`.
6. **Naming inconsistency inside the spec itself.** P14§2 item 2 calls the response `DayBackfillResult`; P14§5 defines it as `DayBackfillResponse`. This plan uses **`DayBackfillResponse`** throughout, matching P14§5's actual struct definition and every other `*Response` type in `protocol.rs`.

Citations that were checked and are **correct**: `benchmarkRunner.ts:76-78` (`BenchmarkRunnerDeps`), `importer.rs:19` (`write_sourced_candles`), `handlers.rs:150` (the `PersistCandles` write), `candle_store.rs:138-153` (`write_sourced_candles`'s read-merge-write on `ts`), `ingest.rs:63-77` (the intraday static import), "`ingest.rs`'s day-range loop has no delay at all today" (lines 39-57 — confirmed, zero sleeps), and every number in P14§3's table: kronos 256 (`kronos_math.rs:11`), chronos 500 (`chronos.rs:70`), ttm 512 (`ttm_math.rs:24` → `CONTEXT_LENGTHS[0]`), moirai 512 (`moirai_math.rs:13`), obv 2 (`indicators/obv.rs:17`).

## Decisions this plan makes that the spec left open

**(i) Where `walk_trading_days_backward` lives.** P14§4 says "exact module TBD by the plan — a natural home is a new `rust-core/crates/ingestion/src/backfill.rs`". **Decision: take that suggestion.** `backfill.rs`, registered in `lib.rs`'s module list. Reason: it is neither parsing (`bhavcopy.rs`) nor network transport (`io.rs`) nor lake writing (`importer.rs`) — it is day-sequencing policy, which is a third responsibility and therefore a third file, per `CLAUDE.md`.

**(ii) The `ingest` CLI is refactored onto a shared *sub*-primitive, not onto `walk_trading_days_backward` itself.** P14§4 says "the CLI's loop is refactored to use it". Taken literally that does not work, for two independent reasons: the walker goes **backward** from a start date while the CLI goes **forward** across `[--from, --to]` (reversing it would reverse the CLI's per-day `eprintln!` output, which P14§2's not-in-scope item 3 promises is unchanged), and the walker is **symbol-scoped** (`DayOutcome.candle` is one symbol's row) while the CLI imports **every** symbol in each day's file. **Decision: `backfill.rs` exposes `fetch_trading_day(exchange, date, fetch) -> Result<TradingDay, IngestionError>`, which is exactly the shared piece — the weekend skip plus the 404-means-closed mapping — and both the CLI's forward loop and `walk_trading_days_backward`'s backward loop call it.** The spec's intent (one place decides what a non-trading day is) is met; its literal wording is not.

**(iii) The CLI's holiday behavior changes, deliberately.** Today a weekday-holiday 404 is a hard error that aborts the whole range (`ingest.rs:44-47`'s comment says so explicitly). After Task 3 it is skipped like a weekend. P14§4 asks for exactly this ("skip-holiday behavior it already approximates today gets the same real distinction"), but P14§2's not-in-scope item 3 says the CLI's "output is unchanged". **Decision: the behavior change stands and is the point; "unchanged" is honored for the command-line interface, the per-day message format, and the final `done:` summary line.** A range spanning Diwali now succeeds where it used to abort.

**(iv) How `io.rs`'s 404 mapping is made testable.** P14§8 asks for "a mocked/injected HTTP layer". Injecting an HTTP layer into `fetch_udiff_bhavcopy` would mean threading a client trait through the one function whose entire job is to be the network edge. **Decision: extract the status→error decision into a pure private helper, `error_for_http_status(status: u16, url: &str) -> Option<IngestionError>`, unit-tested directly in `io.rs`'s own `mod tests`; `fetch_udiff_bhavcopy` keeps being the single untested network edge, exercised only by the existing `#[ignore]`d smoke test.** This is the smallest seam that makes the 404-vs-500 contract a real test rather than a claim.

**(v) How a progress line carries a count.** P14§5 shows `{"type":"progress","id":N,"step":"backfill","status":"running"}` — which has no numbers in it, while P14§6 wants the pill to read "Backfilling history: 143/256 days". **Decision: `ProgressLine` gains two `Option` fields, `index` and `total`, both `#[serde(skip_serializing_if = "Option::is_none")]`, plus a second constructor `encode_progress_counted`.** Every existing progress line stays byte-identical (Task 4 asserts this), no second channel is invented, and the TS side distinguishes a counted line by `index !== undefined`.

**(vi) How backfill progress reaches `runBenchmark`.** `analysisBridge.ts:153-186` establishes one pattern: subscribe to `SidecarSupervisor`'s `"progress"` EventEmitter event and filter by a set of owned request ids. **Decision: do not use that pattern here.** `BenchmarkRunnerDeps.sidecar` is a narrow structural `Pick<SidecarSupervisor, …>`; adding `"on" | "off"` to it would force every one of the 13 test fakes in `benchmarkRunner.test.ts` to grow EventEmitter surface for no benefit. Instead `SidecarSupervisor.ensureDayBackfill(symbol, algoId, onDayProgress?)` takes a **per-request** callback, and the supervisor itself does the id-matching in `dispatch`. One new `Pick` member, zero EventEmitter leakage.

**(vii) `runBenchmark`'s `onProgress` becomes a single object.** P14§6 says backfill progress is "distinguished from frontier-walk progress by a `phase` field" and that "both variants extend the existing `{ index, total }` shape". **Decision: `onProgress?: (progress: BenchmarkProgress) => void` where `BenchmarkProgress = { phase: "backfill" | "run"; index: number; total: number }`, replacing today's positional `(index: number, total: number)`.** Every call site is enumerated in Task 7; there are exactly **1** in `src/` (`benchmarkBridge.ts:32-33`) and **3** in `test/` (`benchmarkRunner.test.ts:233`, `:265-266`, `:323-324`), plus **1** assertion in `benchmarkBridge.test.ts:124`.

**(viii) The pre-flight runs only for `params.timeframe === "day" && params.source === "bhavcopy"` — the timeframe alone is not enough.** P14§6 says the call happens "on every run". That is wrong as written: the handler reads and writes the `("day", "bhavcopy")` partition and nothing else, so running it for a `minute`/`kaggle` benchmark entry would fetch day bars the run cannot use and then report a bogus have/need.

Gating on the timeframe alone is *also* wrong, and this is the sharper trap: the live intraday warm-up path already on this branch persists `("day", "kite")` partitions too — `historicalDataArchive.ts:17-26`'s `INTERVAL_LOOKBACK_HINT_DAYS` carries a `day: 2000` entry and `candleWarmup.ts:10`'s `WARMUP_SOURCE` is `"kite"` — and those entries appear in the benchmark picker (`listLakeSymbols`) right alongside bhavcopy ones. A `("day", "kite")` entry passing a timeframe-only gate would make the pre-flight check and backfill the `("day", "bhavcopy")` partition while `readLakeCandles` then reads `("day", "kite")` for the actual run: wasted network calls at best, and at worst a flatly wrong "insufficient history" verdict on a Kite-sourced partition that is perfectly deep enough. `BenchmarkRunParams` already carries the field (`benchmarkRunner.ts:25-33`: `source: string`), so the gate costs one extra comparison.

**Decision: `runBenchmark` skips the pre-flight entirely unless `params.timeframe === "day" && params.source === "bhavcopy"`.** Two tests pin it: a `minute`/`kaggle` entry and a `day`/`kite` entry each run exactly as they do today, with `ensureDayBackfill` never called (Task 7 Step 3). *Residual gap, accepted:* an intraday benchmark against a thin `minute` partition, or a benchmark against a thin `("day", "kite")` partition, still shows the original confusing empty result. Closing the first needs an intraday data source, which P14§1 puts firmly out of scope; closing the second means driving the live Kite warm-up path from the Benchmark tool, which would give the "pure local-lake reader" (P14§1) a Kite dependency — also out of scope for this phase.

**(ix) `DayBackfillResponse` gains an `error: Option<String>` field.** P14§5's struct has none. But the handler is store-backed: it can fail on "no `--lake-root` configured", on a `CandleStore` read/write error, and on a non-404 fetch error mid-walk. **Decision: add `error: Option<String>` with `#[serde(skip_serializing_if = "Option::is_none")]`, exactly matching `PersistCandlesResponse`, `WatchlistResponse`, `ScanGateResponse`, `LakeSymbolsResponse`, and `LakeCandlesResponse`.** Without it a network outage would be indistinguishable on the wire from a genuinely short-history symbol.

**(x) A failed-and-insufficient backfill throws; it does not render the banner.** Follows directly from (ix). **Decision: `runBenchmark` throws `Error(\`backfill failed for ${symbol}: ${error}\`)` when the response carries an `error` *and* `sufficient === false`, so `BenchmarkView`'s existing error `Banner` shows the real cause.** An error with `sufficient === true` (the walk hit a snag but had already collected enough) is `console.error`'d and the run proceeds.

**(xi) The backfill request needs its own, much longer timeout.** `SidecarSupervisor`'s `DEFAULT_REQUEST_TIMEOUT_MS` is 30 000. P14§3 says a from-scratch ttm/moirai backfill is "a multi-minute operation" — 600-750 requests at ~200 ms plus fetch time. The 30-second default would reject it every time. The spec does not mention this at all. **Decision: `send()` gains an optional per-request timeout, and `ensureDayBackfill` passes `BACKFILL_REQUEST_TIMEOUT_MS = 30 * 60 * 1000`.** A progress-driven idle timeout was considered and rejected as more machinery than the problem warrants; the user can hit Stop at any time, which is the real escape hatch (P14§7).

**(xii) Cancelling during backfill returns a cancelled result, not a thrown error.** `cancelCurrent()` kills the child, which rejects the in-flight `ensureDayBackfill` with `{ cancelled: true }` — outside today's `try` block, which only wraps the frontier loop. **Decision: `runBenchmark` wraps the pre-flight in its own `try`/`catch` and returns `{ params, candles: [], decisionPoints: [], cancelled: true }` on a tagged cancellation**, so Stop during backfill renders the same "Cancelled — partial results" banner Stop during a run already does. Any other rejection is rethrown.

**(xiii) The handler lives in a new `sidecar/src/day_backfill.rs`.** `handlers.rs` is already ~600 lines carrying eleven handlers plus their shared wire-conversion helpers. **Decision: the backfill handler, its two partition constants, and its absent-day threshold get their own file**, per `CLAUDE.md`'s one-responsibility-per-file rule. `lib.rs` grows one `pub mod day_backfill;` line.

**(xiv) The politeness delay lives in `main.rs`'s fetch closure; only its constant lives in `backfill.rs`.** **Decision: `backfill.rs` exports `pub const POLITENESS_DELAY_MS: u64 = 200;` (documented next to the walker it throttles) and performs no sleep itself; `main.rs`'s real fetch closure sleeps that long before each `fetch_udiff_bhavcopy` call.** Keeps `backfill.rs` free of timing I/O and keeps the whole Rust test suite instant. 200 ms is the midpoint of P14§3's stated "~150-250ms". The CLI is deliberately left un-throttled, matching P14§2's not-in-scope item 3.

**(xv) An unknown `algo_id` needs nothing.** **Decision: `need = 0`, `have = <current lake depth>`, `sufficient = true`, zero fetches, no error.** Consistent with `registry::run_applicable`, which also silently runs nothing for an id it does not know — the benchmark then proceeds and produces its (correct, empty) result rather than being blocked by a backfill that has no target.

**(xvi) `have` is re-read from the lake after the walk.** The walk maintains an incremental counter for progress and for its stop condition, but that counter could in principle drift from the partition's real row count (a fetched day whose `ts` already existed would merge rather than append). **Decision: the response's `have` is `store.read_sourced_candles(...).len()` taken after the walk, falling back to the incremental counter if that read fails.** Three lines, and it guarantees the number the banner shows is the number of bars the run will actually get.

**(xvii) Test bhavcopy CSVs are built inline, per date — the shared fixture must not be reused.** `ingestion/tests/fixtures/nse_bhavcopy_udiff_sample.csv` has a hardcoded `TradDt` of `2024-01-15`. `bhavcopy.rs:56` derives each candle's `ts` from `TradDt`, and `write_sourced_candles` merges on `ts` — so feeding that one fixture back for every walked day would write the *same* candle 256 times and the lake would never grow past one row. **Decision: every backfill test builds its CSV with a small local `bhavcopy_csv(date, rows)` helper that stamps the walked date into `TradDt`.** The helper is duplicated in three test modules (`ingestion/tests/backfill_test.rs`, `ingestion/src/bin/ingest.rs`'s `mod tests`, `sidecar/src/day_backfill.rs`'s `mod tests`) because an integration test, a bin's unit tests, and another crate cannot share a helper without a test-support crate this workspace does not have and does not need for ~10 lines.

**(xviii) `walk_trading_days_backward` bounds itself against an archive that has stopped answering — a second, independent stop condition the spec does not have.** P14§4's sketch gives the walk exactly one exit: `on_day` returning `ControlFlow::Break`. But `on_day` is only ever invoked for a **successfully fetched** (`Traded`) day, so a run of consecutive `Closed` (404) weekdays advances no stopping condition at all. That is not a hypothetical: NSE's UDiFF archive has a start date, and a ttm/moirai backfill needs 512 real trading days (P14§3) — a walk that reaches past the archive's coverage 404s on every subsequent weekday and, with the spec's single exit, walks backward forever, one weekday at a time, wedging the single-threaded serial sidecar until the user hits Stop. The same failure mode is what a change to the archive's URL format (a named P14§9 risk) would produce.

**Decision: `backfill.rs` exports `pub const CLOSED_DAY_LIMIT: usize = 30;` and the walker returns `Result<WalkStop, IngestionError>` where `WalkStop` is `CallerStopped | ArchiveExhausted`.** The walker counts *consecutive weekday* `Closed` outcomes (weekends never reach the network, so they never count) and returns `Ok(WalkStop::ArchiveExhausted)` once that counter hits the limit; **any** successful `Traded` fetch resets it to 0, so a scattered single holiday mid-history can never accumulate toward it.

This counter is **independent of `ABSENT_DAY_LIMIT`** and must not be merged with it. `ABSENT_DAY_LIMIT` counts successfully-fetched trading days on which the *target symbol* has no row — a fact about the symbol. `CLOSED_DAY_LIMIT` counts weekdays on which the *archive* has no file — a fact about the archive. They answer different questions and produce different user-facing messages; `ABSENT_DAY_LIMIT`'s existing logic is correct and is not touched.

*Why 30:* the longest NSE holiday cluster in practice is a handful of weekday closures (a festival stretch plus an adjacent exchange holiday), nowhere near ten consecutive weekdays, so 30 is generous by a wide margin against any real calendar. It also bounds the worst case tightly: 30 extra requests at `POLITENESS_DELAY_MS` is ~6 seconds of wasted work before the walk gives an honest answer, instead of an unbounded loop. The reasoning is stated in the constant's doc comment, matching how `ABSENT_DAY_LIMIT` justifies its own value.

**This is a third outcome, not a rebranded `sufficient: false`.** From the walker's vantage point "the archive stopped answering" is genuinely indistinguishable from "this symbol has a gap that wide" — but it is *not* the same claim as "this symbol only has 8 days of listed history," and silently reporting it as such would tell the user a falsehood about their symbol. So it is carried all the way out: `DayBackfillResponse` gains `archive_exhausted: bool` (always serialized, alongside `sufficient`), `DayBackfillResponseWire` mirrors it, and `BenchmarkResult.insufficientHistory` becomes `{ have, need, reason: "symbol_history" | "archive_unreachable" }` so `BenchmarkView` renders a differently-worded banner — "could not reach far enough back into the archive", `variant="warning"` — instead of the symbol-history sentence, `variant="info"`. A dedicated all-404 walker test (Task 2 Step 1) and a dedicated all-404 handler test (Task 5 Step 6) prove the walk terminates at the cap rather than looping.

## Accepted risks this plan does not close

P14§9's four risks stand as written. Three more are named here because they are consequences of this plan's own decisions, and a future reader should see that each was weighed rather than missed. None blocks the phase.

- **A running backfill occupies the Benchmark tool's sidecar for its whole duration — but only that one.** The sidecar's request loop is single-threaded and fully serial (P14§2 item 5), so while a multi-minute backfill runs, nothing else can be served by *that* process. It does **not** reach live analysis, chat, or the watchlist scan: `bootstrap.ts` already gives the Benchmark tool its own `SidecarSupervisor` and its own OS process, separate from the shared one every other feature uses, so a backfill cannot queue in front of an interactive request and no request-queueing machinery is needed to prevent it. What remains is confined to the Benchmark tool itself: the UI runs one benchmark at a time, and decision (xi)'s 30-minute timeout applies to the backfill request only, so a genuinely wedged backfill would take that long to self-surface. **Accepted, deliberately** — Stop is the real escape hatch (P14§7), and raising the *default* timeout globally would be strictly worse, making a hung interactive call take 30 minutes to surface instead of 30 seconds.
- **`CLOSED_DAY_LIMIT = 30` is a judgment call, not a proof** — the same species as P14§9's note on the ten-absent-day heuristic. An NSE closure lasting more than 30 consecutive weekdays (six calendar weeks) would be reported as "archive may not cover this far back" when the archive is in fact fine. No such closure has occurred; the alternative (no bound at all) is the defect this decision exists to remove.
- **A `("day", "kite")` benchmark entry gets no backfill at all** (decision (viii)). It runs exactly as it does today, including the confusing empty result when that partition is thin. Backfilling it means giving the Benchmark tool a live Kite dependency, which P14§1's "pure local-lake reader" framing rules out for this phase.

## File Structure

**New — `rust-core/crates/ingestion/`:**
- `src/backfill.rs` — `POLITENESS_DELAY_MS`, `CLOSED_DAY_LIMIT`, `TradingDay`, `WalkStop`, `DayOutcome`, `fetch_trading_day`, `walk_trading_days_backward`. Day-sequencing policy only: no network, no sleep, no lake writes.
- `tests/backfill_test.rs` — the walker's and `fetch_trading_day`'s tests, all with injected fetch closures.

**New — `rust-core/crates/sidecar/`:**
- `src/day_backfill.rs` — `BACKFILL_TIMEFRAME`, `BACKFILL_SOURCE`, `ABSENT_DAY_LIMIT`, `handle_ensure_day_backfill`, plus its `mod tests`.

**Modified — Rust:**
- `crates/ingestion/src/error.rs` — `IngestionError::NotFound`.
- `crates/ingestion/src/io.rs` — `error_for_http_status`; `fetch_udiff_bhavcopy` inspects the status before erasing it; new `mod tests`.
- `crates/ingestion/src/time.rs` — private `ist_offset()`, new `ist_date_from_epoch`; new `mod tests`.
- `crates/ingestion/src/lib.rs` — `pub mod backfill;`.
- `crates/ingestion/src/bin/ingest.rs` — `run_bhavcopy`'s loop extracted into a testable `ingest_day_range` built on `fetch_trading_day`; new tests in its existing `mod tests`.
- `crates/sidecar/Cargo.toml` — `ingestion = { path = "../ingestion" }`.
- `crates/sidecar/src/lib.rs` — `pub mod day_backfill;`.
- `crates/sidecar/src/protocol.rs` — `ProgressLine.index`/`.total`, `encode_progress_counted`, `EnsureDayBackfillRequest`, `DayBackfillResponse`, one arm each on `SidecarRequest`/`SidecarResponse`.
- `crates/sidecar/src/main.rs` — `request_id`/`request_step` arms, the dispatch arm with the real fetch closure and the counted-progress emitter.
- `crates/sidecar/tests/protocol_test.rs`, `crates/sidecar/tests/end_to_end_test.rs` — wire and end-to-end assertions.

**Modified — Electron main (`electron-app/src/main/`):**
- `services/sidecar/sidecarProtocol.ts` — `SidecarProgressWire.index`/`.total`, `DayBackfillResponseWire`, the `ensure_day_backfill` request variant, union membership.
- `services/sidecar/sidecarSupervisor.ts` — `BACKFILL_REQUEST_TIMEOUT_MS`, per-request `dayProgress` map, `ensureDayBackfill`, `send`'s optional timeout.
- `services/benchmark/benchmarkRunner.ts` — `BenchmarkProgress`, `BenchmarkResult.insufficientHistory`, the pre-flight call, the phased `onProgress`.
- `ipc/benchmarkBridge.ts` — `ensureDayBackfill` in the deps `Pick`; forwards the whole progress object.
- `ipc/rendererApi.ts` — `BenchmarkProgress` re-export; `onBenchmarkProgress`'s handler type.

**Modified — Renderer (`electron-app/src/renderer/`):**
- `BenchmarkView.tsx` — phase-aware progress pill label, `InsufficientHistory` banner branch. **`BenchmarkView.css` is deliberately not modified** — see Task 8.

**Modified — Tests (`electron-app/test/`):** `main/services/sidecar/sidecarSupervisor.test.ts`, `main/services/benchmark/benchmarkRunner.test.ts`, `main/ipc/benchmarkBridge.test.ts`, `renderer/BenchmarkView.test.tsx`. Each is named in its own task with an exact edit list.

## Task dependency order

```
Task 1 (IngestionError::NotFound + io.rs status)
   └─> Task 2 (backfill.rs: fetch_trading_day + walk_trading_days_backward)
         ├─> Task 3 (ingest CLI day-range loop)
         └─> Task 5 (sidecar EnsureDayBackfill)  <── Task 4 (counted progress lines)
                   └─> Task 6 (SidecarSupervisor.ensureDayBackfill)
                         └─> Task 7 (runBenchmark pre-flight + insufficientHistory)
                               └─> Task 8 (BenchmarkView pill + banner)
```

Task 3 is a leaf: nothing downstream depends on it, so it may be deferred or reviewed in parallel with Task 4/5 if convenient. Task 4 has no dependency on Tasks 1-3 and may be done first if a reviewer prefers; it must precede Task 5.

---

### Task 1: `IngestionError::NotFound` — a market holiday stops looking like an outage (P14§2 item 3, P14§4)

Today `fetch_udiff_bhavcopy` chains `.send().and_then(|r| r.error_for_status())` and maps *everything* to `IngestionError::Fetch(String)`. A 404 (the archive has no file for that date, i.e. it was not a trading day) and a 500 (the archive is down) are then indistinguishable to any caller — which is why the `ingest` CLI's comment at `ingest.rs:42-44` has to say "a weekday-holiday 404 surfaces as a hard fetch error". Everything else in this phase depends on that distinction being real, so it lands first and alone.

The status→error decision is extracted into a pure private helper so it can be tested without a network, a mock server, or a client trait (plan decision (iv)).

**Files:**
- Modify: `rust-core/crates/ingestion/src/error.rs:1-22`
- Modify: `rust-core/crates/ingestion/src/io.rs:27-48`

**Interfaces:**
- Consumes: nothing new.
- Produces: `IngestionError::NotFound` (a unit variant, `Display`s as `not found (404)`); `fetch_udiff_bhavcopy(date: NaiveDate, exchange: &str) -> Result<Vec<u8>, IngestionError>` — signature unchanged, but a 404 response now returns `Err(IngestionError::NotFound)` instead of `Err(IngestionError::Fetch(_))`.

- [ ] **Step 1: Write the failing tests** — append a new test module at the end of `rust-core/crates/ingestion/src/io.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_404_maps_to_not_found_so_a_market_holiday_is_distinguishable_from_an_outage() {
        assert!(matches!(
            error_for_http_status(404, "https://nsearchives.nseindia.com/x.zip"),
            Some(IngestionError::NotFound)
        ));
    }

    #[test]
    fn every_other_error_status_keeps_the_opaque_fetch_variant_with_the_status_and_url() {
        match error_for_http_status(500, "https://nsearchives.nseindia.com/x.zip") {
            Some(IngestionError::Fetch(message)) => {
                assert!(message.contains("500"), "message must name the status: {message}");
                assert!(message.contains("nsearchives"), "message must name the url: {message}");
            }
            other => panic!("expected Fetch for a 500, got {other:?}"),
        }
        assert!(matches!(error_for_http_status(403, "u"), Some(IngestionError::Fetch(_))));
        assert!(matches!(error_for_http_status(400, "u"), Some(IngestionError::Fetch(_))));
        assert!(matches!(error_for_http_status(599, "u"), Some(IngestionError::Fetch(_))));
    }

    #[test]
    fn success_and_redirect_statuses_produce_no_error_at_all() {
        assert!(error_for_http_status(200, "u").is_none());
        assert!(error_for_http_status(302, "u").is_none());
        assert!(error_for_http_status(399, "u").is_none());
    }

    #[test]
    fn not_found_has_its_own_display_text() {
        assert_eq!(IngestionError::NotFound.to_string(), "not found (404)");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `rust-core/`): `cargo test -p ingestion --lib`
Expected: FAIL to compile — `cannot find function 'error_for_http_status' in this scope` and `no variant named 'NotFound' found for enum 'IngestionError'`.

- [ ] **Step 3: Add the error variant** — in `rust-core/crates/ingestion/src/error.rs`, replace:

```rust
#[derive(Debug)]
pub enum IngestionError {
    Csv(csv::Error),
    MissingColumn(String),
    BadField { column: String, value: String },
    Io(std::io::Error),
    Storage(storage::StorageError),
    Fetch(String),
}
```

with:

```rust
#[derive(Debug)]
pub enum IngestionError {
    Csv(csv::Error),
    MissingColumn(String),
    BadField { column: String, value: String },
    Io(std::io::Error),
    Storage(storage::StorageError),
    Fetch(String),
    /// The archive has no file for this date. For a per-day bhavcopy URL that
    /// means "not a trading day", which a backward walk must skip rather than
    /// abort on -- a distinction Fetch(String) cannot carry (P14§2 item 3).
    NotFound,
}
```

and in the same file add the matching `Display` arm, replacing:

```rust
            IngestionError::Fetch(m) => write!(f, "fetch error: {m}"),
```

with:

```rust
            IngestionError::Fetch(m) => write!(f, "fetch error: {m}"),
            IngestionError::NotFound => write!(f, "not found (404)"),
```

- [ ] **Step 4: Inspect the status before erasing it** — in `rust-core/crates/ingestion/src/io.rs`, insert this helper immediately above `fetch_udiff_bhavcopy`'s doc comment (i.e. after `unzip_single_csv`):

```rust
/// reqwest's own `error_for_status` collapses every 4xx/5xx into one opaque
/// error, which is why this exists: 404 alone means "no file for this date",
/// and a backward trading-day walk must treat that as a skip, not a failure.
/// Pure so the contract is testable without a network or a mock server.
fn error_for_http_status(status: u16, url: &str) -> Option<IngestionError> {
    match status {
        404 => Some(IngestionError::NotFound),
        code if (400..600).contains(&code) => Some(IngestionError::Fetch(format!("HTTP {code} for {url}"))),
        _ => None,
    }
}
```

Then replace the request chain inside `fetch_udiff_bhavcopy` — this block:

```rust
    let resp = client
        .get(&url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| IngestionError::Fetch(e.to_string()))?;
```

with:

```rust
    let resp = client.get(&url).send().map_err(|e| IngestionError::Fetch(e.to_string()))?;
    if let Some(error) = error_for_http_status(resp.status().as_u16(), &url) {
        return Err(error);
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p ingestion`
Expected: PASS — the four new `io` unit tests plus every pre-existing `ingestion` test (`bhavcopy_parse_test`, `importer_test`, `indices_parse_test`, `intraday_parse_test`, `ingest_cli_test`, and `ingest.rs`'s `parse_date` test). `fetch_smoke_test`'s one test stays `#[ignore]`d and is not run.

- [ ] **Step 6: Confirm nothing else matched on `IngestionError` exhaustively**

Run: `cargo build --workspace 2>&1 | grep -i "non-exhaustive\|patterns.*not covered" || echo "no exhaustive-match breakage"`
Expected: `no exhaustive-match breakage`. (`IngestionError` is matched exhaustively only by its own `Display` impl, which Step 3 already extended; every other site uses `?` or `map_err`.)

- [ ] **Step 7: Commit**

```bash
git add rust-core/crates/ingestion/src/error.rs rust-core/crates/ingestion/src/io.rs
git commit -m "feat(ingestion): distinguish a holiday 404 from a real bhavcopy fetch failure"
```

---

### Task 2: `backfill.rs` — the shared trading-day primitives (P14§4)

The heart of the phase. Two functions, no network of their own: `fetch_trading_day` answers "was this a trading day, and if so what were its bytes?" given an injected fetcher, and `walk_trading_days_backward` walks calendar days backward from a start date, handing every *real* trading day's row for one symbol to a caller-supplied callback that decides when to stop.

The walker carries **its own** stop condition on top of the caller's, because the caller's only fires on a successful fetch: `CLOSED_DAY_LIMIT` consecutive weekday 404s end the walk with `WalkStop::ArchiveExhausted`, which is what keeps a walk that runs off the end of the archive's coverage from spinning backward forever (decision (xviii)). Any successful fetch resets that counter.

The fetcher signature is `FnMut(&str, NaiveDate)` — exchange first, date second — deliberately: the real implementation in Task 5 is then literally `|exchange, date| fetch_udiff_bhavcopy(date, exchange)`, with no need for the caller to know or duplicate the exchange the walk derived from the symbol.

**Files:**
- Create: `rust-core/crates/ingestion/src/backfill.rs`
- Modify: `rust-core/crates/ingestion/src/lib.rs:1-9`
- Create: `rust-core/crates/ingestion/tests/backfill_test.rs`

**Interfaces:**
- Consumes: `IngestionError::NotFound` (Task 1); `crate::bhavcopy::parse_udiff_equity_bhavcopy`; `crate::model::ParsedCandle`.
- Produces:
  - `pub const POLITENESS_DELAY_MS: u64 = 200;`
  - `pub const CLOSED_DAY_LIMIT: usize = 30;`
  - `pub enum TradingDay { Traded(Vec<u8>), Closed }`
  - `pub enum WalkStop { CallerStopped, ArchiveExhausted }`
  - `pub struct DayOutcome { pub date: NaiveDate, pub candle: Option<ParsedCandle> }`
  - `pub fn fetch_trading_day(exchange: &str, date: NaiveDate, fetch: &mut dyn FnMut(&str, NaiveDate) -> Result<Vec<u8>, IngestionError>) -> Result<TradingDay, IngestionError>`
  - `pub fn walk_trading_days_backward(exchange: &str, symbol: &str, start: NaiveDate, fetch: &mut dyn FnMut(&str, NaiveDate) -> Result<Vec<u8>, IngestionError>, on_day: &mut dyn FnMut(DayOutcome) -> ControlFlow<()>) -> Result<WalkStop, IngestionError>`

- [ ] **Step 1: Write the failing tests** — create `rust-core/crates/ingestion/tests/backfill_test.rs`:

```rust
use chrono::{Datelike, NaiveDate, Weekday};
use ingestion::backfill::{
    fetch_trading_day, walk_trading_days_backward, DayOutcome, TradingDay, WalkStop, CLOSED_DAY_LIMIT,
};
use ingestion::error::IngestionError;
use ingestion::time::ist_session_close_epoch;
use std::ops::ControlFlow;

fn date(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).expect("test dates are valid")
}

// The shared fixture's TradDt is hardcoded to 2024-01-15, which would give
// every walked day the same candle ts; these tests stamp the walked date in.
fn bhavcopy_csv(day: NaiveDate, symbols: &[&str]) -> Vec<u8> {
    let mut out = String::from(
        "TradDt,FinInstrmTp,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd\n",
    );
    for symbol in symbols {
        out.push_str(&format!("{day},STK,{symbol},EQ,10.0,11.0,9.0,10.5,10.5,10.0,1000,10500.0,7\n"));
    }
    out.into_bytes()
}

#[test]
fn a_weekend_day_is_closed_without_any_network_attempt() {
    let mut attempts: Vec<NaiveDate> = Vec::new();
    let mut fetch = |_exchange: &str, d: NaiveDate| {
        attempts.push(d);
        Ok(bhavcopy_csv(d, &["INFY"]))
    };
    // 2024-01-13 is a Saturday, 2024-01-14 a Sunday.
    assert!(matches!(fetch_trading_day("NSE", date(2024, 1, 13), &mut fetch), Ok(TradingDay::Closed)));
    assert!(matches!(fetch_trading_day("NSE", date(2024, 1, 14), &mut fetch), Ok(TradingDay::Closed)));
    assert!(attempts.is_empty(), "weekends must never reach the network");
}

#[test]
fn a_404_is_closed_and_a_non_404_error_propagates() {
    let mut fetch_404 = |_e: &str, _d: NaiveDate| Err(IngestionError::NotFound);
    assert!(matches!(fetch_trading_day("NSE", date(2024, 1, 15), &mut fetch_404), Ok(TradingDay::Closed)));

    let mut fetch_500 = |_e: &str, _d: NaiveDate| Err(IngestionError::Fetch("boom".to_string()));
    match fetch_trading_day("NSE", date(2024, 1, 15), &mut fetch_500) {
        Err(IngestionError::Fetch(m)) => assert_eq!(m, "boom"),
        other => panic!("a non-404 must propagate, got {other:?}"),
    }
}

#[test]
fn a_successful_weekday_fetch_is_traded_and_carries_the_bytes_through() {
    let mut fetch = |_e: &str, d: NaiveDate| Ok(bhavcopy_csv(d, &["INFY"]));
    match fetch_trading_day("NSE", date(2024, 1, 15), &mut fetch) {
        Ok(TradingDay::Traded(bytes)) => {
            assert!(String::from_utf8(bytes).unwrap().contains("2024-01-15"));
        }
        other => panic!("expected Traded, got {other:?}"),
    }
}

#[test]
fn the_walk_visits_consecutive_trading_days_backward_and_never_fetches_a_weekend() {
    let mut attempts: Vec<NaiveDate> = Vec::new();
    let mut fetch = |_e: &str, d: NaiveDate| {
        attempts.push(d);
        Ok(bhavcopy_csv(d, &["INFY"]))
    };
    let mut visited: Vec<NaiveDate> = Vec::new();
    let mut on_day = |outcome: DayOutcome| {
        visited.push(outcome.date);
        if visited.len() == 3 { ControlFlow::Break(()) } else { ControlFlow::Continue(()) }
    };

    let stop =
        walk_trading_days_backward("NSE", "NSE:INFY", date(2024, 1, 15), &mut fetch, &mut on_day).unwrap();

    assert_eq!(stop, WalkStop::CallerStopped);
    // Mon 15 -> (Sun 14, Sat 13 skipped with no fetch) -> Fri 12 -> Thu 11.
    assert_eq!(visited, vec![date(2024, 1, 15), date(2024, 1, 12), date(2024, 1, 11)]);
    assert_eq!(attempts, visited);
}

#[test]
fn an_archive_that_404s_on_every_weekday_ends_the_walk_at_the_cap_instead_of_looping_forever() {
    // The defect CLOSED_DAY_LIMIT exists for: `on_day` only ever runs for a
    // fetched day, so with the callback as the walk's only exit an archive that
    // has stopped answering -- walked past its coverage, or its URL format
    // changed -- would step backward one weekday at a time forever, wedging the
    // serial sidecar until the user hits Stop. If this test hangs, the walk has
    // no bound of its own and the cap is not wired up.
    let mut attempts: Vec<NaiveDate> = Vec::new();
    let mut fetch = |_e: &str, d: NaiveDate| -> Result<Vec<u8>, IngestionError> {
        attempts.push(d);
        Err(IngestionError::NotFound)
    };
    let mut visited: Vec<NaiveDate> = Vec::new();
    // Deliberately never breaks -- the walk must terminate on its own.
    let mut on_day = |outcome: DayOutcome| {
        visited.push(outcome.date);
        ControlFlow::Continue(())
    };

    let stop =
        walk_trading_days_backward("NSE", "NSE:INFY", date(2024, 1, 15), &mut fetch, &mut on_day).unwrap();

    assert_eq!(stop, WalkStop::ArchiveExhausted, "the walk must report WHY it stopped");
    assert!(visited.is_empty(), "a closed day never reaches the callback");
    // Exactly the cap and not one request more. Thirty weekdays back from Mon
    // 2024-01-15 lands on Tue 2023-12-05; no weekend is ever attempted, so
    // weekends cannot pad the count toward the cap either.
    assert_eq!(attempts.len(), CLOSED_DAY_LIMIT);
    assert_eq!(attempts.first(), Some(&date(2024, 1, 15)));
    assert_eq!(attempts.last(), Some(&date(2023, 12, 5)));
    assert!(attempts.iter().all(|d| !matches!(d.weekday(), Weekday::Sat | Weekday::Sun)));
}

#[test]
fn one_successful_fetch_resets_the_closed_day_streak() {
    // A scattered mid-history holiday must not accumulate toward the cap.
    // Tue 2023-12-26 is the 15th weekday back from Mon 2024-01-15.
    let traded = date(2023, 12, 26);
    let mut attempts: Vec<NaiveDate> = Vec::new();
    let mut fetch = |_e: &str, d: NaiveDate| -> Result<Vec<u8>, IngestionError> {
        attempts.push(d);
        if d == traded {
            Ok(bhavcopy_csv(d, &["INFY"]))
        } else {
            Err(IngestionError::NotFound)
        }
    };
    let mut visited: Vec<NaiveDate> = Vec::new();
    let mut on_day = |outcome: DayOutcome| {
        visited.push(outcome.date);
        ControlFlow::Continue(())
    };

    let stop =
        walk_trading_days_backward("NSE", "NSE:INFY", date(2024, 1, 15), &mut fetch, &mut on_day).unwrap();

    assert_eq!(stop, WalkStop::ArchiveExhausted);
    assert_eq!(visited, vec![traded]);
    // 14 closed weekdays, then the traded one (streak -> 0), then a full fresh
    // CLOSED_DAY_LIMIT run. Without the reset the walk would have stopped after
    // 31 attempts, when the 30th cumulative 404 landed.
    assert_eq!(attempts.len(), 15 + CLOSED_DAY_LIMIT);
}

#[test]
fn a_holiday_404_is_skipped_without_reaching_the_callback_but_is_still_attempted() {
    let mut attempts: Vec<NaiveDate> = Vec::new();
    let mut fetch = |_e: &str, d: NaiveDate| {
        attempts.push(d);
        if d == date(2024, 1, 12) { Err(IngestionError::NotFound) } else { Ok(bhavcopy_csv(d, &["INFY"])) }
    };
    let mut visited: Vec<NaiveDate> = Vec::new();
    let mut on_day = |outcome: DayOutcome| {
        visited.push(outcome.date);
        if visited.len() == 3 { ControlFlow::Break(()) } else { ControlFlow::Continue(()) }
    };

    walk_trading_days_backward("NSE", "NSE:INFY", date(2024, 1, 15), &mut fetch, &mut on_day).unwrap();

    assert_eq!(visited, vec![date(2024, 1, 15), date(2024, 1, 11), date(2024, 1, 10)]);
    // The holiday WAS attempted -- only weekends are free.
    assert_eq!(
        attempts,
        vec![date(2024, 1, 15), date(2024, 1, 12), date(2024, 1, 11), date(2024, 1, 10)]
    );
}

#[test]
fn a_non_404_error_stops_the_walk_and_propagates_even_when_the_callback_never_breaks() {
    let mut fetch = |_e: &str, d: NaiveDate| {
        if d == date(2024, 1, 12) {
            Err(IngestionError::Fetch("network down".to_string()))
        } else {
            Ok(bhavcopy_csv(d, &["INFY"]))
        }
    };
    let mut visited: Vec<NaiveDate> = Vec::new();
    let mut on_day = |outcome: DayOutcome| {
        visited.push(outcome.date);
        ControlFlow::Continue(())
    };

    match walk_trading_days_backward("NSE", "NSE:INFY", date(2024, 1, 15), &mut fetch, &mut on_day) {
        Err(IngestionError::Fetch(m)) => assert_eq!(m, "network down"),
        other => panic!("expected the fetch error to propagate, got {other:?}"),
    }
    assert_eq!(visited, vec![date(2024, 1, 15)], "the walk stops at the failing day");
}

#[test]
fn a_day_whose_file_has_no_row_for_the_target_symbol_reports_a_none_candle() {
    let mut fetch = |_e: &str, d: NaiveDate| Ok(bhavcopy_csv(d, &["TCS", "RELIANCE"]));
    let mut outcomes: Vec<DayOutcome> = Vec::new();
    let mut on_day = |outcome: DayOutcome| {
        outcomes.push(outcome);
        ControlFlow::Break(())
    };

    walk_trading_days_backward("NSE", "NSE:ZYDUSWELL", date(2024, 1, 15), &mut fetch, &mut on_day).unwrap();

    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].date, date(2024, 1, 15));
    assert!(outcomes[0].candle.is_none(), "absence is a None candle on a real trading day, not an error");
}

#[test]
fn a_present_symbol_is_parsed_with_the_walked_days_own_session_close_timestamp() {
    let mut fetch = |_e: &str, d: NaiveDate| Ok(bhavcopy_csv(d, &["TCS", "INFY"]));
    let mut outcomes: Vec<DayOutcome> = Vec::new();
    let mut on_day = |outcome: DayOutcome| {
        outcomes.push(outcome);
        ControlFlow::Break(())
    };

    walk_trading_days_backward("NSE", "NSE:INFY", date(2024, 1, 15), &mut fetch, &mut on_day).unwrap();

    let parsed = outcomes[0].candle.as_ref().expect("INFY is present in this day's file");
    assert_eq!(parsed.symbol, "NSE:INFY");
    assert_eq!(parsed.timeframe, "day");
    // The ts comes from the file's own TradDt, which is authoritative.
    assert_eq!(parsed.candle.ts, ist_session_close_epoch(date(2024, 1, 15)));
    assert_eq!(parsed.candle.close, 10.5);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `rust-core/`): `cargo test -p ingestion --test backfill_test`
Expected: FAIL to compile — `unresolved import 'ingestion::backfill'`.

If `rustc` instead complains it cannot infer a type parameter for one of the `Ok(bhavcopy_csv(...))` closures, annotate that closure's return explicitly — `|_e: &str, d: NaiveDate| -> Result<Vec<u8>, IngestionError> { ... }` — rather than changing the test's shape. The same annotation is the fix anywhere else in Tasks 3 and 5 where a fetch closure's error type is only pinned by its coercion site.

- [ ] **Step 3: Write the primitives** — create `rust-core/crates/ingestion/src/backfill.rs`:

```rust
use crate::bhavcopy::parse_udiff_equity_bhavcopy;
use crate::error::IngestionError;
use crate::model::ParsedCandle;
use chrono::{Datelike, NaiveDate, Weekday};
use std::ops::ControlFlow;

/// Gap between two anonymous requests to NSE's public archive. A from-scratch
/// 512-bar backfill is ~750 requests; back-to-back they read as a scrape to any
/// rate limiter in front of the archive (P14§2 item 6). Callers own the actual
/// sleep -- this module stays free of timing I/O so its tests run instantly.
pub const POLITENESS_DELAY_MS: u64 = 200;

/// Consecutive *weekday* 404s before the walk concludes the archive itself has
/// stopped answering -- walked past the archive's coverage, or its URL format
/// changed (P14§9). Weekends never reach the network and never count. The
/// longest real NSE closure is a handful of consecutive weekdays, so 30 (six
/// calendar weeks) is generous against any genuine holiday cluster while still
/// bounding the worst case to 30 wasted requests, ~6s at POLITENESS_DELAY_MS,
/// instead of an unbounded backward walk. Deliberately separate from the
/// sidecar's ABSENT_DAY_LIMIT: that one counts days the *symbol* is missing
/// from a file that was fetched successfully (decision (xviii)).
pub const CLOSED_DAY_LIMIT: usize = 30;

/// One calendar day, after the "was the market open?" question is settled.
#[derive(Debug)]
pub enum TradingDay {
    Traded(Vec<u8>),
    Closed,
}

/// Why a walk ended. Both are ordinary, non-error outcomes -- a real failure
/// comes back as `Err` instead.
#[derive(Debug, PartialEq, Eq)]
pub enum WalkStop {
    /// `on_day` returned `ControlFlow::Break`: the caller got what it wanted.
    CallerStopped,
    /// `CLOSED_DAY_LIMIT` weekdays in a row had no file. The caller cannot tell
    /// from here whether the archive stopped covering these dates or stopped
    /// working, so it must not report this as "the symbol has no more history".
    ArchiveExhausted,
}

/// One real trading day's result for a single symbol.
#[derive(Debug)]
pub struct DayOutcome {
    pub date: NaiveDate,
    /// `None` when the day's file carries no EQ row for this symbol -- the
    /// signal the caller counts toward "this symbol isn't listed that far
    /// back" (P14§2 item 4).
    pub candle: Option<ParsedCandle>,
}

/// The single place that decides whether a calendar day is a trading day.
/// Weekends are answered without a network attempt; a 404 means the archive
/// has no file for that date, i.e. a market holiday (P14§2 item 3).
pub fn fetch_trading_day(
    exchange: &str,
    date: NaiveDate,
    fetch: &mut dyn FnMut(&str, NaiveDate) -> Result<Vec<u8>, IngestionError>,
) -> Result<TradingDay, IngestionError> {
    if matches!(date.weekday(), Weekday::Sat | Weekday::Sun) {
        return Ok(TradingDay::Closed);
    }
    match fetch(exchange, date) {
        Ok(bytes) => Ok(TradingDay::Traded(bytes)),
        Err(IngestionError::NotFound) => Ok(TradingDay::Closed),
        Err(e) => Err(e),
    }
}

/// Walk calendar days backward from `start`, handing every real trading day's
/// row for `symbol` to `on_day`.
///
/// Two independent exits, because the caller's is not enough on its own:
/// `on_day` returning `ControlFlow::Break` (the caller is satisfied), and
/// `CLOSED_DAY_LIMIT` consecutive weekday 404s. `on_day` is invoked ONLY for a
/// successfully fetched day, so without the second exit a stretch of days the
/// archive has no files for would advance no stop condition at all and the walk
/// would step backward forever (decision (xviii)).
pub fn walk_trading_days_backward(
    exchange: &str,
    symbol: &str,
    start: NaiveDate,
    fetch: &mut dyn FnMut(&str, NaiveDate) -> Result<Vec<u8>, IngestionError>,
    on_day: &mut dyn FnMut(DayOutcome) -> ControlFlow<()>,
) -> Result<WalkStop, IngestionError> {
    let mut date = start;
    let mut consecutive_closed = 0usize;
    loop {
        match fetch_trading_day(exchange, date, fetch)? {
            TradingDay::Traded(bytes) => {
                consecutive_closed = 0;
                let candle = parse_udiff_equity_bhavcopy(&bytes, exchange)?
                    .into_iter()
                    .find(|parsed| parsed.symbol == symbol);
                if on_day(DayOutcome { date, candle }).is_break() {
                    return Ok(WalkStop::CallerStopped);
                }
            }
            // A weekend is Closed without a request, so only a weekday Closed
            // is evidence about the archive.
            TradingDay::Closed if !matches!(date.weekday(), Weekday::Sat | Weekday::Sun) => {
                consecutive_closed += 1;
                if consecutive_closed >= CLOSED_DAY_LIMIT {
                    return Ok(WalkStop::ArchiveExhausted);
                }
            }
            TradingDay::Closed => {}
        }
        date = date
            .pred_opt()
            .ok_or_else(|| IngestionError::Fetch("walked past the earliest representable date".to_string()))?;
    }
}
```

- [ ] **Step 4: Register the module** — in `rust-core/crates/ingestion/src/lib.rs`, replace:

```rust
pub mod bhavcopy;
pub mod csv_util;
```

with:

```rust
pub mod backfill;
pub mod bhavcopy;
pub mod csv_util;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p ingestion`
Expected: PASS — all ten new `backfill_test` tests plus every pre-existing `ingestion` test. The all-404 test is the one that matters most: if it **hangs** rather than fails, the closed-day cap is missing or is being reset by something other than a successful fetch.

- [ ] **Step 6: Commit**

```bash
git add rust-core/crates/ingestion/src/backfill.rs rust-core/crates/ingestion/src/lib.rs rust-core/crates/ingestion/tests/backfill_test.rs
git commit -m "feat(ingestion): holiday-aware trading-day fetch and backward walk primitives"
```

---

### Task 3: `ingest` CLI's day-range loop moves onto `fetch_trading_day` (P14§4)

`run_bhavcopy`'s loop (`ingest.rs:39-57`) hand-rolls its own weekend check and treats a weekday-holiday 404 as a fatal error. After this task it calls `fetch_trading_day`, so weekday holidays are skipped for the same reason weekends are, and the "what is a trading day" decision exists in exactly one place.

To make this TDD-able at all, the loop is first extracted into `ingest_day_range`, which takes an injected fetch closure. `run_bhavcopy` keeps its argument parsing, wires the real `fetch_udiff_bhavcopy`, and prints the same final summary line it prints today. The CLI's flags, per-day message format, and summary line are unchanged (plan decision (iii)).

This task is a leaf — nothing downstream depends on it. It uses `fetch_trading_day` only, never `walk_trading_days_backward`, so decision (xviii)'s closed-day cap does not apply here and nothing in this task changes because of it: the CLI's loop is forward and bounded by `--to`, so it terminates by construction no matter how many days 404.

**Files:**
- Modify: `rust-core/crates/ingestion/src/bin/ingest.rs:1-8` (imports), `:32-60` (`run_bhavcopy`), `:101-111` (`mod tests`)

**Interfaces:**
- Consumes: `ingestion::backfill::{fetch_trading_day, TradingDay}` (Task 2); `ingestion::error::IngestionError` (Task 1).
- Produces: `fn ingest_day_range(store: &CandleStore, exchange: &str, from: NaiveDate, to: NaiveDate, fetch: &mut dyn FnMut(&str, NaiveDate) -> Result<Vec<u8>, IngestionError>) -> Result<usize, Box<dyn Error>>` — private to the bin; `run_bhavcopy`'s signature is unchanged.

- [ ] **Step 1: Write the failing tests** — in `rust-core/crates/ingestion/src/bin/ingest.rs`, replace the entire existing `mod tests` block:

```rust
#[cfg(test)]
mod tests {
    use super::parse_date;

    #[test]
    fn parse_date_accepts_iso_and_rejects_garbage() {
        assert_eq!(parse_date("2024-01-15").unwrap(), chrono::NaiveDate::from_ymd_opt(2024, 1, 15).unwrap());
        assert!(parse_date("15/01/2024").is_err());
        assert!(parse_date("not-a-date").is_err());
    }
}
```

with:

```rust
#[cfg(test)]
mod tests {
    use super::{ingest_day_range, parse_date};
    use chrono::NaiveDate;
    use ingestion::error::IngestionError;
    use storage::CandleStore;
    use tempfile::tempdir;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).expect("test dates are valid")
    }

    // Per-date TradDt: the shared fixture's is hardcoded, and write_sourced_candles
    // merges on ts, so a fixed date would collapse every day into one candle.
    fn bhavcopy_csv(day: NaiveDate, symbols: &[&str]) -> Vec<u8> {
        let mut out = String::from(
            "TradDt,FinInstrmTp,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd\n",
        );
        for symbol in symbols {
            out.push_str(&format!("{day},STK,{symbol},EQ,10.0,11.0,9.0,10.5,10.5,10.0,1000,10500.0,7\n"));
        }
        out.into_bytes()
    }

    #[test]
    fn parse_date_accepts_iso_and_rejects_garbage() {
        assert_eq!(parse_date("2024-01-15").unwrap(), chrono::NaiveDate::from_ymd_opt(2024, 1, 15).unwrap());
        assert!(parse_date("15/01/2024").is_err());
        assert!(parse_date("not-a-date").is_err());
    }

    #[test]
    fn a_weekday_holiday_404_is_skipped_instead_of_aborting_the_whole_range() {
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            if d == date(2024, 1, 12) {
                Err(IngestionError::NotFound)
            } else {
                Ok(bhavcopy_csv(d, &["INFY", "TCS"]))
            }
        };

        let total =
            ingest_day_range(&store, "NSE", date(2024, 1, 11), date(2024, 1, 15), &mut fetch).unwrap();

        // Thu 11 imported, Fri 12 a holiday, Sat 13 / Sun 14 never attempted, Mon 15 imported.
        assert_eq!(attempts, vec![date(2024, 1, 11), date(2024, 1, 12), date(2024, 1, 15)]);
        assert_eq!(total, 4, "two EQ rows on each of the two traded days");
        assert_eq!(store.read_sourced_candles("NSE:INFY", "day", "bhavcopy").unwrap().len(), 2);
    }

    #[test]
    fn weekends_are_skipped_with_no_network_attempt_at_all() {
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["INFY"]))
        };

        let total = ingest_day_range(&store, "NSE", date(2024, 1, 13), date(2024, 1, 14), &mut fetch).unwrap();

        assert!(attempts.is_empty());
        assert_eq!(total, 0);
    }

    #[test]
    fn a_non_404_fetch_error_still_aborts_the_range_but_keeps_the_days_already_written() {
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let mut fetch = |_e: &str, d: NaiveDate| {
            if d == date(2024, 1, 12) {
                Err(IngestionError::Fetch("network down".to_string()))
            } else {
                Ok(bhavcopy_csv(d, &["INFY"]))
            }
        };

        let error = ingest_day_range(&store, "NSE", date(2024, 1, 11), date(2024, 1, 15), &mut fetch)
            .expect_err("a non-404 must still abort the run");
        assert!(error.to_string().contains("network down"), "got {error}");
        // The run is rerunnable for the failing date: Thursday's write survived.
        assert_eq!(store.read_sourced_candles("NSE:INFY", "day", "bhavcopy").unwrap().len(), 1);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `rust-core/`): `cargo test -p ingestion --bin ingest`
Expected: FAIL to compile — `cannot find function 'ingest_day_range' in the crate root`.

- [ ] **Step 3: Extract the loop onto `fetch_trading_day`** — in `rust-core/crates/ingestion/src/bin/ingest.rs`, replace the import block:

```rust
use chrono::{Datelike, NaiveDate, Weekday};
use ingestion::importer::{import_bhavcopy_files, import_intraday_files};
use ingestion::io::fetch_udiff_bhavcopy;
```

with:

```rust
use chrono::NaiveDate;
use ingestion::backfill::{fetch_trading_day, TradingDay};
use ingestion::error::IngestionError;
use ingestion::importer::{import_bhavcopy_files, import_intraday_files};
use ingestion::io::fetch_udiff_bhavcopy;
```

(`Datelike` and `Weekday` were used only by the weekday check this task deletes — `ingest.rs:45` is their sole use site.)

Then replace the whole of `run_bhavcopy`:

```rust
fn run_bhavcopy(store: &CandleStore, args: &HashMap<String, String>) -> Result<(), Box<dyn Error>> {
    let exchange = arg(args, "exchange")?;
    let from = parse_date(&arg(args, "from")?)?;
    let to = parse_date(&arg(args, "to")?)?;
    if to < from {
        return Err(format!("--to {to} is before --from {from}").into());
    }
    let mut date = from;
    let mut total = 0usize;
    loop {
        // Weekends are never trading days, so a fetch would always 404 -- skip
        // them without a network attempt. A weekday-holiday 404 surfaces as a
        // hard fetch error below (P6§13): the run is rerunnable for that date.
        if !matches!(date.weekday(), Weekday::Sat | Weekday::Sun) {
            let bytes = fetch_udiff_bhavcopy(date, &exchange)
                .map_err(|e| format!("fetch failed for {date} {exchange}: {e}"))?;
            let n = import_bhavcopy_files(store, &exchange, &[bytes])
                .map_err(|e| format!("import failed for {date} {exchange}: {e}"))?;
            eprintln!("ingested {n} candles for {date} {exchange}");
            total += n;
        }
        if date == to {
            break;
        }
        date = date.succ_opt().ok_or("date overflow")?;
    }
    eprintln!("done: {total} candles across [{from}, {to}] {exchange}");
    Ok(())
}
```

with:

```rust
fn ingest_day_range(
    store: &CandleStore,
    exchange: &str,
    from: NaiveDate,
    to: NaiveDate,
    fetch: &mut dyn FnMut(&str, NaiveDate) -> Result<Vec<u8>, IngestionError>,
) -> Result<usize, Box<dyn Error>> {
    let mut date = from;
    let mut total = 0usize;
    loop {
        let day = fetch_trading_day(exchange, date, fetch)
            .map_err(|e| format!("fetch failed for {date} {exchange}: {e}"))?;
        if let TradingDay::Traded(bytes) = day {
            let n = import_bhavcopy_files(store, exchange, &[bytes])
                .map_err(|e| format!("import failed for {date} {exchange}: {e}"))?;
            eprintln!("ingested {n} candles for {date} {exchange}");
            total += n;
        }
        if date == to {
            break;
        }
        date = date.succ_opt().ok_or("date overflow")?;
    }
    Ok(total)
}

fn run_bhavcopy(store: &CandleStore, args: &HashMap<String, String>) -> Result<(), Box<dyn Error>> {
    let exchange = arg(args, "exchange")?;
    let from = parse_date(&arg(args, "from")?)?;
    let to = parse_date(&arg(args, "to")?)?;
    if to < from {
        return Err(format!("--to {to} is before --from {from}").into());
    }
    let mut fetch = |exchange: &str, date: NaiveDate| fetch_udiff_bhavcopy(date, exchange);
    let total = ingest_day_range(store, &exchange, from, to, &mut fetch)?;
    eprintln!("done: {total} candles across [{from}, {to}] {exchange}");
    Ok(())
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p ingestion`
Expected: PASS — the three new `ingest` bin tests plus `parse_date_accepts_iso_and_rejects_garbage`, plus every pre-existing `ingestion` test including `ingest_cli_test`'s two (which exercise `--mode intraday` and a missing flag, neither touched here).

- [ ] **Step 5: Confirm the CLI's surface really is unchanged**

Run: `git diff rust-core/crates/ingestion/src/bin/ingest.rs | grep '^[-+].*eprintln!'`
Expected: the `ingested {n} candles for {date} {exchange}` and `done: {total} candles across [{from}, {to}] {exchange}` lines appear once as a removal and once as an identical addition (they moved between functions). No message text differs. The `USAGE` constant is untouched.

- [ ] **Step 6: Commit**

```bash
git add rust-core/crates/ingestion/src/bin/ingest.rs
git commit -m "refactor(ingest): share the trading-day decision, skip weekday holidays"
```

---

### Task 4: Sidecar progress lines can carry a count (P14§5, P14§6)

P14§5's progress shape carries no numbers, but P14§6's UI needs "143/256 days". Rather than inventing a second channel, `ProgressLine` gains two `Option` fields that are omitted from the JSON when absent, so every progress line the sidecar emits today stays byte-identical and the TypeScript side can tell a counted line from an uncounted one by `index !== undefined` (plan decision (v)).

No dependency on Tasks 1-3; must precede Task 5.

**Files:**
- Modify: `rust-core/crates/sidecar/src/protocol.rs:272-288` (`ProgressLine` + `encode_progress`), `:290-355` (`mod tests`)

**Interfaces:**
- Consumes: nothing.
- Produces: `ProgressLine { r#type, id, step, status, index: Option<usize>, total: Option<usize> }`; `encode_progress(id: u64, step: &str, status: &str) -> String` (behavior unchanged); `encode_progress_counted(id: u64, step: &str, status: &str, index: usize, total: usize) -> String`.

- [ ] **Step 1: Write the failing tests** — in `rust-core/crates/sidecar/src/protocol.rs`'s `mod tests`, append after the existing `encode_progress_emits_a_single_line_progress_object` test:

```rust
    #[test]
    fn encode_progress_omits_the_count_fields_so_every_existing_line_stays_byte_identical() {
        let line = encode_progress(7, "compute", "running");
        assert!(!line.contains("index"), "an uncounted step must not gain an index key: {line}");
        assert!(!line.contains("total"), "an uncounted step must not gain a total key: {line}");
        assert_eq!(
            line,
            r#"{"type":"progress","id":7,"step":"compute","status":"running"}"#
        );
    }

    #[test]
    fn encode_progress_counted_carries_the_day_index_and_total_alongside_the_step() {
        let line = encode_progress_counted(9, "backfill", "running", 143, 256);
        assert!(line.contains("\"type\":\"progress\""));
        assert!(line.contains("\"id\":9"));
        assert!(line.contains("\"step\":\"backfill\""));
        assert!(line.contains("\"status\":\"running\""));
        assert!(line.contains("\"index\":143"));
        assert!(line.contains("\"total\":256"));
        assert!(!line.contains('\n'));
    }

    #[test]
    fn encode_progress_counted_reports_a_zero_denominator_rather_than_omitting_it() {
        // A symbol that needs nothing still emits a well-formed counted line if
        // anything ever walks zero days -- Some(0) is not None.
        let line = encode_progress_counted(9, "backfill", "running", 0, 0);
        assert!(line.contains("\"index\":0"));
        assert!(line.contains("\"total\":0"));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `rust-core/`): `cargo test -p sidecar --lib`
Expected: FAIL to compile — `cannot find function 'encode_progress_counted' in this scope`.

- [ ] **Step 3: Add the optional counts** — in `rust-core/crates/sidecar/src/protocol.rs`, replace:

```rust
#[derive(Debug, Serialize)]
pub struct ProgressLine {
    pub r#type: &'static str,
    pub id: u64,
    pub step: String,
    pub status: String,
}

pub fn encode_progress(id: u64, step: &str, status: &str) -> String {
    serde_json::to_string(&ProgressLine {
        r#type: "progress",
        id,
        step: step.to_string(),
        status: status.to_string(),
    })
    .expect("ProgressLine always serializes")
}
```

with:

```rust
#[derive(Debug, Serialize)]
pub struct ProgressLine {
    pub r#type: &'static str,
    pub id: u64,
    pub step: String,
    pub status: String,
    /// Present only for a step that can say "N of M" -- today just the day
    /// backfill walk. Skipped when absent so every pre-existing progress line
    /// is byte-for-byte what it was before (P14§5).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
}

pub fn encode_progress(id: u64, step: &str, status: &str) -> String {
    serde_json::to_string(&ProgressLine {
        r#type: "progress",
        id,
        step: step.to_string(),
        status: status.to_string(),
        index: None,
        total: None,
    })
    .expect("ProgressLine always serializes")
}

pub fn encode_progress_counted(id: u64, step: &str, status: &str, index: usize, total: usize) -> String {
    serde_json::to_string(&ProgressLine {
        r#type: "progress",
        id,
        step: step.to_string(),
        status: status.to_string(),
        index: Some(index),
        total: Some(total),
    })
    .expect("ProgressLine always serializes")
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p sidecar`
Expected: PASS — the three new tests, the pre-existing `encode_progress_emits_a_single_line_progress_object`, and every test in `protocol_test.rs`, `handlers.rs`, and `end_to_end_test.rs`. `end_to_end_test.rs`'s `read_next_response` skips any line whose `type` is `progress`, so the new fields cannot reach a response assertion.

- [ ] **Step 5: Commit**

```bash
git add rust-core/crates/sidecar/src/protocol.rs
git commit -m "feat(sidecar): progress lines can carry an index/total count"
```

---

### Task 5: Sidecar — `EnsureDayBackfill` (P14§2 item 2, P14§5)

The phase's centre of gravity. `sidecar` takes a direct dependency on `ingestion` (already transitively present via `backtest`; `ingestion`'s only intra-workspace dependency is `storage`, so this cannot cycle). A new `day_backfill.rs` resolves the requested algorithm's `required_lookback()` from the registry, reads the symbol's current `("day", "bhavcopy")` depth, and if short drives `walk_trading_days_backward` from the day before the lake's earliest candle — or from `today` if the lake has nothing — persisting each fetched candle immediately, counting consecutive absent trading days, and stopping at whichever comes first.

The handler owns **two** of the three stop conditions (enough bars collected; `ABSENT_DAY_LIMIT` consecutive trading days with no row for this symbol) and reports the third, which the walker owns: `WalkStop::ArchiveExhausted` becomes `DayBackfillResponse.archive_exhausted`, kept strictly distinct from `sufficient: false` so the UI never tells a user their symbol lacks history when what actually happened is the archive stopped answering (decision (xviii)).

Everything wall-clock and network is a parameter: `today: NaiveDate` and a `fetch` closure. Only `main.rs` supplies the real ones, and only `main.rs` sleeps `POLITENESS_DELAY_MS` between requests (plan decisions (xiv) and the no-wall-clock-test Global Constraint).

`ist_date_from_epoch` lands here because this is the one caller that needs it: the lake stores candle timestamps, the walker takes dates, and something has to invert `ist_session_close_epoch`.

The protocol enum arms and `main.rs`'s dispatch cannot be split from the handler — adding a `SidecarRequest` variant makes `request_id`, `request_step`, and the dispatch `match` non-exhaustive until the same commit fills them in.

**Files:**
- Modify: `rust-core/crates/ingestion/src/time.rs` (whole file)
- Modify: `rust-core/crates/sidecar/Cargo.toml:14-21` (`[dependencies]`)
- Modify: `rust-core/crates/sidecar/src/lib.rs`
- Modify: `rust-core/crates/sidecar/src/protocol.rs:164-167` (after `ListAlgorithmsRequest`), `:235-262` (both enums)
- Create: `rust-core/crates/sidecar/src/day_backfill.rs`
- Modify: `rust-core/crates/sidecar/src/main.rs:1-15` (imports), `:31-61` (`request_id`/`request_step`), `:266-277` (after the `ListAlgorithms` dispatch arm)
- Modify: `rust-core/crates/sidecar/tests/protocol_test.rs`
- Modify: `rust-core/crates/sidecar/tests/end_to_end_test.rs`

**Interfaces:**
- Consumes: `ingestion::backfill::{walk_trading_days_backward, DayOutcome, WalkStop, POLITENESS_DELAY_MS, CLOSED_DAY_LIMIT}` (Task 2); `ingestion::io::fetch_udiff_bhavcopy`; `ingestion::error::IngestionError`; `sidecar::protocol::encode_progress_counted` (Task 4); `algo_core::registry::all_for_binary`; `storage::CandleStore::{read_sourced_candles, write_sourced_candles}`.
- Produces:
  - `ingestion::time::ist_date_from_epoch(ts: i64) -> NaiveDate`
  - `sidecar::protocol::EnsureDayBackfillRequest { id: u64, symbol: String, algo_id: String }` (wire tag `ensure_day_backfill`)
  - `sidecar::protocol::DayBackfillResponse { id: u64, have: usize, need: usize, sufficient: bool, archive_exhausted: bool, error: Option<String> }` (wire tag `day_backfill`)
  - `sidecar::day_backfill::{BACKFILL_TIMEFRAME, BACKFILL_SOURCE, ABSENT_DAY_LIMIT, handle_ensure_day_backfill}`
  - `handle_ensure_day_backfill(store: &CandleStore, request: EnsureDayBackfillRequest, today: NaiveDate, fetch: &mut dyn FnMut(&str, NaiveDate) -> Result<Vec<u8>, IngestionError>, on_progress: &mut dyn FnMut(usize, usize)) -> DayBackfillResponse`

- [ ] **Step 1: Write the failing `ist_date_from_epoch` test** — in `rust-core/crates/ingestion/src/time.rs`, append:

```rust
#[cfg(test)]
mod tests {
    use super::{ist_date_from_epoch, ist_session_close_epoch};
    use chrono::NaiveDate;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).expect("test dates are valid")
    }

    #[test]
    fn ist_date_from_epoch_inverts_ist_session_close_epoch() {
        for day in [date(2024, 1, 15), date(2023, 12, 29), date(2026, 9, 18)] {
            assert_eq!(ist_date_from_epoch(ist_session_close_epoch(day)), day);
        }
    }

    #[test]
    fn ist_date_from_epoch_classifies_by_the_ist_calendar_date_not_the_utc_one() {
        // 2024-01-15 00:00 IST is 2024-01-14 18:30 UTC: a UTC-based conversion
        // would answer the 14th. 15:30 IST close is 1_705_312_800, and midnight
        // that morning is 15.5 hours (55_800s) earlier.
        assert_eq!(ist_date_from_epoch(1_705_257_000), date(2024, 1, 15));
        assert_eq!(ist_date_from_epoch(1_705_256_999), date(2024, 1, 14));
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `rust-core/`): `cargo test -p ingestion --lib`
Expected: FAIL to compile — `cannot find function 'ist_date_from_epoch' in module 'super'`.

- [ ] **Step 3: Add the inverse** — in `rust-core/crates/ingestion/src/time.rs`, replace the import line and `ist_session_close_epoch`:

```rust
use chrono::{FixedOffset, NaiveDate, TimeZone};

/// The instant a daily candle is final: 15:30 IST session close, as an absolute
/// Unix epoch (seconds). Encoding the exchange-local session boundary as absolute
/// time keeps backtest frontier comparisons locale-independent while anchored to
/// session time (design §6.4). Panics only on an impossible offset/time, which
/// are compile-time constants here.
pub fn ist_session_close_epoch(date: NaiveDate) -> i64 {
    let ist = FixedOffset::east_opt(5 * 3600 + 30 * 60).unwrap();
    let naive = date.and_hms_opt(15, 30, 0).unwrap();
    ist.from_local_datetime(&naive).unwrap().timestamp()
}
```

with:

```rust
use chrono::{DateTime, FixedOffset, NaiveDate, TimeZone};

fn ist_offset() -> FixedOffset {
    FixedOffset::east_opt(5 * 3600 + 30 * 60).expect("IST is a valid fixed offset")
}

/// The instant a daily candle is final: 15:30 IST session close, as an absolute
/// Unix epoch (seconds). Encoding the exchange-local session boundary as absolute
/// time keeps backtest frontier comparisons locale-independent while anchored to
/// session time (design §6.4). Panics only on an impossible offset/time, which
/// are compile-time constants here.
pub fn ist_session_close_epoch(date: NaiveDate) -> i64 {
    let naive = date.and_hms_opt(15, 30, 0).expect("15:30 is a valid time of day");
    ist_offset().from_local_datetime(&naive).unwrap().timestamp()
}

/// Which IST calendar date an absolute instant falls on -- the inverse of
/// `ist_session_close_epoch`, and the bridge from a stored candle `ts` (or
/// `Utc::now().timestamp()`) back to the `NaiveDate` a bhavcopy walk needs.
pub fn ist_date_from_epoch(ts: i64) -> NaiveDate {
    let at: DateTime<FixedOffset> = ist_offset()
        .timestamp_opt(ts, 0)
        .single()
        .expect("a fixed offset yields exactly one local time for any epoch second");
    at.date_naive()
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cargo test -p ingestion`
Expected: PASS — the two new `time` tests plus everything from Tasks 1-3.

- [ ] **Step 5: Add the crate dependency and the module** — in `rust-core/crates/sidecar/Cargo.toml`, replace:

```toml
[dependencies]
algo-core = { path = "../algo-core" }
storage = { path = "../storage" }
backtest = { path = "../backtest" }
```

with:

```toml
[dependencies]
algo-core = { path = "../algo-core" }
storage = { path = "../storage" }
backtest = { path = "../backtest" }
ingestion = { path = "../ingestion" }
```

In `rust-core/crates/sidecar/src/lib.rs`, replace:

```rust
pub mod handlers;
pub mod protocol;
```

with:

```rust
pub mod day_backfill;
pub mod handlers;
pub mod protocol;
```

- [ ] **Step 6: Write the failing handler tests** — create `rust-core/crates/sidecar/src/day_backfill.rs` containing **only** this test module for now (the production code lands in Step 8):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use algo_core::registry;
    use chrono::Datelike;
    use ingestion::backfill::CLOSED_DAY_LIMIT;
    use ingestion::time::ist_session_close_epoch;
    use storage::Candle;
    use tempfile::tempdir;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).expect("test dates are valid")
    }

    // Per-date TradDt: write_sourced_candles merges on ts, so reusing one fixed
    // date would collapse every fetched day into a single lake row.
    fn bhavcopy_csv(day: NaiveDate, symbols: &[&str]) -> Vec<u8> {
        let mut out = String::from(
            "TradDt,FinInstrmTp,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd\n",
        );
        for symbol in symbols {
            out.push_str(&format!("{day},STK,{symbol},EQ,10.0,11.0,9.0,10.5,10.5,10.0,1000,10500.0,7\n"));
        }
        out.into_bytes()
    }

    // Asserting against the registry's own number rather than a literal: obv's
    // required_lookback is 2 today (indicators/obv.rs), but this must not
    // silently pass if that constant ever moves.
    fn lookback_of(algo_id: &str) -> usize {
        registry::all_for_binary()
            .iter()
            .find(|a| a.id() == algo_id)
            .map(|a| a.required_lookback())
            .unwrap_or_else(|| panic!("{algo_id} must be in every build's registry"))
    }

    fn request(symbol: &str, algo_id: &str) -> EnsureDayBackfillRequest {
        EnsureDayBackfillRequest { id: 7, symbol: symbol.to_string(), algo_id: algo_id.to_string() }
    }

    fn candle_at(day: NaiveDate) -> Candle {
        Candle { ts: ist_session_close_epoch(day), open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1 }
    }

    #[test]
    fn an_already_deep_enough_lake_answers_immediately_with_zero_fetches() {
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        store
            .write_sourced_candles(
                "NSE:INFY",
                BACKFILL_TIMEFRAME,
                BACKFILL_SOURCE,
                &[candle_at(date(2024, 1, 15)), candle_at(date(2024, 1, 12)), candle_at(date(2024, 1, 11))],
            )
            .unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["INFY"]))
        };
        let mut progress: Vec<(usize, usize)> = Vec::new();

        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:INFY", "obv"),
            date(2024, 1, 15),
            &mut fetch,
            &mut |index, total| progress.push((index, total)),
        );

        assert_eq!(response.id, 7);
        assert_eq!(response.need, lookback_of("obv"));
        assert_eq!(response.have, 3);
        assert!(response.sufficient);
        assert_eq!(response.error, None);
        assert!(attempts.is_empty(), "a deep-enough lake must never hit the network");
        assert!(progress.is_empty());
    }

    #[test]
    fn an_empty_lake_fetches_exactly_the_days_it_needs_and_reports_each_one() {
        let need = lookback_of("obv");
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["INFY", "TCS"]))
        };
        let mut progress: Vec<(usize, usize)> = Vec::new();

        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:INFY", "obv"),
            date(2024, 1, 15),
            &mut fetch,
            &mut |index, total| progress.push((index, total)),
        );

        assert!(response.sufficient);
        assert_eq!(response.have, need);
        assert_eq!(response.need, need);
        assert_eq!(attempts.len(), need, "one fetch per needed trading day, no more");
        assert_eq!(attempts[0], date(2024, 1, 15), "the walk starts at today when the lake is empty");
        assert!(attempts.iter().all(|d| !matches!(d.weekday(), chrono::Weekday::Sat | chrono::Weekday::Sun)));
        assert!(attempts.windows(2).all(|w| w[1] < w[0]), "the walk goes strictly backward");
        assert_eq!(progress, (1..=need).map(|i| (i, need)).collect::<Vec<_>>());
        // The days really landed in the lake, not just in a counter.
        assert_eq!(store.read_sourced_candles("NSE:INFY", "day", "bhavcopy").unwrap().len(), need);
    }

    #[test]
    fn a_partial_lake_resumes_from_the_day_before_its_earliest_candle() {
        assert!(lookback_of("obv") == 2, "this fixture is sized for obv's 2-bar lookback");
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        store
            .write_sourced_candles("NSE:INFY", BACKFILL_TIMEFRAME, BACKFILL_SOURCE, &[candle_at(date(2024, 1, 15))])
            .unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["INFY"]))
        };

        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:INFY", "obv"),
            date(2024, 1, 15),
            &mut fetch,
            &mut |_, _| {},
        );

        // Earliest existing candle is Mon 15 -> start at Sun 14 -> Sat 13 -> Fri 12.
        // Neither weekend day is fetched, and the 15th is never refetched.
        assert_eq!(attempts, vec![date(2024, 1, 12)]);
        assert_eq!(response.have, 2);
        assert!(response.sufficient);
    }

    #[test]
    fn ten_consecutive_absent_trading_days_stop_the_walk_and_report_the_real_history() {
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["TCS"]))
        };
        let mut progress: Vec<(usize, usize)> = Vec::new();

        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:ZYDUSWELL", "obv"),
            date(2024, 1, 15),
            &mut fetch,
            &mut |index, total| progress.push((index, total)),
        );

        assert!(!response.sufficient);
        assert_eq!(response.have, 0, "have is the symbol's real available history");
        assert_eq!(response.need, lookback_of("obv"));
        assert_eq!(response.error, None, "an absent symbol is an answer, not a failure");
        assert!(
            !response.archive_exhausted,
            "every day here fetched fine -- this is a fact about the symbol, not the archive"
        );
        // Mon 15, Fri 12, Thu 11, Wed 10, Tue 9, Mon 8, Fri 5, Thu 4, Wed 3, Tue 2.
        assert_eq!(attempts.len(), ABSENT_DAY_LIMIT);
        assert_eq!(attempts.last(), Some(&date(2024, 1, 2)));
        assert!(progress.is_empty());
    }

    #[test]
    fn an_archive_that_answers_nothing_is_reported_as_exhausted_not_as_a_short_history() {
        // A backfill that walks past the archive's coverage must not come back
        // saying "NSE:INFY has 0 days of listed history" -- it cannot know that.
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| -> Result<Vec<u8>, IngestionError> {
            attempts.push(d);
            Err(IngestionError::NotFound)
        };

        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:INFY", "obv"),
            date(2024, 1, 15),
            &mut fetch,
            &mut |_, _| {},
        );

        assert!(response.archive_exhausted, "the third outcome must reach the response");
        assert!(!response.sufficient);
        assert_eq!(response.have, 0);
        assert_eq!(response.need, lookback_of("obv"));
        assert_eq!(response.error, None, "a silent archive is an answer, not a transport failure");
        // Bounded, not infinite -- this is the whole point of the cap.
        assert_eq!(attempts.len(), CLOSED_DAY_LIMIT);
    }

    #[test]
    fn one_present_day_resets_the_absent_streak_instead_of_stopping_at_ten_overall() {
        let need = lookback_of("obv");
        assert!(need >= 2, "this fixture needs a lookback of at least 2 to avoid stopping at the present day");
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            let symbols: &[&str] = if d == date(2024, 1, 5) { &["ZYDUSWELL"] } else { &["TCS"] };
            Ok(bhavcopy_csv(d, symbols))
        };

        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:ZYDUSWELL", "obv"),
            date(2024, 1, 15),
            &mut fetch,
            &mut |_, _| {},
        );

        // Six absent trading days (15, 12, 11, 10, 9, 8), then Fri 5 present
        // (streak resets), then ten more absent (4, 3, 2, 1, Dec 29, 28, 27,
        // 26, 25, 22) trips the limit. Without a reset it would have stopped
        // after ten fetches total.
        assert_eq!(attempts.len(), 17);
        assert_eq!(attempts.last(), Some(&date(2023, 12, 22)));
        assert_eq!(response.have, 1);
        assert!(!response.sufficient);
    }

    #[test]
    fn a_non_404_fetch_failure_surfaces_as_an_error_and_keeps_what_it_already_persisted() {
        assert!(lookback_of("obv") == 2, "this fixture is sized for obv's 2-bar lookback");
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let mut fetch = |_e: &str, d: NaiveDate| {
            if d == date(2024, 1, 12) {
                Err(IngestionError::Fetch("network down".to_string()))
            } else {
                Ok(bhavcopy_csv(d, &["INFY"]))
            }
        };

        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:INFY", "obv"),
            date(2024, 1, 15),
            &mut fetch,
            &mut |_, _| {},
        );

        assert!(!response.sufficient);
        assert_eq!(response.have, 1, "Monday's candle stays committed");
        let message = response.error.expect("a non-404 failure must be reported, not swallowed");
        assert!(message.contains("network down"), "got {message}");
        assert_eq!(store.read_sourced_candles("NSE:INFY", "day", "bhavcopy").unwrap().len(), 1);
    }

    #[test]
    fn an_unknown_algo_id_needs_nothing_and_fetches_nothing() {
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["INFY"]))
        };

        let response = handle_ensure_day_backfill(
            &store,
            request("NSE:INFY", "__not_an_algorithm__"),
            date(2024, 1, 15),
            &mut fetch,
            &mut |_, _| {},
        );

        assert_eq!(response.need, 0);
        assert_eq!(response.have, 0);
        assert!(response.sufficient);
        assert!(attempts.is_empty());
    }
}
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `cargo test -p sidecar --lib`
Expected: FAIL to compile — `cannot find type 'EnsureDayBackfillRequest' in this scope`, `cannot find function 'handle_ensure_day_backfill'`, `cannot find value 'BACKFILL_TIMEFRAME'`, `cannot find value 'ABSENT_DAY_LIMIT'`.

- [ ] **Step 8: Add the wire types** — in `rust-core/crates/sidecar/src/protocol.rs`, insert immediately after the `ListAlgorithmsRequest` struct (before `AlgorithmWire`):

```rust
#[derive(Debug, Deserialize)]
pub struct EnsureDayBackfillRequest {
    pub id: u64,
    pub symbol: String,
    /// Sizing is per the single selected algorithm, not a max across all of
    /// them: the Benchmark UI already requires picking exactly one (P14§2
    /// locked decision 2).
    pub algo_id: String,
}

#[derive(Debug, Serialize)]
pub struct DayBackfillResponse {
    pub id: u64,
    pub have: usize,
    pub need: usize,
    /// false => `have` is the symbol's full available real history, capped by
    /// the "10 consecutive absent trading days" heuristic (P14§2 item 4) --
    /// UNLESS `archive_exhausted` is set, in which case `have` is only what the
    /// walk managed to collect before the archive went quiet.
    pub sufficient: bool,
    /// The walk stopped because CLOSED_DAY_LIMIT weekdays in a row had no file
    /// at all. Always serialized (like `sufficient`) rather than skipped when
    /// false: this is a third outcome, and a consumer must never have to infer
    /// it from an absent key (decision (xviii)).
    pub archive_exhausted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
```

In the same file add one arm to each enum — replace:

```rust
    ListAlgorithms(ListAlgorithmsRequest),
}
```

with:

```rust
    ListAlgorithms(ListAlgorithmsRequest),
    EnsureDayBackfill(EnsureDayBackfillRequest),
}
```

and replace:

```rust
    Algorithms(ListAlgorithmsResponse),
}
```

with:

```rust
    Algorithms(ListAlgorithmsResponse),
    DayBackfill(DayBackfillResponse),
}
```

- [ ] **Step 9: Write the handler** — prepend this to `rust-core/crates/sidecar/src/day_backfill.rs`, above the `mod tests` block written in Step 6:

```rust
use crate::protocol::{DayBackfillResponse, EnsureDayBackfillRequest};
use algo_core::registry;
use chrono::NaiveDate;
use ingestion::backfill::{walk_trading_days_backward, DayOutcome, WalkStop};
use ingestion::error::IngestionError;
use ingestion::time::ist_date_from_epoch;
use std::ops::ControlFlow;
use storage::CandleStore;

/// Bhavcopy is the one on-demand day source this app has (P14§1), so a day
/// backfill only ever reads and writes this one partition.
pub const BACKFILL_TIMEFRAME: &str = "day";
pub const BACKFILL_SOURCE: &str = "bhavcopy";

/// Consecutive real trading days (holidays don't count -- they never reach the
/// callback) with no row for the target symbol before the walk concludes the
/// symbol simply isn't listed that far back. A stock that is currently listed
/// and trading does not miss ten straight national bhavcopies; one that is
/// pre-IPO or delisted does (P14§2 item 4).
///
/// Distinct from `ingestion::backfill::CLOSED_DAY_LIMIT`, which counts days the
/// *archive* had no file for. This one only ever advances on a day that was
/// fetched successfully, so it is evidence about the symbol alone.
pub const ABSENT_DAY_LIMIT: usize = 10;

pub fn handle_ensure_day_backfill(
    store: &CandleStore,
    request: EnsureDayBackfillRequest,
    today: NaiveDate,
    fetch: &mut dyn FnMut(&str, NaiveDate) -> Result<Vec<u8>, IngestionError>,
    on_progress: &mut dyn FnMut(usize, usize),
) -> DayBackfillResponse {
    let id = request.id;
    let need = registry::all_for_binary()
        .iter()
        .find(|algo| algo.id() == request.algo_id)
        .map(|algo| algo.required_lookback())
        .unwrap_or(0);

    let existing = match store.read_sourced_candles(&request.symbol, BACKFILL_TIMEFRAME, BACKFILL_SOURCE) {
        Ok(candles) => candles,
        Err(e) => {
            return DayBackfillResponse {
                id,
                have: 0,
                need,
                sufficient: false,
                archive_exhausted: false,
                error: Some(e.to_string()),
            }
        }
    };
    let mut collected = existing.len();
    if collected >= need {
        return DayBackfillResponse {
            id,
            have: collected,
            need,
            sufficient: true,
            archive_exhausted: false,
            error: None,
        };
    }

    let exchange = request.symbol.split(':').next().unwrap_or("NSE").to_string();
    // Resume strictly before the earliest bar already held, so no fetched day
    // can collide with one the lake already has.
    let start = match existing.first().map(|c| ist_date_from_epoch(c.ts)).and_then(|d| d.pred_opt()) {
        Some(day) => day,
        None => today,
    };

    let mut absent_streak = 0usize;
    let mut write_failure: Option<String> = None;
    let walk = walk_trading_days_backward(&exchange, &request.symbol, start, fetch, &mut |outcome: DayOutcome| {
        match outcome.candle {
            Some(parsed) => {
                absent_streak = 0;
                // Persist per day, not at the end: a hard-cancel mid-walk must
                // keep every day already fetched (P14§4).
                if let Err(e) = store.write_sourced_candles(
                    &request.symbol,
                    BACKFILL_TIMEFRAME,
                    BACKFILL_SOURCE,
                    &[parsed.candle],
                ) {
                    write_failure = Some(e.to_string());
                    return ControlFlow::Break(());
                }
                collected += 1;
                on_progress(collected, need);
                if collected >= need {
                    return ControlFlow::Break(());
                }
            }
            None => {
                absent_streak += 1;
                if absent_streak >= ABSENT_DAY_LIMIT {
                    return ControlFlow::Break(());
                }
            }
        }
        ControlFlow::Continue(())
    });

    let mut archive_exhausted = false;
    let error = match walk {
        Err(e) => Some(e.to_string()),
        Ok(WalkStop::ArchiveExhausted) => {
            // Not an error: the fetches succeeded in the transport sense, the
            // archive simply had no file for CLOSED_DAY_LIMIT weekdays running.
            archive_exhausted = true;
            write_failure
        }
        Ok(WalkStop::CallerStopped) => write_failure,
    };
    // Authoritative count: the partition's own row count, so the number the UI
    // shows is the number of bars the run will actually get.
    let have = store
        .read_sourced_candles(&request.symbol, BACKFILL_TIMEFRAME, BACKFILL_SOURCE)
        .map(|candles| candles.len())
        .unwrap_or(collected);
    DayBackfillResponse { id, have, need, sufficient: have >= need, archive_exhausted, error }
}
```

- [ ] **Step 10: Run the handler tests to verify they pass**

Run: `cargo test -p sidecar --lib day_backfill`
Expected: PASS — all eight `day_backfill` tests. As with Task 2's walker test, the all-404 one hanging instead of failing means the walk has no bound.

- [ ] **Step 11: Wire it into the request loop** — in `rust-core/crates/sidecar/src/main.rs`, replace the import block:

```rust
use sidecar::handlers::{
    handle_add_watchlist_symbol, handle_benchmark_compute, handle_evaluate_scan_gate,
    handle_evaluate_scan_gate_stateless, handle_list_algorithms, handle_list_lake_symbols,
    handle_list_watchlist, handle_persist, handle_read_lake_candles, handle_remove_watchlist_symbol,
    handle_request_with_progress,
};
use sidecar::protocol::{
    benchmark_empty_response, empty_response, encode_progress, encode_response, parse_request,
    LakeCandlesResponse, LakeSymbolsResponse, ListAlgorithmsResponse, PersistCandlesResponse,
    ScanGateResponse, SidecarRequest, SidecarResponse, WatchlistResponse,
};
```

with:

```rust
use chrono::{NaiveDate, Utc};
use ingestion::backfill::POLITENESS_DELAY_MS;
use ingestion::io::fetch_udiff_bhavcopy;
use ingestion::time::ist_date_from_epoch;
use sidecar::day_backfill::handle_ensure_day_backfill;
use sidecar::handlers::{
    handle_add_watchlist_symbol, handle_benchmark_compute, handle_evaluate_scan_gate,
    handle_evaluate_scan_gate_stateless, handle_list_algorithms, handle_list_lake_symbols,
    handle_list_watchlist, handle_persist, handle_read_lake_candles, handle_remove_watchlist_symbol,
    handle_request_with_progress,
};
use sidecar::protocol::{
    benchmark_empty_response, empty_response, encode_progress, encode_progress_counted,
    encode_response, parse_request, DayBackfillResponse, LakeCandlesResponse, LakeSymbolsResponse,
    ListAlgorithmsResponse, PersistCandlesResponse, ScanGateResponse, SidecarRequest,
    SidecarResponse, WatchlistResponse,
};
```

Then add the two match arms. Replace in `request_id`:

```rust
        SidecarRequest::ListAlgorithms(r) => r.id,
    }
```

with:

```rust
        SidecarRequest::ListAlgorithms(r) => r.id,
        SidecarRequest::EnsureDayBackfill(r) => r.id,
    }
```

and replace in `request_step`:

```rust
        SidecarRequest::ListAlgorithms(_) => "list_algorithms",
    }
```

with:

```rust
        SidecarRequest::ListAlgorithms(_) => "list_algorithms",
        SidecarRequest::EnsureDayBackfill(_) => "ensure_day_backfill",
    }
```

Finally, in the big dispatch `match request { … }`, insert this arm immediately after the closing brace of the `SidecarRequest::ListAlgorithms(request) => { … }` arm:

```rust
            SidecarRequest::EnsureDayBackfill(request) => {
                let id = request.id;
                match store.as_ref() {
                    Some(store) => {
                        let result = panic::catch_unwind(AssertUnwindSafe(|| {
                            let today = ist_date_from_epoch(Utc::now().timestamp());
                            let mut fetch = |exchange: &str, date: NaiveDate| {
                                // The only throttle in front of ~750 anonymous
                                // requests to a public archive (P14§2 item 6).
                                std::thread::sleep(std::time::Duration::from_millis(POLITENESS_DELAY_MS));
                                fetch_udiff_bhavcopy(date, exchange)
                            };
                            handle_ensure_day_backfill(store, request, today, &mut fetch, &mut |index, total| {
                                writeln!(stdout, "{}", encode_progress_counted(id, "backfill", "running", index, total))
                                    .expect("stdout must be writable");
                                stdout.flush().expect("stdout must flush");
                            })
                        }));
                        match result {
                            Ok(response) => SidecarResponse::DayBackfill(response),
                            Err(_) => {
                                eprintln!("sidecar: ensure_day_backfill request {id} panicked");
                                SidecarResponse::DayBackfill(DayBackfillResponse { id, have: 0, need: 0, sufficient: false, archive_exhausted: false, error: Some("ensure_day_backfill panicked".to_string()) })
                            }
                        }
                    }
                    None => SidecarResponse::DayBackfill(DayBackfillResponse { id, have: 0, need: 0, sufficient: false, archive_exhausted: false, error: Some("no --lake-root configured".to_string()) }),
                }
            }
```

- [ ] **Step 12: Write the failing wire tests** — in `rust-core/crates/sidecar/tests/protocol_test.rs`, add a fourth import line after the existing three:

```rust
use sidecar::protocol::{DayBackfillResponse, EnsureDayBackfillRequest};
```

and append at the end of the file:

```rust
#[test]
fn parses_a_tagged_ensure_day_backfill_request() {
    let line = r#"{"type":"ensure_day_backfill","id":41,"symbol":"NSE:ZYDUSWELL","algo_id":"kronos"}"#;
    match parse_request(line).unwrap() {
        SidecarRequest::EnsureDayBackfill(request) => {
            assert_eq!(request.id, 41);
            assert_eq!(request.symbol, "NSE:ZYDUSWELL");
            assert_eq!(request.algo_id, "kronos");
        }
        _ => panic!("expected an ensure_day_backfill request"),
    }
}

#[test]
fn encodes_a_tagged_day_backfill_response_and_omits_the_error_field_when_none() {
    let line = encode_response(&SidecarResponse::DayBackfill(DayBackfillResponse {
        id: 41,
        have: 8,
        need: 256,
        sufficient: false,
        archive_exhausted: false,
        error: None,
    }));
    assert!(!line.contains('\n'));
    assert!(line.contains("\"type\":\"day_backfill\""));
    assert!(line.contains("\"id\":41"));
    assert!(line.contains("\"have\":8"));
    assert!(line.contains("\"need\":256"));
    assert!(line.contains("\"sufficient\":false"));
    // Always on the wire, even when false -- the TS mirror can then require it.
    assert!(line.contains("\"archive_exhausted\":false"));
    assert!(!line.contains("error"));
}

#[test]
fn a_day_backfill_response_carries_its_error_when_one_occurred() {
    let line = encode_response(&SidecarResponse::DayBackfill(DayBackfillResponse {
        id: 41,
        have: 0,
        need: 256,
        sufficient: false,
        archive_exhausted: false,
        error: Some("no --lake-root configured".to_string()),
    }));
    assert!(line.contains("\"error\":\"no --lake-root configured\""));
}

#[test]
fn an_exhausted_archive_is_a_distinct_wire_outcome_from_a_merely_short_history() {
    let short_history = encode_response(&SidecarResponse::DayBackfill(DayBackfillResponse {
        id: 41,
        have: 8,
        need: 256,
        sufficient: false,
        archive_exhausted: false,
        error: None,
    }));
    let exhausted = encode_response(&SidecarResponse::DayBackfill(DayBackfillResponse {
        id: 41,
        have: 8,
        need: 256,
        sufficient: false,
        archive_exhausted: true,
        error: None,
    }));
    assert_ne!(short_history, exhausted, "the two outcomes must not be wire-identical");
    assert!(exhausted.contains("\"archive_exhausted\":true"));
}

#[test]
fn an_ensure_day_backfill_request_is_constructible_for_a_round_trip() {
    // Guards the field names the Electron mirror writes onto the wire.
    let request = EnsureDayBackfillRequest {
        id: 1,
        symbol: "NSE:INFY".to_string(),
        algo_id: "obv".to_string(),
    };
    assert_eq!(request.algo_id, "obv");
}
```

In `rust-core/crates/sidecar/tests/end_to_end_test.rs`, append:

```rust
#[test]
fn ensure_day_backfill_answers_over_stdio_without_touching_the_network() {
    // An algo id no registry knows needs zero bars, so the handler returns
    // before it can ever reach walk_trading_days_backward -- which makes this a
    // pure wiring smoke test for the new request/response pair.
    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_sidecar"))
        .arg("--lake-root")
        .arg(dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("sidecar binary must start");

    let request = r#"{"type":"ensure_day_backfill","id":1,"symbol":"NSE:INFY","algo_id":"__not_an_algorithm__"}"#;
    {
        let stdin = child.stdin.as_mut().unwrap();
        writeln!(stdin, "{request}").unwrap();
    }
    drop(child.stdin.take());

    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let response = read_next_response(&mut reader);
    child.wait().ok();

    assert_eq!(response["type"], "day_backfill");
    assert_eq!(response["id"], 1);
    assert_eq!(response["need"], 0);
    assert_eq!(response["have"], 0);
    assert_eq!(response["sufficient"], true);
    assert_eq!(response["archive_exhausted"], false);
    assert!(response.get("error").is_none(), "a clean answer must omit error entirely");
}
```

- [ ] **Step 13: Run the whole sidecar suite to verify it passes**

Run: `cargo test -p sidecar`
Expected: PASS — the eight `day_backfill` tests, the five new `protocol_test` tests, the new `end_to_end_test` test, and every pre-existing sidecar test.

- [ ] **Step 14: Verify the dependency graph is still acyclic and the release binary builds**

Run (from `rust-core/`): `cargo tree -p sidecar --depth 2 | grep -E "ingestion|backtest" && cargo build --workspace`
Expected: `ingestion` appears as a direct dependency of `sidecar` (and, separately, under `backtest`); the workspace builds with no cycle error.

- [ ] **Step 15: Commit**

```bash
git add rust-core/crates/ingestion/src/time.rs rust-core/crates/sidecar/Cargo.toml rust-core/Cargo.lock rust-core/crates/sidecar/src/lib.rs rust-core/crates/sidecar/src/protocol.rs rust-core/crates/sidecar/src/day_backfill.rs rust-core/crates/sidecar/src/main.rs rust-core/crates/sidecar/tests
git commit -m "feat(sidecar): ensure_day_backfill walks bhavcopy history for one symbol"
```

---

### Task 6: `SidecarSupervisor.ensureDayBackfill` + the wire mirror (P14§5, P14§6)

The TypeScript half of the wire, plus two things the spec does not mention but that the feature cannot work without: a per-request progress callback (so `runBenchmark` never has to subscribe to the supervisor's EventEmitter and filter ids by hand — plan decision (vi)) and a much longer timeout for this one request type (a 256-day backfill takes minutes; the 30-second default would reject every one — plan decision (xi)).

**Files:**
- Modify: `electron-app/src/main/services/sidecar/sidecarProtocol.ts:83-95` (progress wire + a new response interface), `:109-130` (both unions)
- Modify: `electron-app/src/main/services/sidecar/sidecarSupervisor.ts:1-19` (imports), `:43-44` (constants), `:51-56` (fields), `:149-155` (new method), `:157-174` (`send`), `:196-213` (`dispatch`), `:215-226` (`onExit`)
- Modify: `electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts` (five new tests appended inside `describe("SidecarSupervisor", …)`)

**Interfaces:**
- Consumes: the Rust wire from Task 5 (`ensure_day_backfill` request, `day_backfill` response) and Task 4 (`index`/`total` on a progress line).
- Produces:
  - `interface DayBackfillResponseWire { type: "day_backfill"; id: number; have: number; need: number; sufficient: boolean; archive_exhausted: boolean; error?: string }`
  - `SidecarProgressWire` gains `index?: number; total?: number`
  - `SidecarRequestWire` gains `{ type: "ensure_day_backfill"; id: number; symbol: string; algo_id: string }`
  - `export const BACKFILL_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;`
  - `SidecarSupervisor.ensureDayBackfill(symbol: string, algoId: string, onDayProgress?: (index: number, total: number) => void): Promise<DayBackfillResponseWire>`

- [ ] **Step 1: Write the failing tests** — in `electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts`, change the import line at the top:

```ts
import { SidecarSupervisor } from "../../../../src/main/services/sidecar/sidecarSupervisor";
```

to:

```ts
import { BACKFILL_REQUEST_TIMEOUT_MS, SidecarSupervisor } from "../../../../src/main/services/sidecar/sidecarSupervisor";
```

and append these five tests inside the `describe("SidecarSupervisor", …)` block, immediately after the existing `"resolves listAlgorithms with an algorithms response carrying the matching id"` test:

```ts
  it("sends an ensure_day_backfill request and resolves the matching day_backfill response", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.ensureDayBackfill("NSE:ZYDUSWELL", "kronos");

    const [request] = await requestsSeen;
    expect(request).toEqual({ type: "ensure_day_backfill", id: 1, symbol: "NSE:ZYDUSWELL", algo_id: "kronos" });

    children[0].stdout.write(
      `${JSON.stringify({
        type: "day_backfill",
        id: 1,
        have: 8,
        need: 256,
        sufficient: false,
        archive_exhausted: false,
      })}\n`,
    );
    const response = await pending;
    expect(response.type).toBe("day_backfill");
    expect(response.have).toBe(8);
    expect(response.need).toBe(256);
    expect(response.sufficient).toBe(false);
    expect(response.archive_exhausted).toBe(false);
  });

  it("carries an archive_exhausted answer through unchanged", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.ensureDayBackfill("NSE:ZYDUSWELL", "kronos");
    await requestsSeen;

    children[0].stdout.write(
      `${JSON.stringify({
        type: "day_backfill",
        id: 1,
        have: 41,
        need: 256,
        sufficient: false,
        archive_exhausted: true,
      })}\n`,
    );
    const response = await pending;
    expect(response.archive_exhausted).toBe(true);
    expect(response.sufficient).toBe(false);
  });

  it("forwards only its own counted progress lines to the per-request backfill callback", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const seen: Array<[number, number]> = [];
    const pending = supervisor.ensureDayBackfill("NSE:INFY", "kronos", (index, total) => seen.push([index, total]));
    await requestsSeen;

    children[0].stdout.write(
      `${JSON.stringify({ type: "progress", id: 1, step: "backfill", status: "running", index: 1, total: 256 })}\n`,
    );
    // The request-level bracket carries no counts and must be ignored here.
    children[0].stdout.write(
      `${JSON.stringify({ type: "progress", id: 1, step: "ensure_day_backfill", status: "running" })}\n`,
    );
    // A counted line belonging to some other in-flight request must not leak in.
    children[0].stdout.write(
      `${JSON.stringify({ type: "progress", id: 2, step: "backfill", status: "running", index: 99, total: 256 })}\n`,
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "progress", id: 1, step: "backfill", status: "running", index: 2, total: 256 })}\n`,
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "day_backfill", id: 1, have: 256, need: 256, sufficient: true, archive_exhausted: false })}\n`,
    );

    await pending;
    expect(seen).toEqual([
      [1, 256],
      [2, 256],
    ]);
  });

  it("stops forwarding backfill progress once the request has settled", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const seen: Array<[number, number]> = [];
    const pending = supervisor.ensureDayBackfill("NSE:INFY", "kronos", (index, total) => seen.push([index, total]));
    await requestsSeen;

    children[0].stdout.write(
      `${JSON.stringify({ type: "day_backfill", id: 1, have: 1, need: 1, sufficient: true, archive_exhausted: false })}\n`,
    );
    await pending;
    children[0].stdout.write(
      `${JSON.stringify({ type: "progress", id: 1, step: "backfill", status: "running", index: 7, total: 9 })}\n`,
    );

    expect(seen).toEqual([]);
  });

  it("gives a backfill its own long timeout instead of the ordinary per-request one", async () => {
    // A from-scratch ttm/moirai backfill is ~750 requests at ~200ms apiece
    // (P14§3) -- minutes, not seconds. Under the shared default it would be
    // rejected every single time before the sidecar could finish.
    const children: FakeChild[] = [];
    const spawnFn = (_command: string, _args: string[]) => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ReturnType<typeof spawnFn>;
    };
    const supervisor = new SidecarSupervisor({
      binaryPath: "/fake/sidecar",
      lakeRoot: "/fake/lake",
      spawnFn,
      requestTimeoutMs: 5,
    });
    supervisor.start();

    const backfill = supervisor.ensureDayBackfill("NSE:INFY", "kronos"); // id 1
    const ordinary = supervisor.benchmarkCompute("NSE:INFY", "day", "positional", [], "sma"); // id 2

    await expect(ordinary).rejects.toThrow(/timed out after 5ms/);
    children[0].stdout.write(
      `${JSON.stringify({ type: "day_backfill", id: 1, have: 1, need: 1, sufficient: true, archive_exhausted: false })}\n`,
    );
    await expect(backfill).resolves.toMatchObject({ sufficient: true });
    expect(BACKFILL_REQUEST_TIMEOUT_MS).toBeGreaterThan(5);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `electron-app/`): `npx vitest run test/main/services/sidecar/sidecarSupervisor.test.ts`
Expected: FAIL — `supervisor.ensureDayBackfill is not a function`, and `BACKFILL_REQUEST_TIMEOUT_MS` is `undefined`.

- [ ] **Step 3: Mirror the wire** — in `electron-app/src/main/services/sidecar/sidecarProtocol.ts`, replace:

```ts
export interface SidecarProgressWire {
  type: "progress";
  id: number;
  step: string; // request-type name ("compute", …) or algorithm id ("rsi", …)
  status: "running" | "done";
}
```

with:

```ts
export interface DayBackfillResponseWire {
  type: "day_backfill";
  id: number;
  have: number;
  need: number;
  sufficient: boolean;
  // The walk gave up because the archive had no file for CLOSED_DAY_LIMIT
  // weekdays running -- a different claim from "this symbol is only N days
  // old", and the sidecar always sends it, so it is required here too.
  archive_exhausted: boolean;
  error?: string;
}

export interface SidecarProgressWire {
  type: "progress";
  id: number;
  step: string; // request-type name ("compute", …) or algorithm id ("rsi", …)
  status: "running" | "done";
  // Present only on a counted step (today just "backfill"); absence is how a
  // consumer tells an ordinary bracket line from an N-of-M one.
  index?: number;
  total?: number;
}
```

In the same file, replace:

```ts
  | BenchmarkComputeResponseWire
  | ListAlgorithmsResponseWire;
```

with:

```ts
  | BenchmarkComputeResponseWire
  | ListAlgorithmsResponseWire
  | DayBackfillResponseWire;
```

and replace:

```ts
  | { type: "list_algorithms"; id: number };
```

with:

```ts
  | { type: "list_algorithms"; id: number }
  | { type: "ensure_day_backfill"; id: number; symbol: string; algo_id: string };
```

- [ ] **Step 4: Add the method, the map, and the longer timeout** — in `electron-app/src/main/services/sidecar/sidecarSupervisor.ts`, add `DayBackfillResponseWire` to the existing import list from `./sidecarProtocol` (alphabetically it goes after `ConfluenceWire`):

```ts
import {
  BenchmarkComputeResponseWire,
  CandleWire,
  ComputeResponseWire,
  ConfluenceWire,
  DayBackfillResponseWire,
  LakeCandlesResponseWire,
  LakeSymbolsResponseWire,
  ListAlgorithmsResponseWire,
  PersistCandlesResponseWire,
  ScanGateResponseWire,
  SidecarProgressWire,
  SidecarRequestWire,
  SidecarResponseWire,
  WatchlistResponseWire,
  encodeRequest,
} from "./sidecarProtocol";
```

Replace:

```ts
const RESTART_BACKOFF_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
```

with:

```ts
const RESTART_BACKOFF_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
// A from-scratch backfill is up to ~750 sequential HTTP requests with a
// politeness delay between each (P14§3) -- minutes, not seconds. The user's
// escape hatch is Stop (cancelCurrent), not this ceiling.
export const BACKFILL_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
```

Replace the private field block:

```ts
  private stdoutBuffer = "";
  private stopped = false;
  private cancelling = false;
```

with:

```ts
  private stdoutBuffer = "";
  private stopped = false;
  private cancelling = false;
  private readonly dayProgress = new Map<number, (index: number, total: number) => void>();
```

Add the new method immediately after `listAlgorithms()`:

```ts
  ensureDayBackfill(
    symbol: string,
    algoId: string,
    onDayProgress?: (index: number, total: number) => void,
  ): Promise<DayBackfillResponseWire> {
    return this.send(
      { type: "ensure_day_backfill", id: this.nextId, symbol, algo_id: algoId },
      (id) => {
        if (onDayProgress) this.dayProgress.set(id, onDayProgress);
      },
      BACKFILL_REQUEST_TIMEOUT_MS,
    ) as Promise<DayBackfillResponseWire>;
  }
```

Replace `send`:

```ts
  private send(request: SidecarRequestWire, onRequestId?: (id: number) => void): Promise<SidecarResponseWire> {
    const id = this.nextId++;
    onRequestId?.(id);
    request.id = id;
    return new Promise<SidecarResponseWire>((resolve, reject) => {
      if (!this.child) {
        reject(new Error("sidecar is not running"));
        return;
      }
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`sidecar request ${id} timed out after ${this.requestTimeoutMs}ms`));
        }
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(encodeRequest(request));
    });
  }
```

with:

```ts
  private send(
    request: SidecarRequestWire,
    onRequestId?: (id: number) => void,
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<SidecarResponseWire> {
    const id = this.nextId++;
    onRequestId?.(id);
    request.id = id;
    return new Promise<SidecarResponseWire>((resolve, reject) => {
      if (!this.child) {
        this.dayProgress.delete(id);
        reject(new Error("sidecar is not running"));
        return;
      }
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.dayProgress.delete(id);
          reject(new Error(`sidecar request ${id} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(encodeRequest(request));
    });
  }
```

Replace `dispatch`'s progress branch and its resolve path:

```ts
    if (parsed.type === "progress") {
      this.emit("progress", parsed);
      return;
    }
    const waiting = this.pending.get(parsed.id);
    if (!waiting) return;
    this.pending.delete(parsed.id);
    clearTimeout(waiting.timer);
    waiting.resolve(parsed);
```

with:

```ts
    if (parsed.type === "progress") {
      const counted = this.dayProgress.get(parsed.id);
      if (counted && parsed.index !== undefined && parsed.total !== undefined) {
        counted(parsed.index, parsed.total);
      }
      this.emit("progress", parsed);
      return;
    }
    const waiting = this.pending.get(parsed.id);
    if (!waiting) return;
    this.pending.delete(parsed.id);
    this.dayProgress.delete(parsed.id);
    clearTimeout(waiting.timer);
    waiting.resolve(parsed);
```

and in `onExit`, replace:

```ts
    this.pending.clear();
```

with:

```ts
    this.pending.clear();
    this.dayProgress.clear();
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/main/services/sidecar/sidecarSupervisor.test.ts && npm run typecheck`
Expected: PASS — the five new tests plus every pre-existing test in the file, and a clean typecheck.

The vitest run is what proves this task's test-file edits are complete; `npm run typecheck` only checks `src/**` (see Global Constraints — `tsconfig.json` excludes `**/*.test.ts`), so it confirms the two *production* files compile and nothing more. A missed test-side edit shows up as a failing assertion or an `undefined`, never as a type error.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/services/sidecar/sidecarProtocol.ts electron-app/src/main/services/sidecar/sidecarSupervisor.ts electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts
git commit -m "feat(sidecar-client): ensureDayBackfill with per-request progress and a long timeout"
```

---

### Task 7: `runBenchmark` pre-flight backfill, `insufficientHistory`, phased progress (P14§6)

One new call at the top of `runBenchmark`, before `readLakeCandles`. Its progress is forwarded through the *existing* `onProgress` callback and the *existing* `benchmark:progress` IPC channel, tagged `phase: "backfill"` alongside the frontier walk's `phase: "run"` — which means `onProgress`'s positional `(index, total)` signature becomes a single object (plan decision (vii)).

Four behaviors the spec does not spell out are implemented here because the feature is broken without them: the pre-flight is skipped for anything that is not a `("day", "bhavcopy")` entry — the timeframe alone is **not** a sufficient gate, because the live warm-up path writes `("day", "kite")` partitions that show up in the same picker (decision (viii)); a cancellation during backfill returns a cancelled result instead of throwing (decision (xii)); a backfill that both errored and came back insufficient throws the real message rather than showing a misleading "N days of listed history" banner (decision (x)); and a backfill that stopped because the archive went quiet is reported as its own shortfall reason rather than as a claim about the symbol (decision (xviii)).

**Files:**
- Modify: `electron-app/src/main/services/benchmark/benchmarkRunner.ts:36-41` (`BenchmarkResult`), `:76-78` (deps), `:80-116` (signature + pre-flight + the `onProgress` call)
- Modify: `electron-app/src/main/ipc/benchmarkBridge.ts:6-12` (deps `Pick`), `:31-35` (the progress forward)
- Modify: `electron-app/src/main/ipc/rendererApi.ts:34-35` (re-export), `:131` (`onBenchmarkProgress`)
- Modify: `electron-app/test/main/services/benchmark/benchmarkRunner.test.ts` (13 fixture edits + 3 callback-shape edits + 8 new tests)
- Modify: `electron-app/test/main/ipc/benchmarkBridge.test.ts` (the `harness`/`idleSidecar` shape + 1 assertion)

**Interfaces:**
- Consumes: `SidecarSupervisor.ensureDayBackfill` (Task 6).
- Produces:
  - `export interface BenchmarkProgress { phase: "backfill" | "run"; index: number; total: number }`
  - `BenchmarkResult` gains `insufficientHistory?: { have: number; need: number; reason: "symbol_history" | "archive_unreachable" }`
  - `BenchmarkRunnerDeps.sidecar` gains `"ensureDayBackfill"` to its `Pick`
  - `runBenchmark(deps, params, onProgress?: (progress: BenchmarkProgress) => void)`
  - `RendererApi.onBenchmarkProgress(handler: (progress: BenchmarkProgress) => void): void`

- [ ] **Step 1: Update the 13 existing test fixtures** — in `electron-app/test/main/services/benchmark/benchmarkRunner.test.ts`, first add this helper immediately after the existing `const DAY_SECONDS = 86_400;` line (line 80):

```ts
function backfillOk(have = 10_000, need = 0) {
  return vi
    .fn()
    .mockResolvedValue({ type: "day_backfill", id: 1, have, need, sufficient: true, archive_exhausted: false });
}
```

Then insert the line `ensureDayBackfill: backfillOk(),` as the **first** property inside **every** `sidecar: { … }` object literal in this file. There are **exactly 13** of them, at lines **104, 123, 144, 159, 173, 196, 212, 226, 258, 287, 316, 347, 365** in the pre-edit file. Every one is required: `baseParams()` uses `timeframe: "day"` **and** `source: "bhavcopy"` (`benchmarkRunner.test.ts:86-97`), so the pre-flight runs for every existing test, and `BenchmarkRunnerDeps`'s `Pick` makes the property mandatory in production code.

**Do not expect `npm run typecheck` to catch a miss here.** `electron-app/tsconfig.json` excludes `**/*.test.ts`, so `tsc --noEmit` never reads this file at all and a skipped fixture is invisible to it. The safety net is Step 6's `npx vitest run test/main/services/benchmark/benchmarkRunner.test.ts`: a missed fixture fails at runtime with `deps.sidecar.ensureDayBackfill is not a function`, naming the test. Run it and confirm every test passes before moving on.

Work **bottom-up** (365 first, 104 last) so earlier insertions do not shift the later line numbers, or re-run `grep -n "sidecar: {" test/main/services/benchmark/benchmarkRunner.test.ts` after each edit. Each edit turns, for example:

```ts
      sidecar: {
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles }),
```

into:

```ts
      sidecar: {
        ensureDayBackfill: backfillOk(),
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles }),
```

- [ ] **Step 2: Reshape the three existing `onProgress` call sites** — in the same file, there are **exactly 3** places that pass a positional `(index, total)` callback to `runBenchmark`, at pre-edit lines **233**, **265-266**, and **323-324**. Replace each:

Line 233 (`"invokes onProgress once per surviving loop iteration…"`):

```ts
    const result = await runBenchmark(deps, baseParams({ lookaheadBars: 3 }), (index, total) => progress.push([index, total]));
```

becomes:

```ts
    const result = await runBenchmark(deps, baseParams({ lookaheadBars: 3 }), (p) => progress.push([p.phase, p.index, p.total]));
```

Lines 265-266 (`"bounds onProgress's total to the eligible window…"`):

```ts
    await runBenchmark(deps, baseParams({ timeframe: "day", fromTs: dayStart, toTs, lookaheadBars: 2 }), (index, total) =>
      progress.push([index, total]),
    );
```

becomes:

```ts
    await runBenchmark(deps, baseParams({ timeframe: "day", fromTs: dayStart, toTs, lookaheadBars: 2 }), (p) =>
      progress.push([p.phase, p.index, p.total]),
    );
```

Lines 323-324 (`"reports progress from zero at the window's first frontier…"`):

```ts
    await runBenchmark(deps, baseParams({ fromTs: candles[37].ts, toTs: 1e12, lookaheadBars: 1 }), (index, total) =>
      progress.push([index, total]),
    );
```

becomes:

```ts
    await runBenchmark(deps, baseParams({ fromTs: candles[37].ts, toTs: 1e12, lookaheadBars: 1 }), (p) =>
      progress.push([p.phase, p.index, p.total]),
    );
```

Their three `const progress: Array<[number, number]> = [];` declarations (pre-edit lines **232**, **264**, **322**) each become:

```ts
    const progress: Array<[string, number, number]> = [];
```

and their three assertions become:

```ts
    // line 233's test
    expect(progress).toEqual([
      ["run", 0, 5],
      ["run", 1, 5],
      ["run", 2, 5],
      ["run", 3, 5],
      ["run", 4, 5],
    ]);

    // line 265's test
    expect(progress).toEqual([["run", 0, 1]]);

    // line 323's test
    expect(progress).toEqual([
      ["run", 0, 2],
      ["run", 1, 2],
    ]);
```

(The numbers are unchanged from today's passing assertions — `[[0,5],[1,5],[2,5],[3,5],[4,5]]`, `[[0,1]]`, and `[[0,2],[1,2]]` — because `backfillOk()` reports `sufficient: true` with no progress of its own. Only the `"run"` tag is new.)

- [ ] **Step 3: Write the eight new failing tests** — append them inside `describe("runBenchmark frontier walk", …)`, at the end of the block:

```ts
  it("returns an insufficientHistory result and never computes when the symbol's real history falls short", async () => {
    const benchmarkCompute = vi.fn();
    const readLakeCandles = vi.fn();
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill: vi.fn().mockResolvedValue({
          type: "day_backfill",
          id: 1,
          have: 8,
          need: 256,
          sufficient: false,
          archive_exhausted: false,
        }),
        readLakeCandles,
        benchmarkCompute,
        evaluateScanGateStateless: vi.fn(),
      },
    };

    const result = await runBenchmark(deps, baseParams({ algoId: "kronos" }));

    expect(result.insufficientHistory).toEqual({ have: 8, need: 256, reason: "symbol_history" });
    expect(result.decisionPoints).toEqual([]);
    expect(result.candles).toEqual([]);
    expect(result.cancelled).toBe(false);
    // Nothing downstream of the pre-flight runs -- not even the lake read.
    expect(readLakeCandles).not.toHaveBeenCalled();
    expect(benchmarkCompute).not.toHaveBeenCalled();
  });

  it("sizes the pre-flight against the one selected algorithm and leaves a sufficient run untouched", async () => {
    const ensureDayBackfill = backfillOk(400);
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill,
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12, 13]) }),
        benchmarkCompute: vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH }),
        evaluateScanGateStateless: vi.fn(),
      },
    };

    const result = await runBenchmark(deps, baseParams({ algoId: "kronos", lookaheadBars: 1 }));

    expect(ensureDayBackfill).toHaveBeenCalledTimes(1);
    expect(ensureDayBackfill.mock.calls[0][0]).toBe("NSE:INFY");
    expect(ensureDayBackfill.mock.calls[0][1]).toBe("kronos");
    expect(result.insufficientHistory).toBeUndefined();
    expect(result.decisionPoints).toHaveLength(3);
  });

  it("skips the pre-flight entirely for a non-day timeframe, which has no bhavcopy source", async () => {
    const ensureDayBackfill = backfillOk();
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill,
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12, 13]) }),
        benchmarkCompute: vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH }),
        evaluateScanGateStateless: vi.fn(),
      },
    };

    await runBenchmark(deps, baseParams({ timeframe: "minute", source: "kaggle", horizon: "positional", lookaheadBars: 1 }));

    expect(ensureDayBackfill).not.toHaveBeenCalled();
  });

  it("skips the pre-flight for a day entry that is not bhavcopy-sourced, so it cannot verdict the wrong partition", async () => {
    // The live warm-up path writes ("day", "kite") partitions
    // (candleWarmup.ts's WARMUP_SOURCE, historicalDataArchive.ts's `day`
    // lookback hint) and they appear in the same picker. Backfilling would
    // check ("day", "bhavcopy") while the run reads ("day", "kite") --
    // wasted fetches at best, a bogus insufficient-history verdict at worst.
    const ensureDayBackfill = backfillOk();
    const readLakeCandles = vi
      .fn()
      .mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12, 13]) });
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill,
        readLakeCandles,
        benchmarkCompute: vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH }),
        evaluateScanGateStateless: vi.fn(),
      },
    };

    const result = await runBenchmark(deps, baseParams({ timeframe: "day", source: "kite", lookaheadBars: 1 }));

    expect(ensureDayBackfill).not.toHaveBeenCalled();
    // And the run is otherwise exactly what it was before this phase.
    expect(readLakeCandles).toHaveBeenCalledWith("NSE:INFY", "day", "kite");
    expect(result.insufficientHistory).toBeUndefined();
    expect(result.decisionPoints).toHaveLength(3);
  });

  it("reports an exhausted archive as its own reason instead of blaming the symbol's history", async () => {
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill: vi.fn().mockResolvedValue({
          type: "day_backfill",
          id: 1,
          have: 41,
          need: 256,
          sufficient: false,
          archive_exhausted: true,
        }),
        readLakeCandles: vi.fn(),
        benchmarkCompute: vi.fn(),
        evaluateScanGateStateless: vi.fn(),
      },
    };

    const result = await runBenchmark(deps, baseParams({ algoId: "kronos" }));

    expect(result.insufficientHistory).toEqual({ have: 41, need: 256, reason: "archive_unreachable" });
    expect(result.cancelled).toBe(false);
  });

  it("reports backfill progress as its own phase before the frontier walk's", async () => {
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill: vi.fn().mockImplementation((_symbol: string, _algoId: string, onDay?: (i: number, t: number) => void) => {
          onDay?.(1, 2);
          onDay?.(2, 2);
          return Promise.resolve({ type: "day_backfill", id: 1, have: 2, need: 2, sufficient: true, archive_exhausted: false });
        }),
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12]) }),
        benchmarkCompute: vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH }),
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const progress: Array<[string, number, number]> = [];

    await runBenchmark(deps, baseParams({ lookaheadBars: 1 }), (p) => progress.push([p.phase, p.index, p.total]));

    // N=3, L=1 -> eligible frontiers i in {0, 1}.
    expect(progress).toEqual([
      ["backfill", 1, 2],
      ["backfill", 2, 2],
      ["run", 0, 2],
      ["run", 1, 2],
    ]);
  });

  it("tags a cancellation during the pre-flight as cancelled rather than throwing", async () => {
    const readLakeCandles = vi.fn();
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error("sidecar run cancelled"), { cancelled: true })),
        readLakeCandles,
        benchmarkCompute: vi.fn(),
        evaluateScanGateStateless: vi.fn(),
      },
    };

    const result = await runBenchmark(deps, baseParams());

    expect(result.cancelled).toBe(true);
    expect(result.insufficientHistory).toBeUndefined();
    expect(readLakeCandles).not.toHaveBeenCalled();
  });

  it("surfaces a backfill that failed outright as an error instead of a misleading history banner", async () => {
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill: vi.fn().mockResolvedValue({
          type: "day_backfill",
          id: 1,
          have: 40,
          need: 256,
          sufficient: false,
          archive_exhausted: false,
          error: "fetch error: HTTP 503 for https://nsearchives.nseindia.com/x.zip",
        }),
        readLakeCandles: vi.fn(),
        benchmarkCompute: vi.fn(),
        evaluateScanGateStateless: vi.fn(),
      },
    };

    await expect(runBenchmark(deps, baseParams())).rejects.toThrow(/HTTP 503/);
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run (from `electron-app/`): `npx vitest run test/main/services/benchmark/benchmarkRunner.test.ts`
Expected: FAIL — `deps.sidecar.ensureDayBackfill is not a function` for the new tests, and the reshaped existing progress assertions fail because `onProgress` is still called positionally (so `p.phase` is `undefined`).

- [ ] **Step 5: Implement the pre-flight** — in `electron-app/src/main/services/benchmark/benchmarkRunner.ts`, replace:

```ts
export interface BenchmarkResult {
  params: BenchmarkRunParams;
  candles: CandleWire[];
  decisionPoints: DecisionPoint[];
  cancelled: boolean;
}
```

with:

```ts
export interface BenchmarkProgress {
  phase: "backfill" | "run";
  index: number;
  total: number;
}

export interface BenchmarkResult {
  params: BenchmarkRunParams;
  candles: CandleWire[];
  decisionPoints: DecisionPoint[];
  cancelled: boolean;
  // Set only when the run has fewer bars than the selected algorithm needs even
  // after backfill (P14§6); the UI renders this instead of the empty summary
  // strip and chart that started this phase. `reason` keeps the two shortfalls
  // apart: "symbol_history" is a claim about the symbol, "archive_unreachable"
  // is a claim about the archive, and they must not be worded alike
  // (decision (xviii)).
  insufficientHistory?: { have: number; need: number; reason: "symbol_history" | "archive_unreachable" };
}
```

Replace:

```ts
export interface BenchmarkRunnerDeps {
  sidecar: Pick<SidecarSupervisor, "readLakeCandles" | "benchmarkCompute" | "evaluateScanGateStateless">;
}
```

with:

```ts
export interface BenchmarkRunnerDeps {
  sidecar: Pick<
    SidecarSupervisor,
    "readLakeCandles" | "benchmarkCompute" | "evaluateScanGateStateless" | "ensureDayBackfill"
  >;
}
```

Replace the function signature and the first statement of its body:

```ts
export async function runBenchmark(
  deps: BenchmarkRunnerDeps,
  params: BenchmarkRunParams,
  onProgress?: (index: number, total: number) => void,
): Promise<BenchmarkResult> {
  const { candles } = await deps.sidecar.readLakeCandles(params.symbol, params.timeframe, params.source);
```

with:

```ts
export async function runBenchmark(
  deps: BenchmarkRunnerDeps,
  params: BenchmarkRunParams,
  onProgress?: (progress: BenchmarkProgress) => void,
): Promise<BenchmarkResult> {
  // Bhavcopy is the one on-demand source this app has, and it is day-only
  // (P14§1). The source check is not redundant with the timeframe check: the
  // live warm-up path writes ("day", "kite") partitions into the same lake, and
  // backfilling would top up ("day", "bhavcopy") while the run below reads the
  // partition this entry actually names (decision (viii)).
  if (params.timeframe === "day" && params.source === "bhavcopy") {
    let backfill;
    try {
      backfill = await deps.sidecar.ensureDayBackfill(params.symbol, params.algoId, (index, total) =>
        onProgress?.({ phase: "backfill", index, total }),
      );
    } catch (error) {
      if ((error as { cancelled?: boolean }).cancelled !== true) throw error;
      return { params, candles: [], decisionPoints: [], cancelled: true };
    }
    if (backfill.error && !backfill.sufficient) {
      throw new Error(`backfill failed for ${params.symbol}: ${backfill.error}`);
    }
    if (backfill.error) {
      console.error(`benchmark: backfill for ${params.symbol} reported: ${backfill.error}`);
    }
    if (!backfill.sufficient) {
      return {
        params,
        candles: [],
        decisionPoints: [],
        cancelled: false,
        insufficientHistory: {
          have: backfill.have,
          need: backfill.need,
          reason: backfill.archive_exhausted ? "archive_unreachable" : "symbol_history",
        },
      };
    }
  }

  const { candles } = await deps.sidecar.readLakeCandles(params.symbol, params.timeframe, params.source);
```

and replace the single `onProgress` call inside the frontier loop:

```ts
      onProgress?.(i - firstFrontier, progressTotal);
```

with:

```ts
      onProgress?.({ phase: "run", index: i - firstFrontier, total: progressTotal });
```

- [ ] **Step 6: Run the runner tests to verify they pass**

Run: `npx vitest run test/main/services/benchmark/benchmarkRunner.test.ts`
Expected: PASS — all 21 pre-existing tests plus the 8 new ones (29 total). This run, not `npm run typecheck`, is what proves Step 1's 13 fixture insertions are all present.

- [ ] **Step 7: Update the bridge and the renderer API** — in `electron-app/src/main/ipc/benchmarkBridge.ts`, replace:

```ts
  sidecar: Pick<
    SidecarSupervisor,
    "listLakeSymbols" | "listAlgorithms" | "readLakeCandles" | "benchmarkCompute" | "evaluateScanGateStateless" | "cancelCurrent"
  >;
```

with:

```ts
  sidecar: Pick<
    SidecarSupervisor,
    | "listLakeSymbols"
    | "listAlgorithms"
    | "readLakeCandles"
    | "benchmarkCompute"
    | "evaluateScanGateStateless"
    | "ensureDayBackfill"
    | "cancelCurrent"
  >;
```

and replace:

```ts
  deps.ipcMain.handle("benchmark:runBenchmark", (event, params: BenchmarkRunParams) =>
    runBenchmark({ sidecar: deps.sidecar }, params, (index, total) =>
      event.sender.send("benchmark:progress", { index, total }),
    ),
  );
```

with:

```ts
  deps.ipcMain.handle("benchmark:runBenchmark", (event, params: BenchmarkRunParams) =>
    runBenchmark({ sidecar: deps.sidecar }, params, (progress) => event.sender.send("benchmark:progress", progress)),
  );
```

In `electron-app/src/main/ipc/rendererApi.ts`, replace:

```ts
export type { BenchmarkCadence, Outcome, DecisionPoint, BenchmarkRunParams, BenchmarkResult } from "../services/benchmark/benchmarkRunner";
import type { BenchmarkRunParams, BenchmarkResult } from "../services/benchmark/benchmarkRunner";
```

with:

```ts
export type { BenchmarkCadence, Outcome, DecisionPoint, BenchmarkRunParams, BenchmarkResult, BenchmarkProgress } from "../services/benchmark/benchmarkRunner";
import type { BenchmarkProgress, BenchmarkRunParams, BenchmarkResult } from "../services/benchmark/benchmarkRunner";
```

and replace:

```ts
  onBenchmarkProgress(handler: (progress: { index: number; total: number }) => void): void;
```

with:

```ts
  onBenchmarkProgress(handler: (progress: BenchmarkProgress) => void): void;
```

- [ ] **Step 8: Update the bridge test's sidecar fake** — in `electron-app/test/main/ipc/benchmarkBridge.test.ts`, replace the `harness` parameter type:

```ts
function harness(sidecar: {
  listLakeSymbols: ReturnType<typeof vi.fn>;
  listAlgorithms: ReturnType<typeof vi.fn>;
  readLakeCandles: ReturnType<typeof vi.fn>;
  benchmarkCompute: ReturnType<typeof vi.fn>;
  evaluateScanGateStateless: ReturnType<typeof vi.fn>;
  cancelCurrent: ReturnType<typeof vi.fn>;
}) {
```

with:

```ts
function harness(sidecar: {
  listLakeSymbols: ReturnType<typeof vi.fn>;
  listAlgorithms: ReturnType<typeof vi.fn>;
  readLakeCandles: ReturnType<typeof vi.fn>;
  benchmarkCompute: ReturnType<typeof vi.fn>;
  evaluateScanGateStateless: ReturnType<typeof vi.fn>;
  ensureDayBackfill: ReturnType<typeof vi.fn>;
  cancelCurrent: ReturnType<typeof vi.fn>;
}) {
```

replace `idleSidecar`:

```ts
function idleSidecar() {
  return {
    listLakeSymbols: vi.fn(),
    listAlgorithms: vi.fn(),
    readLakeCandles: vi.fn(),
    benchmarkCompute: vi.fn(),
    evaluateScanGateStateless: vi.fn(),
    cancelCurrent: vi.fn(),
  };
}
```

with:

```ts
function idleSidecar() {
  return {
    listLakeSymbols: vi.fn(),
    listAlgorithms: vi.fn(),
    readLakeCandles: vi.fn(),
    benchmarkCompute: vi.fn(),
    evaluateScanGateStateless: vi.fn(),
    // Every fixture in this file uses timeframe "day" with source "bhavcopy",
    // so the pre-flight runs; a lake that already has plenty means the run
    // proceeds unchanged.
    ensureDayBackfill: vi.fn().mockResolvedValue({
      type: "day_backfill",
      id: 1,
      have: 10_000,
      need: 0,
      sufficient: true,
      archive_exhausted: false,
    }),
    cancelCurrent: vi.fn(),
  };
}
```

and replace the progress assertion at line 124:

```ts
    expect(event.sender.send).toHaveBeenCalledWith("benchmark:progress", { index: 0, total: 2 });
```

with:

```ts
    expect(event.sender.send).toHaveBeenCalledWith("benchmark:progress", { phase: "run", index: 0, total: 2 });
```

- [ ] **Step 9: Run the full main-process benchmark and IPC suites**

Run: `npx vitest run test/main/services/benchmark test/main/ipc && npm run typecheck`
Expected: PASS — `benchmarkRunner.test.ts` (29), `benchmarkBridge.test.ts` (all, including the reshaped progress assertion), `rendererApi.test.ts` (unchanged — its `onBenchmarkProgress` test only asserts the channel name, never a payload shape), and a clean typecheck.

The vitest half of that command is the completeness check for the test-file edits; the `typecheck` half only covers the three `src/**` files this task changed (`benchmarkRunner.ts`, `benchmarkBridge.ts`, `rendererApi.ts`), since `tsconfig.json` excludes every `*.test.ts`/`*.test.tsx`.

- [ ] **Step 10: Confirm no other `onProgress`/progress-payload call site was missed**

Run: `grep -rn "benchmark:progress\|onBenchmarkProgress\|runBenchmark(" electron-app/src electron-app/test | grep -v node_modules`
Expected: every hit is either a channel-name string, a `vi.fn()` stub, one of the sites this task already edited, or `BenchmarkView.tsx:115` / `BenchmarkView.test.tsx` — which Task 8 handles.

- [ ] **Step 11: Commit**

```bash
git add electron-app/src/main/services/benchmark/benchmarkRunner.ts electron-app/src/main/ipc/benchmarkBridge.ts electron-app/src/main/ipc/rendererApi.ts electron-app/test/main
git commit -m "feat(benchmark): pre-flight day backfill with phased progress and an insufficient-history result"
```

---

### Task 8: `BenchmarkView` — phase-aware progress pill and the insufficient-history banner (P14§2 item 5, P14§6)

The last task, and the one the whole phase exists for: the incident that started this was `NSE:ZYDUSWELL` returning an empty `algos:` with no explanation. Two changes, both small.

**The progress pill needs no CSS change at all.** `.benchmark-progress-pill` is `position: fixed` with `display: flex` and no `width`, `max-width`, or `white-space` constraint, so the longer "Backfilling history — 143/256 days" label simply makes the pill wider. `.benchmark-progress-bar` is a fixed 96px and its fill is already driven by `index / total`, which is meaningful for both phases. `BenchmarkView.css` is therefore **not** modified by this task — if a diff touches it, something has gone wrong.

**Files:**
- Modify: `electron-app/src/renderer/BenchmarkView.tsx:14` (type import), `:29-45` (new helpers beside `SummaryStrip`), `:101` (progress state type), `:184-199` (the pill), `:200-202` (the result branch)
- Modify: `electron-app/test/renderer/BenchmarkView.test.tsx:206-218` (three edits) plus three new tests

**Interfaces:**
- Consumes: `BenchmarkProgress` and `BenchmarkResult.insufficientHistory` (Task 7).
- Produces: no exported surface change. `BenchmarkView`'s props are unchanged.

- [ ] **Step 1: Write the failing tests** — in `electron-app/test/renderer/BenchmarkView.test.tsx`, first fix the existing progress test. Replace its three affected lines:

```ts
    let progressHandler: ((p: { index: number; total: number }) => void) | undefined;
```

with:

```ts
    let progressHandler: ((p: BenchmarkProgress) => void) | undefined;
```

```ts
      onBenchmarkProgress: vi.fn((handler: (p: { index: number; total: number }) => void) => {
```

with:

```ts
      onBenchmarkProgress: vi.fn((handler: (p: BenchmarkProgress) => void) => {
```

```ts
    progressHandler?.({ index: 3, total: 10 });
```

with:

```ts
    progressHandler?.({ phase: "run", index: 3, total: 10 });
```

Extend the file's type import to carry `BenchmarkProgress` — replace:

```ts
import type { AlgorithmEntry, BenchmarkResult, LakeSymbolEntry, RendererApi } from "../../src/main/ipc/rendererApi";
```

with:

```ts
import type { AlgorithmEntry, BenchmarkProgress, BenchmarkResult, LakeSymbolEntry, RendererApi } from "../../src/main/ipc/rendererApi";
```

Then append these three new tests at the end of the `describe("BenchmarkView", …)` block:

```ts
  it("labels the progress pill by phase, so a long first-time backfill does not read as a stalled bar count", async () => {
    let progressHandler: ((p: BenchmarkProgress) => void) | undefined;
    const runBenchmark = vi.fn(() => new Promise<BenchmarkResult>(() => {})); // never resolves -- keeps `running` true
    const deps = api({
      runBenchmark,
      onBenchmarkProgress: vi.fn((handler: (p: BenchmarkProgress) => void) => {
        progressHandler = handler;
      }),
    });
    render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    await waitFor(() => expect(runBenchmark).toHaveBeenCalledTimes(1));

    progressHandler?.({ phase: "backfill", index: 143, total: 256 });
    expect(await screen.findByText(/backfilling history — 143\/256 days/i)).toBeTruthy();

    progressHandler?.({ phase: "run", index: 3, total: 8 });
    expect(await screen.findByText(/bar 3\/8/i)).toBeTruthy();
    expect(screen.queryByText(/backfilling history/i)).toBeNull();
  });

  it("renders one insufficient-history banner in place of the summary strip and chart", async () => {
    // The exact incident this phase exists for: a thin symbol used to come back
    // as an empty `algos:` list with zeroed confluence and no explanation.
    const insufficient: BenchmarkResult = {
      params: {
        symbol: "NSE:ZYDUSWELL",
        timeframe: "day",
        source: "bhavcopy",
        horizon: "positional",
        algoId: "kronos",
        lookaheadBars: 5,
        fromTs: 0,
        toTs: 0,
      },
      candles: [],
      decisionPoints: [],
      cancelled: false,
      insufficientHistory: { have: 8, need: 256, reason: "symbol_history" },
    };
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(insufficient) });
    const { container } = render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));

    await waitFor(() =>
      expect(container.textContent).toContain(
        "NSE:ZYDUSWELL has 8 days of real listed history; kronos needs 256",
      ),
    );
    // The confusing empty result is gone, not merely accompanied by a banner.
    expect(screen.queryByText(/0 decision points/i)).toBeNull();
    expect(screen.queryByText(/copy raw result/i)).toBeNull();
  });

  it("says the archive could not be reached, not that the symbol is young, when the walk hit the closed-day cap", async () => {
    // Same shortfall shape, different cause: the walker cannot see past a
    // silent archive, so the banner must not assert anything about the symbol.
    const unreachable: BenchmarkResult = {
      params: {
        symbol: "NSE:ZYDUSWELL",
        timeframe: "day",
        source: "bhavcopy",
        horizon: "positional",
        algoId: "kronos",
        lookaheadBars: 5,
        fromTs: 0,
        toTs: 0,
      },
      candles: [],
      decisionPoints: [],
      cancelled: false,
      insufficientHistory: { have: 41, need: 256, reason: "archive_unreachable" },
    };
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(unreachable) });
    const { container } = render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));

    await waitFor(() => expect(container.textContent).toMatch(/could not reach far enough back into the NSE archive/i));
    expect(container.textContent).toContain("41");
    expect(container.textContent).toContain("256");
    expect(container.textContent).not.toContain("days of real listed history");
    expect(screen.queryByText(/copy raw result/i)).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `electron-app/`): `npx vitest run test/renderer/BenchmarkView.test.tsx`
Expected: FAIL — the phase test finds no "Backfilling history" text (the pill always renders the bar label), and the banner test finds "0 decision points" instead of the sentence, because `ResultsView` still renders for an `insufficientHistory` result.

- [ ] **Step 3: Implement both changes** — in `electron-app/src/renderer/BenchmarkView.tsx`, replace the type import:

```ts
import type { AlgorithmEntry, BenchmarkResult, DecisionPoint, LakeSymbolEntry, RendererApi } from "../main/ipc/rendererApi";
```

with:

```ts
import type { AlgorithmEntry, BenchmarkProgress, BenchmarkResult, DecisionPoint, LakeSymbolEntry, RendererApi } from "../main/ipc/rendererApi";
```

Insert these two helpers immediately after the `const DAY_SECONDS = 86_400;` line and before `function SummaryStrip`:

```tsx
function progressLabel(algoId: string | null, progress: BenchmarkProgress | null): string {
  if (progress?.phase === "backfill") {
    return `Backfilling history — ${progress.index}/${progress.total} days`;
  }
  return `${algoId} — bar ${progress ? progress.index : 0}/${progress ? progress.total : "…"}`;
}

function InsufficientHistory({ result }: { result: BenchmarkResult }): JSX.Element {
  const { have, need, reason } = result.insufficientHistory ?? { have: 0, need: 0, reason: "symbol_history" as const };
  // Two different facts, two different sentences: the walk can tell "this
  // symbol has no rows this far back" from "the archive answered nothing at
  // all", and saying the first when the second happened is a lie about the
  // user's symbol (decision (xviii)).
  if (reason === "archive_unreachable") {
    return (
      <Banner variant="warning">
        Could not reach far enough back into the NSE archive for {result.params.symbol} — collected {have} of the{" "}
        {need} days {result.params.algoId} needs before the archive stopped answering. It may not cover this far back.
      </Banner>
    );
  }
  return (
    <Banner variant="info">
      {result.params.symbol} has {have} days of real listed history; {result.params.algoId} needs {need}. Nothing to
      benchmark over.
    </Banner>
  );
}
```

Replace the progress state declaration:

```tsx
  const [progress, setProgress] = useState<{ index: number; total: number } | null>(null);
```

with:

```tsx
  const [progress, setProgress] = useState<BenchmarkProgress | null>(null);
```

Replace the pill's label `<span>`:

```tsx
          <span>
            {selectedAlgoId} — bar {progress ? progress.index : 0}/{progress ? progress.total : "…"}
          </span>
```

with:

```tsx
          <span>{progressLabel(selectedAlgoId, progress)}</span>
```

Replace the result branch:

```tsx
      {result ? (
        <ResultsView api={api} result={result} />
      ) : (
```

with:

```tsx
      {result ? (
        result.insufficientHistory ? (
          <InsufficientHistory result={result} />
        ) : (
          <ResultsView api={api} result={result} />
        )
      ) : (
```

- [ ] **Step 4: Run the renderer tests to verify they pass**

Run: `npx vitest run test/renderer/BenchmarkView.test.tsx && npm run typecheck`
Expected: PASS — all pre-existing tests in the file plus the three new ones, clean typecheck. `ResultsView`'s `useEffect` hook order is untouched because the branch happens in `BenchmarkView`'s render, not inside `ResultsView`.

The vitest run is the check that this task's test-file edits (the three `BenchmarkProgress` reshapes plus the three new tests) are complete and correct. `npm run typecheck` here covers `BenchmarkView.tsx` only — `tsconfig.json` excludes `**/*.test.tsx`, so it never reads the test file and cannot tell you a reshape was missed.

- [ ] **Step 5: Confirm the CSS really was not touched**

Run: `git diff --stat electron-app/src/renderer/BenchmarkView.css`
Expected: empty output — this task changes no CSS (see this task's opening note).

- [ ] **Step 6: Run the full suites, both toolchains**

Run (from `electron-app/`): `npm test && npm run typecheck`
Run (from `rust-core/`): `cargo test --workspace`
Expected: PASS everywhere. The only `#[ignore]`d test is `ingestion`'s live NSE fetch smoke test, which is not run.

- [ ] **Step 7: Commit**

```bash
git add electron-app/src/renderer/BenchmarkView.tsx electron-app/test/renderer/BenchmarkView.test.tsx
git commit -m "feat(benchmark-ui): phase-aware progress pill and an insufficient-history banner"
```

---

## Manual verification checklist (not a task — never blocks phase completion)

Mirrors the Phase 6/11/12/13 precedent: an automatable golden path plus live follow-ups needing a real network. P14§8 explicitly asks that a real from-scratch backfill be confirmed by hand once.

**Automatable (mocked bridge + `npm start`, no network):**
- Selecting a `day`/`bhavcopy` lake entry, picking a fast algorithm with a small lookback, and running completes exactly as it does today — the pre-flight returns `sufficient: true` immediately and no backfill pill phase ever appears.
- Selecting a `minute`/`kaggle` lake entry and running never issues an `ensure_day_backfill` request at all (observable in the sidecar's stdin trace, or by adding a temporary `console.log` in `benchmarkBridge`). This is plan decision (viii) in practice.
- Same check for a `day`/`kite` entry — one written by the live warm-up path, not by bhavcopy. It must also issue no `ensure_day_backfill` and must run exactly as it does today. This is the half of decision (viii) that a timeframe-only gate would get wrong.
- A run whose mocked backfill returns `sufficient: false, archive_exhausted: false` shows the "N days of real listed history" sentence and neither the chart container nor the Copy-raw-result button.
- A run whose mocked backfill returns `sufficient: false, archive_exhausted: true` shows the "could not reach far enough back into the NSE archive" wording instead — the two must be visibly different messages, not one message reused.

**Live follow-ups (real sidecar binary + real network — never a blocker for calling Phase 14 done):**
- **The one P14§8 explicitly asks for:** from a lake holding only the current thin `NSE:ZYDUSWELL` day/bhavcopy partition (8 candles), run a benchmark against `kronos` and watch it walk. Confirm the pill counts up through "Backfilling history — N/256 days", that the run then proceeds to "kronos — bar i/N", and that a *second* run of the same symbol/algorithm starts at the frontier walk immediately with no backfill phase — the proof that the persisted data benefits every future run (P14§2 locked decision 6).
- Press Stop midway through that first backfill. Confirm the UI shows "Cancelled — partial results" (not a raw error), and that re-running resumes from the days already committed rather than from scratch — the proof that per-day persistence works (P14§4) and that decision (xii) holds.
- Confirm the `ingest` CLI still works end to end over a date range that *contains an NSE trading holiday* (e.g. `--from 2024-01-20 --to 2024-01-29`, which spans Republic Day on the 26th): it must now print per-day lines for the trading days, silently skip the holiday, and finish with its `done:` summary — where before this phase it aborted at the holiday.
- Spot-check that the politeness delay is actually in effect: a backfill of N days should take at least `N × 200ms`. If NSE ever starts rejecting the walk with a non-404 status, the run now surfaces that status and URL in the error banner (Task 1's `Fetch("HTTP {code} for {url}")`) rather than a bare transport message — that is the diagnostic P14§9's "IP-level blocking" risk needs.
- Verify a symbol that is genuinely delisted or pre-IPO trips the ten-absent-day heuristic and reports its real `have`, rather than walking backward indefinitely.
- **Bound check for decision (xviii), worth doing once:** run a ttm or moirai backfill (512 days) against a symbol whose history the UDiFF archive does not cover that far back, and confirm the walk *stops* — roughly 30 consecutive weekday attempts past the coverage edge, a few seconds at the politeness delay — and reports "could not reach far enough back into the NSE archive", rather than spinning until you press Stop. Temporarily pointing `bhavcopy_url` at a nonexistent host is the cheap way to force the all-404 condition on demand; the run must end on its own either way.

---

## Self-Review

**1. Spec coverage:**
- **P14§1** (purpose; bhavcopy is the one solvable source; intraday explicitly out) → no task fetches intraday; Global Constraints restates it; Task 7's timeframe **and source** gate enforces it in code, with the residual gaps named in decision (viii).
- **P14§2 item 1** (a shared reusable day-range primitive both callers use, distinguishing holiday-404 from real failure) → Tasks 1, 2, 3. The "both callers use it" requirement is met via `fetch_trading_day` rather than via `walk_trading_days_backward` itself; the reason is decision (ii).
- **P14§2 item 2** (`sidecar` depends on `ingestion`, confirmed acyclic; `EnsureDayBackfill` walks back from existing history or the requested date) → Task 5, with the dependency claim re-verified and strengthened in drift note 5 and a `cargo tree` check at Step 14.
- **P14§2 item 3** (`runBenchmark` calls it before the frontier walk, sized to the single selected `algoId`) → Task 7 Steps 2 and 5; the "single selected algoId" assertion is in the `"sizes the pre-flight against the one selected algorithm"` test.
- **P14§2 item 4** (progress streamed through the same `onBenchmarkProgress` channel, distinguished by `phase`) → Tasks 4, 6, 7, 8. No new channel is created anywhere; Global Constraints forbids one.
- **P14§2 item 5** (one clear message instead of a silent empty result) → Task 8's `InsufficientHistory`, with the message text asserted verbatim.
- **P14§2 item 6** (a politeness delay) → `POLITENESS_DELAY_MS` in Task 2, applied in Task 5 Step 11's fetch closure. Decision (xiv) states why it lives there and not in the walker.
- **P14§2 locked decisions 1-6** → (1) no second process: Global Constraints. (2) sizing per selected algo: Task 5's handler reads one `algo_id`. (3) `IngestionError::NotFound`: Task 1. (4) structural absent-history detection, no calendar ceiling: Task 5's `ABSENT_DAY_LIMIT` with three tests covering the limit, the reset, and the "absent is not an error" case. The separate `CLOSED_DAY_LIMIT` (decision (xviii)) is **not** a calendar ceiling of the kind locked decision 4 rejects — it bounds consecutive *unanswered* requests, not how far back the walk is willing to look, and it never fires while the archive keeps answering. (5) progress streams, no new cancellation: Tasks 4-8 plus Task 7's cancellation test. (6) writes via `write_sourced_candles`: Task 5 Step 9, plus a manual second-run check.
- **P14§3** (the real numbers) → every value re-verified against the tree (see the drift section's "checked and correct" list). The plan does not hardcode a lookback anywhere: `handle_ensure_day_backfill` reads it from the registry, and the tests assert against `lookback_of(...)` rather than a literal, so a changed model constant cannot make a test lie.
- **P14§4** (the `NotFound` variant, the status inspection, `DayOutcome`, `walk_trading_days_backward`'s shape, per-day persistence, the stop conditions) → Tasks 1, 2, 5. The signature gains an injected `fetch` parameter the spec's sketch omitted — without it P14§8's "not real network" requirement is unsatisfiable — and returns `WalkStop` rather than `()`, because the spec's single caller-owned exit leaves the walk unbounded against an archive that 404s everything (decision (xviii)). There are **three** stop conditions in the finished design, not two: enough bars, `ABSENT_DAY_LIMIT` absent trading days, and `CLOSED_DAY_LIMIT` consecutive weekday 404s.
- **P14§5** (request/response shapes, registry lookup, lake-depth read, resume point, one progress event per day) → Task 5, with `DayBackfillResponse.error` added per decision (ix), `.archive_exhausted` per decision (xviii), and the counted progress fields per decision (v).
- **P14§6** (the pre-flight call, forwarded progress with `phase`, the `insufficientHistory` result, the banner mirroring P13's `readinessMessage`) → Tasks 7 and 8. The citation drift on `benchmarkRunner.ts:80` is corrected in drift note 4.
- **P14§7** (no new cancellation mechanism) → no task adds one; Task 7's cancellation handling is pure TypeScript result-shaping around the rejection `cancelCurrent()` already produces.
- **P14§8** (the full test list) → walker counting, 404-skipped-and-not-counted, non-404 stops and propagates, ten-absent trips with holidays not breaking the streak, partial-lake resume → Task 2 Step 1 and Task 5 Step 6. Handler: already-sufficient with zero fetches, small top-up fetching only missing days, never-reachable returning the real `have` → Task 5 Step 6. `io.rs` 404-vs-other → Task 1 Step 1. TS `runBenchmark` insufficient/sufficient/phased-progress → Task 7 Step 3. TS `BenchmarkView` banner → Task 8 Step 1. No real network anywhere → Global Constraints. Manual real-backfill confirmation → the checklist's first live item. **Beyond the spec's list:** an all-404 fetcher terminating the walk at `CLOSED_DAY_LIMIT` (Task 2 Step 1), a traded day resetting that streak (Task 2 Step 1), the handler reporting that as `archive_exhausted` rather than a short history (Task 5 Step 6), the two outcomes being distinguishable on the wire (Task 5 Step 12), `runBenchmark` mapping them to different `reason`s (Task 7 Step 3), and `BenchmarkView` wording them differently (Task 8 Step 1).
- **P14§9 risks** → external-dependency risk is mitigated as far as code can by Task 1's status-and-URL-bearing error message reaching the UI banner (Task 7 decision (x)) **and** by decision (xviii)'s closed-day cap, which is what turns "the archive's URL format changed" from an infinite backward walk into a bounded, honestly-labelled failure; multi-minute first backfill is surfaced by the phased pill (Task 8) and bounded by decision (xi)'s timeout; the single-threaded-sidecar occupancy is restated, unchanged, and needs no code — it is bounded to the Benchmark tool's own sidecar process, and that scope is written up in "Accepted risks this plan does not close"; the ten-day heuristic's judgment-call nature is carried verbatim into `ABSENT_DAY_LIMIT`'s doc comment, and the closed-day cap's own judgment call is stated in the same place for `CLOSED_DAY_LIMIT`.

**2. Placeholder scan:** no "TBD", "handle edge cases", "add validation", "similar to Task N", or "write tests for the above" appears anywhere. Every code step carries the actual code. The two places an implementer supplies anything beyond transcription are both bounded and mechanical: Task 7 Step 1's 13 identical one-line insertions (with every pre-edit line number listed, an explicit count, and a bottom-up ordering instruction plus a re-grep fallback), and Task 5 Step 6/Step 9's two-part file (tests first, then production code prepended above them — stated explicitly in both steps).

**2a. Second verification pass, hunting Phase 13's specific failure modes.**
- *Stale line numbers:* every `path:line` in this document was read out of the working tree during planning, and five spec citations were found already drifted and are corrected in their own section rather than propagated into a task. The four `replace this exact code` blocks that quote existing source (`io.rs`'s request chain, `ingest.rs`'s `run_bhavcopy`, `protocol.rs`'s `ProgressLine`/`encode_progress`, `sidecarSupervisor.ts`'s `send`/`dispatch`, `benchmarkRunner.ts`'s deps/signature/`onProgress`, `BenchmarkView.tsx`'s pill and result branch) were each copied verbatim from the current file, not retyped.
- *Undercounted occurrence lists:* the one "replace every X" instruction in this plan is Task 7 Step 1. `grep -n "sidecar: {"` returns exactly 13 hits — 104, 123, 144, 159, 173, 196, 212, 226, 258, 287, 316, 347, 365 — all enumerated. The adjacent "3 positional `onProgress` call sites" claim was likewise grepped (`(index, total)` → lines 233, 265, 323 in the test file, 32 in `benchmarkBridge.ts`, 83 and 116 in `benchmarkRunner.ts`), and Step 10 adds a grep to prove nothing was missed. `testBridge.ts:40`'s `onBenchmarkProgress: vi.fn()` and `rendererApi.test.ts:75-79`'s channel-name assertion were checked and deliberately need **no** edit — an untyped `vi.fn()` satisfies the widened handler type, and that test never touches a payload shape.
- *Self-contradictory instructions:* checked specifically for the Phase 13 pattern of "remove an import that is still needed". Task 3 removes `Datelike` and `Weekday` from `ingest.rs` — `grep -n "Datelike\|Weekday" ingest.rs` returns exactly one use site, line 45, which that task deletes, so the removal is safe and is stated with that justification inline. Task 5 keeps `encode_progress` in `main.rs`'s import list (still used by the request-level bracket) while adding `encode_progress_counted`; it does not claim either is now unused.
- *Unverified expected values:* every numeric assertion was hand-computed against the actual logic, not transcribed. The backward trading-day sequence from Mon 2024-01-15 was derived and cross-checked against a real calendar: 15(Mon), 12(Fri), 11, 10, 9, 8(Mon), 5(Fri), 4, 3, 2, 1(Mon), 2023-12-29(Fri), 28, 27, 26, 25(Mon), 22(Fri) — which is what makes Task 5's ten-absent test expect exactly 10 fetches ending 2024-01-02, and its streak-reset test expect exactly 17 (6 absent + 1 present + 10 absent) ending 2023-12-22. `ist_session_close_epoch(2024-01-15) = 1_705_312_800` is the value `bhavcopy_parse_test.rs` already asserts; `1_705_257_000` is that minus 15.5 hours (55 800s), i.e. IST midnight that morning, and `1_705_256_999` one second earlier — so the pair distinguishes an IST-based conversion from a UTC-based one, which is the whole point of that test. Task 7's three reshaped progress assertions keep today's already-passing numbers (`[0,5]…[4,5]`, `[0,1]`, `[0,2]/[1,2]`) because `backfillOk()` emits no progress; only the `"run"` tag is new. Task 7's new phased-progress test computes `N=3, L=1 → frontiers {0,1}` from the loop's own `i + lookaheadBars >= series.length` break, matching the file's existing convention. Task 4's exact-string assertion on `encode_progress` was derived from serde's declaration-order field emission, matching the substrings the pre-existing test already asserts.
- *Gaps found during this pass and closed by adding to the plan rather than noting:* the 30-second supervisor timeout that would have rejected every real backfill (decision (xi), tested in Task 6 Step 1), cancellation during the pre-flight escaping the existing `try` block (decision (xii), tested in Task 7 Step 3), a network failure rendering as "insufficient history" (decision (x), tested in Task 7 Step 3), the pre-flight firing for intraday entries (decision (viii), tested in Task 7 Step 3), and the shared bhavcopy fixture's fixed `TradDt` silently collapsing every fetched day onto one `ts` under `write_sourced_candles`'s merge (decision (xvii), which is why all three test modules build their CSV per date).

**2b. Third pass — defects found by independent verification after this plan was first committed, corrected in place.** Four, all of them in the plan text rather than in code, since no code exists yet.

- *`walk_trading_days_backward` could loop forever.* Its only exit was `on_day` returning `Break`, and `on_day` runs only for successfully fetched days — so a run of consecutive 404s (walking past the archive's coverage, which a 512-day ttm/moirai backfill genuinely reaches, or the archive's URL format changing) advanced nothing and the serial sidecar would spin backward one weekday at a time until the user hit Stop. Closed by decision (xviii): `CLOSED_DAY_LIMIT`, `WalkStop`, `DayBackfillResponse.archive_exhausted`, `insufficientHistory.reason`, and a differently-worded banner — threaded through Tasks 2, 5, 6, 7, 8, with an all-404 termination test at both the walker and the handler level.
- *The pre-flight gate ignored `params.source`.* Gating on `timeframe === "day"` alone would fire against a `("day", "kite")` entry written by the live warm-up path (`candleWarmup.ts`, `historicalDataArchive.ts`), checking and backfilling a different partition from the one the run then reads. Closed in decision (viii) and Task 7, with a dedicated `day`/`kite` test.
- *A false safety-net claim about `npm run typecheck`.* Several steps implied it would catch a missed test-fixture edit. It cannot: `tsconfig.json` excludes `**/*.test.ts(x)`, so `tsc --noEmit` never reads a test file. Corrected in Global Constraints and at each step that made the claim; the real check is the vitest run those steps already prescribe.
- *An undocumented side effect of the long backfill timeout.* Written up in "Accepted risks this plan does not close" rather than engineered around — see that section for why a global timeout raise would be the worse trade.

**3. Type consistency:** `DayBackfillResponse` is the name used in every task (the spec's competing `DayBackfillResult` is flagged in drift note 6 and used nowhere). Its six fields — `id`, `have`, `need`, `sufficient`, `archive_exhausted`, `error` — are identical across `protocol.rs` (Task 5), `protocol_test.rs` (Task 5), `main.rs`'s two fallback literals (Task 5), `DayBackfillResponseWire` (Task 6), and every TypeScript fixture in Tasks 6-7; `archive_exhausted` is the one bool that is always serialized rather than skipped, and the `day_backfill` end-to-end test asserts it is present and `false` on a clean answer. `BenchmarkResult.insufficientHistory`'s three fields — `have`, `need`, `reason` — match between `benchmarkRunner.ts` (Task 7), its six fixtures and assertions in `benchmarkRunner.test.ts` (Task 7), and `InsufficientHistory`/its two tests in Task 8; `reason`'s two values, `"symbol_history"` and `"archive_unreachable"`, appear nowhere else and are never inferred from `have`/`need`. `ensureDayBackfill(symbol, algoId, onDayProgress?)`'s three-argument shape matches across its definition (Task 6), the `Pick` in `BenchmarkRunnerDeps` and `BenchmarkBridgeDeps` (Task 7), the production call site (Task 7 Step 5), and all six test fakes that assert on its arguments. `BenchmarkProgress { phase, index, total }` is byte-identical between `benchmarkRunner.ts` (Task 7), `rendererApi.ts`'s re-export (Task 7), the bridge's forwarded payload (Task 7), `BenchmarkView`'s state and `progressLabel` (Task 8), and every test. The Rust fetcher signature `&mut dyn FnMut(&str, NaiveDate) -> Result<Vec<u8>, IngestionError>` is written out identically in `fetch_trading_day`, `walk_trading_days_backward` (Task 2), `ingest_day_range` (Task 3), and `handle_ensure_day_backfill` (Task 5) — exchange first, date second, in all four. `walk_trading_days_backward`'s return type is `Result<WalkStop, IngestionError>` in its definition (Task 2), its interface list, its five call sites across Tasks 2 and 5, and the handler's `match walk { … }` — no task still treats it as `Result<()>`. `BACKFILL_TIMEFRAME`/`BACKFILL_SOURCE` are used for every store call in Task 5's handler, and the literals `"day"`/`"bhavcopy"` appear in its tests only where a test is deliberately asserting the concrete partition name.

**4. Judgment calls made during planning** — the eighteen entries in "Decisions this plan makes that the spec left open" are each stated with a reason, including the five the spec itself did not anticipate at all (the request timeout, pre-flight cancellation, error-vs-insufficient disambiguation, the partition gate, and the walker's own termination bound). The one the spec explicitly deferred — where `walk_trading_days_backward` lives — is decision (i). The places this plan knowingly leaves a user-visible gap are decision (viii)'s two residuals (an intraday benchmark against a thin `minute` partition, and a thin `("day", "kite")` partition, both still showing the original empty result because closing either requires a data source P14§1 rules out) and the three entries under "Accepted risks this plan does not close".
