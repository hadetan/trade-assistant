# Algorithm Catalog (v1) — TA + Options + Quant + Kronos — Implementation Plan (Phase 3 of 7, Catalog)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each numbered indicator task (Tasks 1-32) is designed to be executed by a **fresh implementer subagent from its brief alone** — read Task 0 first (it is the shared enabling change), then execute exactly one task.

> **Scope note — this is the catalog buildout the Phase 2 Foundation plan deliberately deferred.** Phase 2 built the storage carry-forwards, public-data ingestion, the frontier-gated replay/backtest engine, the `run_applicable` gate, the hit-rate→confluence-weight bridge, and resolved the Kronos ONNX spike (**GO**). This plan fills the §6.2 catalog: one `Algorithm` impl + one hand-verified unit test per item, each registered via `inventory::submit!` exactly like Phase 1's SMA/EMA/RSI, each scored by the Phase 2 replay engine.

**Goal:** Implement the full design §6.2 algorithm catalog (v1) as pure, deterministic `Algorithm` implementations registered at compile time, each with a unit test asserting against a hand-computed or cross-checked reference value, and prove the whole roster registers and runs end-to-end through the Phase 2 replay engine producing a per-algorithm hit-rate report.

**Architecture:** Every catalog item is one more `Algorithm` in `algo-core`, self-registered via `inventory::submit!`. A single sequential **Task 0** does all the shared-file work up front — the four Phase-2 carry-forward hardening fixes, the `MarketContext` extension that threads OHLCV/volume/timestamps/options/peer context to `compute()`, all crate deps, and one empty stub file + `mod` line per catalog item. After Task 0, **every indicator task edits exactly one new source file plus its own test file — disjoint from every other task**, so Tasks 1-32 run as truly parallel implementer subagents with zero shared-file contention. Options/OI analytics are **descriptive overlays** (`direction` always `Neutral`); Kronos is the **last task, fully isolated behind a cargo feature** so an `ort`/ONNX-Runtime stall blocks nothing else.

**Tech Stack:** Rust (stable, 2021 edition). New deps in `algo-core`: `rust_ti = "2.2.0"` (primary TA, ~70 indicators, zero-dep), `yata = "0.7.0"` (fallback for anything `rust_ti` lacks), `blackscholes = "0.24.0"` (BSM Greeks), `implied-vol = "2.0.0"` (Peter Jäckel "Let's Be Rational" IV solver), `nalgebra = "0.35"` + `statrs = "0.18"` (OLS/eigen/ADF distributions for cointegration/OU/GARCH), and — **only under the optional `kronos` feature** — `ort = "2.0.0-rc.12"` (download-binaries; ONNX Runtime 1.24, per the spike) + `ndarray = "0.17"`. `ta-rs` is **excluded** (known RSI EMA-alpha bug, design §6.2). Existing `chrono`/`inventory` retained.

---

## Real Phase-1/2 interfaces this plan builds on (confirmed against source, do not assume)

- `algo_core::Algorithm` trait: `id(&self) -> &'static str`, `required_lookback(&self) -> usize`, `applicable_horizons(&self) -> &'static [Horizon]`, `compute(&self, ctx: &MarketContext) -> AlgoOutput` (`crates/algo-core/src/algorithm.rs`).
- `algo_core::AlgoOutput { algo_id: &'static str, symbol: String, timeframe: Timeframe, horizon: Horizon, direction: Direction, magnitude: f64, confidence: f64, evidence: Vec<String>, computed_at: DateTime<Utc> }`.
- `algo_core::Direction { Bullish, Bearish, Neutral }`, `Horizon { Intraday, Positional }`, `Timeframe { Minute, FiveMinute, FifteenMinute, Day }`.
- `algo_core::classify_by_distance(latest_close, baseline) -> (Direction, f64)` and `algo_core::relative_magnitude(latest_close, baseline) -> f64` — the shared price-vs-baseline helpers, both **guarded against a zero/near-zero baseline** (return `Neutral`/`0.0`). Reuse these for every price-vs-line indicator (MACD-signal, Bollinger-mid, Keltner-mid, Donchian-mid, VWAP, Supertrend, PSAR) instead of re-deriving the guard.
- `algo_core::registry::AlgorithmFactory(pub fn() -> Box<dyn Algorithm>)` + `inventory::collect!` + `inventory::submit!` — the exact registration mechanism SMA/EMA/RSI use (`crates/algo-core/src/registry.rs`, `indicators/sma.rs:85`). **Copy this pattern verbatim.**
- `algo_core::registry::all() -> Vec<Box<dyn Algorithm>>` and `algo_core::registry::run_applicable(algos, ctx) -> Vec<AlgoOutput>` — the single lookback gate (`filter(|a| a.required_lookback() <= ctx.closes.len())`). Reused **unchanged**. Every new algo's `required_lookback()` is expressed in **bar count** (== `closes.len()` needed), because that is what `run_applicable` gates on.
- `algo_core::MarketContext` — **Phase 1/2 shape is `{ symbol, timeframe, horizon, closes: Vec<f64>, as_of: DateTime<Utc> }` — CLOSES ONLY.** Task 0 extends it (see below); the trait's own doc comment already sanctions this ("later phases extend this with open/high/low/volume/oi as new algorithms need them").
- `backtest::frontier::context_at(series, i, symbol, timeframe, horizon)` builds the frontier `MarketContext` from `series[..=i]` (`crates/backtest/src/frontier.rs`) — Task 0 extends it to thread the new OHLCV fields from `storage::Candle` (which already carries `open/high/low/close/volume/ts`).
- `sidecar::handlers::handle_request` builds a `MarketContext` from `request.closes` with `as_of: Utc::now()` (`crates/sidecar/src/handlers.rs`) — Task 0 populates the new fields (empty vecs where the wire protocol does not yet carry them; see Open Question Q2).
- `backtest::engine::run_replay(...)` scores only **directional** outputs (`Direction::Neutral => continue`) — so the options overlays (always `Neutral`) correctly contribute **zero** directional calls and simply appear in the roster with `directional_calls == 0`. This is intended, not a bug.

---

## Global Constraints (binding on EVERY task — verbatim-strong)

