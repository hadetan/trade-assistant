# Phase 12 — Benchmark Run Scoping, Progress, and Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Benchmark run cheap and controllable — one chosen algorithm against one chosen calendar day, with live per-bar progress and a hard-cancel — replacing today's default of running every registered algorithm (up to ~38, including four ONNX forecasters) across an entire selected date range, which pegs CPU, blows the sidecar's 30s request timeout, and offers no feedback or way to stop.

**Architecture:** Rust gains one new sidecar request/response pair (`ListAlgorithms`, tagging every linked algorithm `fast`/`slow` by which half of the existing registry partition it came from) and one new required field on the existing `BenchmarkComputeRequest` (`algo_id`, which `handle_benchmark_compute` now filters `registry::all_for_binary()` down to before computing). No new concurrency, no ONNX thread capping, no changes to the live `Compute` path — scope reduction alone is the fix. TypeScript gains: a `cancelCurrent()` hard-kill method on `SidecarSupervisor` that tags the resulting rejection `{ cancelled: true }` and lets the existing auto-restart (`onExit`) respawn the process; `benchmarkRunner.ts`'s `runBenchmark` threads `algoId` through every `benchmarkCompute` call, invokes a new `onProgress(index, total)` callback once per bar, and resolves `BenchmarkResult.cancelled` instead of only logging on a mid-walk rejection; the `manual`/`everyN` cadence toggle is deleted outright (type, runner branch, UI control) rather than left dead. `benchmarkBridge.ts` gains `benchmark:listAlgorithms` and `benchmark:cancelBenchmark` handlers and forwards per-bar progress to the renderer via `event.sender.send("benchmark:progress", ...)` while a run is in flight. `BenchmarkView.tsx`'s setup form swaps its From/To range and Auto/Manual cadence toggle for an algorithm picker (fast/slow tagged) and a single date field; a fixed top-right progress pill + Stop button appears while a run is active; a cancelled run renders a "Cancelled — partial results" banner instead of an error.

**Tech Stack:** Rust (`cargo test -p <crate>`, no new dependency — `sidecar` already depends on `algo-core`/`storage`/`backtest`/`serde`/`serde_json`/`chrono`); TypeScript, Electron, React 18, Vitest (`npx vitest run <path>`, `npm test`, `npm run typecheck` from `electron-app/`).

## Global Constraints

Every task's requirements implicitly include this section.

- **Hard safety invariant (non-negotiable, restated every phase):** the app NEVER places, modifies, cancels, or automates any order. This phase adds **zero** order-related surface — every change here is confined to the Benchmark screen's own scoping/progress/cancel plumbing, which never contacts live Kite.
- **No new concurrency, request queue, or worker pool in the sidecar** — it remains single-threaded and strictly serial (P12§2). No ONNX intra-op thread capping or other CPU/resource throttling below the process level is added; scope reduction (one algorithm × one day) is the entire fix.
- **The live (non-benchmark) `Compute` request path is untouched** — `handle_request`/`handle_request_with_progress` (`handlers.rs`) and `main.rs`'s `Compute` dispatch arm are not modified by any task in this plan.
- **Cancellation is a hard kill, not cooperative.** `SidecarSupervisor.cancelCurrent()` kills the child process immediately; no task adds an abort flag checked between bars. This is safe because the sidecar is already fully re-spawnable/stateless-per-request (existing `onExit` auto-restart) and a benchmark run holds no server-side state a kill could corrupt.
- **Cost tagging reuses the existing registry partition** (`registry::all()` = fast, `registry::ensure_forecasters_linked()` = slow) — no new classification scheme or metadata is added to the `Algorithm` trait (it stays exactly `id`/`required_lookback`/`applicable_horizons`/`compute`).
- **"One day" means one calendar day of bars for the selected timeframe** (start-of-day UTC through start-of-next-day UTC) — for intraday timeframes this can still be many bars; for `day` timeframe it resolves to exactly one bar.
- **An unknown or unlinked `algo_id` yields zero `algo_results`, not an error** — consistent with this codebase's existing well-formed-empty-response pattern (`empty_response`, `benchmark_empty_response`).
- **The `manual`/`everyN` cadence toggle is deleted entirely** (the `BenchmarkCadence` union variant, the runner's `manual` branch, the UI segmented control and its field) — not left unreachable. The runner always derives cadence internally via `defaultCadenceForHorizon(params.horizon)`; `lookaheadBars` remains user-configurable.
- **Comments:** default to none. Only add one when the *why* isn't obvious (a hidden invariant, a workaround, a formula's source). Never restate the next line; never a numbered step block. (From `CLAUDE.md`.)
- **Naming:** Rust `snake_case` functions/vars, `PascalCase` types, one responsibility per file. TypeScript `camelCase` functions/vars, `PascalCase` types/classes/React components, no Hungarian notation. File names describe responsibility, not kind.
- **Structure:** pure logic stays separate from I/O — `algo-core` (pure) vs `sidecar`/`storage` (I/O) in `rust-core/`; this phase adds no new files, so this boundary is preserved by construction, not introduced.
- **Commit convention:** each task's implementer commits as the repo's own configured git user via plain `git commit` — NEVER pass `--author`, NEVER add a `Co-Authored-By` trailer, NEVER use `--no-verify`. Conventional-commit subjects (`type(scope): message`), matching sibling plans.
- **Two toolchains, two test runners.** **Rust:** run from `rust-core/` — `cargo test -p <crate>` (per-crate), `cargo test -p <crate> --test <file>` (single integration test file), `cargo test -p <crate> --lib` (inline `#[cfg(test)]` tests); the compiled-binary `end_to_end_test.rs` is the one place a real sidecar subprocess is spawned. **TypeScript:** run from `electron-app/` — `npx vitest run <path>` (per-file), `npm test` (full suite, rebuilds `better-sqlite3` via its own `pretest` — unrelated to this phase's files but still runs), `npm run typecheck` (`src/**` only).
- **No test performs** a real live Kite OAuth/MCP call, a real `claude` subprocess, a real network fetch, a real timer, or a real `lightweight-charts`/`electron` runtime — everything is DI-faked or module-mocked via the established patterns (`FakeChild` for `SidecarSupervisor`, `vi.mock("../../src/renderer/benchmarkChart", ...)` for `BenchmarkView`).
- **No wall-clock-dependent test is added** — as in prior phases, correctness is verified by behavior (right algorithm selected, right progress counts, right cancellation tagging), not by asserting a timing threshold.

## File Structure

No new files. Every file below already exists; this phase only modifies them.

**Rust (`rust-core/`):**
- `crates/sidecar/src/protocol.rs` — new `ListAlgorithmsRequest`/`AlgorithmWire`/`ListAlgorithmsResponse`, new `algo_id` field on `BenchmarkComputeRequest`, new `SidecarRequest::ListAlgorithms`/`SidecarResponse::Algorithms` variants.
- `crates/sidecar/src/handlers.rs` — new `handle_list_algorithms`, `handle_benchmark_compute` filters to one `algo_id`.
- `crates/sidecar/src/main.rs` — dispatch wiring for `ListAlgorithms` (`request_id`, `request_step`, the match arm).
- `crates/sidecar/tests/protocol_test.rs`, `crates/sidecar/tests/end_to_end_test.rs` — new/updated tests.

**TypeScript main process (`electron-app/src/main/`):**
- `services/sidecar/sidecarProtocol.ts` — wire mirror additions (`AlgorithmWire`, `ListAlgorithmsResponseWire`, `algo_id` on the `benchmark_compute` request variant, `list_algorithms` request variant).
- `services/sidecar/sidecarSupervisor.ts` — `listAlgorithms()`, `cancelCurrent()`, `benchmarkCompute(...)` gains `algoId`, `onExit` tags a cancellation.
- `services/benchmark/benchmarkRunner.ts` — `BenchmarkCadence` drops `manual`; `BenchmarkRunParams` drops `cadence`, gains `algoId`; `runBenchmark` gains `onProgress`; `BenchmarkResult` gains `cancelled`.
- `ipc/benchmarkBridge.ts` — `benchmark:listAlgorithms`, `benchmark:cancelBenchmark`, progress forwarding on `benchmark:runBenchmark`.
- `ipc/rendererApi.ts` — `AlgorithmEntry` type, `RendererApi.listAlgorithms`/`cancelBenchmark`/`onBenchmarkProgress`.

**Renderer (`electron-app/src/renderer/`):**
- `BenchmarkView.tsx` — algorithm picker, single date field, progress pill + Stop button, cancelled banner.
- `BenchmarkView.css` — new progress-pill/algorithm-picker rules, removes the now-unused `.segmented-control` rule.

**Tests (`electron-app/test/`):**
- `main/services/sidecar/sidecarSupervisor.test.ts`, `main/services/benchmark/benchmarkRunner.test.ts`, `main/ipc/benchmarkBridge.test.ts`, `main/ipc/rendererApi.test.ts`, `renderer/BenchmarkView.test.tsx`, `renderer/testBridge.ts`.

---

### Task 1: Sidecar — `ListAlgorithms` request/response

The new introspection request: lists every algorithm linked into the running binary, tagged `fast`/`slow`. Touches `protocol.rs` (payload + enum variants), `handlers.rs` (the handler), and `main.rs` (dispatch) together, because adding an enum variant to `SidecarRequest`/`SidecarResponse` makes `main.rs`'s match non-exhaustive until the same commit adds its arm — these three files are not independently compilable.

**Files:**
- Modify: `rust-core/crates/sidecar/src/protocol.rs`
- Modify: `rust-core/crates/sidecar/src/handlers.rs`
- Modify: `rust-core/crates/sidecar/src/main.rs`
- Modify: `rust-core/crates/sidecar/tests/protocol_test.rs`
- Modify: `rust-core/crates/sidecar/tests/end_to_end_test.rs`

**Interfaces:**
- Consumes: `algo_core::registry::{all, ensure_forecasters_linked}` (existing, unchanged).
- Produces: `ListAlgorithmsRequest { id: u64 }`, `AlgorithmWire { id: String, cost: String }`, `ListAlgorithmsResponse { id: u64, algorithms: Vec<AlgorithmWire> }` (all in `protocol.rs`); `handlers::handle_list_algorithms(request: ListAlgorithmsRequest) -> ListAlgorithmsResponse`; `SidecarRequest::ListAlgorithms(ListAlgorithmsRequest)` (wire tag `"list_algorithms"`); `SidecarResponse::Algorithms(ListAlgorithmsResponse)` (wire tag `"algorithms"`).

- [ ] **Step 1: Write the failing protocol tests** — in `rust-core/crates/sidecar/tests/protocol_test.rs`, add a new `use` line right after the existing two `use sidecar::protocol::{...}` blocks:

```rust
use sidecar::protocol::{AlgorithmWire, ListAlgorithmsRequest, ListAlgorithmsResponse};
```

Append to the end of the file:

```rust
#[test]
fn list_algorithms_request_payload_deserializes() {
    let req: ListAlgorithmsRequest = serde_json::from_str(r#"{"id":40}"#).unwrap();
    assert_eq!(req.id, 40);
}

#[test]
fn algorithms_response_serializes_its_tagged_algorithm_list() {
    let json = serde_json::to_string(&ListAlgorithmsResponse {
        id: 40,
        algorithms: vec![
            AlgorithmWire { id: "sma".to_string(), cost: "fast".to_string() },
            AlgorithmWire { id: "kronos".to_string(), cost: "slow".to_string() },
        ],
    })
    .unwrap();
    assert!(json.contains("\"id\":40"));
    assert!(json.contains("\"id\":\"sma\""));
    assert!(json.contains("\"cost\":\"fast\""));
    assert!(json.contains("\"cost\":\"slow\""));
}

#[test]
fn parses_a_tagged_list_algorithms_request() {
    match parse_request(r#"{"type":"list_algorithms","id":40}"#).unwrap() {
        SidecarRequest::ListAlgorithms(request) => assert_eq!(request.id, 40),
        _ => panic!("expected a list_algorithms request"),
    }
}

#[test]
fn encodes_a_tagged_algorithms_response() {
    let line = encode_response(&SidecarResponse::Algorithms(ListAlgorithmsResponse {
        id: 40,
        algorithms: vec![AlgorithmWire { id: "sma".to_string(), cost: "fast".to_string() }],
    }));
    assert!(!line.contains('\n'));
    assert!(line.contains("\"type\":\"algorithms\""));
    assert!(line.contains("\"id\":\"sma\""));
}
```

- [ ] **Step 2: Run the tests, confirm they fail to compile**

Run (from `rust-core/`): `cargo test -p sidecar --test protocol_test`
Expected: FAIL to compile — `ListAlgorithmsRequest`/`AlgorithmWire`/`ListAlgorithmsResponse`/`SidecarRequest::ListAlgorithms`/`SidecarResponse::Algorithms` don't exist yet.

- [ ] **Step 3: Add the protocol types** — in `rust-core/crates/sidecar/src/protocol.rs`, insert immediately before the `#[derive(Debug, Deserialize)]\n#[serde(tag = "type", rename_all = "snake_case")]\npub enum SidecarRequest {` block:

```rust
#[derive(Debug, Deserialize)]
pub struct ListAlgorithmsRequest {
    pub id: u64,
}

#[derive(Debug, Serialize)]
pub struct AlgorithmWire {
    pub id: String,
    /// "fast" | "slow" -- see handlers::handle_list_algorithms for the split.
    pub cost: String,
}

#[derive(Debug, Serialize)]
pub struct ListAlgorithmsResponse {
    pub id: u64,
    pub algorithms: Vec<AlgorithmWire>,
}
```

Add `ListAlgorithms(ListAlgorithmsRequest),` as the last variant of `SidecarRequest`:

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
    ListAlgorithms(ListAlgorithmsRequest),
}
```

Add `Algorithms(ListAlgorithmsResponse),` as the last variant of `SidecarResponse`:

```rust
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
    Algorithms(ListAlgorithmsResponse),
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `cargo test -p sidecar --test protocol_test`
Expected: PASS — the four new tests plus every pre-existing `protocol_test.rs` test.

