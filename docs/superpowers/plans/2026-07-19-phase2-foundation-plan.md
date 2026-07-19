# Phase 2 Foundation — Public-Data Ingestion + Backtest/Replay Engine — Implementation Plan (Phase 2 of 7, Foundation)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Scope note — the TA-indicator catalog is deliberately NOT in this plan.** The full §6.2 indicator/quant/options catalog buildout (MACD, ADX, Supertrend, Bollinger, cointegration, Greeks, …) is a **separate subsequent plan**, because it depends on this backtest engine existing (each new indicator is only "trusted" once the replay engine gives it a real hit-rate), and because it is the parallel-heavy workstream (dozens of independent, same-shaped indicator tasks) better dispatched on its own once the foundation below is merged. This plan builds the **foundation** those indicators will plug into: storage carry-forward fixes, public-data ingestion, and the frontier-gated replay engine — plus the Kronos ONNX go/no-go spike that must resolve before the catalog assumes an `ort`-hosted Kronos.

**Goal:** Extend the Phase 1 Rust workspace with (a) three storage carry-forward robustness fixes, (b) public no-auth historical data ingestion (NSE/BSE bhavcopy + community intraday archives) into the existing Parquet/DuckDB candle lake, and (c) a frontier-gated walk-forward backtest/replay engine that reuses Phase 1's `registry::all()` and `compute_confluence()` unchanged and produces per-algorithm hit-rate/expectancy — all provable end-to-end with zero Electron/Kite/Claude/network dependency.

**Architecture:** Two new crates are added to the existing `rust-core/` workspace: `ingestion` (pure CSV parsers separated from a thin network/file I/O layer) and `backtest` (the frontier-gated replay engine plus a CLI binary). The pure ingestion parsers turn committed fixture CSVs into `storage::Candle` values and are unit-tested with no network; the I/O layer that actually fetches from NSE/BSE is thin and manually/integration-tested. The backtest engine walks a candle series forward one bar at a time, reveals only candles at or before a frontier `T` to `compute()`, runs the existing algorithm pipeline "as of" `T`, and compares each algorithm's directional verdict against realized subsequent price action. Anti-lookahead is a single shared windowing function with its own tests. The `compute()` insufficient-history contract — already gated inline in Phase 1's sidecar handler — is lifted into one shared `registry::run_applicable()` gate that both the sidecar handler and the backtest engine call, so no caller can forget it.

**Tech Stack:** Rust (stable, 2021 edition), `serde`/`serde_json`, `chrono` (offset-aware timestamps, IST session anchoring), `csv` (deterministic CSV parsing), `duckdb`/`rusqlite` (Phase 1 storage, extended), `reqwest` with **`rustls-tls`** + `zip` (bhavcopy fetch/unzip — I/O layer only), `inventory` (Phase 1 compile-time registry, reused unchanged). Kronos spike uses Python (reference inference) + the Rust `ort` crate (ONNX Runtime), evaluated but **not** committed as product code by this plan.

## Real Phase 1 interfaces this plan builds on (confirmed against source, do not assume)

- `algo_core::registry::all() -> Vec<Box<dyn Algorithm>>` (`crates/algo-core/src/registry.rs`) — reused unchanged; `AlgorithmFactory(pub fn() -> Box<dyn Algorithm>)` + `inventory::collect!`/`submit!`.
- `algo_core::Algorithm` trait: `id(&self) -> &'static str`, `required_lookback(&self) -> usize`, `applicable_horizons(&self) -> &'static [Horizon]`, `compute(&self, ctx: &MarketContext) -> AlgoOutput`.
- `algo_core::MarketContext { symbol: String, timeframe: Timeframe, horizon: Horizon, closes: Vec<f64>, as_of: DateTime<Utc> }` — note: **only `closes`**, no OHLCV per-bar (Phase 1 indicators read closes only).
- `algo_core::AlgoOutput { algo_id: &'static str, symbol: String, timeframe: Timeframe, horizon: Horizon, direction: Direction, magnitude: f64, confidence: f64, evidence: Vec<String>, computed_at: DateTime<Utc> }`.
- `algo_core::Direction { Bullish, Bearish, Neutral }`, `Horizon { Intraday, Positional }`, `Timeframe { Minute, FiveMinute, FifteenMinute, Day }`.
- `algo_core::confluence::compute_confluence(outputs: &[AlgoOutput], weights: &HashMap<&str, f64>) -> ScorecardSummary` (`crates/algo-core/src/confluence.rs`) — reused unchanged; `ScorecardSummary { bullish_count, bearish_count, neutral_count, weighted_vote }`; missing `algo_id` in `weights` defaults to weight `1.0`.
- `storage::Candle { ts: i64, open: f64, high: f64, low: f64, close: f64, volume: i64 }` (`crates/storage/src/candle_store.rs`) — kept **pure OHLCV**, no provenance field.
- `storage::CandleStore::open(root: &Path) -> duckdb::Result<Self>` (currently `.expect()`s on `create_dir_all` — Task 3 fixes this), `write_candles(&self, symbol, timeframe, &[Candle]) -> duckdb::Result<()>` (single-file overwrite per `{symbol}_{timeframe}`), `read_candles(&self, symbol, timeframe) -> duckdb::Result<Vec<Candle>>` (currently errors on a never-written partition — Task 3 fixes this), private `sanitize_component()` already neutralizes quotes/traversal.
- Phase 1's sidecar handler (`crates/sidecar/src/handlers.rs`) already filters `required_lookback() <= ctx.closes.len()` inline; Task 2 extracts that gate into `algo-core` so the backtest shares it.

## Global Constraints

- **The app never implements, wires up, or calls any Kite order-placement/modification/cancellation/GTT-write tool** (`place_order`, `modify_order`, `cancel_order`, `place_gtt_order`, `modify_gtt_order`, `delete_gtt_order`) — permanent, every phase (design §2, §4). This phase adds ingestion/replay only; it touches no order path and no Kite endpoint at all.
- **`compute()` purity:** every `Algorithm::compute()` is pure and deterministic — no wall-clock reads, no randomness, no I/O inside `compute()`. The evaluation instant is `MarketContext::as_of`, supplied by the caller: the live wall-clock at the sidecar I/O boundary in production, or **the replay frontier's simulated time during backtest** (design §6.1). The backtest MUST set `as_of` from the frontier candle's timestamp, never from `Utc::now()`.
- **Compile-time registration only** — algorithms register via `inventory::submit!`; no dynamic loading (design §6.1). The backtest reuses `registry::all()`; it never forks or re-declares the registry.
- **Anti-lookahead (design §6.4):** no candle whose EndTime is after the frontier `T` is ever visible to `compute()`. Windows are anchored to **exchange-local session time** (candle timestamps encode the IST session-close instant as an absolute Unix epoch), never to UTC-midnight strides or the OS locale. This is one shared windowing implementation, tested once.
- **Networking uses `rustls`, never `native-tls`/`openssl`** (design §11) — `reqwest` is added with `default-features = false, features = ["blocking", "rustls-tls"]`.
- **Pure logic separate from I/O:** new ingestion parsers (pure, network-free, unit-tested against tiny committed fixtures) live apart from the fetch layer (network, manually/integration-tested). New ingestion code lives in `rust-core/crates/ingestion/`; the backtest engine in `rust-core/crates/backtest/` (per roadmap).
- **Tests never hit the network.** Every automated test runs against committed fixtures or synthetic in-memory data. The one network-touching test (real bhavcopy fetch) is `#[ignore]`d and run manually.
- **Comment/naming conventions follow `CLAUDE.md`** — no restating-the-obvious comments, no numbered comment blocks, `snake_case` Rust identifiers, one responsibility per file, files named for responsibility.
- **Ingestion ToS caveat (design §10.1):** NSE/BSE Terms prohibit systematic/automated collection; this app's use is personal, low-frequency (≤ once-daily) bootstrapping only, documented not litigated — the fetch layer defaults to a single-shot manual invocation, not a scheduler.

## File Structure

```
rust-core/
  Cargo.toml                               # add ingestion + backtest to workspace members (Task 1)
  crates/
    algo-core/
      src/
        algorithm.rs                       # Task 2: document compute() precondition on the trait
        registry.rs                        # Task 2: add run_applicable() shared lookback gate
    sidecar/
      src/handlers.rs                      # Task 2: refactor to call registry::run_applicable (behavior-preserving)
    storage/
      src/
        error.rs                           # Task 3: StorageError enum + Result alias
        candle_store.rs                    # Task 3: empty-not-error read + open error propagation + private partition helpers
                                           # Task 4: source-tagged append-merge partitions
        lib.rs                             # Tasks 3-4: exports
      tests/
        candle_store_test.rs               # Tasks 3-4: new tests (additive)
    ingestion/                             # NEW crate
      Cargo.toml
      src/
        lib.rs
        error.rs                           # IngestionError
        model.rs                           # ParsedCandle
        time.rs                            # ist_session_close_epoch()
        bhavcopy.rs                        # pure UDiFF equity parser (NSE + BSE)
        indices.rs                         # pure NSE all-indices parser (volume=0 quirk)
        intraday.rs                        # pure community-archive minute parser (+0530 offset-aware)
        io.rs                              # thin fetch layer (reqwest rustls + unzip) — manual/integration test only
        importer.rs                        # parse -> store wiring
      tests/
        fixtures/
          nse_bhavcopy_udiff_sample.csv    # tiny committed fixture (Task 5)
          nse_indices_close_sample.csv     # tiny committed fixture (Task 6)
          kaggle_banknifty_minute_sample.csv # tiny committed fixture (Task 7)
        bhavcopy_parse_test.rs
        indices_parse_test.rs
        intraday_parse_test.rs
        importer_test.rs
        fetch_smoke_test.rs                # #[ignore] network test
    backtest/                              # NEW crate
      Cargo.toml
      src/
        lib.rs
        frontier.rs                        # anti-lookahead windowing
        engine.rs                          # run_replay(), ReplayReport, AlgoStats, hit_rate_weights()
        bin/
          replay.rs                        # CLI: ingest? -> read lake -> replay -> print report
      tests/
        anti_lookahead_test.rs
        replay_math_test.rs
        confluence_bridge_test.rs
        cli_e2e_test.rs
docs/superpowers/spikes/
  2026-07-19-kronos-onnx-feasibility.md    # Task 13 output (findings doc, NOT product code)
```

---

### Task 1: Scaffold `ingestion` and `backtest` crates

**Depends on:** none. **Parallel-safe: yes** (only this task edits `rust-core/Cargo.toml` and the two new empty crate dirs; run it in Wave A alongside Tasks 2, 3, 13).

**Files:**
- Modify: `rust-core/Cargo.toml`
- Create: `rust-core/crates/ingestion/Cargo.toml`
- Create: `rust-core/crates/ingestion/src/lib.rs`
- Create: `rust-core/crates/backtest/Cargo.toml`
- Create: `rust-core/crates/backtest/src/lib.rs`

**Interfaces:**
- Produces: two empty-but-compiling crates every later ingestion/backtest task adds real code to.

- [ ] **Step 1: Add both crates to the workspace**

Edit `rust-core/Cargo.toml` `members` to:
```toml
[workspace]
resolver = "2"
members = [
    "crates/algo-core",
    "crates/storage",
    "crates/sidecar",
    "crates/ingestion",
    "crates/backtest",
]

[workspace.package]
edition = "2021"
```

- [ ] **Step 2: Create the `ingestion` crate**

`rust-core/crates/ingestion/Cargo.toml`:
```toml
[package]
name = "ingestion"
version = "0.1.0"
edition.workspace = true

[dependencies]
storage = { path = "../storage" }
chrono = "0.4"
csv = "1"

[dev-dependencies]
tempfile = "3"
```

`rust-core/crates/ingestion/src/lib.rs` (empty — filled by Tasks 5-8):
```rust
```

- [ ] **Step 3: Create the `backtest` crate**

`rust-core/crates/backtest/Cargo.toml`:
```toml
[package]
name = "backtest"
version = "0.1.0"
edition.workspace = true

[lib]
name = "backtest"
path = "src/lib.rs"

[[bin]]
name = "replay"
path = "src/bin/replay.rs"

[dependencies]
algo-core = { path = "../algo-core" }
storage = { path = "../storage" }
chrono = "0.4"

[dev-dependencies]
tempfile = "3"
```

