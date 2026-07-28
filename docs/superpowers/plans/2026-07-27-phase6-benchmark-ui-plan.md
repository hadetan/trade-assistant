# Phase 6 — Benchmark UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated **Benchmark** screen — a candlestick+volume chart with correct/incorrect/neutral markers over a real historical price series, an instrument+range+cadence setup, a thin summary strip, a click/hover detail popover, and a copy-raw-result button. It is a UI layer over Phase 2's replay mechanism, not a second benchmarking engine: a TypeScript orchestrator (`benchmarkRunner.ts`) walks lake-resident historical candles frontier-by-frontier, runs the existing deterministic pipeline at each frontier via a new benchmark-only sidecar handler (full OHLCV through `backtest::frontier::context_at`), and classifies each verdict's direction against the realized future move. A prerequisite `ingest` CLI populates the Parquet lake first, and a small append-only lake manifest makes `CandleStore::list_symbols` faithful (the on-disk partition filenames are lossy). Engine-Only only — no AI-Assisted benchmark mode, no response-mode picker. Zero order-related surface; the Benchmark UI never even contacts live Kite.

**Architecture:** Rust gains: a runnable `ingest` bin wiring the already-implemented `fetch_udiff_bhavcopy`/`import_bhavcopy_files`/`import_intraday_files` (no new parse logic); an append-only `lake_manifest.jsonl` + `CandleStore::list_symbols` (the sanitized `{s}_{t}_{src}.parquet` filenames are irreversible, so identity is recorded at write time); a pure `algo_core::benchmark_classify::classify_decision` (canonical, unit-tested, not sidecar-routed); four new panic-isolated sidecar request variants (`ListLakeSymbols`, `ReadLakeCandles`, `BenchmarkCompute`, `EvaluateScanGateStateless`) with three new response variants (`LakeSymbols`, `LakeCandles`, `BenchmarkCompute`) — the fourth reuses the existing `ScanGate` response — and the sidecar crate takes a `backtest` dependency for `context_at`. TypeScript gains: the wire mirror + four `SidecarSupervisor` methods; a DI'd one-shot `runBenchmark(deps, params)` async function (mirrors `scanScheduler.ts`'s injection discipline, not its class shape) with a TS mirror of the classification rule and the horizon/cadence/lookahead helpers; a `benchmarkBridge.ts` (three IPC channels) plus `RendererApi`/`buildRendererApi` extensions; a `BenchmarkView.tsx` main-window screen and a thin `benchmarkChart.ts` wrapper over `lightweight-charts` (new npm dep). `bootstrap.ts` registers the bridge once at `createApp()`'s top level. No history writes, no live `Compute`/`from_closes` change, no `run_replay` change, no CSP weakening.

**Tech Stack:** Rust (`rusqlite`/`duckdb` bundled, `serde`/`serde_json`, `chrono`, `reqwest` rustls-only for the CLI's existing fetch path, `cargo test`); TypeScript, Electron 33 (`contextIsolation`/`sandbox` on, `clipboard` main-process-only — a new value import, mocked in tests), React 18 + `@testing-library/react` + jsdom, Vitest, `lightweight-charts` `^5.0.0` (Apache-2.0, offline, no CSP exception), electron-vite (`main`/`preload`/`renderer` targets, unchanged shape).

## Global Constraints

Every task's requirements implicitly include this section.

- **Hard safety invariant (non-negotiable, restated every phase):** the app NEVER places, modifies, cancels, or automates any order. This phase adds **zero** order-related surface: no Kite write-tool method, no new Claude tool grant, no code path reaching `place_order`/`modify_order`/`cancel_order`/`place_gtt_order`/`modify_gtt_order`/`delete_gtt_order`. The Benchmark UI reads historical candles from a local Parquet lake and runs deterministic compute over them; it never even contacts live Kite (P6§17). Any task whose diff could plausibly be read as expanding tool access must call that out explicitly (none here should).
- **Binding invariants (P6§18, verbatim):** (a) the live `Compute` handler and `MarketContext::from_closes` are NOT modified; (b) `run_replay`/`ReplayReport` (`backtest/src/engine.rs`) are NOT extended; (c) `generateDeterministicResponse` / `deterministicResponseGenerator.ts` are NOT modified (reused unchanged, once per decision point); (d) `EvaluateScanGateStateless` performs ZERO `StateStore`/`scan_snapshots` I/O; (e) `HistoryStore` and every chat/session surface are NOT touched; (f) the renderer CSP (`index.html`) is NOT weakened — `lightweight-charts` needs no exception; (g) IPC handlers are registered exactly once at `createApp()`'s top level (P5d bootstrap invariant); (h) no order-related surface is added.
- **Exact new file paths (P6§18):** `rust-core/crates/ingestion/src/bin/ingest.rs`; `rust-core/crates/storage/src/lake_manifest.rs`; `rust-core/crates/algo-core/src/benchmark_classify.rs`; `rust-core/crates/algo-core/tests/benchmark_classify_test.rs`; `electron-app/src/main/services/benchmark/benchmarkRunner.ts`; `electron-app/src/main/ipc/benchmarkBridge.ts`; `electron-app/src/renderer/BenchmarkView.tsx`; `electron-app/src/renderer/benchmarkChart.ts`; `electron-app/test/main/services/benchmark/benchmarkRunner.test.ts`; `electron-app/test/main/ipc/benchmarkBridge.test.ts`; `electron-app/test/renderer/BenchmarkView.test.tsx`.
- **Exact Rust struct field names (P6§18):** `LakePartitionKey { symbol: String, timeframe: String, source: String }`; `LakeSymbolEntry { symbol: String, timeframe: String, source: String, from_ts: i64, to_ts: i64, candle_count: usize }`; `LakeSymbolWire { symbol, timeframe, source, from_ts, to_ts, candle_count }`; `ReadLakeCandlesRequest { id: u64, symbol: String, timeframe: String, source: String }`; `BenchmarkComputeRequest { id: u64, symbol: String, timeframe: String, horizon: String, candles: Vec<CandleWire> }`; `EvaluateScanGateStatelessRequest { id: u64, prev: Option<ConfluenceWire>, curr: ConfluenceWire }`; `BenchmarkComputeResponse { id: u64, algo_results: Vec<AlgoResultWire>, confluence: ConfluenceWire }`; `Outcome::{Correct, Incorrect, Neutral}`.
- **Exact request/response wire tags (snake_case, P6§18):** requests `list_lake_symbols`, `read_lake_candles`, `benchmark_compute`, `evaluate_scan_gate_stateless`; responses `lake_symbols`, `lake_candles`, `benchmark_compute`; `evaluate_scan_gate_stateless` reuses the existing `scan_gate` response.
- **Exact TS type/field names (P6§18):** `LakeSymbolEntry { symbol, timeframe, source, fromTs, toTs, candleCount, horizon }` (camelCase app type); `BenchmarkCadence = { mode: "session_close" } | { mode: "stateless_gate" } | { mode: "manual"; everyN: number }`; `Outcome = "correct" | "incorrect" | "neutral"`; `DecisionPoint { frontierIndex, ts, closeAtFrontier, closeAtLookahead, realizedReturn, direction, conviction, responseText, algoResults, confluence, outcome }`; `BenchmarkRunParams { symbol, timeframe, source, horizon, cadence, lookaheadBars, fromTs, toTs }`; `BenchmarkResult { params, candles, decisionPoints }` (exactly three fields — no status/flag field).
- **Exact default constant values (P6§18):** Rust `algo_core::benchmark_classify::DEFAULT_NEUTRAL_BAND: f64 = 0.001`; TS `NEUTRAL_BAND = 0.001` (mirror); TS `DEFAULT_POSITIONAL_LOOKAHEAD_BARS = 5`, `DEFAULT_INTRADAY_LOOKAHEAD_BARS = 30`; horizon derivation `timeframe === "day" ? "positional" : "intraday"`; cadence default positional→`{ mode: "session_close" }`, intraday→`{ mode: "stateless_gate" }`; hit-rate `correct / (correct + incorrect)`, neutral excluded, `null` (shown `"—"` / `"0 decision points"`) when denominator is 0.
- **Exact IPC channel names (P6§18):** `benchmark:listLakeSymbols`, `benchmark:runBenchmark`, `benchmark:copyToClipboard`.
- **New dependencies (P6§18):** Rust `sidecar/Cargo.toml` gains `backtest = { path = "../backtest" }` (graph stays acyclic: `sidecar → backtest → {ingestion, storage, algo-core}`; transitively pulls `ingestion`'s `reqwest`/`zip` — accepted, locked decision 6). TS `electron-app/package.json` gains `"lightweight-charts": "^5.0.0"`.
- **Comments:** default to none. Only add one when the *why* isn't obvious (a hidden invariant, a workaround, a formula's source — e.g. the neutral-band derivation, the anti-lookahead note on `context_at`). Never restate the next line; never a numbered step block. (From `CLAUDE.md`.)
- **Naming:** Rust `snake_case` functions/vars, `PascalCase` types, one responsibility per file. TypeScript `camelCase` functions/vars, `PascalCase` types/classes/React components, no Hungarian notation, domain terms (`oi`/`pcr`/`ltp`/`ts`) fine. File names describe responsibility, not kind. Pure logic (`benchmark_classify.rs`, the runner's helpers) stays separate from I/O (the CLI, the sidecar handlers, the bridge).
- **Commit convention:** each task's implementer commits as the repo's own configured git user (`hadetan <aquibsyed83@gmail.com>`) via plain `git commit` — NEVER pass `--author`, NEVER add a `Co-Authored-By` trailer, NEVER use `--no-verify`. Conventional-commit subjects, matching the sibling plans.
- **Two toolchains, two test runners.** **Rust:** run from `rust-core/` — `cargo test -p <crate>` (per-crate) or `cargo test -p <crate> --test <file>` (single integration test file), `cargo test -p <crate> --lib` (inline `#[cfg(test)]` tests). Pure modules (`benchmark_classify.rs`) get pure unit tests; `candle_store`/`lake_manifest` get real `duckdb`/fs-backed tests; sidecar handler tests follow the existing inline `Compute`/`PersistCandles` pattern; the compiled-binary `end_to_end_test.rs` is the one place a real sidecar subprocess is spawned. **TypeScript:** run from `electron-app/` — `npx vitest run <path>` (per-file), `npm test` (full suite), `npm run typecheck` (`src/**` only). Benchmark TS code touches **no** `better-sqlite3` (no `HistoryStore`), so no `npm rebuild better-sqlite3` prefix is needed for the benchmark vitest files; the full `npm test` still rebuilds via its own `pretest`.
- No test performs a real live Kite OAuth/MCP call, a real `claude` subprocess, a real network fetch (the CLI's `fetch_udiff_bhavcopy` is exercised only manually, per `io.rs`'s existing `#[ignore]`d-smoke convention), a real timer, or a real `lightweight-charts`/`electron` runtime — everything is DI-faked or module-mocked via the established patterns.
- **Move quickly, don't cut corners.** Tasks are dependency-ordered; the three Rust building blocks (Tasks 1–3) are genuinely parallelizable. Speed comes from the plan being unambiguous, not from skipping TDD, exact code, or the self-review pass.

---

### Task 1: `ingest` CLI (ingestion)

The prerequisite: a runnable entrypoint over the already-implemented parse/import functions, mirroring `replay.rs`'s manual `--flag value` arg-parsing. No new parse/import logic, no new networking crate. Fully independent — depends on nothing else in this phase.

**Files:**
- Create: `rust-core/crates/ingestion/src/bin/ingest.rs`
- Create: `rust-core/crates/ingestion/tests/ingest_cli_test.rs`
- Modify: `rust-core/crates/ingestion/Cargo.toml`

**Interfaces:**
- Consumes: `ingestion::io::fetch_udiff_bhavcopy` (existing, network-touching, rustls-only), `ingestion::importer::{import_bhavcopy_files, import_intraday_files}` (existing), `storage::CandleStore` (existing), `chrono::NaiveDate`.
- Produces: a compiled `ingest` binary (`CARGO_BIN_EXE_ingest`) with two modes (`--mode bhavcopy`, `--mode intraday`); pure helpers `parse_args`/`arg`/`parse_date` (inline-unit-testable). No new public library API.

- [ ] **Step 1: Write the failing integration test** — create `rust-core/crates/ingestion/tests/ingest_cli_test.rs`:

```rust
use std::process::Command;
use storage::CandleStore;
use tempfile::tempdir;

const MINUTE: &[u8] = include_bytes!("fixtures/kaggle_banknifty_minute_sample.csv");

#[test]
fn intraday_mode_imports_csv_files_from_a_dir_into_the_lake_with_no_network() {
    let lake = tempdir().unwrap();
    let src = tempdir().unwrap();
    // The community-archive layout is one CSV per symbol; the CLI derives the
    // symbol from the filename stem, so a colon in the stem must survive.
    std::fs::write(src.path().join("NSE:BANKNIFTY.csv"), MINUTE).unwrap();

    let status = Command::new(env!("CARGO_BIN_EXE_ingest"))
        .args([
            "--lake",
            lake.path().to_str().unwrap(),
            "--mode",
            "intraday",
            "--source",
            "kaggle",
            "--dir",
            src.path().to_str().unwrap(),
        ])
        .status()
        .expect("ingest binary must start");
    assert!(status.success(), "ingest --mode intraday must exit 0");

    let store = CandleStore::open(lake.path()).unwrap();
    let bars = store.read_sourced_candles("NSE:BANKNIFTY", "minute", "kaggle").unwrap();
    assert_eq!(bars.len(), 3, "the three fixture minute bars must land under source=kaggle");
    // The write path also appended a manifest identity (Task 2 consumes it).
    assert!(lake.path().join("lake_manifest.jsonl").exists());
}

#[test]
fn missing_required_flag_exits_non_zero() {
    let status = Command::new(env!("CARGO_BIN_EXE_ingest"))
        .args(["--mode", "intraday"])
        .status()
        .expect("ingest binary must start");
    assert!(!status.success(), "a missing --lake must fail loudly, not default silently");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `rust-core/`): `cargo test -p ingestion --test ingest_cli_test`
Expected: FAIL to compile / link — there is no `ingest` binary target yet (`CARGO_BIN_EXE_ingest` unset).

- [ ] **Step 3: Declare the bin target** — in `rust-core/crates/ingestion/Cargo.toml`, add a `[[bin]]` section immediately after the `[package]` block (mirrors `backtest`'s explicit `replay` bin; the auto-discovered `src/lib.rs` library stays intact):

```toml
[[bin]]
name = "ingest"
path = "src/bin/ingest.rs"
```

- [ ] **Step 4: Implement `ingest.rs`** — create `rust-core/crates/ingestion/src/bin/ingest.rs`:

```rust
use chrono::{Datelike, NaiveDate, Weekday};
use ingestion::importer::{import_bhavcopy_files, import_intraday_files};
use ingestion::io::fetch_udiff_bhavcopy;
use std::collections::HashMap;
use std::error::Error;
use std::ffi::OsStr;
use std::path::PathBuf;
use storage::CandleStore;

const USAGE: &str = "usage: ingest --lake <dir> --mode bhavcopy --exchange <NSE|BSE> --from <YYYY-MM-DD> --to <YYYY-MM-DD>\n       ingest --lake <dir> --mode intraday --source <kaggle|github_archive> --dir <dir>";

fn arg(map: &HashMap<String, String>, key: &str) -> Result<String, Box<dyn Error>> {
    map.get(key).cloned().ok_or_else(|| format!("missing required --{key}\n{USAGE}").into())
}

fn parse_args() -> Result<HashMap<String, String>, Box<dyn Error>> {
    let mut map = HashMap::new();
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        if let Some(key) = flag.strip_prefix("--") {
            let value = args.next().ok_or_else(|| format!("--{key} needs a value\n{USAGE}"))?;
            map.insert(key.to_string(), value);
        }
    }
    Ok(map)
}

fn parse_date(s: &str) -> Result<NaiveDate, Box<dyn Error>> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|e| format!("bad date '{s}': {e}").into())
}

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

fn run_intraday(store: &CandleStore, args: &HashMap<String, String>) -> Result<(), Box<dyn Error>> {
    let source = arg(args, "source")?;
    let dir = arg(args, "dir")?;
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("cannot read --dir '{dir}': {e}"))? {
        let path = entry?.path();
        if path.is_file() && path.extension() == Some(OsStr::new("csv")) {
            let symbol = path
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or_else(|| format!("cannot derive a symbol from filename '{}'", path.display()))?
                .to_string();
            let bytes = std::fs::read(&path).map_err(|e| format!("cannot read '{}': {e}", path.display()))?;
            files.push((symbol, bytes));
        }
    }
    let n = import_intraday_files(store, &source, &files).map_err(|e| format!("intraday import failed: {e}"))?;
    eprintln!("ingested {n} candles from {dir} (source={source})");
    Ok(())
}