- [ ] **Step 5: Write the failing handler tests** — append to the `#[cfg(test)] mod tests` block at the bottom of `rust-core/crates/sidecar/src/handlers.rs` (after `handle_evaluate_scan_gate_stateless_matches_the_persistent_gate_and_writes_nothing`):

```rust
    #[test]
    fn handle_list_algorithms_tags_every_fast_registry_id_fast() {
        let response = handle_list_algorithms(ListAlgorithmsRequest { id: 40 });
        assert_eq!(response.id, 40);
        for algo in registry::all() {
            let wire = response
                .algorithms
                .iter()
                .find(|w| w.id == algo.id())
                .unwrap_or_else(|| panic!("registry::all() id {} missing from the response", algo.id()));
            assert_eq!(wire.cost, "fast");
        }
    }

    #[test]
    fn handle_list_algorithms_tags_forecaster_only_ids_slow_and_dedupes() {
        let response = handle_list_algorithms(ListAlgorithmsRequest { id: 41 });
        let fast_ids: std::collections::HashSet<&str> = registry::all().iter().map(|a| a.id()).collect();
        for algo in registry::ensure_forecasters_linked() {
            if fast_ids.contains(algo.id()) {
                continue; // already covered by all(); never double-counted
            }
            let matches: Vec<_> = response.algorithms.iter().filter(|w| w.id == algo.id()).collect();
            assert_eq!(matches.len(), 1, "forecaster id {} must appear exactly once", algo.id());
            assert_eq!(matches[0].cost, "slow");
        }
        let ids: Vec<&str> = response.algorithms.iter().map(|w| w.id.as_str()).collect();
        let mut deduped = ids.clone();
        deduped.sort();
        deduped.dedup();
        assert_eq!(ids.len(), deduped.len(), "no duplicate ids in the response");
        let mut sorted_ids = ids.clone();
        sorted_ids.sort();
        assert_eq!(ids, sorted_ids, "handle_list_algorithms sorts its output by id");
    }
```

- [ ] **Step 6: Run the tests, confirm they fail to compile**

Run: `cargo test -p sidecar --lib`
Expected: FAIL to compile — `handle_list_algorithms` and `ListAlgorithmsRequest` are not yet imported/defined in `handlers.rs`.

- [ ] **Step 7: Implement `handle_list_algorithms`** — in `rust-core/crates/sidecar/src/handlers.rs`, update the top `use crate::protocol::{...}` block to add `AlgorithmWire`, `ListAlgorithmsRequest`, `ListAlgorithmsResponse`:

```rust
use crate::protocol::{
    benchmark_empty_response, AddWatchlistSymbolRequest, AlgoResultWire, AlgorithmWire,
    BenchmarkComputeRequest, BenchmarkComputeResponse, CandleWire, ComputeRequest, ComputeResponse,
    ConfluenceWire, EvaluateScanGateRequest, EvaluateScanGateStatelessRequest, LakeCandlesResponse,
    LakeSymbolWire, LakeSymbolsResponse, ListAlgorithmsRequest, ListAlgorithmsResponse,
    ListLakeSymbolsRequest, ListWatchlistRequest, PersistCandlesRequest, PersistCandlesResponse,
    ReadLakeCandlesRequest, RemoveWatchlistSymbolRequest, ScanGateResponse, WatchlistResponse,
};
```

Add the handler after `handle_evaluate_scan_gate_stateless` (before the `#[cfg(test)]` module):

```rust
pub fn handle_list_algorithms(request: ListAlgorithmsRequest) -> ListAlgorithmsResponse {
    // Mirrors all_for_binary()'s own union-and-dedup shape (registry.rs) rather
    // than calling all_for_binary() and guessing which entries were forecasters
    // from the outside -- cost tagging must happen while the two source lists
    // are still separate.
    let mut algorithms: Vec<AlgorithmWire> = registry::all()
        .iter()
        .map(|a| AlgorithmWire { id: a.id().to_string(), cost: "fast".to_string() })
        .collect();
    for algo in registry::ensure_forecasters_linked() {
        if !algorithms.iter().any(|w| w.id == algo.id()) {
            algorithms.push(AlgorithmWire { id: algo.id().to_string(), cost: "slow".to_string() });
        }
    }
    algorithms.sort_by(|a, b| a.id.cmp(&b.id));
    ListAlgorithmsResponse { id: request.id, algorithms }
}
```

- [ ] **Step 8: Run the tests, confirm they pass**

Run: `cargo test -p sidecar --lib`
Expected: PASS — the two new tests plus every pre-existing `handlers.rs` inline test.

- [ ] **Step 9: Wire `main.rs` dispatch** — in `rust-core/crates/sidecar/src/main.rs`, update the two top `use` blocks:

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

Add an arm to `request_id`:

```rust
        SidecarRequest::ListAlgorithms(r) => r.id,
```

(immediately after the existing `SidecarRequest::EvaluateScanGateStateless(r) => r.id,` line)

Add an arm to `request_step`:

```rust
        SidecarRequest::ListAlgorithms(_) => "list_algorithms",
```

(immediately after the existing `SidecarRequest::EvaluateScanGateStateless(_) => "evaluate_scan_gate_stateless",` line)

Add a dispatch arm to the big `match request { ... }` in `main()`, immediately after the existing `SidecarRequest::EvaluateScanGateStateless(request) => { ... }` arm and before the closing `};`:

```rust
            SidecarRequest::ListAlgorithms(request) => {
                // Needs no store: pure registry introspection, always answers.
                let id = request.id;
                let result = panic::catch_unwind(AssertUnwindSafe(|| handle_list_algorithms(request)));
                match result {
                    Ok(response) => SidecarResponse::Algorithms(response),
                    Err(_) => {
                        eprintln!("sidecar: list_algorithms request {id} panicked; returning an empty list");
                        SidecarResponse::Algorithms(ListAlgorithmsResponse { id, algorithms: Vec::new() })
                    }
                }
            }
```

- [ ] **Step 10: Write the failing end-to-end test** — append to `rust-core/crates/sidecar/tests/end_to_end_test.rs`:

```rust
#[test]
fn list_algorithms_answers_even_with_no_lake_root() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_sidecar"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("sidecar binary must start");

    let list = r#"{"type":"list_algorithms","id":1}"#;
    {
        let stdin = child.stdin.as_mut().unwrap();
        writeln!(stdin, "{list}").unwrap();
    }
    drop(child.stdin.take());

    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let response = read_next_response(&mut reader);
    child.wait().ok();

    assert_eq!(response["type"], "algorithms");
    assert_eq!(response["id"], 1);
    let algorithms = response["algorithms"].as_array().unwrap();
    assert!(!algorithms.is_empty());
    assert!(algorithms.iter().all(|a| a["cost"] == "fast" || a["cost"] == "slow"));
}
```

- [ ] **Step 11: Run the full sidecar suite**

Run: `cargo test -p sidecar`
Expected: PASS — every test in `protocol_test.rs`, `handlers.rs`, and `end_to_end_test.rs`, including the new ones from this task.

- [ ] **Step 12: Commit**

```bash
git add rust-core/crates/sidecar/src/protocol.rs rust-core/crates/sidecar/src/handlers.rs rust-core/crates/sidecar/src/main.rs rust-core/crates/sidecar/tests/protocol_test.rs rust-core/crates/sidecar/tests/end_to_end_test.rs
git commit -m "feat(sidecar): ListAlgorithms request tagging every linked algorithm fast/slow"
```

---

### Task 2: Sidecar — `BenchmarkComputeRequest.algo_id`

`handle_benchmark_compute` currently runs every registered algorithm (`registry::all_for_binary()`) over the request's candle window. This task adds a required `algo_id` field and filters to that single algorithm before computing — the actual fix for the CPU/timeout incident. Depends on nothing from Task 1 (different struct, no shared enum-exhaustiveness coupling), but is sequenced after it since both touch `protocol.rs`/`handlers.rs`.

