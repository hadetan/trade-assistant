# Rust Sidecar Core — Implementation Plan (Phase 1 of 7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundational Rust sidecar binary — the `Algorithm` trait and compile-time registry, three real (hand-verifiable) technical indicators, a deterministic confluence-scoring function, the Parquet/DuckDB candle lake and SQLite state store, and the JSON-over-stdio protocol that lets Electron drive all of it — as one self-contained, independently testable artifact with zero Electron/TypeScript/Kite/Claude dependencies.

**Architecture:** A Cargo workspace at `rust-core/` with three crates: `algo-core` (pure logic — the `Algorithm` trait, indicator implementations, the registry, confluence scoring; no I/O, no network, no filesystem), `storage` (the Parquet/DuckDB candle lake and the SQLite mutable-state store), and `sidecar` (the binary — a line-delimited JSON stdio loop that wires the other two crates together into the request/response protocol Electron will speak in Phase 3). This maps directly onto the design doc's process-boundary table (§3) and algorithm contract (§6.1).

**Tech Stack:** Rust (stable, 2021 edition), `serde`/`serde_json` (wire format), `rusqlite` with the `bundled` feature (SQLite state store), `duckdb` (candle lake, reads/writes Parquet via SQL), `inventory` (compile-time algorithm registration), `rayon` (parallel algorithm execution), `chrono` (timestamps).

This phase hand-implements three indicators (SMA, EMA, RSI) directly rather than reaching for the `rust_ti` crate the design doc recommends for the full catalog (§6.2). They're simple enough to write and hand-verify correctly in isolation, and doing so proves the `Algorithm` trait/registry/wrapper pattern end-to-end without taking a dependency on an external crate's exact API before that API has been confirmed against docs.rs. Migrating the rest of the catalog (MACD, ADX, Supertrend, Ichimoku, Bollinger, ATR, and everything else in §6.2) onto `rust_ti` is explicitly out of scope for this phase — see the companion roadmap document, Phase 2 note.

## Global Constraints

- **The app never implements, wires up, or calls any Kite order-placement/modification/cancellation/GTT-write tool** (`place_order`, `modify_order`, `cancel_order`, `place_gtt_order`, `modify_gtt_order`, `delete_gtt_order`) — permanent, applies to every phase, not just this one (design doc §2, §4).
- Rust workspace lives at `rust-core/` inside this repo; stable toolchain, 2021 edition.
- No dynamic plugin loading for algorithms — compile-time registration only, via `inventory` (design doc §6.1).
- Every `Algorithm::compute()` implementation is pure and deterministic: no wall-clock reads, no randomness, no I/O inside `compute()` itself. The evaluation timestamp (`AlgoOutput::computed_at`) always comes from `MarketContext::as_of`, which the caller supplies — the live wall-clock at the I/O boundary in production, or the replay frontier's simulated time during backtest — so `compute()` itself never touches the clock.
- Comment and naming conventions follow `CLAUDE.md` (created in Task 1) — no restating-the-obvious comments, no numbered "1. do X" comment blocks, snake_case for Rust identifiers.
- Once networking is introduced in a later phase, networking crates use `rustls`, never `native-tls`/`openssl` (design doc §11) — noted here since it constrains a `Cargo.toml` dependency choice this phase's tasks don't make, but a later phase's tasks will.

## File Structure

```
trade-assistant/
  CLAUDE.md                              # coding-standards doc (Task 1)
  rust-core/
    Cargo.toml                           # workspace manifest
    crates/
      algo-core/
        Cargo.toml
        src/
          lib.rs                         # re-exports
          algorithm.rs                   # Algorithm trait, AlgoOutput, Direction, Horizon, Timeframe, MarketContext
          registry.rs                    # inventory-based compile-time registry
          confluence.rs                  # ScorecardSummary + compute_confluence()
          indicators/
            mod.rs
            sma.rs
            ema.rs
            rsi.rs
        tests/
          registry_test.rs
          confluence_test.rs
      storage/
        Cargo.toml
        src/
          lib.rs
          candle_store.rs                # Parquet + DuckDB candle lake
          state_store.rs                 # SQLite mutable state (watchlist, etc.)
        tests/
          candle_store_test.rs
          state_store_test.rs
      sidecar/
        Cargo.toml
        src/
          main.rs                        # stdin/stdout loop
          protocol.rs                    # Request/Response wire types + line codec
          handlers.rs                    # dispatches "compute" requests
        tests/
          protocol_test.rs
          end_to_end_test.rs             # spawns the compiled binary, feeds it real fixture candles
```

---

### Task 1: Coding-standards doc + Rust workspace scaffold

**Files:**
- Create: `CLAUDE.md`
- Create: `rust-core/Cargo.toml`
- Create: `rust-core/crates/algo-core/Cargo.toml`
- Create: `rust-core/crates/algo-core/src/lib.rs`
- Create: `rust-core/crates/storage/Cargo.toml`
- Create: `rust-core/crates/storage/src/lib.rs`
- Create: `rust-core/crates/sidecar/Cargo.toml`
- Create: `rust-core/crates/sidecar/src/main.rs`

**Interfaces:**
- Produces: three empty-but-compiling crates (`algo-core`, `storage`, `sidecar`) that every later task adds real code to; `CLAUDE.md`'s conventions apply to all Rust and TypeScript code written in every subsequent phase.

- [ ] **Step 1: Write `CLAUDE.md`**

```markdown
# Coding Conventions — Trade Assistant

## Comments
Default to no comments. Only add one when the *why* isn't obvious from the
code itself: a non-obvious invariant, a workaround for a specific upstream
bug, a formula's source. Never write a comment that just restates what the
next line does, and never write a numbered "1. do X, 2. do Y" comment block
above a function — the function body already says that.

Bad: `// increment counter by one` above `count += 1;`
Good: `// Wilder smoothing, not a simple moving average — see RSI task in
       // docs/superpowers/plans/2026-07-18-rust-sidecar-core-plan.md`
above a smoothing formula that would otherwise look like a bug.

## Naming
- Rust: `snake_case` functions/variables, `PascalCase` types, one clear
  responsibility per file (mirrors the file structure in each plan doc).
- TypeScript (later phases): `camelCase` functions/variables, `PascalCase`
  types/classes, no Hungarian notation, no abbreviations that aren't
  already standard in this codebase's domain (`oi`, `pcr`, `ltp` are fine —
  they're Kite/options-market terms used throughout the design doc).
- File names describe what the file is responsible for, not what kind of
  file it is (`confluence.rs`, not `utils.rs` or `helpers.rs`).

## Structure
- Small, focused files over large ones. If a file starts doing two
  unrelated things, split it.
