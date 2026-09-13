# Phase 12 — Benchmark Run Scoping, Progress, and Cancellation

Status: approved by user 2026-09-13 (conversational diagnosis + brainstorming), pending implementation planning.
Author: design produced via superpowers:brainstorming, triggered by a live incident: after the Phase 11 lake-listing fix landed, running an actual benchmark (all registered algorithms across a multi-week date range) hit the sidecar's 30s request timeout, showed no progress in the UI, had no way to stop it, and drove sustained high CPU/thermal load. Section references: "P6§N" → `docs/superpowers/specs/2026-07-27-phase6-benchmark-ui-design.md`; "P11§N" → `docs/superpowers/specs/2026-09-13-phase11-lake-listing-perf-fix-design.md`; "P12§N" → this document.

## P12§1 Purpose

P11§1 fixed the cost of *listing* what's in the lake. This document fixes the cost of *running* a benchmark against it. Measured architecture, confirmed by reading the real code (not assumed):

- `rust-core/crates/sidecar/src/main.rs` is a single-threaded, strictly serial loop: one stdin line in, fully blocking compute, one stdout line out, then the next line. There is no concurrency anywhere in this process.
- `electron-app/src/main/services/benchmark/benchmarkRunner.ts`'s `runBenchmark` drives the entire walk-forward loop from the Electron main process: one `benchmarkCompute` IPC round-trip per bar in the selected date range.
- `handle_benchmark_compute` (`rust-core/crates/sidecar/src/handlers.rs:217-245`) unconditionally calls `registry::all_for_binary()` — **every** registered algorithm, including the four ONNX ML forecasters (kronos/ttm/chronos/moirai, whichever are linked into this build) — on **every single bar**.

A benchmark across a multi-week range therefore multiplies "up to ~38 algorithms" (34 fast indicator/options/quant algorithms plus up to 4 ONNX forecasters) by "hundreds to thousands of bars," with Kronos's 8-step autoregressive ONNX decode as the dominant per-bar cost. That product is what pegs CPU for extended periods, blows past the sidecar's 30s per-request timeout on unrelated calls queued behind it (the process is serial), and gives zero feedback or way to stop while it happens.

This document does not add concurrency, worker pools, or ONNX thread-capping. Per explicit user decision, the fix is: run one chosen algorithm against one chosen day, show live per-bar progress, and allow a hard stop. Scope reduction alone cuts the work by roughly two orders of magnitude versus today's default (all algorithms × full range).

## P12§2 Scope

**In scope:**

1. New sidecar request/response pair `ListAlgorithms` — lists every algorithm linked into the running binary, tagged `fast` or `slow` by which half of the existing registry partition it came from (P12§3.1).
2. `BenchmarkComputeRequest` gains a required `algo_id` field; `handle_benchmark_compute` filters to that single algorithm before computing, instead of the full registry (P12§3.2).
3. `runBenchmark` (`benchmarkRunner.ts`) gains an `algoId` parameter (threaded into every `benchmarkCompute` call) and an `onProgress(index, total)` callback invoked once per bar iteration of its existing loop (P12§4.1).
4. A new hard-cancel path: `SidecarSupervisor` gains a `cancelCurrent()` method that kills the sidecar child process immediately, tags the resulting rejection as a cancellation (distinct from a real crash), and lets the existing auto-restart logic (`onExit`, `stopped` remains `false`) respawn it (P12§4.2).
5. `benchmarkBridge.ts`: a new `benchmark:listAlgorithms` handler; `benchmark:runBenchmark` forwards per-bar progress to the renderer via `event.sender.send` on a new `benchmark:progress` channel while the run is in flight; a new `benchmark:cancelBenchmark` handler that calls `cancelCurrent()` (P12§4.3).
6. `BenchmarkView.tsx`: algorithm picker (fast/slow tagged) and a single-date picker replace the current from/to date range and the manual/every-N cadence toggle; a fixed top-right progress pill + Stop button appears while a run is active; a cancelled run's partial results are labeled "Cancelled," not shown as an error (P12§5).

**Not in scope (explicit user decisions):**

- No new concurrency, request queue, or worker pool in the sidecar — it remains single-threaded and serial.
- No ONNX intra-op thread capping or other CPU/resource throttling below the process level — scope reduction (one algorithm × one day) is judged sufficient; running an expensive forecaster is now an informed, visible, cancellable opt-in choice rather than an accidental default.
- No changes to the live (non-benchmark) `Compute` request path, which already has its own per-algorithm progress instrumentation (`handle_request_with_progress`, `main.rs:99-118`) unrelated to this work.
- Cooperative/graceful cancellation (checking an abort flag between bars) is explicitly rejected in favor of hard-kill, per user decision — see P12§4.2 for why this is safe here.

**Locked decisions:**