**Files:**
- Modify: `rust-core/crates/sidecar/src/protocol.rs`
- Modify: `rust-core/crates/sidecar/src/handlers.rs`
- Modify: `rust-core/crates/sidecar/tests/protocol_test.rs`
- Modify: `rust-core/crates/sidecar/tests/end_to_end_test.rs`

**Interfaces:**
- Consumes: `algo_core::{registry::all_for_binary, run_applicable, Algorithm}` (existing; `Algorithm` is a new import into `handlers.rs`, not a new dependency).
- Produces: `BenchmarkComputeRequest` gains `pub algo_id: String` (after `candles`); `handle_benchmark_compute` filters `registry::all_for_binary()` to the one algorithm whose `id()` matches `request.algo_id` before calling `run_applicable`.

- [ ] **Step 1: Write the failing protocol tests** — in `rust-core/crates/sidecar/tests/protocol_test.rs`, update the existing `benchmark_compute_request_payload_deserializes_its_candle_window` test's JSON literal and the existing `parses_a_tagged_benchmark_compute_request` test's JSON literal to include `algo_id`. Replace:

```rust
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
```

with:

```rust
#[test]
fn benchmark_compute_request_payload_deserializes_its_candle_window_and_algo_id() {
    let req: BenchmarkComputeRequest = serde_json::from_str(
        r#"{"id":22,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":1710000000,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100}],"algo_id":"sma"}"#,
    )
    .unwrap();
    assert_eq!(req.id, 22);
    assert_eq!(req.horizon, "positional");
    assert_eq!(req.candles.len(), 1);
    assert_eq!(req.candles[0].volume, 100);
    assert_eq!(req.algo_id, "sma");
}
```

Replace:

```rust
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
```

with:

```rust
#[test]
fn parses_a_tagged_benchmark_compute_request() {
    match parse_request(
        r#"{"type":"benchmark_compute","id":22,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":1710000000,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100}],"algo_id":"sma"}"#,
    )
    .unwrap()
    {
        SidecarRequest::BenchmarkCompute(request) => {
            assert_eq!(request.id, 22);
            assert_eq!(request.candles.len(), 1);
            assert_eq!(request.algo_id, "sma");
        }
        _ => panic!("expected a benchmark_compute request"),
    }
}
```

- [ ] **Step 2: Run the tests, confirm they fail to compile**

Run: `cargo test -p sidecar --test protocol_test`
Expected: FAIL to compile — `BenchmarkComputeRequest` has no `algo_id` field yet.

- [ ] **Step 3: Add the `algo_id` field** — in `rust-core/crates/sidecar/src/protocol.rs`, replace:

```rust
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
```

with:

```rust
#[derive(Debug, Deserialize)]
pub struct BenchmarkComputeRequest {
    pub id: u64,
    pub symbol: String,
    pub timeframe: String,
    /// "intraday" | "positional".
    pub horizon: String,
    /// The visible window series[0..=frontier], ascending by ts.
    pub candles: Vec<CandleWire>,
    pub algo_id: String,
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `cargo test -p sidecar --test protocol_test`
Expected: PASS.

- [ ] **Step 5: Write the failing handler tests** — in `rust-core/crates/sidecar/src/handlers.rs`'s `mod tests`, replace the existing `handle_benchmark_compute_reaches_run_applicable_with_full_ohlcv` test:

```rust
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
```

with:

```rust
    #[test]
    fn handle_benchmark_compute_filters_to_exactly_the_requested_algo_id() {
        let response = handle_benchmark_compute(BenchmarkComputeRequest {
            id: 30,
            symbol: "NSE:INFY".to_string(),
            timeframe: "day".to_string(),
            horizon: "positional".to_string(),
            candles: ohlcv_window(60),
            algo_id: "obv".to_string(),
        });
        assert_eq!(response.id, 30);
        assert_eq!(response.algo_results.len(), 1);
        assert_eq!(response.algo_results[0].algo_id, "obv");
        // Proves context_at's full OHLCV, not from_closes, reached run_applicable:
        // rising close AND rising volume (ohlcv_window) makes obv's on-balance-
        // volume delta strictly positive, i.e. Bullish, never Neutral.
        assert_ne!(response.algo_results[0].direction, "Neutral");
    }

    #[test]
    fn handle_benchmark_compute_with_an_unknown_algo_id_returns_a_zeroed_response_not_a_panic() {
        let response = handle_benchmark_compute(BenchmarkComputeRequest {
            id: 31,
            symbol: "NSE:INFY".to_string(),
            timeframe: "day".to_string(),
            horizon: "positional".to_string(),
            candles: ohlcv_window(60),
            algo_id: "not_a_real_algo".to_string(),
        });
        assert_eq!(response.id, 31);
        assert!(response.algo_results.is_empty());
        assert_eq!(response.confluence.bullish_count, 0);
        assert_eq!(response.confluence.bearish_count, 0);
        assert_eq!(response.confluence.neutral_count, 0);
    }
```

Update the existing `handle_benchmark_compute_on_empty_candles_returns_a_zeroed_response` test's request literal to add the now-required field (candles are empty, so the value is inert but the struct must compile):

```rust
    #[test]
    fn handle_benchmark_compute_on_empty_candles_returns_a_zeroed_response() {
        let response = handle_benchmark_compute(BenchmarkComputeRequest {
            id: 31,
            symbol: "NSE:INFY".to_string(),
            timeframe: "day".to_string(),
            horizon: "positional".to_string(),
            candles: Vec::new(),
            algo_id: "obv".to_string(),
        });
        assert_eq!(response.id, 31);
        assert!(response.algo_results.is_empty());
        assert_eq!(response.confluence.neutral_count, 0);
    }
```

(Note: this pre-existing test now shares id `31` with the new unknown-`algo_id` test above — renumber the empty-candles test's `id` to `29` to keep them distinct and avoid confusing a future reader who greps for `id: 31`.)

- [ ] **Step 6: Run the tests, confirm they fail**

Run: `cargo test -p sidecar --lib`
Expected: FAIL to compile (missing `algo_id` field on the struct literals) — confirms these are genuinely exercising the new field, not passing by accident.

- [ ] **Step 7: Filter `handle_benchmark_compute` to one `algo_id`** — in `rust-core/crates/sidecar/src/handlers.rs`, update the `use algo_core::{...}` import to add `Algorithm`:

```rust
use algo_core::{
    registry::{self, run_applicable, run_applicable_with_progress},
    AlgoOutput, Algorithm, Horizon, MarketContext, Timeframe,
};
```

Replace the algorithm-selection lines inside `handle_benchmark_compute`:

```rust
    let algos = registry::all_for_binary();
    let outputs = run_applicable(&algos, &ctx);
```

with:

```rust
    let algos: Vec<Box<dyn Algorithm>> = registry::all_for_binary()
        .into_iter()
        .filter(|a| a.id() == request.algo_id)
        .collect();
    let outputs = run_applicable(&algos, &ctx);
```

- [ ] **Step 8: Run the tests, confirm they pass**

Run: `cargo test -p sidecar --lib`
Expected: PASS — the two rewritten/new tests plus every pre-existing `handlers.rs` inline test.

- [ ] **Step 9: Update `end_to_end_test.rs`'s `benchmark_compute` wire literals** — `algo_id` is now required, so every `"type":"benchmark_compute"` JSON literal in this file must gain `,"algo_id":"sma"` before its closing `}`. Apply the following literal replacements (old → new) exactly:

In `benchmark_and_lake_flow_over_stdin_stdout_with_a_lake_root`:

```rust
    let bench = r#"{"type":"benchmark_compute","id":4,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":100,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100},{"ts":200,"open":1.5,"high":2.5,"low":1.0,"close":2.0,"volume":120}]}"#;
```

→

```rust
    let bench = r#"{"type":"benchmark_compute","id":4,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":100,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100},{"ts":200,"open":1.5,"high":2.5,"low":1.0,"close":2.0,"volume":120}],"algo_id":"sma"}"#;
```

In `benchmark_compute_answers_even_with_no_lake_root`:

```rust
    let bench = r#"{"type":"benchmark_compute","id":1,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":100,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100}]}"#;
```

→

```rust
    let bench = r#"{"type":"benchmark_compute","id":1,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":100,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100}],"algo_id":"sma"}"#;
```

In `a_benchmark_compute_with_an_out_of_range_timestamp_between_two_valid_ones_does_not_kill_the_sidecar` (all three literals):

```rust
    let valid = r#"{"type":"benchmark_compute","id":1,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":100,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100}]}"#;
    let panics = r#"{"type":"benchmark_compute","id":2,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":9223372036854775807,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100}]}"#;
    let valid_2 = r#"{"type":"benchmark_compute","id":3,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":200,"open":2.0,"high":3.0,"low":1.5,"close":2.5,"volume":90}]}"#;
```

→

```rust
    let valid = r#"{"type":"benchmark_compute","id":1,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":100,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100}],"algo_id":"sma"}"#;
    let panics = r#"{"type":"benchmark_compute","id":2,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":9223372036854775807,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100}],"algo_id":"sma"}"#;
    let valid_2 = r#"{"type":"benchmark_compute","id":3,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":200,"open":2.0,"high":3.0,"low":1.5,"close":2.5,"volume":90}],"algo_id":"sma"}"#;
```

In `a_malformed_benchmark_compute_between_two_valid_ones_does_not_kill_the_sidecar` (the two *valid* literals only — the `malformed` line deliberately stays malformed, it is testing a different rejection):

```rust
    let valid = r#"{"type":"benchmark_compute","id":1,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":100,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100}]}"#;
    // Well-typed tag but a candle missing required fields: serde rejects the line
    // (logged + skipped) or, if accepted, the handler is panic-isolated. Either
    // way the two valid requests must be answered and the process exit cleanly.
    let malformed = r#"{"type":"benchmark_compute","id":2,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":100}]}"#;
    let valid_2 = r#"{"type":"benchmark_compute","id":3,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":200,"open":2.0,"high":3.0,"low":1.5,"close":2.5,"volume":90}]}"#;
```

→

```rust
    let valid = r#"{"type":"benchmark_compute","id":1,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":100,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100}],"algo_id":"sma"}"#;
    // Well-typed tag but a candle missing required fields: serde rejects the line
    // (logged + skipped) or, if accepted, the handler is panic-isolated. Either
    // way the two valid requests must be answered and the process exit cleanly.
    let malformed = r#"{"type":"benchmark_compute","id":2,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":100}]}"#;
    let valid_2 = r#"{"type":"benchmark_compute","id":3,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":200,"open":2.0,"high":3.0,"low":1.5,"close":2.5,"volume":90}],"algo_id":"sma"}"#;