- Pure logic (no I/O) lives separately from I/O/side-effecting code —
  see `algo-core` (pure) vs `storage`/`sidecar` (I/O) in `rust-core/`.
```

- [ ] **Step 2: Create the Cargo workspace**

`rust-core/Cargo.toml`:
```toml
[workspace]
resolver = "2"
members = [
    "crates/algo-core",
    "crates/storage",
    "crates/sidecar",
]

[workspace.package]
edition = "2021"
```

- [ ] **Step 3: Create the three empty crates**

`rust-core/crates/algo-core/Cargo.toml`:
```toml
[package]
name = "algo-core"
version = "0.1.0"
edition.workspace = true

[dependencies]
chrono = "0.4"
```

`rust-core/crates/algo-core/src/lib.rs`:
```rust
```
(empty file — filled in by Task 2)

`rust-core/crates/storage/Cargo.toml`:
```toml
[package]
name = "storage"
version = "0.1.0"
edition.workspace = true

[dependencies]
rusqlite = { version = "0.31", features = ["bundled"] }
duckdb = { version = "1.0", features = ["bundled"] }
```

`rust-core/crates/storage/src/lib.rs`:
```rust
```
(empty file — filled in by Task 8)

`rust-core/crates/sidecar/Cargo.toml`:
```toml
[package]
name = "sidecar"
version = "0.1.0"
edition.workspace = true

[dependencies]
algo-core = { path = "../algo-core" }
storage = { path = "../storage" }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

`rust-core/crates/sidecar/src/main.rs`:
```rust
fn main() {
    println!("sidecar placeholder");
}
```

- [ ] **Step 4: Verify the workspace builds**

Run: `cd rust-core && cargo build`
Expected: `Compiling algo-core v0.1.0`, `Compiling storage v0.1.0`, `Compiling sidecar v0.1.0`, then `Finished` with no errors.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md rust-core/
git commit -m "chore: scaffold Rust workspace and coding-standards doc"
```

---

### Task 2: `Algorithm` trait, `AlgoOutput`, and core types

**Files:**
- Create: `rust-core/crates/algo-core/src/algorithm.rs`
- Modify: `rust-core/crates/algo-core/src/lib.rs`
- Test: `rust-core/crates/algo-core/tests/registry_test.rs` (a minimal compile/shape test lives here for now; the real registry test arrives in Task 6)

**Interfaces:**
- Produces: `Algorithm` trait, `AlgoOutput` struct, `Direction`/`Horizon`/`Timeframe` enums, `MarketContext` struct (including its `as_of` field), `classify_by_distance()` helper — every later indicator (Tasks 3-5) and the registry/confluence code (Tasks 6-7) depend on these exact names and fields.

- [ ] **Step 1: Write the failing test**

`rust-core/crates/algo-core/tests/registry_test.rs`:
```rust
use algo_core::{Algorithm, AlgoOutput, Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

struct AlwaysBullish;

impl Algorithm for AlwaysBullish {
    fn id(&self) -> &'static str {
        "always_bullish"
    }

    fn required_lookback(&self) -> usize {
        1
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> AlgoOutput {
        AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction: Direction::Bullish,
            magnitude: 1.0,
            confidence: 1.0,
            evidence: vec!["always bullish, by construction".to_string()],
            computed_at: ctx.as_of,
        }
    }
}