`rust-core/crates/backtest/src/lib.rs` (empty — filled by Tasks 9-11):
```rust
```

`rust-core/crates/backtest/src/bin/replay.rs` (placeholder so the bin target compiles; Task 12 replaces it):
```rust
fn main() {
    println!("replay placeholder");
}
```

- [ ] **Step 4: Verify the workspace still builds**

Run: `cd rust-core && cargo build`
Expected: `Compiling ingestion v0.1.0`, `Compiling backtest v0.1.0`, then `Finished` with no errors.

- [ ] **Step 5: Commit**

```bash
git add rust-core/Cargo.toml rust-core/crates/ingestion/ rust-core/crates/backtest/
git commit -m "chore: scaffold ingestion and backtest crates"
```

---

### Task 2: `compute()` totality — one shared lookback gate, documented precondition

**Decision (compute() totality):** Phase 1 already chose the "documented precondition + caller-side gate" model — its sidecar handler filters `required_lookback() <= ctx.closes.len()` inline before calling `compute()`, and its indicators still slice-panic on insufficient history. The backtest is about to become a **second** `compute()` caller, so re-implementing that filter there invites drift. This task takes the **safer** of the two options in the spec: **keep `compute()` panicking-with-a-documented-precondition (do NOT inject synthetic `Neutral` outputs), and enforce the precondition in exactly one shared function `registry::run_applicable()` that every caller — sidecar handler and backtest — routes through.** Injecting `Neutral` was rejected because it corrupts the confluence scorecard's `neutral_count`, which §6.3 keeps as a distinct, meaningful category ("the algorithm looked and had no opinion" must not be confused with "the algorithm could not run"). One chokepoint means no future caller can forget the gate.

**Depends on:** none. **Parallel-safe: yes** (touches only `algo-core` and `sidecar`; no other Wave-A task touches these).

**Files:**
- Modify: `rust-core/crates/algo-core/src/algorithm.rs` (doc the precondition)
- Modify: `rust-core/crates/algo-core/src/registry.rs` (add `run_applicable`)
- Modify: `rust-core/crates/sidecar/src/handlers.rs` (route through `run_applicable`)
- Test: `rust-core/crates/algo-core/tests/registry_test.rs` (append)

**Interfaces:**
- Consumes: `registry::all()`, `Algorithm`, `AlgoOutput`, `MarketContext` (Phase 1).
- Produces: `algo_core::registry::run_applicable(algos: &[Box<dyn Algorithm>], ctx: &MarketContext) -> Vec<AlgoOutput>` — the single lookback gate. Task 8's backtest and the refactored sidecar handler both call it.

- [ ] **Step 1: Write the failing test**

Append to `rust-core/crates/algo-core/tests/registry_test.rs`:
```rust
use algo_core::{registry::run_applicable, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

fn ctx_with_closes(n: usize) -> MarketContext {
    let closes = (0..n).map(|i| 100.0 + i as f64).collect();
    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    MarketContext {
        symbol: "NSE:TEST".to_string(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        closes,
        as_of,
    }
}

#[test]
fn run_applicable_skips_algorithms_without_enough_lookback() {
    // 15 closes: rsi(14) needs 15 and runs; sma(20)/ema(20) need 20 and are skipped.
    let algos = registry::all();
    let outputs = run_applicable(&algos, &ctx_with_closes(15));
    let ids: Vec<&str> = outputs.iter().map(|o| o.algo_id).collect();
    assert_eq!(ids, vec!["rsi"]);
}

#[test]
fn run_applicable_runs_all_when_history_is_sufficient() {
    let algos = registry::all();
    let outputs = run_applicable(&algos, &ctx_with_closes(21));
    assert_eq!(outputs.len(), 3);
}

#[test]
fn run_applicable_returns_empty_for_no_history_instead_of_panicking() {
    let algos = registry::all();
    let outputs = run_applicable(&algos, &ctx_with_closes(0));
    assert!(outputs.is_empty());
}
```
(`use algo_core::registry;` is already present from Phase 1's Task 6 test; keep it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rust-core && cargo test -p algo-core registry_test`
Expected: FAIL — `run_applicable` is not defined.

- [ ] **Step 3: Implement `run_applicable` and document the precondition**

Add to `rust-core/crates/algo-core/src/registry.rs`:
```rust
use crate::{Algorithm, AlgoOutput, MarketContext};

pub struct AlgorithmFactory(pub fn() -> Box<dyn Algorithm>);

inventory::collect!(AlgorithmFactory);

pub fn all() -> Vec<Box<dyn Algorithm>> {
    inventory::iter::<AlgorithmFactory>()
        .map(|factory| (factory.0)())
        .collect()
}

/// The single enforcement point for `Algorithm::compute`'s history precondition.
/// An algorithm whose `required_lookback()` exceeds `ctx.closes.len()` has no
/// opinion to offer and would panic on its own slice arithmetic if called, so it
/// is skipped. Every `compute()` caller (the sidecar handler and the backtest
/// engine) MUST route through this function rather than calling `compute()`
/// directly, so the precondition is checked in exactly one place.
pub fn run_applicable(algos: &[Box<dyn Algorithm>], ctx: &MarketContext) -> Vec<AlgoOutput> {
    algos
        .iter()
        .filter(|algo| algo.required_lookback() <= ctx.closes.len())
        .map(|algo| algo.compute(ctx))
        .collect()
}
```
(Replace the existing `use crate::Algorithm;` line at the top with the combined `use` above.)

Add a doc comment to the `compute` method in `rust-core/crates/algo-core/src/algorithm.rs`:
```rust
pub trait Algorithm: Send + Sync {
    fn id(&self) -> &'static str;
    fn required_lookback(&self) -> usize;
    fn applicable_horizons(&self) -> &'static [Horizon];
    /// Precondition: `ctx.closes.len() >= self.required_lookback()`. Implementations
    /// may panic (slice underflow) if called with less history. Callers MUST NOT
    /// call this directly — route through `registry::run_applicable`, which gates
    /// every algorithm on this precondition in one place.
    fn compute(&self, ctx: &MarketContext) -> AlgoOutput;
}
```

- [ ] **Step 4: Refactor the sidecar handler to route through `run_applicable` (behavior-preserving)**

In `rust-core/crates/sidecar/src/handlers.rs`, replace the inline filter+map block with a call to the shared gate. Change the imports line to include `run_applicable`:
```rust
use algo_core::{confluence::compute_confluence, registry::{self, run_applicable}, Horizon, MarketContext, Timeframe};
```
and replace the `let outputs: Vec<_> = registry::all() ...collect();` block (and its explanatory comment) with:
```rust
    // Route every compute() call through the one shared lookback gate
    // (algo_core::registry::run_applicable) so the sidecar and the backtest
    // engine cannot drift on the insufficient-history contract.
    let algos = registry::all();
    let outputs = run_applicable(&algos, &ctx);
```
The three existing handler tests (`skips_algorithms_without_enough_lookback_instead_of_panicking`, `empty_closes_yields_well_formed_zeroed_response`, `sufficient_closes_runs_all_registered_algorithms`) must remain unchanged and still pass — this refactor preserves their behavior exactly.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd rust-core && cargo test -p algo-core registry_test && cargo test -p sidecar`
Expected: the three new `run_applicable` tests pass, and all Phase 1 `sidecar` tests still pass.

- [ ] **Step 6: Commit**

```bash
git add rust-core/crates/algo-core/ rust-core/crates/sidecar/
git commit -m "feat(algo-core): shared run_applicable lookback gate; document compute() precondition"
```

---

### Task 3: Storage robustness — empty-not-error read, error propagation on open

**Depends on:** none. **Parallel-safe: yes** (Wave A; touches only `storage`). Task 4 edits the same `candle_store.rs`, so Task 4 runs after this.

**Files:**
- Create: `rust-core/crates/storage/src/error.rs`
- Modify: `rust-core/crates/storage/src/candle_store.rs`
- Modify: `rust-core/crates/storage/src/lib.rs`
- Test: `rust-core/crates/storage/tests/candle_store_test.rs` (append)

**Interfaces:**
- Produces: `storage::StorageError` (enum: `Io`, `Duckdb`, `Sqlite`) with `From` impls and a crate-internal `Result<T>` alias; `CandleStore::open`/`write_candles`/`read_candles` now return `storage::Result<T>`; private `read_partition`/`write_partition` helpers where the empty-not-error guard lives (so Task 4's sourced reads inherit it automatically).

- [ ] **Step 1: Write the failing tests**

Append to `rust-core/crates/storage/tests/candle_store_test.rs`:
```rust
#[test]
fn read_candles_on_never_written_partition_returns_empty_vec() {
    // design §5.1: a from/to window with no data is "empty, not error".
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();

    let got = store.read_candles("NSE:NEVERWRITTEN", "day").unwrap();

    assert!(got.is_empty());
}

#[test]
fn open_on_uncreatable_root_returns_err_not_panic() {
    // create_dir_all fails when an ancestor of the requested root is a file.
    let dir = tempdir().unwrap();
    let file_path = dir.path().join("iamafile");
    std::fs::write(&file_path, b"x").unwrap();
    let bogus_root = file_path.join("subdir");

    let result = CandleStore::open(&bogus_root);

    assert!(result.is_err());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd rust-core && cargo test -p storage candle_store_test`
Expected: FAIL — `read_candles` currently returns a DuckDB error for the missing partition; `open` currently `.expect()`-panics instead of returning `Err`.

- [ ] **Step 3: Add the error type**

`rust-core/crates/storage/src/error.rs`:
```rust
#[derive(Debug)]
pub enum StorageError {
    Io(std::io::Error),
    Duckdb(duckdb::Error),
    Sqlite(rusqlite::Error),
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StorageError::Io(e) => write!(f, "storage io error: {e}"),
            StorageError::Duckdb(e) => write!(f, "storage duckdb error: {e}"),
            StorageError::Sqlite(e) => write!(f, "storage sqlite error: {e}"),
        }
    }
}

impl std::error::Error for StorageError {}

impl From<std::io::Error> for StorageError {
    fn from(e: std::io::Error) -> Self {
        StorageError::Io(e)
    }
}

impl From<duckdb::Error> for StorageError {
    fn from(e: duckdb::Error) -> Self {
        StorageError::Duckdb(e)
    }
}

impl From<rusqlite::Error> for StorageError {
    fn from(e: rusqlite::Error) -> Self {
        StorageError::Sqlite(e)
    }
}

pub type Result<T> = std::result::Result<T, StorageError>;
```

- [ ] **Step 4: Migrate `CandleStore` to `storage::Result` and add private partition helpers**

In `rust-core/crates/storage/src/candle_store.rs`, change the top imports and `open`, extract `read_partition`/`write_partition`, and route `read_candles`/`write_candles` through them:
```rust
use crate::error::{Result, StorageError};
use duckdb::{params, Connection};
use std::path::{Path, PathBuf};
```
```rust
    pub fn open(root: &Path) -> Result<Self> {
        std::fs::create_dir_all(root).map_err(StorageError::Io)?;
        Ok(Self { root: root.to_path_buf() })
    }