fn run() -> Result<(), Box<dyn Error>> {
    let args = parse_args()?;
    let lake = PathBuf::from(arg(&args, "lake")?);
    let store = CandleStore::open(&lake).map_err(|e| format!("cannot open --lake '{}': {e}", lake.display()))?;
    match arg(&args, "mode")?.as_str() {
        "bhavcopy" => run_bhavcopy(&store, &args),
        "intraday" => run_intraday(&store, &args),
        other => Err(format!("unrecognized --mode '{other}' (valid: bhavcopy, intraday)\n{USAGE}").into()),
    }
}

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

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

- [ ] **Step 5: Run the tests to verify they pass**

Run (from `rust-core/`): `cargo test -p ingestion --test ingest_cli_test && cargo test -p ingestion --bin ingest`
Expected: PASS — both integration tests and the inline `parse_date` test. Confirm the rest of the crate still passes: `cargo test -p ingestion`.

- [ ] **Step 6: Commit**

```bash
git add rust-core/crates/ingestion/src/bin/ingest.rs rust-core/crates/ingestion/tests/ingest_cli_test.rs rust-core/crates/ingestion/Cargo.toml
git commit -m "feat(ingestion): ingest CLI over bhavcopy/intraday import functions"
```

---

### Task 2: Lake manifest + `CandleStore::list_symbols` (storage)

The on-disk `{sanitize(symbol)}_{sanitize(timeframe)}_{sanitize(source)}.parquet` layout is lossy and irreversible, so `list_symbols` needs a non-lossy record written at ingest time. Add an append-only `lake_manifest.jsonl`, one guarded append in `write_sourced_candles`, and `list_symbols` computing per-partition bounds via a DuckDB aggregate. `storage` already depends on `serde`/`serde_json` and already has `StorageError::{Io, Json}`, so no new dependency and no new error variant. Fully independent — depends on nothing else in this phase.

**Files:**
- Create: `rust-core/crates/storage/src/lake_manifest.rs`
- Modify: `rust-core/crates/storage/src/candle_store.rs`
- Modify: `rust-core/crates/storage/src/lib.rs`
- Modify: `rust-core/crates/storage/tests/candle_store_test.rs`

**Interfaces:**
- Consumes: `serde`/`serde_json` (existing), `duckdb::Connection` (existing), `StorageError::{Io, Json}` (existing).
- Produces:
  - `pub struct LakePartitionKey { symbol: String, timeframe: String, source: String }` (derives `Debug, Clone, PartialEq, Eq, Serialize, Deserialize`), re-exported from `lib.rs`.
  - `lake_manifest::append_partition_key(root: &Path, key: &LakePartitionKey) -> Result<()>` and `lake_manifest::read_partition_keys(root: &Path) -> Result<Vec<LakePartitionKey>>` (dedups, missing file = empty).
  - `pub struct LakeSymbolEntry { symbol: String, timeframe: String, source: String, from_ts: i64, to_ts: i64, candle_count: usize }` (derives `Debug, Clone, PartialEq`), re-exported from `lib.rs`.
  - `CandleStore::list_symbols(&self) -> Result<Vec<LakeSymbolEntry>>` (sorted by `(symbol, timeframe, source)`), plus a private `partition_bounds`.
  - `write_sourced_candles` gains a guarded manifest append on first-creation only.

- [ ] **Step 1: Write the failing tests** — append to `rust-core/crates/storage/tests/candle_store_test.rs` (update the top `use` line to add `LakeSymbolEntry`):

Replace the first line `use storage::{Candle, CandleStore};` with:

```rust
use storage::{Candle, CandleStore, LakeSymbolEntry};
```

Append:

```rust
#[test]
fn list_symbols_on_an_empty_lake_returns_empty() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();
    assert_eq!(store.list_symbols().unwrap(), Vec::<LakeSymbolEntry>::new());
}

#[test]
fn list_symbols_groups_multi_source_multi_symbol_correctly() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();
    let c = |ts: i64| Candle { ts, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1 };

    store.write_sourced_candles("NSE:INFY", "day", "bhavcopy", &[c(100)]).unwrap();
    store.write_sourced_candles("NSE:TCS", "day", "bhavcopy", &[c(100)]).unwrap();
    store.write_sourced_candles("NSE:INFY", "minute", "kaggle", &[c(100)]).unwrap();

    let entries = store.list_symbols().unwrap();
    // Sorted by (symbol, timeframe, source); the "NSE:INFY" colon survives the
    // round trip, proving the manifest -- not the lossy filename -- drives identity.
    assert_eq!(entries.len(), 3);
    assert_eq!((entries[0].symbol.as_str(), entries[0].timeframe.as_str(), entries[0].source.as_str()), ("NSE:INFY", "day", "bhavcopy"));
    assert_eq!((entries[1].symbol.as_str(), entries[1].timeframe.as_str(), entries[1].source.as_str()), ("NSE:INFY", "minute", "kaggle"));
    assert_eq!((entries[2].symbol.as_str(), entries[2].timeframe.as_str(), entries[2].source.as_str()), ("NSE:TCS", "day", "bhavcopy"));
}

#[test]
fn list_symbols_reports_correct_ts_bounds_and_count() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();
    let c = |ts: i64| Candle { ts, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1 };
    store.write_sourced_candles("NSE:INFY", "day", "bhavcopy", &[c(100), c(200), c(300)]).unwrap();

    let entries = store.list_symbols().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].from_ts, 100);
    assert_eq!(entries[0].to_ts, 300);
    assert_eq!(entries[0].candle_count, 3);
}

#[test]
fn re_ingesting_the_same_partition_does_not_duplicate_its_manifest_entry() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();
    let c = |ts: i64| Candle { ts, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1 };

    store.write_sourced_candles("NSE:INFY", "day", "bhavcopy", &[c(100), c(200)]).unwrap();
    store.write_sourced_candles("NSE:INFY", "day", "bhavcopy", &[c(300)]).unwrap();

    let entries = store.list_symbols().unwrap();
    assert_eq!(entries.len(), 1, "re-ingesting the same partition appends its identity exactly once");
    assert_eq!(entries[0].candle_count, 3, "count reflects the merged total");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `rust-core/`): `cargo test -p storage --test candle_store_test`
Expected: FAIL to compile — `LakeSymbolEntry` and `list_symbols` do not exist.

- [ ] **Step 3: Implement the manifest** — create `rust-core/crates/storage/src/lake_manifest.rs`:

```rust
use crate::error::Result;
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LakePartitionKey {
    pub symbol: String,
    pub timeframe: String,
    pub source: String,
}

fn manifest_path(root: &Path) -> PathBuf {
    root.join("lake_manifest.jsonl")
}

pub fn append_partition_key(root: &Path, key: &LakePartitionKey) -> Result<()> {
    let line = serde_json::to_string(key)?;
    let mut file = OpenOptions::new().create(true).append(true).open(manifest_path(root))?;
    writeln!(file, "{line}")?;
    Ok(())
}

pub fn read_partition_keys(root: &Path) -> Result<Vec<LakePartitionKey>> {
    let path = manifest_path(root);
    // A missing manifest is an empty lake, not an error -- mirrors
    // read_partition's "never-written partition is empty" convention.
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = std::fs::read_to_string(&path)?;
    let mut keys: Vec<LakePartitionKey> = Vec::new();
    for line in contents.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let key: LakePartitionKey = serde_json::from_str(line)?;
        // Defend against any accidental duplicate line (append-only, so a bug or
        // a crash-retry could in principle repeat one).
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    Ok(keys)
}
```

- [ ] **Step 4: Wire `list_symbols` into `candle_store.rs`** — in `rust-core/crates/storage/src/candle_store.rs`:

Add the manifest import to the top `use` block (after `use crate::error::{Result, StorageError};`):

```rust
use crate::lake_manifest::{self, LakePartitionKey};
```

Add the `LakeSymbolEntry` type immediately after the `Candle` struct:

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct LakeSymbolEntry {
    pub symbol: String,
    pub timeframe: String,
    pub source: String,
    pub from_ts: i64,
    pub to_ts: i64,
    pub candle_count: usize,
}
```

Replace the `write_sourced_candles` method body with the guarded version (records identity only on first creation, keeping the hot path O(1)):

```rust
    pub fn write_sourced_candles(
        &self,
        symbol: &str,
        timeframe: &str,
        source: &str,
        candles: &[Candle],
    ) -> Result<()> {
        let path = self.sourced_partition_path(symbol, timeframe, source);
        let is_new_partition = !path.exists();
        // Read-merge-write keyed on ts: existing partition + incoming, incoming
        // wins on duplicate ts, output sorted ascending. Makes re-ingesting the
        // same day idempotent and lets day-by-day bhavcopy pulls accumulate.
        let mut merged: BTreeMap<i64, Candle> =
            self.read_partition(&path)?.into_iter().map(|c| (c.ts, c)).collect();
        for candle in candles {
            merged.insert(candle.ts, candle.clone());
        }
        let ordered: Vec<Candle> = merged.into_values().collect();
        self.write_partition(&path, &ordered)?;
        if is_new_partition {
            lake_manifest::append_partition_key(
                &self.root,
                &LakePartitionKey {
                    symbol: symbol.to_string(),
                    timeframe: timeframe.to_string(),
                    source: source.to_string(),
                },
            )?;
        }
        Ok(())
    }
```

Add `list_symbols` and `partition_bounds` inside `impl CandleStore` (e.g. after `read_sourced_candles`):

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

    pub fn list_symbols(&self) -> Result<Vec<LakeSymbolEntry>> {
        let keys = lake_manifest::read_partition_keys(&self.root)?;
        let mut entries = Vec::new();
        for key in keys {
            let path = self.sourced_partition_path(&key.symbol, &key.timeframe, &key.source);
            // Defensive: a manifested key whose partition file is gone is skipped
            // rather than erroring the whole listing.
            if !path.exists() {
                continue;
            }
            let (from_ts, to_ts, candle_count) = self.partition_bounds(&path)?;
            entries.push(LakeSymbolEntry {
                symbol: key.symbol,
                timeframe: key.timeframe,
                source: key.source,
                from_ts,
                to_ts,
                candle_count,
            });
        }
        entries.sort_by(|a, b| {
            (&a.symbol, &a.timeframe, &a.source).cmp(&(&b.symbol, &b.timeframe, &b.source))
        });
        Ok(entries)
    }
```

- [ ] **Step 5: Re-export from `lib.rs`** — replace the full contents of `rust-core/crates/storage/src/lib.rs`:

```rust
mod candle_store;
mod error;
mod lake_manifest;
mod state_store;

pub use candle_store::{Candle, CandleStore, LakeSymbolEntry};
pub use error::StorageError;
pub use lake_manifest::LakePartitionKey;
pub use state_store::{ConfluenceSnapshot, StateStore};
```

- [ ] **Step 6: Run the tests to verify they pass**

Run (from `rust-core/`): `cargo test -p storage`
Expected: PASS — the four new `list_symbols` tests plus every pre-existing `candle_store`/`state_store` test (the guarded `write_sourced_candles` change is behavior-preserving for existing callers, which never read the manifest).

- [ ] **Step 7: Commit**

```bash
git add rust-core/crates/storage/src/lake_manifest.rs rust-core/crates/storage/src/candle_store.rs rust-core/crates/storage/src/lib.rs rust-core/crates/storage/tests/candle_store_test.rs
git commit -m "feat(storage): lake_manifest + CandleStore::list_symbols with per-partition bounds"
```

---

### Task 3: `benchmark_classify.rs` — the pure classification function (algo-core)

The canonical, tested home of the classification rule: pure, deterministic, no I/O, directly unit-tested, matching `scan_gate.rs`/`confluence.rs` style. Not reachable from the TS runner (no sidecar request wraps it — the runner uses a TS mirror, Task 7); the aggregate `run_replay` sign check is deliberately left as-is. Fully independent — depends on nothing else in this phase.

**Files:**
- Create: `rust-core/crates/algo-core/src/benchmark_classify.rs`
- Create: `rust-core/crates/algo-core/tests/benchmark_classify_test.rs`
- Modify: `rust-core/crates/algo-core/src/lib.rs`

**Interfaces:**
- Consumes: `crate::Direction` (existing: `Bullish | Bearish | Neutral`).
- Produces:
  - `pub enum Outcome { Correct, Incorrect, Neutral }` (derives `Debug, Clone, Copy, PartialEq, Eq`).
  - `pub const DEFAULT_NEUTRAL_BAND: f64 = 0.001`.
  - `pub fn classify_decision(direction: Direction, realized_return: f64, neutral_band: f64) -> Outcome`.
  - `lib.rs` gains `pub mod benchmark_classify;`.

- [ ] **Step 1: Write the failing test** — create `rust-core/crates/algo-core/tests/benchmark_classify_test.rs`:

```rust
use algo_core::benchmark_classify::{classify_decision, Outcome, DEFAULT_NEUTRAL_BAND};
use algo_core::Direction;

#[test]
fn bullish_with_a_positive_return_is_correct() {
    assert_eq!(classify_decision(Direction::Bullish, 0.05, DEFAULT_NEUTRAL_BAND), Outcome::Correct);
}

#[test]
fn bullish_with_a_negative_return_is_incorrect() {
    assert_eq!(classify_decision(Direction::Bullish, -0.05, DEFAULT_NEUTRAL_BAND), Outcome::Incorrect);
}

#[test]
fn bearish_with_a_negative_return_is_correct() {
    assert_eq!(classify_decision(Direction::Bearish, -0.05, DEFAULT_NEUTRAL_BAND), Outcome::Correct);
}

#[test]
fn neutral_direction_is_always_neutral_regardless_of_return() {
    assert_eq!(classify_decision(Direction::Neutral, 0.42, DEFAULT_NEUTRAL_BAND), Outcome::Neutral);
    assert_eq!(classify_decision(Direction::Neutral, -0.42, DEFAULT_NEUTRAL_BAND), Outcome::Neutral);
}

#[test]
fn a_tiny_return_within_the_band_is_neutral_even_for_a_directional_call() {
    assert_eq!(classify_decision(Direction::Bullish, 0.0005, DEFAULT_NEUTRAL_BAND), Outcome::Neutral);
}

#[test]
fn a_return_exactly_at_the_band_edge_is_neutral() {
    // realized_return.abs() == neutral_band -> Neutral (inclusive `<=`).
    assert_eq!(classify_decision(Direction::Bullish, DEFAULT_NEUTRAL_BAND, DEFAULT_NEUTRAL_BAND), Outcome::Neutral);
    assert_eq!(classify_decision(Direction::Bearish, -DEFAULT_NEUTRAL_BAND, DEFAULT_NEUTRAL_BAND), Outcome::Neutral);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `rust-core/`): `cargo test -p algo-core --test benchmark_classify_test`
Expected: FAIL to compile — `algo_core::benchmark_classify` does not exist.