1. Cost tagging reuses the existing registry partition (`registry::all()` = fast, `registry::ensure_forecasters_linked()` = slow) rather than introducing a new classification scheme on the `Algorithm` trait. Confirmed via direct code inspection: the trait has exactly four methods (`id`, `required_lookback`, `applicable_horizons`, `compute`) and no cost/category metadata exists anywhere in the crate today.
2. "One day" means one calendar day of bars for the selected timeframe — for intraday timeframes this can still be many bars (all bars within that one trading day); for `day` timeframe it resolves to exactly one bar. This is a deliberate choice over "exactly one bar regardless of timeframe" (rejected) because it keeps the mental model simple ("pick a day") without a second, timeframe-dependent meaning of "one unit."
3. An unknown or unlinked `algo_id` (e.g. the UI's cached algorithm list came from a build with a forecaster feature the running binary lacks) yields zero `algo_results`, not an error — consistent with this file's existing "well-formed empty response" pattern (`empty_response`, `benchmark_empty_response`).
4. Cancellation is a hard kill of the sidecar child process, not a cooperative check. This is safe specifically because: (a) the sidecar is already fully re-spawnable and stateless per request (existing `onExit` auto-restart), (b) a benchmark run holds no server-side state that a kill would corrupt (unlike `PersistCandles`, which is intentionally out of the benchmark path entirely), and (c) it guarantees an instant stop even mid-Kronos-decode, which a cooperative flag checked only between bars cannot.
5. Cadence auto/manual-every-N toggle and its `everyN` field are removed entirely (type, runner branch, UI control) rather than left dead — nothing will construct a `manual` cadence once the toggle is gone, and CLAUDE.md's structure guidance is to avoid half-finished/unreachable code paths. The runner always uses `defaultCadenceForHorizon(horizon)`; `lookaheadBars` remains user-configurable since it controls outcome scoring, not run cost.

## P12§3 Sidecar (Rust) protocol changes

### P12§3.1 `ListAlgorithms`

```rust
// protocol.rs
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

Added to `SidecarRequest` as `ListAlgorithms(ListAlgorithmsRequest)` and to `SidecarResponse` as `Algorithms(ListAlgorithmsResponse)` (serde tag `"algorithms"`). Needs no `CandleStore`/`StateStore` — same "always answers, no store" category as `BenchmarkCompute` and `EvaluateScanGateStateless` in `main.rs`'s dispatch.

```rust
// handlers.rs
pub fn handle_list_algorithms(request: ListAlgorithmsRequest) -> ListAlgorithmsResponse {
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

This mirrors `registry::all_for_binary()`'s own union-and-dedup shape (`registry.rs:52-60`) rather than calling `all_for_binary()` and guessing which entries were forecasters from the outside — cost tagging has to happen while the two source lists are still separate.

### P12§3.2 `BenchmarkComputeRequest.algo_id`

```rust
#[derive(Debug, Deserialize)]
pub struct BenchmarkComputeRequest {
    pub id: u64,
    pub symbol: String,
    pub timeframe: String,
    pub horizon: String,
    pub candles: Vec<CandleWire>,
    pub algo_id: String, // new
}
```

`handle_benchmark_compute` (`handlers.rs:217-245`) changes its algorithm selection from:

```rust
let algos = registry::all_for_binary();
let outputs = run_applicable(&algos, &ctx);
```

to:

```rust
let algos: Vec<Box<dyn Algorithm>> = registry::all_for_binary()
    .into_iter()
    .filter(|a| a.id() == request.algo_id)
    .collect();
let outputs = run_applicable(&algos, &ctx);
```

Everything downstream (`compute_confluence`, `algo_output_to_wire`) already treats `outputs` as a generic list and needs no change for a single-element (or zero-element, per P12§2 locked decision 3) case.

## P12§4 Electron main process changes

### P12§4.1 `benchmarkRunner.ts`

`BenchmarkRunParams` drops `cadence` as a caller-supplied field (the runner computes it internally via `defaultCadenceForHorizon(params.horizon)`) and adds `algoId: string`. The `BenchmarkCadence` union drops its `{ mode: "manual"; everyN: number }` variant, and the loop's `manual` branch is deleted along with `defaultCadenceForHorizon`'s only remaining caller-visible choice being `session_close` vs `stateless_gate` (unchanged, still horizon-driven).

`runBenchmark`'s signature becomes:

```ts
export async function runBenchmark(
  deps: BenchmarkRunnerDeps,
  params: BenchmarkRunParams,
  onProgress?: (index: number, total: number) => void,
): Promise<BenchmarkResult>
```

Inside the existing `for (let i = 0; i < series.length; i++)` loop, after the boundary check and before computing, call `onProgress?.(i, series.length)`. Every `benchmarkCompute` call passes `params.algoId` through. `BenchmarkResult` gains `cancelled: boolean`, defaulted `false`; the existing `catch` block (currently just `console.error`s a mid-walk rejection and returns the partial run — see the comment at `benchmarkRunner.ts:148-152`) additionally checks whether the caught error is tagged as a cancellation (P12§4.2) and sets `cancelled = true` if so, leaving the message-only log path for genuine errors.

### P12§4.2 `sidecarSupervisor.ts` — hard cancel

```ts
private cancelling = false;

cancelCurrent(): void {
  this.cancelling = true;
  this.child?.kill();
}

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
  // ...existing restart logic, unchanged...
}
```

The `error.cancelled === true` tag is what `runBenchmark`'s catch block (P12§4.1) checks. No other change to `onExit`'s existing restart behavior (P11/P6 already established the single-instance auto-restart contract; this reuses it rather than adding a second lifecycle path).

`benchmarkCompute` gains an `algoId` parameter, included in the request object sent to the sidecar.

### P12§4.3 `benchmarkBridge.ts` — listing, progress push, cancel

```ts
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
```

The progress push follows this codebase's one existing fire-and-forget convention exactly (`bootstrap.ts`'s `sendToRenderer` → `webContents.send`, as used today for `"banner:push"` and `"analysis:trace"` — confirmed by reading `appBridge.ts`/`traceBridge.ts` and their preload exposure): a plain channel send with no ack, no queuing, no unsubscribe machinery beyond what `onBanner`/`onTrace` already lack. `benchmark:progress` is deliberately the same shape: `rendererApi.ts` gains `onBenchmarkProgress(handler: (progress: { index: number; total: number }) => void): void` wired via the existing `subscribe(channel, handler)` helper in `preload.ts`, exactly like `onBanner`/`onTrace`.

## P12§5 Renderer (`BenchmarkView.tsx`) changes

- On mount, alongside the existing `listLakeSymbols()` call, also call `listAlgorithms()` and store the tagged list.
- Setup form changes:
  - Algorithm picker: a list of buttons/radio items, one per algorithm, each showing its id and a small "fast"/"slow (ML forecaster)" tag. Selecting one is required before the Run button is enabled (mirrors the existing "must select a lake entry first" gate).
  - Single date field replaces the From/To pair: one `<input type="date">`, bounded by `[entry.fromTs, entry.toTs]` exactly as the two fields are bounded today. `fromTs`/`toTs` passed to `runBenchmark` are derived as that day's start/end (start-of-day UTC through start-of-next-day UTC), so `BenchmarkRunParams`'s wire shape (`fromTs`/`toTs`) is unchanged — only how the UI computes the two values changes.
  - The Auto/Manual segmented control and "Every N bars" field are deleted; `lookaheadBars` remains.
- While `running` is true: a fixed-position (top-right) progress pill subscribed to `onBenchmarkProgress`, showing the selected algorithm id and `"bar {index}/{total}"` plus a thin progress bar, with a Stop button that calls `cancelBenchmark()`.
- `BenchmarkResult.cancelled` renders a distinct "Cancelled — partial results" `Banner` (info tone) in place of the error `Banner`, ahead of the existing chart/summary (which render unchanged against whatever partial `decisionPoints` exist).

## P12§6 Testing

- Rust: unit test for `handle_list_algorithms` asserting every fast-registry id is tagged `"fast"`, every forecaster-only id (from `ensure_forecasters_linked`) is tagged `"slow"`, and the list is deduplicated (mirrors the existing dedup test shape used for `all_for_binary`).
- Rust: unit test for `handle_benchmark_compute` with an `algo_id` matching exactly one known algorithm, asserting `algo_results.len() == 1` and its `algo_id` matches; a second test with an unknown `algo_id`, asserting a well-formed zero-result response (not a panic or error).
- TS: unit test for `runBenchmark` asserting `onProgress` is invoked once per surviving loop iteration with the correct `(index, total)` pairs, and a test that a sidecar rejection tagged `{ cancelled: true }` produces `BenchmarkResult.cancelled === true` with only the pre-cancellation decision points present.
- TS: unit test for `SidecarSupervisor.cancelCurrent()` asserting pending requests reject with `error.cancelled === true` and the child process is killed; a follow-up asserting the supervisor auto-restarts afterward (reuses the existing restart-backoff test setup).
- No wall-clock-dependent test is added — as in P11§5, correctness is verified by behavior (right algorithm selected, right progress counts, right cancellation tagging), not by asserting a timing threshold.

## P12§7 Risk

- Removing the `manual`/`everyN` cadence path is a breaking change to `BenchmarkRunParams`'s shape and `BenchmarkCadence`'s union; there are no other callers of `runBenchmark` in this codebase besides `benchmarkBridge.ts`, so this is a contained, single-call-site change.
- Hard-killing the sidecar mid-request (P12§2 locked decision 4) discards whatever partial in-process state that one `benchmark_compute` call held — acceptable because, as established, no server-side state survives a single request in this handler (it takes candles by value and returns; it never writes to `CandleStore`/`StateStore`). This is a strictly narrower blast radius than the general "sidecar crashes mid-request" case this codebase already tolerates via the existing `onExit` reject-and-restart path.
- If the user cancels and immediately starts a new run before the respawned child has finished starting, the new run's first request queues behind process startup, not behind a stale computation — same behavior as today's existing `RESTART_BACKOFF_MS` (500ms) window after any sidecar exit.