```
```rust
    fn read_partition(&self, path: &Path) -> Result<Vec<Candle>> {
        // design §5.1: a never-written partition is empty, not an error.
        if !path.exists() {
            return Ok(Vec::new());
        }
        let path_str = path.to_string_lossy();
        let conn = Connection::open_in_memory()?;
        let mut stmt = conn.prepare(&format!(
            "SELECT ts, open, high, low, close, volume FROM read_parquet('{path_str}') ORDER BY ts ASC"
        ))?;
        let rows = stmt.query_map([], |row| {
            Ok(Candle {
                ts: row.get(0)?,
                open: row.get(1)?,
                high: row.get(2)?,
                low: row.get(3)?,
                close: row.get(4)?,
                volume: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<duckdb::Result<Vec<Candle>>>()?)
    }

    fn write_partition(&self, path: &Path, candles: &[Candle]) -> Result<()> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            "CREATE TABLE candles (ts BIGINT, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume BIGINT)",
        )?;
        let mut appender = conn.appender("candles")?;
        for candle in candles {
            appender.append_row(params![
                candle.ts, candle.open, candle.high, candle.low, candle.close, candle.volume
            ])?;
        }
        appender.flush()?;
        let path_str = path.to_string_lossy();
        conn.execute(&format!("COPY candles TO '{path_str}' (FORMAT PARQUET)"), [])?;
        Ok(())
    }

    pub fn write_candles(&self, symbol: &str, timeframe: &str, candles: &[Candle]) -> Result<()> {
        self.write_partition(&self.partition_path(symbol, timeframe), candles)
    }

    pub fn read_candles(&self, symbol: &str, timeframe: &str) -> Result<Vec<Candle>> {
        self.read_partition(&self.partition_path(symbol, timeframe))
    }
```
(Delete the old bodies of `write_candles`/`read_candles`; keep `sanitize_component`/`partition_path` as-is.)

Update `rust-core/crates/storage/src/lib.rs`:
```rust
mod candle_store;
mod error;
mod state_store;

pub use candle_store::{Candle, CandleStore};
pub use error::StorageError;
pub use state_store::StateStore;
```
(`candle_store.rs` references `crate::error::Result` directly via its own `use`, so no re-export of the alias is needed here — keeping it out avoids an unused-import clippy warning.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd rust-core && cargo test -p storage`
Expected: the two new tests pass, and all Phase 1 storage tests (round-trip, partition isolation, hostile-symbol sanitize) still pass unchanged (`.unwrap()` works on `storage::Result`).

- [ ] **Step 6: Commit**

```bash
git add rust-core/crates/storage/
git commit -m "fix(storage): empty-not-error reads, propagate open errors, StorageError type"
```

---

### Task 4: Source-tagged, append-merge candle partitions

**Depends on:** Task 3 (uses `read_partition`/`write_partition` and `storage::Result`; edits the same file). **Parallel-safe: yes** within Wave B relative to Tasks 5 and 9 (different crates); **not** parallel with Task 3.

**Rationale:** Design §5.3/§10.3 require live-Kite and public-import candles to be "distinctly partitioned/labeled by `source`". `storage::Candle` is kept pure OHLCV (algorithms read it; provenance is not their concern), so `source` becomes a **partition-key component in the filename** (`{symbol}_{timeframe}_{source}.parquet`) — genuinely Hive-style, mirroring how `symbol` and `timeframe` are already path components, requiring **zero** change to `Candle` or Phase 1 tests. Bhavcopy ingestion appends one day at a time, so the writer does read-merge-write keyed on `ts` (incoming wins on duplicate `ts`, output sorted ascending), giving idempotent re-ingestion.

**Files:**
- Modify: `rust-core/crates/storage/src/candle_store.rs`
- Test: `rust-core/crates/storage/tests/candle_store_test.rs` (append)

**Interfaces:**
- Produces: `CandleStore::write_sourced_candles(&self, symbol: &str, timeframe: &str, source: &str, candles: &[Candle]) -> storage::Result<()>` (append-merge, dedup by `ts`), `CandleStore::read_sourced_candles(&self, symbol: &str, timeframe: &str, source: &str) -> storage::Result<Vec<Candle>>` (empty-not-error via `read_partition`). Task 8 (importer) and Task 12 (CLI) call these.

- [ ] **Step 1: Write the failing test**

Append to `rust-core/crates/storage/tests/candle_store_test.rs`:
```rust
#[test]
fn write_sourced_candles_appends_merges_dedups_and_sorts() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();

    store
        .write_sourced_candles("NSE:INFY", "day", "bhavcopy", &[
            Candle { ts: 100, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 10 },
            Candle { ts: 200, open: 2.0, high: 2.0, low: 2.0, close: 2.0, volume: 20 },
        ])
        .unwrap();
    // Second batch overlaps ts=200 (new value wins) and adds ts=300; ts arrives
    // out of order to prove the merge sorts.
    store
        .write_sourced_candles("NSE:INFY", "day", "bhavcopy", &[
            Candle { ts: 300, open: 3.0, high: 3.0, low: 3.0, close: 3.0, volume: 30 },
            Candle { ts: 200, open: 2.5, high: 2.5, low: 2.5, close: 2.5, volume: 25 },
        ])
        .unwrap();

    let got = store.read_sourced_candles("NSE:INFY", "day", "bhavcopy").unwrap();

    assert_eq!(got.len(), 3);
    assert_eq!(got.iter().map(|c| c.ts).collect::<Vec<_>>(), vec![100, 200, 300]);
    assert_eq!(got[1].close, 2.5, "incoming candle must win on duplicate ts");
}

#[test]
fn read_sourced_candles_on_missing_source_is_empty() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();
    assert!(store.read_sourced_candles("NSE:INFY", "day", "kaggle").unwrap().is_empty());
}

#[test]
fn sources_are_partitioned_separately_for_the_same_symbol() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();
    store.write_sourced_candles("NSE:INFY", "day", "bhavcopy",
        &[Candle { ts: 100, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 10 }]).unwrap();
    store.write_sourced_candles("NSE:INFY", "day", "kaggle",
        &[Candle { ts: 100, open: 9.0, high: 9.0, low: 9.0, close: 9.0, volume: 90 }]).unwrap();

    assert_eq!(store.read_sourced_candles("NSE:INFY", "day", "bhavcopy").unwrap()[0].close, 1.0);
    assert_eq!(store.read_sourced_candles("NSE:INFY", "day", "kaggle").unwrap()[0].close, 9.0);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd rust-core && cargo test -p storage candle_store_test`
Expected: FAIL — `write_sourced_candles`/`read_sourced_candles` do not exist.

- [ ] **Step 3: Implement the sourced partition methods**

Add to `impl CandleStore` in `rust-core/crates/storage/src/candle_store.rs` (add `use std::collections::BTreeMap;` at the top):
```rust
    fn sourced_partition_path(&self, symbol: &str, timeframe: &str, source: &str) -> PathBuf {
        let s = Self::sanitize_component(symbol);
        let t = Self::sanitize_component(timeframe);
        let src = Self::sanitize_component(source);
        self.root.join(format!("{s}_{t}_{src}.parquet"))
    }

    pub fn write_sourced_candles(
        &self,
        symbol: &str,
        timeframe: &str,
        source: &str,
        candles: &[Candle],
    ) -> Result<()> {
        let path = self.sourced_partition_path(symbol, timeframe, source);
        // Read-merge-write keyed on ts: existing partition + incoming, incoming
        // wins on duplicate ts, output sorted ascending. Makes re-ingesting the
        // same day idempotent and lets day-by-day bhavcopy pulls accumulate.
        let mut merged: BTreeMap<i64, Candle> =
            self.read_partition(&path)?.into_iter().map(|c| (c.ts, c)).collect();
        for candle in candles {
            merged.insert(candle.ts, candle.clone());
        }
        let ordered: Vec<Candle> = merged.into_values().collect();
        self.write_partition(&path, &ordered)
    }

    pub fn read_sourced_candles(&self, symbol: &str, timeframe: &str, source: &str) -> Result<Vec<Candle>> {
        self.read_partition(&self.sourced_partition_path(symbol, timeframe, source))
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd rust-core && cargo test -p storage candle_store_test`
Expected: the three new tests pass.

- [ ] **Step 5: Commit**

```bash
git add rust-core/crates/storage/
git commit -m "feat(storage): source-tagged append-merge candle partitions"
```

---

### Task 5: Ingestion foundation — `ParsedCandle`, IST session-close epoch, UDiFF equity bhavcopy parser

**Depends on:** Task 1 (crate exists). **Parallel-safe: yes** within Wave B relative to Task 4 (storage) and Task 9 (backtest). Tasks 6 and 7 add sibling parsers to this crate afterward.

**Design note (timestamp convention — load-bearing for anti-lookahead):** a daily candle is final only at the exchange session close, **15:30 IST**. We encode that instant as an absolute Unix epoch (`ts`), so the backtest's frontier comparisons are locale-independent (never OS-local time, design §5.2) while still being anchored to exchange-local session time (design §6.4). Bhavcopy timestamps are dates, so `ist_session_close_epoch(date)` maps a trade date to the 15:30-IST-close epoch. The parser is **pure** (deterministic, no wall-clock, no network). Provenance (`source`) is applied by the importer (Task 8) at write time, not carried per-row, because a whole bhavcopy file is one source. Symbol is exchange-qualified (`NSE:INFY`) per design §5.1 (key on `exchange:tradingsymbol`); the same parser serves BSE (design §10.1: "same UDiFF schema as NSE") by passing `exchange = "BSE"`.

**Files:**
- Create: `rust-core/crates/ingestion/src/error.rs`
- Create: `rust-core/crates/ingestion/src/model.rs`
- Create: `rust-core/crates/ingestion/src/time.rs`
- Create: `rust-core/crates/ingestion/src/bhavcopy.rs`
- Modify: `rust-core/crates/ingestion/src/lib.rs`
- Create: `rust-core/crates/ingestion/tests/fixtures/nse_bhavcopy_udiff_sample.csv`
- Test: `rust-core/crates/ingestion/tests/bhavcopy_parse_test.rs`

**Interfaces:**
- Produces: `ingestion::ParsedCandle { symbol: String, timeframe: String, candle: storage::Candle }`; `ingestion::IngestionError`; `ingestion::time::ist_session_close_epoch(date: chrono::NaiveDate) -> i64`; `ingestion::bhavcopy::parse_udiff_equity_bhavcopy(csv_bytes: &[u8], exchange: &str) -> Result<Vec<ParsedCandle>, IngestionError>`. Tasks 6, 7, 8 reuse `ParsedCandle`, `IngestionError`, and `ist_session_close_epoch`.

- [ ] **Step 1: Commit the fixture CSV**

`rust-core/crates/ingestion/tests/fixtures/nse_bhavcopy_udiff_sample.csv` (real UDiFF column names; the production NSE file has ~34 columns — the parser resolves columns by header name, so this trimmed-but-real subset plus a couple of neighbors is valid input and the extra production columns are ignored):
```
TradDt,FinInstrmTp,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd
2024-01-15,STK,INFY,EQ,1500.00,1525.50,1495.25,1520.75,1520.00,1490.00,1234567,1875000000.00,45678
2024-01-15,STK,TCS,EQ,3800.00,3850.00,3790.10,3845.60,3845.00,3775.00,987654,3600000000.00,33210
2024-01-15,STK,IDEA,BE,14.50,14.80,14.30,14.75,14.70,14.40,50000,735000.00,1200
```

**Derivation the test asserts (independently verifiable):**
- `SctySrs` filter keeps only `EQ` rows → INFY and TCS parsed, IDEA (`BE`) skipped → **2 candles**.
- `TradDt = 2024-01-15`, session close 15:30 IST = 10:00:00 UTC. Epoch: `2024-01-01T00:00:00Z = 1_704_067_200`; `+14 days (1_209_600) = 1_705_276_800` (2024-01-15T00:00Z); `+10h (36_000) = 1_705_312_800`. So `ts = 1_705_312_800`.
- INFY: open 1500.00, high 1525.50, low 1495.25, close 1520.75, volume 1_234_567, symbol `NSE:INFY`, timeframe `day`.

- [ ] **Step 2: Write the failing test**

`rust-core/crates/ingestion/tests/bhavcopy_parse_test.rs`:
```rust
use ingestion::bhavcopy::parse_udiff_equity_bhavcopy;

const SAMPLE: &[u8] = include_bytes!("fixtures/nse_bhavcopy_udiff_sample.csv");

#[test]
fn parses_only_eq_series_with_correct_fields_and_ist_close_timestamp() {
    let parsed = parse_udiff_equity_bhavcopy(SAMPLE, "NSE").unwrap();

    assert_eq!(parsed.len(), 2, "BE-series row must be skipped");

    let infy = parsed.iter().find(|p| p.symbol == "NSE:INFY").unwrap();
    assert_eq!(infy.timeframe, "day");
    assert_eq!(infy.candle.ts, 1_705_312_800); // 2024-01-15 15:30 IST -> 10:00 UTC
    assert_eq!(infy.candle.open, 1500.00);
    assert_eq!(infy.candle.high, 1525.50);
    assert_eq!(infy.candle.low, 1495.25);
    assert_eq!(infy.candle.close, 1520.75);
    assert_eq!(infy.candle.volume, 1_234_567);

    assert!(parsed.iter().any(|p| p.symbol == "NSE:TCS"));
    assert!(!parsed.iter().any(|p| p.symbol == "NSE:IDEA"));
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd rust-core && cargo test -p ingestion bhavcopy_parse_test`
Expected: FAIL — `ingestion::bhavcopy` does not exist.

- [ ] **Step 4: Implement error type, model, time helper, and the parser**

`rust-core/crates/ingestion/src/error.rs`:
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

impl std::fmt::Display for IngestionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IngestionError::Csv(e) => write!(f, "csv error: {e}"),
            IngestionError::MissingColumn(c) => write!(f, "missing column: {c}"),
            IngestionError::BadField { column, value } => write!(f, "bad field in {column}: {value:?}"),
            IngestionError::Io(e) => write!(f, "io error: {e}"),
            IngestionError::Storage(e) => write!(f, "storage error: {e}"),
            IngestionError::Fetch(m) => write!(f, "fetch error: {m}"),
        }
    }
}