- [ ] **Step 3: Implement `benchmark_classify.rs`** — create `rust-core/crates/algo-core/src/benchmark_classify.rs`:

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
/// call. 0.1%, a starting default following the DIRECTION_DEADBAND = 0.05
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
    if matches {
        Outcome::Correct
    } else {
        Outcome::Incorrect
    }
}
```

- [ ] **Step 4: Wire `lib.rs`** — in `rust-core/crates/algo-core/src/lib.rs`, add `pub mod benchmark_classify;` alongside the existing `pub mod confluence;` (public module namespace, not root-re-exported). The module list becomes:

```rust
mod algorithm;
pub mod benchmark_classify;
pub mod confluence;
mod forecast;
mod indicators;
mod options;
mod quant;
pub mod registry;
pub mod scan_gate;
```

- [ ] **Step 5: Run the test to verify it passes**

Run (from `rust-core/`): `cargo test -p algo-core --test benchmark_classify_test`
Expected: PASS (all six tests). Confirm the crate still fully passes: `cargo test -p algo-core`.

- [ ] **Step 6: Commit**

```bash
git add rust-core/crates/algo-core/src/benchmark_classify.rs rust-core/crates/algo-core/tests/benchmark_classify_test.rs rust-core/crates/algo-core/src/lib.rs
git commit -m "feat(algo-core): pure benchmark_classify classify_decision with band tests"
```

---

### Task 4: Sidecar protocol payloads + benchmark handlers (sidecar)

Add the new request/response **payload** structs, give `CandleWire` `Clone`/`Serialize`, add `LakeSymbolWire` and a `benchmark_empty_response` constructor, and add the four handler functions plus the extracted mapping helpers. Add the `backtest` dependency for `context_at`. This task deliberately does **not** touch the `SidecarRequest`/`SidecarResponse` enums or `main.rs` — that coupled change lands atomically in Task 5. The new structs/handlers are `pub`, so nothing is dead code and the crate still compiles (`main.rs`'s match stays exhaustive over the unchanged enums). Depends on Task 2 (`list_symbols`/`LakeSymbolEntry`).

**Files:**
- Modify: `rust-core/crates/sidecar/Cargo.toml`
- Modify: `rust-core/crates/sidecar/src/protocol.rs`
- Modify: `rust-core/crates/sidecar/src/handlers.rs`
- Modify: `rust-core/crates/sidecar/tests/protocol_test.rs`

**Interfaces:**
- Consumes: `storage::{Candle, CandleStore, LakeSymbolEntry}`, `algo_core::{registry::{self, run_applicable}, AlgoOutput, Horizon, Timeframe}`, `algo_core::confluence::{compute_confluence, ScorecardSummary}`, `algo_core::scan_gate::{evaluate_scan_gate, GateThresholds}`, `backtest::frontier::context_at` (new dep).
- Produces (protocol.rs):
  - `CandleWire` gains `Clone` + `Serialize` (was `Deserialize`-only).
  - `pub struct ListLakeSymbolsRequest { id: u64 }`, `ReadLakeCandlesRequest { id, symbol, timeframe, source }`, `BenchmarkComputeRequest { id, symbol, timeframe, horizon, candles: Vec<CandleWire> }`, `EvaluateScanGateStatelessRequest { id, prev: Option<ConfluenceWire>, curr: ConfluenceWire }` (all `Deserialize`).
  - `pub struct LakeSymbolWire { symbol, timeframe, source, from_ts, to_ts, candle_count }`, `LakeSymbolsResponse { id, entries, error? }`, `LakeCandlesResponse { id, candles, error? }`, `BenchmarkComputeResponse { id, algo_results, confluence }` (all `Serialize`).
  - `pub fn benchmark_empty_response(id: u64) -> BenchmarkComputeResponse` (mirrors `empty_response`).
- Produces (handlers.rs): `handle_list_lake_symbols`/`handle_read_lake_candles` (both `(store: &CandleStore, request) -> …`), `handle_benchmark_compute(request) -> BenchmarkComputeResponse` (no store), `handle_evaluate_scan_gate_stateless(request) -> ScanGateResponse` (no store, zero I/O), plus extracted `algo_output_to_wire`/`confluence_to_wire`/`candle_to_wire`/`lake_entry_to_wire` helpers and `parse_timeframe`/`parse_horizon`.

- [ ] **Step 1: Write the failing tests** — append to `rust-core/crates/sidecar/tests/protocol_test.rs` (standalone struct-level round trips; the tagged-enum round trips land in Task 5). Update the top `use sidecar::protocol::{ … };` block to add the new types:

```rust
use sidecar::protocol::{
    benchmark_empty_response, BenchmarkComputeRequest, BenchmarkComputeResponse, CandleWire,
    EvaluateScanGateStatelessRequest, LakeCandlesResponse, LakeSymbolWire, LakeSymbolsResponse,
    ListLakeSymbolsRequest, ReadLakeCandlesRequest,
};
```

Append:

```rust
#[test]
fn list_lake_symbols_request_payload_deserializes() {
    let req: ListLakeSymbolsRequest = serde_json::from_str(r#"{"id":20}"#).unwrap();
    assert_eq!(req.id, 20);
}

#[test]
fn read_lake_candles_request_payload_deserializes_with_its_source() {
    let req: ReadLakeCandlesRequest =
        serde_json::from_str(r#"{"id":21,"symbol":"NSE:INFY","timeframe":"day","source":"bhavcopy"}"#).unwrap();
    assert_eq!(req.id, 21);
    assert_eq!(req.symbol, "NSE:INFY");
    assert_eq!(req.timeframe, "day");
    assert_eq!(req.source, "bhavcopy");
}

#[test]
fn benchmark_compute_request_payload_deserializes_its_candle_window() {
    let req: BenchmarkComputeRequest = serde_json::from_str(
        r#"{"id":22,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":1710000000,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100}]}"#,
    )
    .unwrap();
    assert_eq!(req.id, 22);
    assert_eq!(req.horizon, "positional");
    assert_eq!(req.candles.len(), 1);
    assert_eq!(req.candles[0].volume, 100);
}

#[test]
fn evaluate_scan_gate_stateless_request_payload_deserializes_with_a_null_prev() {
    let req: EvaluateScanGateStatelessRequest = serde_json::from_str(
        r#"{"id":23,"prev":null,"curr":{"bullish_count":5,"bearish_count":2,"neutral_count":10,"weighted_vote":0.12}}"#,
    )
    .unwrap();
    assert_eq!(req.id, 23);
    assert!(req.prev.is_none());
    assert_eq!(req.curr.bullish_count, 5);
}

#[test]
fn lake_symbols_response_serializes_its_entries() {
    let json = serde_json::to_string(&LakeSymbolsResponse {
        id: 20,
        entries: vec![LakeSymbolWire {
            symbol: "NSE:INFY".to_string(),
            timeframe: "day".to_string(),
            source: "bhavcopy".to_string(),
            from_ts: 1_690_000_000,
            to_ts: 1_710_000_000,
            candle_count: 240,
        }],
        error: None,
    })
    .unwrap();
    assert!(json.contains("\"symbol\":\"NSE:INFY\""));
    assert!(json.contains("\"candle_count\":240"));
    assert!(!json.contains("error"));
}

#[test]
fn lake_candles_response_serializes_all_six_candle_fields_proving_candle_wire_now_serializes() {
    let json = serde_json::to_string(&LakeCandlesResponse {
        id: 21,
        candles: vec![CandleWire { ts: 1_710_000_000, open: 1.0, high: 2.0, low: 0.5, close: 1.5, volume: 100 }],
        error: None,
    })
    .unwrap();
    for field in ["\"ts\":1710000000", "\"open\":1.0", "\"high\":2.0", "\"low\":0.5", "\"close\":1.5", "\"volume\":100"] {
        assert!(json.contains(field), "missing {field} in {json}");
    }
}

#[test]
fn benchmark_compute_response_serializes_and_empty_helper_is_zeroed() {
    let empty = benchmark_empty_response(22);
    assert_eq!(empty.id, 22);
    assert!(empty.algo_results.is_empty());
    assert_eq!(empty.confluence.bullish_count, 0);
    assert_eq!(empty.confluence.neutral_count, 0);
    let json = serde_json::to_string(&BenchmarkComputeResponse {
        id: 22,
        algo_results: Vec::new(),
        confluence: empty.confluence,
    })
    .unwrap();
    assert!(json.contains("\"id\":22"));
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `rust-core/`): `cargo test -p sidecar --test protocol_test`
Expected: FAIL to compile — the new payload types, `LakeSymbolWire`, and `benchmark_empty_response` don't exist, and `CandleWire` isn't `Serialize`.

- [ ] **Step 3: Add the `backtest` dependency** — in `rust-core/crates/sidecar/Cargo.toml`, add to `[dependencies]` (dependency graph stays acyclic — `backtest` does not depend on `sidecar`):

```toml
backtest = { path = "../backtest" }
```

- [ ] **Step 4: Implement the protocol additions** — in `rust-core/crates/sidecar/src/protocol.rs`:

Change `CandleWire`'s derive to add `Clone` + `Serialize`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandleWire {
    pub ts: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: i64,
}
```

Add the new payloads immediately before the `SidecarRequest` enum (after `ScanGateResponse`):

```rust
#[derive(Debug, Deserialize)]
pub struct ListLakeSymbolsRequest {
    pub id: u64,
}

#[derive(Debug, Deserialize)]
pub struct ReadLakeCandlesRequest {
    pub id: u64,
    pub symbol: String,
    pub timeframe: String,
    pub source: String,
}

#[derive(Debug, Deserialize)]
pub struct BenchmarkComputeRequest {
    pub id: u64,
    pub symbol: String,
    pub timeframe: String,
    /// "intraday" | "positional".
    pub horizon: String,
    /// The visible window series[0..=frontier], ascending by ts.
    pub candles: Vec<CandleWire>,
}

#[derive(Debug, Deserialize)]
pub struct EvaluateScanGateStatelessRequest {
    pub id: u64,
    pub prev: Option<ConfluenceWire>,
    pub curr: ConfluenceWire,
}

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

/// The "nothing ran / panicked" benchmark_compute answer for `id`: no algorithm
/// results, entirely zeroed confluence. Mirrors `empty_response`'s role for
/// `Compute` -- the client blocks on `id`, so it is still owed one line.
pub fn benchmark_empty_response(id: u64) -> BenchmarkComputeResponse {
    BenchmarkComputeResponse {
        id,
        algo_results: Vec::new(),
        confluence: ConfluenceWire {
            bullish_count: 0,
            bearish_count: 0,
            neutral_count: 0,
            weighted_vote: 0.0,
        },
    }
}
```

- [ ] **Step 5: Implement the handlers** — in `rust-core/crates/sidecar/src/handlers.rs`, extend the imports and add the handlers + extracted helpers.

Update the top `use` block to:

```rust
use crate::protocol::{
    benchmark_empty_response, AddWatchlistSymbolRequest, AlgoResultWire, BenchmarkComputeRequest,
    BenchmarkComputeResponse, CandleWire, ComputeRequest, ComputeResponse, ConfluenceWire,
    EvaluateScanGateRequest, EvaluateScanGateStatelessRequest, LakeCandlesResponse, LakeSymbolWire,
    LakeSymbolsResponse, ListLakeSymbolsRequest, ListWatchlistRequest, PersistCandlesRequest,
    PersistCandlesResponse, ReadLakeCandlesRequest, RemoveWatchlistSymbolRequest, ScanGateResponse,
    WatchlistResponse,
};
use algo_core::confluence::{compute_confluence, ScorecardSummary};
use algo_core::scan_gate::{evaluate_scan_gate, GateThresholds};
use algo_core::{registry::{self, run_applicable}, AlgoOutput, Horizon, MarketContext, Timeframe};
use backtest::frontier::context_at;
use chrono::Utc;
use std::collections::HashMap;
use storage::{Candle, CandleStore, ConfluenceSnapshot, LakeSymbolEntry, StateStore};
```

Add the extracted mapping helpers (pure refactor of the mapping already inside `handle_request`) near the other helper fns:

```rust
fn algo_output_to_wire(output: &AlgoOutput) -> AlgoResultWire {
    AlgoResultWire {
        algo_id: output.algo_id.to_string(),
        symbol: output.symbol.clone(),
        timeframe: timeframe_to_wire(output.timeframe).to_string(),
        horizon: horizon_to_wire(output.horizon).to_string(),
        direction: format!("{:?}", output.direction),
        magnitude: output.magnitude,
        confidence: output.confidence,
        evidence: output.evidence.clone(),
        computed_at: output.computed_at.to_rfc3339(),
    }
}

fn confluence_to_wire(summary: &ScorecardSummary) -> ConfluenceWire {
    ConfluenceWire {
        bullish_count: summary.bullish_count,
        bearish_count: summary.bearish_count,
        neutral_count: summary.neutral_count,
        weighted_vote: summary.weighted_vote,
    }
}

fn candle_to_wire(c: &Candle) -> CandleWire {
    CandleWire { ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }
}

fn lake_entry_to_wire(e: &LakeSymbolEntry) -> LakeSymbolWire {
    LakeSymbolWire {
        symbol: e.symbol.clone(),
        timeframe: e.timeframe.clone(),
        source: e.source.clone(),
        from_ts: e.from_ts,
        to_ts: e.to_ts,
        candle_count: e.candle_count,
    }
}

fn parse_timeframe(s: &str) -> Timeframe {
    match s {
        "minute" => Timeframe::Minute,
        "5minute" => Timeframe::FiveMinute,
        "15minute" => Timeframe::FifteenMinute,
        _ => Timeframe::Day,
    }
}

fn parse_horizon(s: &str) -> Horizon {
    if s == "intraday" {
        Horizon::Intraday
    } else {
        Horizon::Positional
    }
}
```

Refactor the tail of `handle_request` to use the extracted helpers (behavior byte-identical). Replace its `let algo_results = outputs.iter().map(|output| AlgoResultWire { … }).collect();` block and its final `ComputeResponse { … }` with:

```rust
    let algo_results = outputs.iter().map(algo_output_to_wire).collect();

    ComputeResponse {
        id: request.id,
        algo_results,
        confluence: confluence_to_wire(&confluence),
    }
```

Add the four new handlers (after `handle_evaluate_scan_gate`, before the `#[cfg(test)]` module):

```rust
pub fn handle_benchmark_compute(request: BenchmarkComputeRequest) -> BenchmarkComputeResponse {
    let candles: Vec<Candle> = request.candles.iter().map(|c| Candle {
        ts: c.ts,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
    }).collect();
    if candles.is_empty() {
        return benchmark_empty_response(request.id);
    }
    let timeframe = parse_timeframe(&request.timeframe);
    let horizon = parse_horizon(&request.horizon);
    // Full OHLCV context at the last visible bar -- richer than the live
    // Compute handler's closes-only from_closes path (which is left unchanged).
    // Anti-lookahead holds: context_at's as_of is the frontier bar's own ts, and
    // only series[0..=frontier] is in the window.
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
    // Wraps read_sourced_candles (not read_candles): all lake data lives in
    // sourced partitions, so a source-less read would return an empty
    // non-sourced partition. The request carries `source` so the renderer
    // round-trips the exact partition list_symbols reported.
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
    // ZERO StateStore I/O: a pure wrapper over evaluate_scan_gate. Takes no
    // store, so it can never touch scan_snapshots -- a benchmark run can never
    // corrupt the live proactive scanner's per-symbol gate memory.
    let decision = evaluate_scan_gate(prev.as_ref(), &curr, &GateThresholds::default());
    ScanGateResponse { id: request.id, decision: format!("{decision:?}"), error: None }
}
```

- [ ] **Step 6: Add the handler inline tests** — append inside the existing `#[cfg(test)] mod tests { … }` in `handlers.rs` (after the scan-gate tests):

```rust
    fn candle_store() -> (tempfile::TempDir, CandleStore) {
        use tempfile::tempdir;
        let dir = tempdir().unwrap();
        let store = CandleStore::open(dir.path()).unwrap();
        (dir, store)
    }

    fn ohlcv_window(len: usize) -> Vec<CandleWire> {
        // Rising close AND rising volume: a full-OHLCV context lets volume-based
        // algorithms produce a directional signal; a closes-only from_closes
        // context (empty volumes) would no-op them all to Neutral.
        (0..len)
            .map(|i| {
                let base = 100.0 + i as f64;
                CandleWire {
                    ts: 1_700_000_000 + i as i64 * 86_400,
                    open: base,
                    high: base + 2.0,
                    low: base - 1.0,
                    close: base + 1.0,
                    volume: 1_000 + i as i64 * 100,
                }
            })
            .collect()
    }

    #[test]
    fn handle_benchmark_compute_reaches_run_applicable_with_full_ohlcv() {
        let response = handle_benchmark_compute(BenchmarkComputeRequest {
            id: 30,
            symbol: "NSE:INFY".to_string(),
            timeframe: "day".to_string(),
            horizon: "positional".to_string(),
            candles: ohlcv_window(60),
        });
        assert_eq!(response.id, 30);
        // At least one volume/OHLCV-reading algorithm must produce a directional
        // signal -- the proof that context_at's full OHLCV, not from_closes,
        // reached run_applicable.
        let volume_based = ["obv", "mfi", "cmf", "vwap", "accumulation_distribution", "volume_profile"];
        assert!(
            response.algo_results.iter().any(|r| volume_based.contains(&r.algo_id.as_str()) && r.direction != "Neutral"),
            "a volume/OHLCV-based algorithm must be directional under full OHLCV; got {:?}",
            response.algo_results.iter().map(|r| (r.algo_id.clone(), r.direction.clone())).collect::<Vec<_>>()
        );
    }

    #[test]
    fn handle_benchmark_compute_on_empty_candles_returns_a_zeroed_response() {
        let response = handle_benchmark_compute(BenchmarkComputeRequest {
            id: 31,
            symbol: "NSE:INFY".to_string(),
            timeframe: "day".to_string(),
            horizon: "positional".to_string(),
            candles: Vec::new(),
        });
        assert_eq!(response.id, 31);
        assert!(response.algo_results.is_empty());
        assert_eq!(response.confluence.neutral_count, 0);
    }

    #[test]
    fn handle_read_lake_candles_reads_back_a_written_sourced_partition() {
        let (_dir, store) = candle_store();
        store
            .write_sourced_candles("NSE:INFY", "day", "bhavcopy", &[Candle { ts: 100, open: 1.0, high: 2.0, low: 0.5, close: 1.5, volume: 10 }])
            .unwrap();
        let response = handle_read_lake_candles(
            &store,
            ReadLakeCandlesRequest { id: 32, symbol: "NSE:INFY".to_string(), timeframe: "day".to_string(), source: "bhavcopy".to_string() },
        );
        assert_eq!(response.candles.len(), 1);
        assert_eq!(response.candles[0].close, 1.5);
        assert!(response.error.is_none());
    }

    #[test]
    fn handle_list_lake_symbols_returns_one_entry_per_written_partition() {
        let (_dir, store) = candle_store();
        store.write_sourced_candles("NSE:INFY", "day", "bhavcopy", &[Candle { ts: 100, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1 }]).unwrap();
        store.write_sourced_candles("NSE:TCS", "day", "bhavcopy", &[Candle { ts: 100, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1 }]).unwrap();
        let response = handle_list_lake_symbols(&store, ListLakeSymbolsRequest { id: 33 });
        assert_eq!(response.id, 33);
        assert_eq!(response.entries.len(), 2);
    }

    #[test]
    fn handle_evaluate_scan_gate_stateless_matches_the_persistent_gate_and_writes_nothing() {
        // Identical first-ever input -> same decision as the persistent handler.
        let stateless = handle_evaluate_scan_gate_stateless(EvaluateScanGateStatelessRequest {
            id: 34,
            prev: None,
            curr: confluence_wire(5, 2, 10, 0.12),
        });
        assert_eq!(stateless.decision, "WorthLook");

        // Zero StateStore writes: run the stateless handler, then open a fresh
        // StateStore and confirm scan_snapshots never got a row (it can't -- the
        // handler holds no store reference).
        let (_dir, state) = state_store();
        let _ = handle_evaluate_scan_gate_stateless(EvaluateScanGateStatelessRequest {
            id: 35,
            prev: None,
            curr: confluence_wire(5, 2, 10, 0.12),
        });
        assert!(state.get_last_snapshot("NSE:INFY").unwrap().is_none());
    }
```

- [ ] **Step 7: Run tests + build to verify they pass**

Run (from `rust-core/`): `cargo test -p sidecar --lib && cargo test -p sidecar --test protocol_test`
Expected: PASS — the new handler inline tests via `--lib` (plus every pre-existing inline test, unchanged by the pure mapping refactor) and the new protocol payload tests via `--test protocol_test`. The crate still compiles because `main.rs`'s `match` remains exhaustive over the unchanged enums.

- [ ] **Step 8: Commit**

```bash
git add rust-core/crates/sidecar/Cargo.toml rust-core/crates/sidecar/src/protocol.rs rust-core/crates/sidecar/src/handlers.rs rust-core/crates/sidecar/tests/protocol_test.rs
git commit -m "feat(sidecar): benchmark/lake request-response payloads and handlers"
```

---

### Task 5: Sidecar enum variants + `main.rs` dispatch + end-to-end (sidecar)

The coupled change: extend the `SidecarRequest`/`SidecarResponse` tagged enums with the new variants and, in the **same commit**, add the four `main.rs` dispatch arms (each panic-isolated exactly like `Compute`/`PersistCandles`), add the tagged-enum round-trip protocol tests, and the compiled-binary end-to-end tests. `ListLakeSymbols`/`ReadLakeCandles` require `store`; `BenchmarkCompute`/`EvaluateScanGateStateless` require **no** store. Depends on Task 4.

**Files:**
- Modify: `rust-core/crates/sidecar/src/protocol.rs`
- Modify: `rust-core/crates/sidecar/src/main.rs`
- Modify: `rust-core/crates/sidecar/tests/protocol_test.rs`
- Modify: `rust-core/crates/sidecar/tests/end_to_end_test.rs`

**Interfaces:**
- Consumes: the Task 4 handlers and payloads; existing `main.rs` `store: Option<CandleStore>`.
- Produces:
  - `SidecarRequest` gains `ListLakeSymbols`, `ReadLakeCandles`, `BenchmarkCompute`, `EvaluateScanGateStateless`.
  - `SidecarResponse` gains `LakeSymbols`, `LakeCandles`, `BenchmarkCompute`.
  - `main.rs`: four new `catch_unwind`-isolated match arms.

- [ ] **Step 1: Write the failing tests** — append the tagged round trips to `rust-core/crates/sidecar/tests/protocol_test.rs`. First add `encode_response, parse_request, SidecarRequest, SidecarResponse` to the top `use` block if not already imported there (they are, from the existing test file). Append:

```rust
#[test]
fn parses_a_tagged_list_lake_symbols_request() {
    match parse_request(r#"{"type":"list_lake_symbols","id":20}"#).unwrap() {
        SidecarRequest::ListLakeSymbols(request) => assert_eq!(request.id, 20),
        _ => panic!("expected a list_lake_symbols request"),
    }
}

#[test]
fn parses_a_tagged_read_lake_candles_request() {
    match parse_request(r#"{"type":"read_lake_candles","id":21,"symbol":"NSE:INFY","timeframe":"day","source":"bhavcopy"}"#).unwrap() {
        SidecarRequest::ReadLakeCandles(request) => {
            assert_eq!(request.id, 21);
            assert_eq!(request.source, "bhavcopy");
        }
        _ => panic!("expected a read_lake_candles request"),
    }
}

#[test]
fn parses_a_tagged_benchmark_compute_request() {
    match parse_request(
        r#"{"type":"benchmark_compute","id":22,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":1710000000,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100}]}"#,
    )
    .unwrap()
    {
        SidecarRequest::BenchmarkCompute(request) => {
            assert_eq!(request.id, 22);
            assert_eq!(request.candles.len(), 1);
        }
        _ => panic!("expected a benchmark_compute request"),
    }
}

#[test]
fn parses_a_tagged_evaluate_scan_gate_stateless_request() {
    match parse_request(
        r#"{"type":"evaluate_scan_gate_stateless","id":23,"prev":null,"curr":{"bullish_count":5,"bearish_count":2,"neutral_count":10,"weighted_vote":0.12}}"#,
    )
    .unwrap()
    {
        SidecarRequest::EvaluateScanGateStateless(request) => {
            assert_eq!(request.id, 23);
            assert!(request.prev.is_none());
        }
        _ => panic!("expected an evaluate_scan_gate_stateless request"),
    }
}

#[test]
fn encodes_a_tagged_lake_symbols_response() {
    let line = encode_response(&SidecarResponse::LakeSymbols(LakeSymbolsResponse {
        id: 20,
        entries: vec![LakeSymbolWire {
            symbol: "NSE:INFY".to_string(),
            timeframe: "day".to_string(),
            source: "bhavcopy".to_string(),
            from_ts: 1_690_000_000,
            to_ts: 1_710_000_000,
            candle_count: 240,
        }],
        error: None,
    }));
    assert!(!line.contains('\n'));
    assert!(line.contains("\"type\":\"lake_symbols\""));
    assert!(line.contains("\"candle_count\":240"));
}

#[test]
fn encodes_a_tagged_lake_candles_response() {
    let line = encode_response(&SidecarResponse::LakeCandles(LakeCandlesResponse {
        id: 21,
        candles: vec![CandleWire { ts: 1_710_000_000, open: 1.0, high: 2.0, low: 0.5, close: 1.5, volume: 100 }],
        error: None,
    }));
    assert!(line.contains("\"type\":\"lake_candles\""));
    assert!(line.contains("\"volume\":100"));
}

#[test]
fn encodes_a_tagged_benchmark_compute_response() {
    let line = encode_response(&SidecarResponse::BenchmarkCompute(benchmark_empty_response(22)));
    assert!(line.contains("\"type\":\"benchmark_compute\""));
    assert!(line.contains("\"id\":22"));
}
```

Append to `rust-core/crates/sidecar/tests/end_to_end_test.rs` (the file already imports `Command`, `Stdio`, `BufReader`, `BufRead`, `Write`):

```rust
#[test]
fn benchmark_and_lake_flow_over_stdin_stdout_with_a_lake_root() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_sidecar"))
        .arg("--lake-root")
        .arg(dir.path().to_str().unwrap())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("sidecar binary must start");

    let persist = r#"{"type":"persist_candles","id":1,"symbol":"NSE:INFY","timeframe":"day","source":"bhavcopy","candles":[{"ts":100,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100},{"ts":200,"open":1.5,"high":2.5,"low":1.0,"close":2.0,"volume":120}]}"#;
    let list = r#"{"type":"list_lake_symbols","id":2}"#;
    let read = r#"{"type":"read_lake_candles","id":3,"symbol":"NSE:INFY","timeframe":"day","source":"bhavcopy"}"#;
    let bench = r#"{"type":"benchmark_compute","id":4,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":100,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100},{"ts":200,"open":1.5,"high":2.5,"low":1.0,"close":2.0,"volume":120}]}"#;
    let gate = r#"{"type":"evaluate_scan_gate_stateless","id":5,"prev":null,"curr":{"bullish_count":8,"bearish_count":1,"neutral_count":2,"weighted_vote":0.5}}"#;

    {
        let stdin = child.stdin.as_mut().unwrap();
        for line in [persist, list, read, bench, gate] {
            writeln!(stdin, "{line}").unwrap();
        }
    }
    drop(child.stdin.take());

    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let mut responses = Vec::new();
    for _ in 0..5 {
        let mut line = String::new();
        reader.read_line(&mut line).expect("stdout must be readable");
        responses.push(serde_json::from_str::<serde_json::Value>(line.trim()).unwrap());
    }
    child.wait().ok();

    assert_eq!(responses[0]["type"], "persist_candles");
    assert_eq!(responses[1]["type"], "lake_symbols");
    assert_eq!(responses[1]["entries"][0]["symbol"], "NSE:INFY");
    assert_eq!(responses[1]["entries"][0]["from_ts"], 100);
    assert_eq!(responses[1]["entries"][0]["to_ts"], 200);
    assert_eq!(responses[1]["entries"][0]["candle_count"], 2);
    assert_eq!(responses[2]["type"], "lake_candles");
    assert_eq!(responses[2]["candles"].as_array().unwrap().len(), 2);
    assert_eq!(responses[3]["type"], "benchmark_compute");
    assert!(responses[3]["confluence"]["bullish_count"].is_number());
    assert_eq!(responses[4]["type"], "scan_gate");
    assert_eq!(responses[4]["decision"], "WorthLook");
}

#[test]
fn benchmark_compute_answers_even_with_no_lake_root() {
    // BenchmarkCompute needs no store -- it computes purely from the request's
    // candles -- so it must answer with no --lake-root at all.
    let mut child = Command::new(env!("CARGO_BIN_EXE_sidecar"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("sidecar binary must start");

    let bench = r#"{"type":"benchmark_compute","id":1,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":100,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100}]}"#;
    {
        let stdin = child.stdin.as_mut().unwrap();
        writeln!(stdin, "{bench}").unwrap();
    }
    drop(child.stdin.take());

    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader.read_line(&mut line).expect("stdout must be readable");
    child.wait().ok();

    let response: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(response["type"], "benchmark_compute");
    assert_eq!(response["id"], 1);
}

#[test]
fn a_malformed_benchmark_compute_between_two_valid_ones_does_not_kill_the_sidecar() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_sidecar"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("sidecar binary must start");

    let valid = r#"{"type":"benchmark_compute","id":1,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":100,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100}]}"#;
    // Well-typed tag but a candle missing required fields: serde rejects the line
    // (logged + skipped) or, if accepted, the handler is panic-isolated. Either
    // way the two valid requests must be answered and the process exit cleanly.
    let malformed = r#"{"type":"benchmark_compute","id":2,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":100}]}"#;
    let valid_2 = r#"{"type":"benchmark_compute","id":3,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":200,"open":2.0,"high":3.0,"low":1.5,"close":2.5,"volume":90}]}"#;

    {
        let stdin = child.stdin.as_mut().unwrap();
        for line in [valid, malformed, valid_2] {
            writeln!(stdin, "{line}").unwrap();
        }
    }
    drop(child.stdin.take());

    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let mut ids = Vec::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap() == 0 {
            break;
        }
        if line.trim().is_empty() {
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        ids.push(value["id"].as_u64().unwrap());
    }

    let status = child.wait().expect("sidecar must be waitable, not crashed");
    assert!(status.success(), "sidecar should exit cleanly, not crash: {status:?}");
    assert!(ids.contains(&1), "the first valid request must be answered");
    assert!(ids.contains(&3), "the second valid request must be answered");
}
```

Add the new response types to the `end_to_end_test.rs` imports only if the file names them directly (it decodes into `serde_json::Value`, so no new imports are needed there). For `protocol_test.rs`, ensure the top `use` block includes `benchmark_empty_response, CandleWire, LakeCandlesResponse, LakeSymbolWire, LakeSymbolsResponse` (added in Task 4).

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `rust-core/`): `cargo test -p sidecar --test protocol_test`
Expected: FAIL to compile — `SidecarRequest`/`SidecarResponse` have no `ListLakeSymbols`/`ReadLakeCandles`/`BenchmarkCompute`/`EvaluateScanGateStateless`/`LakeSymbols`/`LakeCandles` variants yet.