- **The app NEVER places, modifies, or cancels orders. Pure compute only.** No order path, no Kite write tool (`place_order`/`modify_order`/`cancel_order`/`*_gtt_order`), no Kite endpoint at all is touched by this plan (design §2/§4). Every task adds read-only compute.
- **`compute()` purity & determinism.** `compute(&self, ctx: &MarketContext)` reads only `ctx` and returns an `AlgoOutput` that is a pure deterministic function of `ctx`. **NO wall-clock inside `compute()`** — never call `Utc::now()`/`Instant::now()`/system time; the evaluation instant is `ctx.as_of`, supplied by the caller. **No randomness** (Kronos uses greedy `top_k=1` argmax decoding — no RNG). No I/O inside `compute()` (Kronos loads its ONNX session **once at construction/factory time**, not per-compute).
- **Anti-lookahead.** Read only `series[..=frontier]`. Never index a future bar. All new fields Task 0 adds (`opens/highs/lows/volumes/timestamps`) are pre-sliced to the same `[..=frontier]` window by `context_at`; an indicator must only read `ctx.*[i]` for `i <= last index`, never reconstruct or peek beyond the supplied slice.
- **The confluence layer stays non-collapsing (§6.3).** Every `AlgoOutput` reaches the response layer; the rolling hit-rate weight is SEPARATE from a run's live `confidence`. No task here collapses, filters, or overwrites any algorithm's output. Do not modify `compute_confluence` or `run_applicable`.
- **Register via `inventory::submit!` exactly like SMA/EMA/RSI.** Compile-time static registration only; no dynamic loading, no if-else dispatch tree. The `submit!` block lives at the **bottom of the algorithm's own file** (mirroring `indicators/sma.rs:85-87`), so no task edits a shared registration list.
- **Options/OI analytics are DESCRIPTIVE OVERLAYS.** Greeks, Implied Volatility, OI buildup, Put-Call Ratio, and Max Pain MUST set `direction: Direction::Neutral` unconditionally — they are "never directional signals or confidence scores" (design §6.2). Their sentiment lands in `evidence` strings and `magnitude`, never in `direction`. Max Pain is meaningful only near expiry — say so in `evidence`.
- **Comments: default NONE.** Only a non-obvious *why* earns a comment (a Wilder-vs-SMA smoothing note, a formula's source, an upstream-bug workaround). NEVER restate the next line; NEVER write a numbered "1. do X, 2. do Y" comment block above a function. Enforced by repo `CLAUDE.md`.
- **Naming/structure per `CLAUDE.md`.** `snake_case` fns/vars, `PascalCase` types, one responsibility per file, files named for what they are responsible for (`macd.rs`, not `utils.rs`). Domain abbreviations `oi`/`pcr`/`ltp` are fine.
- **Networking uses `rustls`, never `openssl`/`native-tls`.** Only relevant if a crate pulls a network stack. `ort`'s `download-binaries` fetches the ONNX Runtime binary at **build time** (not app networking) and does not introduce openssl into the Rust dep tree — verify with `cargo tree -i openssl` staying empty (it must remain empty after every task, as in Phase 2).
- **Every unit test asserts against a HAND-COMPUTED or cross-checked reference value** on a concrete tiny input series (design §6.2: "unit-test against a hand-computed or cross-checked reference value before it's trusted"). Each task below specifies the exact input and the exact expected output. Use `assert!((got - expected).abs() < 1e-6)` for floats (looser `1e-3` only where a crate's float-kernel ordering makes `1e-6` unstable, e.g. Greeks/Kronos — noted per task).
- **Failing-test-first (TDD).** Every task writes the test, runs it to see it fail for the stated reason, then implements until green. No implementation before a red test.

---

## Crate versions (verified against crates.io via `cargo search`, 2026-07-19) & feasibility risks

| Crate | Pin | Verified | Use | Risk |
|---|---|---|---|---|
| `rust_ti` | `2.2.0` | ✅ latest on crates.io | primary TA | **API-surface risk (unverified per-indicator):** version confirmed, but I could not confirm from here that 2.2.0 exposes each specific function (esp. Supertrend, Ichimoku, PSAR, Keltner, session-VWAP-with-IST-reset, Volume Profile). Each task says "cross-check `rust_ti` docs.rs for the pinned version; if absent, fall back to `yata`; if both lack it, hand-roll from the cited formula." |
| `yata` | `0.7.0` | ✅ latest | fallback TA | mature; `yata` is streaming/incremental — adapt its API to our batch `compute()` by feeding the whole slice. |
| `blackscholes` | `0.24.0` | ✅ latest | BSM Greeks | confirm the exact call signature on docs.rs for 0.24.0; the reference values below are standard textbook BSM and are crate-independent. |
| `implied-vol` | `2.0.0` | ✅ latest | IV solver | Jäckel "Let's Be Rational"; robust near-zero-vega. Confirm 2.0.0 fn signature. |
| `ort` | `2.0.0-rc.12` | ✅ (bundles ONNX Runtime 1.24, matches spike) | Kronos only, feature-gated | pre-release `-rc`; isolate behind `kronos` feature so it never blocks the default build. |
| `nalgebra` | `0.35.0` | ✅ latest | OLS regression, eigen (Johansen) | fine. |
| `statrs` | `0.18.0` | ✅ latest | Normal CDF, ADF critical-value distributions | fine. |

**Genuine feasibility risks (call out to the human):**
- **R1 — `MarketContext` is a breaking extension.** Task 0 adds fields to a struct constructed in the sidecar handler, the backtest `context_at`, and several Phase-1/2 tests. This is unavoidable (closes-only cannot feed ATR/ADX/Stochastic/volume/options algos) and is explicitly sanctioned by the trait doc comment, but it is a coordinated edit across 3 crates that MUST land in the single sequential Task 0 before any parallel task starts.
- **R2 — GARCH(1,1) MLE has no obvious maintained Rust crate.** Task 30 fits via a **hand-rolled bounded Nelder-Mead over `(ω,α,β)` contained entirely in `garch.rs`** — argmin was considered and rejected because adding it would require editing the shared `Cargo.toml`, breaking Task 30's parallel-safety; the hand-rolled optimizer needs no new dependency. To keep the unit test deterministic and hand-checkable, Task 30 tests the **variance recursion and long-run variance `ω/(1−α−β)`** at fixed params, and treats full MLE calibration as the implementation's runtime path (not asserted to a hand value). Heaviest quant task.
- **R3 — Johansen cointegration needs a generalized eigenproblem** (harder than symmetric eigen). Task 25 implements **Engle-Granger fully** (OLS hedge ratio + ADF on residuals) with a hand-checked hedge ratio, and provides Johansen as a **documented `nalgebra`-based approximation** flagged for later validation — Engle-Granger is the tested path.
- **R4 — Multi-series algos don't fit the single-instrument `Algorithm` naturally.** Cointegration/OU need a **peer** series; MTF confluence needs **higher-timeframe** series. Task 0 threads these as **optional** `MarketContext` fields; the algo emits a `Neutral` "no peer/mtf context" no-op when absent (so it still registers and never panics). See Open Questions Q1/Q3.
- **R5 — Kronos ships `.onnx` build assets.** The spike says export offline at release-engineering time and commit the `.onnx` files. Task 32 assumes those assets exist under `crates/algo-core/assets/kronos/`; if not yet exported, its test is `#[ignore]`d / behind `--features kronos` so the roster still completes. Also carries the spike's open follow-up: the fixed-max-context + padding-mask decode path was described but not fully re-validated.

**Open design questions needing the human's decision** (each has a concrete default baked in so the plan is executable as-is):
- **Q1 — Options/OI context shape.** Default: add `MarketContext.options: Option<OptionsContext>` and `MarketContext.chain: Option<OptionChainSnapshot>` (strike, expiry, spot, rate, oi/oi_day_high/low, per-strike call/put OI). Alternative the human may prefer: a separate registration path/context type for non-candle-series algos. Confirm the default is acceptable.
- **Q2 — Live sidecar wiring of OHLCV/OI.** Default: the backtest path (which drives the DoD hit-rate report) gets full OHLCV from `Candle`; the **live sidecar** `ComputeRequest` wire protocol is left closes-only for now (new `MarketContext` fields populated empty ⇒ OHLCV/options algos are no-op in the live path until a follow-up extends the wire protocol). Confirm live options/OI wiring is out of scope for this catalog plan.
- **Q3 — Should cointegration/OU/MTF register in the same roster** (default: yes, as `Algorithm`s that no-op without peer/mtf context) or live outside `registry::all()`? Default keeps them in the roster so the confluence scorecard sees them.
- **Q4 — Kronos default checkpoint.** Default: **Kronos-small (~24.7M params)** — the responsive sweet spot for the target dev box (11th-gen i5 CPU + NVIDIA MX450 2GB): mini (4.1M) is retained as the lighter-bundle alternative and **base** is the reach option to benchmark later, but the catalog task **builds and tests against `small`**. Exported `.onnx` assets committed under `crates/algo-core/assets/kronos/`. Confirm the `small` default and asset location. (Still `--features kronos`-gated either way.)

---

## File Structure

```
rust-core/
  crates/
    algo-core/
      Cargo.toml                     # Task 0: add rust_ti, yata, blackscholes, implied-vol, nalgebra, statrs; [features] kronos = [ort, ndarray]
      assets/kronos/                 # Task 32 (+Q4): committed .onnx build assets (feature-gated)
      src/
        algorithm.rs                 # Task 0: extend MarketContext (OHLCV/timestamps/options/peer/mtf); doc the new fields
        lib.rs                       # Task 0: `mod options; mod quant; mod forecast;`
        indicators/
          mod.rs                     # Task 0: one `mod <name>;` line per new indicator (private mod; no pub-use needed)
          macd.rs adx.rs supertrend.rs ichimoku.rs psar.rs stochastic.rs cci.rs
          williams_r.rs roc.rs bollinger.rs atr.rs keltner.rs donchian.rs
          obv.rs vwap.rs mfi.rs cmf.rs accumulation_distribution.rs volume_profile.rs   # Tasks 1-19 fill these
        options/
          mod.rs                     # Task 0: `pub mod context; mod greeks; mod implied_vol; mod oi_buildup; mod put_call_ratio; mod max_pain;`
          context.rs                 # Task 0: OptionsContext + OptionChainSnapshot types
          greeks.rs implied_vol.rs oi_buildup.rs put_call_ratio.rs max_pain.rs           # Tasks 20-24
        quant/
          mod.rs                     # Task 0: `mod cointegration; mod ou_half_life; mod parkinson; mod garman_klass; mod yang_zhang; mod garch; mod confluence_mtf;`
          cointegration.rs ou_half_life.rs parkinson.rs garman_klass.rs yang_zhang.rs garch.rs confluence_mtf.rs   # Tasks 25-31
        forecast/
          mod.rs                     # Task 0: `#[cfg(feature = "kronos")] mod kronos;`
          kronos.rs                  # Task 32 (feature-gated)
      tests/
        <one test file per task>     # each task owns its own test file — no shared test file
        registry_count_test.rs       # Task 0 baseline (asserts current 3) → Task 33 tightens to full roster
```

**Zero-contention rule (why this parallelizes):** Task 0 writes every `mod <name>;` line and every empty stub file up front, so each indicator task (1-32) touches **only** `src/<area>/<name>.rs` (fill the stub) + `tests/<name>_test.rs` (new file). No two indicator tasks share a file. The **exact** registration-count assertion lives ONLY in Task 33 (run after all land); each indicator's own test asserts just that *its* id is in `registry::all()`, so the count test is never a shared edit.

---

## Wave overview

| Wave | Tasks | Header |
|---|---|---|
| **Task 0** (sequential, FIRST) | 0 | Carry-forward hardening + `MarketContext` extension + full catalog scaffold |
| **Wave A — Technical indicators** | 1-19 | rust_ti primary / yata fallback / hand-roll; all `Parallel-safe: yes`, depend only on Task 0 |
| **Wave B — Options/F&O overlays** | 20-24 | `blackscholes`/`implied-vol`; `direction` always `Neutral`; all `Parallel-safe: yes`, depend only on Task 0 |
| **Wave C — Statistical/quant** | 25-31 | `nalgebra`/`statrs`; peer/mtf-aware; all `Parallel-safe: yes`, depend only on Task 0 |
| **Wave D — Kronos** | 32 | LAST, isolated behind `--features kronos`; depends only on Task 0 |
| **Final** | 33 | Registration-count assertion + `cargo test --workspace` + `cargo clippy --all-targets -- -D warnings` + Phase-2 DoD replay hit-rate report incl. new indicators |

Waves A/B/C/D have **no inter-task dependencies** — all 32 depend solely on Task 0 and touch disjoint files, so they can all be dispatched at once to parallel implementer subagents. They are grouped into waves only for reviewer sanity and roster readability.

---

### Task 0: Carry-forward hardening + `MarketContext` extension + full catalog scaffold

**Depends on:** none. **Parallel-safe: NO** — this is the single sequential enabling task; it edits shared files (`algorithm.rs`, `lib.rs`, `Cargo.toml`, `mod.rs`s, `frontier.rs`, `candle_store.rs`, `engine.rs`, `bin/replay.rs`) that no other task may touch. **Every other task depends on this and starts only after it is committed.**

**Files:**
- Modify: `rust-core/crates/storage/src/candle_store.rs` (carry-forward #1: atomic write)
- Modify: `rust-core/crates/backtest/src/engine.rs` (carry-forwards #2, #4: zero-close guard, series-ascending debug_assert)
- Modify: `rust-core/crates/backtest/src/bin/replay.rs` (carry-forward #3: `*.csv` filter + exchange-from-symbol)
- Modify: `rust-core/crates/algo-core/Cargo.toml` (all catalog deps + `kronos` feature)
- Modify: `rust-core/crates/algo-core/src/algorithm.rs` (extend `MarketContext`)
- Modify: `rust-core/crates/backtest/src/frontier.rs` (thread new fields from `Candle`)
- Modify: `rust-core/crates/sidecar/src/handlers.rs` (+ its test `request()` helper) (populate new fields)
- Modify: `rust-core/crates/algo-core/src/lib.rs`, `src/indicators/mod.rs`; create `src/options/mod.rs`, `src/options/context.rs`, `src/quant/mod.rs`, `src/forecast/mod.rs`
- Create: 32 empty stub files (one per Tasks 1-32) with their `mod` lines wired
- Create: `rust-core/crates/algo-core/tests/registry_count_test.rs`

**Interfaces produced (every later task consumes these):**
- Extended `MarketContext`:
  ```rust
  pub struct MarketContext {
      pub symbol: String,
      pub timeframe: Timeframe,
      pub horizon: Horizon,
      pub closes: Vec<f64>,
      // Task 0 additions — aligned 1:1 with `closes` when present, else empty.
      pub opens: Vec<f64>,
      pub highs: Vec<f64>,
      pub lows: Vec<f64>,
      pub volumes: Vec<f64>,
      pub timestamps: Vec<i64>,          // absolute Unix epoch per bar (VWAP session anchoring)
      pub options: Option<OptionsContext>,   // Greeks/IV/OI-buildup input (Q1)
      pub chain: Option<OptionChainSnapshot>, // PCR/Max-Pain input (Q1)
      pub peer: Option<PeerSeries>,          // cointegration/OU second leg (Q3)
      pub higher_tf: Option<HigherTfSeries>, // MTF confluence forward-filled higher-timeframe (Q3)
      pub as_of: DateTime<Utc>,
  }
  ```
  with a `MarketContext::from_closes(...)` convenience constructor preserving the Phase-1 shape (empty OHLCV/None extras) so existing tests migrate with a one-line change.
- Context types (all `#[derive(Debug, Clone)]`; **every field explicitly typed** — Tasks 22/23/24 do float arithmetic on OI, so no field is left to inference), in `options/context.rs` and `quant/`:
  ```rust
  pub struct OptionsContext {
      pub spot: f64,
      pub strike: f64,
      pub rate: f64,
      pub time_to_expiry_years: f64,  // expiry as year-fraction T (what BSM/IV consume); absolute bar time lives in MarketContext.timestamps/as_of (DateTime<Utc>)
      pub is_call: bool,
      pub iv: f64,
      pub oi: f64,
      pub prev_oi: f64,
      pub oi_day_high: f64,
      pub oi_day_low: f64,
      pub market_price: f64,
  }
  pub struct StrikeRow { pub strike: f64, pub call_oi: f64, pub put_oi: f64 }
  pub struct OptionChainSnapshot { pub spot: f64, pub strikes: Vec<StrikeRow> }
  pub struct PeerSeries { pub symbol: String, pub closes: Vec<f64> }
  pub struct HigherTfSeries { pub timeframe: Timeframe, pub closes: Vec<f64> }
  ```
- **No-op guard convention (state-once here; binding on every OHLCV/volume/options algorithm — later tasks reference it by name).** `run_applicable` gates ONLY on `ctx.closes.len()`, so an algorithm reading `highs`/`lows`/`volumes`/`timestamps` (or `ctx.options`/`ctx.chain`) can be handed a closes-only or short context (e.g. the live sidecar path, Q2) and would index-panic. Therefore **any algorithm reading a high/low/volume series MUST, as the first action in `compute()`, guard**: `if ctx.highs.len() < self.required_lookback() { return <Neutral no-op> }` — and the same for each `lows`/`volumes`/`timestamps` series it consumes (and `ctx.closes.len() >= 2` for algos like OI-buildup that index `closes[len-2..]` under a `required_lookback` of 0). The no-op `AlgoOutput` is `direction: Neutral`, `magnitude: 0.0`, `evidence: ["insufficient OHLCV"]`, `computed_at: ctx.as_of`. This mirrors Wave B's `ctx.options`-absent no-op, so every algo registers and never panics regardless of context shape.

- [ ] **Step 1: Apply the four Phase-2 carry-forward hardening fixes (quoted from `.superpowers/sdd/phase2-progress.md`).**
  1. *"#4 storage write_partition: use temp-file + atomic rename (crash mid-merge currently can corrupt a partition; catalog re-ingests heavily -> poisons backtests). HIGHEST VALUE."* — In `candle_store.rs::write_partition`, `COPY ... TO` a sibling temp path (`{path}.tmp`) then `std::fs::rename` over the final path (rename is atomic on same filesystem). Add a test: interrupting/overwriting leaves the old partition intact (assert a second write to a temp path then rename yields exactly the new rows; assert the final file is never a partial).
  2. *"#2 backtest signed_return: guard `current <= 0.0` (continue) BEFORE hit-rate weights feed real confluence (a 0-close bar NaN-poisons an algo weight)."* — In `engine.rs::run_replay`, before `let signed_return = ... / current`, add `if current <= 0.0 { continue; }`. Add a test with a zero-close bar proving no `NaN` reaches `sum_signed_return`.
  3. *"#3 CLI --ingest-dir: filter to *.csv (macOS .DS_Store breaks the run) + derive exchange from --symbol prefix (not hardcoded NSE)."* — In `bin/replay.rs`, filter `read_dir` entries to `extension() == Some("csv")`, and derive the exchange from the `--symbol` prefix (`symbol.split(':').next()`), replacing the hardcoded `"NSE"`.
  4. *"add debug_assert!(series ascending by ts) at top of run_replay (anti-lookahead relies on it)."* — Add `debug_assert!(series.windows(2).all(|w| w[0].ts <= w[1].ts), "run_replay requires ascending-by-ts series");` as the first line of `run_replay`.

- [ ] **Step 2: Extend `MarketContext` and its context types (failing test first).** Add a test in `tests/registry_count_test.rs` that constructs a full `MarketContext` with OHLCV + `options`/`chain`/`peer`/`higher_tf` and asserts field access compiles/round-trips; run it → RED (fields don't exist). Then add the fields + `from_closes` + the four context structs, and migrate `sidecar/handlers.rs`, `backtest/frontier.rs`, and all existing `MarketContext { ... }` literals in Phase-1/2 tests to the new shape (`context_at` slices `opens/highs/lows/volumes/timestamps` from `series[..=frontier_index]` off `Candle`; sidecar populates OHLCV/extras empty/None per Q2).

- [ ] **Step 3: Add all catalog deps + `kronos` feature to `algo-core/Cargo.toml`.**
  ```toml
  [dependencies]
  chrono = "0.4"
  inventory = "0.3"
  rust_ti = "2.2.0"
  yata = "0.7.0"
  blackscholes = "0.24.0"
  implied-vol = "2.0.0"
  nalgebra = "0.35"
  statrs = "0.18"
  ort = { version = "2.0.0-rc.12", features = ["download-binaries"], optional = true }
  ndarray = { version = "0.17", optional = true }

  [features]
  kronos = ["dep:ort", "dep:ndarray"]
  ```

- [ ] **Step 4: Scaffold all 32 stub files + module wiring.** Create every stub file listed in File Structure as an **empty file** (a valid empty module), add each `mod <name>;` line to the relevant `mod.rs`, add `mod options; mod quant; mod forecast;` to `lib.rs`, write `options/context.rs` with the context types, and gate `mod kronos;` under `#[cfg(feature = "kronos")]`. Do NOT add `pub use` re-exports for the new algos — they are reached only via the `inventory` factory, so no re-export is needed and none creates dead-code warnings.

- [ ] **Step 5: Baseline registration-count test.** In `tests/registry_count_test.rs` assert `registry::all().len() == 3` and that the ids are exactly `{sma, ema, rsi}` (the pre-catalog baseline). Task 33 replaces `3` with the full roster count.

- [ ] **Step 6: Verify + Commit.**
  Run: `cd rust-core && cargo build && cargo test --workspace && cargo clippy --all-targets -- -D warnings && cargo tree -i openssl` (last must print nothing/error "not found").
  ```bash
  git add rust-core/
  git commit -m "chore(algo-core): carry-forward hardening, MarketContext OHLCV/options extension, catalog scaffold"
  ```

---

## Wave A — Technical indicators (Tasks 1-19)

> Every Wave-A task: **Depends on Task 0. Parallel-safe: yes.** Files: fill `crates/algo-core/src/indicators/<name>.rs` + create `crates/algo-core/tests/<name>_test.rs`. Register via `inventory::submit! { crate::registry::AlgorithmFactory(|| Box::new(<Name>Algorithm::new(...))) }` at the file bottom. `applicable_horizons` = `&[Horizon::Intraday, Horizon::Positional]` unless noted. Each test asserts its id is in `registry::all()`. Compute via `rust_ti` (primary); if the pinned `rust_ti 2.2.0` lacks the indicator, use `yata 0.7.0`; if both lack it, hand-roll from the cited formula — and note which path was taken in a one-line `why` comment only if non-obvious.

### Task 1: MACD (12/26/9)
`id="macd"`, `required_lookback=35` (26 slow-EMA seed + 9 signal seed). Compute MACD line = EMA12−EMA26, signal = EMA9(MACD), histogram = line−signal. Direction: histogram>0 → Bullish, <0 → Bearish, ==0 → Neutral; `magnitude=|histogram|`. **Test input & expected:** (a) exact — constant series `[5.0; 40]` ⇒ all EMAs = 5 ⇒ MACD line = signal = histogram = **0.0**, direction **Neutral**. (b) sign — ramp `closes = (1..=40).map(f64)` ⇒ MACD line **> 0** (fast EMA leads a rising series) ⇒ **Bullish**. Assert both.

### Task 2: ADX/DMI
`id="adx"`, `required_lookback=28` (2×14 for +DI/−DI Wilder-smoothing then ADX). Needs `highs/lows/closes`. Output +DI/−DI/ADX in evidence. Direction: +DI>−DI **and** ADX>20 → Bullish; −DI>+DI **and** ADX>20 → Bearish; else Neutral; `magnitude=ADX`. **Test input:** a 30-bar clean uptrend `high=100+2i, low=99+2i, close=99.5+2i` (`i=0..30`). Expected: **+DI > −DI**, ADX > 20, direction **Bullish**. **Exact externally-verifiable anchor (hand formula, not the crate's own echo):** pin the first Wilder step on this series — TR₁ = max(H₁−L₁, |H₁−C₀|, |L₁−C₀|) = max(102−101, |102−99.5|, |101−99.5|) = **2.5**; +DM₁ = H₁−H₀ = 102−100 = **2.0**; −DM₁ = **0.0** (down-move L₀−L₁ = 99−101 < 0). Assert TR₁, +DM₁, −DM₁ exactly. Secondary: assert +DI > −DI, ADX > 20, direction Bullish. **Guard** per the Task 0 no-op convention (Neutral no-op if `highs`/`lows` shorter than `required_lookback()`).

### Task 3: Supertrend
`id="supertrend"`, params (ATR period 10, multiplier 3), `required_lookback=11`. Needs `highs/lows/closes`. Line = final upper/lower band from ATR; direction: close above line → Bullish (uptrend), below → Bearish. Use `relative_magnitude(close, line)`. **Test input:** 20-bar uptrend ramp ⇒ Supertrend line sits **below** close ⇒ **Bullish**; assert line < last close and direction Bullish. If `rust_ti` lacks Supertrend, use `yata::indicators::` equivalent or hand-roll (band = midpoint ± mult·ATR with the standard trend-flip carry). **Exact externally-verifiable anchor:** on a flat series `H=11, L=10, C=10.5` for every bar, each TR = max(H−L, |H−Cₚᵣₑᵥ|, |L−Cₚᵣₑᵥ|) = max(1, 0.5, 0.5) = 1 ⇒ ATR(10) = **1.0**; first basic bands by the hand formula (H+L)/2 ± mult·ATR = 10.5 ± 3·1 ⇒ basicUpper = **13.5**, basicLower = **7.5**. Assert ATR==1.0, basicUpper==13.5, basicLower==7.5; keep the uptrend-ramp `line < last close` + Bullish as secondary. **Guard** per the Task 0 no-op convention (Neutral no-op if `highs`/`lows` shorter than `required_lookback()`).

### Task 4: Ichimoku
`id="ichimoku"`, `required_lookback=52` (senkou B span). Needs `highs/lows/closes`. Tenkan(9), Kijun(26), Senkou A/B, Chikou. Direction: price above cloud AND Tenkan>Kijun → Bullish; below cloud AND Tenkan<Kijun → Bearish; else Neutral. **Test input:** 60-bar uptrend ramp `high_i=10+i, low_i=8+i, close_i=9+i` (i=0..59). **Exact externally-verifiable anchors** (midpoints, crate-independent): Tenkan = (max(high[51..60]) + min(low[51..60]))/2 = (69+59)/2 = **64.0**; Kijun = (max(high[34..60]) + min(low[34..60]))/2 = (69+42)/2 = **55.5**. Assert Tenkan==64.0 and Kijun==55.5 exactly; secondary: Tenkan>Kijun, close above cloud, Bullish. `yata` fallback if `rust_ti` lacks it. **Guard** per the Task 0 no-op convention (Neutral no-op if `highs`/`lows` shorter than `required_lookback()`).

### Task 5: Parabolic SAR
`id="psar"`, params (AF start 0.02, step 0.02, max 0.2), `required_lookback=5`. Needs `highs/lows`. Direction: SAR below price → Bullish (long), above → Bearish. **Test input:** 15-bar uptrend ramp `high_i=10+i, low_i=8+i` (initial long). **Exact externally-verifiable anchor (Wilder init):** seed SAR₀ = prior extreme = low[0] = **8.0**, EP = high[0] = 10.0, AF = 0.02 ⇒ first computed SAR₁ = SAR₀ + AF·(EP−SAR₀) = 8 + 0.02·(10−8) = **8.04**. Assert SAR₀==8.0 and SAR₁==8.04 exactly; secondary: `sar < last close` and Bullish. Hand-roll from Wilder if neither crate exposes it. **Guard** per the Task 0 no-op convention (Neutral no-op if `highs`/`lows` shorter than `required_lookback()`).

### Task 6: Stochastic (14/3/3)
`id="stochastic"`, `required_lookback=16` (14 + %D smoothing). Needs `highs/lows/closes`. Fast %K = (C−LL)/(HH−LL)·100 over 14; %D = SMA₃(%K). Direction: %K>80 → Bearish (overbought), <20 → Bullish (oversold), else Neutral. **Test input (period 3 for hand-check):** last 3 bars `high=[12,13,14], low=[10,11,9], close=13` ⇒ HH=14, LL=9 ⇒ **%K = (13−9)/(14−9)·100 = 80.0** exactly. Assert %K==80.0; separately assert classifier(85)=Bearish, classifier(15)=Bullish, classifier(50)=Neutral. **Guard** per the Task 0 no-op convention (Neutral no-op if `highs`/`lows` shorter than `required_lookback()`).

### Task 7: CCI (20)
`id="cci"`, `required_lookback=20`. Needs `highs/lows/closes`. TP=(H+L+C)/3, CCI=(TP−SMA(TP))/(0.015·MeanDev). Direction: CCI>100 → Bullish, <−100 → Bearish, else Neutral. **Test input (period 3):** bars TP=`[23,24,25]` from `high=[24,25,26], low=[22,23,24], close=[23,24,25]` ⇒ SMA=24, MeanDev=(1+0+1)/3=2/3 ⇒ **CCI=(25−24)/(0.015·2/3)=100.0** exactly. Assert CCI≈100.0; classifier(150)=Bullish, (−150)=Bearish, (50)=Neutral. **Guard** per the Task 0 no-op convention (Neutral no-op if `highs`/`lows` shorter than `required_lookback()`).

### Task 8: Williams %R
`id="williams_r"`, `required_lookback=14`. Needs `highs/lows/closes`. %R=(HH−C)/(HH−LL)·(−100). Direction: %R>−20 → Bearish (overbought), <−80 → Bullish (oversold), else Neutral. **Test input (period 3):** `high=[12,13,14], low=[10,11,9], close=13` ⇒ HH=14, LL=9 ⇒ **%R=(14−13)/(14−9)·−100 = −20.0** exactly. Assert %R≈−20.0; classifier(−10)=Bearish, (−90)=Bullish, (−50)=Neutral. **Guard** per the Task 0 no-op convention (Neutral no-op if `highs`/`lows` shorter than `required_lookback()`).

### Task 9: ROC
`id="roc"`, param period 2 (test)/12 (register default), `required_lookback=period+1`. Closes only. ROC=(C−C₍ₙ₋ₚ₎)/C₍ₙ₋ₚ₎·100. Direction: ROC>0 → Bullish, <0 → Bearish, ==0 → Neutral; `magnitude=|ROC|`. **Test input:** `closes=[10,11,12,13,14]`, period 2 ⇒ **ROC=(14−12)/12·100 = 16.6667** ⇒ Bullish. Assert ROC≈16.66667 and Bullish.

### Task 10: Bollinger Bands (20, ±2σ)
`id="bollinger"`, `required_lookback=20`. Closes only. Mid=SMA20, σ=**population** SD (n divisor, per StockCharts), upper=mid+2σ, lower=mid−2σ. Direction via `classify_by_distance(close, mid)`. **Test input:** `closes=(1..=20)` ⇒ mid=**10.5**, σ=√((20²−1)/12)=√33.25≈**5.766281**, upper≈**22.032563**, lower≈**−1.032563**; last close 20 > mid ⇒ **Bullish**. Assert mid, σ, upper (1e-6), Bullish.

### Task 11: ATR (Wilder, 14)
`id="atr"`, `required_lookback=period+1`. Needs `highs/lows/closes`. TR=max(H−L, |H−Cₚᵣₑᵥ|, |L−Cₚᵣₑᵥ|); ATR = Wilder-smoothed (seed = simple mean of first `period` TRs, then `(ATRₚᵣₑᵥ·(p−1)+TR)/p`) — **not** an SMA (why-comment cites Wilder). Non-directional: `direction=Neutral`, `magnitude=ATR`. **Test input (period 3):** closes/H/L: seed close 10; bars (H,L,C) = `(12,10,11),(13,11,12),(15,11,14),(16,14,15)` ⇒ TRs = `2,2,4,2` ⇒ seed=(2+2+4)/3=8/3, Wilder step=(8/3·2+2)/3 = **22/9 ≈ 2.444444**. Assert ATR≈2.444444, direction Neutral. **Guard** per the Task 0 no-op convention (Neutral no-op if `highs`/`lows` shorter than `required_lookback()`).

### Task 12: Keltner Channels
`id="keltner"`, `required_lookback=20`. Needs `highs/lows/closes`. Mid=EMA20(close), bands=mid±2·ATR10. Direction: close>upper → Bullish, <lower → Bearish, else via `classify_by_distance(close, mid)`. **Test input:** 25-bar uptrend ramp ⇒ bands ordered lower<mid<upper and close above mid ⇒ **Bullish**; assert ordering + Bullish. **De-circularized exact anchor:** on a constant series `closes=[10.0; 25]` (with `highs=[11.0; 25]`, `lows=[9.0; 25]`), the EMA20 of a constant series equals that constant, so `mid == 10.0` — assert `mid==10.0` against this independently hand-computed value, NOT the output of the same EMA helper the algo calls. **Guard** per the Task 0 no-op convention (Neutral no-op if `highs`/`lows` shorter than `required_lookback()`).

### Task 13: Donchian Channels
`id="donchian"`, `required_lookback=period`. Needs `highs/lows`. Upper=max(H,n), Lower=min(L,n), Mid=(U+L)/2. Direction via `classify_by_distance(close, mid)`. **Test input (period 3):** `high=[12,13,14], low=[10,9,11]` ⇒ Upper=**14**, Lower=**9**, Mid=**11.5**. Assert all three exactly; with last close 13 > mid ⇒ Bullish. **Guard** per the Task 0 no-op convention (Neutral no-op if `highs`/`lows` shorter than `required_lookback()`).

### Task 14: OBV
`id="obv"`, `required_lookback=2`. Needs `closes/volumes`. OBV += sign(ΔC)·V (0 on unchanged), cumulative from 0. Direction: last ΔOBV>0 → Bullish, <0 → Bearish, ==0 → Neutral; `magnitude=|last ΔOBV|`. **Test input:** `closes=[10,11,10,12], volumes=[100,200,150,300]` ⇒ OBV path 0→+200→+50→**350**; last step +300 ⇒ **Bullish**. Assert OBV==350.0 and Bullish. **Guard** per the Task 0 no-op convention (Neutral no-op if `volumes` shorter than `required_lookback()`).

### Task 15: session-anchored VWAP (9:15 IST reset)
`id="vwap"`, `required_lookback=1`. Needs `highs/lows/closes/volumes/timestamps`. TP=(H+L+C)/3; VWAP=Σ(TP·V)/Σ(V) accumulated **from the most recent 09:15 IST session open** (reset when a bar's IST calendar-session differs from the prior bar's). Direction via `classify_by_distance(close, vwap)`. **Test input (one session):** two bars, TP via H/L/C ⇒ TP=[10,11], V=[100,100], same session ⇒ **VWAP=(10·100+11·100)/200 = 10.5**; last close 11 > VWAP ⇒ Bullish. Second test: a bar with a next-day IST timestamp **resets** accumulation (VWAP of the new session == that bar's TP). Assert VWAP==10.5 and the reset behavior. (Session boundary: convert `ts` to IST, bucket by trading date; why-comment cites 09:15 IST anchor.) **Guard** per the Task 0 no-op convention (Neutral no-op if `volumes`/`timestamps` shorter than `required_lookback()`).

### Task 16: MFI
`id="mfi"`, `required_lookback=period+1`. Needs `highs/lows/closes/volumes`. TP=(H+L+C)/3, RawMF=TP·V, split by TP↑/↓, MFR=ΣposMF/ΣnegMF, MFI=100−100/(1+MFR). Direction: MFI>80 → Bearish, <20 → Bullish, else Neutral. **Test input (period 2):** bars TP=[10,11,9] (from H/L/C), V=[·,100,100] ⇒ posMF=11·100=1100, negMF=9·100=900 ⇒ MFR=1.2222, **MFI=100−100/2.2222 = 55.0**. Assert MFI≈55.0, Neutral. **Guard** per the Task 0 no-op convention (Neutral no-op if `highs`/`lows`/`volumes` shorter than `required_lookback()`).

### Task 17: CMF
`id="cmf"`, `required_lookback=period`. Needs `highs/lows/closes/volumes`. MFM=((C−L)−(H−C))/(H−L), MFV=MFM·V, CMF=Σ(MFV,n)/Σ(V,n). Direction: CMF>0 → Bullish, <0 → Bearish, ==0 → Neutral. **Test input (period 2):** bar1 `H=10,L=8,C=9.5,V=100` ⇒ MFM=0.5, MFV=50; bar2 `H=11,L=9,C=9.5,V=200` ⇒ MFM=−0.5, MFV=−100 ⇒ **CMF=(50−100)/(100+200)=−0.166667** ⇒ Bearish. Assert CMF≈−0.166667. **Guard** per the Task 0 no-op convention (Neutral no-op if `highs`/`lows`/`volumes` shorter than `required_lookback()`).

### Task 18: Accumulation/Distribution
`id="accumulation_distribution"`, `required_lookback=2`. Needs `highs/lows/closes/volumes`. ADL += MFV (MFM as in CMF; MFM=0 when H==L). Direction: last ΔADL>0 → Bullish, <0 → Bearish, ==0 → Neutral. **Test input:** bar1 `H=10,L=8,C=9.5,V=100` ⇒ MFV=50 ⇒ ADL=50; bar2 `H=11,L=9,C=9.5,V=200` ⇒ MFV=−100 ⇒ **ADL=−50**; last step −100 ⇒ Bearish. Assert ADL==−50.0 and Bearish. **Guard** per the Task 0 no-op convention (Neutral no-op if `highs`/`lows`/`volumes` shorter than `required_lookback()`).

### Task 19: Volume Profile
`id="volume_profile"`, `required_lookback=1`. Needs `highs/lows/volumes`. **Distribute each bar's volume as uniform density across `[Low,High]` and accumulate into fixed-width price bins by OVERLAP-FRACTION** (design §6.2: NOT close-only, NOT equal-split-per-touched-bin — both documented bugs). POC = bin with max accumulated volume. Direction via `classify_by_distance(close, poc_mid)`. **Test input (bin width 1.0):** bar1 `L=10,H=12,V=100`; bar2 `L=11,H=13,V=100` ⇒ bins `[10,11)=50, [11,12)=100, [12,13)=50` ⇒ **POC bin = [11,12), mid 11.5, volume 100**. Assert POC mid==11.5 and its volume==100.0. **Guard** per the Task 0 no-op convention (Neutral no-op if `highs`/`lows`/`volumes` shorter than `required_lookback()`).

---

## Wave B — Options/F&O overlays (Tasks 20-24)

> Every Wave-B task: **Depends on Task 0. Parallel-safe: yes.** Files: fill `crates/algo-core/src/options/<name>.rs` + create `crates/algo-core/tests/<name>_test.rs`. **HARD CONSTRAINT: `direction` is ALWAYS `Direction::Neutral`** (descriptive overlays, design §6.2). `required_lookback=0`; the algo reads `ctx.options`/`ctx.chain` and returns a `Neutral` "no options context" no-op (empty magnitude, evidence `"no options context"`) when absent, so it always registers and never panics. Register via `inventory::submit!`.

### Task 20: Black-Scholes-Merton Greeks
`id="bsm_greeks"`. Reads `ctx.options`. Compute Delta/Gamma/Theta/Vega/Rho via `blackscholes 0.24.0`. `direction=Neutral`; Greeks land in `evidence` (e.g. `"delta=0.6368 gamma=0.0188 theta=... vega=... rho=..."`); `magnitude=|delta|`. **Test input (cross-checked textbook BSM, tol 1e-3):** S=100, K=100, r=0.05, σ=0.20, T=1, call ⇒ d1=0.35 ⇒ **call Delta=N(0.35)=0.636831**, **Gamma=φ(0.35)/(100·0.20)=0.0187620**. Assert delta≈0.63683 and gamma≈0.018762 (1e-3), direction Neutral. (Confirm the `blackscholes` call signature on docs.rs for 0.24.0; the reference values are crate-independent.)

### Task 21: Implied Volatility
`id="implied_vol"`. Reads `ctx.options.market_price`. Solve IV via `implied-vol 2.0.0` (Jäckel "Let's Be Rational" — robust near-zero-vega, unlike naive Newton-Raphson; why-comment cites this). `direction=Neutral`, `magnitude=iv`, evidence `"iv=0.2000"`. **Test input (round-trip, tol 1e-4):** price the S=100,K=100,r=0.05,σ=0.20,T=1 call ⇒ **call price = 10.450584**; feed that price back ⇒ recovered **IV ≈ 0.2000**. Assert iv≈0.20 (1e-4), Neutral.

### Task 22: OI buildup classification
`id="oi_buildup"`. Reads `ctx.options` (`close` vs `prev_close` from `ctx.closes[-2..]`, `oi` vs `prev_oi`). 2×2 price×OI matrix: price↑&OI↑=**long buildup**, price↑&OI↓=**short covering**, price↓&OI↑=**short buildup**, price↓&OI↓=**long unwinding**. `direction=Neutral` (overlay — the label is a human-judgment hint, never a signal); label in `evidence`. **Test input:** last two closes `[100, 102]` (price↑) and `oi=1200, prev_oi=1000` (OI↑) ⇒ evidence contains **"long buildup"**, direction **Neutral**. Assert both; add a second case price↓&OI↓ ⇒ "long unwinding". **Guard** per the Task 0 no-op convention: with `required_lookback=0`, return the Neutral no-op if `ctx.options` is `None` OR `ctx.closes.len() < 2` (before indexing `closes[len-2..]`).

### Task 23: Put-Call Ratio
`id="put_call_ratio"`. Reads `ctx.chain`. PCR = Σ put_oi / Σ call_oi. `direction=Neutral`, `magnitude=pcr`, evidence `"pcr=1.50"`. **Test input:** chain with Σput_oi=1500, Σcall_oi=1000 ⇒ **PCR=1.5**. Assert pcr≈1.5, Neutral. Guard Σcall_oi==0 ⇒ evidence "undefined pcr (zero call OI)", magnitude 0 (reuse the zero-baseline discipline).

### Task 24: Max Pain
`id="max_pain"`. Reads `ctx.chain`. For each candidate strike S, pain(S)=Σₖ call_oiₖ·max(S−Kₖ,0) + put_oiₖ·max(Kₖ−S,0); Max Pain = argmin pain. `direction=Neutral`, `magnitude=0`, evidence `"max_pain=110 (meaningful only near expiry)"` — MUST note the near-expiry caveat (design §6.2). **Test input:** strikes `[100,110,120]`, call_oi=`[10,10,10]`, put_oi=`[10,10,10]` ⇒ pain(100)=300, pain(110)=200, pain(120)=300 ⇒ **Max Pain = 110**. Assert strike==110, Neutral, evidence contains "near expiry".

---

## Wave C — Statistical/quant (Tasks 25-31)

> Every Wave-C task: **Depends on Task 0. Parallel-safe: yes.** Files: fill `crates/algo-core/src/quant/<name>.rs` + create `crates/algo-core/tests/<name>_test.rs`. Volatility estimators are **non-directional** (`direction=Neutral`, `magnitude=σ`). Cointegration/OU no-op (`Neutral`, evidence `"no peer context"`) when `ctx.peer` is `None`; MTF no-ops when `ctx.higher_tf` is `None`. Register via `inventory::submit!`.

### Task 25: Cointegration (Engle-Granger; Johansen documented)
`id="cointegration"`. Reads `ctx.closes` + `ctx.peer.closes`. **Engle-Granger (tested path):** OLS regress y=`peer` on x=`closes` (via `nalgebra`) → hedge ratio β + intercept; residual spread e = y−(βx+α); ADF test statistic on e (compare to `statrs`-derived critical values). `direction=Neutral` in v1 (evidence carries β, ADF stat, and cointegrated y/n). **Johansen:** provide as a documented `nalgebra` generalized-eigenvalue approximation, flagged (R3) as not-yet-validated. **Test input:** x=`closes=[1,2,3,4,5]`, peer y=`[2,4,6,8,10]` (y=2x exactly) ⇒ **β=2.0**, α≈0, residual variance≈0 ⇒ cointegrated=true. Assert β≈2.0 (1e-6) and residual variance < 1e-9; Neutral.

### Task 26: Ornstein-Uhlenbeck half-life + z-score bands
`id="ou_half_life"`. Reads the spread from `ctx.closes` vs `ctx.peer.closes` (or `ctx.closes` directly if no peer, treating it as the series). Fit AR(1): sₜ = a + b·sₜ₋₁ (OLS); λ=−ln(b); **half-life = ln(2)/λ = −ln(2)/ln(b)**; z-score = (s_last − mean)/std. Direction: z<−1 → Bullish (expect revert up), z>+1 → Bearish, else Neutral; `magnitude=|z|`, evidence carries half-life. **Test input:** spread series `[4,2,1,0.5,0.25]` (each halves ⇒ b=0.5, a=0) ⇒ **half-life=−ln2/ln0.5 = 1.0 bar** exactly. Assert half-life≈1.0 (1e-6); assert z-score sign classification on a constructed z.

### Task 27: Parkinson volatility
`id="parkinson"`. Reads `ctx.highs/lows`. σ²=(1/(4·ln2))·mean((ln(H/L))²). `direction=Neutral`, `magnitude=σ`. **Test input (1 bar):** H=e (2.718281828), L=1 ⇒ ln(H/L)=1 ⇒ **σ²=1/(4·ln2)=0.360674**, σ=0.600561. Assert σ²≈0.360674 (1e-6), Neutral.

### Task 28: Garman-Klass volatility
`id="garman_klass"`. Reads `ctx.opens/highs/lows/closes`. σ²=mean(0.5·(ln(H/L))² − (2ln2−1)·(ln(C/O))²). `direction=Neutral`, `magnitude=σ`. **Test input (1 bar):** H=e, L=1, O=1, C=1 ⇒ second term 0 ⇒ **σ²=0.5·1=0.5**, σ=0.707107. Assert σ²≈0.5 (1e-6), Neutral.

### Task 29: Yang-Zhang volatility (default estimator)
`id="yang_zhang"`. Reads `ctx.opens/highs/lows/closes`. σ²_YZ = σ²_overnight + k·σ²_open-close + (1−k)·σ²_RS, k=0.34/(1.34+(n+1)/(n−1)); σ²_RS per bar = ln(H/C)ln(H/O)+ln(L/C)ln(L/O) (Rogers-Satchell). Preferred default because it handles overnight gaps + intraday jumps (design §6.2; why-comment). `direction=Neutral`, `magnitude=σ`. **Test input:** a 3-bar synthetic (opens/closes/highs/lows given in the test) for which the three variance terms are hand-derived in the test comment; assert σ²_YZ to 1e-6 against that derivation, and separately assert the per-bar Rogers-Satchell term on the clean bar H=e,L=1,O=C=1 equals **1.0** as the load-bearing anchor. Neutral.

### Task 30: GARCH(1,1)
`id="garch"`. Reads returns from `ctx.closes`. Runtime path: fit (ω,α,β) by MLE via a **hand-rolled bounded Nelder-Mead contained entirely in `garch.rs`** (no new crate — argmin rejected to avoid a shared `Cargo.toml` edit that would break parallel-safety; R2); forecast σ²ₜ=ω+α·r²ₜ₋₁+β·σ²ₜ₋₁. `direction=Neutral`, `magnitude=σ_forecast`, evidence carries long-run vol. **Test input (deterministic, no MLE):** fixed params ω=1e-5, α=0.10, β=0.85 ⇒ **long-run variance = ω/(1−α−β) = 1e-5/0.05 = 0.0002**, long-run σ=0.0141421; and assert one recursion step for a given (r,σ²ₚᵣₑᵥ). Assert long-run variance≈0.0002 (1e-9) and the recursion value. (R2: full MLE fit is the heaviest task; the unit test pins the recursion/long-run math, not the optimizer.)

### Task 31: Multi-timeframe confluence
`id="confluence_mtf"`. Reads `ctx.closes` (base TF) + `ctx.higher_tf.closes` (forward-filled higher TF, **no lookahead** — the higher-TF value is the last one fully closed at or before `ctx.as_of`). Compute the same simple trend rule (close vs SMA) per timeframe; combine via a **labeled weighted-sum / count-of-conditions-met rule engine** (bespoke — design §6.2 notes no standard formula; why-comment). Direction = sign of the weighted sum; `magnitude=|weighted sum|`; evidence lists per-TF votes. **Test input:** base ramp (Bullish) with weight 1.0 + higher_tf ramp (Bullish) with weight 2.0 ⇒ weighted sum = +3/3 = **+1.0** ⇒ Bullish; a base-Bullish(+1) vs higher-Bearish(−2) ⇒ −1/3 ⇒ Bearish. Assert the exact weighted-sum sign/value for both.

---

## Wave D — Kronos (Task 32, LAST, isolated)

### Task 32: Kronos ONNX forecaster (feature-gated)
**Depends on Task 0. Parallel-safe: yes** but **sequenced LAST and fully isolated** — all code under `#[cfg(feature = "kronos")]`, so the default `cargo build`/`cargo test --workspace` never compiles `ort`/ONNX Runtime and a Kronos stall blocks nothing (design §6.2, spike recommendation). Files: fill `crates/algo-core/src/forecast/kronos.rs` + create `crates/algo-core/tests/kronos_test.rs`; assumes committed `.onnx` assets under `crates/algo-core/assets/kronos/` for the **`small` (~24.7M params) default checkpoint** (Q4/R5) — mini/base are alternatives, but this task builds and tests against `small`.

`id="kronos"`. Loads the four exported ONNX graphs (`tokenizer.encode`, `tokenizer.decode`, `decode_s1`, `decode_s2`) **once at construction** via `ort::Session` (per spike; BSQ tokenizer stays in-graph — no Rust reimpl needed). `compute()` runs the **deterministic greedy (top_k=1 argmax)** autoregressive driver loop in Rust (buffer bookkeeping + argmax only — no RNG), using the **fixed-max-context + padding-mask** decode path (spike §5; NOT naive `dynamic_axes`, which silently drifts). Output = forecast band + conviction presented as a labeled **"model opinion"** (evidence prefixed `"model opinion:"`), NEVER a headline verdict. Direction from forecast sign (up→Bullish, down→Bearish, flat→Neutral); `magnitude=|forecast return|`, `confidence=conviction`. **Test (behind `--features kronos`, else `#[ignore]`):** feed the spike's regression-fixture 256-bar window; assert the reconstructed forecast matches the committed reference within the spike's tolerance (max rel err < 1e-3), and greedy argmax matches. On a monotone-up synthetic window assert direction Bullish. Registration is `#[cfg(feature = "kronos")] inventory::submit! { ... }`.

---

### Task 33: Catalog completion checkpoint (registration count + green build + DoD replay)

**Depends on:** Tasks 0-32. **Parallel-safe: no** (final verification).

**Files:** Modify `rust-core/crates/algo-core/tests/registry_count_test.rs` (tighten the count); no new source.

- [ ] **Step 1: Registration-count assertion.** Update `registry_count_test.rs`: under **default features** `registry::all().len() == 34` (3 existing + 31 new non-Kronos: Tasks 1-31) and the id set equals the expected 34 ids (list them explicitly). Add a `#[cfg(feature = "kronos")]` test asserting `len() == 35` and that `"kronos"` is present. Run to confirm every catalog algorithm actually registered.
- [ ] **Step 2: Whole-branch green.** Run `cd rust-core && cargo test --workspace` (all green; Phase-2 network test still the only `#[ignore]`), then `cargo test --workspace --features kronos` (if assets present), then `cargo clippy --all-targets -- -D warnings` (zero warnings), then `cargo tree -i openssl` (empty). Fix any drift.
- [ ] **Step 3: Phase-2 DoD replay run incl. new indicators.** Run the `replay` CLI on a bhavcopy-sourced series from the lake and confirm the per-algorithm hit-rate report now includes the new directional indicators (macd, adx, supertrend, ichimoku, psar, stochastic, cci, williams_r, roc, bollinger, keltner, donchian, obv, vwap, mfi, cmf, accumulation_distribution, volume_profile, cointegration, ou_half_life, confluence_mtf) alongside sma/ema/rsi, and that the Neutral-only overlays (bsm_greeks, implied_vol, oi_buildup, put_call_ratio, max_pain) + non-directional vol estimators (atr, parkinson, garman_klass, yang_zhang, garch) appear with `directional_calls == 0`. Record the report in the commit message.
- [ ] **Step 4: Commit.**
  ```bash
  git add rust-core/
  git commit -m "test(algo-core): full catalog registration-count assertion; DoD replay incl. new indicators"
  ```

---

## Catalog Definition of Done

- `cargo test --workspace` green (only the Phase-2 network smoke test `#[ignore]`d); `cargo clippy --all-targets -- -D warnings` clean; `cargo tree -i openssl` empty.
- **34 algorithms registered under default features** (3 Phase-1 + 31 catalog), **35 with `--features kronos`** — proven by `registry_count_test.rs`.
- Every catalog item is one `Algorithm` self-registered via `inventory::submit!` (SMA/EMA/RSI pattern), pure and deterministic (`ctx.as_of`, no wall-clock, no RNG, no I/O in `compute()`), unit-tested against the hand-computed/cross-checked reference value specified in its task.
- The **four Phase-2 carry-forwards are in** (atomic partition write, zero-close guard, `*.csv` + exchange-from-symbol CLI, series-ascending `debug_assert`).
- Options/OI analytics (`bsm_greeks`, `implied_vol`, `oi_buildup`, `put_call_ratio`, `max_pain`) emit `direction: Neutral` **unconditionally**; Max Pain carries the near-expiry caveat in evidence.
- Kronos is one more `Algorithm` (labeled "model opinion", greedy-deterministic, fixed-shape+padding-mask), fully isolated behind `--features kronos` so it never blocks the default roster.
- The Phase-2 replay engine and `compute_confluence`/`run_applicable` are **reused unchanged**; every `AlgoOutput` reaches the response layer (non-collapsing §6.3); the DoD replay run scores the new directional indicators.
- Nothing in this plan touches Kite, Claude, Electron, or any order path — by construction (design §2/§3/§4).
