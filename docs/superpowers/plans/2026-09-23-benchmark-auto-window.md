# Automatic Benchmark Window Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Benchmark screen's manual date and lookahead-bars fields; the backend resolves a working test day itself (backfilling more bhavcopy history when needed, exactly as today, just without a caller-supplied day), and a stock proven unable to support an algorithm greys out in the picker instead of repeating the same confusing failure.

**Architecture:** The Rust sidecar's existing, fully-tested `day_backfill.rs` logic (leading/trailing split, backward backfill walk, absent-day/archive-exhausted detection) is left completely untouched as a private helper. A new thin public entry point picks the candidate day by counting rows already in the lake (no new calendar/holiday code — reuses whatever the existing helper already does with that day) and delegates to it. On the Electron side, `runBenchmark` is split into an outer resolver (new) and the existing frontier-walk (extracted unchanged, so its ~15 existing tests need no logic changes). The screen drops both manual fields, remembers which stock+algorithm pairs are proven unworkable, and gains a way back to the picker after a run so that memory is actually visible.

**Tech Stack:** Rust (sidecar crate, chrono, serde), TypeScript/Electron (main process services + IPC bridge), React (renderer), Vitest, cargo test.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-23-phase15-benchmark-auto-window-design.md` (P15). Prior design it builds on: `docs/superpowers/specs/2026-09-18-phase14-benchmark-bhavcopy-backfill-design.md` (P14).
- P15§2 locked decision 1/2: candidate-day picking lives in Rust, using only rows already read off disk — no new trading-calendar/holiday code anywhere.
- P15§2 locked decision 3: lookahead is fully automatic (`defaultLookaheadForHorizon`), never caller-supplied from the screen.
- P15§2 locked decision 4: only a `symbol_history` refusal greys out a symbol+algorithm pair; `archive_unreachable` never does (it's a transient network condition, not a fact about the stock).
- P15§2 locked decision 5/6: the wire request/response is renamed (`EnsureDayBackfillRequest`/`DayBackfillResponse` → `ResolveBenchmarkWindowRequest`/`ResolveBenchmarkWindowResponse`), and `day_backfill.rs` is renamed `benchmark_window.rs`. This is an internal Electron↔sidecar contract with no external consumers, so it changes cleanly — no compatibility shim.
- P15§2 "not in scope": no proactive/bulk pre-check of every symbol; no persisting the greyed-out set across restarts; no change to the backfill/fetch behavior itself (politeness delay, absent-day heuristic, archive-exhausted detection all stay exactly as built).
- **Scope addendum (not in the original spec, required to keep the screen functional):** the spec's "no date field" requirement applies to every entry in the picker, but P14's backfill mechanism only ever applied to day-timeframe/bhavcopy-sourced entries — intraday/community-archive entries (P14§1: a one-time static import, never backfilled) have no backend resolution to lean on. For those, `runBenchmark` uses the entry's *entire* available lake partition as the run's window (no per-day chunking at all) and checks sufficiency against `requiredLookback + lookaheadBars` using data already in hand — no fetch, no new calendar logic, just a length comparison. This is a strict simplification of today's behavior (which could silently produce zero decision points for an arbitrarily-thin single day), not a new subsystem.
- Naming/comments: follow `CLAUDE.md` — no comment that restates the next line; comments only where a non-obvious invariant needs explaining.

---

### Task 1: Rust — add the `ResolveBenchmarkWindow` wire types

**Files:**
- Modify: `rust-core/crates/sidecar/src/protocol.rs`

**Interfaces:**
- Produces: `ResolveBenchmarkWindowRequest { id: u64, symbol: String, algo_id: String, lookahead: usize }`, `ResolveBenchmarkWindowResponse { id: u64, from_ts: i64, have: usize, need: usize, sufficient: bool, archive_exhausted: bool, error: Option<String> }`, and `SidecarRequest::ResolveBenchmarkWindow` / `SidecarResponse::BenchmarkWindow` enum variants, consumed by Task 2 and Task 3.
- Consumes: nothing new (the existing `EnsureDayBackfillRequest`/`DayBackfillResponse` structs stay exactly as they are — they simply stop being wired into the public request/response enums, and keep serving as Task 2's internal per-day-check types).

- [ ] **Step 1: Add the new wire structs**

Add directly below the existing `DayBackfillResponse` struct (after its closing `}` at line 228):

```rust
#[derive(Debug, Deserialize)]
pub struct ResolveBenchmarkWindowRequest {
    pub id: u64,
    pub symbol: String,
    pub algo_id: String,
    /// The requesting run's scoring window (its `lookaheadBars`) -- everything
    /// else about which day to test is resolved server-side (P15§3).
    pub lookahead: usize,
}