- [ ] **Step 3: Extend the enums** — in `rust-core/crates/sidecar/src/protocol.rs`, replace the two enums:

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

- [ ] **Step 4: Route the new variants in `main.rs`** — in `rust-core/crates/sidecar/src/main.rs`:

Extend the handlers import to add `handle_benchmark_compute, handle_evaluate_scan_gate_stateless, handle_list_lake_symbols, handle_read_lake_candles`, and the protocol import to add `benchmark_empty_response, LakeCandlesResponse, LakeSymbolsResponse`.

Add these four arms inside the `match request { … }` (after `SidecarRequest::EvaluateScanGate(...)`):

```rust
            SidecarRequest::ListLakeSymbols(request) => {
                let id = request.id;
                match store.as_ref() {
                    Some(store) => {
                        let result = panic::catch_unwind(AssertUnwindSafe(|| handle_list_lake_symbols(store, request)));
                        match result {
                            Ok(response) => SidecarResponse::LakeSymbols(response),
                            Err(_) => {
                                eprintln!("sidecar: list_lake_symbols request {id} panicked");
                                SidecarResponse::LakeSymbols(LakeSymbolsResponse { id, entries: Vec::new(), error: Some("list_lake_symbols panicked".to_string()) })
                            }
                        }
                    }
                    None => SidecarResponse::LakeSymbols(LakeSymbolsResponse { id, entries: Vec::new(), error: Some("no --lake-root configured".to_string()) }),
                }
            }
            SidecarRequest::ReadLakeCandles(request) => {
                let id = request.id;
                match store.as_ref() {
                    Some(store) => {
                        let result = panic::catch_unwind(AssertUnwindSafe(|| handle_read_lake_candles(store, request)));
                        match result {
                            Ok(response) => SidecarResponse::LakeCandles(response),
                            Err(_) => {
                                eprintln!("sidecar: read_lake_candles request {id} panicked");
                                SidecarResponse::LakeCandles(LakeCandlesResponse { id, candles: Vec::new(), error: Some("read_lake_candles panicked".to_string()) })
                            }
                        }
                    }
                    None => SidecarResponse::LakeCandles(LakeCandlesResponse { id, candles: Vec::new(), error: Some("no --lake-root configured".to_string()) }),
                }
            }
            SidecarRequest::BenchmarkCompute(request) => {
                // Needs no store: it always answers, computing purely from the
                // request's candles. A panic falls back to a zeroed response.
                let id = request.id;
                let result = panic::catch_unwind(AssertUnwindSafe(|| handle_benchmark_compute(request)));
                match result {
                    Ok(response) => SidecarResponse::BenchmarkCompute(response),
                    Err(_) => {
                        eprintln!("sidecar: benchmark_compute request {id} panicked; returning a zeroed response");
                        SidecarResponse::BenchmarkCompute(benchmark_empty_response(id))
                    }
                }
            }
            SidecarRequest::EvaluateScanGateStateless(request) => {
                // Needs no store (pure): it always answers.
                let id = request.id;
                let result = panic::catch_unwind(AssertUnwindSafe(|| handle_evaluate_scan_gate_stateless(request)));
                match result {
                    Ok(response) => SidecarResponse::ScanGate(response),
                    Err(_) => {
                        eprintln!("sidecar: evaluate_scan_gate_stateless request {id} panicked");
                        SidecarResponse::ScanGate(ScanGateResponse { id, decision: "NoChange".to_string(), error: Some("evaluate_scan_gate_stateless panicked".to_string()) })
                    }
                }
            }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run (from `rust-core/`): `cargo test -p sidecar`
Expected: PASS — all protocol tests (Task 4 payload + Task 5 tagged), the handler inline tests, the pre-existing `end_to_end_test.rs` tests, and the three new end-to-end tests.

- [ ] **Step 6: Commit**

```bash
git add rust-core/crates/sidecar/src/protocol.rs rust-core/crates/sidecar/src/main.rs rust-core/crates/sidecar/tests/protocol_test.rs rust-core/crates/sidecar/tests/end_to_end_test.rs
git commit -m "feat(sidecar): route benchmark/lake variants with catch_unwind isolation"
```

---

### Task 6: TypeScript sidecar mirror (electron-app)

Mirror the four new request tags and three new response tags into `sidecarProtocol.ts`, and add four `SidecarSupervisor` methods that delegate to the existing `send()` (which owns id-assignment, the per-request timeout, and pending-map correlation — no new plumbing). `evaluateScanGateStateless` reuses the existing `ScanGateResponseWire`. Depends on Task 5 (the Rust wire contract must exist).

**Files:**
- Modify: `electron-app/src/main/services/sidecar/sidecarProtocol.ts`
- Modify: `electron-app/src/main/services/sidecar/sidecarSupervisor.ts`
- Modify: `electron-app/test/main/services/sidecar/sidecarProtocol.test.ts`
- Modify: `electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts`

**Interfaces:**
- Consumes: existing `CandleWire`, `ConfluenceWire`, `AlgoResultWire`, `ScanGateResponseWire`, `send()`.
- Produces:
  - `sidecarProtocol.ts`: `LakeSymbolWire` (6 data fields, no `type` tag), `LakeSymbolsResponseWire`, `LakeCandlesResponseWire`, `BenchmarkComputeResponseWire`; the `SidecarResponseWire` union extended with the three; `SidecarRequestWire` extended with the four new request variants.
  - `sidecarSupervisor.ts`: `listLakeSymbols()`, `readLakeCandles(symbol, timeframe, source)`, `benchmarkCompute(symbol, timeframe, horizon, candles)`, `evaluateScanGateStateless(prev, curr)`.

- [ ] **Step 1: Write the failing tests** — append to `electron-app/test/main/services/sidecar/sidecarProtocol.test.ts` (extend the top type import to add `LakeSymbolsResponseWire`, `LakeCandlesResponseWire`, `BenchmarkComputeResponseWire`):

```typescript
describe("benchmark + lake wire shapes", () => {
  it("encodes the four new request tags on a single newline-terminated line", () => {
    expect(encodeRequest({ type: "list_lake_symbols", id: 20 })).toBe('{"type":"list_lake_symbols","id":20}\n');
    expect(encodeRequest({ type: "read_lake_candles", id: 21, symbol: "NSE:INFY", timeframe: "day", source: "bhavcopy" })).toBe(
      '{"type":"read_lake_candles","id":21,"symbol":"NSE:INFY","timeframe":"day","source":"bhavcopy"}\n',
    );
    expect(
      encodeRequest({
        type: "benchmark_compute",
        id: 22,
        symbol: "NSE:INFY",
        timeframe: "day",
        horizon: "positional",
        candles: [{ ts: 1710000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }],
      }),
    ).toContain('"type":"benchmark_compute"');
    expect(
      encodeRequest({
        type: "evaluate_scan_gate_stateless",
        id: 23,
        prev: null,
        curr: { bullish_count: 5, bearish_count: 2, neutral_count: 10, weighted_vote: 0.12 },
      }),
    ).toContain('"prev":null');
  });

  it("decodes the three new response tags", () => {
    const symbols = JSON.parse(
      '{"type":"lake_symbols","id":20,"entries":[{"symbol":"NSE:INFY","timeframe":"day","source":"bhavcopy","from_ts":1690000000,"to_ts":1710000000,"candle_count":240}]}',
    ) as import("../../../../src/main/services/sidecar/sidecarProtocol").LakeSymbolsResponseWire;
    expect(symbols.type).toBe("lake_symbols");
    expect(symbols.entries[0].candle_count).toBe(240);
    const candles = JSON.parse(
      '{"type":"lake_candles","id":21,"candles":[{"ts":1710000000,"open":1,"high":2,"low":0.5,"close":1.5,"volume":100}]}',
    ) as import("../../../../src/main/services/sidecar/sidecarProtocol").LakeCandlesResponseWire;
    expect(candles.candles[0].volume).toBe(100);
    const bench = JSON.parse(
      '{"type":"benchmark_compute","id":22,"algo_results":[],"confluence":{"bullish_count":3,"bearish_count":1,"neutral_count":8,"weighted_vote":0.18}}',
    ) as import("../../../../src/main/services/sidecar/sidecarProtocol").BenchmarkComputeResponseWire;
    expect(bench.confluence.weighted_vote).toBe(0.18);
  });
});
```

Append to `electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts`:

```typescript
  it("resolves listLakeSymbols with a lake_symbols response carrying the matching id", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.listLakeSymbols();
    await requestsSeen;
    children[0].stdout.write(
      `${JSON.stringify({ type: "lake_symbols", id: 1, entries: [{ symbol: "NSE:INFY", timeframe: "day", source: "bhavcopy", from_ts: 1, to_ts: 2, candle_count: 3 }] })}\n`,
    );
    const response = await pending;
    expect(response.type).toBe("lake_symbols");
    expect(response.entries[0].symbol).toBe("NSE:INFY");
  });

  it("resolves readLakeCandles with the sourced series", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.readLakeCandles("NSE:INFY", "day", "bhavcopy");
    await requestsSeen;
    children[0].stdout.write(
      `${JSON.stringify({ type: "lake_candles", id: 1, candles: [{ ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }] })}\n`,
    );
    expect((await pending).candles).toHaveLength(1);
  });

  it("resolves benchmarkCompute with algo_results and confluence", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.benchmarkCompute("NSE:INFY", "day", "positional", [
      { ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ]);
    await requestsSeen;
    children[0].stdout.write(
      `${JSON.stringify({ type: "benchmark_compute", id: 1, algo_results: [], confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 } })}\n`,
    );
    expect((await pending).confluence.bullish_count).toBe(1);
  });

  it("resolves evaluateScanGateStateless with a scan_gate decision", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.evaluateScanGateStateless(null, {
      bullish_count: 5,
      bearish_count: 2,
      neutral_count: 10,
      weighted_vote: 0.12,
    });
    await requestsSeen;
    children[0].stdout.write(`${JSON.stringify({ type: "scan_gate", id: 1, decision: "WorthLook" })}\n`);
    expect((await pending).decision).toBe("WorthLook");
  });

  it("rejects benchmarkCompute on timeout exactly like compute (shared send path)", async () => {
    const children: FakeChild[] = [];
    const spawnFn = (_command: string, _args: string[]) => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ReturnType<typeof spawnFn>;
    };
    const supervisor = new SidecarSupervisor({ binaryPath: "/fake/sidecar", lakeRoot: "/fake/lake", spawnFn, requestTimeoutMs: 20 });
    supervisor.start();
    await expect(
      supervisor.benchmarkCompute("NSE:INFY", "day", "positional", [{ ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }]),
    ).rejects.toThrow(/sidecar request 1 timed out after 20ms/);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `electron-app/`): `npx vitest run test/main/services/sidecar/sidecarProtocol.test.ts test/main/services/sidecar/sidecarSupervisor.test.ts`