```

- [ ] **Step 10: Run the full sidecar suite**

Run: `cargo test -p sidecar`
Expected: PASS — every test across the crate, including the compiled-binary end-to-end suite.

- [ ] **Step 11: Commit**

```bash
git add rust-core/crates/sidecar/src/protocol.rs rust-core/crates/sidecar/src/handlers.rs rust-core/crates/sidecar/tests/protocol_test.rs rust-core/crates/sidecar/tests/end_to_end_test.rs
git commit -m "perf(sidecar): benchmark_compute filters to one requested algo_id instead of the full registry"
```

---

### Task 3: Electron main — `sidecarProtocol.ts` wire mirror + `SidecarSupervisor` (`listAlgorithms`, `cancelCurrent`, `benchmarkCompute` gains `algoId`)

The TS mirror of Tasks 1-2's wire contract, plus the hard-cancel path. `sidecarProtocol.ts` and `sidecarSupervisor.ts` are a single task because the new supervisor methods reference the new wire types directly — they do not compile independently.

**Files:**
- Modify: `electron-app/src/main/services/sidecar/sidecarProtocol.ts`
- Modify: `electron-app/src/main/services/sidecar/sidecarSupervisor.ts`
- Modify: `electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts`

**Interfaces:**
- Consumes: nothing new from outside this task.
- Produces: `AlgorithmWire { id: string; cost: "fast" | "slow" }`, `ListAlgorithmsResponseWire { type: "algorithms"; id: number; algorithms: AlgorithmWire[] }`; `SidecarSupervisor.listAlgorithms(): Promise<ListAlgorithmsResponseWire>`; `SidecarSupervisor.cancelCurrent(): void`; `SidecarSupervisor.benchmarkCompute(symbol, timeframe, horizon, candles, algoId: string): Promise<BenchmarkComputeResponseWire>` (gains a 5th parameter — every existing call site must be updated in this task and Task 4).

- [ ] **Step 1: Update the wire types** — in `electron-app/src/main/services/sidecar/sidecarProtocol.ts`, add after `BenchmarkComputeResponseWire`:

```ts
export interface AlgorithmWire {
  id: string;
  cost: "fast" | "slow";
}

export interface ListAlgorithmsResponseWire {
  type: "algorithms";
  id: number;
  algorithms: AlgorithmWire[];
}
```

Add `ListAlgorithmsResponseWire` to the `SidecarResponseWire` union:

```ts
export type SidecarResponseWire =
  | ComputeResponseWire
  | PersistCandlesResponseWire
  | WatchlistResponseWire
  | ScanGateResponseWire
  | LakeSymbolsResponseWire
  | LakeCandlesResponseWire
  | BenchmarkComputeResponseWire
  | ListAlgorithmsResponseWire;
```

Replace the `benchmark_compute` variant of `SidecarRequestWire` to add `algo_id`, and add a `list_algorithms` variant:

```ts
export type SidecarRequestWire =
  | { type: "compute"; id: number; symbol: string; timeframe: string; closes: number[] }
  | { type: "persist_candles"; id: number; symbol: string; timeframe: string; source: string; candles: CandleWire[] }
  | { type: "add_watchlist_symbol"; id: number; symbol: string }
  | { type: "remove_watchlist_symbol"; id: number; symbol: string }
  | { type: "list_watchlist"; id: number }
  | { type: "evaluate_scan_gate"; id: number; symbol: string; confluence: ConfluenceWire }
  | { type: "list_lake_symbols"; id: number }
  | { type: "read_lake_candles"; id: number; symbol: string; timeframe: string; source: string }
  | { type: "benchmark_compute"; id: number; symbol: string; timeframe: string; horizon: string; candles: CandleWire[]; algo_id: string }
  | { type: "evaluate_scan_gate_stateless"; id: number; prev: ConfluenceWire | null; curr: ConfluenceWire }
  | { type: "list_algorithms"; id: number };