#[derive(Debug, Serialize)]
pub struct ResolveBenchmarkWindowResponse {
    pub id: u64,
    /// The day actually resolved and tested: UTC midnight of that calendar
    /// day, in the same encoding `EnsureDayBackfillRequest::from_ts` used
    /// when a caller supplied it directly.
    pub from_ts: i64,
    pub have: usize,
    pub need: usize,
    pub sufficient: bool,
    pub archive_exhausted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
```

- [ ] **Step 2: Swap the enum variants**

In `SidecarRequest` (around line 313), replace:

```rust
    EnsureDayBackfill(EnsureDayBackfillRequest),
```

with:

```rust
    ResolveBenchmarkWindow(ResolveBenchmarkWindowRequest),
```

In `SidecarResponse` (around line 327), replace:

```rust
    DayBackfill(DayBackfillResponse),
```

with:

```rust
    BenchmarkWindow(ResolveBenchmarkWindowResponse),
```

- [ ] **Step 3: Compile-check (expected to fail — nothing implements the new variant yet)**

Run: `cd rust-core && cargo check -p sidecar 2>&1 | tail -40`
Expected: FAIL — `main.rs` still references `SidecarRequest::EnsureDayBackfill` and `SidecarResponse::DayBackfill`, which no longer exist. This is expected; Task 3 fixes it. Confirm the errors are only in `main.rs` (not `protocol.rs` itself) before moving on.

- [ ] **Step 4: Commit**

```bash
git add rust-core/crates/sidecar/src/protocol.rs
git commit -m "$(cat <<'EOF'
feat(sidecar): add ResolveBenchmarkWindow wire contract

Replaces EnsureDayBackfill/DayBackfill in the public request/response
enums -- the caller no longer supplies which day to test (P15§2 locked
decision 5). main.rs is intentionally left broken until the next commit.
EOF
)"
```

---

### Task 2: Rust — candidate-day picking and the new public handler

**Files:**
- Modify (rename): `rust-core/crates/sidecar/src/day_backfill.rs` → `rust-core/crates/sidecar/src/benchmark_window.rs`
- Modify: `rust-core/crates/sidecar/src/lib.rs`

**Interfaces:**
- Consumes: `ResolveBenchmarkWindowRequest`/`ResolveBenchmarkWindowResponse` (Task 1), the existing untouched `handle_ensure_day_backfill`/`EnsureDayBackfillRequest`/`DayBackfillResponse` in this same file.
- Produces: `pub fn handle_resolve_benchmark_window(store: &CandleStore, request: ResolveBenchmarkWindowRequest, today: NaiveDate, fetch: DayFetcher<'_>, on_progress: &mut dyn FnMut(usize, usize)) -> ResolveBenchmarkWindowResponse`, consumed by Task 3.

- [ ] **Step 1: Rename the file and update the module declaration**

```bash
git mv rust-core/crates/sidecar/src/day_backfill.rs rust-core/crates/sidecar/src/benchmark_window.rs
```

In `rust-core/crates/sidecar/src/lib.rs`, change:

```rust
pub mod day_backfill;
```

to:

```rust
pub mod benchmark_window;
```

- [ ] **Step 2: Add the import for the new wire types**

In `benchmark_window.rs`, change the top-of-file import:

```rust
use crate::protocol::{DayBackfillResponse, EnsureDayBackfillRequest};
```

to:

```rust
use crate::protocol::{
    DayBackfillResponse, EnsureDayBackfillRequest, ResolveBenchmarkWindowRequest,
    ResolveBenchmarkWindowResponse,
};
```

Also widen the existing `use storage::CandleStore;` to also bring in `Candle` (needed by the new candidate-picking function below):

```rust
use storage::{Candle, CandleStore};
```

(Remove the now-redundant `use storage::Candle;` inside the `#[cfg(test)] mod tests` block at the bottom of the file, since it is now imported at module scope and the duplicate import would warn.)

- [ ] **Step 3: Write the failing test for candidate-day picking on an already-sufficient lake**

Add to the existing `#[cfg(test)] mod tests` block, after the last test (`an_unknown_algo_id_needs_nothing_and_fetches_nothing`):

```rust
    #[test]
    fn resolve_picks_a_day_with_zero_fetches_when_the_lake_already_has_enough_on_both_sides() {
        // Mirrors an_already_deep_enough_lake_answers_immediately_with_zero_fetches,
        // but through the new entry point: nothing supplies from_ts, so the
        // picked day must be the newest candle minus `lookahead` positions.
        let lookahead = 1;
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

        let response = handle_resolve_benchmark_window(
            &store,
            ResolveBenchmarkWindowRequest { id: 7, symbol: "NSE:INFY".to_string(), algo_id: "obv".to_string(), lookahead },
            date(2024, 1, 15),
            &mut fetch,
            &mut |_, _| {},
        );

        assert_eq!(response.id, 7);
        // Newest is Jan 15 (index 0); index `lookahead` = 1 is Jan 12.
        assert_eq!(response.from_ts, selected_day_ts(date(2024, 1, 12)));
        assert_eq!(response.need, lookback_of("obv") + lookahead);
        assert_eq!(response.have, lookback_of("obv") + lookahead);
        assert!(response.sufficient);
        assert!(attempts.is_empty(), "a deep-enough lake must never hit the network");
    }

    #[test]
    fn resolve_refuses_immediately_when_the_whole_lake_is_thinner_than_the_lookahead_alone() {
        // Trailing can never reach `lookahead` no matter which day is picked
        // when the lake holds fewer rows than that in total -- the same
        // structural refusal a_selected_day_without_enough_trailing_bars_is_answered_without_fetching
        // exercises, reached here through candidate selection instead of a
        // caller-supplied from_ts.
        let lookahead = 5;
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        store
            .write_sourced_candles("NSE:INFY", BACKFILL_TIMEFRAME, BACKFILL_SOURCE, &weekly_candles(date(2024, 1, 15), 3))
            .unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["INFY"]))
        };

        let response = handle_resolve_benchmark_window(
            &store,
            ResolveBenchmarkWindowRequest { id: 7, symbol: "NSE:INFY".to_string(), algo_id: "obv".to_string(), lookahead },
            date(2024, 1, 15),
            &mut fetch,
            &mut |_, _| {},
        );

        assert!(!response.sufficient);
        assert!(attempts.is_empty(), "a lake this thin can never be fixed by fetching, so nothing should be attempted");
        assert_eq!(response.need, lookback_of("obv") + lookahead);
    }

    #[test]
    fn resolve_still_drives_the_leading_side_backfill_walk_when_needed() {
        // The phase-defining incident, reached through resolve(): a thin lake
        // and a deep algorithm, with no from_ts supplied at all.
        let lookback = lookback_of("garch");
        assert!(lookback > 8, "this fixture needs an algorithm deeper than the lake it starts with");
        let lookahead = 5;
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        store
            .write_sourced_candles("NSE:ZYDUSWELL", BACKFILL_TIMEFRAME, BACKFILL_SOURCE, &weekly_candles(date(2024, 1, 15), 8))
            .unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["ZYDUSWELL"]))
        };

        let response = handle_resolve_benchmark_window(
            &store,
            ResolveBenchmarkWindowRequest { id: 7, symbol: "NSE:ZYDUSWELL".to_string(), algo_id: "garch".to_string(), lookahead },
            date(2024, 1, 15),
            &mut fetch,
            &mut |_, _| {},
        );

        // 8 candles held, lookahead 5 -> candidate is the candle at index 5
        // (the 6th newest), which is the earliest of the 8 weekly candles is
        // index 7 -- index 5 lands two weeks in from the earliest.
        assert!(response.sufficient);
        assert_eq!(response.need, lookback + lookahead);
        assert_eq!(response.have, lookback + lookahead);
        assert!(!attempts.is_empty(), "the leading side was short, so the walk must have run");
    }
```

- [ ] **Step 2: Run the new tests to verify they fail to compile (the function doesn't exist yet)**

Run: `cd rust-core && cargo test -p sidecar benchmark_window 2>&1 | tail -30`
Expected: FAIL — `cannot find function 'handle_resolve_benchmark_window' in this scope`.

- [ ] **Step 3: Implement candidate picking and the new public handler**

Add to `benchmark_window.rs`, after the existing `handle_ensure_day_backfill` function's closing `}` (before the `#[cfg(test)]` block):

```rust
/// Picks a day using only rows already on disk, so the run's trailing side
/// is satisfied without ever needing a fetch (P15§3) -- backfill only ever
/// walks backward, so trailing can never be grown after the fact. Needs no
/// calendar/holiday logic: it counts rows, it doesn't walk dates.
fn pick_candidate_from_ts(existing: &[Candle], lookahead: usize, today: NaiveDate) -> i64 {
    let start_of_day = |day: NaiveDate| day.and_hms_opt(0, 0, 0).expect("midnight is a valid time").and_utc().timestamp();
    if existing.is_empty() {
        return start_of_day(today);
    }
    let mut sorted: Vec<&Candle> = existing.iter().collect();
    sorted.sort_by_key(|c| std::cmp::Reverse(c.ts));
    // `lookahead.min(sorted.len() - 1)`: when the lake holds no more than
    // `lookahead` rows total, trailing can never reach `lookahead` from any
    // candidate -- picking the earliest row here just routes into the
    // existing, already-tested `trailing < lookahead` refusal below with zero
    // fetches, rather than needing a second refusal path of its own.
    let idx = lookahead.min(sorted.len() - 1);
    start_of_day(ist_date_from_epoch(sorted[idx].ts))
}

/// Resolves which day to test (P15§3) and delegates to the untouched,
/// already-tested per-day check above. The caller supplies only the symbol,
/// algorithm, and this run's scoring window -- not a day.
pub fn handle_resolve_benchmark_window(
    store: &CandleStore,
    request: ResolveBenchmarkWindowRequest,
    today: NaiveDate,
    fetch: DayFetcher<'_>,
    on_progress: &mut dyn FnMut(usize, usize),
) -> ResolveBenchmarkWindowResponse {
    let id = request.id;
    let lookahead = request.lookahead;
    let lookback = registry::all_for_binary()
        .iter()
        .find(|algo| algo.id() == request.algo_id)
        .map(|algo| algo.required_lookback())
        .unwrap_or(0);
    let need = lookback + lookahead;

    let existing = match store.read_sourced_candles(&request.symbol, BACKFILL_TIMEFRAME, BACKFILL_SOURCE) {
        Ok(candles) => candles,
        Err(e) => {
            return ResolveBenchmarkWindowResponse { id, from_ts: 0, have: 0, need, sufficient: false, archive_exhausted: false, error: Some(e.to_string()) };
        }
    };
    let from_ts = pick_candidate_from_ts(&existing, lookahead, today);

    // Delegates to the untouched per-day check; it re-reads `existing` itself
    // (a small, accepted duplicate local read -- P14/P15 leave that function's
    // body unmodified on purpose).
    let checked = handle_ensure_day_backfill(
        store,
        EnsureDayBackfillRequest { id, symbol: request.symbol, algo_id: request.algo_id, lookahead, from_ts },
        today,
        fetch,
        on_progress,
    );

    ResolveBenchmarkWindowResponse {
        id: checked.id,
        from_ts,
        have: checked.have,
        need: checked.need,
        sufficient: checked.sufficient,
        archive_exhausted: checked.archive_exhausted,
        error: checked.error,
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd rust-core && cargo test -p sidecar benchmark_window 2>&1 | tail -60`
Expected: PASS — all tests in the file, including the 3 new ones and every pre-existing one (unchanged, still calling `handle_ensure_day_backfill` directly).

- [ ] **Step 5: Commit**

```bash
git add rust-core/crates/sidecar/src/benchmark_window.rs rust-core/crates/sidecar/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(sidecar): resolve the benchmark day server-side instead of trusting a caller-supplied one

day_backfill.rs -> benchmark_window.rs. The existing per-day
leading/trailing/backfill logic is untouched; a new public entry point
picks the candidate day by counting rows already on disk (P15§3) and
delegates to it.
EOF
)"
```

---

### Task 3: Rust — wire the new request into `main.rs`

**Files:**
- Modify: `rust-core/crates/sidecar/src/main.rs`

**Interfaces:**
- Consumes: `handle_resolve_benchmark_window` (Task 2), `SidecarRequest::ResolveBenchmarkWindow`/`SidecarResponse::BenchmarkWindow` (Task 1).

- [ ] **Step 1: Update imports**

Change:

```rust
use sidecar::day_backfill::handle_ensure_day_backfill;
```

to:

```rust
use sidecar::benchmark_window::handle_resolve_benchmark_window;
```

Change the `sidecar::protocol::{...}` import list's `DayBackfillResponse` entry to `ResolveBenchmarkWindowResponse`:

```rust
use sidecar::protocol::{
    benchmark_empty_response, empty_response, encode_progress, encode_progress_counted,
    encode_response, parse_request, LakeCandlesResponse, LakeSymbolsResponse,
    ListAlgorithmsResponse, PersistCandlesResponse, ResolveBenchmarkWindowResponse,
    ScanGateResponse, SidecarRequest, SidecarResponse, WatchlistResponse,
};
```

- [ ] **Step 2: Update `request_id` and `request_step`**

In `request_id` (around line 50), change:

```rust
        SidecarRequest::EnsureDayBackfill(r) => r.id,
```

to:

```rust
        SidecarRequest::ResolveBenchmarkWindow(r) => r.id,
```

In `request_step` (around line 67), change:

```rust
        SidecarRequest::EnsureDayBackfill(_) => "ensure_day_backfill",
```

to:

```rust
        SidecarRequest::ResolveBenchmarkWindow(_) => "resolve_benchmark_window",
```

- [ ] **Step 3: Update the match arm**

Replace the `SidecarRequest::EnsureDayBackfill(request) => { ... }` arm (lines 286-314) with:

```rust
            SidecarRequest::ResolveBenchmarkWindow(request) => {
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
                            handle_resolve_benchmark_window(store, request, today, &mut fetch, &mut |index, total| {
                                writeln!(stdout, "{}", encode_progress_counted(id, "backfill", "running", index, total))
                                    .expect("stdout must be writable");
                                stdout.flush().expect("stdout must flush");
                            })
                        }));
                        match result {
                            Ok(response) => SidecarResponse::BenchmarkWindow(response),
                            Err(_) => {
                                eprintln!("sidecar: resolve_benchmark_window request {id} panicked");
                                SidecarResponse::BenchmarkWindow(ResolveBenchmarkWindowResponse { id, from_ts: 0, have: 0, need: 0, sufficient: false, archive_exhausted: false, error: Some("resolve_benchmark_window panicked".to_string()) })
                            }
                        }
                    }
                    None => SidecarResponse::BenchmarkWindow(ResolveBenchmarkWindowResponse { id, from_ts: 0, have: 0, need: 0, sufficient: false, archive_exhausted: false, error: Some("no --lake-root configured".to_string()) }),
                }
            }
```

- [ ] **Step 4: Build and run the full sidecar test suite**

Run: `cd rust-core && cargo build -p sidecar && cargo test -p sidecar 2>&1 | tail -60`
Expected: PASS, zero warnings about unused `EnsureDayBackfillRequest`/`DayBackfillResponse` (they're still used inside `benchmark_window.rs`).

- [ ] **Step 5: Commit**

```bash
git add rust-core/crates/sidecar/src/main.rs
git commit -m "feat(sidecar): dispatch resolve_benchmark_window requests"
```

---

### Task 4: TypeScript — wire protocol types

**Files:**
- Modify: `electron-app/src/main/services/sidecar/sidecarProtocol.ts`

**Interfaces:**
- Produces: `ResolveBenchmarkWindowResponseWire`, and the `resolve_benchmark_window` entry in `SidecarRequestWire`, consumed by Task 5.

- [ ] **Step 1: Replace `DayBackfillResponseWire`**

Replace the whole `DayBackfillResponseWire` interface (lines 93-111) with:

```typescript
export interface ResolveBenchmarkWindowResponseWire {
  type: "benchmark_window";
  id: number;
  // The day the sidecar actually resolved and tested: UTC midnight of that
  // calendar day, Unix epoch seconds.
  from_ts: number;
  // Of the `need` bars this run wants, how many it can actually use around
  // the resolved day: bars at-or-before it capped at the lookback, plus bars
  // after it capped at the lookahead. Capped per side on purpose, so an
  // insufficient answer can never show have >= need whichever side is short.
  have: number;
  // The total bars this run needs before it can produce even one result: the
  // algorithm's own required_lookback plus the request's lookahead scoring
  // window -- not the bare registry lookback.
  need: number;
  sufficient: boolean;
  // The walk gave up because the archive had no file for CLOSED_DAY_LIMIT
  // weekdays running -- a different claim from "this symbol is only N days
  // old", and the sidecar always sends it, so it is required here too.
  archive_exhausted: boolean;
  error?: string;
}
```

- [ ] **Step 2: Update the two unions**

In `SidecarResponseWire` (lines 136-145), replace `| DayBackfillResponseWire;` with `| ResolveBenchmarkWindowResponseWire;`.

In `SidecarRequestWire` (lines 147-163), replace the trailing `ensure_day_backfill` member and its comment:

```typescript
  // `lookahead` is the requesting run's scoring window and `from_ts` the start
  // of the one day it will test. The sidecar needs both: it sizes against the
  // bars around THAT day -- required_lookback at-or-before it, lookahead after
  // it -- and total partition depth answers neither question.
  | { type: "ensure_day_backfill"; id: number; symbol: string; algo_id: string; lookahead: number; from_ts: number };
```

with:

```typescript
  // The sidecar resolves which day to test itself (P15§3) -- the caller
  // supplies only this run's scoring window (`lookahead`), not a day.
  | { type: "resolve_benchmark_window"; id: number; symbol: string; algo_id: string; lookahead: number };
```

- [ ] **Step 3: Compile-check (expected to fail — nothing else updated yet)**

Run: `cd electron-app && npx tsc --noEmit 2>&1 | head -40`
Expected: FAIL — `sidecarSupervisor.ts` still imports `DayBackfillResponseWire`. Confirm the errors are confined to that file before continuing; Task 5 fixes it.

- [ ] **Step 4: Commit**

```bash
git add electron-app/src/main/services/sidecar/sidecarProtocol.ts
git commit -m "feat(sidecar-protocol): rename the day-backfill wire contract to resolve_benchmark_window"
```

---

### Task 5: TypeScript — `SidecarSupervisor.resolveBenchmarkWindow`

**Files:**
- Modify: `electron-app/src/main/services/sidecar/sidecarSupervisor.ts`
- Test: `electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts`

**Interfaces:**
- Consumes: `ResolveBenchmarkWindowResponseWire` (Task 4).
- Produces: `SidecarSupervisor.resolveBenchmarkWindow(symbol: string, algoId: string, lookahead: number, onDayProgress?: (index: number, total: number) => void): Promise<ResolveBenchmarkWindowResponseWire>`, consumed by Task 6.

- [ ] **Step 1: Update the failing tests first**

In `sidecarSupervisor.test.ts`, replace the import of `DayBackfillResponseWire` with `ResolveBenchmarkWindowResponseWire`, and replace the 5 tests spanning lines 333-468 (`"sends an ensure_day_backfill request..."` through `"gives a backfill its own long timeout..."`) with:

```typescript
  it("sends a resolve_benchmark_window request and resolves the matching benchmark_window response", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.resolveBenchmarkWindow("NSE:ZYDUSWELL", "kronos", 5);

    const [request] = await requestsSeen;
    expect(request).toEqual({
      type: "resolve_benchmark_window",
      id: 1,
      symbol: "NSE:ZYDUSWELL",
      algo_id: "kronos",
      lookahead: 5,
    });

    children[0].stdout.write(
      `${JSON.stringify({
        type: "benchmark_window",
        id: 1,
        from_ts: SELECTED_DAY_TS,
        have: 8,
        need: 256,
        sufficient: false,
        archive_exhausted: false,
      })}\n`,
    );
    const response = await pending;
    expect(response.type).toBe("benchmark_window");
    expect(response.from_ts).toBe(SELECTED_DAY_TS);
    expect(response.have).toBe(8);
    expect(response.need).toBe(256);
    expect(response.sufficient).toBe(false);
    expect(response.archive_exhausted).toBe(false);
  });

  it("carries an archive_exhausted answer through unchanged", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.resolveBenchmarkWindow("NSE:ZYDUSWELL", "kronos", 0);
    await requestsSeen;

    children[0].stdout.write(
      `${JSON.stringify({
        type: "benchmark_window",
        id: 1,
        from_ts: SELECTED_DAY_TS,
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
    const pending = supervisor.resolveBenchmarkWindow("NSE:INFY", "kronos", 0, (index, total) => seen.push([index, total]));
    await requestsSeen;

    children[0].stdout.write(
      `${JSON.stringify({ type: "progress", id: 1, step: "backfill", status: "running", index: 1, total: 256 })}\n`,
    );
    // The request-level bracket carries no counts and must be ignored here.
    children[0].stdout.write(
      `${JSON.stringify({ type: "progress", id: 1, step: "resolve_benchmark_window", status: "running" })}\n`,
    );
    // A counted line belonging to some other in-flight request must not leak in.
    children[0].stdout.write(
      `${JSON.stringify({ type: "progress", id: 2, step: "backfill", status: "running", index: 99, total: 256 })}\n`,
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "progress", id: 1, step: "backfill", status: "running", index: 2, total: 256 })}\n`,
    );
    children[0].stdout.write(
      `${JSON.stringify({ type: "benchmark_window", id: 1, from_ts: SELECTED_DAY_TS, have: 256, need: 256, sufficient: true, archive_exhausted: false })}\n`,
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
    const pending = supervisor.resolveBenchmarkWindow("NSE:INFY", "kronos", 0, (index, total) => seen.push([index, total]));
    await requestsSeen;

    children[0].stdout.write(
      `${JSON.stringify({ type: "benchmark_window", id: 1, from_ts: SELECTED_DAY_TS, have: 1, need: 1, sufficient: true, archive_exhausted: false })}\n`,
    );
    await pending;
    children[0].stdout.write(
      `${JSON.stringify({ type: "progress", id: 1, step: "backfill", status: "running", index: 7, total: 9 })}\n`,
    );

    expect(seen).toEqual([]);
  });

  it("gives a backfill its own long timeout instead of the ordinary per-request one", async () => {
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

    const backfill = supervisor.resolveBenchmarkWindow("NSE:INFY", "kronos", 0); // id 1
    const ordinary = supervisor.benchmarkCompute("NSE:INFY", "day", "positional", [], "sma"); // id 2

    await expect(ordinary).rejects.toThrow(/timed out after 5ms/);
    children[0].stdout.write(
      `${JSON.stringify({ type: "benchmark_window", id: 1, from_ts: SELECTED_DAY_TS, have: 1, need: 1, sufficient: true, archive_exhausted: false })}\n`,
    );
    await expect(backfill).resolves.toMatchObject({ sufficient: true });
    expect(BACKFILL_REQUEST_TIMEOUT_MS).toBeGreaterThan(5);
  });
```

- [ ] **Step 2: Run to verify these fail**

Run: `cd electron-app && npx vitest run test/main/services/sidecar/sidecarSupervisor.test.ts 2>&1 | tail -40`
Expected: FAIL — `supervisor.resolveBenchmarkWindow is not a function`.

- [ ] **Step 3: Implement the method**

In `sidecarSupervisor.ts`, replace the `ensureDayBackfill` method and its leading comment (lines 159-177) with:

```typescript
  // `lookahead` is required rather than defaulted: the sidecar sizes the
  // fetch against the bars surrounding whichever day it resolves, and a
  // caller that silently got 0 would be back to a backfill that reports
  // success over a day the run cannot use.
  resolveBenchmarkWindow(
    symbol: string,
    algoId: string,
    lookahead: number,
    onDayProgress?: (index: number, total: number) => void,
  ): Promise<ResolveBenchmarkWindowResponseWire> {
    return this.send(
      { type: "resolve_benchmark_window", id: this.nextId, symbol, algo_id: algoId, lookahead },
      (id) => {
        if (onDayProgress) this.dayProgress.set(id, onDayProgress);
      },
      BACKFILL_REQUEST_TIMEOUT_MS,
    ) as Promise<ResolveBenchmarkWindowResponseWire>;
  }
```

Update the import at the top of the file from `DayBackfillResponseWire` to `ResolveBenchmarkWindowResponseWire`.

- [ ] **Step 4: Run to verify the tests pass**

Run: `cd electron-app && npx vitest run test/main/services/sidecar/sidecarSupervisor.test.ts 2>&1 | tail -40`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/sidecar/sidecarSupervisor.ts electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts
git commit -m "feat(sidecar-supervisor): rename ensureDayBackfill to resolveBenchmarkWindow"
```

---

### Task 6: TypeScript — split `runBenchmark` and resolve the bhavcopy window automatically

**Files:**
- Modify: `electron-app/src/main/services/benchmark/benchmarkRunner.ts`
- Test: `electron-app/test/main/services/benchmark/benchmarkRunner.test.ts`

**Interfaces:**
- Consumes: `SidecarSupervisor.resolveBenchmarkWindow` (Task 5).
- Produces: `BenchmarkRunRequest { symbol: string; timeframe: string; source: string; horizon: Horizon; algoId: string; requiredLookback: number }` (the new public input to `runBenchmark`), `runFrontierWalk(deps: FrontierWalkDeps, params: BenchmarkRunParams, onProgress?): Promise<BenchmarkResult>` (extracted, unchanged body, exported for direct testing) — both consumed by Task 7 (intraday path), Task 8 (bridge), Task 9 (UI).
- `BenchmarkRunParams` (existing type, fields unchanged) continues to be what `BenchmarkResult.params` carries.

This task has three parts: (A) extract `runFrontierWalk` and mechanically repoint the pure frontier-walk tests at it; (B) rewrite the backfill-preflight-specific tests for the new contract; (C) implement the new `runBenchmark`.

#### Part A — extract `runFrontierWalk`

- [ ] **Step 1: Add the narrower deps type and extract the function**

In `benchmarkRunner.ts`, add just above the existing `runBenchmark` export:

```typescript
type FrontierWalkDeps = { sidecar: Pick<SidecarSupervisor, "readLakeCandles" | "benchmarkCompute" | "evaluateScanGateStateless"> };
```

Rename the existing `runBenchmark` function to `runFrontierWalk`, change its second parameter's type from `BenchmarkRunParams` to `BenchmarkRunParams` (unchanged — it already is), its `deps` parameter's type from `BenchmarkRunnerDeps` to `FrontierWalkDeps`, and delete the backfill pre-flight block at the top of its body (the `if (params.timeframe === "day" && params.source === "bhavcopy") { ... }` block, lines 107-136) — that responsibility moves to the new `runBenchmark` in Part C. The function now starts directly with:

```typescript
export async function runFrontierWalk(
  deps: FrontierWalkDeps,
  params: BenchmarkRunParams,
  onProgress?: (progress: BenchmarkProgress) => void,
): Promise<BenchmarkResult> {
  const { candles } = await deps.sidecar.readLakeCandles(params.symbol, params.timeframe, params.source);
  // ...unchanged: the rest of the original function body, verbatim, through
  // its final `return { params, candles: series.slice(firstFrontier, candleEnd), decisionPoints, cancelled };`
}
```

- [ ] **Step 2: Mechanically repoint the pure frontier-walk tests**

In `benchmarkRunner.test.ts`, apply this exact two-part transform to each of the tests listed below: (1) change the call `runBenchmark(deps, baseParams({...}))` to `runFrontierWalk(deps, baseParams({...}))` (same arguments, unchanged); (2) delete the `ensureDayBackfill: ...` (or `backfillOk()`) entry from that test's `deps.sidecar` object literal, since `runFrontierWalk`'s `FrontierWalkDeps` type no longer has that field. Do not change any other line, value, or assertion in these tests — they test the frontier walk itself, which is byte-for-byte unchanged.

Example (the first one, in full, showing the exact transform):

```typescript
  it("positional session_close produces one decision point per eligible bar", async () => {
    const benchmarkCompute = vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH });
    const deps: FrontierWalkDeps = {
      sidecar: {
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12, 13, 14, 15, 16, 17]) }),
        benchmarkCompute,
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const result = await runFrontierWalk(deps, baseParams({ lookaheadBars: 3 }));
    expect(result.decisionPoints).toHaveLength(5);
    expect(benchmarkCompute).toHaveBeenCalledTimes(5);
    // ...(rest of the test's existing assertions, unchanged)
  });