Expected: FAIL — the new wire types and the four supervisor methods do not exist.

- [ ] **Step 3: Add the wire types** — in `electron-app/src/main/services/sidecar/sidecarProtocol.ts`, add after `ScanGateResponseWire`:

```typescript
export interface LakeSymbolWire {
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
```

Extend the `SidecarResponseWire` union to add the three:

```typescript
export type SidecarResponseWire =
  | ComputeResponseWire
  | PersistCandlesResponseWire
  | WatchlistResponseWire
  | ScanGateResponseWire
  | LakeSymbolsResponseWire
  | LakeCandlesResponseWire
  | BenchmarkComputeResponseWire;
```

Extend the `SidecarRequestWire` union to add the four:

```typescript
export type SidecarRequestWire =
  | { type: "compute"; id: number; symbol: string; timeframe: string; closes: number[] }
  | { type: "persist_candles"; id: number; symbol: string; timeframe: string; source: string; candles: CandleWire[] }
  | { type: "add_watchlist_symbol"; id: number; symbol: string }
  | { type: "remove_watchlist_symbol"; id: number; symbol: string }
  | { type: "list_watchlist"; id: number }
  | { type: "evaluate_scan_gate"; id: number; symbol: string; confluence: ConfluenceWire }
  | { type: "list_lake_symbols"; id: number }
  | { type: "read_lake_candles"; id: number; symbol: string; timeframe: string; source: string }
  | { type: "benchmark_compute"; id: number; symbol: string; timeframe: string; horizon: string; candles: CandleWire[] }
  | { type: "evaluate_scan_gate_stateless"; id: number; prev: ConfluenceWire | null; curr: ConfluenceWire };
```

- [ ] **Step 4: Add the supervisor methods** — in `electron-app/src/main/services/sidecar/sidecarSupervisor.ts`, extend the import from `./sidecarProtocol` to add `BenchmarkComputeResponseWire`, `LakeCandlesResponseWire`, `LakeSymbolsResponseWire`, then add the four methods after `evaluateScanGate`:

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

- [ ] **Step 5: Run the tests + typecheck to verify they pass**

Run (from `electron-app/`): `npx vitest run test/main/services/sidecar/ && npm run typecheck`
Expected: PASS — all sidecar protocol/supervisor tests (new and pre-existing) and a clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/services/sidecar/sidecarProtocol.ts electron-app/src/main/services/sidecar/sidecarSupervisor.ts electron-app/test/main/services/sidecar/sidecarProtocol.test.ts electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts
git commit -m "feat(electron): mirror benchmark/lake sidecar wire types and methods"
```

---

### Task 7: `benchmarkRunner.ts` pure core — types, constants, and helpers (electron-app)

Create `benchmarkRunner.ts` with the benchmark types, the default constants, and the pure helpers (`horizonForTimeframe`, `defaultCadenceForHorizon`, `defaultLookaheadForHorizon`, `classifyDecision` — the TS mirror of the canonical Rust rule — and `summarize`). `runBenchmark` itself lands in Task 8. Depends on Task 6 (imports the wire types).

**Files:**
- Create: `electron-app/src/main/services/benchmark/benchmarkRunner.ts`
- Create: `electron-app/test/main/services/benchmark/benchmarkRunner.test.ts`

**Interfaces:**
- Consumes (type-only): `AlgoResultWire`, `CandleWire`, `ConfluenceWire` from `../sidecar/sidecarProtocol`; `Conviction`, `Direction` from `../analysis/contracts`; `Horizon` from `../../ipc/rendererApi`.
- Produces: `Outcome`, `BenchmarkCadence`, `DecisionPoint`, `BenchmarkRunParams`, `BenchmarkResult` types; `NEUTRAL_BAND`, `DEFAULT_POSITIONAL_LOOKAHEAD_BARS`, `DEFAULT_INTRADAY_LOOKAHEAD_BARS` consts; `horizonForTimeframe`, `defaultCadenceForHorizon`, `defaultLookaheadForHorizon`, `classifyDecision`, `summarize` functions.

- [ ] **Step 1: Write the failing tests** — create `electron-app/test/main/services/benchmark/benchmarkRunner.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  classifyDecision,
  defaultCadenceForHorizon,
  defaultLookaheadForHorizon,
  horizonForTimeframe,
  summarize,
  NEUTRAL_BAND,
} from "../../../../src/main/services/benchmark/benchmarkRunner";
import type { DecisionPoint } from "../../../../src/main/services/benchmark/benchmarkRunner";

function point(outcome: DecisionPoint["outcome"]): DecisionPoint {
  return {
    frontierIndex: 0,
    ts: 0,
    closeAtFrontier: 1,
    closeAtLookahead: 1,
    realizedReturn: 0,
    direction: "bullish",
    conviction: "low",
    responseText: "",
    algoResults: [],
    confluence: { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 },
    outcome,
  };
}

describe("horizon / cadence / lookahead derivation", () => {
  it("derives positional only for the day timeframe, intraday for everything else", () => {
    expect(horizonForTimeframe("day")).toBe("positional");
    expect(horizonForTimeframe("minute")).toBe("intraday");
    expect(horizonForTimeframe("5minute")).toBe("intraday");
    expect(horizonForTimeframe("15minute")).toBe("intraday");
  });

  it("binds cadence to horizon", () => {
    expect(defaultCadenceForHorizon("positional")).toEqual({ mode: "session_close" });
    expect(defaultCadenceForHorizon("intraday")).toEqual({ mode: "stateless_gate" });
  });

  it("binds lookahead defaults to horizon", () => {
    expect(defaultLookaheadForHorizon("positional")).toBe(5);
    expect(defaultLookaheadForHorizon("intraday")).toBe(30);
  });
});

describe("classifyDecision (TS mirror of algo_core::benchmark_classify)", () => {
  it("scores a directional call by the sign of the realized return", () => {
    expect(classifyDecision("bullish", 0.05)).toBe("correct");
    expect(classifyDecision("bullish", -0.05)).toBe("incorrect");
    expect(classifyDecision("bearish", -0.05)).toBe("correct");
  });

  it("scores a neutral call neutral regardless of magnitude", () => {
    expect(classifyDecision("neutral", 0.42)).toBe("neutral");
    expect(classifyDecision("neutral", -0.42)).toBe("neutral");
  });

  it("scores a within-band or band-edge directional call neutral (inclusive)", () => {
    expect(classifyDecision("bullish", 0.0005)).toBe("neutral");
    expect(classifyDecision("bullish", NEUTRAL_BAND)).toBe("neutral");
  });
});