```

- [ ] **Step 2: Write the failing supervisor tests** — in `electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts`, update the two existing `benchmarkCompute` call sites to pass a 5th `algoId` argument. Replace:

```ts
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
```

with:

```ts
  it("resolves benchmarkCompute with algo_results and confluence", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.benchmarkCompute(
      "NSE:INFY",
      "day",
      "positional",
      [{ ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
      "sma",
    );
    const requests = await requestsSeen;
    expect(requests[0].algo_id).toBe("sma");
    children[0].stdout.write(
      `${JSON.stringify({ type: "benchmark_compute", id: 1, algo_results: [], confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 } })}\n`,
    );
    expect((await pending).confluence.bullish_count).toBe(1);
  });
```

Replace:

```ts
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

with:

```ts
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
      supervisor.benchmarkCompute("NSE:INFY", "day", "positional", [{ ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }], "sma"),
    ).rejects.toThrow(/sidecar request 1 timed out after 20ms/);
  });
```

Append new tests at the end of the `describe("SidecarSupervisor", ...)` block, before its closing `});`:

```ts
  it("resolves listAlgorithms with an algorithms response carrying the matching id", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.listAlgorithms();
    await requestsSeen;
    children[0].stdout.write(
      `${JSON.stringify({ type: "algorithms", id: 1, algorithms: [{ id: "sma", cost: "fast" }] })}\n`,
    );
    const response = await pending;
    expect(response.type).toBe("algorithms");
    expect(response.algorithms[0].id).toBe("sma");
  });

  it("cancelCurrent kills the child and rejects pending requests with error.cancelled === true", async () => {
    const { supervisor, children } = makeSupervisor();
    const pending = supervisor.compute("NSE:INFY", "day", [1, 2, 3]);

    supervisor.cancelCurrent();

    await expect(pending).rejects.toMatchObject({ cancelled: true, message: "sidecar run cancelled" });
    expect(children[0].killed).toBe(true);
  });

  it("respawns after a cancelCurrent kill, same as an unexpected exit", async () => {
    const { supervisor, children } = makeSupervisor();

    supervisor.cancelCurrent();

    // Respawn is on a RESTART_BACKOFF_MS timer, so wait past it before asserting.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(children.length).toBe(2);
  });
```

- [ ] **Step 3: Run the tests, confirm they fail**

Run (from `electron-app/`): `npx vitest run test/main/services/sidecar/sidecarSupervisor.test.ts`
Expected: FAIL — `supervisor.listAlgorithms`/`supervisor.cancelCurrent` don't exist yet; `benchmarkCompute`'s extra argument is silently ignored by the current 4-arg signature (so the `algo_id` assertion in the updated first test also fails).

- [ ] **Step 4: Implement `listAlgorithms`, `cancelCurrent`, and `benchmarkCompute`'s new parameter** — in `electron-app/src/main/services/sidecar/sidecarSupervisor.ts`, update the top import to add `ListAlgorithmsResponseWire`:

```ts
import {
  BenchmarkComputeResponseWire,
  CandleWire,
  ComputeResponseWire,
  ConfluenceWire,
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

Replace the `benchmarkCompute` method:

```ts
  benchmarkCompute(symbol: string, timeframe: string, horizon: string, candles: CandleWire[], algoId: string): Promise<BenchmarkComputeResponseWire> {
    return this.send({
      type: "benchmark_compute",
      id: this.nextId,
      symbol,
      timeframe,
      horizon,
      candles,
      algo_id: algoId,
    }) as Promise<BenchmarkComputeResponseWire>;
  }
```

Add `listAlgorithms` immediately after it:

```ts
  listAlgorithms(): Promise<ListAlgorithmsResponseWire> {
    return this.send({ type: "list_algorithms", id: this.nextId }) as Promise<ListAlgorithmsResponseWire>;
  }
```

Add a `cancelling` flag next to the existing private fields:

```ts
  private cancelling = false;
```

Add `cancelCurrent()` immediately after `stop()`:

```ts
  cancelCurrent(): void {
    this.cancelling = true;
    this.child?.kill();
  }
```

Replace `onExit`:

```ts
  private onExit(code: number | null): void {
    this.child = null;
    const wasCancelling = this.cancelling;
    this.cancelling = false;
    const error = wasCancelling
      ? Object.assign(new Error("sidecar run cancelled"), { cancelled: true })
      : new Error(`sidecar exited (code ${code ?? "null"})`);
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();

    if (this.stopped) {
      this.emitStatus("down");
      return;
    }
    this.emitStatus("restarting");
    setTimeout(() => {
      if (!this.stopped) this.spawnChild();
    }, RESTART_BACKOFF_MS);
  }
```

- [ ] **Step 5: Run the tests, confirm they pass**

Run: `npx vitest run test/main/services/sidecar/sidecarSupervisor.test.ts`
Expected: PASS — every test in the file, including the three new ones.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/services/sidecar/sidecarProtocol.ts electron-app/src/main/services/sidecar/sidecarSupervisor.ts electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts
git commit -m "feat(sidecar-supervisor): listAlgorithms, hard-kill cancelCurrent, benchmarkCompute algoId"
```

---

### Task 4: Electron main — `benchmarkRunner.ts` (`algoId`, `onProgress`, `cancelled`, remove `manual` cadence)

The frontier-walk orchestrator: threads `algoId` through every compute call, reports per-bar progress, and resolves `cancelled: boolean` instead of only logging on a mid-walk rejection. Depends on Task 3 (`SidecarSupervisor.benchmarkCompute`'s new `algoId` parameter, whose type this file's `BenchmarkRunnerDeps` `Pick`s from).

**Files:**
- Modify: `electron-app/src/main/services/benchmark/benchmarkRunner.ts`
- Modify: `electron-app/test/main/services/benchmark/benchmarkRunner.test.ts`

**Interfaces:**
- Consumes: `SidecarSupervisor.benchmarkCompute(symbol, timeframe, horizon, candles, algoId)` (Task 3).
- Produces: `BenchmarkCadence = { mode: "session_close" } | { mode: "stateless_gate" }` (no `manual` variant); `BenchmarkRunParams` without `cadence`, with `algoId: string`; `BenchmarkResult` gains `cancelled: boolean`; `runBenchmark(deps, params, onProgress?: (index: number, total: number) => void): Promise<BenchmarkResult>`.

- [ ] **Step 1: Write the failing runner tests** — in `electron-app/test/main/services/benchmark/benchmarkRunner.test.ts`, replace `baseParams`:

```ts
function baseParams(overrides: Partial<import("../../../../src/main/services/benchmark/benchmarkRunner").BenchmarkRunParams> = {}) {
  return {
    symbol: "NSE:INFY",
    timeframe: "day",
    source: "bhavcopy",
    horizon: "positional" as const,
    algoId: "sma",
    lookaheadBars: 1,
    fromTs: 0,
    toTs: 1e12,
    ...overrides,
  };
}
```

Replace the `"intraday stateless_gate cadence is gate-driven and threads prev/curr"` test's `runBenchmark` override (cadence is now derived purely from `horizon`, not caller-supplied) and its mock's arity — replace:

```ts
        benchmarkCompute: vi.fn().mockImplementation((_s, _t, _h, window: CandleWire[]) =>
          Promise.resolve({ type: "benchmark_compute", id: 1, algo_results: [], confluence: perFrontier[window.length - 1] }),
        ),
```

with:

```ts
        benchmarkCompute: vi.fn().mockImplementation((_s, _t, _h, window: CandleWire[], _algoId: string) =>
          Promise.resolve({ type: "benchmark_compute", id: 1, algo_results: [], confluence: perFrontier[window.length - 1] }),
        ),
```

and replace:

```ts
    const result = await runBenchmark(deps, baseParams({ horizon: "intraday", cadence: { mode: "stateless_gate" }, lookaheadBars: 2 }));
```

with:

```ts
    const result = await runBenchmark(deps, baseParams({ horizon: "intraday", lookaheadBars: 2 }));
```

Delete the entire `"manual everyN stride produces decision points only at every Nth index"` test (the `manual`/`everyN` cadence is removed, per Global Constraints).

Append `expect(result.cancelled).toBe(false);` to the end of the existing `"preserves partial results on a mid-run sidecar rejection"` test, right before its `consoleError.mockRestore();` line, so the test body's tail reads:

```ts
    const result = await runBenchmark(deps, baseParams({ lookaheadBars: 1 }));
    expect(result.decisionPoints).toHaveLength(2); // the first two frontiers survived
    expect(result.cancelled).toBe(false);
    consoleError.mockRestore();
```

Append two new tests at the end of the `describe("runBenchmark frontier walk", ...)` block, before its closing `});`:

```ts
  it("invokes onProgress once per surviving loop iteration with the correct (index, total) pairs", async () => {
    const benchmarkCompute = vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH });
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12, 13, 14, 15, 16, 17]) }),
        benchmarkCompute,
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const progress: Array<[number, number]> = [];
    const result = await runBenchmark(deps, baseParams({ lookaheadBars: 3 }), (index, total) => progress.push([index, total]));
    // N=8, L=3 -> eligible i in 0..4 (5 iterations), each reported against the full series length.
    expect(progress).toEqual([[0, 8], [1, 8], [2, 8], [3, 8], [4, 8]]);
    expect(result.decisionPoints).toHaveLength(5);
  });

  it("tags cancelled=true and keeps only the pre-cancellation decision points on a cancellation-tagged rejection", async () => {
    let call = 0;
    const benchmarkCompute = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 3) return Promise.reject(Object.assign(new Error("sidecar run cancelled"), { cancelled: true }));
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
    expect(result.cancelled).toBe(true);
    expect(result.decisionPoints).toHaveLength(2);
  });
```

- [ ] **Step 2: Run the tests, confirm they fail**

Run (from `electron-app/`): `npx vitest run test/main/services/benchmark/benchmarkRunner.test.ts`
Expected: FAIL to compile/run — `BenchmarkRunParams` still requires `cadence` and has no `algoId`; `runBenchmark` takes no third `onProgress` argument; `BenchmarkResult` has no `cancelled` field.

- [ ] **Step 3: Rewrite `benchmarkRunner.ts`** — replace the full contents of `electron-app/src/main/services/benchmark/benchmarkRunner.ts`:

```ts
import type { AlgoResultWire, CandleWire, ConfluenceWire } from "../sidecar/sidecarProtocol";
import type { AnalysisEnvelope, Conviction, Direction } from "../analysis/contracts";
import type { Horizon } from "../../ipc/rendererApi";
import type { SidecarSupervisor } from "../sidecar/sidecarSupervisor";
import { generateDeterministicResponse } from "../analysis/deterministicResponseGenerator";

export type Outcome = "correct" | "incorrect" | "neutral";

export type BenchmarkCadence = { mode: "session_close" } | { mode: "stateless_gate" };

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
  algoId: string;
  lookaheadBars: number;
  fromTs: number;
  toTs: number;
}

export interface BenchmarkResult {
  params: BenchmarkRunParams;
  candles: CandleWire[];
  decisionPoints: DecisionPoint[];
  cancelled: boolean;
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

export interface BenchmarkRunnerDeps {
  sidecar: Pick<SidecarSupervisor, "readLakeCandles" | "benchmarkCompute" | "evaluateScanGateStateless">;
}

export async function runBenchmark(
  deps: BenchmarkRunnerDeps,
  params: BenchmarkRunParams,
  onProgress?: (index: number, total: number) => void,
): Promise<BenchmarkResult> {
  const { candles } = await deps.sidecar.readLakeCandles(params.symbol, params.timeframe, params.source);
  const series = candles.filter((c) => c.ts >= params.fromTs && c.ts <= params.toTs);
  const cadence = defaultCadenceForHorizon(params.horizon);
  const decisionPoints: DecisionPoint[] = [];
  let prevConfluence: ConfluenceWire | null = null;
  let cancelled = false;

  try {
    for (let i = 0; i < series.length; i++) {
      // Mirror run_replay's boundary: stop once no future bar exists at i+lookahead.
      if (i + params.lookaheadBars >= series.length) break;

      onProgress?.(i, series.length);

      let compute: { algo_results: AlgoResultWire[]; confluence: ConfluenceWire } | null = null;
      let isDecisionPoint = false;

      if (cadence.mode === "session_close") {
        compute = await deps.sidecar.benchmarkCompute(params.symbol, params.timeframe, params.horizon, series.slice(0, i + 1), params.algoId);
        isDecisionPoint = true;
      } else {
        // stateless_gate: compute every frontier to feed the gate, thread the
        // per-run prevConfluence (never persisted -- a benchmark can never
        // corrupt the live scanner's scan_snapshots gate memory).
        compute = await deps.sidecar.benchmarkCompute(params.symbol, params.timeframe, params.horizon, series.slice(0, i + 1), params.algoId);
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
    // A hard-cancel (SidecarSupervisor.cancelCurrent) tags its rejection
    // { cancelled: true } so the caller renders "Cancelled", not an error; any
    // other mid-walk rejection stops the walk but preserves the partial run.
    if ((error as { cancelled?: boolean }).cancelled === true) {
      cancelled = true;
    } else {
      console.error(`benchmark: run stopped early: ${(error as Error).message}`);
    }
  }

  return { params, candles: series, decisionPoints, cancelled };
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `npx vitest run test/main/services/benchmark/benchmarkRunner.test.ts`
Expected: PASS — every test in the file, including the two new ones and the deletion of the `manual`-cadence test.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/benchmark/benchmarkRunner.ts electron-app/test/main/services/benchmark/benchmarkRunner.test.ts
git commit -m "feat(benchmark): runBenchmark threads algoId, reports onProgress, tags cancelled runs"
```

---

### Task 5: Electron main — `benchmarkBridge.ts` + `rendererApi.ts` (`listAlgorithms`, `cancelBenchmark`, `onBenchmarkProgress`)

The IPC surface: a listing channel, a progress push while a run is in flight, and a cancel channel. Depends on Task 3 (`SidecarSupervisor.listAlgorithms`/`cancelCurrent`) and Task 4 (`runBenchmark`'s `onProgress` parameter, `BenchmarkRunParams` without `cadence`).

**Files:**
- Modify: `electron-app/src/main/ipc/benchmarkBridge.ts`
- Modify: `electron-app/src/main/ipc/rendererApi.ts`
- Modify: `electron-app/test/main/ipc/benchmarkBridge.test.ts`
- Modify: `electron-app/test/main/ipc/rendererApi.test.ts`

**Interfaces:**
- Consumes: `SidecarSupervisor.{listLakeSymbols, listAlgorithms, readLakeCandles, benchmarkCompute, evaluateScanGateStateless, cancelCurrent}` (Task 3); `runBenchmark(deps, params, onProgress)` (Task 4).
- Produces: `AlgorithmEntry { id: string; cost: "fast" | "slow" }` (in `rendererApi.ts`); IPC channels `benchmark:listAlgorithms`, `benchmark:cancelBenchmark`; `RendererApi.listAlgorithms(): Promise<AlgorithmEntry[]>`, `RendererApi.cancelBenchmark(): Promise<void>`, `RendererApi.onBenchmarkProgress(handler: (progress: { index: number; total: number }) => void): void`.

- [ ] **Step 1: Write the failing bridge tests** — in `electron-app/test/main/ipc/benchmarkBridge.test.ts`, update the `harness`/`idleSidecar` helpers to include the two new sidecar methods, and update every `handlers.get(...)!(...)` call to pass a fake event with a `sender.send` spy instead of `{}`/`null`:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));

import { registerBenchmarkBridge } from "../../../src/main/ipc/benchmarkBridge";

function harness(sidecar: {
  listLakeSymbols: ReturnType<typeof vi.fn>;
  listAlgorithms: ReturnType<typeof vi.fn>;
  readLakeCandles: ReturnType<typeof vi.fn>;
  benchmarkCompute: ReturnType<typeof vi.fn>;
  evaluateScanGateStateless: ReturnType<typeof vi.fn>;
  cancelCurrent: ReturnType<typeof vi.fn>;
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
    listAlgorithms: vi.fn(),
    readLakeCandles: vi.fn(),
    benchmarkCompute: vi.fn(),
    evaluateScanGateStateless: vi.fn(),
    cancelCurrent: vi.fn(),
  };
}

