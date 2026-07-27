# Phase 6 — Benchmark UI

Status: approved by user 2026-07-27 (brainstorming dialogue), pending implementation planning.
Author: design produced via superpowers:brainstorming, concretizing §10.4 (Benchmark UI) of `docs/superpowers/specs/2026-07-18-trade-assistant-design.md` and building on §10.3 (historical-replay harness), §10.1/§10.2 (public no-auth data), §8.1 (proactive scan gate), and §8.2 (security/CSP). Section references: "§N" → master design; "P5d§N" → `docs/superpowers/specs/2026-07-27-phase5d-settings-scan-scheduler-design.md`; "P6§N" → this document.

## P6§1 Purpose

§10.4 of the master design sketched a dedicated **Benchmark** screen: a candlestick chart with correct/incorrect/neutral markers over a real historical price series, an instrument+range+cadence setup, a single thin summary strip, click/hover detail popovers, and a copy-raw-result button — "a UI layer on top" of §10.3's replay harness, "not a second benchmarking implementation." §10.3 in turn described the replay mechanism: load public historical candles into the same Parquet lake live data uses, walk a point-in-time frontier forward, run the full pipeline at each frontier as if it were "now," and compare each verdict's direction against the realized future move. Both sections described the *shape*; neither pinned a lake-enumeration API, a sidecar wire protocol, a classification function, a cadence algorithm, or a file layout. This document supersedes both sketches for the Benchmark UI with the full concrete design: the new `ingest` CLI that must populate the lake first, the exact `storage::CandleStore::list_symbols` shape and its backing manifest, the exact new sidecar request/response variants and handlers, the exact TypeScript orchestrator (`benchmarkRunner.ts`) mirroring the live tick-pipeline shape, the exact renderer screen, and the exact `lightweight-charts` rendering wrapper.

Phase 6's place in the roadmap (`docs/superpowers/plans/2026-07-18-implementation-roadmap.md` §"Phase 6"): it depends on Phase 2's replay harness (`rust-core/crates/backtest/`) and Phase 5's chart/UI/IPC conventions, and packages nothing new architecturally beyond a UI over already-existing compute. Phase 7 (packaging/CI, §11) is next and remains unscoped by this document.

Everything obeys the master hard constraints (§2, §4). This phase adds **zero** order-related surface (P6§17): no Kite write-tool method, no new Claude tool grant, no order/GTT code path of any kind — the Benchmark UI reads historical candles from a local Parquet lake and runs deterministic compute over them; it never even contacts Kite live.

## P6§2 Scope

**In scope:**

1. Rust: a new CLI binary `rust-core/crates/ingestion/src/bin/ingest.rs` — a runnable entrypoint that wires up the already-implemented `fetch_udiff_bhavcopy`/`import_bhavcopy_files`/`import_intraday_files`, mirroring `replay.rs`'s manual arg-parsing style. No new parse/import logic (P6§3).
2. Rust: `storage::CandleStore::list_symbols` + a small lake manifest that makes it faithful, since the on-disk partition filenames are lossy (P6§4).
3. Rust: a new pure function `algo_core::benchmark_classify::classify_decision` and its `Outcome` type, unit-tested directly, no I/O (P6§5).
4. Rust: four new sidecar request variants (`ListLakeSymbols`, `ReadLakeCandles`, `BenchmarkCompute`, `EvaluateScanGateStateless`) and three new response variants (`LakeSymbols`, `LakeCandles`, `BenchmarkCompute`), the fourth request reusing the existing `ScanGate` response — all routed through `main.rs`'s existing per-request `catch_unwind` isolation. The sidecar crate gains a dependency on the `backtest` crate for `context_at` (P6§6).
5. TypeScript: the wire-protocol mirror in `sidecarProtocol.ts` and four new `SidecarSupervisor` methods (P6§7).
6. TypeScript: a new one-shot orchestrator `benchmarkRunner.ts` mirroring `scanScheduler.ts`'s DI style and the live tick-pipeline shape — walking historical candles frontier-by-frontier per cadence rule (P6§9), with horizon derived from the picked entry's timeframe (P6§8).
7. TypeScript: a new `benchmarkBridge.ts` (`benchmark:listLakeSymbols`/`benchmark:runBenchmark`) mirroring `historyBridge.ts`/`settingsBridge.ts`'s DI/registration pattern, and `RendererApi`/`buildRendererApi` extensions with the two new methods and their types (P6§10).
8. TypeScript renderer: a new top-level `BenchmarkView.tsx` screen (setup → run → chart+summary+popover+copy-raw), reached via a new top-level nav button from `App.tsx`, and a thin `benchmarkChart.ts` wrapper over `lightweight-charts` (a new npm dependency) (P6§11).
9. `bootstrap.ts` wires `registerBenchmarkBridge` alongside the other bridges, once, at `createApp()`'s top level (P6§10.3).

**Not in scope (deferred, or permanently out of scope — P6§20 has the full list):**