```

Apply the identical transform (rename the call target to `runFrontierWalk`, retype the `deps` variable annotation to `FrontierWalkDeps`, delete the backfill mock field) to every test with these titles:

- "intraday stateless_gate cadence is gate-driven and threads prev/curr"
- "skips a zero/negative frontier close without a marker but keeps walking"
- "stops at the lookahead boundary with no out-of-range read"
- "wires classification exactly against the realized future close"
- "preserves partial results on a mid-run sidecar rejection"
- "propagates an initial readLakeCandles rejection instead of resolving empty"
- "invokes onProgress once per surviving loop iteration with the correct (index, total) pairs"
- "bounds onProgress's total to the eligible window, not the entire remaining lake series"
- "computes a window-start frontier against the lake history BEFORE fromTs, not a truncated window"
- "reports progress from zero at the window's first frontier, not from its lake index"
- "day-timeframe single-day window still scores an outcome using bars beyond toTs for lookahead"
- "tags cancelled=true and keeps only the pre-cancellation decision points on a cancellation-tagged rejection"
- "bounds result.candles past the LAST decision point's lookahead, not just the first, for a multi-decision-point stateless_gate run"
- "bounds result.candles to the selected day plus lookaheadBars, not the entire backfilled partition"

Also delete the now-unused `backfillOk()` helper function (lines 82-86) once no test references it (Part B below replaces its remaining callers with a `resolveOk()` helper).

- [ ] **Step 3: Run to verify these still pass**

Run: `cd electron-app && npx vitest run test/main/services/benchmark/benchmarkRunner.test.ts -t "frontier walk" 2>&1 | tail -60`
Expected: mixed — the 14 tests just repointed should PASS unchanged; the backfill-preflight tests (not yet touched) will FAIL to compile until Part B. Confirm specifically that the 14 listed tests pass.

#### Part B — rewrite the backfill-preflight tests

- [ ] **Step 4: Replace the backfill-preflight test block**

Replace the entire block of tests from `"returns an insufficientHistory result and never computes when the symbol's real history falls short"` through `"surfaces a backfill that failed outright as an error instead of a misleading history banner"` (original lines 411-670) with:

```typescript
function baseRequest(overrides: Partial<import("../../../../src/main/services/benchmark/benchmarkRunner").BenchmarkRunRequest> = {}) {
  return {
    symbol: "NSE:INFY",
    timeframe: "day",
    source: "bhavcopy",
    horizon: "positional" as const,
    algoId: "sma",
    requiredLookback: 20,
    ...overrides,
  };
}