impl std::error::Error for IngestionError {}

impl From<csv::Error> for IngestionError {
    fn from(e: csv::Error) -> Self { IngestionError::Csv(e) }
}
impl From<std::io::Error> for IngestionError {
    fn from(e: std::io::Error) -> Self { IngestionError::Io(e) }
}
impl From<storage::StorageError> for IngestionError {
    fn from(e: storage::StorageError) -> Self { IngestionError::Storage(e) }
}
```

`rust-core/crates/ingestion/src/model.rs`:
```rust
use storage::Candle;

/// One parsed OHLCV bar plus the metadata needed to route it into the candle
/// lake. `source` is NOT carried here — it is a whole-file property applied by
/// the importer at write time (a bhavcopy file is entirely one source).
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedCandle {
    pub symbol: String,    // exchange-qualified, e.g. "NSE:INFY"
    pub timeframe: String, // "day" | "minute"
    pub candle: Candle,
}
```

`rust-core/crates/ingestion/src/time.rs`:
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

`rust-core/crates/ingestion/src/bhavcopy.rs`:
```rust
use crate::error::IngestionError;
use crate::model::ParsedCandle;
use crate::time::ist_session_close_epoch;
use chrono::NaiveDate;
use csv::{ReaderBuilder, StringRecord, Trim};
use std::collections::HashMap;
use storage::Candle;

fn header_index(headers: &StringRecord) -> HashMap<String, usize> {
    headers.iter().enumerate().map(|(i, h)| (h.to_string(), i)).collect()
}

fn col(idx: &HashMap<String, usize>, name: &str) -> Result<usize, IngestionError> {
    idx.get(name).copied().ok_or_else(|| IngestionError::MissingColumn(name.to_string()))
}

fn field<'a>(record: &'a StringRecord, i: usize) -> Result<&'a str, IngestionError> {
    record.get(i).ok_or_else(|| IngestionError::BadField {
        column: format!("index {i}"),
        value: "<missing>".to_string(),
    })
}

fn parse_f64(record: &StringRecord, i: usize, name: &str) -> Result<f64, IngestionError> {
    let v = field(record, i)?;
    v.parse::<f64>().map_err(|_| IngestionError::BadField { column: name.to_string(), value: v.to_string() })
}

fn parse_i64(record: &StringRecord, i: usize, name: &str) -> Result<i64, IngestionError> {
    let v = field(record, i)?;
    v.parse::<i64>().map_err(|_| IngestionError::BadField { column: name.to_string(), value: v.to_string() })
}

pub fn parse_udiff_equity_bhavcopy(
    csv_bytes: &[u8],
    exchange: &str,
) -> Result<Vec<ParsedCandle>, IngestionError> {
    let mut reader = ReaderBuilder::new().trim(Trim::All).from_reader(csv_bytes);
    let headers = reader.headers()?.clone();
    let idx = header_index(&headers);

    let (c_series, c_tckr, c_dt) = (col(&idx, "SctySrs")?, col(&idx, "TckrSymb")?, col(&idx, "TradDt")?);
    let (c_o, c_h, c_l, c_c, c_v) = (
        col(&idx, "OpnPric")?,
        col(&idx, "HghPric")?,
        col(&idx, "LwPric")?,
        col(&idx, "ClsPric")?,
        col(&idx, "TtlTradgVol")?,
    );

    let mut out = Vec::new();
    for record in reader.records() {
        let record = record?;
        if record.get(c_series) != Some("EQ") {
            continue;
        }
        let dt_str = field(&record, c_dt)?;
        let date = NaiveDate::parse_from_str(dt_str, "%Y-%m-%d")
            .map_err(|_| IngestionError::BadField { column: "TradDt".to_string(), value: dt_str.to_string() })?;
        out.push(ParsedCandle {
            symbol: format!("{exchange}:{}", field(&record, c_tckr)?),
            timeframe: "day".to_string(),
            candle: Candle {
                ts: ist_session_close_epoch(date),
                open: parse_f64(&record, c_o, "OpnPric")?,
                high: parse_f64(&record, c_h, "HghPric")?,
                low: parse_f64(&record, c_l, "LwPric")?,
                close: parse_f64(&record, c_c, "ClsPric")?,
                volume: parse_i64(&record, c_v, "TtlTradgVol")?,
            },
        });
    }
    Ok(out)
}
```

`rust-core/crates/ingestion/src/lib.rs`:
```rust
pub mod bhavcopy;
pub mod error;
pub mod model;
pub mod time;

pub use error::IngestionError;
pub use model::ParsedCandle;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd rust-core && cargo test -p ingestion bhavcopy_parse_test`
Expected: `parses_only_eq_series_with_correct_fields_and_ist_close_timestamp ... ok`

- [ ] **Step 6: Commit**

```bash
git add rust-core/crates/ingestion/
git commit -m "feat(ingestion): ParsedCandle, IST session-close epoch, UDiFF equity bhavcopy parser"
```

---

### Task 6: NSE all-indices daily-close parser (volume=0 quirk)

**Depends on:** Task 5 (reuses `ParsedCandle`, `IngestionError`, `ist_session_close_epoch`). **Parallel-safe: yes** with Task 7 (different source file; both add one `pub mod` line to `lib.rs` — an additive, trivially-mergeable edit).

**Design note:** the all-indices file (`ind_close_all_{DDMMYYYY}.csv`, design §10.1) is a different schema and has no meaningful traded volume. Per design §5.1 ("Index instruments always report volume=0"), the parser normalizes every index row to `volume: 0` so index candles match what volume-based algorithms will see from live Kite data — no special-casing needed downstream beyond what those algorithms already do for indices. Index `Index Date` is `DD-MM-YYYY`.

**Files:**
- Create: `rust-core/crates/ingestion/src/indices.rs`
- Modify: `rust-core/crates/ingestion/src/lib.rs` (add `pub mod indices;`)
- Create: `rust-core/crates/ingestion/tests/fixtures/nse_indices_close_sample.csv`
- Test: `rust-core/crates/ingestion/tests/indices_parse_test.rs`

**Interfaces:**
- Produces: `ingestion::indices::parse_nse_indices_close(csv_bytes: &[u8]) -> Result<Vec<ParsedCandle>, IngestionError>` — every returned candle has `volume == 0`, `timeframe == "day"`.

- [ ] **Step 1: Commit the fixture CSV**

`rust-core/crates/ingestion/tests/fixtures/nse_indices_close_sample.csv`:
```
Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value
Nifty 50,15-01-2024,21600.00,21750.00,21550.00,21700.50
Nifty Bank,15-01-2024,46000.00,46300.00,45900.00,46250.75
```

**Derivation:** `15-01-2024` → same 15:30-IST-close epoch as Task 5 → `ts = 1_705_312_800`. Two rows → 2 candles; both `volume == 0`; symbols `NSE:Nifty 50`, `NSE:Nifty Bank`.

- [ ] **Step 2: Write the failing test**

`rust-core/crates/ingestion/tests/indices_parse_test.rs`:
```rust
use ingestion::indices::parse_nse_indices_close;

const SAMPLE: &[u8] = include_bytes!("fixtures/nse_indices_close_sample.csv");

#[test]
fn parses_indices_with_zero_volume_and_ist_close_timestamp() {
    let parsed = parse_nse_indices_close(SAMPLE).unwrap();

    assert_eq!(parsed.len(), 2);
    for p in &parsed {
        assert_eq!(p.candle.volume, 0, "index candles carry volume 0 (design §5.1)");
        assert_eq!(p.candle.ts, 1_705_312_800);
        assert_eq!(p.timeframe, "day");
    }
    let nifty = parsed.iter().find(|p| p.symbol == "NSE:Nifty 50").unwrap();
    assert_eq!(nifty.candle.open, 21600.00);
    assert_eq!(nifty.candle.close, 21700.50);
    assert!(parsed.iter().any(|p| p.symbol == "NSE:Nifty Bank"));
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd rust-core && cargo test -p ingestion indices_parse_test`
Expected: FAIL — `ingestion::indices` does not exist.

- [ ] **Step 4: Implement the parser**

`rust-core/crates/ingestion/src/indices.rs`:
```rust
use crate::error::IngestionError;
use crate::model::ParsedCandle;
use crate::time::ist_session_close_epoch;
use chrono::NaiveDate;
use csv::{ReaderBuilder, StringRecord, Trim};
use std::collections::HashMap;
use storage::Candle;

fn header_index(headers: &StringRecord) -> HashMap<String, usize> {
    headers.iter().enumerate().map(|(i, h)| (h.to_string(), i)).collect()
}

fn col(idx: &HashMap<String, usize>, name: &str) -> Result<usize, IngestionError> {
    idx.get(name).copied().ok_or_else(|| IngestionError::MissingColumn(name.to_string()))
}

fn get<'a>(r: &'a StringRecord, i: usize) -> Result<&'a str, IngestionError> {
    r.get(i).ok_or_else(|| IngestionError::BadField { column: format!("index {i}"), value: "<missing>".to_string() })
}

fn num(r: &StringRecord, i: usize, name: &str) -> Result<f64, IngestionError> {
    let v = get(r, i)?;
    v.parse::<f64>().map_err(|_| IngestionError::BadField { column: name.to_string(), value: v.to_string() })
}