function fakeEvent() {
  return { sender: { send: vi.fn() } };
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
    const entries = (await handlers.get("benchmark:listLakeSymbols")!(fakeEvent(), undefined)) as Array<Record<string, unknown>>;
    expect(entries[0]).toEqual({ symbol: "NSE:INFY", timeframe: "day", source: "bhavcopy", fromTs: 100, toTs: 200, candleCount: 3, horizon: "positional" });
    expect(entries[1].horizon).toBe("intraday");
  });

  it("maps the algorithms wire response to AlgorithmEntry", async () => {
    const sidecar = idleSidecar();
    sidecar.listAlgorithms.mockResolvedValue({
      type: "algorithms",
      id: 1,
      algorithms: [
        { id: "sma", cost: "fast" },
        { id: "kronos", cost: "slow" },
      ],
    });
    const handlers = harness(sidecar);
    const entries = await handlers.get("benchmark:listAlgorithms")!(fakeEvent(), undefined);
    expect(entries).toEqual([
      { id: "sma", cost: "fast" },
      { id: "kronos", cost: "slow" },
    ]);
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
      algoId: "sma",
      lookaheadBars: 5,
      fromTs: 0,
      toTs: 1e12,
    };
    const result = (await handlers.get("benchmark:runBenchmark")!(fakeEvent(), params)) as { params: unknown; decisionPoints: unknown[] };
    expect(sidecar.readLakeCandles).toHaveBeenCalledWith("NSE:INFY", "day", "bhavcopy");
    expect(result.params).toEqual(params);
    expect(result.decisionPoints).toHaveLength(0);
  });

  it("forwards per-bar progress to the requesting window via event.sender.send on benchmark:progress", async () => {
    const sidecar = idleSidecar();
    sidecar.readLakeCandles.mockResolvedValue({
      type: "lake_candles",
      id: 1,
      candles: [
        { ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { ts: 2, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      ],
    });
    sidecar.benchmarkCompute.mockResolvedValue({
      type: "benchmark_compute",
      id: 1,
      algo_results: [],
      confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
    });
    const handlers = harness(sidecar);
    const event = fakeEvent();
    const params = {
      symbol: "NSE:INFY",
      timeframe: "day",
      source: "bhavcopy",
      horizon: "positional",
      algoId: "sma",
      lookaheadBars: 0,
      fromTs: 0,
      toTs: 1e12,
    };
    await handlers.get("benchmark:runBenchmark")!(event, params);
    // series has 2 bars, lookaheadBars=0 -> eligible i in {0} only.
    expect(event.sender.send).toHaveBeenCalledWith("benchmark:progress", { index: 0, total: 2 });
  });

  it("calls cancelCurrent on the sidecar", async () => {
    const sidecar = idleSidecar();
    const handlers = harness(sidecar);
    await handlers.get("benchmark:cancelBenchmark")!(fakeEvent(), undefined);
    expect(sidecar.cancelCurrent).toHaveBeenCalledTimes(1);
  });

  it("writes the copy-raw text to the clipboard", async () => {
    const { clipboard } = await import("electron");
    const handlers = harness(idleSidecar());
    await handlers.get("benchmark:copyToClipboard")!(fakeEvent(), "raw-json-blob");
    expect(clipboard.writeText).toHaveBeenCalledWith("raw-json-blob");
  });
});
```

- [ ] **Step 2: Run the tests, confirm they fail**

Run (from `electron-app/`): `npx vitest run test/main/ipc/benchmarkBridge.test.ts`
Expected: FAIL — `benchmark:listAlgorithms`/`benchmark:cancelBenchmark` channels don't exist yet; `BenchmarkBridgeDeps.sidecar`'s `Pick` doesn't include `listAlgorithms`/`cancelCurrent` yet.

- [ ] **Step 3: Add `AlgorithmEntry` and the new `RendererApi` members** — in `electron-app/src/main/ipc/rendererApi.ts`, add after `LakeSymbolEntry`:

```ts
export interface AlgorithmEntry {
  id: string;
  cost: "fast" | "slow";
}
```

Update `RendererApi`:

```ts
export interface RendererApi {
  getStatus(): Promise<AppStatus>;
  onBanner(handler: (banner: BannerEvent) => void): void;
  onTrace(handler: (event: TraceEvent) => void): void;
  login(): Promise<LoginResult>;
  searchInstruments(query: string): Promise<unknown>;
  runAnalysis(params: AnalysisRunParams): Promise<AnalysisResult>;
  createSession(mode: AnalysisMode): Promise<SessionSummary>;
  listSessions(): Promise<SessionSummary[]>;
  getSession(id: string): Promise<SessionDetail>;
  listLakeSymbols(): Promise<LakeSymbolEntry[]>;
  listAlgorithms(): Promise<AlgorithmEntry[]>;
  runBenchmark(params: BenchmarkRunParams): Promise<BenchmarkResult>;
  cancelBenchmark(): Promise<void>;
  onBenchmarkProgress(handler: (progress: { index: number; total: number }) => void): void;
  copyBenchmarkResult(text: string): Promise<void>;
}
```

Update `buildRendererApi`'s returned object:

```ts
export function buildRendererApi(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  subscribe: (channel: string, handler: (payload: unknown) => void) => void,
): RendererApi {
  return {
    getStatus: () => invoke("status:get") as Promise<AppStatus>,
    onBanner: (handler) => subscribe("banner:push", handler as (payload: unknown) => void),
    onTrace: (handler) => subscribe("analysis:trace", handler as (p: unknown) => void),
    login: () => invoke("kite:login") as Promise<LoginResult>,
    searchInstruments: (query) => invoke("kite:searchInstruments", { query }),
    runAnalysis: (params) => invoke("analysis:run", params) as Promise<AnalysisResult>,
    createSession: (mode) => invoke("history:createSession", { mode }) as Promise<SessionSummary>,
    listSessions: () => invoke("history:listSessions") as Promise<SessionSummary[]>,
    getSession: (id) => invoke("history:getSession", { id }) as Promise<SessionDetail>,
    listLakeSymbols: () => invoke("benchmark:listLakeSymbols") as Promise<LakeSymbolEntry[]>,
    listAlgorithms: () => invoke("benchmark:listAlgorithms") as Promise<AlgorithmEntry[]>,
    runBenchmark: (params) => invoke("benchmark:runBenchmark", params) as Promise<BenchmarkResult>,
    cancelBenchmark: () => invoke("benchmark:cancelBenchmark") as Promise<void>,
    onBenchmarkProgress: (handler) => subscribe("benchmark:progress", handler as (payload: unknown) => void),
    copyBenchmarkResult: (text) => invoke("benchmark:copyToClipboard", text) as Promise<void>,
  };
}
```

- [ ] **Step 4: Implement the bridge** — replace the full contents of `electron-app/src/main/ipc/benchmarkBridge.ts`:

```ts
import { clipboard, type IpcMain } from "electron";
import type { SidecarSupervisor } from "../services/sidecar/sidecarSupervisor";
import { runBenchmark, horizonForTimeframe } from "../services/benchmark/benchmarkRunner";
import type { AlgorithmEntry, BenchmarkRunParams, LakeSymbolEntry } from "./rendererApi";

export interface BenchmarkBridgeDeps {
  ipcMain: Pick<IpcMain, "handle">;
  sidecar: Pick<
    SidecarSupervisor,
    "listLakeSymbols" | "listAlgorithms" | "readLakeCandles" | "benchmarkCompute" | "evaluateScanGateStateless" | "cancelCurrent"
  >;
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
  deps.ipcMain.handle("benchmark:listAlgorithms", async (): Promise<AlgorithmEntry[]> => {
    const { algorithms } = await deps.sidecar.listAlgorithms();
    return algorithms.map((a) => ({ id: a.id, cost: a.cost as "fast" | "slow" }));
  });
  deps.ipcMain.handle("benchmark:runBenchmark", (event, params: BenchmarkRunParams) =>
    runBenchmark({ sidecar: deps.sidecar }, params, (index, total) =>
      event.sender.send("benchmark:progress", { index, total }),
    ),
  );
  deps.ipcMain.handle("benchmark:cancelBenchmark", () => {
    deps.sidecar.cancelCurrent();
  });
  deps.ipcMain.handle("benchmark:copyToClipboard", (_event, text: string) => clipboard.writeText(text));
}
```

- [ ] **Step 5: Run the bridge tests, confirm they pass**

Run: `npx vitest run test/main/ipc/benchmarkBridge.test.ts`
Expected: PASS.

- [ ] **Step 6: Update `rendererApi.test.ts`** — replace the `"exposes exactly the twelve bridge methods..."` test with the new count and member list:

```ts
  it("exposes exactly the fifteen bridge methods and never leaks the raw transport", () => {
    const api = buildRendererApi(vi.fn().mockResolvedValue({}), vi.fn());
    expect(Object.keys(api).sort()).toEqual([
      "cancelBenchmark",
      "copyBenchmarkResult",
      "createSession",
      "getSession",
      "getStatus",
      "listAlgorithms",
      "listLakeSymbols",
      "listSessions",
      "login",
      "onBanner",
      "onBenchmarkProgress",
      "onTrace",
      "runAnalysis",
      "runBenchmark",
      "searchInstruments",
    ]);
    expect((api as Record<string, unknown>).ipcRenderer).toBeUndefined();
    expect((api as Record<string, unknown>).invoke).toBeUndefined();
  });
```

Append two new tests to the `describe("buildRendererApi", ...)` block:

```ts
  it("routes listAlgorithms through benchmark:listAlgorithms", async () => {
    const invoke = vi.fn().mockResolvedValue([{ id: "sma", cost: "fast" }]);
    const entries = await buildRendererApi(invoke, vi.fn()).listAlgorithms();
    expect(invoke).toHaveBeenCalledWith("benchmark:listAlgorithms");
    expect(entries[0].id).toBe("sma");
  });

  it("subscribes onBenchmarkProgress to the benchmark:progress channel", () => {
    const subscribe = vi.fn();
    const handler = vi.fn();
    buildRendererApi(vi.fn(), subscribe).onBenchmarkProgress(handler);
    expect(subscribe).toHaveBeenCalledWith("benchmark:progress", handler);
  });
```

- [ ] **Step 7: Run the full rendererApi test file, confirm it passes**

Run: `npx vitest run test/main/ipc/rendererApi.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add electron-app/src/main/ipc/benchmarkBridge.ts electron-app/src/main/ipc/rendererApi.ts electron-app/test/main/ipc/benchmarkBridge.test.ts electron-app/test/main/ipc/rendererApi.test.ts
git commit -m "feat(ipc): benchmark:listAlgorithms/cancelBenchmark channels and per-bar progress push"
```

---

### Task 6: Renderer — `BenchmarkView.tsx` (algorithm picker, single date field, progress pill, Stop, cancelled banner)

The setup form and results view. Depends on Task 5 (`RendererApi.listAlgorithms`/`cancelBenchmark`/`onBenchmarkProgress`, `AlgorithmEntry`) and Task 4 (`BenchmarkRunParams` without `cadence`, with `algoId`; `BenchmarkResult.cancelled`).

**Files:**
- Modify: `electron-app/src/renderer/BenchmarkView.tsx`
- Modify: `electron-app/src/renderer/BenchmarkView.css`
- Modify: `electron-app/test/renderer/testBridge.ts`
- Modify: `electron-app/test/renderer/BenchmarkView.test.tsx`

**Interfaces:**
- Consumes: `RendererApi.{listLakeSymbols, listAlgorithms, runBenchmark, cancelBenchmark, copyBenchmarkResult, onBenchmarkProgress}`; `defaultLookaheadForHorizon`, `summarize` (from `benchmarkRunner.ts`, unchanged exports).
- Produces: `BenchmarkView({ api }: { api: BenchmarkApi }): JSX.Element` (unchanged export shape; `BenchmarkApi`'s `Pick` widens).

- [ ] **Step 1: Update the shared renderer test bridge** — in `electron-app/test/renderer/testBridge.ts`, replace the `runBenchmark` mock's resolved value and add the three new bridge methods:

```ts
import { vi } from "vitest";
import type { RendererApi } from "../../src/main/ipc/rendererApi";

export function installBridge(overrides: Partial<RendererApi> = {}): RendererApi {
  const bridge: RendererApi = {
    getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "needsLogin", driftWarning: null }),
    onBanner: vi.fn(),
    onTrace: vi.fn(),
    login: vi.fn().mockResolvedValue({ status: "authenticated" }),
    searchInstruments: vi.fn().mockResolvedValue({ data: [] }),
    runAnalysis: vi.fn(),
    createSession: vi.fn().mockResolvedValue({
      id: "session-1",
      response_mode: "engine_only",
      created_at: "2026-07-27T00:00:00.000Z",
      last_active_at: "2026-07-27T00:00:00.000Z",
      preview: "(no messages yet)",
    }),
    listSessions: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockResolvedValue({ id: "session-1", response_mode: "engine_only", messages: [] }),
    listLakeSymbols: vi.fn().mockResolvedValue([]),
    listAlgorithms: vi.fn().mockResolvedValue([]),
    runBenchmark: vi.fn().mockResolvedValue({
      params: {
        symbol: "NSE:INFY",
        timeframe: "day",
        source: "bhavcopy",
        horizon: "positional",
        algoId: "sma",
        lookaheadBars: 5,
        fromTs: 0,
        toTs: 0,
      },
      candles: [],
      decisionPoints: [],
      cancelled: false,
    }),
    cancelBenchmark: vi.fn().mockResolvedValue(undefined),
    onBenchmarkProgress: vi.fn(),
    copyBenchmarkResult: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  (window as unknown as { tradeAssistant: RendererApi }).tradeAssistant = bridge;
  return bridge;
}
```

- [ ] **Step 2: Run the full renderer suite, confirm only `BenchmarkView.test.tsx` fails**

Run (from `electron-app/`): `npx vitest run test/renderer`
Expected: every other renderer test file (e.g. `App.test.tsx`) still passes unchanged (the bridge mock is a superset-compatible update); `BenchmarkView.test.tsx` fails because the component still uses the removed `cadence`/`manual`/`everyN` state.

- [ ] **Step 3: Rewrite `BenchmarkView.test.tsx`** — replace the full contents of `electron-app/test/renderer/BenchmarkView.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/renderer/benchmarkChart", () => ({ createBenchmarkChart: vi.fn(() => ({ dispose: vi.fn() })) }));