describe("summarize", () => {
  it("counts each outcome and excludes neutral from the hit-rate", () => {
    const result = summarize([point("correct"), point("correct"), point("incorrect"), point("neutral")]);
    expect(result).toEqual({ correct: 2, incorrect: 1, neutral: 1, hitRate: 2 / 3 });
  });

  it("returns a null hit-rate when there are zero directional outcomes", () => {
    expect(summarize([]).hitRate).toBeNull();
    expect(summarize([point("neutral"), point("neutral")]).hitRate).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `electron-app/`): `npx vitest run test/main/services/benchmark/benchmarkRunner.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the pure core** — create `electron-app/src/main/services/benchmark/benchmarkRunner.ts`:

```typescript
import type { AlgoResultWire, CandleWire, ConfluenceWire } from "../sidecar/sidecarProtocol";
import type { Conviction, Direction } from "../analysis/contracts";
import type { Horizon } from "../../ipc/rendererApi";

export type Outcome = "correct" | "incorrect" | "neutral";

export type BenchmarkCadence =
  | { mode: "session_close" }
  | { mode: "stateless_gate" }
  | { mode: "manual"; everyN: number };

export interface DecisionPoint {
  frontierIndex: number;
  ts: number;
  closeAtFrontier: number;
  closeAtLookahead: number;
  realizedReturn: number;
  direction: Direction;
  conviction: Conviction;
  responseText: string;
  algoResults: AlgoResultWire[];
  confluence: ConfluenceWire;
  outcome: Outcome;
}

export interface BenchmarkRunParams {
  symbol: string;
  timeframe: string;
  source: string;
  horizon: Horizon;
  cadence: BenchmarkCadence;
  lookaheadBars: number;
  fromTs: number;
  toTs: number;
}

export interface BenchmarkResult {
  params: BenchmarkRunParams;
  candles: CandleWire[];
  decisionPoints: DecisionPoint[];
}

export const NEUTRAL_BAND = 0.001; // mirrors algo_core::benchmark_classify::DEFAULT_NEUTRAL_BAND
export const DEFAULT_POSITIONAL_LOOKAHEAD_BARS = 5; // ~1 trading week of day bars
export const DEFAULT_INTRADAY_LOOKAHEAD_BARS = 30; // ~30 minute bars

export function horizonForTimeframe(timeframe: string): Horizon {
  // Community-archive intraday data is stored under "minute", not "5minute", so
  // map any non-"day" timeframe to intraday rather than assuming "5minute".
  return timeframe === "day" ? "positional" : "intraday";
}

export function defaultCadenceForHorizon(horizon: Horizon): BenchmarkCadence {
  return horizon === "positional" ? { mode: "session_close" } : { mode: "stateless_gate" };
}

export function defaultLookaheadForHorizon(horizon: Horizon): number {
  return horizon === "positional" ? DEFAULT_POSITIONAL_LOOKAHEAD_BARS : DEFAULT_INTRADAY_LOOKAHEAD_BARS;
}

export function classifyDecision(direction: Direction, realizedReturn: number, neutralBand: number = NEUTRAL_BAND): Outcome {
  if (direction === "neutral") return "neutral";
  if (Math.abs(realizedReturn) <= neutralBand) return "neutral";
  const matches = direction === "bullish" ? realizedReturn > 0 : realizedReturn < 0;
  return matches ? "correct" : "incorrect";
}

export function summarize(points: DecisionPoint[]): { correct: number; incorrect: number; neutral: number; hitRate: number | null } {
  const correct = points.filter((p) => p.outcome === "correct").length;
  const incorrect = points.filter((p) => p.outcome === "incorrect").length;
  const neutral = points.filter((p) => p.outcome === "neutral").length;
  const denom = correct + incorrect;
  return { correct, incorrect, neutral, hitRate: denom === 0 ? null : correct / denom };
}
```

- [ ] **Step 4: Run the tests + typecheck to verify they pass**

Run (from `electron-app/`): `npx vitest run test/main/services/benchmark/benchmarkRunner.test.ts && npm run typecheck`
Expected: PASS — all helper/classify/summarize tests and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/benchmark/benchmarkRunner.ts electron-app/test/main/services/benchmark/benchmarkRunner.test.ts
git commit -m "feat(electron): benchmark runner pure core (types, constants, classify, summarize)"
```

---

### Task 8: `runBenchmark` — the frontier walk (electron-app)

Add the one-shot orchestrator `runBenchmark(deps, params)` to `benchmarkRunner.ts`: a DI'd async function (mirrors `scanScheduler.ts`'s injection discipline; a function, not a class, since a run is a single invocation with no resident state) that reads the sourced series once, slices to the working range, walks frontiers per cadence, breaks at the lookahead boundary, and builds a `DecisionPoint` at each decision frontier using the reused `generateDeterministicResponse` and the TS `classifyDecision`. Depends on Task 7.

**Files:**
- Modify: `electron-app/src/main/services/benchmark/benchmarkRunner.ts`
- Modify: `electron-app/test/main/services/benchmark/benchmarkRunner.test.ts`

**Interfaces:**
- Consumes: `Pick<SidecarSupervisor, "readLakeCandles" | "benchmarkCompute" | "evaluateScanGateStateless">`; `generateDeterministicResponse` (reused unchanged); `AnalysisEnvelope`.
- Produces: `BenchmarkRunnerDeps` interface; `runBenchmark(deps: BenchmarkRunnerDeps, params: BenchmarkRunParams): Promise<BenchmarkResult>`.

> **Partial-result contract (documented judgment call — see the tension note at the end of this plan).** `BenchmarkResult` stays exactly `{ params, candles, decisionPoints }` (P6§18 binding — no status field). The initial `readLakeCandles` rejection propagates (rejects the whole run; the view shows a load error). A mid-walk rejection from `benchmarkCompute`/`evaluateScanGateStateless` is **caught**, the walk stops, and `runBenchmark` **resolves** with the partial `BenchmarkResult` collected so far, logging the failure via `console.error` — so partials are preserved (P6§13's load-bearing requirement) and survive the IPC boundary (a rejected promise's partial payload would not).

- [ ] **Step 1: Write the failing tests** — append to `electron-app/test/main/services/benchmark/benchmarkRunner.test.ts`. First extend the imports at the top of the file to add `runBenchmark` and the wire type, and `vi`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { runBenchmark } from "../../../../src/main/services/benchmark/benchmarkRunner";
import type { BenchmarkRunnerDeps } from "../../../../src/main/services/benchmark/benchmarkRunner";
import type { CandleWire, ConfluenceWire } from "../../../../src/main/services/sidecar/sidecarProtocol";
```

Then append the walk tests:

```typescript
const BULLISH: ConfluenceWire = { bullish_count: 8, bearish_count: 1, neutral_count: 1, weighted_vote: 0.5 };

function seriesOf(closes: number[]): CandleWire[] {
  return closes.map((close, i) => ({ ts: 1_000 + i, open: close, high: close, low: close, close, volume: 100 }));
}

function baseParams(overrides: Partial<import("../../../../src/main/services/benchmark/benchmarkRunner").BenchmarkRunParams> = {}) {
  return {
    symbol: "NSE:INFY",
    timeframe: "day",
    source: "bhavcopy",
    horizon: "positional" as const,
    cadence: { mode: "session_close" as const },
    lookaheadBars: 1,
    fromTs: 0,
    toTs: 1e12,
    ...overrides,
  };
}

describe("runBenchmark frontier walk", () => {
  it("positional session_close produces one decision point per eligible bar", async () => {
    const benchmarkCompute = vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH });
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12, 13, 14, 15, 16, 17]) }),
        benchmarkCompute,
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const result = await runBenchmark(deps, baseParams({ lookaheadBars: 3 }));
    // N=8, L=3, break when i+3>=8 -> i in 0..4 -> 5 decision points.
    expect(result.decisionPoints).toHaveLength(5);
    expect(benchmarkCompute).toHaveBeenCalledTimes(5);
  });

  it("intraday stateless_gate cadence is gate-driven and threads prev/curr", async () => {
    const closes = [10, 11, 12, 13, 14, 15]; // N=6, L=2 -> eligible i in 0..3
    const perFrontier: ConfluenceWire[] = closes.map((_, i) => ({ bullish_count: i, bearish_count: 0, neutral_count: 1, weighted_vote: 0.5 }));
    const decisions = ["WorthLook", "NoChange", "WorthAiCall", "NoChange"];
    let gateCall = 0;
    const gateArgs: Array<{ prev: ConfluenceWire | null; curr: ConfluenceWire }> = [];
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf(closes) }),
        benchmarkCompute: vi.fn().mockImplementation((_s, _t, _h, window: CandleWire[]) =>
          Promise.resolve({ type: "benchmark_compute", id: 1, algo_results: [], confluence: perFrontier[window.length - 1] }),
        ),
        evaluateScanGateStateless: vi.fn().mockImplementation((prev: ConfluenceWire | null, curr: ConfluenceWire) => {
          gateArgs.push({ prev, curr });
          return Promise.resolve({ type: "scan_gate", id: 1, decision: decisions[gateCall++] });
        }),
      },
    };
    const result = await runBenchmark(deps, baseParams({ horizon: "intraday", cadence: { mode: "stateless_gate" }, lookaheadBars: 2 }));
    expect(result.decisionPoints.map((p) => p.frontierIndex)).toEqual([0, 2]);
    expect(gateArgs[0].prev).toBeNull();
    expect(gateArgs[1].prev).toEqual(gateArgs[0].curr);
    expect(gateArgs[2].prev).toEqual(gateArgs[1].curr);
  });

  it("manual everyN stride produces decision points only at every Nth index", async () => {
    const benchmarkCompute = vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH });
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]) }),
        benchmarkCompute,
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const result = await runBenchmark(deps, baseParams({ cadence: { mode: "manual", everyN: 3 }, lookaheadBars: 2 }));
    // N=10, L=2 -> eligible i in 0..7; every 3rd -> i in {0,3,6}.
    expect(result.decisionPoints.map((p) => p.frontierIndex)).toEqual([0, 3, 6]);
    expect(benchmarkCompute).toHaveBeenCalledTimes(3);
  });

  it("skips a zero/negative frontier close without a marker but keeps walking", async () => {
    const benchmarkCompute = vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH });
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, -5, 13, 14, 15]) }),
        benchmarkCompute,
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const result = await runBenchmark(deps, baseParams({ lookaheadBars: 2 }));
    // N=6, L=2 -> eligible i in 0..3; i=2 has close -5 -> skipped.
    expect(result.decisionPoints.map((p) => p.frontierIndex)).toEqual([0, 1, 3]);
    expect(result.candles).toHaveLength(6); // the glitch candle still renders on the chart
  });

  it("stops at the lookahead boundary with no out-of-range read", async () => {
    const benchmarkCompute = vi.fn();
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12]) }),
        benchmarkCompute,
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const result = await runBenchmark(deps, baseParams({ lookaheadBars: 5 }));
    expect(result.decisionPoints).toHaveLength(0);
    expect(benchmarkCompute).not.toHaveBeenCalled();
  });

  it("wires classification exactly against the realized future close", async () => {
    async function outcomeFor(closes: number[]): Promise<string> {
      const deps: BenchmarkRunnerDeps = {
        sidecar: {
          readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf(closes) }),
          benchmarkCompute: vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH }),
          evaluateScanGateStateless: vi.fn(),
        },
      };
      const result = await runBenchmark(deps, baseParams({ lookaheadBars: 1 }));
      return result.decisionPoints[0].outcome;
    }
    expect(await outcomeFor([100, 110])).toBe("correct"); // bullish + +10% future move
    expect(await outcomeFor([100, 90])).toBe("incorrect"); // bullish + -10%
    expect(await outcomeFor([100, 100.05])).toBe("neutral"); // +0.05% within band
  });

  it("preserves partial results on a mid-run sidecar rejection", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let call = 0;
    const benchmarkCompute = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 3) return Promise.reject(new Error("sidecar request 3 timed out"));
      return Promise.resolve({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH });
    });
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12, 13, 14, 15, 16, 17]) }),
        benchmarkCompute,
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const result = await runBenchmark(deps, baseParams({ lookaheadBars: 1 }));
    expect(result.decisionPoints).toHaveLength(2); // the first two frontiers survived
    consoleError.mockRestore();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `electron-app/`): `npx vitest run test/main/services/benchmark/benchmarkRunner.test.ts`
Expected: FAIL — `runBenchmark` / `BenchmarkRunnerDeps` do not exist.

- [ ] **Step 3: Implement `runBenchmark`** — in `electron-app/src/main/services/benchmark/benchmarkRunner.ts`, add these imports at the top (the runtime `generateDeterministicResponse` import is only referenced by `runBenchmark`, so tree-shaking keeps it out of any renderer bundle that imports only the pure helpers):

```typescript
import type { SidecarSupervisor } from "../sidecar/sidecarSupervisor";
import type { AnalysisEnvelope } from "../analysis/contracts";
import { generateDeterministicResponse } from "../analysis/deterministicResponseGenerator";
```

Append the deps interface and the function:

```typescript
export interface BenchmarkRunnerDeps {
  sidecar: Pick<SidecarSupervisor, "readLakeCandles" | "benchmarkCompute" | "evaluateScanGateStateless">;
}

export async function runBenchmark(deps: BenchmarkRunnerDeps, params: BenchmarkRunParams): Promise<BenchmarkResult> {
  const { candles } = await deps.sidecar.readLakeCandles(params.symbol, params.timeframe, params.source);
  const series = candles.filter((c) => c.ts >= params.fromTs && c.ts <= params.toTs);
  const decisionPoints: DecisionPoint[] = [];
  let prevConfluence: ConfluenceWire | null = null;

  try {
    for (let i = 0; i < series.length; i++) {
      // Mirror run_replay's boundary: stop once no future bar exists at i+lookahead.
      if (i + params.lookaheadBars >= series.length) break;

      let compute: { algo_results: AlgoResultWire[]; confluence: ConfluenceWire } | null = null;
      let isDecisionPoint = false;

      if (params.cadence.mode === "session_close") {
        compute = await deps.sidecar.benchmarkCompute(params.symbol, params.timeframe, params.horizon, series.slice(0, i + 1));
        isDecisionPoint = true;
      } else if (params.cadence.mode === "manual") {
        if (i % params.cadence.everyN === 0) {
          compute = await deps.sidecar.benchmarkCompute(params.symbol, params.timeframe, params.horizon, series.slice(0, i + 1));
          isDecisionPoint = true;
        }
      } else {
        // stateless_gate: compute every frontier to feed the gate, thread the
        // per-run prevConfluence (never persisted -- a benchmark can never
        // corrupt the live scanner's scan_snapshots gate memory).
        compute = await deps.sidecar.benchmarkCompute(params.symbol, params.timeframe, params.horizon, series.slice(0, i + 1));
        const gate = await deps.sidecar.evaluateScanGateStateless(prevConfluence, compute.confluence);
        prevConfluence = compute.confluence;
        isDecisionPoint = gate.decision !== "NoChange";
      }

      if (!isDecisionPoint || compute === null) continue;

      const closeAtFrontier = series[i].close;
      // Mirror run_replay's `current <= 0.0 -> continue`: a data glitch produces
      // no marker, but the candle still renders (it stays in `series`).
      if (closeAtFrontier <= 0) continue;

      const envelope: AnalysisEnvelope = {
        trigger: "reactive",
        instrument: { symbol: params.symbol, exchange: params.symbol.split(":")[0] ?? "", segment: "", kite_token_asof: "" },
        horizon_requested: params.horizon,
        intent_lens: "buying",
        algo_results: compute.algo_results,
        confluence: compute.confluence,
        overlays: {},
      };
      const { direction, conviction, text } = generateDeterministicResponse(envelope);
      const closeAtLookahead = series[i + params.lookaheadBars].close;
      const realizedReturn = (closeAtLookahead - closeAtFrontier) / closeAtFrontier;

      decisionPoints.push({
        frontierIndex: i,
        ts: series[i].ts,
        closeAtFrontier,
        closeAtLookahead,
        realizedReturn,
        direction,
        conviction,
        responseText: text,
        algoResults: compute.algo_results,
        confluence: compute.confluence,
        outcome: classifyDecision(direction, realizedReturn),
      });
    }
  } catch (error) {
    // A mid-walk sidecar rejection stops the walk but preserves the partial run
    // (P6§13); the initial readLakeCandles rejection is outside this try and
    // rejects the whole run.
    console.error(`benchmark: run stopped early: ${(error as Error).message}`);
  }

  return { params, candles: series, decisionPoints };
}
```

- [ ] **Step 4: Run the tests + typecheck to verify they pass**

Run (from `electron-app/`): `npx vitest run test/main/services/benchmark/benchmarkRunner.test.ts && npm run typecheck`
Expected: PASS — all seven walk tests plus the Task-7 helper tests, and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/benchmark/benchmarkRunner.ts electron-app/test/main/services/benchmark/benchmarkRunner.test.ts
git commit -m "feat(electron): runBenchmark frontier walk with cadence and lookahead"
```

---

### Task 9: `benchmarkBridge.ts` + `rendererApi` + bootstrap wiring (electron-app)

Add the IPC bridge (three channels: `benchmark:listLakeSymbols`, `benchmark:runBenchmark`, `benchmark:copyToClipboard`) mirroring `historyBridge.ts`/`settingsBridge.ts`'s DI pattern, extend the main-window `RendererApi`/`buildRendererApi` with the two data methods plus `copyBenchmarkResult`, register the bridge once in `bootstrap.ts`, and add `testBridge.ts` defaults. Depends on Task 8 (`runBenchmark`, `horizonForTimeframe`).

**Files:**
- Create: `electron-app/src/main/ipc/benchmarkBridge.ts`
- Modify: `electron-app/src/main/ipc/rendererApi.ts`
- Modify: `electron-app/src/main/bootstrap.ts`
- Modify: `electron-app/test/renderer/testBridge.ts`
- Create: `electron-app/test/main/ipc/benchmarkBridge.test.ts`

**Interfaces:**
- Consumes: `runBenchmark`, `horizonForTimeframe` (Task 8); `Pick<SidecarSupervisor, "listLakeSymbols" | "readLakeCandles" | "benchmarkCompute" | "evaluateScanGateStateless">`; Electron `clipboard`.
- Produces:
  - `registerBenchmarkBridge(deps: BenchmarkBridgeDeps): void` (`ipcMain` + `sidecar`).
  - `rendererApi.ts`: `LakeSymbolEntry` interface, benchmark type re-exports, `RendererApi.listLakeSymbols`/`runBenchmark`/`copyBenchmarkResult`, and their `buildRendererApi` wiring.
  - `bootstrap.ts`: `registerBenchmarkBridge({ ipcMain, sidecar: supervisor })` at `createApp()`'s top level.
  - `testBridge.ts`: `listLakeSymbols`/`runBenchmark`/`copyBenchmarkResult` defaults.

- [ ] **Step 1: Write the failing test** — create `electron-app/test/main/ipc/benchmarkBridge.test.ts` (mirrors `settingsBridge.test.ts`'s `Map`-of-handlers harness; mocks Electron's `clipboard` at the module boundary):

```typescript
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));

import { registerBenchmarkBridge } from "../../../src/main/ipc/benchmarkBridge";

function harness(sidecar: {
  listLakeSymbols: ReturnType<typeof vi.fn>;
  readLakeCandles: ReturnType<typeof vi.fn>;
  benchmarkCompute: ReturnType<typeof vi.fn>;
  evaluateScanGateStateless: ReturnType<typeof vi.fn>;
}) {
  const handlers = new Map<string, (event: unknown, arg: unknown) => unknown>();
  registerBenchmarkBridge({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn as never) } as never,
    sidecar: sidecar as never,
  });
  return handlers;
}

function idleSidecar() {
  return {
    listLakeSymbols: vi.fn(),
    readLakeCandles: vi.fn(),
    benchmarkCompute: vi.fn(),
    evaluateScanGateStateless: vi.fn(),
  };
}