pub fn parse_nse_indices_close(csv_bytes: &[u8]) -> Result<Vec<ParsedCandle>, IngestionError> {
    let mut reader = ReaderBuilder::new().trim(Trim::All).from_reader(csv_bytes);
    let headers = reader.headers()?.clone();
    let idx = header_index(&headers);

    let c_name = col(&idx, "Index Name")?;
    let c_date = col(&idx, "Index Date")?;
    let c_o = col(&idx, "Open Index Value")?;
    let c_h = col(&idx, "High Index Value")?;
    let c_l = col(&idx, "Low Index Value")?;
    let c_c = col(&idx, "Closing Index Value")?;

    let mut out = Vec::new();
    for record in reader.records() {
        let record = record?;
        let date_str = get(&record, c_date)?;
        let date = NaiveDate::parse_from_str(date_str, "%d-%m-%Y")
            .map_err(|_| IngestionError::BadField { column: "Index Date".to_string(), value: date_str.to_string() })?;
        out.push(ParsedCandle {
            symbol: format!("NSE:{}", get(&record, c_name)?),
            timeframe: "day".to_string(),
            candle: Candle {
                ts: ist_session_close_epoch(date),
                open: num(&record, c_o, "Open Index Value")?,
                high: num(&record, c_h, "High Index Value")?,
                low: num(&record, c_l, "Low Index Value")?,
                close: num(&record, c_c, "Closing Index Value")?,
                volume: 0, // design §5.1: indices report volume 0
            },
        });
    }
    Ok(out)
}
```

Add to `rust-core/crates/ingestion/src/lib.rs`:
```rust
pub mod indices;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd rust-core && cargo test -p ingestion indices_parse_test`
Expected: `parses_indices_with_zero_volume_and_ist_close_timestamp ... ok`

- [ ] **Step 6: Commit**

```bash
git add rust-core/crates/ingestion/
git commit -m "feat(ingestion): NSE all-indices daily-close parser (volume=0)"
```

---

### Task 7: Community intraday minute parser (offset-aware +0530)

**Depends on:** Task 5 (`ParsedCandle`, `IngestionError`). **Parallel-safe: yes** with Task 6.

**Design note:** the Kaggle CC0 dataset (`debashis74017/...`, preferred) and the aeron7 GitHub archive (lower-confidence supplement) share the same `date,open,high,low,close,volume` minute shape (design §10.2). One pure parser serves both; only the `source` tag (`"kaggle"` vs `"github_archive"`) differs, applied by the importer (Task 8), not the parser. Timestamps carry an explicit `+05:30` offset (Kite convention, design §5.2): the parser **must parse offset-aware and never strip to naive** (a documented real bug class). Symbol is passed in by the caller (these files are per-symbol).

**Files:**
- Create: `rust-core/crates/ingestion/src/intraday.rs`
- Modify: `rust-core/crates/ingestion/src/lib.rs` (add `pub mod intraday;`)
- Create: `rust-core/crates/ingestion/tests/fixtures/kaggle_banknifty_minute_sample.csv`
- Test: `rust-core/crates/ingestion/tests/intraday_parse_test.rs`

**Interfaces:**
- Produces: `ingestion::intraday::parse_intraday_ohlcv(csv_bytes: &[u8], symbol: &str) -> Result<Vec<ParsedCandle>, IngestionError>` — `timeframe == "minute"`, timestamps converted offset-aware.

- [ ] **Step 1: Commit the fixture CSV**

`rust-core/crates/ingestion/tests/fixtures/kaggle_banknifty_minute_sample.csv`:
```
date,open,high,low,close,volume
2021-01-01 09:15:00+05:30,31000.00,31025.50,30990.00,31010.25,150000
2021-01-01 09:16:00+05:30,31010.25,31040.00,31005.00,31035.75,120000
2021-01-01 09:17:00+05:30,31035.75,31050.00,31020.00,31025.00,98000
```

**Derivation (row 1):** `2021-01-01 09:15:00 +05:30` = `03:45:00 UTC`. Epoch: `2021-01-01T00:00:00Z = 1_609_459_200`; `+3h45m (13_500) = 1_609_472_700`. So `ts = 1_609_472_700`. If the offset were wrongly stripped and read as UTC, `ts` would be `1_609_492_500` (09:15 UTC) — the test's exact value catches that bug.

- [ ] **Step 2: Write the failing test**

`rust-core/crates/ingestion/tests/intraday_parse_test.rs`:
```rust
use ingestion::intraday::parse_intraday_ohlcv;

const SAMPLE: &[u8] = include_bytes!("fixtures/kaggle_banknifty_minute_sample.csv");

#[test]
fn parses_minute_bars_offset_aware() {
    let parsed = parse_intraday_ohlcv(SAMPLE, "NSE:BANKNIFTY").unwrap();

    assert_eq!(parsed.len(), 3);
    assert_eq!(parsed[0].symbol, "NSE:BANKNIFTY");
    assert_eq!(parsed[0].timeframe, "minute");
    assert_eq!(parsed[0].candle.ts, 1_609_472_700); // 09:15 +05:30 -> 03:45 UTC
    assert_eq!(parsed[0].candle.close, 31010.25);
    assert_eq!(parsed[0].candle.volume, 150000);
    // one-minute spacing preserved
    assert_eq!(parsed[1].candle.ts - parsed[0].candle.ts, 60);
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd rust-core && cargo test -p ingestion intraday_parse_test`
Expected: FAIL — `ingestion::intraday` does not exist.

- [ ] **Step 4: Implement the parser**

`rust-core/crates/ingestion/src/intraday.rs`:
```rust
use crate::error::IngestionError;
use crate::model::ParsedCandle;
use chrono::DateTime;
use csv::{ReaderBuilder, StringRecord, Trim};
use std::collections::HashMap;
use storage::Candle;

fn header_index(headers: &StringRecord) -> HashMap<String, usize> {
    headers.iter().enumerate().map(|(i, h)| (h.to_string(), i)).collect()
}

fn col(idx: &HashMap<String, usize>, name: &str) -> Result<usize, IngestionError> {
    idx.get(name).copied().ok_or_else(|| IngestionError::MissingColumn(name.to_string()))
}

fn get<'a>(r: &'a StringRecord, i: usize) -> Result<&'a str, IngestionError> {
    r.get(i).ok_or_else(|| IngestionError::BadField { column: format!("index {i}"), value: "<missing>".to_string() })
}

fn num(r: &StringRecord, i: usize, name: &str) -> Result<f64, IngestionError> {
    let v = get(r, i)?;
    v.parse::<f64>().map_err(|_| IngestionError::BadField { column: name.to_string(), value: v.to_string() })
}

fn int(r: &StringRecord, i: usize, name: &str) -> Result<i64, IngestionError> {
    let v = get(r, i)?;
    v.parse::<i64>().map_err(|_| IngestionError::BadField { column: name.to_string(), value: v.to_string() })
}

pub fn parse_intraday_ohlcv(csv_bytes: &[u8], symbol: &str) -> Result<Vec<ParsedCandle>, IngestionError> {
    let mut reader = ReaderBuilder::new().trim(Trim::All).from_reader(csv_bytes);
    let headers = reader.headers()?.clone();
    let idx = header_index(&headers);

    let c_date = col(&idx, "date")?;
    let (c_o, c_h, c_l, c_c, c_v) = (
        col(&idx, "open")?,
        col(&idx, "high")?,
        col(&idx, "low")?,
        col(&idx, "close")?,
        col(&idx, "volume")?,
    );

    let mut out = Vec::new();
    for record in reader.records() {
        let record = record?;
        let raw = get(&record, c_date)?;
        // Normalize a space separator to RFC3339's 'T'; parse OFFSET-AWARE so the
        // +05:30 is honored, never stripped to naive (design §5.2 bug class).
        let normalized = raw.replacen(' ', "T", 1);
        let dt = DateTime::parse_from_rfc3339(&normalized)
            .map_err(|_| IngestionError::BadField { column: "date".to_string(), value: raw.to_string() })?;
        out.push(ParsedCandle {
            symbol: symbol.to_string(),
            timeframe: "minute".to_string(),
            candle: Candle {
                ts: dt.timestamp(),
                open: num(&record, c_o, "open")?,
                high: num(&record, c_h, "high")?,
                low: num(&record, c_l, "low")?,
                close: num(&record, c_c, "close")?,
                volume: int(&record, c_v, "volume")?,
            },
        });
    }
    Ok(out)
}
```

Add to `rust-core/crates/ingestion/src/lib.rs`:
```rust
pub mod intraday;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd rust-core && cargo test -p ingestion intraday_parse_test`
Expected: `parses_minute_bars_offset_aware ... ok`

- [ ] **Step 6: Commit**

```bash
git add rust-core/crates/ingestion/
git commit -m "feat(ingestion): offset-aware community intraday minute parser"
```

---

### Task 8: Importer + thin fetch/I/O layer

**Depends on:** Task 4 (`write_sourced_candles`), Task 5 (bhavcopy parser + `ParsedCandle`), Task 6 (indices parser), Task 7 (intraday parser). **Parallel-safe: yes** with Task 11 (backtest) in Wave D.

**Design note:** the importer (pure orchestration over parsed bytes + store, unit-tested with fixtures, no network) is separated from `io.rs` (network fetch, `#[ignore]`d integration test). Fetch sends a mandatory `User-Agent` (design §10.1: a bare request gets a connection reset) and uses **`rustls`** (Global Constraints). NSE serves a `.csv.zip` (unzip one CSV); BSE serves a plain `.CSV` (design §10.1) — the branch handles both. Kaggle/GitHub intraday archives are manual downloads (Kaggle API / git clone), so their "I/O" is reading local files, not HTTP — the importer takes already-read bytes.

**Files:**
- Modify: `rust-core/crates/ingestion/Cargo.toml` (add `reqwest`, `zip`)
- Create: `rust-core/crates/ingestion/src/importer.rs`
- Create: `rust-core/crates/ingestion/src/io.rs`
- Modify: `rust-core/crates/ingestion/src/lib.rs`
- Test: `rust-core/crates/ingestion/tests/importer_test.rs`
- Test: `rust-core/crates/ingestion/tests/fetch_smoke_test.rs` (`#[ignore]`)

**Interfaces:**
- Produces: `ingestion::importer::import_bhavcopy_files(store: &CandleStore, exchange: &str, files: &[Vec<u8>]) -> Result<usize, IngestionError>`; `ingestion::importer::import_intraday_files(store: &CandleStore, source: &str, files: &[(String, Vec<u8>)]) -> Result<usize, IngestionError>`; `ingestion::io::fetch_udiff_bhavcopy(date: NaiveDate, exchange: &str) -> Result<Vec<u8>, IngestionError>`. Task 12's CLI calls `import_bhavcopy_files`.

- [ ] **Step 1: Add fetch dependencies**

Add to `rust-core/crates/ingestion/Cargo.toml` under `[dependencies]`:
```toml
reqwest = { version = "0.12", default-features = false, features = ["blocking", "rustls-tls"] }
zip = "2"
```

- [ ] **Step 2: Write the failing test (network-free importer)**

`rust-core/crates/ingestion/tests/importer_test.rs`:
```rust
use ingestion::importer::{import_bhavcopy_files, import_intraday_files};
use storage::CandleStore;
use tempfile::tempdir;

const BHAV: &[u8] = include_bytes!("fixtures/nse_bhavcopy_udiff_sample.csv");
const MINUTE: &[u8] = include_bytes!("fixtures/kaggle_banknifty_minute_sample.csv");

#[test]
fn bhavcopy_import_lands_eq_candles_tagged_bhavcopy() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();

    let n = import_bhavcopy_files(&store, "NSE", &[BHAV.to_vec()]).unwrap();
    assert_eq!(n, 2, "INFY + TCS; BE-series row skipped");

    let infy = store.read_sourced_candles("NSE:INFY", "day", "bhavcopy").unwrap();
    assert_eq!(infy.len(), 1);
    assert_eq!(infy[0].close, 1520.75);
    assert_eq!(infy[0].ts, 1_705_312_800);
    // not written under a different source
    assert!(store.read_sourced_candles("NSE:INFY", "day", "kaggle").unwrap().is_empty());
}

#[test]
fn intraday_import_lands_minute_candles_tagged_by_source() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();

    let n = import_intraday_files(&store, "kaggle", &[("NSE:BANKNIFTY".to_string(), MINUTE.to_vec())]).unwrap();
    assert_eq!(n, 3);

    let bars = store.read_sourced_candles("NSE:BANKNIFTY", "minute", "kaggle").unwrap();
    assert_eq!(bars.len(), 3);
    assert_eq!(bars[0].ts, 1_609_472_700);
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd rust-core && cargo test -p ingestion importer_test`
Expected: FAIL — `ingestion::importer` does not exist.

- [ ] **Step 4: Implement the importer and fetch layer**

`rust-core/crates/ingestion/src/importer.rs`:
```rust
use crate::bhavcopy::parse_udiff_equity_bhavcopy;
use crate::error::IngestionError;
use crate::intraday::parse_intraday_ohlcv;
use std::collections::HashMap;
use storage::{Candle, CandleStore};

/// Parse each daily bhavcopy file, group candles by symbol across the batch, and
/// write each symbol's series into the lake tagged `source = "bhavcopy"`. The
/// store's append-merge (Task 4) accumulates across batches/days idempotently.
pub fn import_bhavcopy_files(store: &CandleStore, exchange: &str, files: &[Vec<u8>]) -> Result<usize, IngestionError> {
    let mut by_symbol: HashMap<String, Vec<Candle>> = HashMap::new();
    for bytes in files {
        for parsed in parse_udiff_equity_bhavcopy(bytes, exchange)? {
            by_symbol.entry(parsed.symbol).or_default().push(parsed.candle);
        }
    }
    let mut count = 0;
    for (symbol, candles) in &by_symbol {
        store.write_sourced_candles(symbol, "day", "bhavcopy", candles)?;
        count += candles.len();
    }
    Ok(count)
}

/// `files` is `(symbol, csv_bytes)` — community intraday archives are per-symbol.
/// `source` is "kaggle" or "github_archive".
pub fn import_intraday_files(
    store: &CandleStore,
    source: &str,
    files: &[(String, Vec<u8>)],
) -> Result<usize, IngestionError> {
    let mut count = 0;
    for (symbol, bytes) in files {
        let candles: Vec<Candle> = parse_intraday_ohlcv(bytes, symbol)?.into_iter().map(|p| p.candle).collect();
        let n = candles.len();
        store.write_sourced_candles(symbol, "minute", source, &candles)?;
        count += n;
    }
    Ok(count)
}
```