function resolveOk(from_ts = 0, have = 10_000, need = 0) {
  return vi
    .fn()
    .mockResolvedValue({ type: "benchmark_window", id: 1, from_ts, have, need, sufficient: true, archive_exhausted: false });
}

describe("runBenchmark: resolving the bhavcopy window automatically", () => {
  it("returns an insufficientHistory result and never computes when the symbol's real history falls short", async () => {
    const benchmarkCompute = vi.fn();
    const readLakeCandles = vi.fn();
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        resolveBenchmarkWindow: vi.fn().mockResolvedValue({
          type: "benchmark_window",
          id: 1,
          from_ts: 1_000,
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

    const result = await runBenchmark(deps, baseRequest({ algoId: "kronos" }));

    expect(result.insufficientHistory).toEqual({ have: 8, need: 256, reason: "symbol_history" });
    expect(result.decisionPoints).toEqual([]);
    expect(result.candles).toEqual([]);
    expect(result.cancelled).toBe(false);
    // Nothing downstream of the pre-flight runs -- not even the lake read.
    expect(readLakeCandles).not.toHaveBeenCalled();
    expect(benchmarkCompute).not.toHaveBeenCalled();
  });

  it("sizes the pre-flight against the one selected algorithm and the horizon's default lookahead, and runs against the resolved day", async () => {
    const resolveBenchmarkWindow = resolveOk(1_000, 400);
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        resolveBenchmarkWindow,
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12, 13, 14, 15]) }),
        benchmarkCompute: vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH }),
        evaluateScanGateStateless: vi.fn(),
      },
    };

    const result = await runBenchmark(deps, baseRequest({ algoId: "kronos" }));

    expect(resolveBenchmarkWindow).toHaveBeenCalledTimes(1);
    expect(resolveBenchmarkWindow.mock.calls[0][0]).toBe("NSE:INFY");
    expect(resolveBenchmarkWindow.mock.calls[0][1]).toBe("kronos");
    // positional -> DEFAULT_POSITIONAL_LOOKAHEAD_BARS (5), never caller-supplied.
    expect(resolveBenchmarkWindow.mock.calls[0][2]).toBe(5);
    expect(result.insufficientHistory).toBeUndefined();
    expect(result.params.fromTs).toBe(1_000);
    expect(result.params.toTs).toBe(1_000 + DAY_SECONDS);
    expect(result.params.lookaheadBars).toBe(5);
    // N=6, L=5 -> eligible i in {0} only.
    expect(result.decisionPoints).toHaveLength(1);
  });

  it("skips the pre-flight entirely for a non-day timeframe, which has no bhavcopy source", async () => {
    const resolveBenchmarkWindow = resolveOk();
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        resolveBenchmarkWindow,
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12, 13, 14, 15, 16, 17]) }),
        benchmarkCompute: vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH }),
        evaluateScanGateStateless: vi.fn(),
      },
    };

    const result = await runBenchmark(deps, baseRequest({ timeframe: "minute", source: "kaggle", horizon: "positional", requiredLookback: 0 }));

    expect(resolveBenchmarkWindow).not.toHaveBeenCalled();
    // 8 candles, positional default lookahead 5 -> eligible i in {0,1,2}.
    expect(result.decisionPoints).toHaveLength(3);
  });

  it("skips the pre-flight for a day entry that is not bhavcopy-sourced, so it cannot verdict the wrong partition", async () => {
    // The live warm-up path writes ("day", "kite") partitions
    // (candleWarmup.ts's WARMUP_SOURCE, historicalDataArchive.ts's `day`
    // lookback hint) and they appear in the same picker. Resolving would
    // check ("day", "bhavcopy") while the run reads ("day", "kite") --
    // wasted fetches at best, a bogus insufficient-history verdict at worst.
    const resolveBenchmarkWindow = resolveOk();
    const readLakeCandles = vi
      .fn()
      .mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12, 13, 14, 15, 16, 17]) });
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        resolveBenchmarkWindow,
        readLakeCandles,
        benchmarkCompute: vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH }),
        evaluateScanGateStateless: vi.fn(),
      },
    };

    const result = await runBenchmark(deps, baseRequest({ timeframe: "day", source: "kite", requiredLookback: 0 }));

    expect(resolveBenchmarkWindow).not.toHaveBeenCalled();
    expect(readLakeCandles).toHaveBeenCalledWith("NSE:INFY", "day", "kite");
    expect(result.insufficientHistory).toBeUndefined();
    expect(result.decisionPoints).toHaveLength(3);
  });

  it("reports an exhausted archive as its own reason instead of blaming the symbol's history", async () => {
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        resolveBenchmarkWindow: vi.fn().mockResolvedValue({
          type: "benchmark_window",
          id: 1,
          from_ts: 1_000,
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

    const result = await runBenchmark(deps, baseRequest({ algoId: "kronos" }));

    expect(result.insufficientHistory).toEqual({ have: 41, need: 256, reason: "archive_unreachable" });
    expect(result.cancelled).toBe(false);
  });

  it("reports backfill progress as its own phase before the frontier walk's", async () => {
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        resolveBenchmarkWindow: vi.fn().mockImplementation((_symbol: string, _algoId: string, _lookahead: number, onDay?: (i: number, t: number) => void) => {
          onDay?.(1, 2);
          onDay?.(2, 2);
          return Promise.resolve({ type: "benchmark_window", id: 1, from_ts: 1_000, have: 2, need: 2, sufficient: true, archive_exhausted: false });
        }),
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12, 13, 14, 15]) }),
        benchmarkCompute: vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH }),
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const progress: Array<[string, number, number]> = [];

    await runBenchmark(deps, baseRequest(), (p) => progress.push([p.phase, p.index, p.total]));

    // N=6, L=5 (positional default) -> eligible frontiers i in {0}.
    expect(progress).toEqual([
      ["backfill", 1, 2],
      ["backfill", 2, 2],
      ["run", 0, 1],
    ]);
  });

  it("tags a cancellation during the pre-flight as cancelled rather than throwing", async () => {
    const readLakeCandles = vi.fn();
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        resolveBenchmarkWindow: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error("sidecar run cancelled"), { cancelled: true })),
        readLakeCandles,
        benchmarkCompute: vi.fn(),
        evaluateScanGateStateless: vi.fn(),
      },
    };

    const result = await runBenchmark(deps, baseRequest());

    expect(result.cancelled).toBe(true);
    expect(result.insufficientHistory).toBeUndefined();
    expect(readLakeCandles).not.toHaveBeenCalled();
  });

  it("surfaces a backfill that failed outright as an error instead of a misleading history banner", async () => {
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        resolveBenchmarkWindow: vi.fn().mockResolvedValue({
          type: "benchmark_window",
          id: 1,
          from_ts: 1_000,
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

    await expect(runBenchmark(deps, baseRequest())).rejects.toThrow(/HTTP 503/);
  });

  it("a thin lake backfilled around the resolved day yields a real decision point for that day", async () => {
    // The reported incident, to scale, reached with no caller-supplied day at
    // all: a thin lake, a deep algorithm, and the sidecar resolving its own
    // candidate. This test only needs to confirm runBenchmark plumbs the
    // resolved from_ts/toTs into the frontier walk correctly -- benchmark_window.rs's
    // own Rust tests (Task 2) cover the candidate-picking arithmetic itself.
    const lookahead = 5;
    const fromTs = 1_700_000_000;
    const toTs = fromTs + DAY_SECONDS;
    const candles = seriesOf([10, 11, 12, 13, 14, 15, 16]).map((c, i) => ({ ...c, ts: fromTs + (i - 1) * DAY_SECONDS }));
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        resolveBenchmarkWindow: vi.fn().mockResolvedValue({
          type: "benchmark_window",
          id: 1,
          from_ts: fromTs,
          have: 20 + lookahead,
          need: 20 + lookahead,
          sufficient: true,
          archive_exhausted: false,
        }),
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles }),
        benchmarkCompute: vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH }),
        evaluateScanGateStateless: vi.fn(),
      },
    };

    const result = await runBenchmark(deps, baseRequest({ algoId: "kronos", requiredLookback: 20 }));

    expect(result.params.fromTs).toBe(fromTs);
    expect(result.params.toTs).toBe(toTs);
    expect(result.insufficientHistory).toBeUndefined();
    // Exactly the candle at ts===fromTs is the one frontier inside [fromTs, toTs).
    expect(result.decisionPoints.map((p) => p.ts)).toEqual([fromTs]);
  });
});
```

Also delete the old `backfillOk` helper (superseded by `resolveOk`) and change the `deps: BenchmarkRunnerDeps` type annotations on tests still using the full `runBenchmark` path — those are exactly the ones in this new block, already annotated correctly above.

- [ ] **Step 5: Run to verify this block fails to compile (implementation not written yet)**

Run: `cd electron-app && npx vitest run test/main/services/benchmark/benchmarkRunner.test.ts 2>&1 | tail -40`
Expected: FAIL — `runBenchmark` still has the old signature (`BenchmarkRunParams`, not `BenchmarkRunRequest`), and `deps.sidecar` has no `resolveBenchmarkWindow` in its `Pick<...>`.

#### Part C — implement the new `runBenchmark`

- [ ] **Step 6: Add the new request type and `BenchmarkRunnerDeps`**

Add, near the top of the file next to `NEUTRAL_BAND`:

```typescript
// `fromDate` (formerly BenchmarkView.tsx, now unused there -- see Task 9) yields
// UTC midnight of a calendar day; `day_backfill.rs` derives a resolved day's
// partition as `[from_ts, from_ts + DAY_SECONDS)`. Changing this without
// changing that file reopens the boundary bug fix round 3 of this subsystem
// existed to close.
const DAY_SECONDS = 86_400;
```

Add, near the existing `BenchmarkRunParams` interface:

```typescript
export interface BenchmarkRunRequest {
  symbol: string;
  timeframe: string;
  source: string;
  horizon: Horizon;
  algoId: string;
  // Needed only by the non-bhavcopy path (Task 7), which has no backend
  // resolution to lean on and must judge sufficiency from data already in
  // hand.
  requiredLookback: number;
}
```

Change `BenchmarkRunnerDeps` (existing, currently `Pick<SidecarSupervisor, "readLakeCandles" | "benchmarkCompute" | "evaluateScanGateStateless" | "ensureDayBackfill">`) to:

```typescript
export interface BenchmarkRunnerDeps {
  sidecar: Pick<
    SidecarSupervisor,
    "readLakeCandles" | "benchmarkCompute" | "evaluateScanGateStateless" | "resolveBenchmarkWindow"
  >;
}
```

- [ ] **Step 7: Implement `runBenchmark`**

Add, in place of the old combined function (now that `runFrontierWalk` holds the walk logic), a new `runBenchmark` that only handles the bhavcopy path for now (Task 7 adds the `else` branch for everything else):

```typescript
export async function runBenchmark(
  deps: BenchmarkRunnerDeps,
  request: BenchmarkRunRequest,
  onProgress?: (progress: BenchmarkProgress) => void,
): Promise<BenchmarkResult> {
  const lookaheadBars = defaultLookaheadForHorizon(request.horizon);

  // Bhavcopy is the one on-demand source this app has, and it is day-only
  // (P14§1) -- only this path has a backend that can resolve a day for it.
  if (request.timeframe === "day" && request.source === "bhavcopy") {
    let window;
    try {
      window = await deps.sidecar.resolveBenchmarkWindow(request.symbol, request.algoId, lookaheadBars, (index, total) =>
        onProgress?.({ phase: "backfill", index, total }),
      );
    } catch (error) {
      if ((error as { cancelled?: boolean }).cancelled !== true) throw error;
      return { params: { ...request, lookaheadBars, fromTs: 0, toTs: 0 }, candles: [], decisionPoints: [], cancelled: true };
    }
    if (window.error && !window.sufficient) {
      throw new Error(`backfill failed for ${request.symbol}: ${window.error}`);
    }
    if (window.error) {
      console.error(`benchmark: backfill for ${request.symbol} reported: ${window.error}`);
    }
    const params: BenchmarkRunParams = { ...request, lookaheadBars, fromTs: window.from_ts, toTs: window.from_ts + DAY_SECONDS };
    if (!window.sufficient) {
      return {
        params,
        candles: [],
        decisionPoints: [],
        cancelled: false,
        insufficientHistory: {
          have: window.have,
          need: window.need,
          reason: window.archive_exhausted ? "archive_unreachable" : "symbol_history",
        },
      };
    }
    return runFrontierWalk(deps, params, onProgress);
  }

  throw new Error(`unsupported benchmark source: ${request.timeframe}/${request.source}`); // Task 7 replaces this
}
```

- [ ] **Step 8: Run to verify the bhavcopy-path tests pass, and the non-bhavcopy ones intentionally still fail**

Run: `cd electron-app && npx vitest run test/main/services/benchmark/benchmarkRunner.test.ts 2>&1 | tail -60`
Expected: the 9 tests in the new `"runBenchmark: resolving the bhavcopy window automatically"` block that exercise `timeframe: "day", source: "bhavcopy"` PASS; `"skips the pre-flight entirely for a non-day timeframe..."` FAILS (throws the placeholder error) — expected, Task 7 fixes it. All 14 `runFrontierWalk` tests from Part A PASS.

- [ ] **Step 9: Commit**

```bash
git add electron-app/src/main/services/benchmark/benchmarkRunner.ts electron-app/test/main/services/benchmark/benchmarkRunner.test.ts
git commit -m "$(cat <<'EOF'
feat(benchmark): resolve the bhavcopy test day automatically

