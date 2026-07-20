# Forecaster Models (v1) — Granite-TTM r2 + Chronos-Bolt-small + Moirai-2.0-R-small via a Shared Forecaster Framework — Implementation Plan (Phase-2 Rust engine, Spike-First)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Each task carries **Depends / Parallel-safe / Files / Interfaces / numbered Steps (failing-test-first) / Commit** — designed so a fresh implementer subagent can execute exactly one task from its brief plus Task 0. Read Task 0 first (it is the shared enabling change). **Every model integration (Tasks 4-6) is HARD-GATED on its own spike's GO verdict (Tasks 1-3): if a spike is NO-GO, its integration task does not run and its cargo feature is never added.**

> **Scope note.** This is more Phase-2 Rust-engine work — a forecaster extension of the algorithm catalog, in the same `phase-2-*` branch family as the foundation and catalog plans (branch `phase-2-forecaster-models`), building entirely inside `algo-core`/`backtest`. The Electron shell, Kite MCP integration, and Claude AI pipeline remain later phases in the roadmap and are untouched here. The algorithm catalog (merged at `main` = PR #3) shipped 34 default `Algorithm`s plus a feature-gated **Kronos** ONNX forecaster (`--features kronos` ⇒ 35). This plan adds THREE more time-series foundation-model forecasters — **Granite-TTM r2**, **Chronos-Bolt-small**, **Moirai-2.0-R-small** — behind a **new generic forecaster framework** the three plug into. **Kronos stays bespoke and is NOT refactored onto the framework** (its candlestick tokenizer + autoregressive greedy driver are special; touching it would risk a shipped, validated path for zero benefit).

**Goal:** Introduce a reusable ONNX-forecaster framework in `algo-core`, then add TTM / Chronos / Moirai as three feature-gated `Algorithm`s plugged into it, each preceded by a mandatory feasibility spike (fixed-shape ONNX export + numeric cross-validation vs PyTorch → GO/NO-GO), each labeled a non-collapsing "model opinion", and prove value (or its absence) via a multi-symbol / multi-horizon benchmark against the deterministic catalog + Kronos.

**Architecture.** One new `forecast/framework.rs` provides: (a) an N-graph fixed-shape `ort::Session` loader parked behind a per-model `OnceLock<Arc<…>>` singleton (generalizing Kronos's `KronosSessions` pattern, **not** reusing Kronos's own singleton); (b) a `ForecasterAdapter` trait describing each model's plug-in shape (input series, context length, normalization, output kind point-vs-quantile, conviction derivation); (c) a generic `ForecastAlgorithm<A: ForecasterAdapter>` wrapper implementing `Algorithm`, mapping an adapter's `ForecastSummary { forecast_return, conviction, evidence }` to an `AlgoOutput` with the shared forecast-sign dead-band and `"model opinion:"` evidence prefix; (d) the Neutral no-op guard. Each model gets its own `forecast/<model>.rs` (adapter + singleton + `inventory::submit!`) and a pure `forecast/<model>_math.rs` (normalization + conviction math, hand-testable like `kronos_math.rs`). Everything new is `#[cfg]`-gated so the default build compiles zero `ort`.

**Tech Stack:** Rust (stable, 2021). Reuses the **already-present** `ort = "2.0.0-rc.12"` (`download-binaries`; bundles ONNX Runtime 1.24.2) — currently under the `kronos` feature; this plan makes it shared by the new features too. **No new Rust runtime deps expected**: Kronos proved `ort::value::TensorRef::from_array_view((shape, &[T]))` needs no `ndarray` (it was removed in Task 32), and quantile/ensemble post-processing is plain-slice arithmetic — if any spike finds an `ndarray` op is genuinely required, that is a flagged deviation, added as `ndarray = { version = "0.17", optional = true }` in Task 0's scaffold only when proven. Export tooling (build-time only, never shipped): Python 3.12 venv, `torch==2.13.0` (CPU wheel), `onnx==1.22.0`, `onnxruntime==1.27.0`, opset **18**, `dynamo=False` — the exact Kronos recipe.

---

## Real interfaces this plan builds on (confirmed against source, do not assume)

- `algo_core::Algorithm` trait: `id() -> &'static str`, `required_lookback() -> usize`, `applicable_horizons() -> &'static [Horizon]`, `compute(&self, &MarketContext) -> AlgoOutput` (`crates/algo-core/src/algorithm.rs`).
- `algo_core::AlgoOutput { algo_id, symbol, timeframe, horizon, direction, magnitude: f64, confidence: f64, evidence: Vec<String>, computed_at }`; `Direction { Bullish, Bearish, Neutral }`; `Horizon { Intraday, Positional }`; `Timeframe { Minute, FiveMinute, FifteenMinute, Day }`.
- `MarketContext` carries frontier-sliced `closes/opens/highs/lows/volumes/timestamps` (aligned 1:1 when present, else empty) + optional `options/chain/peer/higher_tf` + `as_of` — no lookahead. Forecasters read `closes` (all three; univariate MVP) and `timestamps` only where a model conditions on calendar features (none of the three do — unlike Kronos).
- `registry::AlgorithmFactory(pub fn() -> Box<dyn Algorithm>)` + `inventory::collect!`/`inventory::submit!` — the exact SMA/EMA/RSI/Kronos registration mechanism. `submit!` lives at the bottom of the model's own file; no task edits a shared registration list.
- `registry::all()` and `registry::run_applicable(algos, ctx)` — the single lookback gate (`required_lookback() <= ctx.closes.len()`), reused **unchanged**. `required_lookback()` is a **bar count**.
- **Kronos precedent = the export/integration template** (do not deviate without a spike reason): fixed-shape graphs, opset 18, `dynamo=False`, **NOT** `dynamic_axes` (measured to silently drift + flip argmax at off-trace lengths); assets via git-lfs under `crates/algo-core/assets/<model>/`; `include_bytes!` + `Session::commit_from_memory`; `Mutex<Session>` for `&self`-compatible `compute()`; a process-wide `static SESSIONS: OnceLock<Arc<…>>` so `registry::all()`'s per-call factory re-invocation parses each graph at most once. See `crates/algo-core/src/forecast/kronos.rs`, `kronos_math.rs`, `docs/superpowers/spikes/2026-07-19-kronos-onnx-feasibility.md`, `.superpowers/sdd/task-32-report.md`.
- `backtest::engine::run_replay(...)` scores directional outputs (`Direction::Neutral => continue`), frontier-gated; `backtest::frontier::context_at(...)` builds the anti-lookahead `MarketContext`; `backtest/src/bin/replay.rs` is the existing single-run CLI. Task 8's benchmark harness wraps these — it does not modify them.

---

## Global Constraints (binding on EVERY task — verbatim-strong)

- **The app NEVER places, modifies, or cancels orders.** No order path, no Kite write endpoint, no Kite endpoint at all. Every task adds read-only compute.
- **`compute()` purity & determinism.** Reads only `ctx`; returns a pure deterministic function of `ctx`. **NO wall-clock** (`Utc::now`/`Instant::now`/system time) inside `compute()` — the instant is `ctx.as_of`. **No RNG** — all three forecasters are deterministic (point regression for TTM; direct single-shot quantile heads for Chronos/Moirai — no sampling, no `generate()` loop, no multinomial). **No I/O in `compute()`** except reading the once-loaded `ort::Session`s (loaded lazily at first factory call via the `OnceLock` singleton, never per-compute).
- **Anti-lookahead.** Read only `ctx.*[..=frontier]` as pre-sliced by `context_at`; never index or reconstruct a future bar. A forecaster consumes at most the most-recent `context_len` closes (truncating older history, as Kronos does).
- **Forecaster output is a labeled "model opinion", NEVER a headline verdict (§6.3 non-collapsing).** Every evidence line is `"model opinion:"`-prefixed. No task collapses, filters, or overwrites any output; `compute_confluence`/`run_applicable` are untouched. Every `AlgoOutput` reaches the response layer.
- **Feature-gated; the default build compiles ZERO `ort`.** `cargo build`/`cargo test --workspace` under default features must compile no `ort`/ONNX Runtime and register exactly 34 algorithms. A forecaster's ONNX assets, `ort` code, and `inventory::submit!` are all under its `#[cfg(feature = "…")]`.
- **`rustls` only, never `openssl`/`native-tls`.** `ort`'s `download-binaries` fetches the ONNX Runtime binary at **build time** (not app networking). `cargo tree -i openssl` must stay empty under every feature combination (see the Linux/native-tls caveat in the risks table).
- **Register via `inventory::submit!` exactly like sma.rs**, gated by the model's feature. Compile-time static registration only.
- **Every unit test asserts against a committed reference fixture** (the spike's numerically-cross-validated PyTorch reference) within the spike's stated tolerance, PLUS a directional sanity test on a synthetic monotone window. Failing-test-first (TDD): write the test, watch it fail for the stated reason, then implement to green.
- **Comment hygiene per `CLAUDE.md`.** Default no comments; only a non-obvious *why* earns one (a normalization-formula source, an upstream-op workaround, an invariant). Never restate the next line; never a numbered comment block above a function.
- **Assets via git-lfs**, scoped `--local` (as Task 32 did — never touch `~/.gitconfig`). Track `crates/algo-core/assets/<model>/*.onnx` before committing binaries.
- **Branch + commits.** New feature branch off current `main` (catalog merged): `phase-2-forecaster-models`. Commit author **`hadetan` only, NO `Co-Authored-By` trailer** (this overrides the repo `CLAUDE.md` co-author default, matching Task 32's convention). Open the PR only at the end (Task 8).

---

## Crate/version assumptions (verified where possible) & feasibility risks

| Item | State | Verified? |
|---|---|---|
| `ort = "2.0.0-rc.12"` (`download-binaries`, ONNX Runtime 1.24.2) | Already in `algo-core/Cargo.toml` under `kronos` | ✅ read from Cargo.toml + Task 32 report |
| `ndarray` | **Absent** (removed in Task 32; `TensorRef::from_array_view` needs it not) | ✅ read from Cargo.toml — add only if a spike proves it needed |
| git-lfs | Already configured for `assets/kronos/*.onnx` in `.gitattributes` | ✅ read from `.gitattributes` |
| Default registration count | 34 (Kronos +1 ⇒ 35) | ✅ read from Task 32 report + catalog plan |
| Export recipe (opset 18, `dynamo=False`, no `dynamic_axes`) | Kronos-proven | ✅ spike doc + Task 32 report |

**Genuine feasibility / version risks (flagged, not guessed):**

- **R1 — No first-party fixed-shape ONNX exists for ANY of the three; all three are first-of-its-kind in-house exports.** TTM: no IBM/Optimum recipe (sibling **PatchTST** has ONNX precedent only). Chronos-Bolt: the only community export (canerturkmen's branch, Discussion #272) uses **`dynamic_axes` — the exact technique Kronos rejected as drift-prone**; only the `aten::nanmean` op-swap is liftable. Moirai-2.0: **zero ONNX precedent anywhere** (GitHub code-search = 0 hits) — no reference patch, no fixture, hardest of the three. **This is precisely why every integration is spike-gated.** Feasibility cannot be confirmed from static analysis — the spikes ARE the verification.
- **R2 — Chronos `aten::nanmean` unsupported op.** Known blocker with a known ~10-line hand-rolled fix (isnan/where/sum/clamp) from canerturkmen's branch; Task 2 must apply it before export.
- **R3 — TTM `TinyTimeMixerAddFFTPatches` (`rfft`/`topk`).** `resolution_prefix_tuning: false` in both inspected configs *should* leave it inert, but `frequency_token_vocab_size` is non-null — Task 1 MUST inspect the traced graph for stray `Fft`/`TopK` nodes, not trust the config flag alone (`rfft`/`TopK` have uneven opset support).
- **R4 — Moirai quantile-head + RoPE export is unproven.** First-of-its-kind quantile-head ONNX export (flag). RoPE + packed causal-bias may re-trigger the SDPA `is_causal` + `attn_mask` conflict that bit Kronos — the Kronos `module.py` export-time patch is the template. `PackedStdScaler` (causal "first-30%" statistics) trace-safety and the `[num_predict_token, quantiles, patch_size]` output reshape are untested. Short-horizon use lets Task 3 **skip the recursive multi-quantile decode loop** (the one genuinely graph-hostile part).
- **R5 — Chronos-Bolt-small is ~48M params / ~190 MB fp32 (LFS), well under `base`'s ~800 MB, `prediction_length` baked to 64.** **Decided (Q2, no longer open): ship `small` as the default, not `base`.** Per the Kronos base-vs-small finding (bigger checkpoints' quality gain sat inside measurement noise there): start lean; `base` (205M, ~800 MB) is a later upgrade path only, revisited if Task 8's multi-symbol benchmark shows `small` under-delivering. Still the heaviest of the three model assets (vs TTM ~3–12 MB/checkpoint, Moirai ~46 MB), but far lighter — and far less RAM/call — than `base` would have been. `prediction_length=64` is fine for next-step/near-horizon (read step 0…N of the 64); a horizon >64 would need a re-trace or a Rust-side rolling loop (out of scope).
- **R6 — `ort` is a pre-release `-rc.12`.** Accepted for Kronos; isolate the same way so any `ort` instability never blocks the default build.
- **R7 — `cargo tree -i openssl` platform caveat.** Confirmed empty under `kronos` on macOS (Task 32). On Linux, some `ort`/download-binaries or transitive path can pull `native-tls`/`openssl`; Task 7 must verify empty **per feature and per feature-combo**, and the plan flags Linux as the environment where this most likely regresses.

**Decisions locked before implementation** (Q1–Q4 numbering preserved for cross-references throughout the plan; Q1–Q3 are closed, Q4 ships with a concrete default that stays refinable at Task 8):

- **Q1 — Moirai CC-BY-NC-4.0 license — DECIDED.** Accepted for personal/non-commercial use (human confirmed). This is an eyes-open acceptance, not an open question: build it behind its own `moirai` feature with the acceptance noted in the module doc, so the default and the Apache-2.0-only (`ttm`/`chronos`) builds never pull NC-licensed assets. Nothing further gates Task 3's export effort.
- **Q2 — Chronos checkpoint — DECIDED.** `chronos-bolt-small` (~48M params, ~190 MB fp32), **NOT** `base`. Per the Kronos base-vs-small finding (bigger = gain inside noise): start lean; `base` (205M, ~800 MB) is a later upgrade path only, taken up if the Task-8 multi-symbol benchmark shows `small` falling short.
- **Q3 — TTM ensemble/conviction policy + channels — DECIDED.** Close-only (1 channel) MVP that degrades gracefully: use the largest of the `{512, 1024, 1536}` context checkpoints that fits the available history, ensembling all checkpoints in that fitting subset for directional-agreement conviction (single-checkpoint fallback = magnitude-scaled low conviction when only one checkpoint fits). `required_lookback = 512` (the smallest checkpoint's minimum, so the algorithm is at least eligible to run). Multivariate OHLCV input is a later enhancement, out of MVP scope.
- **Q4 — Benchmark evaluation set (Task 8) — default set, refinable at Task 8.** Eval set = the Yahoo→bhavcopy harness over ~15–20 liquid NSE symbols, horizons 1 & 5, ~2-year window. "Adds value" bar = **positive expectancy AND hit-rate CI clear of 0.5** across the set. Task 8 may refine the exact symbol list/window against confirmed data-lake coverage, but ships and runs against this default rather than blocking on further human input.

---

## File Structure

```
rust-core/
  crates/
    algo-core/
      Cargo.toml                     # Task 0: [features] ttm/chronos/moirai (+ forecasters aggregate); each = ["dep:ort"]
      assets/
        kronos/                      # unchanged
        ttm/*.onnx                   # Task 4 (LFS): ttm_512.onnx, ttm_1024.onnx, ttm_1536.onnx
        chronos/*.onnx               # Task 5 (LFS): chronos_bolt_small.onnx
        moirai/*.onnx                # Task 6 (LFS): moirai_2_small.onnx
      src/
        forecast/
          mod.rs                     # Task 0: gate framework + 3 models; kronos lines UNCHANGED
          framework.rs               # Task 0: ForecasterAdapter, ForecasterSessions, ForecastAlgorithm<A>, helpers
          kronos.rs, kronos_math.rs  # UNCHANGED — Kronos not refactored onto the framework
          ttm.rs, ttm_math.rs        # Task 4
          chronos.rs, chronos_math.rs# Task 5
          moirai.rs, moirai_math.rs  # Task 6
      tests/
        fixtures/                    # Tasks 4-6: <model>_context.csv + <model>_expected.csv (committed, from spike)
        ttm_test.rs chronos_test.rs moirai_test.rs   # Tasks 4-6
        forecaster_registry_test.rs  # Task 7: per-feature registration counts
    backtest/
      src/bin/
        replay.rs                    # unchanged
        bench_forecasters.rs         # Task 8: multi-symbol / multi-horizon benchmark harness
  docs/superpowers/spikes/
    2026-07-20-granite-ttm-onnx-feasibility.md   # Task 1 deliverable (GO/NO-GO)
    2026-07-20-chronos-bolt-onnx-feasibility.md  # Task 2 deliverable
    2026-07-20-moirai-2-onnx-feasibility.md      # Task 3 deliverable
__references/                        # gitignored: cloned granite-tsfm / chronos-forecasting / uni2ts for export
```

**Feature-gating scheme — DECISION: per-model features (`ttm`, `chronos`, `moirai`), NOT one `forecasters` feature.** Justification: (1) **asset asymmetry** — a single feature would force compiling `ort` + bundling ALL assets including the ~190 MB Chronos for a user who only wants 3 MB TTM; per-model lets you build exactly what you want. (2) **license isolation** — Moirai is CC-BY-NC-4.0; its own feature keeps the default and the Apache-2.0-only builds free of NC-licensed assets and auditable. (3) **spike independence** — a NO-GO spike simply means its feature is never added, with zero coupling to the others. (4) **consistency** with the existing per-model `kronos` feature. A convenience aggregate `forecasters = ["ttm", "chronos", "moirai"]` (and `all-forecasters = ["kronos", "ttm", "chronos", "moirai"]`) is added for the benchmark run only, layered on top of the per-model features.

---

## Task overview

| Task | Title | Depends | Parallel-safe |
|---|---|---|---|
| **0** | Generic forecaster framework + feature scaffold | none | NO (shared files) |
| **1** | Granite-TTM r2 feasibility spike (export + cross-validate → GO/NO-GO) | 0 | yes (1 of 3) |
| **2** | Chronos-Bolt-small feasibility spike (nanmean patch + export → GO/NO-GO) | 0 | yes (2 of 3) |
| **3** | Moirai-2.0-R-small feasibility spike (quantile-head export → GO/NO-GO) | 0 | yes (3 of 3) |
| **4** | Granite-TTM r2 integration (ensemble conviction) | 0 + Task 1 GO | yes (across models) |
| **5** | Chronos-Bolt-small integration (quantile-spread conviction) | 0 + Task 2 GO | yes (across models) |
| **6** | Moirai-2.0-R-small integration (quantile-spread conviction) | 0 + Task 3 GO | yes (across models) |
| **7** | Registration counts + whole-branch green + clippy + per-feature openssl-clean | 0,4,5,6 | NO (verification) |
| **8** | Multi-symbol / multi-horizon benchmark harness + final PR | 0-7 | NO (final) |

Spikes (1-3) are independent and can be dispatched in parallel. Integrations (4-6) touch disjoint files (`forecast/<model>.rs` + `<model>_math.rs` + `tests/<model>_test.rs` + `assets/<model>/`) and are parallel-safe across models, each gated on its own spike's GO.

---

### Task 0: Generic forecaster framework + feature scaffold

**Depends on:** none. **Parallel-safe: NO** — edits shared files (`Cargo.toml`, `forecast/mod.rs`) and creates `framework.rs` + empty stub files. Every later task depends on this being committed. **Kronos files are NOT touched.**

**Files:**
- Modify `rust-core/crates/algo-core/Cargo.toml` — add features.
- Modify `rust-core/crates/algo-core/src/forecast/mod.rs` — gate framework + 3 models (kronos lines unchanged).
- Create `rust-core/crates/algo-core/src/forecast/framework.rs`.
- Create empty stub files: `forecast/ttm.rs`, `ttm_math.rs`, `chronos.rs`, `chronos_math.rs`, `moirai.rs`, `moirai_math.rs`.

**Interfaces produced (every model task consumes these):**

```rust
// forecast/framework.rs  (all gated: #[cfg(any(feature="ttm",feature="chronos",feature="moirai"))])
use std::sync::{Arc, Mutex, OnceLock};
use ort::session::Session;
use crate::{AlgoOutput, Algorithm, Direction, Horizon, MarketContext};

/// N fixed-shape ONNX graphs loaded ONCE per model. Generalizes Kronos's
/// KronosSessions to an arbitrary named set. Kronos is NOT refactored onto this.
pub struct ForecasterSessions { sessions: Vec<(&'static str, Mutex<Session>)> }
impl ForecasterSessions {
    /// commit_from_memory each (name, bytes); panic on failure (packaging bug).
    pub fn load(graphs: &[(&'static str, &'static [u8])]) -> Self { /* ... */ }
    pub fn get(&self, name: &str) -> &Mutex<Session> { /* ... */ }
}

/// What an adapter's forward pass produced, before the shared AlgoOutput mapping.
pub struct ForecastSummary {
    pub forecast_return: f64,   // signed, at the target horizon vs last close
    pub conviction: f64,        // [0,1]
    pub evidence: Vec<String>,  // adapter builds these; framework enforces the "model opinion:" prefix
}

/// Per-model plug-in shape: input series, context length, normalization,
/// output kind (point vs quantile), and conviction derivation all live in the impl.
pub trait ForecasterAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn required_lookback(&self) -> usize;
    fn applicable_horizons(&self) -> &'static [Horizon];
    /// Build the normalized input in Rust (replicating the model's scaler
    /// EXACTLY — like kronos_math), run the once-loaded sessions, denormalize,
    /// and summarize. `None` = Neutral no-op (insufficient history / missing series).
    fn forecast(&self, ctx: &MarketContext) -> Option<ForecastSummary>;
}

/// Shared quantile-spread conviction (Chronos + Moirai): tight band => high.
pub fn conviction_from_quantile_spread(q10: f64, q90: f64, median: f64, recent_vol: f64) -> f64;

/// Shared forecast-sign dead-band -> Direction + full AlgoOutput, "model opinion:" enforced.
/// Same 1e-6 dead-band and magnitude=|forecast_return| convention as kronos.rs compute().
pub fn summary_to_output(id: &'static str, ctx: &MarketContext, s: ForecastSummary) -> AlgoOutput;
/// Neutral, magnitude 0. Its single evidence line is wrapped with the shared
/// "model opinion:" prefix -> "model opinion: <reason>", exactly like kronos.rs's
/// no-op (`src/forecast/kronos.rs:154`, asserted in tests/kronos_test.rs:172), so the
/// Global Constraint that EVERY forecaster evidence line is "model opinion:"-prefixed
/// holds on the guard path too. Tasks 4-6 test for this.
pub fn no_op(id: &'static str, ctx: &MarketContext, reason: &str) -> AlgoOutput;

/// Any adapter becomes an Algorithm. Models register ForecastAlgorithm<XAdapter> via inventory::submit!.
pub struct ForecastAlgorithm<A: ForecasterAdapter> { adapter: A }
impl<A: ForecasterAdapter> ForecastAlgorithm<A> { pub fn new(adapter: A) -> Self; }
impl<A: ForecasterAdapter> Algorithm for ForecastAlgorithm<A> { /* delegates; compute = forecast|no_op -> summary_to_output */ }
```

Each model owns its **own** `static SESSIONS: OnceLock<Arc<ForecasterSessions>>` + `shared_sessions()` in its own file (per-model singleton, using the shared loader) — mirroring `kronos.rs`, so no cross-model session sharing.

- [ ] **Step 1: Add features to `Cargo.toml` (failing check first).** Add:
  ```toml
  [features]
  kronos = ["dep:ort"]
  ttm = ["dep:ort"]
  chronos = ["dep:ort"]
  moirai = ["dep:ort"]
  forecasters = ["ttm", "chronos", "moirai"]
  all-forecasters = ["kronos", "ttm", "chronos", "moirai"]
  ```
  (`ndarray` is NOT added — see Tech Stack; add `ndarray = { version = "0.17", optional = true }` and append `"dep:ndarray"` to a feature ONLY if a spike proves a required `ndarray` op.)
- [ ] **Step 2: Write `framework.rs` (failing-test-first).** Add unit tests in `framework.rs` FIRST (RED): `summary_to_output` maps `+0.02`⇒Bullish / `-0.02`⇒Bearish / `<1e-6`⇒Neutral with `magnitude` = `|forecast_return|` and every evidence line `"model opinion:"`-prefixed; `no_op` is Neutral/0.0 with its evidence line `"model opinion: <reason>"` (prefix enforced on the guard path too); `conviction_from_quantile_spread` is 1.0 at zero spread and decreases monotonically as `q90-q10` widens, clamped `[0,1]`. Then implement to green. `ForecasterSessions`/`ForecastAlgorithm` need no unit test here (exercised by the model tasks); they must at least compile under `--features ttm`.
- [ ] **Step 3: Wire `forecast/mod.rs`.** Append (leaving the two existing `kronos` lines untouched):
  ```rust
  #[cfg(any(feature = "ttm", feature = "chronos", feature = "moirai"))]
  pub(crate) mod framework;
  #[cfg(feature = "ttm")]    mod ttm;    #[cfg(feature = "ttm")]    mod ttm_math;
  #[cfg(feature = "chronos")] mod chronos; #[cfg(feature = "chronos")] mod chronos_math;
  #[cfg(feature = "moirai")] mod moirai; #[cfg(feature = "moirai")] mod moirai_math;
  ```
  Create the six stub files empty (valid empty modules).
- [ ] **Step 4: Verify + Commit.** `cd rust-core && CARGO_TARGET_DIR=$PWD/target cargo build` (default, no ort), then `cargo build -p algo-core --features ttm` (framework compiles), `cargo clippy -p algo-core --features ttm --all-targets -- -D warnings`, `cargo tree -p algo-core --features ttm -i openssl` (empty). Commit: `feat(algo-core): generic ONNX forecaster framework + feature scaffold` (author hadetan, no co-author).

---

### Task 1: Granite-TTM r2 feasibility spike (export + numeric cross-validation → GO/NO-GO)

**Depends on:** Task 0. **Parallel-safe: yes** (spike 1 of 3; no product code — only a spike doc + committed fixtures + export scripts in `__references`/scratch).

**Files:** Create `docs/superpowers/spikes/2026-07-20-granite-ttm-onnx-feasibility.md`; produce `tests/fixtures/ttm_context.csv` + `tests/fixtures/ttm_expected_{512,1024,1536}.csv` (committed for Task 4); keep export/validate scripts in `__references/granite-tsfm` (gitignored) + scratch.

**Model facts (from dossier `granite-ttm.md`):** Apache-2.0. Point-only (`loss: mse`). Channel-independent; **close-only, 1 channel** MVP (Q3 decision). Three fixed-shape checkpoints = three git branches: `512-96-r2` (~1M), `1024-96-r2` (~4M), `1536-96-r2` (~5M). Input `past_values` `(1, context_len, 1)`. Internal `scaling: "std"` per-instance std-scaler (mean/std from the window, reversed on output) — replicate in Rust. Naturally fixed-shape (a genuine advantage). Export difficulty Low-Medium.

- [ ] **Step 1: Environment + reference.** Python 3.12 venv; `torch==2.13.0` CPU, `onnx==1.22.0`, `onnxruntime==1.27.0`, `transformers`, `granite-tsfm` (IBM `tsfm_public`). Clone into `__references/granite-tsfm`. Load each of the three checkpoints, run a PyTorch forward on a fixed close-only window, dump the reference point forecasts to `.npy`/CSV.
- [ ] **Step 2: Export three fixed-shape ONNX graphs.** For each checkpoint, wrap the model's forward in a plain `nn.Module` adapter and `torch.onnx.export(..., opset_version=18, dynamo=False)` at static `past_values` shape `(1, context_len, 1)` — NO `dynamic_axes`. Prefer keeping the internal std-scaler **in-graph** (it is pure elementwise arithmetic), and separately note the Rust-side scaler formula for parity.
- [ ] **Step 3: VERIFY the FFT/topk path is inert (R3).** Inspect each traced ONNX graph for stray `Fft`/`Rfft`/`TopK` nodes (do NOT trust `resolution_prefix_tuning: false` alone). Document the node scan result. If present, this is a NO-GO blocker to resolve (disable `use_fft_embedding`/re-export) before proceeding.
- [ ] **Step 4: Numeric cross-validation vs PyTorch (state tolerance).** Run each `.onnx` via onnxruntime (Python) then via Rust `ort`, diff the denormalized point forecast against the PyTorch reference. **GO bar: max relative error < 1e-3** (Kronos's target; expect ~1e-5–1e-6 float-kernel noise). Record per-checkpoint numbers.
- [ ] **Step 5: Document the conviction strategy — ensemble directional-agreement.** Per the Q3 decision: run the same window through the 512/1024/1536 checkpoints, conviction = fraction agreeing on `sign(forecast_return)` (+ magnitude dispersion note). Document exact input/output shapes, the std-scaler formula, the ensemble/degrade-gracefully policy, and required_lookback.
- [ ] **Step 6: Commit the spike doc + fixtures with a GO/NO-GO verdict.** `spike(algo-core): Granite-TTM r2 ONNX feasibility (GO|NO-GO)`.

---

### Task 2: Chronos-Bolt-small feasibility spike (nanmean patch + fixed-shape export → GO/NO-GO)

**Depends on:** Task 0. **Parallel-safe: yes** (spike 2 of 3).

**Files:** Create `docs/superpowers/spikes/2026-07-20-chronos-bolt-onnx-feasibility.md`; produce `tests/fixtures/chronos_context.csv` + `tests/fixtures/chronos_expected_quantiles.csv` (9×64 or the sliced target horizon); scripts in `__references/chronos-forecasting` + scratch.

**Model facts (from dossier `chronos-bolt.md`):** Apache-2.0. **~48M params, ~190 MB fp32 (Q2 decision — `small`, not `base`; see R5).** Univariate. T5 encoder-decoder. `context_length: 2048`, `patch_size: 16`, `prediction_length: 64` (baked). Output = 9 quantiles × 64 steps, single forward pass. Per-instance RevIN-style normalize (`loc=nanmean`, `scale=sqrt(nanmean((x-loc)^2))`, optional `arcsinh`) — replicate in Rust. **AutoGluon does NOT ship ONNX for Bolt** (brief's premise corrected); only community `dynamic_axes` PoC exists — lift ONLY the `nanmean` op-swap.

- [ ] **Step 1: Environment + reference.** Python 3.12 venv; `torch`/`onnx`/`onnxruntime` as above + `chronos-forecasting`. Load `amazon/chronos-bolt-small` (the Q2-decided checkpoint), run a PyTorch forward on a fixed **raw `closes`** window — univariate, matching TTM and Moirai per the Real Interfaces section (NOT log-returns; the model's own RevIN-style normalization is applied inside/at the graph, not by pre-differencing the input). If the spike finds a concrete reason to feed log-returns instead, that is a **flagged deviation** documented in the spike doc, never a silent choice. Dump the 9×64 quantile reference.
- [ ] **Step 2: PATCH `aten::nanmean` (R2).** Apply canerturkmen's ~10-line hand-rolled replacement (isnan/where/sum/clamp) in a local copy of `chronos_bolt.py` (export-only, not vendored). This is the only true unsupported op.
- [ ] **Step 3: Export ONE fixed-shape ONNX graph.** `torch.onnx.export(..., opset_version=18, dynamo=False)` feeding exactly `context_length=2048`, **pre-truncated/pre-padded to a multiple of 16 in the export driver** (the two data-dependent `if` branches — truncate-to-2048, NaN-pad-to-16 — then vanish from the traced graph). NO `dynamic_axes`. Confirm the traced graph is single-path.
- [ ] **Step 4: Numeric cross-validation vs PyTorch.** onnxruntime then Rust `ort`; diff the denormalized 9×64 quantile tensor against reference. **GO bar: max relative error < 1e-3.** Confirm `prediction_length=64` is baked and that reading step 0…N is sufficient for the target horizon.
- [ ] **Step 5: Document conviction — quantile spread.** `conviction = conviction_from_quantile_spread(q10, q90, q50, recent_vol)`; direction from `sign(q50_at_horizon − last_close)`; magnitude `|q50_return|`. Document input/output shapes, the RevIN formula (incl. `arcsinh` choice), and the ~190 MB asset (Q2/R5) — note `base` (205M, ~800 MB) as the later upgrade path if Task 8 justifies it.
- [ ] **Step 6: Commit the spike doc + fixtures with a GO/NO-GO verdict.** `spike(algo-core): Chronos-Bolt-small ONNX feasibility (GO|NO-GO)`.

---

### Task 3: Moirai-2.0-R-small feasibility spike (quantile-head export → GO/NO-GO)

**Depends on:** Task 0. **Parallel-safe: yes** (spike 3 of 3). **Q1 (license) is decided** — CC-BY-NC-4.0 accepted for personal/non-commercial use (human confirmed); proceed with export effort without further license gating.

**Files:** Create `docs/superpowers/spikes/2026-07-20-moirai-2-onnx-feasibility.md`; produce `tests/fixtures/moirai_context.csv` + `tests/fixtures/moirai_expected_quantiles.csv`; scripts in `__references/uni2ts` + scratch.

**Model facts (from dossier `moirai-2.md`):** Weights **CC-BY-NC-4.0** (code `uni2ts` is Apache-2.0) — accepted for personal/non-commercial use, Q1 decided. 11.4M, ~46 MB. Decoder-only, RoPE, RMSNorm, GLU FFN. Univariate. `d_model 384, num_layers 6, max_seq_len 512, patch_size 16, num_predict_token 4, quantile_levels [0.1..0.9]`. `num_predict_token(4) × patch_size(16) = 64` raw steps in ONE forward pass → **skip the recursive multi-quantile decode loop** for short horizons. Output reshape `[4, 9, 16]`. `PackedStdScaler` (causal). **Zero ONNX precedent (R1/R4) — hardest of the three.**

- [ ] **Step 1: Environment + reference.** Python 3.12 venv + `uni2ts`. Clone into `__references/uni2ts`. Load `Salesforce/moirai-2.0-R-small`, run a PyTorch forward on a fixed 512-close window (patchified to 32 tokens), dump the `[4,9,16]` quantile reference.
- [ ] **Step 2: Patch for trace-safety (R4).** Read `moirai2/module.py`; if the RoPE attention hits the SDPA `is_causal`+`attn_mask` conflict, apply the Kronos-style fold-causal-into-mask patch (export-only, local copy). Confirm `PackedStdScaler`'s statistics have no Python-side branching on tensor values. Confirm the `variate_id`/`sample_id` packing tensors collapse to constants for a single univariate series.
- [ ] **Step 3: Export ONE fixed-shape ONNX graph — VERIFY THE QUANTILE HEAD EXPORTS (R4, flag).** `torch.onnx.export(..., opset_version=18, dynamo=False)` at fixed `[1, 512]` context, single patch config, **only the one-forward-pass path (no recursive decode loop)**. This is the first-known quantile-head ONNX export of any Moirai. **The GO criterion is measurable — ALL of the following must hold, else NO-GO:** (a) the exported graph passes `onnx.checker.check_model`; (b) it contains NO dynamic-shape control-flow ops (`Loop`/`If`); (c) the `ResidualBlock` quantile head and the final `[num_predict_token, quantiles, patch_size]` reshape are present as STATIC ops; and (d) — like Tasks 1/2 — the exported graph's output cross-validates against the PyTorch-eager reference within **max relative error < 1e-3** on the fixture (see Step 4). Record each of the four checks explicitly in the spike doc.
- [ ] **Step 4: Numeric cross-validation vs PyTorch.** onnxruntime then Rust `ort`; diff the `[4,9,16]` quantile output against reference. **GO bar: max relative error < 1e-3.**
- [ ] **Step 5: Document conviction — quantile spread** (same helper as Chronos): direction from `sign(q50_at_horizon − last_close)`, magnitude `|q50_return|`, conviction from IQR/`(q90−q10)`. Document shapes, `PackedStdScaler` formula, the skip-recursive-decode decision, and **restate the CC-BY-NC-4.0 acceptance (Q1, decided)** in the doc.
- [ ] **Step 6: Commit the spike doc + fixtures with a GO/NO-GO verdict.** `spike(algo-core): Moirai-2.0-R-small ONNX feasibility (GO|NO-GO)`.

---

### Task 4: Granite-TTM r2 integration (ensemble conviction, feature-gated)

**Depends on:** Task 0 + **Task 1 GO**. **Parallel-safe: yes** (disjoint files across models). Skip entirely if Task 1 is NO-GO.

**Files:** Fill `forecast/ttm.rs` + `forecast/ttm_math.rs`; create `tests/ttm_test.rs`; add `assets/ttm/ttm_{512,1024,1536}.onnx` (LFS); commit `tests/fixtures/ttm_*.csv` from Task 1.

- [ ] **Step 1: LFS + assets.** `git lfs track "rust-core/crates/algo-core/assets/ttm/*.onnx"` (`--local`), add the three exported graphs, verify pointer-only in history.
- [ ] **Step 2: `ttm_math.rs` (failing-test-first).** Pure std-scaler (per-window mean/std normalize + reverse), directional-agreement conviction over the ensemble, point-return extraction. Unit tests against hand values first (RED), then implement.
- [ ] **Step 3: `ttm.rs` adapter (failing-test-first).** `TtmAdapter` implements `ForecasterAdapter`: `id="ttm"`, `required_lookback=512` (Q3 decision), close-only input `(1, ctx_len, 1)` per checkpoint. `forecast()` runs the subset of `{512,1024,1536}` sessions that fit history via the per-model `OnceLock<Arc<ForecasterSessions>>` singleton, denormalizes, computes ensemble direction/magnitude + agreement conviction, builds `"model opinion:"` evidence. Register `#[cfg(feature="ttm")] inventory::submit! { AlgorithmFactory(|| Box::new(ForecastAlgorithm::new(TtmAdapter::new()))) }`.
- [ ] **Step 4: `tests/ttm_test.rs`** (`#![cfg(feature = "ttm")]`): registered-in-registry; reconstructed forecast matches `tests/fixtures/ttm_expected_*.csv` within **< 1e-3 rel err** (per checkpoint); a monotone-up synthetic window ⇒ Bullish; a no-op guard test (short history ⇒ Neutral, `"model opinion:"` evidence).
- [ ] **Step 5: Verify + Commit.** `cargo test -p algo-core --features ttm`, `cargo clippy -p algo-core --features ttm --all-targets -- -D warnings`, `cargo build -p algo-core` (default unaffected), `cargo tree -p algo-core --features ttm -i openssl` (empty). Two commits (author hadetan, no co-author): `assets(algo-core): Granite-TTM r2 ONNX graphs (fixed-shape, LFS)` then `feat(algo-core): Granite-TTM r2 forecaster (feature-gated, ensemble conviction)`.

---

### Task 5: Chronos-Bolt-small integration (quantile-spread conviction, feature-gated)

**Depends on:** Task 0 + **Task 2 GO**. **Parallel-safe: yes**. Skip if Task 2 NO-GO.

**Files:** Fill `forecast/chronos.rs` + `chronos_math.rs`; create `tests/chronos_test.rs`; add `assets/chronos/chronos_bolt_small.onnx` (LFS, ~190 MB); commit `tests/fixtures/chronos_*.csv` from Task 2.

- [ ] **Step 1: LFS + asset.** `git lfs track "…/assets/chronos/*.onnx"` (`--local`), add the ~190 MB graph, verify pointer-only.
- [ ] **Step 2: `chronos_math.rs` (failing-test-first).** Pure RevIN-style normalize/denormalize (`loc`/`scale`, `arcsinh` per spike), patch-to-multiple-of-16 padding, `q50`-return + `conviction_from_quantile_spread` wiring. Hand-value unit tests first (RED), then implement.
- [ ] **Step 3: `chronos.rs` adapter (failing-test-first).** `ChronosAdapter`: `id="chronos"`, `required_lookback` per context (guard short history with left-pad-to-2048 exactly as exported), close-only, one session via the per-model `OnceLock` singleton. `forecast()` normalizes → runs → denormalizes 9×64 → reads target-horizon quantiles → direction `sign(q50−last_close)`, magnitude `|q50_return|`, conviction from `(q10,q50,q90)` spread, `"model opinion:"` evidence quoting q10/q50/q90. Register via `#[cfg(feature="chronos")] inventory::submit!`.
- [ ] **Step 4: `tests/chronos_test.rs`** (`#![cfg(feature="chronos")]`): registered; reconstructed quantiles match fixture within **< 1e-3 rel err**; monotone-up window ⇒ Bullish; tight-vs-wide synthetic band ⇒ higher-vs-lower conviction; no-op guard.
- [ ] **Step 5: Verify + Commit.** Same command matrix under `--features chronos`. Two commits: `assets(algo-core): Chronos-Bolt-small ONNX graph (fixed-shape, LFS)` then `feat(algo-core): Chronos-Bolt-small forecaster (feature-gated, quantile-spread conviction)`.

---

### Task 6: Moirai-2.0-R-small integration (quantile-spread conviction, feature-gated)

**Depends on:** Task 0 + **Task 3 GO**. Moirai's CC-BY-NC-4.0 license acceptance (Q1) is already decided — noted in the module doc, not a blocking gate. **Parallel-safe: yes**. Skip if Task 3 NO-GO.

**Files:** Fill `forecast/moirai.rs` + `moirai_math.rs`; create `tests/moirai_test.rs`; add `assets/moirai/moirai_2_small.onnx` (LFS); commit `tests/fixtures/moirai_*.csv` from Task 3.

- [ ] **Step 1: LFS + asset.** `git lfs track "…/assets/moirai/*.onnx"` (`--local`), add the ~46 MB graph, verify pointer-only. **Add a CC-BY-NC-4.0 attribution/NOTICE note in the module doc (Q1, decided).**
- [ ] **Step 2: `moirai_math.rs` (failing-test-first).** Pure `PackedStdScaler` normalize/denormalize, patchify (32 tokens), `[4,9,16]` → target-horizon quantile extraction, `q50`-return + shared spread conviction. Hand-value tests first (RED), then implement.
- [ ] **Step 3: `moirai.rs` adapter (failing-test-first).** `MoiraiAdapter`: `id="moirai"`, `required_lookback=512`, close-only, single session via the per-model `OnceLock` singleton, **single forward pass (no recursive decode)**. Direction/magnitude/conviction as Chronos. Module doc states the CC-BY-NC-4.0 non-commercial acceptance (Q1, decided). Register via `#[cfg(feature="moirai")] inventory::submit!`.
- [ ] **Step 4: `tests/moirai_test.rs`** (`#![cfg(feature="moirai")]`): registered; reconstructed quantiles match fixture within **< 1e-3 rel err**; monotone-up ⇒ Bullish; spread-conviction sanity; no-op guard.
- [ ] **Step 5: Verify + Commit.** Same matrix under `--features moirai`. Two commits: `assets(algo-core): Moirai-2.0-R-small ONNX graph (fixed-shape, LFS)` then `feat(algo-core): Moirai-2.0-R-small forecaster (feature-gated, quantile-spread conviction; CC-BY-NC-4.0)`.

---

### Task 7: Registration counts + whole-branch green + clippy + per-feature openssl-clean

**Depends on:** Tasks 0, 4, 5, 6 (whichever GO'd). **Parallel-safe: NO** (verification).

**Files:** Create `rust-core/crates/algo-core/tests/forecaster_registry_test.rs`; no new source.

- [ ] **Step 1: Registration-count assertions.** Default `registry::all().len() == 34` (zero ort). A robust combo-safe test: `expected = 34 + cfg!(feature="kronos") as usize + cfg!(feature="ttm") as usize + cfg!(feature="chronos") as usize + cfg!(feature="moirai") as usize`, and assert each enabled forecaster's id is present. Per-feature: `--features ttm` ⇒ 35 (+`"ttm"`), `chronos` ⇒ 35, `moirai` ⇒ 35; `--features forecasters` ⇒ 37; `--features all-forecasters` ⇒ 38.
- [ ] **Step 2: Whole-branch green.** Run and record: `cargo test --workspace` (default, 34); `cargo test -p algo-core --features ttm`; `--features chronos`; `--features moirai`; `--features all-forecasters`; then `cargo clippy --all-targets -- -D warnings` under default AND under `--features all-forecasters` (zero warnings). Note the one pre-existing baseline test state if it recurs.
- [ ] **Step 3: `cargo tree -i openssl` per feature (R7).** Empty under default, `ttm`, `chronos`, `moirai`, and `all-forecasters`. **Note the Linux/native-tls caveat** in the commit message: confirmed on the dev platform; Linux CI must re-verify since `download-binaries`/transitive paths can regress it there.
- [ ] **Step 4: Commit.** `test(algo-core): per-feature forecaster registration counts + green/clippy/openssl matrix` (author hadetan, no co-author).

---

### Task 8: Multi-symbol / multi-horizon benchmark harness + final PR

**Depends on:** Tasks 0-7. **Parallel-safe: NO** (final). Ships against the Q4 default eval set (below); refines the symbol list/window if better data-lake coverage is confirmed, but does not block on further human input.

**Files:** Create `rust-core/crates/backtest/src/bin/bench_forecasters.rs`; no changes to `run_replay`/`context_at`/`replay.rs`.

**Rationale (from the brief):** the single-symbol test was statistical noise. Value is judged by aggregating across many symbols × horizons.

- [ ] **Step 1: Harness (failing-test-first where unit-testable).** New bin, built with `--features all-forecasters` so kronos/ttm/chronos/moirai register alongside the deterministic catalog. For each (symbol × horizon) it wraps the existing frontier-gated `run_replay` (anti-lookahead preserved — no new evaluation logic), then aggregates per algorithm: **hit-rate** (fraction of directional calls whose `sign(forecast)` matches the realized next-horizon return sign) and **expectancy** (mean signed return per directional call). Unit-test the pure aggregation (hit-rate, expectancy, Wilson score interval) against hand values.
- [ ] **Step 2: Statistical honesty.** Report per algorithm: n (directional calls), hit-rate with a **Wilson score CI**, expectancy, and an explicit **small-sample caveat** (wide CI ⇒ do not over-interpret; forecasters vs deterministic differences within overlapping CIs are not significant). Neutral-only overlays appear with `directional_calls == 0`.
- [ ] **Step 3: Run + report.** Run over the **Q4 default eval set**: the Yahoo→bhavcopy harness over ~15–20 liquid NSE symbols, horizons 1 & 5, ~2-year window (refine the exact symbol list/window against confirmed lake coverage; keep the horizons and acceptance bar unless there's a documented reason to change them). Produce a comparison table (kronos, ttm, chronos, moirai vs the deterministic catalog). Record the report in the PR body; state whether the new models clear the Q4 "adds value" bar — **positive expectancy AND hit-rate CI clear of 0.5** — or the evidence is inconclusive.
- [ ] **Step 4: Commit + open PR.** Commit `feat(backtest): multi-symbol/multi-horizon forecaster benchmark harness` (author hadetan, no co-author). Open the PR from `phase-2-forecaster-models` into `main` (PR body: framework design, per-model spike verdicts, registration matrix, benchmark table + caveats, Q1-Q4 decisions). PR body ends with the standard Claude Code trailer.

---

## Definition of Done

- Default `cargo build`/`cargo test --workspace` compiles **zero `ort`** and registers **exactly 34** algorithms; `cargo clippy --all-targets -- -D warnings` clean; `cargo tree -i openssl` empty (default + every forecaster feature; Linux re-verify noted).
- Each GO model is one feature-gated `Algorithm` plugged into `forecast/framework.rs`: `--features ttm|chronos|moirai` ⇒ 35 each, `forecasters` ⇒ 37, `all-forecasters` ⇒ 38 — proven by `forecaster_registry_test.rs`.
- Each integration passes its committed regression fixture within **< 1e-3 rel err** and a directional sanity test; each has a spike doc with an explicit GO/NO-GO.
- Every forecaster output is a `"model opinion:"`-labeled, non-collapsing `AlgoOutput` (direction from forecast sign, magnitude `|forecast return|`, confidence from conviction); pure/deterministic (no wall-clock, no RNG, no per-compute I/O); sessions loaded once via a per-model `OnceLock<Arc<…>>` singleton.
- **Kronos is untouched** — not refactored onto the framework.
- Assets committed via git-lfs (`--local`); Chronos ships `small` (~190 MB) not `base`; Moirai carries its CC-BY-NC-4.0 note.
- The multi-symbol/multi-horizon benchmark harness runs all forecasters + deterministic algos and reports hit-rate + expectancy with sample-size/CI caveats against the Q4 default eval set.
- Nothing touches Kite, Claude, Electron, or any order path.