`rust-core/crates/ingestion/src/io.rs`:
```rust
use crate::error::IngestionError;
use chrono::NaiveDate;
use std::io::Read;

fn bhavcopy_url(date: NaiveDate, exchange: &str) -> Result<String, IngestionError> {
    let ymd = date.format("%Y%m%d");
    match exchange {
        "NSE" => Ok(format!(
            "https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{ymd}_F_0000.csv.zip"
        )),
        "BSE" => Ok(format!(
            "https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_{ymd}_F_0000.CSV"
        )),
        other => Err(IngestionError::Fetch(format!("unknown exchange {other}"))),
    }
}

fn unzip_single_csv(zip_bytes: &[u8]) -> Result<Vec<u8>, IngestionError> {
    let reader = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| IngestionError::Fetch(e.to_string()))?;
    let mut file = archive.by_index(0).map_err(|e| IngestionError::Fetch(e.to_string()))?;
    let mut out = Vec::new();
    file.read_to_end(&mut out)?;
    Ok(out)
}

/// Download one day's UDiFF equity bhavcopy and return decompressed CSV bytes.
/// A `User-Agent` is mandatory (design §10.1: a bare request gets a connection
/// reset). rustls only (Global Constraints). Network-touching — exercised only
/// by the #[ignore]d smoke test, never by CI's default run.
pub fn fetch_udiff_bhavcopy(date: NaiveDate, exchange: &str) -> Result<Vec<u8>, IngestionError> {
    let url = bhavcopy_url(date, exchange)?;
    let client = reqwest::blocking::Client::builder()
        .user_agent("trade-assistant/0.1 (personal-use)")
        .build()
        .map_err(|e| IngestionError::Fetch(e.to_string()))?;
    let resp = client
        .get(&url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| IngestionError::Fetch(e.to_string()))?;
    let bytes = resp.bytes().map_err(|e| IngestionError::Fetch(e.to_string()))?.to_vec();
    if exchange == "NSE" {
        unzip_single_csv(&bytes)
    } else {
        Ok(bytes) // BSE serves a plain .CSV
    }
}
```

`rust-core/crates/ingestion/tests/fetch_smoke_test.rs`:
```rust
use chrono::NaiveDate;
use ingestion::bhavcopy::parse_udiff_equity_bhavcopy;
use ingestion::io::fetch_udiff_bhavcopy;

#[test]
#[ignore = "hits the live NSE endpoint; run manually with `cargo test -p ingestion -- --ignored`, pick a recent trading day"]
fn fetch_real_nse_bhavcopy_smoke() {
    let date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let csv = fetch_udiff_bhavcopy(date, "NSE").unwrap();
    let parsed = parse_udiff_equity_bhavcopy(&csv, "NSE").unwrap();
    assert!(!parsed.is_empty());
}
```

Add to `rust-core/crates/ingestion/src/lib.rs`:
```rust
pub mod importer;
pub mod io;
```

- [ ] **Step 5: Run tests to verify they pass (network test stays ignored)**

Run: `cd rust-core && cargo test -p ingestion`
Expected: all parser + importer tests pass; `fetch_real_nse_bhavcopy_smoke` is listed as `ignored`, not run.

- [ ] **Step 6: Commit**

```bash
git add rust-core/crates/ingestion/
git commit -m "feat(ingestion): bhavcopy/intraday importers + rustls fetch layer"
```

---

### Task 9: Backtest frontier windowing + anti-lookahead

**Depends on:** Task 1 (crate exists), Task 2 (`run_applicable`). **Parallel-safe: yes** within Wave B relative to Tasks 4 and 5.

**Design note (anti-lookahead, design §6.4):** the frontier `T` is a candle's own timestamp — walking `T` across the series' candles makes the cadence inherently session-anchored (no arbitrary UTC stride). At frontier index `i`, only candles `series[0..=i]` are visible; `MarketContext.closes` is exactly those closes and `as_of` is `series[i].ts` converted to `DateTime<Utc>` (never `Utc::now()`). The future bar used to score the outcome is read by the engine directly from `series[i + horizon_bars]` — the engine may see the future for scoring; only `compute()` must not. This is the single windowing implementation the whole engine and the §10.3 replay harness share.

**Files:**
- Create: `rust-core/crates/backtest/src/frontier.rs`
- Modify: `rust-core/crates/backtest/src/lib.rs`
- Test: `rust-core/crates/backtest/tests/anti_lookahead_test.rs`

**Interfaces:**
- Produces: `backtest::frontier::context_at(series: &[storage::Candle], frontier_index: usize, symbol: &str, timeframe: algo_core::Timeframe, horizon: algo_core::Horizon) -> algo_core::MarketContext` — builds a `MarketContext` whose `closes` are exactly `series[0..=frontier_index]`'s closes and whose `as_of` is `series[frontier_index].ts` as UTC. Task 10's engine calls this.

- [ ] **Step 1: Write the failing test**

`rust-core/crates/backtest/tests/anti_lookahead_test.rs`:
```rust
use algo_core::{Algorithm, AlgoOutput, Direction, Horizon, MarketContext, Timeframe};
use backtest::frontier::context_at;
use chrono::DateTime;
use std::sync::{Arc, Mutex};
use storage::Candle;

fn series(closes: &[f64]) -> Vec<Candle> {
    let base = 1_700_000_000;
    closes
        .iter()
        .enumerate()
        .map(|(i, &c)| Candle { ts: base + i as i64 * 86_400, open: c, high: c, low: c, close: c, volume: 0 })
        .collect()
}

#[test]
fn context_at_reveals_only_up_to_the_frontier() {
    let s = series(&[10.0, 11.0, 12.0, 13.0, 14.0]);
    let ctx = context_at(&s, 2, "NSE:TEST", Timeframe::Day, Horizon::Positional);

    assert_eq!(ctx.closes, vec![10.0, 11.0, 12.0]); // never 13.0/14.0
    assert_eq!(ctx.as_of, DateTime::from_timestamp(s[2].ts, 0).unwrap());
    assert_eq!(ctx.symbol, "NSE:TEST");
}

/// A spy algorithm asserting the anti-lookahead invariant across a full manual
/// walk: it must never observe a future bar. If windowing ever leaked bar i+1
/// (or the whole series) into an earlier decision, the poison value would appear
/// and this test would FAIL.
struct Spy {
    max_len: Arc<Mutex<usize>>,
    saw_poison: Arc<Mutex<bool>>,
}
impl Algorithm for Spy {
    fn id(&self) -> &'static str { "spy" }
    fn required_lookback(&self) -> usize { 1 }
    fn applicable_horizons(&self) -> &'static [Horizon] { &[Horizon::Positional] }
    fn compute(&self, ctx: &MarketContext) -> AlgoOutput {
        let mut m = self.max_len.lock().unwrap();
        *m = (*m).max(ctx.closes.len());
        if ctx.closes.iter().any(|&c| c == 999_999.0) {
            *self.saw_poison.lock().unwrap() = true;
        }
        AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction: Direction::Neutral,
            magnitude: 0.0,
            confidence: 0.0,
            evidence: vec![],
            computed_at: ctx.as_of,
        }
    }
}

#[test]
fn frontier_walk_never_leaks_a_future_bar_into_compute() {
    // Last bar is a poison spike; horizon 1 means the last decision frontier is
    // index len-2, so the poison bar (index len-1) is never visible to compute().
    let s = series(&[10.0, 11.0, 12.0, 13.0, 14.0, 999_999.0]);
    let horizon_bars = 1;
    let spy = Spy { max_len: Arc::new(Mutex::new(0)), saw_poison: Arc::new(Mutex::new(false)) };

    for i in 0..s.len() {
        if i + horizon_bars >= s.len() {
            break;
        }
        let ctx = context_at(&s, i, "NSE:TEST", Timeframe::Day, Horizon::Positional);
        let _ = spy.compute(&ctx);
    }

    assert!(!*spy.saw_poison.lock().unwrap(), "future poison bar leaked into a decision");
    assert_eq!(*spy.max_len.lock().unwrap(), 5, "max visible window is [0..=4], never the poison bar");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rust-core && cargo test -p backtest anti_lookahead_test`
Expected: FAIL — `backtest::frontier` does not exist.

- [ ] **Step 3: Implement the windowing**

`rust-core/crates/backtest/src/frontier.rs`:
```rust
use algo_core::{Horizon, MarketContext, Timeframe};
use chrono::DateTime;
use storage::Candle;

/// Build the `MarketContext` visible at frontier index `i`: exactly the closes of
/// `series[0..=i]`, with `as_of` set to bar i's timestamp as absolute UTC — never
/// the wall clock, never a future bar (anti-lookahead, design §6.4).
pub fn context_at(
    series: &[Candle],
    frontier_index: usize,
    symbol: &str,
    timeframe: Timeframe,
    horizon: Horizon,
) -> MarketContext {
    let closes = series[..=frontier_index].iter().map(|c| c.close).collect();
    let as_of = DateTime::from_timestamp(series[frontier_index].ts, 0)
        .expect("candle ts is a valid Unix epoch");
    MarketContext { symbol: symbol.to_string(), timeframe, horizon, closes, as_of }
}
```

`rust-core/crates/backtest/src/lib.rs`:
```rust
pub mod frontier;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd rust-core && cargo test -p backtest anti_lookahead_test`
Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add rust-core/crates/backtest/
git commit -m "feat(backtest): frontier windowing with anti-lookahead guarantee"
```

---

### Task 10: Replay engine — per-algorithm hit-rate and expectancy

**Depends on:** Task 9 (`context_at`). **Parallel-safe: no** (Task 11 edits the same `engine.rs`; runs after).

**Design note:** `run_replay` reuses Phase 1 unchanged — it takes `algos: &[Box<dyn Algorithm>]` (the CLI passes `registry::all()`; tests pass a deterministic probe) and routes every call through `algo_core::registry::run_applicable` (Task 2's shared gate). Accumulation is **sequential** (not `rayon`) so floating-point expectancy sums are deterministic. Scoring: for each directional output (`Bullish`/`Bearish`; `Neutral` makes no claim and is excluded from both numerator and denominator), `signed_return = dir_sign * (future_close - current_close) / current_close`; a **hit** is `signed_return > 0.0`. `hit_rate = hits / directional_calls`; `expectancy = mean(signed_return)`.

**Files:**
- Create: `rust-core/crates/backtest/src/engine.rs`
- Modify: `rust-core/crates/backtest/src/lib.rs`
- Test: `rust-core/crates/backtest/tests/replay_math_test.rs`

**Interfaces:**
- Produces: `backtest::engine::{run_replay, ReplayReport, AlgoStats}`. `run_replay(series: &[storage::Candle], algos: &[Box<dyn algo_core::Algorithm>], horizon_bars: usize, symbol: &str, timeframe: algo_core::Timeframe) -> ReplayReport`. `AlgoStats { pub algo_id: String, pub directional_calls: usize, pub hits: usize, pub sum_signed_return: f64 }` with `hit_rate()`/`expectancy()`. `ReplayReport { pub per_algo: Vec<AlgoStats> }` with `stat(&self, algo_id: &str) -> Option<&AlgoStats>`. Task 11 adds `hit_rate_weights()`; Task 12's CLI calls `run_replay`.

- [ ] **Step 1: Write the failing test (hand-derived hit-rate and expectancy)**

`rust-core/crates/backtest/tests/replay_math_test.rs`:
```rust
use algo_core::{Algorithm, AlgoOutput, Direction, Horizon, MarketContext, Timeframe};
use backtest::engine::run_replay;
use storage::Candle;