Splits runBenchmark into a thin resolver and the existing frontier walk
(runFrontierWalk, extracted unchanged). The caller no longer supplies
fromTs/toTs/lookaheadBars for the bhavcopy path -- lookahead comes from
the horizon default and the day comes from the sidecar's new
resolve_benchmark_window response. Non-bhavcopy sources are handled next.
EOF
)"
```

---

### Task 7: TypeScript — non-bhavcopy sources use their full available window

**Files:**
- Modify: `electron-app/src/main/services/benchmark/benchmarkRunner.ts`
- Test: `electron-app/test/main/services/benchmark/benchmarkRunner.test.ts`

**Interfaces:**
- Consumes: `runFrontierWalk`, `BenchmarkRunRequest` (Task 6).

- [ ] **Step 1: Fix the two non-bhavcopy tests to match the new (correct) expectations**

Both tests already exist from Task 6 Part B and currently expect the OLD caller-supplied-window behavior. Update them:

`"skips the pre-flight entirely for a non-day timeframe, which has no bhavcopy source"` — no change needed; it already asserts `resolveBenchmarkWindow` was not called and that 8 candles with a positional default lookahead of 5 yield 3 decision points, which is what Step 2 below will produce (the full 8-candle partition becomes the window; window bounds no longer come from caller-supplied `fromTs`/`toTs`, which this request no longer has).

`"skips the pre-flight for a day entry that is not bhavcopy-sourced..."` — no change needed for the same reason.

- [ ] **Step 2: Run to confirm both still fail (the `else` branch isn't implemented yet)**

Run: `cd electron-app && npx vitest run test/main/services/benchmark/benchmarkRunner.test.ts -t "skips the pre-flight" 2>&1 | tail -30`
Expected: FAIL — `runBenchmark` still throws the Task 6 Step 7 placeholder for non-bhavcopy sources.

- [ ] **Step 3: Add a test for the insufficient-local-data case**

Add to the `"runBenchmark: resolving the bhavcopy window automatically"` describe block (despite the name, this is the natural home — rename the describe block to `"runBenchmark"` to reflect that it now covers both paths):

```typescript
  it("reports insufficient history for a non-bhavcopy source using only local data, with no fetch attempted", async () => {
    const resolveBenchmarkWindow = vi.fn();
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        resolveBenchmarkWindow,
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12]) }),
        benchmarkCompute: vi.fn(),
        evaluateScanGateStateless: vi.fn(),
      },
    };

    const result = await runBenchmark(deps, baseRequest({ timeframe: "minute", source: "kaggle", requiredLookback: 20 }));

    expect(resolveBenchmarkWindow).not.toHaveBeenCalled();
    // 3 candles, requiredLookback 20 + positional default lookahead 5 = 25 needed.
    expect(result.insufficientHistory).toEqual({ have: 3, need: 25, reason: "symbol_history" });
    expect(result.decisionPoints).toEqual([]);
  });