import { BenchmarkView } from "../../src/renderer/BenchmarkView";
import type { AlgorithmEntry, BenchmarkResult, LakeSymbolEntry, RendererApi } from "../../src/main/ipc/rendererApi";

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

const ALGORITHMS: AlgorithmEntry[] = [
  { id: "sma", cost: "fast" },
  { id: "kronos", cost: "slow" },
];

function api(
  overrides: Partial<Pick<RendererApi, "listLakeSymbols" | "listAlgorithms" | "runBenchmark" | "cancelBenchmark" | "copyBenchmarkResult" | "onBenchmarkProgress">> = {},
) {
  return {
    listLakeSymbols: vi.fn().mockResolvedValue([DAY_ENTRY]),
    listAlgorithms: vi.fn().mockResolvedValue(ALGORITHMS),
    runBenchmark: vi.fn(),
    cancelBenchmark: vi.fn().mockResolvedValue(undefined),
    copyBenchmarkResult: vi.fn().mockResolvedValue(undefined),
    onBenchmarkProgress: vi.fn(),
    ...overrides,
  };
}

function resultWith(outcomes: Array<BenchmarkResult["decisionPoints"][number]["outcome"]>, cancelled = false): BenchmarkResult {
  return {
    params: { symbol: "NSE:INFY", timeframe: "day", source: "bhavcopy", horizon: "positional", algoId: "sma", lookaheadBars: 5, fromTs: 0, toTs: 0 },
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
    cancelled,
  };
}