/// Bullish if the last close rose vs the prior close, Bearish if it fell.
/// required_lookback = 2 so it is skipped at frontier 0 (only 1 close visible).
struct LastDiffProbe;
impl Algorithm for LastDiffProbe {
    fn id(&self) -> &'static str { "last_diff_probe" }
    fn required_lookback(&self) -> usize { 2 }
    fn applicable_horizons(&self) -> &'static [Horizon] { &[Horizon::Positional] }
    fn compute(&self, ctx: &MarketContext) -> AlgoOutput {
        let n = ctx.closes.len();
        let direction = if ctx.closes[n - 1] > ctx.closes[n - 2] { Direction::Bullish } else { Direction::Bearish };
        AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude: 0.0,
            confidence: 0.0,
            evidence: vec![],
            computed_at: ctx.as_of,
        }
    }
}

fn series(closes: &[f64]) -> Vec<Candle> {
    let base = 1_700_000_000;
    closes
        .iter()
        .enumerate()
        .map(|(i, &c)| Candle { ts: base + i as i64 * 86_400, open: c, high: c, low: c, close: c, volume: 0 })
        .collect()
}

#[test]
fn probe_hit_rate_and_expectancy_match_hand_derivation() {
    // closes:   c0=10 c1=11 c2=10 c3=12 c4=13 c5=11, horizon_bars=1.
    // Decision frontiers (need >=2 closes AND a bar at i+1): i = 1,2,3,4.
    //   i=1 diff c1-c0=+1 -> Bullish; future c2=10 vs c1=11 -> down  -> MISS; ret=+1*(10-11)/11 = -1/11
    //   i=2 diff c2-c1=-1 -> Bearish; future c3=12 vs c2=10 -> up    -> MISS; ret=-1*(12-10)/10 = -1/5
    //   i=3 diff c3-c2=+2 -> Bullish; future c4=13 vs c3=12 -> up    -> HIT ; ret=+1*(13-12)/12 = +1/12
    //   i=4 diff c4-c3=+1 -> Bullish; future c5=11 vs c4=13 -> down  -> MISS; ret=+1*(11-13)/13 = -2/13
    // hits=1, directional_calls=4 -> hit_rate = 0.25
    // sum = -1/11 - 1/5 + 1/12 - 2/13 = -3101/8580 ; expectancy = sum/4 = -3101/34320 = -0.0903555...
    let s = series(&[10.0, 11.0, 10.0, 12.0, 13.0, 11.0]);
    let algos: Vec<Box<dyn Algorithm>> = vec![Box::new(LastDiffProbe)];

    let report = run_replay(&s, &algos, 1, "NSE:TEST", Timeframe::Day);
    let stat = report.stat("last_diff_probe").unwrap();

    assert_eq!(stat.directional_calls, 4);
    assert_eq!(stat.hits, 1);
    assert!((stat.hit_rate() - 0.25).abs() < 1e-12);
    assert!((stat.expectancy() - (-0.090_355_5)).abs() < 1e-5);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rust-core && cargo test -p backtest replay_math_test`
Expected: FAIL — `backtest::engine` does not exist.

- [ ] **Step 3: Implement the engine**

`rust-core/crates/backtest/src/engine.rs`:
```rust
use crate::frontier::context_at;
use algo_core::{registry::run_applicable, Algorithm, Direction, Horizon, Timeframe};
use std::collections::BTreeMap;
use storage::Candle;

#[derive(Debug, Clone)]
pub struct AlgoStats {
    pub algo_id: String,
    pub directional_calls: usize,
    pub hits: usize,
    pub sum_signed_return: f64,
}

impl AlgoStats {
    pub fn hit_rate(&self) -> f64 {
        if self.directional_calls == 0 { 0.0 } else { self.hits as f64 / self.directional_calls as f64 }
    }
    pub fn expectancy(&self) -> f64 {
        if self.directional_calls == 0 { 0.0 } else { self.sum_signed_return / self.directional_calls as f64 }
    }
}

#[derive(Debug, Clone)]
pub struct ReplayReport {
    pub per_algo: Vec<AlgoStats>,
}

impl ReplayReport {
    pub fn stat(&self, algo_id: &str) -> Option<&AlgoStats> {
        self.per_algo.iter().find(|s| s.algo_id == algo_id)
    }
}

/// Walk `series` forward one bar at a time. At each frontier i (that has a future
/// bar at i + horizon_bars), reveal only series[0..=i] to compute() via the shared
/// run_applicable gate, then score each directional output against the realized
/// move to series[i + horizon_bars]. Reuses registry algorithms unchanged.
pub fn run_replay(
    series: &[Candle],
    algos: &[Box<dyn Algorithm>],
    horizon_bars: usize,
    symbol: &str,
    timeframe: Timeframe,
) -> ReplayReport {
    let mut stats: BTreeMap<String, AlgoStats> = BTreeMap::new();

    for i in 0..series.len() {
        if i + horizon_bars >= series.len() {
            break;
        }
        let ctx = context_at(series, i, symbol, timeframe, Horizon::Positional);
        let outputs = run_applicable(algos, &ctx);

        let current = series[i].close;
        let future = series[i + horizon_bars].close;
        for output in outputs {
            let sign = match output.direction {
                Direction::Bullish => 1.0,
                Direction::Bearish => -1.0,
                Direction::Neutral => continue,
            };
            let signed_return = sign * (future - current) / current;
            let entry = stats.entry(output.algo_id.to_string()).or_insert_with(|| AlgoStats {
                algo_id: output.algo_id.to_string(),
                directional_calls: 0,
                hits: 0,
                sum_signed_return: 0.0,
            });
            entry.directional_calls += 1;
            if signed_return > 0.0 {
                entry.hits += 1;
            }
            entry.sum_signed_return += signed_return;
        }
    }

    ReplayReport { per_algo: stats.into_values().collect() }
}
```

Update `rust-core/crates/backtest/src/lib.rs`:
```rust
pub mod engine;
pub mod frontier;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd rust-core && cargo test -p backtest replay_math_test`
Expected: `probe_hit_rate_and_expectancy_match_hand_derivation ... ok`

- [ ] **Step 5: Commit**

```bash
git add rust-core/crates/backtest/
git commit -m "feat(backtest): frontier-gated replay engine with hit-rate/expectancy"
```

---

### Task 11: Confluence-weight bridge

**Depends on:** Task 10 (edits `engine.rs`). **Parallel-safe: yes** with Task 8 in Wave D.

**Design note (design §6.3/§6.4):** the per-algorithm hit-rate is exactly the number that will replace `compute_confluence`'s equal-weight placeholder. This task delivers the **type-level bridge** now — `ReplayReport::hit_rate_weights()` produces the `HashMap<String, f64>` shape, and the test proves it feeds `compute_confluence` and changes the weighted vote. The **actual re-weighting in production** (persisting weights and swapping them into the sidecar handler's currently-empty `weights` map) lands in the catalog phase; this task nails the contract so that wiring is mechanical. `compute_confluence` takes `&HashMap<&str, f64>`, so callers borrow from the owned map: `let owned = report.hit_rate_weights(); let w: HashMap<&str, f64> = owned.iter().map(|(k, v)| (k.as_str(), *v)).collect();`.

**Files:**
- Modify: `rust-core/crates/backtest/src/engine.rs`
- Modify: `rust-core/crates/backtest/Cargo.toml` (add `algo-core` already present; no new dep)
- Test: `rust-core/crates/backtest/tests/confluence_bridge_test.rs`

**Interfaces:**
- Produces: `ReplayReport::hit_rate_weights(&self) -> std::collections::HashMap<String, f64>` (`algo_id -> hit_rate`).

- [ ] **Step 1: Write the failing test**

`rust-core/crates/backtest/tests/confluence_bridge_test.rs`:
```rust
use algo_core::confluence::compute_confluence;
use algo_core::{AlgoOutput, Direction, Horizon, Timeframe};
use backtest::engine::{AlgoStats, ReplayReport};
use chrono::Utc;
use std::collections::HashMap;

fn output(algo_id: &'static str, direction: Direction) -> AlgoOutput {
    AlgoOutput {
        algo_id,
        symbol: "NSE:TEST".to_string(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        direction,
        magnitude: 1.0,
        confidence: 1.0,
        evidence: vec![],
        computed_at: Utc::now(),
    }
}

#[test]
fn hit_rate_weights_feed_compute_confluence() {
    // "a" hit-rate 0.8, "b" hit-rate 0.4.
    let report = ReplayReport {
        per_algo: vec![
            AlgoStats { algo_id: "a".to_string(), directional_calls: 5, hits: 4, sum_signed_return: 0.0 },
            AlgoStats { algo_id: "b".to_string(), directional_calls: 5, hits: 2, sum_signed_return: 0.0 },
        ],
    };
    let owned = report.hit_rate_weights();
    assert!((owned["a"] - 0.8).abs() < 1e-12);
    assert!((owned["b"] - 0.4).abs() < 1e-12);

    let weights: HashMap<&str, f64> = owned.iter().map(|(k, v)| (k.as_str(), *v)).collect();
    let outputs = vec![output("a", Direction::Bullish), output("b", Direction::Bearish)];
    let scorecard = compute_confluence(&outputs, &weights);

    // weight_total = 0.8 + 0.4 = 1.2; weighted_sum = +0.8 - 0.4 = 0.4; vote = 0.4/1.2 = 1/3
    assert_eq!(scorecard.bullish_count, 1);
    assert_eq!(scorecard.bearish_count, 1);
    assert!((scorecard.weighted_vote - (1.0 / 3.0)).abs() < 1e-12);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rust-core && cargo test -p backtest confluence_bridge_test`
Expected: FAIL — `hit_rate_weights` does not exist.

- [ ] **Step 3: Implement the bridge**

Add to `impl ReplayReport` in `rust-core/crates/backtest/src/engine.rs` (and add `use std::collections::HashMap;` at the top alongside `BTreeMap`):
```rust
    /// Per-algorithm hit-rate as the weight map `compute_confluence` accepts. In
    /// the catalog phase these replace the sidecar handler's equal-weight
    /// placeholder (design §6.3); here they prove the type-level bridge.
    pub fn hit_rate_weights(&self) -> HashMap<String, f64> {
        self.per_algo.iter().map(|s| (s.algo_id.clone(), s.hit_rate())).collect()
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd rust-core && cargo test -p backtest confluence_bridge_test`
Expected: `hit_rate_weights_feed_compute_confluence ... ok`

- [ ] **Step 5: Commit**

```bash
git add rust-core/crates/backtest/
git commit -m "feat(backtest): hit-rate -> confluence weight bridge"
```

---

### Task 12: CLI replay binary — end-to-end foundation deliverable

**Depends on:** Task 8 (importer, for `--ingest-dir`), Task 10/11 (engine). **Parallel-safe: no** (final wiring; runs after its deps).

**Design note:** this is the roadmap's Phase 2 Definition of Done — "a CLI-invokable command runs a walk-forward replay over real bhavcopy-sourced history for a real NSE symbol and produces a hit-rate report per algorithm." The automated test pre-populates the lake with a synthetic multi-bar series and drives the binary end-to-end (read lake → replay with `registry::all()` → print report). The **real** bhavcopy run is the manual DoD check (fetch a month of NSE bhavcopy via Task 8's `#[ignore]`d fetch, then `replay --ingest-dir ...`). A minimal hand-rolled arg parser avoids a `clap` dependency.

**Files:**
- Modify: `rust-core/crates/backtest/Cargo.toml` (add `ingestion`; `storage`/`algo-core`/`chrono` already present)
- Modify: `rust-core/crates/backtest/src/bin/replay.rs`
- Test: `rust-core/crates/backtest/tests/cli_e2e_test.rs`

**Interfaces:**
- Produces: the `replay` binary. Usage: `replay --lake <dir> --symbol <NSE:SYM> --timeframe day|minute --source <src> --horizon <N> [--ingest-dir <dir-of-bhavcopy-csvs>]`. Prints one tab-separated line per algorithm: `algo_id<TAB>hit_rate<TAB>expectancy<TAB>directional_calls`.

- [ ] **Step 1: Add dependencies**

Add to `rust-core/crates/backtest/Cargo.toml` under `[dependencies]`:
```toml
ingestion = { path = "../ingestion" }
```

- [ ] **Step 2: Write the failing test**

`rust-core/crates/backtest/tests/cli_e2e_test.rs`:
```rust
use std::process::Command;
use storage::{Candle, CandleStore};
use tempfile::tempdir;

#[test]
fn replay_binary_reads_lake_and_prints_per_algorithm_report() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();

    // 25 rising daily candles: enough history for sma(20)/ema(20)/rsi(14).
    let base = 1_700_000_000;
    let candles: Vec<Candle> = (0..25)
        .map(|i| {
            let c = 100.0 + i as f64;
            Candle { ts: base + i as i64 * 86_400, open: c, high: c, low: c, close: c, volume: 1000 }
        })
        .collect();
    store.write_sourced_candles("NSE:INFY", "day", "bhavcopy", &candles).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_replay"))
        .args([
            "--lake", dir.path().to_str().unwrap(),
            "--symbol", "NSE:INFY",
            "--timeframe", "day",
            "--source", "bhavcopy",
            "--horizon", "1",
        ])
        .output()
        .expect("replay binary must run");

    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("sma"), "report missing sma: {stdout}");
    assert!(stdout.contains("ema"), "report missing ema: {stdout}");
    assert!(stdout.contains("rsi"), "report missing rsi: {stdout}");
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd rust-core && cargo test -p backtest cli_e2e_test`
Expected: FAIL — the placeholder binary prints `"replay placeholder"` and exits.

- [ ] **Step 4: Implement the CLI**

`rust-core/crates/backtest/src/bin/replay.rs`:
```rust
use algo_core::{registry, Timeframe};
use backtest::engine::run_replay;
use ingestion::importer::import_bhavcopy_files;
use std::collections::HashMap;
use std::path::PathBuf;
use storage::CandleStore;

fn arg(map: &HashMap<String, String>, key: &str) -> String {
    map.get(key).unwrap_or_else(|| panic!("missing required --{key}")).clone()
}

fn parse_args() -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        if let Some(key) = flag.strip_prefix("--") {
            let value = args.next().unwrap_or_else(|| panic!("--{key} needs a value"));
            map.insert(key.to_string(), value);
        }
    }
    map
}

fn main() {
    let args = parse_args();
    let lake = PathBuf::from(arg(&args, "lake"));
    let symbol = arg(&args, "symbol");
    let timeframe_str = arg(&args, "timeframe");
    let source = arg(&args, "source");
    let horizon: usize = arg(&args, "horizon").parse().expect("--horizon must be an integer");

    let store = CandleStore::open(&lake).expect("open candle lake");

    if let Some(ingest_dir) = args.get("ingest-dir") {
        let mut files = Vec::new();
        for entry in std::fs::read_dir(ingest_dir).expect("read ingest dir") {
            let path = entry.expect("dir entry").path();
            if path.is_file() {
                files.push(std::fs::read(&path).expect("read bhavcopy file"));
            }
        }
        let n = import_bhavcopy_files(&store, "NSE", &files).expect("import bhavcopy");
        eprintln!("ingested {n} candles from {ingest_dir}");
    }

    let timeframe = match timeframe_str.as_str() {
        "minute" => Timeframe::Minute,
        "5minute" => Timeframe::FiveMinute,
        "15minute" => Timeframe::FifteenMinute,
        _ => Timeframe::Day,
    };

    let series = store
        .read_sourced_candles(&symbol, &timeframe_str, &source)
        .expect("read candles");
    if series.is_empty() {
        eprintln!("no candles for {symbol} {timeframe_str} source={source}");
        return;
    }

    let algos = registry::all();
    let report = run_replay(&series, &algos, horizon, &symbol, timeframe);

    for stat in &report.per_algo {
        println!(
            "{}\t{:.4}\t{:.6}\t{}",
            stat.algo_id,
            stat.hit_rate(),
            stat.expectancy(),
            stat.directional_calls
        );
    }
    if report.per_algo.is_empty() {
        eprintln!("no directional calls (insufficient history for any algorithm)");
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd rust-core && cargo test -p backtest cli_e2e_test`
Expected: `replay_binary_reads_lake_and_prints_per_algorithm_report ... ok`

- [ ] **Step 6: Commit**

```bash
git add rust-core/crates/backtest/
git commit -m "feat(backtest): replay CLI binary (lake -> walk-forward -> per-algo report)"
```

---

### Task 13: Kronos ONNX-export SPIKE (exploratory — GO/NO-GO, not TDD)

**Depends on:** none. **Parallel-safe: yes** — runs independently in Wave A and **does not block Tasks 1-12.** Its outcome informs the *later catalog plan* (whether Kronos is built into the Rust sidecar via `ort` or via a Python fallback sidecar), not this foundation.

**This is a spike, not a normal task.** There is no RED/GREEN cycle and no product code is committed by it. It produces **one artifact: a written go/no-go finding.** The "definition of done" is the finding itself, not a passing assertion against a pre-known value. The fallback is already decided (design §6.2/§14): a NO-GO is a legitimate, planned outcome, not a failure.

**Goal:** determine whether Kronos (`github.com/shiyu-coder/Kronos`; open mini/small checkpoints under the HuggingFace org `NeoQuasar`) can be exported to ONNX and run via Rust's `ort` crate, producing output matching the reference Python inference within tolerance.

**Files:**
- Create: `docs/superpowers/spikes/2026-07-19-kronos-onnx-feasibility.md` (findings doc)
- Scratch only (NOT committed to `rust-core/`): a throwaway Python venv + a throwaway Rust `ort` probe under the scratchpad dir.

**Exploration steps (timebox ~1-2 days):**

- [ ] **Step 1: Reference inference.** In a scratch Python venv, clone Kronos, download a `NeoQuasar` mini or small checkpoint, and run the repo's reference inference on one fixed sample OHLCV window (e.g. 512 bars of a committed intraday fixture). Record the exact forecast output vector as the reference. Note the BSQ tokenizer's quantization step (design §6.2 flags it must be reimplemented as plain Rust math, or handled in pre/post-processing).

- [ ] **Step 2: Export attempt.** Attempt `torch.onnx.export` (or `optimum`/`transformers.onnx`) on the transformer core. Record: which opset works, any unsupported-operator errors, whether the tokenizer/quantization stays inside the graph or must be lifted out. Save the `.onnx` to scratch.

- [ ] **Step 3: Load via `ort`.** In a throwaway Rust probe using the `ort` crate, load the exported `.onnx`, feed the same sample window (applying the Rust-side tokenizer/quantization if lifted out), and run inference.

- [ ] **Step 4: Compare.** Compare the `ort` output to the Step 1 Python reference element-wise. Record max absolute and max relative error. Tolerance target: max relative error `< 1e-3` on the forecast vector.

- [ ] **Step 5: Write the finding.** Write `docs/superpowers/spikes/2026-07-19-kronos-onnx-feasibility.md` with:
  - **Verdict: GO or NO-GO.**
  - **GO** → export path works within tolerance; the catalog plan builds Kronos into the Rust sidecar as one more `Algorithm` via `ort` (deterministic-forecast-as-`AlgoOutput`, design §6.2). Document the working opset, the tokenizer/quantization split (in-graph vs Rust-side), and the measured error.
  - **NO-GO** → export blocked (unsupported ops, tokenizer can't be reproduced, or tolerance failure). The catalog plan instead runs a small supervised Python/FastAPI sidecar speaking the **same JSON-over-stdio protocol** as the Rust sidecar (design §6.2/§14 — "same architecture shape, one more child process, not a redesign"). Document the specific blocker so the fallback plan is precise.
  - Either way: the sample window used, the reference output, the measured errors, and the exact checkpoint/opset/crate versions, so the finding is reproducible.

- [ ] **Step 6: Commit the finding doc only**

```bash
git add docs/superpowers/spikes/2026-07-19-kronos-onnx-feasibility.md
git commit -m "docs: Kronos ONNX-export feasibility spike finding (go/no-go)"
```

---

### Task 14: Workspace completion checkpoint

**Depends on:** Tasks 1-12 (and Task 13's doc committed). **Parallel-safe: no** (final verification).

**Files:** none created; runs and verifies.

- [ ] **Step 1: Full workspace test suite**

Run: `cd rust-core && cargo test --workspace`
Expected: every test passes — Phase 1's suite plus this phase's `algo-core` (`run_applicable`), `storage` (empty-read, open-error, sourced append-merge), `ingestion` (bhavcopy/indices/intraday parsers, importer), and `backtest` (anti-lookahead, replay math, confluence bridge, CLI e2e). The `fetch_real_nse_bhavcopy_smoke` test is reported as `ignored`, not failed.

- [ ] **Step 2: Release build succeeds (including the replay binary)**

Run: `cd rust-core && cargo build --release`
Expected: `Finished` with no errors; `target/release/sidecar` and `target/release/replay` both produced.

- [ ] **Step 3: No clippy drift**

Run: `cd rust-core && cargo clippy --workspace --all-targets`
Expected: no warnings. Fix any that appear (unused imports, dead helpers) before proceeding.

- [ ] **Step 4: Commit** (only if Step 3 required fixes)

```bash
git add rust-core/
git commit -m "chore: clean up clippy warnings after Phase 2 foundation"
```

---

## Phase 2 Foundation Definition of Done

- `cd rust-core && cargo test --workspace` passes with zero failures; the only ignored test is the network bhavcopy smoke test.
- **Storage carry-forward fixes are in:** `read_candles`/`read_sourced_candles` return an empty `Vec` (not a DuckDB error) for a never-written partition; `CandleStore::open` propagates a `create_dir_all` failure as `Err(StorageError::Io(_))` instead of panicking; both proven by tests.
- **`compute()` totality is nailed down:** the insufficient-history precondition is documented on the `Algorithm::compute` trait method and enforced in exactly one shared `registry::run_applicable()` gate that both the sidecar handler and the backtest engine route through — no caller re-implements the check, and no synthetic `Neutral` outputs pollute the confluence scorecard.
- **Public-data ingestion works, pure/I-O split:** pure parsers (`parse_udiff_equity_bhavcopy` for NSE+BSE, `parse_nse_indices_close` with volume=0, `parse_intraday_ohlcv` offset-aware +0530) are unit-tested against tiny committed fixtures with exact hand-derived timestamps and no network; the thin `reqwest`/`rustls` fetch layer sends the mandatory `User-Agent` and is exercised only by an `#[ignore]`d manual test. Imported candles land in the Phase 1 lake tagged `source` (`bhavcopy`/`kaggle`/`github_archive`), append-merged idempotently.
- **The frontier-gated replay engine works and is correct:** `run_replay` reuses `registry::all()` and `compute_confluence` unchanged, enforces anti-lookahead through one shared windowing function (a test that would FAIL if a future bar leaked passes), and produces per-algorithm hit-rate/expectancy that matches an independent hand derivation (probe: hit-rate 0.25, expectancy ≈ -0.0903555). The hit-rate → confluence-weight bridge is proven, ready for the catalog phase to swap in for the equal-weight placeholder.
- **End-to-end, no Electron/Kite/Claude/network:** the `replay` CLI reads a bhavcopy-sourced series from the lake for a real NSE symbol and prints a per-algorithm hit-rate report (proven by the CLI e2e test on synthetic history; the real-data run is the manual check via the `#[ignore]`d fetch).
- **Kronos spike resolved:** `docs/superpowers/spikes/2026-07-19-kronos-onnx-feasibility.md` records a GO or NO-GO with reproducible evidence, sequenced to inform the later catalog plan without having blocked any foundation task.
- Nothing in this phase touches Kite, Claude, Electron, or any order path — by construction (design §2/§3/§4).

This is the point at which the **TA-indicator catalog plan** (deferred, separate) has a working replay engine to score each new indicator against, and a proven pattern (Phase 1's `inventory::submit!` + hand-verified reference value) to add them one at a time in parallel.