describe("registerBenchmarkBridge", () => {
  it("maps the snake_case wire to the camelCase app type and attaches the derived horizon", async () => {
    const sidecar = idleSidecar();
    sidecar.listLakeSymbols.mockResolvedValue({
      type: "lake_symbols",
      id: 1,
      entries: [
        { symbol: "NSE:INFY", timeframe: "day", source: "bhavcopy", from_ts: 100, to_ts: 200, candle_count: 3 },
        { symbol: "NSE:BANKNIFTY", timeframe: "minute", source: "kaggle", from_ts: 10, to_ts: 20, candle_count: 5 },
      ],
    });
    const handlers = harness(sidecar);
    const entries = (await handlers.get("benchmark:listLakeSymbols")!(null, undefined)) as Array<Record<string, unknown>>;
    expect(entries[0]).toEqual({ symbol: "NSE:INFY", timeframe: "day", source: "bhavcopy", fromTs: 100, toTs: 200, candleCount: 3, horizon: "positional" });
    expect(entries[1].horizon).toBe("intraday");
  });

  it("forwards params to runBenchmark with the injected sidecar and returns its BenchmarkResult", async () => {
    const sidecar = idleSidecar();
    // runBenchmark reads the lake first; an empty read yields an empty walk.
    sidecar.readLakeCandles.mockResolvedValue({ type: "lake_candles", id: 1, candles: [] });
    const handlers = harness(sidecar);
    const params = {
      symbol: "NSE:INFY",
      timeframe: "day",
      source: "bhavcopy",
      horizon: "positional",
      cadence: { mode: "session_close" },
      lookaheadBars: 5,
      fromTs: 0,
      toTs: 1e12,
    };
    const result = (await handlers.get("benchmark:runBenchmark")!({}, params)) as { params: unknown; decisionPoints: unknown[] };
    expect(sidecar.readLakeCandles).toHaveBeenCalledWith("NSE:INFY", "day", "bhavcopy");
    expect(result.params).toEqual(params);
    expect(result.decisionPoints).toHaveLength(0);
  });

  it("writes the copy-raw text to the clipboard", async () => {
    const { clipboard } = await import("electron");
    const handlers = harness(idleSidecar());
    await handlers.get("benchmark:copyToClipboard")!({}, "raw-json-blob");
    expect(clipboard.writeText).toHaveBeenCalledWith("raw-json-blob");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `electron-app/`): `npx vitest run test/main/ipc/benchmarkBridge.test.ts`
Expected: FAIL — `benchmarkBridge.ts` does not exist.

- [ ] **Step 3: Implement `benchmarkBridge.ts`** — create `electron-app/src/main/ipc/benchmarkBridge.ts`:

```typescript
import { clipboard, type IpcMain } from "electron";
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
  deps.ipcMain.handle("benchmark:copyToClipboard", (_event, text: string) => clipboard.writeText(text));
}
```

- [ ] **Step 4: Extend `rendererApi.ts`** — in `electron-app/src/main/ipc/rendererApi.ts`:

Add the benchmark type re-exports and the `LakeSymbolEntry` app type near the other exported types (after the `Horizon` type):

```typescript
export type { BenchmarkCadence, Outcome, DecisionPoint, BenchmarkRunParams, BenchmarkResult } from "../services/benchmark/benchmarkRunner";
import type { BenchmarkRunParams, BenchmarkResult } from "../services/benchmark/benchmarkRunner";

export interface LakeSymbolEntry {
  symbol: string;
  timeframe: string;
  source: string;
  fromTs: number;
  toTs: number;
  candleCount: number;
  horizon: Horizon; // derived from timeframe in the bridge
}
```

Add three methods to the `RendererApi` interface (after `getSession`):

```typescript
  listLakeSymbols(): Promise<LakeSymbolEntry[]>;
  runBenchmark(params: BenchmarkRunParams): Promise<BenchmarkResult>;
  copyBenchmarkResult(text: string): Promise<void>;
```

Add the wiring to `buildRendererApi`'s returned object (after `getSession`):

```typescript
    listLakeSymbols: () => invoke("benchmark:listLakeSymbols") as Promise<LakeSymbolEntry[]>,
    runBenchmark: (params) => invoke("benchmark:runBenchmark", params) as Promise<BenchmarkResult>,
    copyBenchmarkResult: (text) => invoke("benchmark:copyToClipboard", text) as Promise<void>,
```

- [ ] **Step 5: Wire `bootstrap.ts`** — in `electron-app/src/main/bootstrap.ts`, add the import alongside the other bridge imports:

```typescript
import { registerBenchmarkBridge } from "./ipc/benchmarkBridge";
```

and register it once at `createApp()`'s top-level bridge-registration block (after `registerSettingsBridge(...)`):

```typescript
  registerBenchmarkBridge({ ipcMain, sidecar: supervisor });
```

- [ ] **Step 6: Add `testBridge.ts` defaults** — in `electron-app/test/renderer/testBridge.ts`, add to the `bridge` object literal (before `...overrides`):

```typescript
    listLakeSymbols: vi.fn().mockResolvedValue([]),
    runBenchmark: vi.fn().mockResolvedValue({
      params: {
        symbol: "NSE:INFY",
        timeframe: "day",
        source: "bhavcopy",
        horizon: "positional",
        cadence: { mode: "session_close" },
        lookaheadBars: 5,
        fromTs: 0,
        toTs: 0,
      },
      candles: [],
      decisionPoints: [],
    }),
    copyBenchmarkResult: vi.fn().mockResolvedValue(undefined),
```

- [ ] **Step 7: Run the test + typecheck to verify they pass**

Run (from `electron-app/`): `npx vitest run test/main/ipc/benchmarkBridge.test.ts && npm run typecheck`
Expected: PASS — the three bridge tests and a clean typecheck (the `RendererApi`/`testBridge` extensions line up; `bootstrap.ts` compiles with the new registration).

- [ ] **Step 8: Commit**

```bash
git add electron-app/src/main/ipc/benchmarkBridge.ts electron-app/src/main/ipc/rendererApi.ts electron-app/src/main/bootstrap.ts electron-app/test/renderer/testBridge.ts electron-app/test/main/ipc/benchmarkBridge.test.ts
git commit -m "feat(electron): benchmark IPC bridge, rendererApi methods, bootstrap wiring"
```

---

### Task 10: `lightweight-charts` dependency + `benchmarkChart.ts` (electron-app)

Add the `lightweight-charts` npm dependency and a thin, responsibility-named wrapper: a candlestick series + volume histogram over `result.candles`, a markers overlay (one per decision point, colored by outcome, arrow-shaped by direction) via the v5 `createSeriesMarkers` primitive, and a click callback matching a marker's `time` back to its `DecisionPoint`. The wrapper exposes a `dispose()` for React unmount. The library satisfies the existing CSP with **no** exception (bundled `script-src 'self'`, zero network, canvas + JS-assigned styles). Depends on Task 9 (imports the `DecisionPoint`/`Outcome`/`BenchmarkResult` types via `rendererApi`).

**Files:**
- Modify: `electron-app/package.json`
- Create: `electron-app/src/renderer/benchmarkChart.ts`
- Create: `electron-app/test/renderer/benchmarkChart.test.ts`

**Interfaces:**
- Consumes (type-only): `BenchmarkResult`, `DecisionPoint`, `Outcome` from `../main/ipc/rendererApi`; `CandleWire` from `../main/services/sidecar/sidecarProtocol`; `lightweight-charts` `createChart`/`CandlestickSeries`/`HistogramSeries`/`createSeriesMarkers`.
- Produces: `createBenchmarkChart(container, result, onSelect): BenchmarkChartHandle` with `dispose()`.

- [ ] **Step 1: Add the dependency** — in `electron-app/package.json`, add to `dependencies` (keep alphabetical among its neighbors):

```json
    "lightweight-charts": "^5.0.0",
```

Then install (from `electron-app/`): `npm install`
Expected: `lightweight-charts@5.x` resolves and the lockfile updates; no build errors.

- [ ] **Step 2: Write the failing test** — create `electron-app/test/renderer/benchmarkChart.test.ts`:

```typescript
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const createSeriesMarkers = vi.fn();
const remove = vi.fn();
const addSeries = vi.fn(() => ({ setData: vi.fn() }));
const subscribeClick = vi.fn();

vi.mock("lightweight-charts", () => ({
  createChart: vi.fn(() => ({ addSeries, subscribeClick, remove })),
  CandlestickSeries: "Candlestick",
  HistogramSeries: "Histogram",
  createSeriesMarkers,
}));

import { createBenchmarkChart } from "../../src/renderer/benchmarkChart";
import type { BenchmarkResult } from "../../src/main/ipc/rendererApi";

function resultWith(outcomes: Array<BenchmarkResult["decisionPoints"][number]["outcome"]>): BenchmarkResult {
  return {
    params: {
      symbol: "NSE:INFY",
      timeframe: "day",
      source: "bhavcopy",
      horizon: "positional",
      cadence: { mode: "session_close" },
      lookaheadBars: 5,
      fromTs: 0,
      toTs: 0,
    },
    candles: [{ ts: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }],
    decisionPoints: outcomes.map((outcome, i) => ({
      frontierIndex: i,
      ts: i + 1,
      closeAtFrontier: 1,
      closeAtLookahead: 1,
      realizedReturn: 0,
      direction: outcome === "incorrect" ? "bearish" : "bullish",
      conviction: "medium",
      responseText: "",
      algoResults: [],
      confluence: { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 },
      outcome,
    })),
  };
}

describe("createBenchmarkChart", () => {
  it("passes one marker per decision point with a color matching each outcome", () => {
    createSeriesMarkers.mockClear();
    const container = document.createElement("div");
    createBenchmarkChart(container, resultWith(["correct", "incorrect", "neutral"]), () => {});
    const markers = createSeriesMarkers.mock.calls[0][1] as Array<{ color: string }>;
    expect(markers).toHaveLength(3);
    expect(markers.map((m) => m.color)).toEqual(["#26a69a", "#ef5350", "#9e9e9e"]);
  });

  it("dispose() removes the chart", () => {
    remove.mockClear();
    const container = document.createElement("div");
    const handle = createBenchmarkChart(container, resultWith([]), () => {});
    handle.dispose();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run (from `electron-app/`): `npx vitest run test/renderer/benchmarkChart.test.ts`
Expected: FAIL — `benchmarkChart.ts` does not exist.

- [ ] **Step 4: Implement `benchmarkChart.ts`** — create `electron-app/src/renderer/benchmarkChart.ts`:

```typescript
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  createSeriesMarkers,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { BenchmarkResult, DecisionPoint, Outcome } from "../main/ipc/rendererApi";
import type { CandleWire } from "../main/services/sidecar/sidecarProtocol";

const OUTCOME_COLOR: Record<Outcome, string> = {
  correct: "#26a69a",
  incorrect: "#ef5350",
  neutral: "#9e9e9e",
};

export interface BenchmarkChartHandle {
  dispose(): void;
}

function markerFor(point: DecisionPoint): SeriesMarker<Time> {
  const bullish = point.direction === "bullish";
  const bearish = point.direction === "bearish";
  return {
    time: point.ts as UTCTimestamp,
    position: bullish ? "belowBar" : bearish ? "aboveBar" : "inBar",
    color: OUTCOME_COLOR[point.outcome],
    shape: bullish ? "arrowUp" : bearish ? "arrowDown" : "circle",
  };
}

export function createBenchmarkChart(
  container: HTMLElement,
  result: BenchmarkResult,
  onSelect: (point: DecisionPoint | null) => void,
): BenchmarkChartHandle {
  const chart = createChart(container, { autoSize: true });

  const candleSeries = chart.addSeries(CandlestickSeries);
  candleSeries.setData(
    result.candles.map((c: CandleWire) => ({
      time: c.ts as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    })),
  );

  const volumeSeries = chart.addSeries(HistogramSeries, { priceScaleId: "volume" });
  volumeSeries.setData(result.candles.map((c: CandleWire) => ({ time: c.ts as UTCTimestamp, value: c.volume })));

  createSeriesMarkers(candleSeries, result.decisionPoints.map(markerFor));

  const byTime = new Map<number, DecisionPoint>(result.decisionPoints.map((p) => [p.ts, p]));
  chart.subscribeClick((param) => {
    const time = param.time as number | undefined;
    onSelect(time === undefined ? null : byTime.get(time) ?? null);
  });

  return {
    dispose(): void {
      chart.remove();
    },
  };
}
```

> **Note for the implementer:** the exact `lightweight-charts` v5 method names above (`addSeries(CandlestickSeries, …)`, `createSeriesMarkers`, `subscribeClick`) are the current v5 primitives named by the master design. The unit test mocks the module at its boundary, so it validates the wrapper's marker mapping, not the library's runtime; confirm the real render in the manual checklist. If a v5 signature differs at install time, adjust the wrapper (not the test's marker-count/color assertions).

- [ ] **Step 5: Run the test + typecheck to verify they pass**

Run (from `electron-app/`): `npx vitest run test/renderer/benchmarkChart.test.ts && npm run typecheck`
Expected: PASS — the marker-count/color test and the dispose test, and a clean typecheck (the `lightweight-charts` types resolve after install).

- [ ] **Step 6: Commit**

```bash
git add electron-app/package.json electron-app/package-lock.json electron-app/src/renderer/benchmarkChart.ts electron-app/test/renderer/benchmarkChart.test.ts
git commit -m "feat(electron): lightweight-charts benchmark chart wrapper with outcome markers"
```

---

### Task 11: `BenchmarkView.tsx` + `App.tsx` nav (electron-app)

The renderer screen: setup (pick a lake entry → read-only derived horizon, prefilled cadence with a manual override toggle, adjustable lookahead, a date sub-range) → run → results (chart + thin summary strip + marker popover + copy-raw). Reached via a new top-level "Benchmark" nav button (a peer of the chat home, not a session child, not a second window). Engine-Only only — no response-mode picker. Decision-point prose renders through the existing DOMPurify markdown path (`MessageMarkdown`). Depends on Task 9 (`api` methods, `LakeSymbolEntry`, pure helpers) and Task 10 (`createBenchmarkChart`).

**Files:**
- Create: `electron-app/src/renderer/BenchmarkView.tsx`
- Modify: `electron-app/src/renderer/App.tsx`
- Create: `electron-app/test/renderer/BenchmarkView.test.tsx`

**Interfaces:**
- Consumes: `Pick<RendererApi, "listLakeSymbols" | "runBenchmark" | "copyBenchmarkResult">`; `summarize`, `defaultCadenceForHorizon`, `defaultLookaheadForHorizon` (benchmarkRunner); `createBenchmarkChart` (Task 10); `MessageMarkdown`; `LakeSymbolEntry`, `BenchmarkResult`, `DecisionPoint`, `BenchmarkRunParams`, `BenchmarkCadence` types.
- Produces: `BenchmarkView` component; `App.tsx` gains `showBenchmark` state + a "Benchmark" nav button rendering `<BenchmarkView api={bridge()} />` in place of `HomeScreen`.

- [ ] **Step 1: Write the failing test** — create `electron-app/test/renderer/BenchmarkView.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/renderer/benchmarkChart", () => ({ createBenchmarkChart: vi.fn(() => ({ dispose: vi.fn() })) }));

import { BenchmarkView } from "../../src/renderer/BenchmarkView";
import type { BenchmarkResult, LakeSymbolEntry, RendererApi } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);

const DAY_ENTRY: LakeSymbolEntry = {
  symbol: "NSE:INFY",
  timeframe: "day",
  source: "bhavcopy",
  fromTs: 1_690_000_000,
  toTs: 1_710_000_000,
  candleCount: 240,
  horizon: "positional",
};

function api(overrides: Partial<Pick<RendererApi, "listLakeSymbols" | "runBenchmark" | "copyBenchmarkResult">> = {}) {
  return {
    listLakeSymbols: vi.fn().mockResolvedValue([DAY_ENTRY]),
    runBenchmark: vi.fn(),
    copyBenchmarkResult: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function resultWith(outcomes: Array<BenchmarkResult["decisionPoints"][number]["outcome"]>): BenchmarkResult {
  return {
    params: { symbol: "NSE:INFY", timeframe: "day", source: "bhavcopy", horizon: "positional", cadence: { mode: "session_close" }, lookaheadBars: 5, fromTs: 0, toTs: 0 },
    candles: [{ ts: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }],
    decisionPoints: outcomes.map((outcome, i) => ({
      frontierIndex: i,
      ts: i + 1,
      closeAtFrontier: 1,
      closeAtLookahead: 1,
      realizedReturn: 0,
      direction: "bullish",
      conviction: "medium",
      responseText: "",
      algoResults: [],
      confluence: { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 },
      outcome,
    })),
  };
}

describe("BenchmarkView", () => {
  it("shows the no-data message when the lake is empty", async () => {
    render(<BenchmarkView api={api({ listLakeSymbols: vi.fn().mockResolvedValue([]) })} />);
    expect(await screen.findByText(/no data ingested yet/i)).toBeTruthy();
  });

  it("renders each lake entry with its derived horizon and covered range", async () => {
    render(<BenchmarkView api={api()} />);
    const option = await screen.findByRole("button", { name: /NSE:INFY/ });
    expect(option.textContent).toMatch(/day/);
    expect(option.textContent).toMatch(/positional/);
    expect(option.textContent).toMatch(/240/);
  });

  it("prefills the horizon-appropriate cadence and lookahead on selection", async () => {
    render(<BenchmarkView api={api()} />);
    fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));
    const lookahead = (await screen.findByLabelText(/lookahead bars/i)) as HTMLInputElement;
    expect(lookahead.value).toBe("5"); // positional default
    expect(screen.getByText(/session_close/i)).toBeTruthy();
  });

  it("runs the benchmark with the assembled params", async () => {
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(resultWith([])) });
    render(<BenchmarkView api={deps} />);
    fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    await waitFor(() => expect(deps.runBenchmark).toHaveBeenCalledTimes(1));
    expect(deps.runBenchmark.mock.calls[0][0]).toMatchObject({
      symbol: "NSE:INFY",
      timeframe: "day",
      source: "bhavcopy",
      horizon: "positional",
      cadence: { mode: "session_close" },
      lookaheadBars: 5,
    });
  });

  it("renders the summary strip counts and hit-rate after a run", async () => {
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(resultWith(["correct", "correct", "incorrect", "neutral"])) });
    render(<BenchmarkView api={deps} />);
    fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    // 2 correct / (2 correct + 1 incorrect) = 67%.
    expect(await screen.findByText(/67%/)).toBeTruthy();
    expect(screen.getByText(/2 correct/i)).toBeTruthy();
  });

  it("shows a zero-decision-points strip instead of dividing by zero", async () => {
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(resultWith([])) });
    render(<BenchmarkView api={deps} />);
    fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    expect(await screen.findByText(/0 decision points/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `electron-app/`): `npx vitest run test/renderer/BenchmarkView.test.tsx`
Expected: FAIL — `BenchmarkView` does not exist.

- [ ] **Step 3: Implement `BenchmarkView.tsx`** — create `electron-app/src/renderer/BenchmarkView.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { MessageMarkdown } from "./MessageMarkdown";
import { createBenchmarkChart } from "./benchmarkChart";
import { defaultCadenceForHorizon, defaultLookaheadForHorizon, summarize } from "../main/services/benchmark/benchmarkRunner";
import type { BenchmarkCadence, BenchmarkResult, DecisionPoint, LakeSymbolEntry, RendererApi } from "../main/ipc/rendererApi";

type BenchmarkApi = Pick<RendererApi, "listLakeSymbols" | "runBenchmark" | "copyBenchmarkResult">;

function toDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function fromDate(value: string): number {
  return Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 1000);
}

function SummaryStrip({ points }: { points: DecisionPoint[] }): JSX.Element {
  const { correct, incorrect, neutral, hitRate } = summarize(points);
  if (points.length === 0) return <div className="benchmark-summary">0 decision points — nothing to score.</div>;
  const hitRateLabel = hitRate === null ? "—" : `${Math.round(hitRate * 100)}%`;
  return (
    <div className="benchmark-summary">
      {correct} correct / {incorrect} incorrect / {neutral} neutral · hit-rate {hitRateLabel}
    </div>
  );
}

function ResultsView({ api, result }: { api: BenchmarkApi; result: BenchmarkResult }): JSX.Element {
  const chartRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<DecisionPoint | null>(null);

  useEffect(() => {
    const container = chartRef.current;
    if (!container) return;
    const handle = createBenchmarkChart(container, result, setSelected);
    return () => handle.dispose();
  }, [result]);

  return (
    <div className="benchmark-results">
      <SummaryStrip points={result.decisionPoints} />
      <button type="button" onClick={() => void api.copyBenchmarkResult(JSON.stringify(result))}>
        Copy raw result
      </button>
      <div className="benchmark-chart" ref={chartRef} />
      {selected && (
        <aside className="benchmark-popover">
          <h3>
            {selected.direction} ({selected.conviction} conviction) — {selected.outcome}
          </h3>
          <p>
            {selected.closeAtFrontier} → {selected.closeAtLookahead} ({(selected.realizedReturn * 100).toFixed(2)}%)
          </p>
          <p>algos: {selected.algoResults.map((r) => r.algo_id).join(", ")}</p>
          <MessageMarkdown text={selected.responseText} />
        </aside>
      )}
    </div>
  );
}

export function BenchmarkView({ api }: { api: BenchmarkApi }): JSX.Element {
  const [entries, setEntries] = useState<LakeSymbolEntry[] | null>(null);
  const [selected, setSelected] = useState<LakeSymbolEntry | null>(null);
  const [cadence, setCadence] = useState<BenchmarkCadence>({ mode: "session_close" });
  const [manual, setManual] = useState(false);
  const [everyN, setEveryN] = useState(5);
  const [lookaheadBars, setLookaheadBars] = useState(5);
  const [fromTs, setFromTs] = useState(0);
  const [toTs, setToTs] = useState(0);
  const [result, setResult] = useState<BenchmarkResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.listLakeSymbols().then(setEntries);
  }, [api]);

  const onSelectEntry = (entry: LakeSymbolEntry): void => {
    setSelected(entry);
    setManual(false);
    setCadence(defaultCadenceForHorizon(entry.horizon));
    setLookaheadBars(defaultLookaheadForHorizon(entry.horizon));
    setFromTs(entry.fromTs);
    setToTs(entry.toTs);
    setResult(null);
  };

  const onToggleManual = (checked: boolean): void => {
    setManual(checked);
    if (!selected) return;
    setCadence(checked ? { mode: "manual", everyN } : defaultCadenceForHorizon(selected.horizon));
  };

  const onRun = async (): Promise<void> => {
    if (!selected) return;
    setRunning(true);
    setError(null);
    try {
      const effectiveCadence: BenchmarkCadence = manual ? { mode: "manual", everyN } : cadence;
      const run = await api.runBenchmark({
        symbol: selected.symbol,
        timeframe: selected.timeframe,
        source: selected.source,
        horizon: selected.horizon,
        cadence: effectiveCadence,
        lookaheadBars,
        fromTs,
        toTs,
      });
      setResult(run);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  if (entries === null) return <div className="benchmark">Loading lake…</div>;
  if (entries.length === 0) {
    return <div className="benchmark">No data ingested yet — run the `ingest` CLI (see the Phase 6 design, P6§3).</div>;
  }
  if (result) return <ResultsView api={api} result={result} />;

  return (
    <div className="benchmark">
      <h2>Benchmark</h2>
      <ul className="benchmark-picker">
        {entries.map((entry) => (
          <li key={`${entry.symbol}_${entry.timeframe}_${entry.source}`}>
            <button type="button" onClick={() => onSelectEntry(entry)}>
              {entry.symbol} · {entry.timeframe} · {entry.source} · {entry.horizon} · {toDate(entry.fromTs)}–{toDate(entry.toTs)} · {entry.candleCount} bars
            </button>
          </li>
        ))}
      </ul>

      {selected && (
        <form
          className="benchmark-setup"
          onSubmit={(event) => {
            event.preventDefault();
            void onRun();
          }}
        >
          <p>
            Horizon: <strong>{selected.horizon}</strong> (derived from timeframe)
          </p>
          <p>
            Cadence: <strong>{manual ? "manual" : cadence.mode}</strong>
          </p>
          <label>
            <input type="checkbox" checked={manual} onChange={(e) => onToggleManual(e.target.checked)} /> Manual every-N override
          </label>
          {manual && (
            <label>
              Every N bars
              <input type="number" min={1} value={everyN} onChange={(e) => setEveryN(Number(e.target.value))} />
            </label>
          )}
          <label>
            Lookahead bars
            <input type="number" min={1} value={lookaheadBars} onChange={(e) => setLookaheadBars(Number(e.target.value))} />
          </label>
          <label>
            From
            <input type="date" min={toDate(selected.fromTs)} max={toDate(selected.toTs)} value={toDate(fromTs)} onChange={(e) => setFromTs(fromDate(e.target.value))} />
          </label>
          <label>
            To
            <input type="date" min={toDate(selected.fromTs)} max={toDate(selected.toTs)} value={toDate(toTs)} onChange={(e) => setToTs(fromDate(e.target.value))} />
          </label>
          <button type="submit" disabled={running}>
            {running ? "Running…" : "Run benchmark"}
          </button>
          {error && <div className="error">{error}</div>}
        </form>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire the nav into `App.tsx`** — in `electron-app/src/renderer/App.tsx`:

Add the import:

```tsx
import { BenchmarkView } from "./BenchmarkView";
```

Add the state (next to `showModePicker`):

```tsx
  const [showBenchmark, setShowBenchmark] = useState(false);
```

Add the handlers (near `onNewChat`):

```tsx
  const onOpenBenchmark = (): void => {
    setActiveSession(null);
    setSessionDetail(null);
    setShowModePicker(false);
    setShowBenchmark(true);
  };
```

Extend `onBackToHome` to also clear the benchmark view:

```tsx
  const onBackToHome = (): void => {
    setActiveSession(null);
    setSessionDetail(null);
    setShowBenchmark(false);
    void bridge().listSessions().then(setSessions);
  };
```

Render a top-level "Benchmark" button on the home screen, and a "Home" button whenever a session or the benchmark view is active. Replace the existing `{activeSession !== null && (<button ... onBackToHome ...>Home</button>)}` block with:

```tsx
      {(activeSession !== null || showBenchmark) && (
        <button type="button" onClick={onBackToHome}>
          Home
        </button>
      )}
      {activeSession === null && !showModePicker && !showBenchmark && (
        <button type="button" onClick={onOpenBenchmark}>
          Benchmark
        </button>
      )}
```

Gate `HomeScreen` on `!showBenchmark` and render `BenchmarkView` in its place:

```tsx
      {activeSession === null && !showModePicker && !showBenchmark && (
        <HomeScreen sessions={sessions} onNewChat={onNewChat} onOpenSession={onOpenSession} />
      )}
      {activeSession === null && showBenchmark && <BenchmarkView api={bridge()} />}
```

- [ ] **Step 5: Run the tests + typecheck to verify they pass**

Run (from `electron-app/`): `npx vitest run test/renderer/BenchmarkView.test.tsx test/renderer/App.test.tsx && npm run typecheck`
Expected: PASS — the six BenchmarkView tests, the unchanged App tests (the new nav button is additive), and a clean typecheck. Then run the full suite once: `npm test` — expected all green.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/renderer/BenchmarkView.tsx electron-app/src/renderer/App.tsx electron-app/test/renderer/BenchmarkView.test.tsx
git commit -m "feat(electron): BenchmarkView screen and top-level benchmark nav"
```

---

## Manual verification checklist (not a task — never blocks phase completion)

Mirrors P5a§11/P5b§11/P5c§10/P5d§14 and spec P6§15: an automatable golden path plus a live follow-up requiring real ingested data. This is a checklist to run with the `verify` skill after the tasks land, not a task with its own commit.

**Automatable (mocked bridge + `npm start`):**
- The top-level "Benchmark" nav button opens `BenchmarkView`.
- An empty lake shows the "No data ingested yet — run the `ingest` CLI" message (no crash).
- With a stub `listLakeSymbols`, the picker renders entries with their derived horizon and covered date range.
- Selecting an entry prefills the horizon-appropriate cadence (`session_close` for a `day` entry, `stateless_gate` for a `minute` entry) and lookahead default (5 / 30).
- "Run benchmark" against a stub `runBenchmark` renders the chart, the markers, and the summary strip; an all-neutral / zero-point run shows "0 decision points" (no divide-by-zero).
- Clicking a marker opens the popover detail; "Copy raw result" resolves.

**Live follow-ups (real ingested data — never a blocker for calling Phase 6 done):**
- Run `ingest --lake <dir> --mode bhavcopy --exchange NSE --from <d1> --to <d2>` for real over a small weekday range; confirm it exits 0 and appends to `lake_manifest.jsonl`.
- Open the Benchmark screen; confirm `list_symbols` surfaces the ingested symbols with correct covered ranges and bar counts.
- Run a real positional benchmark on a real symbol; eyeball that candlestick, volume, and correct/incorrect/neutral markers land on the right candles and the hit-rate strip is sane.
- Run an intraday benchmark against community-archive (`--mode intraday`) data to confirm the stateless-gate cadence produces a plausible, sparse marker set (not one-per-bar).
- Confirm "Copy raw result" produces valid JSON that round-trips through `JSON.parse` with every decision point's full structured payload (`ts`, `algoResults`, `confluence`, `direction`/`conviction`/`responseText`, `closeAtFrontier`/`closeAtLookahead`/`realizedReturn`, `outcome`) plus the run's `params`.

---

## Self-review

**Spec coverage — every P6§ requirement maps to a task:**
- P6§3 `ingest` CLI → Task 1. P6§4 lake manifest + `list_symbols` (P6§4.1–4.5) → Task 2. P6§5 `benchmark_classify` (P6§5.1) → Task 3. P6§6 sidecar protocol/handlers/routing (P6§6.1–6.4): payloads+handlers → Task 4, enums+`main.rs`+e2e → Task 5. P6§7 TS mirror (P6§7.1–7.3) → Task 6. P6§8 horizon/cadence/lookahead constants → Task 7. P6§9 `benchmarkRunner` (P6§9.1–9.5): pure core → Task 7, frontier walk → Task 8. P6§10 IPC bridge + rendererApi + bootstrap (P6§10.1–10.4) → Task 9. P6§11 renderer (P6§11.1–11.7): chart → Task 10, view+nav → Task 11; P6§11.5 CSP is satisfied unchanged (no CSP file touched in any task); P6§11.6 copy-raw channel → Task 9 (bridge) + Task 11 (button). P6§12 data flow is realized across Tasks 4–11. P6§13 error handling: empty lake (Task 11), lookahead-boundary stop + zero-close skip (Task 8), zero-decision-points strip (Task 11), mid-run rejection partials (Task 8), ingest fetch failure (Task 1). P6§14 testing strategy: every enumerated case appears as real test code (see below). P6§15 → manual checklist. P6§16 tensions are respected (see below). P6§17/P6§20 no-order / out-of-scope: nothing in any task adds order surface or an AI-Assisted mode. P6§18 binding values are copied verbatim into Global Constraints. P6§19 file layout matches the tasks' file lists exactly.

**Every enumerated test case is real test code (not a restated bullet):** P6§4.5 (4 tests) → Task 2 Step 1. P6§5.1 (6 tests) → Task 3 Step 1. P6§6.2 handler tests (5) + P6§6.4 protocol/e2e → Task 4 Step 1/6 and Task 5 Step 1. P6§7.3 → Task 6 Step 1. P6§9.5 (7 walk tests) → Task 8 Step 1; the classifyDecision/summarize mirrors of P6§5.1/P6§11.3 → Task 7 Step 1. P6§10.4 → Task 9 Step 1. P6§11.7 (BenchmarkView + benchmarkChart marker-count/color + summarize) → Task 11 Step 1, Task 10 Step 2, Task 7 Step 1.

**Type/signature consistency across tasks (checked against the real current code):** `AlgoResultWire`/`ConfluenceWire`/`CandleWire` field names match `sidecarProtocol.ts` and `protocol.rs`; `Direction = "bullish"|"bearish"|"neutral"` and `Conviction` come from `contracts.ts`; `AnalysisEnvelope.horizon_requested` accepts `Horizon` (`"intraday"|"positional"`); `generateDeterministicResponse` reads only `confluence`/`algo_results` (verified — envelope's `instrument`/`intent_lens`/`trigger` are placeholders); `context_at(series, i, symbol, timeframe, horizon)`, `run_applicable(&algos, &ctx)`, `all_for_binary()`, `compute_confluence(&outputs, &weights)` signatures match; `StorageError::{Io, Json}` already exist (no new variant); `storage` already depends on `serde`/`serde_json` (no new dep in Task 2); the `run_replay` boundary (`i + horizon_bars >= len → break`, `current <= 0.0 → continue`) is mirrored exactly by the runner; the sidecar `main.rs` store-`None` and `catch_unwind` patterns match the existing `PersistCandles` arm.

**No placeholders:** every step has runnable code, an exact command, and an expected result. The one deliberate best-effort note is the `lightweight-charts` v5 method names in Task 10 (flagged inline; the test mocks the module boundary and the manual checklist confirms the real render).

**Documented judgment calls (details the spec left slightly open):**
1. **Partial-result contract (the notable one).** P6§13 wants a mid-run "stopped early" banner, but P6§18 pins `BenchmarkResult` to exactly `{ params, candles, decisionPoints }` (no status field), and a rejected IPC promise cannot carry a partial payload across the boundary. Resolution: `runBenchmark` **resolves** with the partial `BenchmarkResult` on a mid-walk rejection (the load-bearing "partials not silently discarded" requirement) and logs the failure; the explicit banner is deferred because the binding type has nowhere to express it. The initial `readLakeCandles` rejection still propagates (whole-run error).
2. **`benchmark_empty_response` consolidates the spec's `zeroed_confluence()` sketch** — one constructor (mirroring the existing `empty_response`) serves both the handler's empty-candles branch and `main.rs`'s panic fallback, rather than two zeroed paths.
3. **The handler does not `use algo_core::benchmark_classify`** (the spec showed a decorative import) — the benchmark handler never calls classify, so importing it would be an unused-import warning; `benchmark_classify` stays a pure, independently-tested module (Task 3 is a leaf, decoupled from Task 4).
4. **The renderer imports the pure helpers (`summarize`/`defaultCadenceForHorizon`/`defaultLookaheadForHorizon`) from `benchmarkRunner.ts`** per P6§19's placement; they are pure and tree-shaking keeps `runBenchmark`/`generateDeterministicResponse` out of the renderer bundle.
5. **The `ingest` bin's automated test exercises the no-network `--mode intraday` path** (the bhavcopy fetch is network-only, exercised manually per `io.rs`'s `#[ignore]`d-smoke convention).
6. **`ingest --exchange` takes a single value** (run once per exchange), keeping arg-parsing trivial and mirroring `replay.rs` — as P6§3.1 specifies.