async function selectEntryAndAlgo(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^sma/i }));
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

  it("renders the algorithm picker tagged fast/slow and tags a forecaster as an ML forecaster", async () => {
    render(<BenchmarkView api={api()} />);
    fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));
    expect(await screen.findByText(/kronos/i)).toBeTruthy();
    expect(screen.getByText(/slow \(ml forecaster\)/i)).toBeTruthy();
  });

  it("prefills the lookahead default and the single date field on selection", async () => {
    render(<BenchmarkView api={api()} />);
    fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));
    const lookahead = (await screen.findByLabelText(/lookahead bars/i)) as HTMLInputElement;
    expect(lookahead.value).toBe("5"); // positional default
    const date = (await screen.findByLabelText(/^date$/i)) as HTMLInputElement;
    expect(date.value).toBe(new Date(DAY_ENTRY.fromTs * 1000).toISOString().slice(0, 10));
  });

  it("keeps the Run button disabled until an algorithm is selected", async () => {
    render(<BenchmarkView api={api()} />);
    fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));
    const runButton = await screen.findByRole("button", { name: /run benchmark/i });
    expect(runButton).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /^sma/i }));
    expect(runButton).not.toBeDisabled();
  });

  it("runs the benchmark with the assembled params including the selected algorithm and single-day window", async () => {
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(resultWith([])) });
    render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    await waitFor(() => expect(deps.runBenchmark).toHaveBeenCalledTimes(1));
    const dayStart = Math.floor(new Date(`${new Date(DAY_ENTRY.fromTs * 1000).toISOString().slice(0, 10)}T00:00:00Z`).getTime() / 1000);
    expect(deps.runBenchmark.mock.calls[0][0]).toEqual({
      symbol: "NSE:INFY",
      timeframe: "day",
      source: "bhavcopy",
      horizon: "positional",
      algoId: "sma",
      lookaheadBars: 5,
      fromTs: dayStart,
      toTs: dayStart + 86_400,
    });
  });

  it("renders the summary strip counts and hit-rate after a run", async () => {
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(resultWith(["correct", "correct", "incorrect", "neutral"])) });
    render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    // 2 correct / (2 correct + 1 incorrect) = 67%.
    expect(await screen.findByText(/67%/)).toBeTruthy();
    expect(screen.getByText(/2 correct/i)).toBeTruthy();
  });

  it("shows a zero-decision-points strip instead of dividing by zero", async () => {
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(resultWith([])) });
    render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    expect(await screen.findByText(/0 decision points/i)).toBeTruthy();
  });

  it("renders a Cancelled banner in place of an error when the result is cancelled", async () => {
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(resultWith([], true)) });
    render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    expect(await screen.findByText(/cancelled — partial results/i)).toBeTruthy();
  });

  it("shows a loading spinner while the lake list is in flight", () => {
    render(<BenchmarkView api={api({ listLakeSymbols: vi.fn(() => new Promise(() => {})) })} />);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("shows a fixed progress pill reflecting onBenchmarkProgress updates while running", async () => {
    let progressHandler: ((p: { index: number; total: number }) => void) | undefined;
    const runBenchmark = vi.fn(() => new Promise<BenchmarkResult>(() => {})); // never resolves -- keeps `running` true
    const deps = api({
      runBenchmark,
      onBenchmarkProgress: vi.fn((handler: (p: { index: number; total: number }) => void) => {
        progressHandler = handler;
      }),
    });
    render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    await waitFor(() => expect(runBenchmark).toHaveBeenCalledTimes(1));
    progressHandler?.({ index: 3, total: 10 });
    expect(await screen.findByText(/bar 3\/10/i)).toBeTruthy();
  });

  it("calls cancelBenchmark when Stop is clicked while a run is in flight", async () => {
    const runBenchmark = vi.fn(() => new Promise<BenchmarkResult>(() => {}));
    const deps = api({ runBenchmark });
    render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    await waitFor(() => expect(runBenchmark).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: /^stop$/i }));
    expect(deps.cancelBenchmark).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 4: Run the tests, confirm they fail**

Run: `npx vitest run test/renderer/BenchmarkView.test.tsx`
Expected: FAIL — the component doesn't yet call `listAlgorithms`/expose an algorithm picker/single date field/progress pill/Stop button/cancelled banner.

- [ ] **Step 5: Update `BenchmarkView.css`** — remove the now-unused segmented-control rule:

```css
.segmented-control {
  display: inline-flex;
  gap: var(--space-1);
}
```

Add, after `.benchmark-field`:

```css
.benchmark-algo-picker {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  border: none;
  padding: 0;
  margin: 0;
}
```

Add, after `.benchmark-popover` (end of file):

```css
.benchmark-progress-pill {
  position: fixed;
  top: var(--space-4);
  right: var(--space-4);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  z-index: 10;
}

.benchmark-progress-bar {
  width: 96px;
  height: 4px;
  background: var(--bg-subtle);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.benchmark-progress-bar-fill {
  height: 100%;
  background: var(--fg);
}
```

- [ ] **Step 6: Rewrite `BenchmarkView.tsx`** — replace the full contents of `electron-app/src/renderer/BenchmarkView.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { MessageMarkdown } from "./MessageMarkdown";
import { createBenchmarkChart } from "./benchmarkChart";
import { defaultLookaheadForHorizon, summarize } from "../main/services/benchmark/benchmarkRunner";
import { Card } from "./ui/Card";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { TextField } from "./ui/TextField";
import { EmptyState } from "./ui/EmptyState";
import { Banner } from "./ui/Banner";
import { Spinner } from "./ui/Spinner";
import { BarChart3, Copy } from "./ui/icons";
import "./BenchmarkView.css";
import type { AlgorithmEntry, BenchmarkResult, DecisionPoint, LakeSymbolEntry, RendererApi } from "../main/ipc/rendererApi";

type BenchmarkApi = Pick<
  RendererApi,
  "listLakeSymbols" | "listAlgorithms" | "runBenchmark" | "cancelBenchmark" | "copyBenchmarkResult" | "onBenchmarkProgress"
>;

function toDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function fromDate(value: string): number {
  return Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 1000);
}

const DAY_SECONDS = 86_400;

function SummaryStrip({ points }: { points: DecisionPoint[] }): JSX.Element {
  const { correct, incorrect, neutral, hitRate } = summarize(points);
  if (points.length === 0) {
    return <Card className="benchmark-summary">0 decision points — nothing to score.</Card>;
  }
  const hitRateLabel = hitRate === null ? "—" : `${Math.round(hitRate * 100)}%`;
  return (
    <Card className="benchmark-summary">
      <Badge tone="bullish">{correct} correct</Badge>
      <Badge tone="bearish">{incorrect} incorrect</Badge>
      <Badge tone="neutral">{neutral} neutral</Badge>
      <span className="benchmark-summary-hitrate">hit-rate {hitRateLabel}</span>
    </Card>
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
      {result.cancelled && <Banner variant="info">Cancelled — partial results</Banner>}
      <SummaryStrip points={result.decisionPoints} />
      <Button variant="ghost" onClick={() => void api.copyBenchmarkResult(JSON.stringify(result))}>
        <Copy size={14} aria-hidden="true" /> Copy raw result
      </Button>
      <div className="benchmark-chart" ref={chartRef} />
      {selected && (
        <Card className="benchmark-popover">
          <h3>
            {selected.direction} ({selected.conviction} conviction) — {selected.outcome}
          </h3>
          <p>
            {selected.closeAtFrontier} → {selected.closeAtLookahead} ({(selected.realizedReturn * 100).toFixed(2)}%)
          </p>
          <p>algos: {selected.algoResults.map((r) => r.algo_id).join(", ")}</p>
          <MessageMarkdown text={selected.responseText} />
        </Card>
      )}
    </div>
  );
}

export function BenchmarkView({ api }: { api: BenchmarkApi }): JSX.Element {
  const [entries, setEntries] = useState<LakeSymbolEntry[] | null>(null);
  const [algorithms, setAlgorithms] = useState<AlgorithmEntry[] | null>(null);
  const [selected, setSelected] = useState<LakeSymbolEntry | null>(null);
  const [selectedAlgoId, setSelectedAlgoId] = useState<string | null>(null);
  const [lookaheadBars, setLookaheadBars] = useState(5);
  const [date, setDate] = useState("");
  const [result, setResult] = useState<BenchmarkResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ index: number; total: number } | null>(null);

  useEffect(() => {
    void api.listLakeSymbols().then(setEntries);
    void api.listAlgorithms().then(setAlgorithms);
    api.onBenchmarkProgress(setProgress);
  }, [api]);

  const onSelectEntry = (entry: LakeSymbolEntry): void => {
    setSelected(entry);
    setLookaheadBars(defaultLookaheadForHorizon(entry.horizon));
    setDate(toDate(entry.fromTs));
    setResult(null);
  };

  const onRun = async (): Promise<void> => {
    if (!selected || !selectedAlgoId) return;
    setRunning(true);
    setError(null);
    setProgress(null);
    try {
      const dayStart = fromDate(date);
      const run = await api.runBenchmark({
        symbol: selected.symbol,
        timeframe: selected.timeframe,
        source: selected.source,
        horizon: selected.horizon,
        algoId: selectedAlgoId,
        lookaheadBars,
        fromTs: dayStart,
        toTs: dayStart + DAY_SECONDS,
      });
      setResult(run);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const onStop = (): void => {
    void api.cancelBenchmark();
  };

  if (entries === null || algorithms === null) {
    return (
      <div className="benchmark-loading">
        <Spinner /> Loading lake…
      </div>
    );
  }
  if (entries.length === 0) {
    return <EmptyState icon={BarChart3} message="No data ingested yet — run the `ingest` CLI (see the Phase 6 design, P6§3)." />;
  }

  return (
    <div className="benchmark">
      {running && (
        <Card className="benchmark-progress-pill">
          <span>
            {selectedAlgoId} — bar {progress ? progress.index : 0}/{progress ? progress.total : "…"}
          </span>
          <div className="benchmark-progress-bar">
            <div
              className="benchmark-progress-bar-fill"
              style={{ width: progress && progress.total > 0 ? `${(progress.index / progress.total) * 100}%` : "0%" }}
            />
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onStop}>
            Stop
          </Button>
        </Card>
      )}
      {result ? (
        <ResultsView api={api} result={result} />
      ) : (
        <>
          <h2>Benchmark</h2>
          <ul className="benchmark-picker">
            {entries.map((entry) => (
              <li key={`${entry.symbol}_${entry.timeframe}_${entry.source}`}>
                <button type="button" className="benchmark-picker-item" onClick={() => onSelectEntry(entry)}>
                  {entry.symbol} · {entry.timeframe} · {entry.source} · {entry.horizon} · {toDate(entry.fromTs)}–{toDate(entry.toTs)} · {entry.candleCount} bars
                </button>
              </li>
            ))}
          </ul>

          {selected && (
            <Card>
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
                <fieldset className="benchmark-algo-picker">
                  <legend>Algorithm</legend>
                  {algorithms.map((algo) => (
                    <Button
                      key={algo.id}
                      type="button"
                      variant={selectedAlgoId === algo.id ? "primary" : "secondary"}
                      size="sm"
                      aria-pressed={selectedAlgoId === algo.id}
                      onClick={() => setSelectedAlgoId(algo.id)}
                    >
                      {algo.id} · {algo.cost === "slow" ? "slow (ML forecaster)" : "fast"}
                    </Button>
                  ))}
                </fieldset>
                <label className="benchmark-field">
                  Lookahead bars
                  <TextField type="number" min={1} value={lookaheadBars} onChange={(e) => setLookaheadBars(Number(e.target.value))} />
                </label>
                <label className="benchmark-field">
                  Date
                  <TextField
                    type="date"
                    min={toDate(selected.fromTs)}
                    max={toDate(selected.toTs)}
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </label>
                <Button type="submit" disabled={running || !selectedAlgoId}>
                  {running && <Spinner size={14} />} {running ? "Running…" : "Run benchmark"}
                </Button>
                {error && <Banner variant="error">{error}</Banner>}
              </form>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Run the tests + typecheck, confirm they pass**

Run (from `electron-app/`): `npx vitest run test/renderer/BenchmarkView.test.tsx && npm run typecheck`
Expected: PASS — every test in the file plus a clean typecheck. Then run the full renderer suite once: `npx vitest run test/renderer` — expected all green (the `testBridge.ts` update from Step 1 keeps every other renderer test compiling). Finally run the whole project test suite: `npm test`.

- [ ] **Step 8: Commit**

```bash
git add electron-app/src/renderer/BenchmarkView.tsx electron-app/src/renderer/BenchmarkView.css electron-app/test/renderer/testBridge.ts electron-app/test/renderer/BenchmarkView.test.tsx
git commit -m "feat(benchmark-ui): algorithm picker, single-day field, progress pill, Stop, cancelled banner"
```

---

## Manual verification checklist (not a task — never blocks phase completion)

Mirrors the Phase 6/Phase 11 precedent: an automatable golden path plus a live follow-up requiring the real sidecar binary and a real ingested lake.

**Automatable (mocked bridge + `npm start`):**
- Opening the Benchmark screen and selecting a lake entry shows the algorithm picker with every algorithm tagged `fast` or `slow (ML forecaster)`.
- The Run button stays disabled until both a lake entry and an algorithm are selected.
- Starting a run shows the fixed top-right progress pill with the selected algorithm id and an advancing `bar {index}/{total}`; clicking Stop calls `cancelBenchmark` and the pill disappears once the run resolves.
- A run whose result has `cancelled: true` renders the "Cancelled — partial results" banner, not the error banner, with whatever partial chart/summary data exists.

**Live follow-ups (real sidecar binary + a real ingested lake — never a blocker for calling Phase 12 done):**
- Build the sidecar binary and run a real benchmark against an actual ingested symbol/day/algorithm; confirm it completes in low single-digit seconds instead of hitting the old 30s timeout, and that CPU returns to idle promptly after completion.
- Select a slow (ONNX forecaster) algorithm, start a run, and click Stop mid-run; confirm the sidecar process is killed immediately (not after the current bar finishes), the UI shows "Cancelled — partial results," and a subsequent run starts normally once the supervisor has respawned (~500ms backoff).
- Confirm an `algo_id` the running binary doesn't recognize (e.g. a forecaster feature not compiled into this build) yields a completed run with zero decision points, not a hung request or a crash.

---

## Self-Review

**1. Spec coverage:**
- P12§3.1 (`ListAlgorithms` protocol + `handle_list_algorithms`, cost tagging via the existing registry partition, dedup, sorted by id) → Task 1.
- P12§3.2 (`BenchmarkComputeRequest.algo_id`, `handle_benchmark_compute` filters to one algorithm) → Task 2.
- P12§4.1 (`runBenchmark` gains `algoId`/`onProgress`, cadence computed internally, `manual`/`everyN` removed, `BenchmarkResult.cancelled`) → Task 4.
- P12§4.2 (`SidecarSupervisor.cancelCurrent()`, `onExit` tags a cancellation, `benchmarkCompute` gains `algoId`) → Task 3.
- P12§4.3 (`benchmark:listAlgorithms`, `benchmark:runBenchmark` forwards progress via `event.sender.send`, `benchmark:cancelBenchmark`, `RendererApi.onBenchmarkProgress`) → Task 5.
- P12§5 (algorithm picker, single date field replacing From/To, progress pill + Stop, cancelled banner, Auto/Manual + Every-N deleted) → Task 6.
- P12§6 testing: `handle_list_algorithms` fast/slow/dedup test → Task 1 Step 5; `handle_benchmark_compute` exact-one-match and unknown-id tests → Task 2 Step 5; `runBenchmark` `onProgress` + cancellation tests → Task 4 Step 1; `SidecarSupervisor.cancelCurrent` reject + respawn tests → Task 3 Step 2. No wall-clock-dependent test is added anywhere.
- P12§7 risk: the `BenchmarkRunParams`/`BenchmarkCadence` breaking change is contained to `benchmarkBridge.ts`'s one call site (confirmed via the codebase-wide grep during planning — no other caller of `runBenchmark` exists); the hard-kill blast radius is unchanged from what `onExit` already tolerates.
- Not-in-scope items (no sidecar concurrency/worker pool, no ONNX thread capping, no live `Compute` path change, no cooperative cancellation) — no task touches any of these; the Global Constraints section states them explicitly as guardrails for the implementer.

**2. Placeholder scan:** every step shows complete, real, compilable code verified against the actual current file contents read from the repo (not paraphrased) — including every existing test literal that had to change once `algo_id` became required. No "TBD"/"TODO"/"handle edge cases" language appears in any task.

**3. Type consistency:** `BenchmarkRunParams { symbol, timeframe, source, horizon, algoId, lookaheadBars, fromTs, toTs }` is identical across Task 4 (definition), Task 5 (bridge test payloads), and Task 6 (`onRun`'s constructed params and the test's `resultWith`/assembled-params test). `BenchmarkResult { params, candles, decisionPoints, cancelled }` matches across Tasks 4-6. `AlgorithmEntry { id, cost }` and `AlgorithmWire { id, cost }` match between Task 5 (TS) and Task 1 (Rust wire, modulo the snake_case-vs-camelCase convention already established for every other wire type in this codebase). `SidecarSupervisor.benchmarkCompute`'s 5-arg signature `(symbol, timeframe, horizon, candles, algoId)` matches across Task 3 (definition + tests) and Task 4 (`runBenchmark`'s two call sites). `handle_benchmark_compute`'s `algo_id: String` field matches across Task 2 (Rust struct, handler, tests) and the wire literals updated in `end_to_end_test.rs`.

**4. Judgment calls made during planning (spec was silent or showed two conflicting conventions):**
1. **Progress-push wiring uses `event.sender.send` directly** (as the spec's P12§4.3 code block literally shows), not the `sendToRenderer`-via-`bootstrap.ts` closure pattern that `registerStatusBridge`/`registerAnalysisBridge` use elsewhere in this codebase (and that the spec's surrounding prose gestures at). This keeps `bootstrap.ts`'s existing `registerBenchmarkBridge({ ipcMain, sidecar: supervisor })` call site completely untouched — `BenchmarkBridgeDeps.sidecar`'s `Pick` widening is satisfied structurally by the already-passed `supervisor` instance, so zero `bootstrap.ts` edits are needed in this plan. If a reviewer prefers strict consistency with the `sendToRenderer` convention instead, that is a one-file, low-risk follow-up (adding `sendToRenderer` to `BenchmarkBridgeDeps` and one line in `bootstrap.ts`), not a blocking gap.
2. **`handle_benchmark_compute_on_empty_candles_returns_a_zeroed_response`'s `id` is renumbered from `31` to `29`** in Task 2 Step 5, to keep it distinct from the new unknown-`algo_id` test (which the spec's own P12§6 wording implies should exist alongside the existing empty-candles test) — purely a test-id-collision-avoidance choice, no behavior change.
3. **`"sma"` is the fixed `algo_id` used across every updated Rust/TS wire-literal test** (it's in `EXPECTED_DEFAULT_IDS`, so it exists in every build regardless of which forecaster features are compiled in) — chosen once and reused everywhere for consistency, rather than picking different ids per test file.
4. **The renderer's single date `<input type="date">` is bounded by `[entry.fromTs, entry.toTs]`** exactly as the old From/To pair was, and its state is stored as the raw `<input>` string (`date`) rather than a derived timestamp, converting to `fromTs`/`toTs` only at submit time via `fromDate(date)` / `fromDate(date) + 86_400` — matching P12§5's "start-of-day UTC through start-of-next-day UTC" wording exactly.