```

- [ ] **Step 4: Implement the non-bhavcopy branch**

In `benchmarkRunner.ts`, replace the placeholder `throw new Error(...)` at the end of `runBenchmark` with:

```typescript
  // Non-bhavcopy sources (intraday/community-archive) have no on-demand
  // backfill (P14§1) -- the whole available partition is the run's window,
  // and sufficiency is a pure local-data question (P15 scope addendum: no
  // date field means no reason left to arbitrarily chunk to one day here).
  const { candles: full } = await deps.sidecar.readLakeCandles(request.symbol, request.timeframe, request.source);
  const params: BenchmarkRunParams = {
    ...request,
    lookaheadBars,
    fromTs: full[0]?.ts ?? 0,
    toTs: (full[full.length - 1]?.ts ?? 0) + 1,
  };
  const need = request.requiredLookback + lookaheadBars;
  if (full.length < need) {
    return {
      params,
      candles: [],
      decisionPoints: [],
      cancelled: false,
      insufficientHistory: { have: full.length, need, reason: "symbol_history" },
    };
  }
  return runFrontierWalk(deps, params, onProgress);
```

- [ ] **Step 5: Run the full file to verify everything passes**

Run: `cd electron-app && npx vitest run test/main/services/benchmark/benchmarkRunner.test.ts 2>&1 | tail -80`
Expected: PASS — every test in the file.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/services/benchmark/benchmarkRunner.ts electron-app/test/main/services/benchmark/benchmarkRunner.test.ts
git commit -m "feat(benchmark): give non-bhavcopy sources their full available window instead of an arbitrary caller-supplied day"
```

---

### Task 8: TypeScript — bridge and renderer API types

**Files:**
- Modify: `electron-app/src/main/ipc/benchmarkBridge.ts`
- Modify: `electron-app/src/main/ipc/rendererApi.ts`
- Test: `electron-app/test/main/ipc/benchmarkBridge.test.ts`

**Interfaces:**
- Consumes: `BenchmarkRunRequest`, `runBenchmark` (Task 7).
- Produces: IPC channel `benchmark:runBenchmark` now accepts `BenchmarkRunRequest` instead of `BenchmarkRunParams`, consumed by Task 9 (UI).

- [ ] **Step 1: Update the failing tests first**

In `benchmarkBridge.test.ts`:

Replace `idleSidecar()`'s `ensureDayBackfill` field with:

```typescript
    resolveBenchmarkWindow: vi.fn().mockResolvedValue({
      type: "benchmark_window",
      id: 1,
      from_ts: 0,
      have: 10_000,
      need: 0,
      sufficient: true,
      archive_exhausted: false,
    }),
```

and rename the `ensureDayBackfill: ReturnType<typeof vi.fn>;` field in the `harness()` parameter type to `resolveBenchmarkWindow: ReturnType<typeof vi.fn>;`.

In `"forwards params to runBenchmark with the injected sidecar and returns its BenchmarkResult"` (line 96), replace the `params` object with the new request shape and update the assertion:

```typescript
    const params = {
      symbol: "NSE:INFY",
      timeframe: "day",
      source: "bhavcopy",
      horizon: "positional",
      algoId: "sma",
      requiredLookback: 20,
    };
    const result = (await handlers.get("benchmark:runBenchmark")!(fakeEvent(), params)) as { params: unknown; decisionPoints: unknown[] };
    expect(sidecar.readLakeCandles).toHaveBeenCalledWith("NSE:INFY", "day", "bhavcopy");
    expect(result.params).toEqual({ ...params, lookaheadBars: 5, fromTs: 0, toTs: 86_400 });
    expect(result.decisionPoints).toHaveLength(0);
```

In `"forwards per-bar progress to the requesting window..."` (line 117), replace its `params` object with:

```typescript
    const params = {
      symbol: "NSE:INFY",
      timeframe: "day",
      source: "bhavcopy",
      horizon: "positional",
      algoId: "sma",
      requiredLookback: 0,
    };
    await handlers.get("benchmark:runBenchmark")!(event, params);
    // series has 2 bars, positional default lookahead 5 -> no eligible frontier at all.
```

and change its final assertion, since a 2-bar series can no longer produce a frontier once lookahead defaults to 5 (it needs a real, non-trivial example): replace the mocked candles with 6 bars and expect `{ phase: "run", index: 0, total: 1 }`:

```typescript
    sidecar.readLakeCandles.mockResolvedValue({
      type: "lake_candles",
      id: 1,
      candles: [
        { ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { ts: 2, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { ts: 3, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { ts: 4, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { ts: 5, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { ts: 6, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      ],
    });
    // ...
    expect(event.sender.send).toHaveBeenCalledWith("benchmark:progress", { phase: "run", index: 0, total: 1 });
```

- [ ] **Step 2: Run to verify these fail**

Run: `cd electron-app && npx vitest run test/main/ipc/benchmarkBridge.test.ts 2>&1 | tail -40`
Expected: FAIL — `sidecar.resolveBenchmarkWindow` doesn't exist on the mock's type yet used by real code; `registerBenchmarkBridge`'s deps `Pick<...>` still says `ensureDayBackfill`.

- [ ] **Step 3: Update `benchmarkBridge.ts`**

Change the `BenchmarkBridgeDeps.sidecar` `Pick<...>` list's `"ensureDayBackfill"` entry to `"resolveBenchmarkWindow"`, and change the `benchmark:runBenchmark` handler's parameter type from `BenchmarkRunParams` to `BenchmarkRunRequest`:

```typescript
import type { AlgorithmEntry, BenchmarkRunRequest, LakeSymbolEntry } from "./rendererApi";
```

```typescript
  deps.ipcMain.handle("benchmark:runBenchmark", (event, params: BenchmarkRunRequest) =>
    runBenchmark({ sidecar: deps.sidecar }, params, (progress) => event.sender.send("benchmark:progress", progress)),
  );
```

- [ ] **Step 4: Update `rendererApi.ts`**

Change the re-export line:

```typescript
export type { BenchmarkCadence, Outcome, DecisionPoint, BenchmarkRunParams, BenchmarkResult, BenchmarkProgress } from "../services/benchmark/benchmarkRunner";
import type { BenchmarkProgress, BenchmarkRunParams, BenchmarkResult } from "../services/benchmark/benchmarkRunner";
```

to:

```typescript
export type { BenchmarkCadence, Outcome, DecisionPoint, BenchmarkRunRequest, BenchmarkRunParams, BenchmarkResult, BenchmarkProgress } from "../services/benchmark/benchmarkRunner";
import type { BenchmarkProgress, BenchmarkRunRequest, BenchmarkResult } from "../services/benchmark/benchmarkRunner";
```

Change `RendererApi.runBenchmark`'s parameter type:

```typescript
  runBenchmark(params: BenchmarkRunRequest): Promise<BenchmarkResult>;
```

and the corresponding line in `buildRendererApi`'s returned object (`runBenchmark: (params) => invoke(...)`) needs no change — its parameter is inferred from the interface.

- [ ] **Step 5: Run to verify tests pass and the whole project typechecks**

Run: `cd electron-app && npx vitest run test/main/ipc/benchmarkBridge.test.ts 2>&1 | tail -40 && npx tsc --noEmit 2>&1 | tail -60`
Expected: vitest PASS; `tsc` errors should now be confined to `BenchmarkView.tsx` (Task 9 fixes it) — confirm that before continuing.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/ipc/benchmarkBridge.ts electron-app/src/main/ipc/rendererApi.ts electron-app/test/main/ipc/benchmarkBridge.test.ts
git commit -m "feat(benchmark-bridge): accept BenchmarkRunRequest instead of a caller-assembled BenchmarkRunParams"
```

---

### Task 9: UI — remove the date/lookahead fields, add greying-out and a resolved-date caption

**Files:**
- Modify: `electron-app/src/renderer/BenchmarkView.tsx`
- Test: `electron-app/test/renderer/BenchmarkView.test.tsx`

**Interfaces:**
- Consumes: `BenchmarkRunRequest`, `BenchmarkResult` (Task 8).

- [ ] **Step 1: Update the test file's fixtures and delete obsolete tests**

In `BenchmarkView.test.tsx`:

- Delete the `BACKFILLED_ENTRY` fixture and both tests that reference it (`"displays the picker list's first-seen extent..."` stays — it does not depend on the date field — but `"seeds the default benchmark date from the first-seen extent..."` is deleted entirely, since there is no longer a default date to seed).
- Delete `"prefills the lookahead default and the single date field on selection"` entirely (no such fields exist anymore).
- Delete `"shows a validation error instead of calling runBenchmark when the date field is cleared"` entirely (no date field to clear).
- Update `resultWith()`'s `params` literal (line 63) to drop nothing (the shape is unchanged — `BenchmarkRunParams` still has `fromTs`/`toTs`/`lookaheadBars`, just now always sidecar-resolved) but change its `fromTs` to a nonzero value so the new "Tested" caption (Step 4 below) has something to render:

```typescript
    params: { symbol: "NSE:INFY", timeframe: "day", source: "bhavcopy", horizon: "positional", algoId: "sma", lookaheadBars: 5, fromTs: 1_700_000_000, toTs: 1_700_086_400 },
```

- Update `"runs the benchmark with the assembled params including the selected algorithm and single-day window"` (line 143) — rename it to reflect the new contract and replace its body:

```typescript
  it("runs the benchmark with the selected symbol and algorithm, no date or lookahead supplied", async () => {
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(resultWith([])) });
    render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    await waitFor(() => expect(deps.runBenchmark).toHaveBeenCalledTimes(1));
    expect(deps.runBenchmark.mock.calls[0][0]).toEqual({
      symbol: "NSE:INFY",
      timeframe: "day",
      source: "bhavcopy",
      horizon: "positional",
      algoId: "sma",
      requiredLookback: 20,
    });
  });
```

- Update the two insufficient-history banner tests to expect the new plain-sentence copy:

```typescript
  it("renders one insufficient-history banner in place of the summary strip and chart", async () => {
    const insufficient: BenchmarkResult = {
      params: { symbol: "NSE:ZYDUSWELL", timeframe: "day", source: "bhavcopy", horizon: "positional", algoId: "kronos", lookaheadBars: 5, fromTs: 0, toTs: 0 },
      candles: [],
      decisionPoints: [],
      cancelled: false,
      insufficientHistory: { have: 8, need: 256, reason: "symbol_history" },
    };
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(insufficient) });
    const { container } = render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));

    await waitFor(() => expect(container.textContent).toContain("NSE:ZYDUSWELL doesn't have enough trading history for this test."));
    expect(container.textContent).toContain("Try a different stock.");
    expect(container.textContent).not.toMatch(/archive/i);
    expect(container.textContent).not.toContain("256");
    expect(screen.queryByText(/0 decision points/i)).toBeNull();
    expect(screen.queryByText(/copy raw result/i)).toBeNull();
  });

  it("says the archive could not be reached, not that the symbol is young, when the walk hit the closed-day cap", async () => {
    const unreachable: BenchmarkResult = {
      params: { symbol: "NSE:ZYDUSWELL", timeframe: "day", source: "bhavcopy", horizon: "positional", algoId: "kronos", lookaheadBars: 5, fromTs: 0, toTs: 0 },
      candles: [],
      decisionPoints: [],
      cancelled: false,
      insufficientHistory: { have: 41, need: 256, reason: "archive_unreachable" },
    };
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(unreachable) });
    const { container } = render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));

    await waitFor(() => expect(container.textContent).toContain("Couldn't reach far enough back for NSE:ZYDUSWELL right now."));
    expect(container.textContent).toContain("Try again in a bit.");
    expect(container.textContent).not.toContain("doesn't have enough trading history");
    expect(container.textContent).not.toContain("41");
    expect(screen.queryByText(/copy raw result/i)).toBeNull();
  });