- Any change to the no-order-placement safety invariant (§2, §4).
- **Any AI-Assisted benchmark mode at all** (P6§2 decision below) — Engine-Only (deterministic) only; no response-mode picker/selector appears anywhere in the Benchmark UI. §10.4's "which response mode to benchmark" is deliberately narrowed to Engine-Only for this phase.
- Extending `run_replay`/`ReplayReport` (`rust-core/crates/backtest/src/engine.rs`) — that aggregate hit-rate/expectancy engine stays untouched; Benchmark execution is a separate TS-orchestrated frontier walk, not a bespoke Rust replay-report engine.
- Any change to the live `Compute` sidecar handler's closes-only `MarketContext::from_closes` path (§handlers.rs) — its Phase-1 limitation is out of scope here; the new `BenchmarkCompute` handler is a separate variant using full OHLCV via `context_at`.
- Any write to `HistoryStore` — a benchmark run is a test of the engine, not a chat session; nothing in this phase touches session/message history.
- Any corporate-action adjustment, survivorship handling, or data-quality repair of the ingested candles (§10.2's honest caveats stand).
- A config UI for `neutral_band` or lookahead defaults — sane code defaults only (P6§5, P6§8).

**Locked decisions this document writes up verbatim (from the completed brainstorming session):** (1) real data must be ingested first via a new `ingest` CLI; (2) benchmark reuses the live tick-pipeline *shape* in TS, not a new Rust engine; (3) Engine-Only only, no mode picker; (4) instrument/horizon picking lists lake-resident history, no Kite login required, horizon derived from timeframe; (5) cadence auto-binds to horizon (positional→session-close, intraday→stateless-gated) with a manual every-N override; (6) per-point compute uses full OHLCV via `context_at`, a new benchmark-only sidecar handler; (7) `generateDeterministicResponse` is reused unchanged per decision point; (8) classification is a new pure Rust function; (9) lookahead bars is a UI field with per-horizon defaults; (10) no history writes; (11) `lightweight-charts` rendering (candles+volume+markers), thin summary strip, progressive-disclosure popover; (12) copy-raw-result serializes the whole run via the contextBridge pattern.

## P6§3 Prerequisite: the `ingest` CLI (`rust-core/crates/ingestion/src/bin/ingest.rs`, new)

No Parquet lake data exists yet, and a benchmark cannot run against an empty lake. This binary is the first deliverable: a runnable entrypoint over the already-implemented parse/import functions, mirroring `replay.rs`'s existing manual `--flag value` arg-parsing (no new CLI-arg crate dependency, no new parse logic).

### P6§3.1 Two modes

```
usage: ingest --lake <dir> --mode bhavcopy --exchange <NSE|BSE> --from <YYYY-MM-DD> --to <YYYY-MM-DD>
       ingest --lake <dir> --mode intraday --source <kaggle|github_archive> --dir <dir>
```

**`--mode bhavcopy`:** for each trading date in the inclusive `[from, to]` range and the given `--exchange`, call the existing `fetch_udiff_bhavcopy(date, exchange)` (`ingestion::io`) to download+decompress one day's UDiFF equity bhavcopy, then `import_bhavcopy_files(&store, exchange, &[bytes])` (`ingestion::importer`) to parse and write it into the lake tagged `source = "bhavcopy"`, timeframe `"day"`. `--exchange` accepts a single value; run the CLI once per exchange to cover both NSE and BSE (keeps arg-parsing trivial, mirrors `replay.rs`). Saturdays and Sundays in the range are skipped without a fetch attempt (bhavcopy is a trading-day artifact — a weekend fetch would always 404); a weekday holiday that 404s is treated as a fetch failure per P6§13.

**`--mode intraday`:** read every `*.csv` file in `--dir`, deriving each file's `symbol` from its filename stem (e.g. `NSE:INFY.csv` → `"NSE:INFY"`, matching the community-archive per-symbol layout §10.2), assemble the `(symbol, csv_bytes)` pairs the existing `import_intraday_files(&store, source, &files)` (`ingestion::importer`) expects, and import with the given `--source` (`"kaggle"` or `"github_archive"`), timeframe `"minute"`. No network access in this mode.

### P6§3.2 Arg parsing and structure

Reuse `replay.rs`'s exact helpers verbatim in shape: `parse_args() -> HashMap<String, String>` (splits `--key value` pairs), `arg(&map, "key")` (required-flag lookup with a `USAGE`-carrying error), and a `run() -> Result<(), Box<dyn Error>>` wrapped by a `main()` that prints `error: {e}` to stderr and `std::process::exit(1)` on failure. Date parsing uses `chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")`, iterating with `date.succ_opt()`.

`fetch_udiff_bhavcopy` is network-touching and rustls-only (already so, `ingestion::io`); the CLI adds no new networking crate. Automated tests never hit the network (P6§14).

## P6§4 Storage: `list_symbols` + the lake manifest

### P6§4.1 Why the on-disk layout alone is insufficient (the key derivation finding)

`CandleStore` writes each sourced partition to `<root>/{sanitize(symbol)}_{sanitize(timeframe)}_{sanitize(source)}.parquet` (`candle_store.rs`'s `sourced_partition_path`), where `sanitize_component` replaces every non-ASCII-alphanumeric character with `_`. This is deliberately lossy and **not reversible**: `"NSE:INFY"` and `"NSE_INFY"` both sanitize to `NSE_INFY`, and the underscore-joined filename `NSE_INFY_day_bhavcopy.parquet` cannot be split back into `(symbol, timeframe, source)` unambiguously (the symbol itself contains underscores post-sanitization). The Parquet files carry only `ts/open/high/low/close/volume` columns — no identity column. **Therefore the original `exchange:tradingsymbol`, timeframe, and source are not derivable from the on-disk layout, and `list_symbols` needs a non-lossy record written at ingest time.** The per-partition time bounds and row count *are* derivable (a cheap DuckDB aggregate over the partition). This finding is the reason the design below adds a small manifest rather than a filename parser.

Because the lake is currently empty (P6§3), the manifest is populated from scratch by every write path going forward — the `ingest` CLI (via `import_*` → `write_sourced_candles`) and the live persist path (P5d/Phase-3 `handle_persist` → `write_sourced_candles`) — so no migration of pre-existing partitions is needed.

### P6§4.2 The manifest (`rust-core/crates/storage/src/lake_manifest.rs`, new)

A newline-delimited JSON index at `<root>/lake_manifest.jsonl`, one line per partition identity:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LakePartitionKey {
    pub symbol: String,
    pub timeframe: String,
    pub source: String,
}
```

`storage` already depends on `serde`/`serde_json` (added in P5d for `ConfluenceSnapshot`), so this adds no new crate dependency. The module exposes two helpers used only by `CandleStore`:

- `append_partition_key(root: &Path, key: &LakePartitionKey) -> Result<()>` — appends one JSON line to `lake_manifest.jsonl` (creating it if absent). Append-only, never a full rewrite.
- `read_partition_keys(root: &Path) -> Result<Vec<LakePartitionKey>>` — reads the file (a missing file is an empty lake, not an error — mirrors `read_partition`'s "never-written partition is empty" convention), parses each non-blank line, and **dedups** by value (defends against any accidental duplicate line).

`StorageError` already has an `Io` and a `Json` variant (P5d§3.3), so the manifest needs no new error variant.

### P6§4.3 Recording on write (one guarded change to `write_sourced_candles`)

`write_sourced_candles` records the partition's identity **only on first creation**, keeping the hot path O(1) and the manifest append-only:

```rust
pub fn write_sourced_candles(&self, symbol: &str, timeframe: &str, source: &str, candles: &[Candle]) -> Result<()> {
    let path = self.sourced_partition_path(symbol, timeframe, source);
    let is_new_partition = !path.exists();
    // ...existing read-merge-write body, unchanged...
    self.write_partition(&path, &ordered)?;
    if is_new_partition {
        lake_manifest::append_partition_key(
            &self.root,
            &LakePartitionKey { symbol: symbol.to_string(), timeframe: timeframe.to_string(), source: source.to_string() },
        )?;
    }
    Ok(())
}
```

Re-ingesting the same symbol day-by-day (the common accumulate-more-history case) finds the partition already exists and appends nothing, so importing 1800 bhavcopy symbols across many days appends each identity exactly once, ever. `write_candles` (the non-sourced, test-only method) is **not** manifested — all real lake data flows through `write_sourced_candles`, and `list_symbols` intentionally reports only sourced partitions.

### P6§4.4 `list_symbols` and its return type

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct LakeSymbolEntry {
    pub symbol: String,      // original "NSE:INFY", from the manifest
    pub timeframe: String,   // "day" | "minute" | "5minute" | "15minute"
    pub source: String,      // "bhavcopy" | "kaggle" | "github_archive" | "kite"
    pub from_ts: i64,        // min candle ts (Unix epoch seconds)
    pub to_ts: i64,          // max candle ts
    pub candle_count: usize, // row count
}

pub fn list_symbols(&self) -> Result<Vec<LakeSymbolEntry>> { /* ... */ }
```

Implementation: read the manifest keys; for each key, re-derive its partition path via the existing `sourced_partition_path(symbol, timeframe, source)` (so the manifest need not store the filename); skip a key whose partition file is missing (defensive); otherwise compute bounds with a single DuckDB aggregate over the partition, reusing the existing in-memory-`Connection` + `escape_sql_literal` pattern from `read_partition`:

```rust
fn partition_bounds(&self, path: &Path) -> Result<(i64, i64, usize)> {
    let path_str = Self::escape_sql_literal(&path.to_string_lossy());
    let conn = Connection::open_in_memory()?;
    let (min_ts, max_ts, count): (i64, i64, i64) = conn.query_row(
        &format!("SELECT min(ts), max(ts), count(*) FROM read_parquet('{path_str}')"),
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    Ok((min_ts, max_ts, count as usize))
}
```

Entries are returned sorted by `(symbol, timeframe, source)` for a stable picker order. `LakeSymbolEntry` and `LakePartitionKey` are re-exported from `rust-core/crates/storage/src/lib.rs`.

### P6§4.5 Test additions (`rust-core/crates/storage/tests/candle_store_test.rs`, extended or new alongside existing inline tests)

- `list_symbols_on_an_empty_lake_returns_empty` — fresh store, no writes → `[]`, no error (missing manifest is an empty lake).
- `list_symbols_groups_multi_source_multi_symbol_correctly` — write `NSE:INFY`/`day`/`bhavcopy`, `NSE:TCS`/`day`/`bhavcopy`, and `NSE:INFY`/`minute`/`kaggle`; assert three distinct entries with the correct original symbol/timeframe/source (proving the manifest, not the lossy filename, drives identity — the `"NSE:INFY"` colon survives round-trip).
- `list_symbols_reports_correct_ts_bounds_and_count` — write a known 3-candle series, assert `from_ts`/`to_ts`/`candle_count` match `min`/`max`/`3`.
- `re_ingesting_the_same_partition_does_not_duplicate_its_manifest_entry` — `write_sourced_candles` for the same `(symbol, timeframe, source)` twice with different days; assert `list_symbols` returns exactly one entry for it, with `candle_count` reflecting the merged total.

## P6§5 `benchmark_classify.rs`: the pure classification function

New file `rust-core/crates/algo-core/src/benchmark_classify.rs`. Pure, deterministic, no I/O — directly unit-tested, matching the crate's `scan_gate.rs`/`confluence.rs` style for a pure aggregation-adjacent module.

```rust
use crate::Direction;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Correct,
    Incorrect,
    Neutral,
}

/// A realized return whose absolute value is within this band of zero is a
/// "flat market, no real move" -- classified Neutral even for a directional
/// call. 0.1%, documented as a starting default (overridable later if it
/// proves wrong empirically), following the DIRECTION_DEADBAND = 0.05
/// precedent in deterministicResponseGenerator.ts. Not a locked constant
/// needing a config UI in this phase.
pub const DEFAULT_NEUTRAL_BAND: f64 = 0.001;

pub fn classify_decision(direction: Direction, realized_return: f64, neutral_band: f64) -> Outcome {
    // A neutral call is never right or wrong about a move it did not predict.
    if direction == Direction::Neutral {
        return Outcome::Neutral;
    }
    // A directional call in a market that barely moved is a non-event, not a
    // hit or a miss -- scored Neutral so a flat tape does not inflate either count.
    if realized_return.abs() <= neutral_band {
        return Outcome::Neutral;
    }
    let matches = match direction {
        Direction::Bullish => realized_return > 0.0,
        Direction::Bearish => realized_return < 0.0,
        Direction::Neutral => unreachable!("handled above"),
    };
    if matches { Outcome::Correct } else { Outcome::Incorrect }
}
```

`rust-core/crates/algo-core/src/lib.rs` gains `pub mod benchmark_classify;` (matching how `scan_gate`/`confluence` are exposed as public module namespaces). Callers use `algo_core::benchmark_classify::{classify_decision, Outcome, DEFAULT_NEUTRAL_BAND}`.

This function is the **canonical, tested home** of the classification rule. It is not reachable from the TS `benchmarkRunner` (no sidecar request wraps it — see P6§9.4 for why, and for the deliberate, precedent-following TS mirror that the runner actually calls). The Rust definition anchors the semantics and its unit tests; the aggregate `run_replay` engine's inline sign check (`engine.rs`) is deliberately left as-is and not refactored to call this — that is a separate concern (P6§16).

### P6§5.1 Test file (`rust-core/crates/algo-core/tests/benchmark_classify_test.rs`, new)

Following the crate's separate-`tests/<name>_test.rs` convention (as `scan_gate_test.rs`):

- `bullish_with_a_positive_return_is_correct`.
- `bullish_with_a_negative_return_is_incorrect`.
- `bearish_with_a_negative_return_is_correct`.
- `neutral_direction_is_always_neutral_regardless_of_return` — Neutral + a large positive return, and Neutral + a large negative return, both → Neutral.
- `a_tiny_return_within_the_band_is_neutral_even_for_a_directional_call` — Bullish + a return `<= DEFAULT_NEUTRAL_BAND` → Neutral.
- `a_return_exactly_at_the_band_edge_is_neutral` — `realized_return.abs() == neutral_band` → Neutral (inclusive `<=`).

## P6§6 Sidecar protocol additions

### P6§6.1 New request/response variants (`rust-core/crates/sidecar/src/protocol.rs`)

`CandleWire` gains `Serialize` (it is currently `Deserialize`-only — a request payload — but `ReadLakeCandles`'s `LakeCandles` response is the first place the sidecar emits candles). This mirrors exactly how P5d gave `ConfluenceWire` a `Deserialize` for its first consuming request:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandleWire { pub ts: i64, pub open: f64, pub high: f64, pub low: f64, pub close: f64, pub volume: i64 }
```

New request payloads:

```rust
#[derive(Debug, Deserialize)]
pub struct ListLakeSymbolsRequest { pub id: u64 }

#[derive(Debug, Deserialize)]
pub struct ReadLakeCandlesRequest { pub id: u64, pub symbol: String, pub timeframe: String, pub source: String }

#[derive(Debug, Deserialize)]
pub struct BenchmarkComputeRequest {
    pub id: u64,
    pub symbol: String,
    pub timeframe: String,
    pub horizon: String,        // "intraday" | "positional"
    pub candles: Vec<CandleWire> // the visible window series[0..=frontier], ascending by ts
}

#[derive(Debug, Deserialize)]
pub struct EvaluateScanGateStatelessRequest {
    pub id: u64,
    pub prev: Option<ConfluenceWire>,
    pub curr: ConfluenceWire,
}
```

New wire struct + response payloads (`AlgoResultWire`/`ConfluenceWire` reused unchanged):

```rust
#[derive(Debug, Serialize)]
pub struct LakeSymbolWire {
    pub symbol: String,
    pub timeframe: String,
    pub source: String,
    pub from_ts: i64,
    pub to_ts: i64,
    pub candle_count: usize,
}

#[derive(Debug, Serialize)]
pub struct LakeSymbolsResponse {
    pub id: u64,
    pub entries: Vec<LakeSymbolWire>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LakeCandlesResponse {
    pub id: u64,
    pub candles: Vec<CandleWire>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BenchmarkComputeResponse {
    pub id: u64,
    pub algo_results: Vec<AlgoResultWire>,
    pub confluence: ConfluenceWire,
}
```

`EvaluateScanGateStateless` reuses the **existing** `ScanGateResponse` (`{ id, decision, error? }`, tag `scan_gate`) — no new response type for it. So this phase adds four request variants and three response variants:

```rust
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarRequest {
    Compute(ComputeRequest),
    PersistCandles(PersistCandlesRequest),
    AddWatchlistSymbol(AddWatchlistSymbolRequest),
    RemoveWatchlistSymbol(RemoveWatchlistSymbolRequest),
    ListWatchlist(ListWatchlistRequest),
    EvaluateScanGate(EvaluateScanGateRequest),
    ListLakeSymbols(ListLakeSymbolsRequest),
    ReadLakeCandles(ReadLakeCandlesRequest),
    BenchmarkCompute(BenchmarkComputeRequest),
    EvaluateScanGateStateless(EvaluateScanGateStatelessRequest),
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarResponse {
    Compute(ComputeResponse),
    PersistCandles(PersistCandlesResponse),
    Watchlist(WatchlistResponse),
    ScanGate(ScanGateResponse),
    LakeSymbols(LakeSymbolsResponse),
    LakeCandles(LakeCandlesResponse),
    BenchmarkCompute(BenchmarkComputeResponse),
}
```

Wire shapes, concretely:

```json
{"type":"list_lake_symbols","id":20}
{"type":"read_lake_candles","id":21,"symbol":"NSE:INFY","timeframe":"day","source":"bhavcopy"}
{"type":"benchmark_compute","id":22,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":1710000000,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100}]}
{"type":"evaluate_scan_gate_stateless","id":23,"prev":null,"curr":{"bullish_count":5,"bearish_count":2,"neutral_count":10,"weighted_vote":0.12}}
```

```json
{"type":"lake_symbols","id":20,"entries":[{"symbol":"NSE:INFY","timeframe":"day","source":"bhavcopy","from_ts":1690000000,"to_ts":1710000000,"candle_count":240}]}
{"type":"lake_candles","id":21,"candles":[{"ts":1710000000,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100}]}
{"type":"benchmark_compute","id":22,"algo_results":[...],"confluence":{"bullish_count":3,"bearish_count":1,"neutral_count":8,"weighted_vote":0.18}}
{"type":"scan_gate","id":23,"decision":"WorthLook"}
```

### P6§6.2 New handlers (`rust-core/crates/sidecar/src/handlers.rs`)

`Cargo.toml` gains `backtest = { path = "../backtest" }` (dependency graph stays acyclic: `sidecar → backtest → {ingestion, storage, algo-core}`; `backtest` does not depend on `sidecar`). The `BenchmarkCompute` handler builds `MarketContext` via `backtest::frontier::context_at` — the full-OHLCV builder — **not** `MarketContext::from_closes`:

```rust
use backtest::frontier::context_at;
use algo_core::benchmark_classify; // canonical classify lives here even though this handler does not call it

fn parse_timeframe(s: &str) -> Timeframe { /* "minute"|"5minute"|"15minute" -> variants, else Day (mirrors handle_request) */ }
fn parse_horizon(s: &str) -> Horizon { if s == "intraday" { Horizon::Intraday } else { Horizon::Positional } }

pub fn handle_benchmark_compute(request: BenchmarkComputeRequest) -> BenchmarkComputeResponse {
    let candles: Vec<Candle> = request.candles.iter().map(|c| Candle {
        ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    }).collect();
    if candles.is_empty() {
        return BenchmarkComputeResponse { id: request.id, algo_results: Vec::new(), confluence: zeroed_confluence() };
    }
    let timeframe = parse_timeframe(&request.timeframe);
    let horizon = parse_horizon(&request.horizon);
    // Full OHLCV context at the last visible bar -- richer than the live
    // Compute handler's closes-only from_closes path (that path is left
    // unchanged). Anti-lookahead holds: context_at's as_of is the frontier
    // bar's own ts, and only series[0..=frontier] is in the window.
    let ctx = context_at(&candles, candles.len() - 1, &request.symbol, timeframe, horizon);
    let algos = registry::all_for_binary();
    let outputs = run_applicable(&algos, &ctx);
    let weights: HashMap<&str, f64> = HashMap::new();
    let confluence = compute_confluence(&outputs, &weights);
    BenchmarkComputeResponse {
        id: request.id,
        algo_results: outputs.iter().map(algo_output_to_wire).collect(),
        confluence: confluence_to_wire(&confluence),
    }
}

pub fn handle_read_lake_candles(store: &CandleStore, request: ReadLakeCandlesRequest) -> LakeCandlesResponse {
    match store.read_sourced_candles(&request.symbol, &request.timeframe, &request.source) {
        Ok(candles) => LakeCandlesResponse { id: request.id, candles: candles.iter().map(candle_to_wire).collect(), error: None },
        Err(e) => LakeCandlesResponse { id: request.id, candles: Vec::new(), error: Some(e.to_string()) },
    }
}

pub fn handle_list_lake_symbols(store: &CandleStore, request: ListLakeSymbolsRequest) -> LakeSymbolsResponse {
    match store.list_symbols() {
        Ok(entries) => LakeSymbolsResponse { id: request.id, entries: entries.iter().map(lake_entry_to_wire).collect(), error: None },
        Err(e) => LakeSymbolsResponse { id: request.id, entries: Vec::new(), error: Some(e.to_string()) },
    }
}

pub fn handle_evaluate_scan_gate_stateless(request: EvaluateScanGateStatelessRequest) -> ScanGateResponse {
    let curr = wire_to_scorecard(&request.curr);
    let prev = request.prev.as_ref().map(wire_to_scorecard);
    // ZERO StateStore I/O: a pure wrapper over evaluate_scan_gate. No
    // get_last_snapshot, no set_last_snapshot, nothing touches state.sqlite3 /
    // scan_snapshots -- a benchmark run can never corrupt the live proactive
    // scanner's per-symbol gate memory.
    let decision = evaluate_scan_gate(prev.as_ref(), &curr, &GateThresholds::default());
    ScanGateResponse { id: request.id, decision: format!("{decision:?}"), error: None }
}
```

`algo_output_to_wire`/`candle_to_wire`/`lake_entry_to_wire`/`confluence_to_wire`/`zeroed_confluence` are small mapping helpers; `algo_output_to_wire` and `confluence_to_wire` are extracted from the existing `handle_request` body (identical field-for-field mapping) rather than duplicated — a pure refactor of the mapping, leaving `handle_request`'s behavior byte-identical. `ReadLakeCandles` deliberately wraps `read_sourced_candles` (not `read_candles`): all lake data lives in sourced partitions (`{s}_{t}_{src}.parquet`), so a source-less read would return an empty non-sourced partition. The `source` field on `ReadLakeCandlesRequest` and `LakeSymbolWire` exists precisely so the renderer round-trips the exact partition `list_symbols` reported (P6§16 item 2 flags this as a deliberate correction of the brainstorm's shorthand "wraps read_candles").

Handler inline tests (matching the crate's existing inline-`#[cfg(test)]` convention):
- `handle_benchmark_compute_reaches_run_applicable_with_full_ohlcv` — feed a candle window with distinct open/high/low/close/volume and assert an algorithm that reads non-close series (e.g. an ATR/volume-based one) contributes, contrasting with a closes-only context where it could not. This proves `context_at` (full OHLCV), not `from_closes`, is on this path.
- `handle_benchmark_compute_on_empty_candles_returns_a_zeroed_response` (no panic).
- `handle_read_lake_candles_reads_back_a_written_sourced_partition`.
- `handle_list_lake_symbols_returns_one_entry_per_written_partition`.
- `handle_evaluate_scan_gate_stateless_matches_the_persistent_gate_for_identical_inputs` — same `prev`/`curr` as a persistent `handle_evaluate_scan_gate` call yields the same `decision`, **and** assert the stateless call performed zero `StateStore` writes (open a `StateStore`, run the stateless handler, assert `scan_snapshots` is still empty).

### P6§6.3 `main.rs` routing

`main.rs` already opens `store: Option<CandleStore>` and `state_store: Option<StateStore>` from `--lake-root`. Add four match arms, each wrapped in the same `panic::catch_unwind(AssertUnwindSafe(...))` isolation as every existing variant:

- `ListLakeSymbols` / `ReadLakeCandles` require `store`; fall back to the same `"no --lake-root configured"` message (carried in the response's `error` field, with `entries`/`candles` empty) when `store` is `None`, exactly as `PersistCandles` does. Panic fallback: an `error`-carrying empty response.
- `BenchmarkCompute` requires **no** store (it computes purely from the request's candles). It always answers; a panic falls back to a zeroed `BenchmarkComputeResponse` (mirroring `empty_response`'s role for `Compute`).
- `EvaluateScanGateStateless` requires **no** store (pure). It always answers; a panic falls back to `ScanGateResponse { id, decision: "NoChange", error: Some("evaluate_scan_gate_stateless panicked") }`.

### P6§6.4 Protocol + end-to-end test additions

`rust-core/crates/sidecar/tests/protocol_test.rs`: parse/encode round trips for the four new request tags and the three new response tags, plus a round trip proving `CandleWire` now serializes (a `LakeCandlesResponse` encodes the six numeric fields).

`rust-core/crates/sidecar/tests/end_to_end_test.rs`: a spawned-binary test with `--lake-root <tempdir>` that first `persist_candles` a known series, then `list_lake_symbols` (asserts the entry appears with correct bounds), `read_lake_candles` (asserts the series reads back), `benchmark_compute` over a window (asserts a well-formed `algo_results`/`confluence`), and `evaluate_scan_gate_stateless` (asserts a `scan_gate` decision) — plus a panic-isolation regression test sandwiching a malformed `benchmark_compute` request between two valid ones, asserting all three are answered and the process exits cleanly. An explicit assertion that a `benchmark_compute` request answers with no `--lake-root` at all (proving it needs no store).

## P6§7 TypeScript sidecar mirror

### P6§7.1 `sidecarProtocol.ts` additions

```typescript
export interface LakeSymbolWire {
  type?: never; // (documentation: this is a nested element, not a top-level response)
  symbol: string;
  timeframe: string;
  source: string;
  from_ts: number;
  to_ts: number;
  candle_count: number;
}

export interface LakeSymbolsResponseWire {
  type: "lake_symbols";
  id: number;
  entries: LakeSymbolWire[];
  error?: string;
}

export interface LakeCandlesResponseWire {
  type: "lake_candles";
  id: number;
  candles: CandleWire[];
  error?: string;
}

export interface BenchmarkComputeResponseWire {
  type: "benchmark_compute";
  id: number;
  algo_results: AlgoResultWire[];
  confluence: ConfluenceWire;
}

export type SidecarResponseWire =
  | ComputeResponseWire
  | PersistCandlesResponseWire
  | WatchlistResponseWire
  | ScanGateResponseWire
  | LakeSymbolsResponseWire
  | LakeCandlesResponseWire
  | BenchmarkComputeResponseWire;

// SidecarRequestWire gains:
//   | { type: "list_lake_symbols"; id: number }
//   | { type: "read_lake_candles"; id: number; symbol: string; timeframe: string; source: string }
//   | { type: "benchmark_compute"; id: number; symbol: string; timeframe: string; horizon: string; candles: CandleWire[] }
//   | { type: "evaluate_scan_gate_stateless"; id: number; prev: ConfluenceWire | null; curr: ConfluenceWire }
```

(The `type?: never` line on `LakeSymbolWire` is illustrative shorthand; in the actual file `LakeSymbolWire` is a plain nested interface with the six data fields and no `type` tag.)

### P6§7.2 `SidecarSupervisor` additions

Four new methods, each building a tagged request and delegating to the existing `send()` (which owns id-assignment, the per-request timeout, and pending-map correlation — no new plumbing):

```typescript
listLakeSymbols(): Promise<LakeSymbolsResponseWire> {
  return this.send({ type: "list_lake_symbols", id: this.nextId }) as Promise<LakeSymbolsResponseWire>;
}

readLakeCandles(symbol: string, timeframe: string, source: string): Promise<LakeCandlesResponseWire> {
  return this.send({ type: "read_lake_candles", id: this.nextId, symbol, timeframe, source }) as Promise<LakeCandlesResponseWire>;
}

benchmarkCompute(symbol: string, timeframe: string, horizon: string, candles: CandleWire[]): Promise<BenchmarkComputeResponseWire> {
  return this.send({ type: "benchmark_compute", id: this.nextId, symbol, timeframe, horizon, candles }) as Promise<BenchmarkComputeResponseWire>;
}

evaluateScanGateStateless(prev: ConfluenceWire | null, curr: ConfluenceWire): Promise<ScanGateResponseWire> {
  return this.send({ type: "evaluate_scan_gate_stateless", id: this.nextId, prev, curr }) as Promise<ScanGateResponseWire>;
}
```

`evaluateScanGateStateless` reuses the existing `ScanGateResponseWire` return type. A `BenchmarkCompute` request over a large positional series can exceed the default 30 s per-request timeout only if the window is enormous; the runner sends one bounded window per frontier (P6§9), each a single fast compute, so the existing `DEFAULT_REQUEST_TIMEOUT_MS` is unchanged.

### P6§7.3 Test additions

`sidecarProtocol.test.ts`: encode/decode coverage for the four new request shapes and three new response shapes. `sidecarSupervisor.test.ts`: each of the four new methods resolves via a fake child responding with the matching `type` tag (mirroring the existing `compute`/`persistCandles` resolution tests), and rejects on timeout exactly like the existing `compute` timeout test (proving they share `send()`'s one timeout implementation).

## P6§8 Horizon derivation and benchmark constants

Horizon is **derived** from the picked entry's timeframe, never a separately chosen field (locked decision 4). A single pure helper, exported from `benchmarkRunner.ts`:

```typescript
export function horizonForTimeframe(timeframe: string): Horizon {
  return timeframe === "day" ? "positional" : "intraday"; // "minute" | "5minute" | "15minute" -> intraday
}
```

This deliberately reads the timeframe that actually exists in the lake per entry — community-archive-ingested intraday data is stored under timeframe `"minute"` (P6§3.1), not `"5minute"`, so the picker must not assume `"5minute"`; `horizonForTimeframe` maps any non-`"day"` timeframe to `"intraday"`.

Cadence auto-binds to horizon, with a manual override:

```typescript
export type BenchmarkCadence =
  | { mode: "session_close" }              // positional default: every daily bar is a decision point
  | { mode: "stateless_gate" }             // intraday default: live-equivalent gating (P6§9.2)
  | { mode: "manual"; everyN: number };    // exploratory/debugging override: every Nth bar

export function defaultCadenceForHorizon(horizon: Horizon): BenchmarkCadence {
  return horizon === "positional" ? { mode: "session_close" } : { mode: "stateless_gate" };
}
```

Lookahead-bars defaults, prefilled in the setup UI and adjustable per-run:

```typescript
export const DEFAULT_POSITIONAL_LOOKAHEAD_BARS = 5;  // ~1 trading week of day bars
export const DEFAULT_INTRADAY_LOOKAHEAD_BARS = 30;   // ~30 minute bars

export function defaultLookaheadForHorizon(horizon: Horizon): number {
  return horizon === "positional" ? DEFAULT_POSITIONAL_LOOKAHEAD_BARS : DEFAULT_INTRADAY_LOOKAHEAD_BARS;
}
```

## P6§9 `benchmarkRunner.ts` (`electron-app/src/main/services/benchmark/benchmarkRunner.ts`, new)

A one-shot orchestrator mirroring `scanScheduler.ts`'s dependency-injection discipline (an explicit `deps` object, an injectable sidecar, no direct singletons) and the live tick-pipeline **shape** (gate → decide → act, per frontier). Because a benchmark run is a single invocation rather than a resident timer loop, it is an async function with a DI'd deps object, not a class — the appropriate shape for a one-shot (P6§16 item 5).

### P6§9.1 Types and entry point

```typescript
export interface BenchmarkRunnerDeps {
  sidecar: Pick<SidecarSupervisor, "readLakeCandles" | "benchmarkCompute" | "evaluateScanGateStateless">;
}

export interface BenchmarkRunParams {
  symbol: string;
  timeframe: string;
  source: string;
  horizon: Horizon;             // derived via horizonForTimeframe(timeframe)
  cadence: BenchmarkCadence;
  lookaheadBars: number;
  fromTs: number;               // inclusive working-range start (Unix epoch seconds)
  toTs: number;                 // inclusive working-range end
}

export type Outcome = "correct" | "incorrect" | "neutral";

export interface DecisionPoint {
  frontierIndex: number;        // index into the working series
  ts: number;                   // series[frontierIndex].ts (frontier bar timestamp)
  closeAtFrontier: number;      // series[frontierIndex].close
  closeAtLookahead: number;     // series[frontierIndex + lookaheadBars].close
  realizedReturn: number;       // (closeAtLookahead - closeAtFrontier) / closeAtFrontier
  direction: Direction;         // from generateDeterministicResponse
  conviction: Conviction;
  responseText: string;         // the deterministic Verdict-equivalent prose
  algoResults: AlgoResultWire[];// full per-frontier algorithm outputs
  confluence: ConfluenceWire;   // full per-frontier confluence scorecard
  outcome: Outcome;
}

export interface BenchmarkResult {
  params: BenchmarkRunParams;   // echoes the setup so the copy-raw blob is self-describing
  candles: CandleWire[];        // the working series (the chart's full price data)
  decisionPoints: DecisionPoint[];
}

export async function runBenchmark(deps: BenchmarkRunnerDeps, params: BenchmarkRunParams): Promise<BenchmarkResult>;
```

The summary strip's counts and hit-rate are **not** on `BenchmarkResult` — they are computed client-side from `decisionPoints` (P6§11.3), matching §10.4's "computed from the array."

### P6§9.2 The frontier walk

1. `const { candles } = await deps.sidecar.readLakeCandles(params.symbol, params.timeframe, params.source)` — one read of the full sourced partition, ascending by ts.
2. Slice to the working series: `const series = candles.filter((c) => c.ts >= params.fromTs && c.ts <= params.toTs)`.
3. Walk frontiers `i = 0 .. series.length - 1`, stopping at the lookahead boundary: **break when `i + params.lookaheadBars >= series.length`** (mirrors `run_replay`'s `i + horizon_bars >= series.len() → break`, `engine.rs`). At each `i`, per cadence:
   - **`session_close`** (positional default): every `i` is a decision point (no gating — each daily bar is a decision point, §10.4).
   - **`stateless_gate`** (intraday default): compute at every `i` (needed to feed the gate), thread an in-memory `prevConfluence: ConfluenceWire | null` (starts `null`), call `deps.sidecar.evaluateScanGateStateless(prevConfluence, currConfluence)`, then set `prevConfluence = currConfluence`. The frontier is a decision point **only if** `decision !== "NoChange"`. The `prevConfluence` is scoped to this one run, never persisted — a benchmark can never corrupt the live scanner's `scan_snapshots` gate memory (that is the whole point of the stateless sidecar variant, P6§6.2).
   - **`manual`** (override): `i` is a decision point iff `i % everyN === 0`.
4. Producing a decision point at `i`:
   - The `stateless_gate` path already has `currConfluence`/`algoResults` from the gate's own compute; the `session_close`/`manual` paths call `deps.sidecar.benchmarkCompute(symbol, timeframe, horizon, series.slice(0, i + 1))` (the visible window `series[0..=i]`) to get them. (`benchmarkCompute` is called at most once per frontier in every cadence.)
   - Guard against a zero/negative frontier close (data glitch): if `series[i].close <= 0`, **skip this frontier's decision point** — no classification, no marker (mirrors `run_replay`'s `current <= 0.0 → continue`, `engine.rs`). The candle still renders on the chart (it is in `series`), just without a marker.
   - Build a minimal `AnalysisEnvelope` (P6§9.3), call `generateDeterministicResponse(envelope)` → `{ direction, conviction, text }` (reused **unchanged**).
   - `realizedReturn = (series[i + lookaheadBars].close - series[i].close) / series[i].close`.
   - `outcome = classifyDecision(direction, realizedReturn)` (P6§9.4).
   - Push a `DecisionPoint`.
5. Return `{ params, candles: series, decisionPoints }`.

### P6§9.3 The minimal envelope

`generateDeterministicResponse(envelope)` reads only `envelope.confluence` and `envelope.algo_results` (verified against `deterministicResponseGenerator.ts` — it never touches `instrument`/`horizon`/`intent_lens`). The runner constructs a type-valid envelope where only those two fields are load-bearing:

```typescript
const envelope: AnalysisEnvelope = {
  trigger: "reactive",
  instrument: { symbol: params.symbol, exchange: params.symbol.split(":")[0] ?? "", segment: "", kite_token_asof: "" },
  horizon_requested: params.horizon,
  intent_lens: "buying",
  algo_results: compute.algo_results,
  confluence: compute.confluence,
  overlays: {},
};
```

`segment`/`kite_token_asof` are empty and `intent_lens` is a placeholder — none is read by `generateDeterministicResponse`; they exist only to satisfy the `AnalysisEnvelope` type. A benchmark never has a live Kite token, by design (the lake decouples benchmarking from Kite session state, locked decision 4).

### P6§9.4 Classification: the TS mirror of the canonical Rust rule

The canonical classification lives in Rust (`classify_decision`, P6§5), but **no sidecar request wraps it** — the locked scope lists exactly four new sidecar requests, none of which is a classify request, and classification sits between two TS-side operations (`generateDeterministicResponse` and reading `series[i+lookahead].close`, both in the runner). The runner therefore calls a small pure TS mirror, a deliberate second-copy-across-the-boundary of exactly the same kind this codebase already uses (`ConfluenceWire` mirroring `ScorecardSummary`; `watchlistInstrumentResolver`'s parsing duplicating `parseInstruments`, P5d§8.2). The Rust function anchors the semantics and its unit tests; the TS mirror is what runs in the live UI path. Both are trivially small and both are tested (P6§14).

```typescript
export const NEUTRAL_BAND = 0.001; // mirrors algo_core::benchmark_classify::DEFAULT_NEUTRAL_BAND

export function classifyDecision(direction: Direction, realizedReturn: number, neutralBand: number = NEUTRAL_BAND): Outcome {
  if (direction === "neutral") return "neutral";
  if (Math.abs(realizedReturn) <= neutralBand) return "neutral";
  const matches = direction === "bullish" ? realizedReturn > 0 : realizedReturn < 0;
  return matches ? "correct" : "incorrect";
}
```

### P6§9.5 Test additions (`electron-app/test/main/services/benchmark/benchmarkRunner.test.ts`, new)

Fake `sidecar` double (no real sidecar process), fabricated candle series with known future closes:

- `positional session_close cadence produces one decision point per eligible bar` — a series of length `N`, lookahead `L`; assert exactly `N - L` decision points (one per frontier that has a future bar), and that `benchmarkCompute` was called once per frontier.
- `intraday stateless_gate cadence is gate-driven` — a fake `evaluateScanGateStateless` returning `NoChange` for some frontiers and `WorthLook`/`WorthAiCall` for others; assert the `NoChange` frontiers produce **no** decision point and the non-`NoChange` ones do, and that `prev`/`curr` are threaded (the second gate call's `prev` equals the first call's `curr`).
- `manual everyN stride produces decision points only at every Nth index`.
- `a zero/negative frontier close is skipped without a marker but does not abort the walk`.
- `the walk stops at the lookahead boundary` — a series shorter than `lookaheadBars + 1` produces zero decision points, no out-of-range read.
- `classification wiring is exact` — a fabricated series with a known bullish confluence and a known positive future close asserts `outcome === "correct"`; a known negative future close asserts `"incorrect"`; a tiny future move asserts `"neutral"`.
- `a mid-run sidecar rejection surfaces and partial results are preserved` — a fake `benchmarkCompute` that rejects on the third frontier; assert the runner rejects (or returns partial per P6§13) with the first two decision points intact (the exact surface is settled in P6§13).

## P6§10 IPC contract and wiring

### P6§10.1 `benchmarkBridge.ts` (`electron-app/src/main/ipc/benchmarkBridge.ts`, new)

Mirrors `historyBridge.ts`/`settingsBridge.ts`'s exact DI/registration pattern:

```typescript
import type { IpcMain } from "electron";
import type { SidecarSupervisor } from "../services/sidecar/sidecarSupervisor";
import { runBenchmark, horizonForTimeframe } from "../services/benchmark/benchmarkRunner";
import type { BenchmarkRunParams, LakeSymbolEntry } from "./rendererApi";

export interface BenchmarkBridgeDeps {
  ipcMain: Pick<IpcMain, "handle">;
  sidecar: Pick<SidecarSupervisor, "listLakeSymbols" | "readLakeCandles" | "benchmarkCompute" | "evaluateScanGateStateless">;
}

export function registerBenchmarkBridge(deps: BenchmarkBridgeDeps): void {
  deps.ipcMain.handle("benchmark:listLakeSymbols", async (): Promise<LakeSymbolEntry[]> => {
    const { entries } = await deps.sidecar.listLakeSymbols();
    return entries.map((e) => ({
      symbol: e.symbol,
      timeframe: e.timeframe,
      source: e.source,
      fromTs: e.from_ts,
      toTs: e.to_ts,
      candleCount: e.candle_count,
      horizon: horizonForTimeframe(e.timeframe),
    }));
  });
  deps.ipcMain.handle("benchmark:runBenchmark", (_event, params: BenchmarkRunParams) =>
    runBenchmark({ sidecar: deps.sidecar }, params),
  );
}
```

The `listLakeSymbols` handler maps the snake_case wire (`from_ts`/`to_ts`/`candle_count`) to the camelCase app type and attaches the derived `horizon`. No Kite login is required for either channel — both operate purely against the local lake and the sidecar's pure compute.

### P6§10.2 `rendererApi.ts` additions

Extend the main-window `RendererApi`/`buildRendererApi` (the Benchmark screen lives in the main window, P6§11.1, so it uses the main API — not the separate `SettingsApi`). New exported types plus two methods:

```typescript
export type { BenchmarkCadence, Outcome, DecisionPoint, BenchmarkRunParams, BenchmarkResult } from "../services/benchmark/benchmarkRunner";

export interface LakeSymbolEntry {
  symbol: string;
  timeframe: string;
  source: string;
  fromTs: number;
  toTs: number;
  candleCount: number;
  horizon: Horizon; // derived from timeframe in the bridge
}

// RendererApi gains:
//   listLakeSymbols(): Promise<LakeSymbolEntry[]>;
//   runBenchmark(params: BenchmarkRunParams): Promise<BenchmarkResult>;

// buildRendererApi gains:
//   listLakeSymbols: () => invoke("benchmark:listLakeSymbols") as Promise<LakeSymbolEntry[]>,
//   runBenchmark: (params) => invoke("benchmark:runBenchmark", params) as Promise<BenchmarkResult>,
```

`testBridge.ts` (`electron-app/test/renderer/testBridge.ts`) gains `listLakeSymbols`/`runBenchmark` defaults (a `[]` and a stub `BenchmarkResult`), mirroring how every other `RendererApi` method already has a default there.

### P6§10.3 `bootstrap.ts` wiring

Add `registerBenchmarkBridge({ ipcMain, sidecar: supervisor })` alongside the other four bridge registrations at `createApp()`'s top level — registered exactly once, decoupled from window creation, per the invariant established by the P5d bootstrap fix (`ipcMain.handle` throws on a second registration for the same channel, and the main window can be recreated). No new `BrowserWindow`, no new preload, no new renderer HTML page — the Benchmark screen is a view inside the existing main window (P6§11.1), so none of P5d's second-window machinery is duplicated here.

### P6§10.4 Test additions (`electron-app/test/main/ipc/benchmarkBridge.test.ts`, new)

Mirrors `settingsBridge.test.ts`/`historyBridge.test.ts`'s `Map`-of-channel-to-handler style with fake `Pick<...>` doubles: `benchmark:listLakeSymbols` maps the wire's snake_case fields to camelCase and attaches the derived `horizon` (a `"day"` entry → `"positional"`, a `"minute"` entry → `"intraday"`); `benchmark:runBenchmark` forwards `params` to `runBenchmark` with the injected sidecar and returns its `BenchmarkResult`.

## P6§11 Renderer: `BenchmarkView.tsx`, chart wrapper, nav, and CSP

### P6§11.1 Nav entry point (`App.tsx`)

The Benchmark screen is a top-level view within the main window, reached from the app's main navigation — **not** nested inside a chat session and **not** a separate `BrowserWindow`. `App.tsx` gains a `showBenchmark` boolean state (mirroring the existing `showModePicker` pattern) and a top-level "Benchmark" button rendered alongside the existing home controls (next to where "New Chat"/"Home" live). Entering the Benchmark view clears `activeSession`/`showModePicker`; a "Home" action returns to `HomeScreen`. When `showBenchmark` is true (and no `activeSession`), `App` renders `<BenchmarkView api={bridge()} />` in place of `HomeScreen`. This keeps benchmarking a peer of the chat home, never a child of a session — matching §10.4's "reachable from the app's main navigation as its own mode."

### P6§11.2 `BenchmarkView.tsx` (`electron-app/src/renderer/BenchmarkView.tsx`, new)

Three phases in one screen:

**Setup.** On mount, `api.listLakeSymbols()` populates a picker. Each option shows the lake entry: `symbol`, `timeframe`, `source`, the derived `horizon`, and the covered date range (`fromTs`–`toTs` rendered as dates) and `candleCount`. Selecting an entry:
- Derives `horizon` (already on the entry) and shows it read-only (not a chosen field).
- Prefills `cadence = defaultCadenceForHorizon(horizon)` with a toggle to switch to the manual `every N` override (a numeric `everyN` field appears only when manual is chosen). **No response-mode picker exists** (Engine-Only only, locked decision 3).
- Prefills `lookaheadBars = defaultLookaheadForHorizon(horizon)` in an adjustable numeric field.
- Shows a date-range-within-covered-range picker bounded to `[fromTs, toTs]`, producing the run's `fromTs`/`toTs` sub-range.

A "Run benchmark" button calls `api.runBenchmark(params)` and transitions to results. If the lake is empty (`listLakeSymbols()` → `[]`), the setup screen shows a "No data ingested yet — run the `ingest` CLI (see P6§3)" message instead of a picker, and no crash (P6§13).

**Results.** Renders `benchmarkChart.ts` (P6§11.4) over `result.candles` with a marker per `result.decisionPoints` entry, a thin summary strip above the chart, a detail popover on marker click/hover, and a copy-raw-result button.

### P6§11.3 Summary strip and popover

The single thin summary strip (the only chrome above the chart) shows, computed client-side from `decisionPoints`:
- `correct` / `incorrect` / `neutral` counts.
- Hit-rate `= correct / (correct + incorrect)`, **neutral excluded from the ratio**, rendered as a percentage. When `correct + incorrect === 0` (all-neutral, or zero decision points), the strip shows `"0 decision points"` / `"—"` rather than dividing by zero (P6§13).

```typescript
export function summarize(points: DecisionPoint[]): { correct: number; incorrect: number; neutral: number; hitRate: number | null } {
  const correct = points.filter((p) => p.outcome === "correct").length;
  const incorrect = points.filter((p) => p.outcome === "incorrect").length;
  const neutral = points.filter((p) => p.outcome === "neutral").length;
  const denom = correct + incorrect;
  return { correct, incorrect, neutral, hitRate: denom === 0 ? null : correct / denom };
}
```

Clicking or hovering a marker opens a small popover/side panel revealing **that one** decision point's detail — `direction`/`conviction`/`responseText` (the reasoning), the driving algorithm ids (from `algoResults`), the realized price move (`closeAtFrontier` → `closeAtLookahead`, `realizedReturn`), and its `outcome`. Progressive disclosure: no per-marker fields shown until a marker is engaged; the chart plus its markers is the whole default view, deliberately uncluttered (locked decision 11, §10.4).

Any decision-point prose rendered as markdown goes through the existing DOMPurify sanitizer path already used for chat output (§8.2) — `responseText` originates from `generateDeterministicResponse`, but the same non-negotiable sanitize-on-render rule applies to Engine-Only template output (§8.2's explicit "applies equally to Engine-Only mode's templated output").

### P6§11.4 `benchmarkChart.ts` (`electron-app/src/renderer/benchmarkChart.ts`, new) and the `lightweight-charts` dependency

A thin wrapper over `lightweight-charts` (new npm dependency, `electron-app/package.json`): a candlestick series over `result.candles`, a volume histogram series underneath, and a markers overlay via the library's own `createSeriesMarkers` primitive (the v5 API the master design names by name in §10.4). Marker encoding per decision point:
- Color: green (`outcome === "correct"`), red (`"incorrect"`), gray (`"neutral"`).
- Shape/position: an up arrow below the bar for a bullish call, a down arrow above the bar for a bearish call, a neutral glyph for a neutral call — placed on the frontier candle (`time = decisionPoint.ts`).

The wrapper exposes a small handle: a `dispose()` for React unmount cleanup, and a click/hover callback carrying the engaged decision point (by matching the marker's `time` back to the `DecisionPoint`) so `BenchmarkView` can drive the popover. The file is a responsibility-named wrapper (chart construction over `lightweight-charts`), not a `utils`/`helpers` grab-bag.

`package.json` adds `"lightweight-charts": "^5.0.0"` under `dependencies`. It is Apache-2.0 (TradingView), bundles fully offline (no remote calls), and renders to a canvas.

### P6§11.5 CSP: satisfied unchanged, not weakened

The renderer's Content-Security-Policy (`index.html`) is `default-src 'none'; script-src 'self'; style-src 'self'; object-src 'none'`. `lightweight-charts` satisfies it **with no exception needed**, exactly as §10.4/§8.2 claim, and this phase does **not** weaken it:
- It is bundled into the renderer's own JS by `electron-vite`, served from the app origin — `script-src 'self'` covers it.
- It makes zero network requests (fully offline) — nothing tests `default-src 'none'`'s `connect-src`/`img-src`/`font-src` fallbacks.
- It renders to a `<canvas>` and sets element styles imperatively via JavaScript (`element.style.*`), which CSP `style-src` does not govern (`style-src` governs `<style>` blocks and HTML inline `style=""` attributes, not JS-assigned DOM style properties) — so no `'unsafe-inline'` style exception is needed or added.

The Benchmark screen lives in the existing main window under the existing CSP meta tag; no new HTML page, no new CSP surface. This claim is stated here explicitly so the plan-writer does not "helpfully" relax the CSP to accommodate the chart — it must not be relaxed.

### P6§11.6 Copy-raw-result

A "Copy raw result" button serializes the **entire** run to one JSON blob and writes it to the OS clipboard via the existing `contextBridge`/`ipcMain.handle` pattern — the renderer never gets raw Node/clipboard access (§8.2). The blob is `JSON.stringify(result)` where `result: BenchmarkResult` already carries, per decision point: `ts` (frontier timestamp), full `algoResults` and `confluence` scorecard, the deterministic Verdict-equivalent (`direction`/`conviction`/`responseText`), the realized subsequent price action (`closeAtFrontier`/`closeAtLookahead`/`realizedReturn`), the `outcome` classification — plus the run's own `params` (setup). Meant to be pasted to a coding agent to debug a specific wrong call.

Clipboard write channel: a new `ipcMain.handle("benchmark:copyToClipboard", (_event, text: string) => clipboard.writeText(text))` in `benchmarkBridge.ts` (Electron's `clipboard` module, main-process only), exposed on `RendererApi` as `copyBenchmarkResult(text: string): Promise<void>` → `invoke("benchmark:copyToClipboard", text)`. This is the only additional channel beyond the two in P6§10.1, and it follows the same never-expose-raw-Node discipline (P6§18 lists all three channels).

### P6§11.7 Renderer test additions

- `electron-app/test/renderer/BenchmarkView.test.tsx` (new): with a fake `RendererApi` (via `testBridge.ts`), the setup picker renders lake entries with their derived horizon and covered range; an empty `listLakeSymbols()` renders the "no data ingested yet" message; selecting an entry prefills the horizon-appropriate cadence and lookahead default; "Run benchmark" calls `runBenchmark` with the assembled `params`; the summary strip renders `summarize`'s counts and hit-rate (and `"0 decision points"` when empty).
- A `benchmarkChart` marker-count test: using a `lightweight-charts` mock (the library renders to a real canvas, absent in the jsdom/plain-Node vitest environment — mock it at the module boundary, the same way main-process tests mock Electron surfaces), assert the number of markers passed to the mocked `createSeriesMarkers` equals the number of `decisionPoints`, and that each marker's color matches its `outcome`. (No repo code touches a real canvas today, so a module-level `vi.mock("lightweight-charts", ...)` boundary is the sensible stub.)
- `summarize` unit tests: hit-rate excludes neutral; `null` hit-rate on zero directional outcomes.

## P6§12 Data flow (end to end)

1. **Ingest (prerequisite, one-time-ish):** `ingest --mode bhavcopy ...` / `ingest --mode intraday ...` populates the Parquet lake and appends identities to `lake_manifest.jsonl` (P6§3, P6§4.3).
2. **Setup:** `BenchmarkView` mounts → `api.listLakeSymbols()` → `benchmark:listLakeSymbols` → `sidecar.listLakeSymbols()` → `handle_list_lake_symbols` → `CandleStore::list_symbols()` (manifest + per-partition bounds) → entries with derived `horizon` back to the renderer. User picks an entry + date sub-range + cadence + lookahead (Engine-Only implied, no mode picker).
3. **Run:** `api.runBenchmark(params)` → `benchmark:runBenchmark` → `runBenchmark(deps, params)` in the main process:
   - `sidecar.readLakeCandles(symbol, timeframe, source)` once → full sourced series; slice to `[fromTs, toTs]`.
   - Walk frontiers per cadence (session-close / stateless-gated / manual-N), breaking at the lookahead boundary. Per decision point: `sidecar.benchmarkCompute(symbol, timeframe, horizon, series[0..=i])` (full OHLCV via `context_at`) → build minimal envelope → `generateDeterministicResponse` → `classifyDecision` against `series[i+lookahead].close` → collect a `DecisionPoint`.
   - Return `{ params, candles: series, decisionPoints }`.
4. **Render:** the renderer draws the candlestick+volume chart, one marker per decision point (green/red/gray), and the client-side summary strip. Click/hover a marker → popover detail. "Copy raw result" → `benchmark:copyToClipboard` → OS clipboard.
5. **No history writes anywhere in this flow** — `HistoryStore` is never touched (locked decision 10).

## P6§13 Error handling

These are the exact cases validated in brainstorming — no new ones invented, none dropped:

- **Empty lake:** `listLakeSymbols` returns `[]` → setup screen shows a "no data ingested yet, run the `ingest` CLI" message pointing at P6§3; no crash.
- **Range too short for lookahead:** the walk stops at `series.length - lookaheadBars - 1` (breaks when `i + lookaheadBars >= series.length`), mirroring `run_replay`'s boundary. A working range shorter than `lookaheadBars + 1` produces zero decision points, no out-of-range read.
- **Zero/negative close at a frontier (data glitch):** skip that frontier's decision point/classification (mirrors `run_replay`'s `current <= 0.0 → continue`). The candle still renders on the chart; there is simply no marker there.
- **Insufficient history for an individual algorithm at early frontiers:** already handled by `run_applicable`'s per-algorithm `required_lookback` gate — that algorithm just does not contribute to that frontier's confluence, identical to live behavior. No special handling in this phase.
- **Zero decision points produced** (range too short, or an all-`NoChange` intraday run): the summary strip shows `"0 decision points"` (no divide-by-zero on hit-rate — `summarize` returns `hitRate: null`), and the chart still renders the price series alone with no markers.
- **Sidecar crash/error mid-run:** surfaced through the existing `SidecarSupervisor` per-request-timeout/rejection path — nothing new is built. The runner collects decision points into an array as it walks; on a mid-run rejection it stops and the already-collected partial results are returned/shown with a "run stopped early" indication in `BenchmarkView`, not silently discarded. (The runner catches a rejection from `benchmarkCompute`/`evaluateScanGateStateless`/`readLakeCandles`, returns the partial `BenchmarkResult` collected so far, and sets a flag the view renders as the "stopped early" banner.)
- **`ingest` CLI network failure** (a bhavcopy fetch for one date fails): the CLI exits non-zero reporting the failing date and does not partially corrupt the lake — each day's import is a self-contained batch via `import_bhavcopy_files` (`write_sourced_candles`'s temp-file+atomic-rename keeps a partition intact on a mid-write crash, `candle_store.rs`), so committed days survive and the run is rerunnable later for just the missing date(s).

## P6§14 Testing strategy

Follows §13's conventions and the exact cases validated in brainstorming.

**Rust:**
- `benchmark_classify_test.rs` (new) — pure classification unit tests, per P6§5.1 (bullish+positive→Correct, bullish+negative→Incorrect, neutral-direction→Neutral regardless of magnitude, within-band directional→Neutral, band-edge inclusive).
- `candle_store` tests — `list_symbols` on an empty lake, multi-source/multi-symbol grouping with correct original identity (colon survives), correct ts bounds/count, no duplicate manifest entry on re-ingest (P6§4.5).
- `handlers.rs` inline tests — `handle_benchmark_compute` proves full-OHLCV context reaches `run_applicable` (contrast with the closes-only live `Compute`); empty-candles zeroed response; `read_lake_candles`/`list_lake_symbols` round trips; `handle_evaluate_scan_gate_stateless` matches the persistent gate for identical inputs **and** performs zero `StateStore`/`scan_snapshots` writes (P6§6.2).
- `protocol_test.rs` / `end_to_end_test.rs` — new request/response wire round trips; a spawned-binary chain (`persist_candles` → `list_lake_symbols` → `read_lake_candles` → `benchmark_compute` → `evaluate_scan_gate_stateless`); a panic-isolation regression for `benchmark_compute`; `benchmark_compute` answering with no `--lake-root` (P6§6.4).
- `ingest` bin — an integration test against a small fixture bhavcopy CSV file (the intraday-dir/local path), asserting candles read back; **no real network call in any automated test** (the network `fetch_udiff_bhavcopy` path is exercised only manually, per `io.rs`'s existing `#[ignore]`d-smoke-test convention).

**TypeScript:**
- `benchmarkRunner.test.ts` (new) — positional cadence produces one decision point per eligible bar; intraday cadence is gate-driven (`NoChange` frontiers produce no decision point; `prev`/`curr` threaded); manual-N stride; zero/negative-close skip; lookahead-boundary stop; exact classification wiring; mid-run rejection preserves partials (P6§9.5).
- `sidecarProtocol.test.ts` / `sidecarSupervisor.test.ts` — wire encode/decode and the four new supervisor methods' resolve/timeout behavior (P6§7.3).
- `benchmarkBridge.test.ts` (new) — IPC wiring mirroring `historyBridge.test.ts`/`settingsBridge.test.ts` (snake→camel mapping + derived horizon; `runBenchmark` forwarding) (P6§10.4).
- `BenchmarkView.test.tsx` (new) — setup/picker rendering, empty-lake message, cadence/lookahead prefill, run invocation, summary strip; a `benchmarkChart` marker-count/color test using a `lightweight-charts` module mock; `summarize` unit tests (P6§11.7).

**Manual (per the `verify` skill, end of phase, not automated):** run `ingest` for real NSE bhavcopy over a small date range; open the Benchmark screen; run a real positional benchmark on a real symbol; confirm the candlestick chart, volume, and correct/incorrect/neutral markers plus the summary strip render sensibly; click a marker and confirm the popover detail; confirm "Copy raw result" produces valid, complete JSON.

## P6§15 Manual verification checklist

Mirrors P5a§11/P5b§11/P5c§10/P5d§14: an automatable golden path plus a live follow-up, never a blocker for calling Phase 6 done.

**Automatable (mocked bridge + `npm start`):** the Benchmark nav button opens `BenchmarkView`; an empty lake shows the "no data ingested yet" message; with a stub `listLakeSymbols` the picker renders entries with derived horizon/covered range; selecting one prefills the horizon-appropriate cadence and lookahead; "Run benchmark" against a stub `runBenchmark` renders the chart, markers, and summary strip; clicking a marker opens the popover; "Copy raw result" resolves.

**Live follow-ups (real ingested data):** run `ingest --mode bhavcopy --exchange NSE --from <d1> --to <d2>` for real; confirm `list_symbols` surfaces the ingested symbols with correct covered ranges; run a real positional benchmark and eyeball that markers land on the right candles and the hit-rate strip is sane; run an intraday benchmark against community-archive (`--mode intraday`) data to confirm the stateless-gate cadence produces a plausible, sparse marker set (not one-per-bar); confirm the copy-raw JSON round-trips through `JSON.parse` with every decision point's full structured payload present.

## P6§16 Relationship to existing design (flagged tensions & resolutions)

1. **The on-disk lake layout is lossy; `list_symbols` needs a manifest.** The sanitized partition filenames cannot be reversed to `(symbol, timeframe, source)` (P6§4.1). This phase adds a small append-only `lake_manifest.jsonl` and one guarded line in `write_sourced_candles` — a real, if minimal, change to an existing write method, called out explicitly rather than left implicit. Because the lake is currently empty, no migration is needed. This is the single most consequential mechanical detail the brainstorm left unpinned ("check what's derivable from the on-disk layout").
2. **`ReadLakeCandles`/`LakeSymbolWire` carry `source`; reads wrap `read_sourced_candles`, not `read_candles`.** The brainstorm's shorthand said "wraps existing `read_candles`," but all real lake data lives in sourced partitions (`{s}_{t}_{src}.parquet`), so a source-less `read_candles` would read an empty non-sourced partition. The entry already carries `source`, so the renderer round-trips the exact partition `list_symbols` reported. This is a deliberate correction of the shorthand to make the phase work against actually-ingested data, consistent with `list_symbols` returning `source`.
3. **Classification is canonical in Rust but mirrored in TS for the runner.** The locked scope lists a Rust `classify_decision` *and* exactly four sidecar requests (none a classify request); classification sits between two TS-side runner operations. The runner therefore calls a small pure TS mirror (`classifyDecision`), following the same deliberate cross-boundary mirror precedent the codebase already uses (`ConfluenceWire`↔`ScorecardSummary`; `watchlistInstrumentResolver`↔`parseInstruments`). Both sides are tested (P6§14). The aggregate `run_replay` engine's inline sign check is intentionally **not** refactored to call `classify_decision` — that engine stays untouched (locked decision 2).
4. **The sidecar crate gains a `backtest` dependency (and transitively `ingestion`).** `context_at` lives in `backtest::frontier`; per locked decision 6 the sidecar depends on `backtest` to reuse it. This transitively pulls `ingestion` (and its `reqwest`/`zip`) into the sidecar binary — heavier than strictly necessary for one function, but it is the locked decision and the dependency graph stays acyclic. Noted for the plan-writer as a minor observation, not a blocker (a future refactor could relocate `context_at` to a leaner shared crate if binary size ever matters).
5. **`benchmarkRunner` is a DI'd async function, not a class.** `scanScheduler.ts` is a class because it holds a timer/lifecycle; a benchmark run is a single invocation with no resident state, so a one-shot `runBenchmark(deps, params)` function is the right shape while still mirroring scanScheduler's dependency-injection discipline (explicit `deps`, injectable sidecar, no singletons).
6. **The Benchmark screen is a view in the main window, not a second `BrowserWindow`.** Unlike P5d's Settings window, benchmarking reuses the main window, the main preload, the main `RendererApi`, and the existing CSP — none of P5d's second-preload/second-renderer/second-CSP machinery is duplicated. It reaches the screen via a top-level nav peer of the chat home (§10.4's "its own mode" in the main nav).
7. **`AnalysisEnvelope.trigger` is set to `"reactive"` for the synthetic benchmark envelope**, since only `confluence`/`algo_results` are load-bearing for `generateDeterministicResponse` and no live trigger applies. The benchmark path never assembles a real envelope via `assembleEnvelope` (which needs Kite), consistent with decoupling benchmarking from Kite session state (locked decision 4).

## P6§17 The permanent no-order-placement safety invariant is unaffected

This phase adds no Kite write-tool method, no new Claude tool grant, and no code path that could reach `place_order`/`modify_order`/`cancel_order`/`place_gtt_order`/`modify_gtt_order`/`delete_gtt_order` — indeed it adds no order-related surface of any kind, and does not even contact live Kite: the Benchmark UI reads historical candles from the local Parquet lake and runs deterministic compute over them, presenting analysis with proofs for the human to read. The permanent §2/§4 constraint — the app never places, modifies, cancels, or automates any order, ever — is restated here for completeness, as in every phase, precisely because nothing in this phase touches it.

## P6§18 Global Constraints (binding, verbatim for the plan-writer and task-implementers)

**Exact new file paths:**
- `rust-core/crates/ingestion/src/bin/ingest.rs`
- `rust-core/crates/storage/src/lake_manifest.rs`
- `rust-core/crates/algo-core/src/benchmark_classify.rs`
- `rust-core/crates/algo-core/tests/benchmark_classify_test.rs`
- `electron-app/src/main/services/benchmark/benchmarkRunner.ts`
- `electron-app/src/main/ipc/benchmarkBridge.ts`
- `electron-app/src/renderer/BenchmarkView.tsx`
- `electron-app/src/renderer/benchmarkChart.ts`
- `electron-app/test/main/services/benchmark/benchmarkRunner.test.ts`
- `electron-app/test/main/ipc/benchmarkBridge.test.ts`
- `electron-app/test/renderer/BenchmarkView.test.tsx`

**Exact Rust struct field names:**
- `LakePartitionKey { symbol: String, timeframe: String, source: String }`
- `LakeSymbolEntry { symbol: String, timeframe: String, source: String, from_ts: i64, to_ts: i64, candle_count: usize }`
- `LakeSymbolWire { symbol, timeframe, source, from_ts, to_ts, candle_count }` (same field names, wire)
- `ReadLakeCandlesRequest { id: u64, symbol: String, timeframe: String, source: String }`
- `BenchmarkComputeRequest { id: u64, symbol: String, timeframe: String, horizon: String, candles: Vec<CandleWire> }`
- `EvaluateScanGateStatelessRequest { id: u64, prev: Option<ConfluenceWire>, curr: ConfluenceWire }`
- `BenchmarkComputeResponse { id: u64, algo_results: Vec<AlgoResultWire>, confluence: ConfluenceWire }`
- `Outcome::{Correct, Incorrect, Neutral}`

**Exact request/response wire tags (snake_case):** requests `list_lake_symbols`, `read_lake_candles`, `benchmark_compute`, `evaluate_scan_gate_stateless`; responses `lake_symbols`, `lake_candles`, `benchmark_compute`; `evaluate_scan_gate_stateless` reuses the existing `scan_gate` response.

**Exact TS type/field names:**
- `LakeSymbolEntry { symbol, timeframe, source, fromTs, toTs, candleCount, horizon }` (camelCase app type)
- `BenchmarkCadence = { mode: "session_close" } | { mode: "stateless_gate" } | { mode: "manual"; everyN: number }`
- `Outcome = "correct" | "incorrect" | "neutral"`
- `DecisionPoint { frontierIndex, ts, closeAtFrontier, closeAtLookahead, realizedReturn, direction, conviction, responseText, algoResults, confluence, outcome }`
- `BenchmarkRunParams { symbol, timeframe, source, horizon, cadence, lookaheadBars, fromTs, toTs }`
- `BenchmarkResult { params, candles, decisionPoints }`

**Exact default constant values:**
- Rust `algo_core::benchmark_classify::DEFAULT_NEUTRAL_BAND: f64 = 0.001`
- TS `NEUTRAL_BAND = 0.001` (mirror)
- TS `DEFAULT_POSITIONAL_LOOKAHEAD_BARS = 5`, `DEFAULT_INTRADAY_LOOKAHEAD_BARS = 30`
- Horizon derivation: `timeframe === "day" ? "positional" : "intraday"`
- Cadence default: positional → `{ mode: "session_close" }`, intraday → `{ mode: "stateless_gate" }`
- Hit-rate: `correct / (correct + incorrect)`, neutral excluded; `null` (shown as `"—"` / `"0 decision points"`) when the denominator is 0.

**Exact IPC channel names:** `benchmark:listLakeSymbols`, `benchmark:runBenchmark`, `benchmark:copyToClipboard`.

**New dependencies:** Rust `sidecar/Cargo.toml` gains `backtest = { path = "../backtest" }`. TS `electron-app/package.json` gains `"lightweight-charts": "^5.0.0"` (Apache-2.0, offline, no CSP exception).

**Binding invariants:** (a) the live `Compute` handler and `MarketContext::from_closes` are NOT modified; (b) `run_replay`/`ReplayReport` are NOT extended; (c) `generateDeterministicResponse` and `deterministicResponseGenerator.ts` are NOT modified; (d) `EvaluateScanGateStateless` performs ZERO `StateStore`/`scan_snapshots` I/O; (e) `HistoryStore` is NOT touched; (f) the renderer CSP is NOT weakened; (g) IPC handlers are registered exactly once at `createApp()`'s top level (P5d bootstrap invariant); (h) no order-related surface is added (P6§17).

## P6§19 File layout summary

**New — Rust:**
- `rust-core/crates/ingestion/src/bin/ingest.rs` — the `ingest` CLI (P6§3).
- `rust-core/crates/storage/src/lake_manifest.rs` — `LakePartitionKey`, `append_partition_key`, `read_partition_keys` (P6§4.2).
- `rust-core/crates/algo-core/src/benchmark_classify.rs` — `Outcome`, `DEFAULT_NEUTRAL_BAND`, `classify_decision` (P6§5).
- `rust-core/crates/algo-core/tests/benchmark_classify_test.rs` (P6§5.1).

**Modified — Rust:**
- `rust-core/crates/storage/src/candle_store.rs` — `list_symbols`, `partition_bounds`, the guarded manifest append in `write_sourced_candles`, `LakeSymbolEntry` (P6§4.3–4.4).
- `rust-core/crates/storage/src/lib.rs` — re-export `LakeSymbolEntry`, `LakePartitionKey`.
- `rust-core/crates/storage/tests/candle_store_test.rs` (or inline) — `list_symbols` tests (P6§4.5).
- `rust-core/crates/algo-core/src/lib.rs` — `pub mod benchmark_classify;`.
- `rust-core/crates/sidecar/Cargo.toml` — add `backtest` dependency (P6§6.2).
- `rust-core/crates/sidecar/src/protocol.rs` — four new request variants, three new response variants, `CandleWire` gains `Serialize`, `LakeSymbolWire` (P6§6.1).
- `rust-core/crates/sidecar/src/handlers.rs` — `handle_list_lake_symbols`, `handle_read_lake_candles`, `handle_benchmark_compute`, `handle_evaluate_scan_gate_stateless`, extracted mapping helpers (P6§6.2).
- `rust-core/crates/sidecar/src/main.rs` — route the four new variants with `catch_unwind` (P6§6.3).
- `rust-core/crates/sidecar/tests/protocol_test.rs`, `rust-core/crates/sidecar/tests/end_to_end_test.rs` (P6§6.4).

**New — TypeScript:**
- `electron-app/src/main/services/benchmark/benchmarkRunner.ts` (P6§9), plus `horizonForTimeframe`/`defaultCadenceForHorizon`/`defaultLookaheadForHorizon`/`classifyDecision`/`summarize` helpers and the benchmark types (P6§8, P6§9, P6§11.3).
- `electron-app/src/main/ipc/benchmarkBridge.ts` (P6§10.1, P6§11.6).
- `electron-app/src/renderer/BenchmarkView.tsx` (P6§11.2).
- `electron-app/src/renderer/benchmarkChart.ts` (P6§11.4).
- `electron-app/test/main/services/benchmark/benchmarkRunner.test.ts`, `electron-app/test/main/ipc/benchmarkBridge.test.ts`, `electron-app/test/renderer/BenchmarkView.test.tsx` (P6§14).

**Modified — TypeScript:**
- `electron-app/src/main/services/sidecar/sidecarProtocol.ts` — three new response wires, `LakeSymbolWire`, four new request variants (P6§7.1).
- `electron-app/src/main/services/sidecar/sidecarSupervisor.ts` — `listLakeSymbols`/`readLakeCandles`/`benchmarkCompute`/`evaluateScanGateStateless` (P6§7.2).
- `electron-app/src/main/ipc/rendererApi.ts` — `listLakeSymbols`/`runBenchmark`/`copyBenchmarkResult` methods, `LakeSymbolEntry`, benchmark type re-exports (P6§10.2, P6§11.6).
- `electron-app/src/main/bootstrap.ts` — `registerBenchmarkBridge` at the top level (P6§10.3).
- `electron-app/src/renderer/App.tsx` — the top-level Benchmark nav entry (P6§11.1).
- `electron-app/package.json` — `lightweight-charts` dependency (P6§11.4).
- `electron-app/test/renderer/testBridge.ts`, `electron-app/test/main/services/sidecar/sidecarProtocol.test.ts`, `electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts` — extended per P6§14.

**Explicitly considered, not changed:**
- `rust-core/crates/backtest/src/engine.rs` (`run_replay`/`ReplayReport`) — untouched (locked decision 2).
- `rust-core/crates/sidecar/src/handlers.rs`'s `handle_request` / `MarketContext::from_closes` — the live closes-only path is untouched (locked decision 6); only pure mapping helpers are extracted from it without behavior change.
- `rust-core/crates/ingestion/src/{importer,bhavcopy,intraday,io}.rs` — no parse/import redesign; `ingest.rs` only wires them up.
- `electron-app/src/main/services/analysis/deterministicResponseGenerator.ts` — reused unchanged, once per decision point.
- `electron-app/src/main/services/history/historyStore.ts` and every chat/session surface — untouched (locked decision 10).
- The renderer CSP (`index.html`) — unchanged; `lightweight-charts` needs no exception (P6§11.5).

## P6§20 Out of scope for this phase

- **Any change to the hard no-order-placement safety invariant (§2, §4).** Unaffected — this phase adds no order-related surface at all (P6§17).
- **AI-Assisted benchmark mode.** Engine-Only only; no response-mode picker appears in the Benchmark UI. Exercising the Claude synthesis layer against historical replay (§10.4's optional AI-Assisted benchmarking) is a clean future extension, not built here.
- **Extending `run_replay`/`ReplayReport`** or building any bespoke Rust benchmark-report engine. Benchmark execution is the TS-orchestrated frontier walk (locked decision 2).
- **A config UI for `neutral_band` or lookahead defaults.** `DEFAULT_NEUTRAL_BAND`/`NEUTRAL_BAND = 0.001` and the two lookahead defaults are code constants; lookahead is per-run adjustable in the setup field, but `neutral_band` has no UI control in this phase.
- **Corporate-action adjustment, survivorship, or data-quality repair** of ingested candles — §10.2's honest caveats stand; the benchmark scores whatever candles the lake holds.
- **Per-entry cadence/lookahead persistence.** Setup choices are per-run, not saved; nothing persists benchmark configuration.
- **Deep-linking a marker to anything outside the popover**, exporting a run to disk, or re-running a saved benchmark — the copy-raw-result JSON blob is the complete v1 export mechanism.
- **A `benchmark_classify` sidecar request.** Classification is canonical in Rust and mirrored in TS for the runner (P6§9.4, P6§16 item 3); no sidecar round trip is added for it.
- **`ingest` scheduling/automation** (cron/launchd) or an in-app ingest trigger — `ingest` is a manually-run CLI, matching §2's no-automation posture and §10.1's once-daily-pull framing.