#[test]
fn algorithm_trait_is_object_safe_and_computable() {
    let algo = AlwaysBullish;
    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = MarketContext {
        symbol: "NSE:INFY".to_string(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        closes: vec![100.0, 101.0, 102.0],
        as_of,
    };

    let output = algo.compute(&ctx);

    assert_eq!(output.algo_id, "always_bullish");
    assert_eq!(output.symbol, "NSE:INFY");
    assert_eq!(output.direction, Direction::Bullish);
    assert_eq!(output.computed_at, as_of);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rust-core && cargo test -p algo-core registry_test`
Expected: FAIL — compile error, `algo_core` has no `Algorithm`/`AlgoOutput`/etc. exported yet.

- [ ] **Step 3: Write the implementation**

`rust-core/crates/algo-core/src/algorithm.rs`:
```rust
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Bullish,
    Bearish,
    Neutral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Horizon {
    Intraday,
    Positional,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Timeframe {
    Minute,
    FiveMinute,
    FifteenMinute,
    Day,
}

/// What an `Algorithm::compute()` call needs. `closes` is the only series
/// Phase 1's indicators read; later phases extend this with open/high/low/
/// volume/oi as new algorithms need them.
pub struct MarketContext {
    pub symbol: String,
    pub timeframe: Timeframe,
    pub horizon: Horizon,
    pub closes: Vec<f64>,
    /// The evaluation instant: the live wall-clock at the I/O boundary in
    /// production, or the replay frontier's simulated time during backtest.
    /// Supplied by the caller so `compute()` stays pure and replayed
    /// decisions carry their historical timestamp, not today's.
    pub as_of: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct AlgoOutput {
    pub algo_id: &'static str,
    pub symbol: String,
    pub timeframe: Timeframe,
    pub horizon: Horizon,
    pub direction: Direction,
    pub magnitude: f64,
    pub confidence: f64,
    pub evidence: Vec<String>,
    pub computed_at: DateTime<Utc>,
}

pub trait Algorithm: Send + Sync {
    fn id(&self) -> &'static str;
    fn required_lookback(&self) -> usize;
    fn applicable_horizons(&self) -> &'static [Horizon];
    fn compute(&self, ctx: &MarketContext) -> AlgoOutput;
}

/// Direction + confidence from how far the latest close sits from a baseline
/// (e.g. a moving average). Shared by price-vs-MA indicators; RSI and other
/// non-baseline indicators classify differently and do not use this.
pub fn classify_by_distance(latest_close: f64, baseline: f64) -> (Direction, f64) {
    let distance = (latest_close - baseline) / baseline;
    let direction = if distance.abs() < 1e-6 {
        Direction::Neutral
    } else if distance > 0.0 {
        Direction::Bullish
    } else {
        Direction::Bearish
    };
    (direction, distance.abs().min(1.0))
}
```

`rust-core/crates/algo-core/src/lib.rs`:
```rust
mod algorithm;

pub use algorithm::{classify_by_distance, Algorithm, AlgoOutput, Direction, Horizon, MarketContext, Timeframe};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd rust-core && cargo test -p algo-core registry_test`
Expected: `test algorithm_trait_is_object_safe_and_computable ... ok`

- [ ] **Step 5: Commit**

```bash
git add rust-core/crates/algo-core/
git commit -m "feat(algo-core): add Algorithm trait and core types"
```

---

### Task 3: SMA algorithm

**Files:**
- Create: `rust-core/crates/algo-core/src/indicators/mod.rs`
- Create: `rust-core/crates/algo-core/src/indicators/sma.rs`
- Modify: `rust-core/crates/algo-core/src/lib.rs`

**Interfaces:**
- Consumes: `Algorithm`, `AlgoOutput`, `Direction`, `Horizon`, `MarketContext`, `Timeframe` (Task 2).
- Produces: `SmaAlgorithm::new(period: usize)`, registered under id `"sma"` — Task 6's registry test references this exact constructor and id.

- [ ] **Step 1: Write the failing test**

`rust-core/crates/algo-core/src/indicators/sma.rs` (test module at the bottom of the same file — standard Rust convention, keeps the test next to the code it exercises):
```rust
use crate::{classify_by_distance, Algorithm, Direction, Horizon, MarketContext, Timeframe};

pub struct SmaAlgorithm {
    period: usize,
}

impl SmaAlgorithm {
    pub fn new(period: usize) -> Self {
        Self { period }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, Utc};

    #[test]
    fn sma_matches_hand_computed_average() {
        // closes = [10, 12, 14, 16, 18], period = 3
        // SMA of the last 3 closes (14, 16, 18) = (14+16+18)/3 = 16.0
        let algo = SmaAlgorithm::new(3);
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = MarketContext {
            symbol: "TEST".to_string(),
            timeframe: Timeframe::Day,
            horizon: Horizon::Positional,
            closes: vec![10.0, 12.0, 14.0, 16.0, 18.0],
            as_of,
        };

        let output = algo.compute(&ctx);

        assert!((sma_value(&ctx.closes, 3) - 16.0).abs() < 1e-9);
        // latest close (18.0) is above the SMA (16.0) -> Bullish
        assert_eq!(output.direction, Direction::Bullish);
        assert_eq!(output.computed_at, as_of);
    }

    fn sma_value(closes: &[f64], period: usize) -> f64 {
        let window = &closes[closes.len() - period..];
        window.iter().sum::<f64>() / period as f64
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rust-core && cargo test -p algo-core sma`
Expected: FAIL — `SmaAlgorithm` has no `compute` method, `Algorithm` not implemented yet.

- [ ] **Step 3: Implement `SmaAlgorithm`**

Add to `rust-core/crates/algo-core/src/indicators/sma.rs`, above the `#[cfg(test)]` block:
```rust
impl Algorithm for SmaAlgorithm {
    fn id(&self) -> &'static str {
        "sma"
    }

    fn required_lookback(&self) -> usize {
        self.period
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        let window = &ctx.closes[ctx.closes.len() - self.period..];
        let sma = window.iter().sum::<f64>() / self.period as f64;
        let latest_close = *ctx.closes.last().unwrap();

        let (direction, confidence) = classify_by_distance(latest_close, sma);
        let magnitude = ((latest_close - sma) / sma).abs();

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude,
            confidence,
            evidence: vec![format!(
                "close {:.2} vs SMA({}) {:.2}",
                latest_close, self.period, sma
            )],
            computed_at: ctx.as_of,
        }
    }
}
```

`rust-core/crates/algo-core/src/indicators/mod.rs`:
```rust
mod sma;

pub use sma::SmaAlgorithm;
```

Update `rust-core/crates/algo-core/src/lib.rs`:
```rust
mod algorithm;
mod indicators;

pub use algorithm::{classify_by_distance, Algorithm, AlgoOutput, Direction, Horizon, MarketContext, Timeframe};
pub use indicators::SmaAlgorithm;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd rust-core && cargo test -p algo-core sma`
Expected: `test indicators::sma::tests::sma_matches_hand_computed_average ... ok`

- [ ] **Step 5: Commit**

```bash
git add rust-core/crates/algo-core/
git commit -m "feat(algo-core): add SMA algorithm"
```

---

### Task 4: EMA algorithm

**Files:**
- Create: `rust-core/crates/algo-core/src/indicators/ema.rs`
- Modify: `rust-core/crates/algo-core/src/indicators/mod.rs`

**Interfaces:**
- Consumes: same core types as Task 3.
- Produces: `EmaAlgorithm::new(period: usize)`, id `"ema"`.

- [ ] **Step 1: Write the failing test**

`rust-core/crates/algo-core/src/indicators/ema.rs`:
```rust
use crate::{classify_by_distance, Algorithm, Direction, Horizon, MarketContext, Timeframe};

pub struct EmaAlgorithm {
    period: usize,
}

impl EmaAlgorithm {
    pub fn new(period: usize) -> Self {
        Self { period }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, Utc};

    #[test]
    fn ema_matches_hand_computed_series() {
        // closes = [10, 11, 12, 13, 14], period = 3, multiplier k = 2/(3+1) = 0.5
        // seed EMA = SMA of first 3 closes (10, 11, 12) = 11.0
        // EMA at close=13: (13 - 11.0) * 0.5 + 11.0 = 12.0
        // EMA at close=14: (14 - 12.0) * 0.5 + 12.0 = 13.0  <- final expected value
        let algo = EmaAlgorithm::new(3);
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = MarketContext {
            symbol: "TEST".to_string(),
            timeframe: Timeframe::Day,
            horizon: Horizon::Positional,
            closes: vec![10.0, 11.0, 12.0, 13.0, 14.0],
            as_of,
        };

        let output = algo.compute(&ctx);

        // latest close (14.0) is above the EMA (13.0) -> Bullish
        assert_eq!(output.direction, Direction::Bullish);
        assert!(output.evidence[0].contains("13.00"));
        assert_eq!(output.computed_at, as_of);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rust-core && cargo test -p algo-core ema`
Expected: FAIL — `EmaAlgorithm` doesn't implement `Algorithm` yet.

- [ ] **Step 3: Implement `EmaAlgorithm`**

Add above the `#[cfg(test)]` block in the same file:
```rust
impl Algorithm for EmaAlgorithm {
    fn id(&self) -> &'static str {
        "ema"
    }

    fn required_lookback(&self) -> usize {
        self.period
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        let ema = ema_series(&ctx.closes, self.period);
        let latest_close = *ctx.closes.last().unwrap();

        let (direction, confidence) = classify_by_distance(latest_close, ema);
        let magnitude = ((latest_close - ema) / ema).abs();

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude,
            confidence,
            evidence: vec![format!(
                "close {:.2} vs EMA({}) {:.2}",
                latest_close, self.period, ema
            )],
            computed_at: ctx.as_of,
        }
    }
}

/// Wilder-style EMA: seed with the SMA of the first `period` values, then
/// apply the standard multiplier `2 / (period + 1)` to every value after.
fn ema_series(closes: &[f64], period: usize) -> f64 {
    let k = 2.0 / (period as f64 + 1.0);
    let mut ema = closes[..period].iter().sum::<f64>() / period as f64;

    for close in &closes[period..] {
        ema = (close - ema) * k + ema;
    }

    ema
}
```

Update `rust-core/crates/algo-core/src/indicators/mod.rs`:
```rust
mod ema;
mod sma;

pub use ema::EmaAlgorithm;
pub use sma::SmaAlgorithm;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd rust-core && cargo test -p algo-core ema`
Expected: `test indicators::ema::tests::ema_matches_hand_computed_series ... ok`

- [ ] **Step 5: Commit**

```bash
git add rust-core/crates/algo-core/
git commit -m "feat(algo-core): add EMA algorithm"
```

---

### Task 5: RSI (Wilder) algorithm

**Files:**
- Create: `rust-core/crates/algo-core/src/indicators/rsi.rs`
- Modify: `rust-core/crates/algo-core/src/indicators/mod.rs`

**Interfaces:**
- Consumes: same core types as Task 3.
- Produces: `RsiAlgorithm::new(period: usize)`, id `"rsi"`.

- [ ] **Step 1: Write the failing test**

`rust-core/crates/algo-core/src/indicators/rsi.rs`:
```rust
use crate::{Algorithm, Direction, Horizon, MarketContext, Timeframe};

pub struct RsiAlgorithm {
    period: usize,
}

impl RsiAlgorithm {
    pub fn new(period: usize) -> Self {
        Self { period }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, Utc};

    #[test]
    fn rsi_matches_hand_computed_wilder_smoothing() {
        // closes = [100, 102, 101, 105, 103], period = 2
        // changes: +2, -1, +4, -2
        // avgGain1/avgLoss1 (first `period`=2 changes: +2,-1) = 1.0 / 0.5
        // avgGain2/avgLoss2 (Wilder step, change +4/loss 0) = 2.5 / 0.25
        // avgGain3/avgLoss3 (Wilder step, change -2/gain 0) = 1.25 / 1.125
        // RS3 = 1.25 / 1.125 = 10/9; RSI3 = 100 - 100/(1 + 10/9) = 100 - 900/19
        //     = 52.6316 (final expected RSI)
        let algo = RsiAlgorithm::new(2);
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = MarketContext {
            symbol: "TEST".to_string(),
            timeframe: Timeframe::Day,
            horizon: Horizon::Positional,
            closes: vec![100.0, 102.0, 101.0, 105.0, 103.0],
            as_of,
        };

        let output = algo.compute(&ctx);

        assert!(output.evidence[0].contains("52.63"));
        // RSI 52.63 sits inside the neutral 30-70 band -> Neutral
        assert_eq!(output.direction, Direction::Neutral);
        assert_eq!(output.computed_at, as_of);
    }

    #[test]
    fn rsi_classifies_overbought_and_oversold() {
        assert_eq!(classify_rsi(75.0), Direction::Bearish);
        assert_eq!(classify_rsi(20.0), Direction::Bullish);
        assert_eq!(classify_rsi(50.0), Direction::Neutral);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rust-core && cargo test -p algo-core rsi`
Expected: FAIL — `RsiAlgorithm` doesn't implement `Algorithm`, `classify_rsi` doesn't exist.

- [ ] **Step 3: Implement `RsiAlgorithm`**

Add above the `#[cfg(test)]` block in the same file:
```rust
impl Algorithm for RsiAlgorithm {
    fn id(&self) -> &'static str {
        "rsi"
    }

    fn required_lookback(&self) -> usize {
        self.period + 1
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        let rsi = rsi_value(&ctx.closes, self.period);
        let direction = classify_rsi(rsi);

        // distance from the neutral midpoint (50), scaled to roughly [0, 1]
        let confidence = ((rsi - 50.0).abs() / 50.0).min(1.0);

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude: (rsi - 50.0).abs(),
            confidence,
            evidence: vec![format!("RSI({}) = {:.2}", self.period, rsi)],
            computed_at: ctx.as_of,
        }
    }
}

fn classify_rsi(rsi: f64) -> Direction {
    if rsi > 70.0 {
        Direction::Bearish
    } else if rsi < 30.0 {
        Direction::Bullish
    } else {
        Direction::Neutral
    }
}

/// Wilder's original RSI smoothing: seed avg gain/loss from the first
/// `period` changes, then smooth every subsequent change with weight
/// `(period - 1) / period` on the running average.
fn rsi_value(closes: &[f64], period: usize) -> f64 {
    let changes: Vec<f64> = closes.windows(2).map(|w| w[1] - w[0]).collect();

    let mut avg_gain = changes[..period]
        .iter()
        .map(|c| c.max(0.0))
        .sum::<f64>()
        / period as f64;
    let mut avg_loss = changes[..period]
        .iter()
        .map(|c| (-c).max(0.0))
        .sum::<f64>()
        / period as f64;

    for change in &changes[period..] {
        let gain = change.max(0.0);
        let loss = (-change).max(0.0);
        avg_gain = (avg_gain * (period as f64 - 1.0) + gain) / period as f64;
        avg_loss = (avg_loss * (period as f64 - 1.0) + loss) / period as f64;
    }

    if avg_loss == 0.0 {
        return 100.0;
    }
    let rs = avg_gain / avg_loss;
    100.0 - 100.0 / (1.0 + rs)
}
```

Update `rust-core/crates/algo-core/src/indicators/mod.rs`:
```rust
mod ema;
mod rsi;
mod sma;

pub use ema::EmaAlgorithm;
pub use rsi::RsiAlgorithm;
pub use sma::SmaAlgorithm;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd rust-core && cargo test -p algo-core rsi`
Expected: both `rsi_matches_hand_computed_wilder_smoothing` and `rsi_classifies_overbought_and_oversold` pass.

- [ ] **Step 5: Commit**

```bash
git add rust-core/crates/algo-core/
git commit -m "feat(algo-core): add RSI algorithm"
```

---

### Task 6: Compile-time registry

**Files:**
- Create: `rust-core/crates/algo-core/src/registry.rs`
- Modify: `rust-core/crates/algo-core/src/lib.rs`
- Modify: `rust-core/crates/algo-core/Cargo.toml`
- Modify: `rust-core/crates/algo-core/src/indicators/sma.rs` (register)
- Modify: `rust-core/crates/algo-core/src/indicators/ema.rs` (register)
- Modify: `rust-core/crates/algo-core/src/indicators/rsi.rs` (register)
- Test: `rust-core/crates/algo-core/tests/registry_test.rs`

**Interfaces:**
- Consumes: `Algorithm` trait and the three concrete algorithms (Tasks 2-5).
- Produces: `registry::all() -> Vec<Box<dyn Algorithm>>` — Task 7 (confluence) and Task 11 (sidecar handler) both call this exact function.

- [ ] **Step 1: Write the failing test**

Add to `rust-core/crates/algo-core/tests/registry_test.rs` (append, don't replace the existing test from Task 2):
```rust
use algo_core::registry;

#[test]
fn registry_contains_all_three_phase_one_algorithms() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();

    assert!(ids.contains(&"sma"));
    assert!(ids.contains(&"ema"));
    assert!(ids.contains(&"rsi"));
    assert_eq!(ids.len(), 3);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rust-core && cargo test -p algo-core registry_test`
Expected: FAIL — `algo_core::registry` module doesn't exist.

- [ ] **Step 3: Implement the registry**

Add to `rust-core/crates/algo-core/Cargo.toml`, under `[dependencies]`:
```toml
inventory = "0.3"
```

`rust-core/crates/algo-core/src/registry.rs`:
```rust
use crate::Algorithm;

pub struct AlgorithmFactory(pub fn() -> Box<dyn Algorithm>);

inventory::collect!(AlgorithmFactory);

pub fn all() -> Vec<Box<dyn Algorithm>> {
    inventory::iter::<AlgorithmFactory>()
        .map(|factory| (factory.0)())
        .collect()
}
```

Add to the bottom of `rust-core/crates/algo-core/src/indicators/sma.rs`:
```rust
inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(SmaAlgorithm::new(20)))
}
```

Add to the bottom of `rust-core/crates/algo-core/src/indicators/ema.rs`:
```rust
inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(EmaAlgorithm::new(20)))
}
```

Add to the bottom of `rust-core/crates/algo-core/src/indicators/rsi.rs`:
```rust
inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(RsiAlgorithm::new(14)))
}
```

Update `rust-core/crates/algo-core/src/lib.rs`:
```rust
mod algorithm;
mod indicators;
pub mod registry;

pub use algorithm::{classify_by_distance, Algorithm, AlgoOutput, Direction, Horizon, MarketContext, Timeframe};
pub use indicators::{EmaAlgorithm, RsiAlgorithm, SmaAlgorithm};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd rust-core && cargo test -p algo-core registry_test`
Expected: both registry tests pass (the Task 2 shape test and the new count/id test).

- [ ] **Step 5: Commit**

```bash
git add rust-core/crates/algo-core/
git commit -m "feat(algo-core): compile-time algorithm registry via inventory"
```

---

### Task 7: Confluence scorecard

**Files:**
- Create: `rust-core/crates/algo-core/src/confluence.rs`
- Modify: `rust-core/crates/algo-core/src/lib.rs`
- Test: `rust-core/crates/algo-core/tests/confluence_test.rs`

**Interfaces:**
- Consumes: `AlgoOutput`, `Direction` (Task 2).
- Produces: `ScorecardSummary` struct and `compute_confluence(outputs: &[AlgoOutput], weights: &HashMap<&str, f64>) -> ScorecardSummary` — Task 11 (sidecar handler) calls this exact function; a later phase's backtest engine supplies real hit-rate-derived weights instead of the equal weights this phase's tests use.

- [ ] **Step 1: Write the failing test**

`rust-core/crates/algo-core/tests/confluence_test.rs`:
```rust
use algo_core::{confluence::compute_confluence, AlgoOutput, Direction, Horizon, Timeframe};
use chrono::Utc;
use std::collections::HashMap;

fn output(algo_id: &'static str, direction: Direction) -> AlgoOutput {
    AlgoOutput {
        algo_id,
        symbol: "TEST".to_string(),
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
fn two_bullish_one_bearish_with_equal_weights_favors_bullish() {
    let outputs = vec![
        output("sma", Direction::Bullish),
        output("ema", Direction::Bullish),
        output("rsi", Direction::Bearish),
    ];
    let weights: HashMap<&str, f64> =
        [("sma", 1.0), ("ema", 1.0), ("rsi", 1.0)].into_iter().collect();

    let scorecard = compute_confluence(&outputs, &weights);

    assert_eq!(scorecard.bullish_count, 2);
    assert_eq!(scorecard.bearish_count, 1);
    assert_eq!(scorecard.neutral_count, 0);
    // weighted vote: (1.0 + 1.0 - 1.0) / 3.0 = 0.333...
    assert!((scorecard.weighted_vote - (1.0 / 3.0)).abs() < 1e-9);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rust-core && cargo test -p algo-core confluence_test`
Expected: FAIL — `algo_core::confluence` module doesn't exist.

- [ ] **Step 3: Implement confluence scoring**

`rust-core/crates/algo-core/src/confluence.rs`:
```rust
use crate::{AlgoOutput, Direction};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub struct ScorecardSummary {
    pub bullish_count: usize,
    pub bearish_count: usize,
    pub neutral_count: usize,
    /// Range roughly [-1.0, 1.0]: sum of (direction_sign * weight) / sum of weights.
    /// Positive leans bullish, negative leans bearish.
    pub weighted_vote: f64,
}

/// `weights` maps an algorithm's `algo_id` to its current weight — in this
/// phase, tests supply equal (1.0) weights; a later phase's backtest engine
/// supplies each algorithm's rolling historical hit-rate instead. An
/// `algo_id` missing from `weights` defaults to 1.0 so new algorithms are
/// never silently dropped from the vote before they have backtest history.
pub fn compute_confluence(
    outputs: &[AlgoOutput],
    weights: &HashMap<&str, f64>,
) -> ScorecardSummary {
    let mut bullish_count = 0;
    let mut bearish_count = 0;
    let mut neutral_count = 0;
    let mut weighted_sum = 0.0;
    let mut weight_total = 0.0;

    for output in outputs {
        let weight = *weights.get(output.algo_id).unwrap_or(&1.0);
        weight_total += weight;

        match output.direction {
            Direction::Bullish => {
                bullish_count += 1;
                weighted_sum += weight;
            }
            Direction::Bearish => {
                bearish_count += 1;
                weighted_sum -= weight;
            }
            Direction::Neutral => {
                neutral_count += 1;
            }
        }
    }

    let weighted_vote = if weight_total > 0.0 {
        weighted_sum / weight_total
    } else {
        0.0
    };

    ScorecardSummary {
        bullish_count,
        bearish_count,
        neutral_count,
        weighted_vote,
    }
}
```

Update `rust-core/crates/algo-core/src/lib.rs`:
```rust
mod algorithm;
pub mod confluence;
mod indicators;
pub mod registry;

pub use algorithm::{classify_by_distance, Algorithm, AlgoOutput, Direction, Horizon, MarketContext, Timeframe};
pub use indicators::{EmaAlgorithm, RsiAlgorithm, SmaAlgorithm};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd rust-core && cargo test -p algo-core confluence_test`
Expected: `test two_bullish_one_bearish_with_equal_weights_favors_bullish ... ok`

- [ ] **Step 5: Commit**

```bash
git add rust-core/crates/algo-core/
git commit -m "feat(algo-core): deliberately-uncollapsed confluence scorecard"
```

---

### Task 8: SQLite state store

**Files:**
- Create: `rust-core/crates/storage/src/state_store.rs`
- Modify: `rust-core/crates/storage/src/lib.rs`
- Test: `rust-core/crates/storage/tests/state_store_test.rs`

**Interfaces:**
- Produces: `StateStore::open(path: &Path) -> Result<StateStore>`, `StateStore::add_watchlist_symbol(&self, symbol: &str) -> Result<()>`, `StateStore::watchlist(&self) -> Result<Vec<String>>` — a later phase's Settings-window backend calls these exact methods.

- [ ] **Step 1: Write the failing test**

`rust-core/crates/storage/tests/state_store_test.rs`:
```rust
use storage::StateStore;
use tempfile::tempdir;

#[test]
fn watchlist_round_trips_through_sqlite() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("state.sqlite");

    let store = StateStore::open(&db_path).unwrap();
    store.add_watchlist_symbol("NSE:INFY").unwrap();
    store.add_watchlist_symbol("NSE:TCS").unwrap();

    let watchlist = store.watchlist().unwrap();

    assert_eq!(watchlist, vec!["NSE:INFY".to_string(), "NSE:TCS".to_string()]);
}
```

Add `tempfile` as a dev-dependency in `rust-core/crates/storage/Cargo.toml`:
```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rust-core && cargo test -p storage state_store_test`
Expected: FAIL — `storage::StateStore` doesn't exist.

- [ ] **Step 3: Implement `StateStore`**

`rust-core/crates/storage/src/state_store.rs`:
```rust
use rusqlite::{Connection, Result};
use std::path::Path;

pub struct StateStore {
    conn: Connection,
}

impl StateStore {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS watchlist (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL UNIQUE,
                added_at TEXT NOT NULL DEFAULT (datetime('now'))
            )",
            (),
        )?;
        Ok(Self { conn })
    }

    pub fn add_watchlist_symbol(&self, symbol: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO watchlist (symbol) VALUES (?1)",
            [symbol],
        )?;
        Ok(())
    }

    pub fn watchlist(&self) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT symbol FROM watchlist ORDER BY id ASC")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.collect()
    }
}
```

`rust-core/crates/storage/src/lib.rs`:
```rust
mod state_store;

pub use state_store::StateStore;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd rust-core && cargo test -p storage state_store_test`
Expected: `test watchlist_round_trips_through_sqlite ... ok`

- [ ] **Step 5: Commit**

```bash
git add rust-core/crates/storage/
git commit -m "feat(storage): SQLite watchlist state store"
```

---

### Task 9: Parquet/DuckDB candle lake

**Files:**
- Create: `rust-core/crates/storage/src/candle_store.rs`
- Modify: `rust-core/crates/storage/src/lib.rs`
- Test: `rust-core/crates/storage/tests/candle_store_test.rs`

**Interfaces:**
- Produces: `Candle { ts: i64, open: f64, high: f64, low: f64, close: f64, volume: i64 }`, `CandleStore::open(dir: &Path) -> Result<CandleStore>`, `CandleStore::write_candles(&self, symbol: &str, timeframe: &str, candles: &[Candle]) -> Result<()>`, `CandleStore::read_candles(&self, symbol: &str, timeframe: &str) -> Result<Vec<Candle>>` — proven correct by this task's own round-trip test. Task 11's handler does **not** call these yet: this phase's protocol takes `closes` directly inline in the request to keep the end-to-end proof minimal. Phase 2's ingestion/backtest engine and Phase 3's live-Kite-data path are what actually read and write through `CandleStore` in practice; when they land, the sidecar's request shape grows to reference a symbol/lookback that the handler resolves via `CandleStore::read_candles` instead of requiring the caller to inline every close.

- [ ] **Step 1: Write the failing test**

`rust-core/crates/storage/tests/candle_store_test.rs`:
```rust
use storage::{Candle, CandleStore};
use tempfile::tempdir;

#[test]
fn candles_round_trip_through_parquet_via_duckdb() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();

    let candles = vec![
        Candle { ts: 1_700_000_000, open: 100.0, high: 101.0, low: 99.5, close: 100.5, volume: 1000 },
        Candle { ts: 1_700_000_060, open: 100.5, high: 102.0, low: 100.0, close: 101.5, volume: 1200 },
    ];

    store.write_candles("NSE:INFY", "minute", &candles).unwrap();
    let read_back = store.read_candles("NSE:INFY", "minute").unwrap();

    assert_eq!(read_back.len(), 2);
    assert_eq!(read_back[0].close, 100.5);
    assert_eq!(read_back[1].close, 101.5);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rust-core && cargo test -p storage candle_store_test`
Expected: FAIL — `storage::CandleStore`/`storage::Candle` don't exist.

- [ ] **Step 3: Implement `CandleStore`**

`rust-core/crates/storage/src/candle_store.rs`:
```rust
use duckdb::{params, Connection};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct Candle {
    pub ts: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: i64,
}

pub struct CandleStore {
    root: PathBuf,
}

impl CandleStore {
    pub fn open(root: &Path) -> duckdb::Result<Self> {
        std::fs::create_dir_all(root).expect("candle lake root must be creatable");
        Ok(Self { root: root.to_path_buf() })
    }

    fn partition_path(&self, symbol: &str, timeframe: &str) -> PathBuf {
        let safe_symbol = symbol.replace(':', "_");
        self.root.join(format!("{safe_symbol}_{timeframe}.parquet"))
    }

    pub fn write_candles(
        &self,
        symbol: &str,
        timeframe: &str,
        candles: &[Candle],
    ) -> duckdb::Result<()> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            "CREATE TABLE candles (ts BIGINT, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume BIGINT)",
        )?;

        let mut appender = conn.appender("candles")?;
        for candle in candles {
            appender.append_row(params![
                candle.ts,
                candle.open,
                candle.high,
                candle.low,
                candle.close,
                candle.volume
            ])?;
        }
        appender.flush()?;

        let path = self.partition_path(symbol, timeframe);
        let path_str = path.to_string_lossy();
        conn.execute(
            &format!("COPY candles TO '{path_str}' (FORMAT PARQUET)"),
            [],
        )?;

        Ok(())
    }

    pub fn read_candles(&self, symbol: &str, timeframe: &str) -> duckdb::Result<Vec<Candle>> {
        let path = self.partition_path(symbol, timeframe);
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

        rows.collect()
    }
}
```

Update `rust-core/crates/storage/src/lib.rs`:
```rust
mod candle_store;
mod state_store;

pub use candle_store::{Candle, CandleStore};
pub use state_store::StateStore;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd rust-core && cargo test -p storage candle_store_test`
Expected: `test candles_round_trip_through_parquet_via_duckdb ... ok`

- [ ] **Step 5: Commit**

```bash
git add rust-core/crates/storage/
git commit -m "feat(storage): Parquet candle lake queried via embedded DuckDB"
```

---

### Task 10: Sidecar stdio protocol types

**Files:**
- Create: `rust-core/crates/sidecar/src/protocol.rs`
- Modify: `rust-core/crates/sidecar/src/main.rs`
- Test: `rust-core/crates/sidecar/tests/protocol_test.rs`

**Interfaces:**
- Produces: `ComputeRequest { id: u64, symbol: String, timeframe: String, closes: Vec<f64> }`, `ComputeResponse { id: u64, algo_results: Vec<AlgoResultWire>, confluence: ConfluenceWire }`, `parse_request(line: &str) -> serde_json::Result<ComputeRequest>`, `encode_response(response: &ComputeResponse) -> String` — Task 11 wires these into the actual stdin/stdout loop.

- [ ] **Step 1: Write the failing test**

`rust-core/crates/sidecar/tests/protocol_test.rs`:
```rust
use sidecar::protocol::{encode_response, parse_request, AlgoResultWire, ComputeResponse, ConfluenceWire};

#[test]
fn request_round_trips_from_json_line() {
    let line = r#"{"id":1,"symbol":"NSE:INFY","timeframe":"day","closes":[100.0,101.0,102.0]}"#;

    let request = parse_request(line).unwrap();

    assert_eq!(request.id, 1);
    assert_eq!(request.symbol, "NSE:INFY");
    assert_eq!(request.closes, vec![100.0, 101.0, 102.0]);
}

#[test]
fn response_encodes_to_a_single_json_line() {
    let response = ComputeResponse {
        id: 1,
        algo_results: vec![AlgoResultWire {
            algo_id: "sma".to_string(),
            direction: "Bullish".to_string(),
            confidence: 0.5,
            evidence: vec!["close above SMA".to_string()],
        }],
        confluence: ConfluenceWire {
            bullish_count: 1,
            bearish_count: 0,
            neutral_count: 0,
            weighted_vote: 1.0,
        },
    };

    let line = encode_response(&response);

    assert!(!line.contains('\n'));
    assert!(line.contains("\"id\":1"));
    assert!(line.contains("\"algo_id\":\"sma\""));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rust-core && cargo test -p sidecar protocol_test`
Expected: FAIL — `sidecar::protocol` module doesn't exist, and `sidecar` isn't exposed as a library yet (only a binary).

- [ ] **Step 3: Implement the protocol types**

`rust-core/crates/sidecar/src/protocol.rs`:
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct ComputeRequest {
    pub id: u64,
    pub symbol: String,
    pub timeframe: String,
    pub closes: Vec<f64>,
}

#[derive(Debug, Serialize)]
pub struct AlgoResultWire {
    pub algo_id: String,
    pub direction: String,
    pub confidence: f64,
    pub evidence: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ConfluenceWire {
    pub bullish_count: usize,
    pub bearish_count: usize,
    pub neutral_count: usize,
    pub weighted_vote: f64,
}

#[derive(Debug, Serialize)]
pub struct ComputeResponse {
    pub id: u64,
    pub algo_results: Vec<AlgoResultWire>,
    pub confluence: ConfluenceWire,
}

pub fn parse_request(line: &str) -> serde_json::Result<ComputeRequest> {
    serde_json::from_str(line)
}

pub fn encode_response(response: &ComputeResponse) -> String {
    serde_json::to_string(response).expect("ComputeResponse always serializes")
}
```

Add a library target so `tests/` can import `sidecar::protocol` — create `rust-core/crates/sidecar/src/lib.rs`:
```rust
pub mod protocol;
```

Update `rust-core/crates/sidecar/Cargo.toml` to declare both a library and a binary:
```toml
[package]
name = "sidecar"
version = "0.1.0"
edition.workspace = true

[lib]
name = "sidecar"
path = "src/lib.rs"

[[bin]]
name = "sidecar"
path = "src/main.rs"

[dependencies]
algo-core = { path = "../algo-core" }
storage = { path = "../storage" }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

`rust-core/crates/sidecar/src/main.rs` (unchanged placeholder for now — Task 11 replaces it):
```rust
fn main() {
    println!("sidecar placeholder");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd rust-core && cargo test -p sidecar protocol_test`
Expected: both `request_round_trips_from_json_line` and `response_encodes_to_a_single_json_line` pass.

- [ ] **Step 5: Commit**

```bash
git add rust-core/crates/sidecar/
git commit -m "feat(sidecar): line-delimited JSON request/response protocol types"
```

---

### Task 11: Sidecar main loop — wire everything together

**Files:**
- Create: `rust-core/crates/sidecar/src/handlers.rs`
- Modify: `rust-core/crates/sidecar/Cargo.toml` (add `chrono` — `handle_request` reads the wall clock once at the I/O boundary)
- Modify: `rust-core/crates/sidecar/src/main.rs`
- Modify: `rust-core/crates/sidecar/src/lib.rs`
- Test: `rust-core/crates/sidecar/tests/end_to_end_test.rs`

**Interfaces:**
- Consumes: `algo_core::registry::all()`, `algo_core::confluence::compute_confluence()` (Tasks 6-7), `sidecar::protocol::*` (Task 10).
- Produces: `handle_request(request: ComputeRequest) -> ComputeResponse` — this is the function a later phase's proactive-scan-gate logic and Benchmark-UI harness both call indirectly via the stdio loop; the binary itself reads one JSON line from stdin, calls this, writes one JSON line to stdout, per request. `handle_request` is also the sidecar's I/O boundary: it reads the wall clock once per request via `chrono::Utc::now()` and threads it through `MarketContext::as_of`, so the `Algorithm::compute()` implementations (Tasks 2-5) never read the clock themselves (Global Constraints).

- [ ] **Step 1: Write the failing test**

`rust-core/crates/sidecar/tests/end_to_end_test.rs` (spawns the actual compiled binary — this is the "does the whole Phase 1 pipeline actually work" checkpoint):
```rust
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

#[test]
fn compiled_binary_computes_algorithms_over_stdin_stdout() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_sidecar"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("sidecar binary must start");

    let request = r#"{"id":1,"symbol":"NSE:INFY","timeframe":"day","closes":[100.0,101.0,102.0,103.0,104.0,105.0,106.0,107.0,108.0,109.0,110.0,111.0,112.0,113.0,114.0,115.0,116.0,117.0,118.0,119.0,120.0]}"#;

    {
        let stdin = child.stdin.as_mut().unwrap();
        writeln!(stdin, "{request}").unwrap();
    }

    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let mut response_line = String::new();
    reader.read_line(&mut response_line).unwrap();

    child.kill().ok();

    let response: serde_json::Value = serde_json::from_str(response_line.trim()).unwrap();

    assert_eq!(response["id"], 1);
    let algo_results = response["algo_results"].as_array().unwrap();
    // sma, ema, rsi -- exactly the three Phase 1 algorithms
    assert_eq!(algo_results.len(), 3);
    assert!(response["confluence"]["bullish_count"].is_number());
}
```

Add `serde_json` as a dev-dependency is unnecessary (it's already a normal dependency), but the test needs it in scope — no `Cargo.toml` change required since `serde_json` is already a dependency of the `sidecar` crate and dev-dependencies inherit normal dependencies for integration tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rust-core && cargo test -p sidecar end_to_end_test`
Expected: FAIL — the binary currently only prints `"sidecar placeholder"` and exits; it never reads stdin or writes a response.

- [ ] **Step 3: Implement the handler and main loop**

Add to `rust-core/crates/sidecar/Cargo.toml`, under `[dependencies]`:
```toml
chrono = "0.4"
```
This is the sidecar's I/O boundary reading the live wall clock so `Algorithm::compute()` never has to.

`rust-core/crates/sidecar/src/handlers.rs`:
```rust
use crate::protocol::{AlgoResultWire, ComputeRequest, ComputeResponse, ConfluenceWire};
use algo_core::{confluence::compute_confluence, registry, Horizon, MarketContext, Timeframe};
use chrono::Utc;
use std::collections::HashMap;

pub fn handle_request(request: ComputeRequest) -> ComputeResponse {
    let timeframe = match request.timeframe.as_str() {
        "minute" => Timeframe::Minute,
        "5minute" => Timeframe::FiveMinute,
        "15minute" => Timeframe::FifteenMinute,
        _ => Timeframe::Day,
    };

    let ctx = MarketContext {
        symbol: request.symbol.clone(),
        timeframe,
        horizon: Horizon::Positional,
        closes: request.closes,
        as_of: Utc::now(),
    };

    let outputs: Vec<_> = registry::all().iter().map(|algo| algo.compute(&ctx)).collect();

    // Phase 1 uses equal weights for every algorithm; a later phase's
    // backtest engine supplies real rolling-hit-rate weights here instead.
    let weights: HashMap<&str, f64> = HashMap::new();
    let confluence = compute_confluence(&outputs, &weights);

    let algo_results = outputs
        .iter()
        .map(|output| AlgoResultWire {
            algo_id: output.algo_id.to_string(),
            direction: format!("{:?}", output.direction),
            confidence: output.confidence,
            evidence: output.evidence.clone(),
        })
        .collect();

    ComputeResponse {
        id: request.id,
        algo_results,
        confluence: ConfluenceWire {
            bullish_count: confluence.bullish_count,
            bearish_count: confluence.bearish_count,
            neutral_count: confluence.neutral_count,
            weighted_vote: confluence.weighted_vote,
        },
    }
}
```

`rust-core/crates/sidecar/src/main.rs`:
```rust
use sidecar::handlers::handle_request;
use sidecar::protocol::{encode_response, parse_request};
use std::io::{self, BufRead, Write};

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = line.expect("stdin must be readable");
        if line.trim().is_empty() {
            continue;
        }

        let request = match parse_request(&line) {
            Ok(request) => request,
            Err(_) => continue,
        };

        let response = handle_request(request);
        writeln!(stdout, "{}", encode_response(&response)).expect("stdout must be writable");
        stdout.flush().expect("stdout must flush");
    }
}
```

`rust-core/crates/sidecar/src/lib.rs`:
```rust
pub mod handlers;
pub mod protocol;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd rust-core && cargo test -p sidecar end_to_end_test`
Expected: `test compiled_binary_computes_algorithms_over_stdin_stdout ... ok`

- [ ] **Step 5: Commit**

```bash
git add rust-core/crates/sidecar/
git commit -m "feat(sidecar): wire stdin/stdout loop to algo-core registry and confluence"
```

---

### Task 12: Full workspace check — Phase 1 completion checkpoint

**Files:** none created; this task only runs and verifies.

**Interfaces:** none new — this task proves every earlier task's pieces work together as one artifact.

- [ ] **Step 1: Run the entire workspace test suite**

Run: `cd rust-core && cargo test --workspace`
Expected: every test from Tasks 2-11 passes — `algo-core` (algorithm/indicator/registry/confluence tests), `storage` (state store + candle store tests), `sidecar` (protocol + end-to-end tests). No failures, no ignored tests.

- [ ] **Step 2: Confirm a release build succeeds**

Run: `cd rust-core && cargo build --release`
Expected: `Finished` with no errors — this is the actual binary a later phase's Electron main process will spawn as the sidecar child process (design doc §3).

- [ ] **Step 3: Confirm there is no dead code / unused-dependency drift**

Run: `cd rust-core && cargo clippy --workspace --all-targets`
Expected: no warnings. Fix any that appear (e.g. unused imports left over from earlier tasks) before proceeding — this is the natural point to catch that kind of drift, since every crate now has real content.

- [ ] **Step 4: Commit** (only if Step 3 required fixes; otherwise this task has nothing new to commit and is a pure verification checkpoint)

```bash
git add rust-core/
git commit -m "chore: clean up clippy warnings after Phase 1"
```

---

## Phase 1 Definition of Done

- `cd rust-core && cargo test --workspace` passes with zero failures.
- `cargo build --release` produces a working `sidecar` binary.
- Feeding that binary one JSON line on stdin (a symbol + timeframe + a series of closes) produces one JSON line on stdout containing all three algorithms' results (`sma`, `ema`, `rsi`) plus a confluence scorecard that never collapses disagreement into a single number (§6.3 of the design doc).
- The candle lake can write and read back Parquet-backed OHLCV data via DuckDB; the state store can write and read back a watchlist via SQLite — both proven by real round-trip tests, not just "it compiles."
- Nothing in this phase touches Kite, Claude, Electron, or the network — by design, so it's testable in complete isolation (design doc §3's process-boundary table).

This is the point at which Phase 2 (public-data ingestion + the historical-replay/backtest engine) has real, working building blocks to build on top of — see the companion roadmap document for that phase's scope.