```

- Add two new tests for greying-out and the "run another test" affordance:

```typescript
  it("greys out a symbol for the current algorithm after it is proven to lack enough history, and re-enables it under a different algorithm", async () => {
    const insufficient: BenchmarkResult = {
      params: { symbol: "NSE:INFY", timeframe: "day", source: "bhavcopy", horizon: "positional", algoId: "kronos", lookaheadBars: 5, fromTs: 0, toTs: 0 },
      candles: [],
      decisionPoints: [],
      cancelled: false,
      insufficientHistory: { have: 8, need: 256, reason: "symbol_history" },
    };
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(insufficient) });
    render(<BenchmarkView api={deps} />);
    fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^kronos/i }));
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    await waitFor(() => expect(deps.runBenchmark).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: /run another test/i }));
    const option = await screen.findByRole("button", { name: /NSE:INFY/ });
    expect(option).toHaveProperty("disabled", true);
    expect(option.textContent).toMatch(/not enough history/i);

    fireEvent.click(option); // still clickable in the sense of re-selecting isn't needed; algo switch alone re-enables it
    fireEvent.click(await screen.findByRole("button", { name: /^sma/i }));
    const optionUnderSma = await screen.findByRole("button", { name: /NSE:INFY/ });
    expect(optionUnderSma).toHaveProperty("disabled", false);
  });

  it("does not grey out a symbol after a transient archive-unreachable result", async () => {
    const unreachable: BenchmarkResult = {
      params: { symbol: "NSE:INFY", timeframe: "day", source: "bhavcopy", horizon: "positional", algoId: "kronos", lookaheadBars: 5, fromTs: 0, toTs: 0 },
      candles: [],
      decisionPoints: [],
      cancelled: false,
      insufficientHistory: { have: 41, need: 256, reason: "archive_unreachable" },
    };
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(unreachable) });
    render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    await waitFor(() => expect(deps.runBenchmark).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: /run another test/i }));
    const option = await screen.findByRole("button", { name: /NSE:INFY/ });
    expect(option).toHaveProperty("disabled", false);
  });

  it("shows the resolved test date after a successful run", async () => {
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(resultWith([])) });
    render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    expect(await screen.findByText(/tested 2023-11-14/i)).toBeTruthy();
  });
```

(`fromTs: 1_700_000_000` in `resultWith()` is `2023-11-14T22:13:20.000Z`; `toDate()` truncates to the date portion, `"2023-11-14"` — confirm this matches what `toDate` actually produces once Step 4 is implemented, and adjust the expected string if the truncation lands on a different UTC day.)

- [ ] **Step 2: Run to verify the whole file now fails to compile/run against the current component**

Run: `cd electron-app && npx vitest run test/renderer/BenchmarkView.test.tsx 2>&1 | tail -60`
Expected: FAIL — the component still has the date/lookahead fields and old copy.

- [ ] **Step 3: Remove the date and lookahead fields, and the now-dead `fromDate` helper**

In `BenchmarkView.tsx`:

- Delete the `fromDate` function (lines 25-27) — no longer called anywhere once the date field is gone.
- Delete the `DAY_SECONDS` constant and its preceding boundary-encoding comment (lines 29-34) — its only use was `onRun`'s `toTs: dayStart + DAY_SECONDS` (line 201), which is being replaced below. That invariant now lives in `benchmarkRunner.ts` (Task 6 Part C), which is where the day-window arithmetic actually happens now.
- Remove the `lookaheadBars`/`setLookaheadBars` and `date`/`setDate` state (lines 143-144).
- In `onSelectEntry` (lines 175-180), remove the `setLookaheadBars(...)` and `setDate(...)` calls:

```typescript
  const onSelectEntry = (entry: LakeSymbolEntry): void => {
    setSelected(entry);
    setResult(null);
  };
```

- Delete the `Lookahead bars` `<label>` block (lines 298-301) and the `Date` `<label>` block (lines 302-318) from the form.
- Rewrite `onRun` to build a `BenchmarkRunRequest` and record known-insufficient pairs:

```typescript
  const onRun = async (): Promise<void> => {
    if (!selected || !selectedAlgoId) return;
    const algo = algorithms?.find((a) => a.id === selectedAlgoId);
    setRunning(true);
    setError(null);
    setProgress(null);
    try {
      const run = await api.runBenchmark({
        symbol: selected.symbol,
        timeframe: selected.timeframe,
        source: selected.source,
        horizon: selected.horizon,
        algoId: selectedAlgoId,
        requiredLookback: algo?.requiredLookback ?? 0,
      });
      if (run.insufficientHistory?.reason === "symbol_history") {
        setInsufficientPairs((prev) => new Set(prev).add(`${selected.symbol}:${selectedAlgoId}`));
      }
      setResult(run);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };
```

- [ ] **Step 4: Add the greyed-out state and the "run another test" affordance**

Add new state near the other `useState` calls:

```typescript
  const [insufficientPairs, setInsufficientPairs] = useState<Set<string>>(new Set());
```

In the symbol picker's `<li>` rendering (lines 255-268), disable and annotate a known-insufficient entry:

```typescript
          <ul className="benchmark-picker">
            {entries.map((entry) => {
              const isKnownInsufficient = selectedAlgoId !== null && insufficientPairs.has(`${entry.symbol}:${selectedAlgoId}`);
              return (
                <li key={`${entry.symbol}_${entry.timeframe}_${entry.source}`}>
                  <button
                    type="button"
                    className={`benchmark-picker-item${selected === entry ? " benchmark-picker-item-selected" : ""}`}
                    aria-pressed={selected === entry}
                    disabled={isKnownInsufficient}
                    onClick={() => onSelectEntry(entry)}
                  >
                    {entry.symbol} · {entry.timeframe} · {entry.source} · {entry.horizon} · {toDate(entry.firstSeenFromTs)}–{toDate(entry.firstSeenToTs)} · {entry.firstSeenCandleCount} bars
                    {isKnownInsufficient && " · not enough history for this test"}
                  </button>
                </li>
              );
            })}
          </ul>
```

Add a "Run another test" button, rendered whenever a result exists, just above the `{result ? (...) : (...)}` block:

```typescript
      {result && (
        <Button type="button" variant="ghost" onClick={() => setResult(null)}>
          ← Run another test
        </Button>
      )}
      {result ? (
```

- [ ] **Step 5: Rewrite `InsufficientHistory` and add the resolved-date caption**

Replace the `InsufficientHistory` component:

```typescript
function InsufficientHistory({ result }: { result: BenchmarkResult }): JSX.Element {
  const reason = result.insufficientHistory?.reason ?? "symbol_history";
  if (reason === "archive_unreachable") {
    return (
      <Banner variant="warning">
        Couldn't reach far enough back for {result.params.symbol} right now. Try again in a bit.
      </Banner>
    );
  }
  return (
    <Banner variant="info">
      {result.params.symbol} doesn't have enough trading history for this test. Try a different stock.
    </Banner>
  );
}
```

In `ResultsView`, add the resolved-date caption right after the opening `<div className="benchmark-results">` (before `{result.cancelled && ...}`):

```typescript
      <p className="benchmark-tested-date">Tested {toDate(result.params.fromTs)}</p>
```

- [ ] **Step 6: Run to verify everything passes**

Run: `cd electron-app && npx vitest run test/renderer/BenchmarkView.test.tsx 2>&1 | tail -80`
Expected: PASS — every test in the file. If the "shows the resolved test date" assertion's expected date string doesn't match (per the note in Step 1), fix the expected string to whatever `toDate(1_700_000_000)` actually produces — do not change `toDate` itself.

- [ ] **Step 7: Full typecheck across the whole app**

Run: `cd electron-app && npx tsc --noEmit 2>&1 | tail -60`
Expected: clean, no errors.

- [ ] **Step 8: Commit**

```bash
git add electron-app/src/renderer/BenchmarkView.tsx electron-app/test/renderer/BenchmarkView.test.tsx
git commit -m "$(cat <<'EOF'
feat(benchmark-ui): remove manual date/lookahead fields; grey out proven-insufficient symbols

Picking a symbol and an algorithm is now enough to run. A symbol proven
to lack enough history for the selected algorithm greys out in the
picker (per-algorithm, session-only); a transient archive-unreachable
result never does. A "Run another test" control makes the picker (and
that greyed state) reachable again after a result, which previously
had no way back.
EOF
)"
```

---

### Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full Rust test suite**

Run: `cd rust-core && cargo test 2>&1 | tail -80`
Expected: PASS, zero failures, zero warnings about the renamed items.

- [ ] **Step 2: Run the full Electron/TypeScript test suite**

Run: `cd electron-app && npx vitest run 2>&1 | tail -100`
Expected: PASS, zero failures.

- [ ] **Step 3: Full typecheck**

Run: `cd electron-app && npx tsc --noEmit 2>&1 | tail -60`
Expected: clean.

- [ ] **Step 4: Manual smoke check (per this repo's convention of testing UI changes live, not just via unit tests)**

Start the app (however this project's existing dev-run flow works — check for a `run` skill or `package.json` dev script), open the Benchmark tab, pick a thin symbol and a deep algorithm (e.g. `garch` or `kronos`) and confirm: no date or lookahead field is visible; Run is enabled as soon as an algorithm is picked; a genuinely-insufficient combination shows one plain sentence with no numbers; going back via "Run another test" shows that symbol greyed out with a short note; picking a different algorithm re-enables it; a working combination shows a "Tested <date>" caption near the results.

- [ ] **Step 5: If everything is green, no further commit is needed** — Tasks 1-9 already committed incrementally.
