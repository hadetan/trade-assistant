# Phase 5d — Settings Window + Proactive Scan Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in, tray-resident proactive scanning — a deterministic Rust gate (`scan_gate.rs`) decides whether each scan tick is a no-op, a deterministic "worth a look," or worth spending a real Claude call — plus a dedicated Settings window (scan on/off, interval, watchlist, read-only account status). The scheduler reuses the exact `assembleEnvelope` / `generateDeterministicResponse` / `ClaudeCliProvider.completeAiAssisted` / `HistoryStore` machinery Phases 5a–5c already built; it adds no Kite write capability and no new Claude tool grant. Once done, Phase 5 is complete.

**Architecture:** Rust owns the gate's memory: `StateStore` gains a `scan_snapshots` last-observation table and a pure `algo_core::scan_gate::evaluate_scan_gate` function (`gate_delta = max(|Δweighted_vote|, |Δnet_count_ratio|)`, thresholds 0.10/0.25). The sidecar exposes four new panic-isolated request variants (`AddWatchlistSymbol`/`RemoveWatchlistSymbol`/`ListWatchlist`/`EvaluateScanGate`) mirrored into TypeScript. Electron-main gains `ScanScheduler` (an in-process timer that, per tick, re-resolves each watchlist symbol's live instrument fresh from Kite — never a cached token — fetches/computes via the existing envelope path, calls the gate, and acts on the 3-way decision), a `Tray`, a second `BrowserWindow` class for Settings (its own preload/renderer entry), and a `settingsBridge` IPC contract. `ScanConfig` (enabled + interval) persists as a singleton row in `HistoryStore`'s existing SQLite db. A real, spec-caught correctness fix is bundled: `ipcMain.handle` registration is hoisted out of `createMainWindow()` (which tray "Show"/`activate` can now call twice) to run exactly once at `createApp()`'s top level, with the window looked up dynamically.

**Tech Stack:** Rust (`rusqlite`/`duckdb` bundled, `serde`/`serde_json`, `cargo test`); TypeScript, Electron 33 (`contextIsolation`/`sandbox` on, `Tray`/`Notification` built-in — no new npm dep), React 18 + `@testing-library/react` + jsdom, Vitest, `better-sqlite3` (native, Electron-ABI-rebuilt), Claude CLI v2.1.209 (unchanged), electron-vite (`main`/`preload`/`renderer` targets, now with a second preload + renderer entry).

## Global Constraints

Every task's requirements implicitly include this section.

- **Hard safety invariant (non-negotiable, restated every phase):** the app NEVER places, modifies, cancels, or automates any order. This phase adds no Kite write-tool method, no new Claude tool grant, and no code path reaching `place_order`/`modify_order`/`cancel_order`/`place_gtt_order`/`modify_gtt_order`/`delete_gtt_order`. The AI-escalated scan path reuses `ClaudeCliProvider.completeAiAssisted` **exactly** as AI-Assisted mode already does — nothing new. The scan scheduler only ever calls the same read-only `KiteClient` methods and the same `Provider`/`AiAssistedProvider` interfaces every other phase uses; proactive scanning only ever produces information (a history entry, a desktop notification), never an action. Any task whose diff could plausibly be read as expanding tool access must call that out explicitly in its review criteria (none here should).
- **The mandatory per-session AI-Assisted/Engine-Only prompt is unaffected.** Settings never pre-answers or caches a default for that choice — it remains asked fresh every session (§9). No task in this phase touches that flow.
- **Comments:** default to none. Only add one when the *why* isn't obvious (a hidden invariant, a workaround, a formula's source — e.g. the gate threshold derivation is exactly this kind of comment-worthy fact). Never restate what the next line does; never a numbered step-by-step comment block. (From `/Users/salman/ws/trade-assistant/CLAUDE.md`.)
- **Naming:** Rust `snake_case` functions/vars, `PascalCase` types, one clear responsibility per file. TypeScript `camelCase` functions/vars, `PascalCase` types/classes/React components, no Hungarian notation, no non-standard abbreviations (`oi`/`pcr`/`ltp` are domain terms and fine). File names describe responsibility, not file kind.
- **Structure:** small focused files, one responsibility each. Pure logic (`scan_gate.rs`) stays separate from I/O (`StateStore` persistence, the sidecar handler wiring, the scheduler). Task boundaries preserve that split.
- **Commit convention:** every task's implementer commits as the repo's own configured git user (`hadetan <aquibsyed83@gmail.com>`) via plain `git commit` — NEVER pass `--author`, NEVER add a `Co-Authored-By` trailer, NEVER use `--no-verify`. Conventional-commit subjects, matching the sibling plans.
- **Two toolchains, two test runners.** **Rust:** run from `rust-core/` — `cargo test -p <crate>` (per-crate) or `cargo test -p <crate> --test <file>` (single integration test file). `scan_gate.rs` gets pure unit tests (no I/O, no mocking); `state_store.rs` extensions get real `rusqlite`-backed tests matching the existing `state_store_test.rs`/`candle_store` style; sidecar handler tests follow the existing `Compute`/`PersistCandles` inline pattern. **TypeScript:** run from `electron-app/` — `npx vitest run <path>` (per-file), `npm test` (full suite), `npm run typecheck` (`src/**` only, excludes test files). `scanScheduler.ts` tests use a fake sidecar supervisor + fake clock (injected `setIntervalFn`/`clearIntervalFn`, no real timers); IPC bridge tests mirror `historyBridge.test.ts`'s `Map`-of-channel-to-handler style. **DB-touching vitest runs are prefixed with `npm rebuild better-sqlite3`** to guarantee the system-Node ABI under vitest (Phase 5c's dual-ABI resolution).
- No test performs a real live Kite OAuth/MCP call, a real `claude` subprocess invocation, a real sidecar subprocess (except the Rust `end_to_end_test.rs`, which is the established pattern of spawning the compiled binary over stdin/stdout), a real web search/fetch, or a real timer — everything is DI-faked via the established `spawnFn`/`callTool`/`setIntervalFn` patterns.
- **Move quickly, don't cut corners.** Tasks are dependency-ordered so independent ones (Rust vs TS building blocks) are genuinely parallelizable. Speed comes from the plan being unambiguous, not from skipping TDD, exact code, or the self-review pass.

---

### Task 1: `scan_gate.rs` — the pure gate function (algo-core)

The first, most independent task: a pure, deterministic, no-I/O function plus its `GateDecision`/`GateThresholds` types, unit-tested directly, matching `confluence.rs`'s style. Zero dependency on anything else in this phase.

**Files:**
- Create: `rust-core/crates/algo-core/src/scan_gate.rs`
- Create: `rust-core/crates/algo-core/tests/scan_gate_test.rs`
- Modify: `rust-core/crates/algo-core/src/lib.rs`

**Interfaces:**
- Consumes: `crate::confluence::ScorecardSummary` (existing: `{ bullish_count: usize, bearish_count: usize, neutral_count: usize, weighted_vote: f64 }`).
- Produces:
  - `pub enum GateDecision { NoChange, WorthLook, WorthAiCall }` (derives `Debug, Clone, Copy, PartialEq, Eq`).
  - `pub struct GateThresholds { pub worth_look_delta: f64, pub worth_ai_call_delta: f64 }` (derives `Debug, Clone, Copy, PartialEq`; `Default` = `0.10` / `0.25`).
  - `pub fn evaluate_scan_gate(prev: Option<&ScorecardSummary>, curr: &ScorecardSummary, thresholds: &GateThresholds) -> GateDecision`.
  - `lib.rs` gains `pub mod scan_gate;`.

- [ ] **Step 1: Write the failing test** — create `rust-core/crates/algo-core/tests/scan_gate_test.rs`:

```rust
use algo_core::confluence::ScorecardSummary;
use algo_core::scan_gate::{evaluate_scan_gate, GateDecision, GateThresholds};

fn summary(bullish: usize, bearish: usize, neutral: usize, weighted_vote: f64) -> ScorecardSummary {
    ScorecardSummary { bullish_count: bullish, bearish_count: bearish, neutral_count: neutral, weighted_vote }
}

#[test]
fn first_ever_scan_of_a_symbol_is_worth_a_look() {
    let curr = summary(5, 2, 10, 0.12);
    assert_eq!(evaluate_scan_gate(None, &curr, &GateThresholds::default()), GateDecision::WorthLook);
}

#[test]
fn first_ever_scan_with_zero_algorithm_outputs_is_no_change() {
    // Proves the zero-total guard runs before the prev.is_none() check.
    let curr = summary(0, 0, 0, 0.0);
    assert_eq!(evaluate_scan_gate(None, &curr, &GateThresholds::default()), GateDecision::NoChange);
}

#[test]
fn identical_scorecards_are_no_change() {
    let prev = summary(5, 2, 10, 0.12);
    let curr = summary(5, 2, 10, 0.12);
    assert_eq!(evaluate_scan_gate(Some(&prev), &curr, &GateThresholds::default()), GateDecision::NoChange);
}

#[test]
fn a_moderate_vote_swing_crosses_into_worth_look() {
    // vote_delta = 0.15, strictly between 0.10 and 0.25; counts unchanged.
    let prev = summary(3, 3, 4, 0.10);
    let curr = summary(3, 3, 4, 0.25);
    assert_eq!(evaluate_scan_gate(Some(&prev), &curr, &GateThresholds::default()), GateDecision::WorthLook);
}

#[test]
fn a_large_vote_swing_crosses_into_worth_ai_call() {
    // vote_delta = 0.30 >= 0.25; counts unchanged.
    let prev = summary(3, 3, 4, 0.10);
    let curr = summary(3, 3, 4, 0.40);
    assert_eq!(evaluate_scan_gate(Some(&prev), &curr, &GateThresholds::default()), GateDecision::WorthAiCall);
}

#[test]
fn exactly_the_worth_look_threshold_counts_as_worth_look() {
    // vote_delta = 0.10 exactly; proves the comparison is inclusive `>=`.
    let prev = summary(3, 3, 4, 0.10);
    let curr = summary(3, 3, 4, 0.20);
    assert_eq!(evaluate_scan_gate(Some(&prev), &curr, &GateThresholds::default()), GateDecision::WorthLook);
}

#[test]
fn exactly_the_worth_ai_call_threshold_counts_as_worth_ai_call() {
    // vote_delta = 0.25 exactly; proves the comparison is inclusive `>=`.
    let prev = summary(3, 3, 4, 0.10);
    let curr = summary(3, 3, 4, 0.35);
    assert_eq!(evaluate_scan_gate(Some(&prev), &curr, &GateThresholds::default()), GateDecision::WorthAiCall);
}

#[test]
fn a_quiet_vote_with_a_loud_count_flip_still_escalates() {
    // weighted_vote barely moves (0.50 -> 0.52, vote_delta 0.02, below even
    // worth_look_delta) but the net directional count swings hard: net ratio
    // 0.0 -> 0.8, net_delta 0.8. A vote-only formula would call this NoChange;
    // the max() combination makes it WorthAiCall.
    let prev = summary(5, 5, 0, 0.50);
    let curr = summary(9, 1, 0, 0.52);
    assert_eq!(evaluate_scan_gate(Some(&prev), &curr, &GateThresholds::default()), GateDecision::WorthAiCall);
}

#[test]
fn below_both_thresholds_is_no_change() {
    // vote_delta = 0.06 (one algorithm's worth), counts unchanged -> NoChange.
    let prev = summary(3, 3, 4, 0.10);
    let curr = summary(3, 3, 4, 0.16);
    assert_eq!(evaluate_scan_gate(Some(&prev), &curr, &GateThresholds::default()), GateDecision::NoChange);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `rust-core/`): `cargo test -p algo-core --test scan_gate_test`
Expected: FAIL to compile — `algo_core::scan_gate` module does not exist.

- [ ] **Step 3: Implement `scan_gate.rs`** — create `rust-core/crates/algo-core/src/scan_gate.rs`:

```rust
use crate::confluence::ScorecardSummary;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateDecision {
    NoChange,
    WorthLook,
    WorthAiCall,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GateThresholds {
    pub worth_look_delta: f64,
    pub worth_ai_call_delta: f64,
}

impl Default for GateThresholds {
    // 0.10 ~= a couple of algorithms' net directional change under today's
    // equal-weight scheme (one flip moves weighted_vote ~2/34 ~= 0.06); 0.25
    // ~= four-plus algorithms' worth. Documented starting points, not tied
    // permanently to "34" -- see the phase 5d design doc P5d§4.1.
    fn default() -> Self {
        Self { worth_look_delta: 0.10, worth_ai_call_delta: 0.25 }
    }
}

fn net_count_ratio(summary: &ScorecardSummary) -> f64 {
    let total = (summary.bullish_count + summary.bearish_count + summary.neutral_count) as f64;
    if total == 0.0 {
        return 0.0;
    }
    (summary.bullish_count as f64 - summary.bearish_count as f64) / total
}

pub fn evaluate_scan_gate(
    prev: Option<&ScorecardSummary>,
    curr: &ScorecardSummary,
    thresholds: &GateThresholds,
) -> GateDecision {
    let curr_total = curr.bullish_count + curr.bearish_count + curr.neutral_count;
    if curr_total == 0 {
        // No algorithm produced an opinion this tick (e.g. insufficient
        // history) -- nothing real to compare or show, so this never counts as
        // a change regardless of what `prev` was. Without this guard a data gap
        // (weighted_vote defaults to 0.0) would look like "everything flipped".
        return GateDecision::NoChange;
    }

    let Some(prev) = prev else {
        // First-ever scan of this symbol: no baseline to diff, but the user
        // wants at least one read rather than a permanent silent swallow.
        return GateDecision::WorthLook;
    };

    let vote_delta = (curr.weighted_vote - prev.weighted_vote).abs();
    let net_delta = (net_count_ratio(curr) - net_count_ratio(prev)).abs();
    let gate_delta = vote_delta.max(net_delta);

    if gate_delta >= thresholds.worth_ai_call_delta {
        GateDecision::WorthAiCall
    } else if gate_delta >= thresholds.worth_look_delta {
        GateDecision::WorthLook
    } else {
        GateDecision::NoChange
    }
}
```

- [ ] **Step 4: Wire `lib.rs`** — in `rust-core/crates/algo-core/src/lib.rs`, add `pub mod scan_gate;` alongside the existing `pub mod confluence;` / `pub mod registry;` (public module namespace, not root-re-exported):

```rust
mod algorithm;
pub mod confluence;
mod forecast;
mod indicators;
mod options;
mod quant;
pub mod registry;
pub mod scan_gate;
```

- [ ] **Step 5: Run test to verify it passes**

Run (from `rust-core/`): `cargo test -p algo-core --test scan_gate_test`
Expected: PASS (all nine tests). Confirm the existing `registry_count_test` still passes: `cargo test -p algo-core`.

- [ ] **Step 6: Commit**

```bash
git add rust-core/crates/algo-core/src/scan_gate.rs rust-core/crates/algo-core/tests/scan_gate_test.rs rust-core/crates/algo-core/src/lib.rs
git commit -m "feat(algo-core): pure scan_gate evaluate function with threshold tests"
```

---

### Task 2: `StateStore` extensions — `remove_watchlist_symbol` + `scan_snapshots` (storage)

Extend the existing, currently-unwired `StateStore` with `remove_watchlist_symbol`, a `scan_snapshots` last-observation table, and its `get_last_snapshot`/`set_last_snapshot` accessors, plus the `ConfluenceSnapshot` type and a `StorageError::Json` variant. `storage` gains its first `serde`/`serde_json` dependency but **not** a dependency on `algo-core` — `ConfluenceSnapshot` mirrors `ScorecardSummary`'s four fields locally, exactly as `sidecar::protocol::ConfluenceWire` already mirrors it. Depends only on the existing `state_store.rs`, not on Task 1.

**Files:**
- Modify: `rust-core/crates/storage/src/state_store.rs`
- Modify: `rust-core/crates/storage/src/error.rs`
- Modify: `rust-core/crates/storage/src/lib.rs`
- Modify: `rust-core/crates/storage/Cargo.toml`
- Modify: `rust-core/crates/storage/tests/state_store_test.rs`

**Interfaces:**
- Consumes: `rusqlite` (existing), `serde`/`serde_json` (new deps), `serde_json::Error` (new `StorageError::Json`).
- Produces:
  - `pub struct ConfluenceSnapshot { pub bullish_count: usize, pub bearish_count: usize, pub neutral_count: usize, pub weighted_vote: f64 }` (derives `Debug, Clone, Serialize, Deserialize, PartialEq`), re-exported from `lib.rs`.
  - `StateStore::remove_watchlist_symbol(&self, symbol: &str) -> Result<()>`.
  - `StateStore::get_last_snapshot(&self, symbol: &str) -> Result<Option<ConfluenceSnapshot>>`.
  - `StateStore::set_last_snapshot(&self, symbol: &str, snapshot: &ConfluenceSnapshot) -> Result<()>` (upsert).
  - `StorageError::Json(serde_json::Error)` variant + `Display` arm + `From<serde_json::Error>` impl.
  - `open()` also creates the `scan_snapshots` table.

- [ ] **Step 1: Write the failing tests** — append to `rust-core/crates/storage/tests/state_store_test.rs` (keep the existing `watchlist_round_trips_through_sqlite` test; update the import line at the top):

Replace the first line `use storage::StateStore;` with:

```rust
use storage::{ConfluenceSnapshot, StateStore};
```

Append these tests:

```rust
#[test]
fn remove_watchlist_symbol_removes_only_the_named_symbol() {
    let dir = tempdir().unwrap();
    let store = StateStore::open(&dir.path().join("state.sqlite")).unwrap();
    store.add_watchlist_symbol("NSE:INFY").unwrap();
    store.add_watchlist_symbol("NSE:TCS").unwrap();

    store.remove_watchlist_symbol("NSE:INFY").unwrap();

    assert_eq!(store.watchlist().unwrap(), vec!["NSE:TCS".to_string()]);
}

#[test]
fn removing_a_symbol_not_on_the_watchlist_is_a_harmless_no_op() {
    let dir = tempdir().unwrap();
    let store = StateStore::open(&dir.path().join("state.sqlite")).unwrap();

    store.remove_watchlist_symbol("NSE:NOTHERE").unwrap();

    assert!(store.watchlist().unwrap().is_empty());
}

#[test]
fn get_last_snapshot_returns_none_for_a_symbol_never_scanned() {
    let dir = tempdir().unwrap();
    let store = StateStore::open(&dir.path().join("state.sqlite")).unwrap();

    assert_eq!(store.get_last_snapshot("NSE:INFY").unwrap(), None);
}

#[test]
fn set_last_snapshot_then_get_last_snapshot_round_trips() {
    let dir = tempdir().unwrap();
    let store = StateStore::open(&dir.path().join("state.sqlite")).unwrap();
    let snapshot = ConfluenceSnapshot { bullish_count: 5, bearish_count: 2, neutral_count: 10, weighted_vote: 0.12 };

    store.set_last_snapshot("NSE:INFY", &snapshot).unwrap();

    assert_eq!(store.get_last_snapshot("NSE:INFY").unwrap(), Some(snapshot));
}

#[test]
fn set_last_snapshot_twice_overwrites_rather_than_duplicating() {
    let dir = tempdir().unwrap();
    let store = StateStore::open(&dir.path().join("state.sqlite")).unwrap();
    let first = ConfluenceSnapshot { bullish_count: 1, bearish_count: 1, neutral_count: 1, weighted_vote: 0.0 };
    let second = ConfluenceSnapshot { bullish_count: 9, bearish_count: 1, neutral_count: 0, weighted_vote: 0.8 };

    store.set_last_snapshot("NSE:INFY", &first).unwrap();
    store.set_last_snapshot("NSE:INFY", &second).unwrap();

    // The upsert overwrites the single row; get returns only the second value.
    assert_eq!(store.get_last_snapshot("NSE:INFY").unwrap(), Some(second));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `rust-core/`): `cargo test -p storage --test state_store_test`
Expected: FAIL to compile — `ConfluenceSnapshot` and the three new methods do not exist.

- [ ] **Step 3: Add `serde`/`serde_json` deps** — in `rust-core/crates/storage/Cargo.toml`, add to `[dependencies]` (matching the versions the `sidecar` crate already uses):

```toml
[dependencies]
rusqlite = { version = "0.31", features = ["bundled"] }
duckdb = { version = "1.0", features = ["bundled"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **Step 4: Add the `Json` error variant** — replace the full contents of `rust-core/crates/storage/src/error.rs`:

```rust
#[derive(Debug)]
pub enum StorageError {
    Io(std::io::Error),
    Duckdb(duckdb::Error),
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StorageError::Io(e) => write!(f, "storage io error: {e}"),
            StorageError::Duckdb(e) => write!(f, "storage duckdb error: {e}"),
            StorageError::Sqlite(e) => write!(f, "storage sqlite error: {e}"),
            StorageError::Json(e) => write!(f, "storage json error: {e}"),
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

impl From<serde_json::Error> for StorageError {
    fn from(e: serde_json::Error) -> Self {
        StorageError::Json(e)
    }
}

pub type Result<T> = std::result::Result<T, StorageError>;
```

- [ ] **Step 5: Implement the `StateStore` extensions** — replace the full contents of `rust-core/crates/storage/src/state_store.rs`:

```rust
use crate::error::Result;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConfluenceSnapshot {
    pub bullish_count: usize,
    pub bearish_count: usize,
    pub neutral_count: usize,
    pub weighted_vote: f64,
}

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
        conn.execute(
            "CREATE TABLE IF NOT EXISTS scan_snapshots (
                symbol TEXT PRIMARY KEY,
                confluence_json TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

    pub fn remove_watchlist_symbol(&self, symbol: &str) -> Result<()> {
        self.conn.execute("DELETE FROM watchlist WHERE symbol = ?1", [symbol])?;
        Ok(())
    }

    pub fn watchlist(&self) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT symbol FROM watchlist ORDER BY id ASC")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        // Collect into rusqlite's own Result first (the iterator's item error
        // type), then `?` converts any rusqlite::Error into StorageError.
        let symbols = rows.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(symbols)
    }

    pub fn get_last_snapshot(&self, symbol: &str) -> Result<Option<ConfluenceSnapshot>> {
        use rusqlite::OptionalExtension;
        let json: Option<String> = self
            .conn
            .query_row(
                "SELECT confluence_json FROM scan_snapshots WHERE symbol = ?1",
                [symbol],
                |row| row.get(0),
            )
            .optional()?;
        match json {
            Some(text) => Ok(Some(serde_json::from_str(&text)?)),
            None => Ok(None),
        }
    }

    pub fn set_last_snapshot(&self, symbol: &str, snapshot: &ConfluenceSnapshot) -> Result<()> {
        let json = serde_json::to_string(snapshot)?;
        self.conn.execute(
            "INSERT INTO scan_snapshots (symbol, confluence_json, updated_at)
             VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(symbol) DO UPDATE SET
               confluence_json = excluded.confluence_json,
               updated_at = excluded.updated_at",
            rusqlite::params![symbol, json],
        )?;
        Ok(())
    }
}
```

- [ ] **Step 6: Re-export `ConfluenceSnapshot`** — replace the full contents of `rust-core/crates/storage/src/lib.rs`:

```rust
mod candle_store;
mod error;
mod state_store;

pub use candle_store::{Candle, CandleStore};
pub use error::StorageError;
pub use state_store::{ConfluenceSnapshot, StateStore};
```

- [ ] **Step 7: Run tests to verify they pass**

Run (from `rust-core/`): `cargo test -p storage`
Expected: PASS (the existing `watchlist_round_trips_through_sqlite` and the `candle_store` inline tests, plus all five new tests).

- [ ] **Step 8: Commit**

```bash
git add rust-core/crates/storage/src/state_store.rs rust-core/crates/storage/src/error.rs rust-core/crates/storage/src/lib.rs rust-core/crates/storage/Cargo.toml rust-core/crates/storage/tests/state_store_test.rs
git commit -m "feat(storage): scan_snapshots table, remove_watchlist_symbol, ConfluenceSnapshot"
```

---

### Task 3: Sidecar protocol payloads + handlers (sidecar)

Add the new request/response **payload** structs (`AddWatchlistSymbolRequest`, `RemoveWatchlistSymbolRequest`, `ListWatchlistRequest`, `EvaluateScanGateRequest`, `WatchlistResponse`, `ScanGateResponse`), give `ConfluenceWire` a `Deserialize` derive, and add the four handler functions with their conversion helpers and inline tests. This task deliberately does **not** touch the `SidecarRequest`/`SidecarResponse` enums or `main.rs` — that coupled change (adding enum variants makes `main.rs`'s `match` non-exhaustive) lands atomically in Task 4. Because the new structs are `pub` in the lib crate and the handlers are `pub fn`, nothing here is dead code and the whole crate still compiles. Depends on Tasks 1 (`scan_gate`) and 2 (`StateStore`/`ConfluenceSnapshot`).

**Files:**
- Modify: `rust-core/crates/sidecar/src/protocol.rs`
- Modify: `rust-core/crates/sidecar/src/handlers.rs`
- Modify: `rust-core/crates/sidecar/tests/protocol_test.rs`

**Interfaces:**
- Consumes: `storage::{ConfluenceSnapshot, StateStore}`, `algo_core::confluence::ScorecardSummary`, `algo_core::scan_gate::{evaluate_scan_gate, GateThresholds}`.
- Produces (protocol.rs):
  - `ConfluenceWire` gains `Deserialize` (was `Serialize`-only).
  - `pub struct AddWatchlistSymbolRequest { pub id: u64, pub symbol: String }` (`Deserialize`).
  - `pub struct RemoveWatchlistSymbolRequest { pub id: u64, pub symbol: String }` (`Deserialize`).
  - `pub struct ListWatchlistRequest { pub id: u64 }` (`Deserialize`).
  - `pub struct EvaluateScanGateRequest { pub id: u64, pub symbol: String, pub confluence: ConfluenceWire }` (`Deserialize`).
  - `pub struct WatchlistResponse { pub id: u64, pub symbols: Vec<String>, pub error: Option<String> }` (`Serialize`, `error` skipped when `None`).
  - `pub struct ScanGateResponse { pub id: u64, pub decision: String, pub error: Option<String> }` (`Serialize`, `error` skipped when `None`).
- Produces (handlers.rs): `handle_add_watchlist_symbol`, `handle_remove_watchlist_symbol`, `handle_list_watchlist` (all `(store: &StateStore, request: …) -> WatchlistResponse`), `handle_evaluate_scan_gate(store: &StateStore, request: EvaluateScanGateRequest) -> ScanGateResponse`, plus private `wire_to_scorecard`/`scorecard_to_snapshot`/`snapshot_to_scorecard` helpers.

- [ ] **Step 1: Write the failing tests** — append to `rust-core/crates/sidecar/tests/protocol_test.rs` (the standalone struct-level round trips; the tagged-enum round trips land in Task 4). Update the import line at the top to add the new types:

Replace the existing `use sidecar::protocol::{ … };` block with:

```rust
use sidecar::protocol::{
    empty_response, encode_response, parse_request, AddWatchlistSymbolRequest, AlgoResultWire,
    ComputeResponse, ConfluenceWire, EvaluateScanGateRequest, ListWatchlistRequest,
    RemoveWatchlistSymbolRequest, ScanGateResponse, SidecarRequest, SidecarResponse,
    WatchlistResponse,
};
```

Append:

```rust
#[test]
fn confluence_wire_deserializes_from_a_json_object() {
    let json = r#"{"bullish_count":5,"bearish_count":2,"neutral_count":10,"weighted_vote":0.12}"#;
    let wire: ConfluenceWire = serde_json::from_str(json).unwrap();
    assert_eq!(wire.bullish_count, 5);
    assert_eq!(wire.bearish_count, 2);
    assert_eq!(wire.neutral_count, 10);
    assert!((wire.weighted_vote - 0.12).abs() < 1e-9);
}

#[test]
fn add_watchlist_symbol_request_payload_deserializes() {
    let req: AddWatchlistSymbolRequest =
        serde_json::from_str(r#"{"id":7,"symbol":"NSE:INFY"}"#).unwrap();
    assert_eq!(req.id, 7);
    assert_eq!(req.symbol, "NSE:INFY");
}

#[test]
fn remove_watchlist_symbol_request_payload_deserializes() {
    let req: RemoveWatchlistSymbolRequest =
        serde_json::from_str(r#"{"id":8,"symbol":"NSE:INFY"}"#).unwrap();
    assert_eq!(req.id, 8);
    assert_eq!(req.symbol, "NSE:INFY");
}

#[test]
fn list_watchlist_request_payload_deserializes() {
    let req: ListWatchlistRequest = serde_json::from_str(r#"{"id":9}"#).unwrap();
    assert_eq!(req.id, 9);
}

#[test]
fn evaluate_scan_gate_request_payload_deserializes_with_its_confluence() {
    let req: EvaluateScanGateRequest = serde_json::from_str(
        r#"{"id":10,"symbol":"NSE:INFY","confluence":{"bullish_count":5,"bearish_count":2,"neutral_count":10,"weighted_vote":0.12}}"#,
    )
    .unwrap();
    assert_eq!(req.id, 10);
    assert_eq!(req.symbol, "NSE:INFY");
    assert_eq!(req.confluence.bullish_count, 5);
}

#[test]
fn watchlist_response_omits_error_field_when_none() {
    let json = serde_json::to_string(&WatchlistResponse {
        id: 7,
        symbols: vec!["NSE:INFY".to_string()],
        error: None,
    })
    .unwrap();
    assert!(json.contains("\"id\":7"));
    assert!(json.contains("\"symbols\":[\"NSE:INFY\"]"));
    assert!(!json.contains("error"));
}

#[test]
fn scan_gate_response_serializes_its_decision_string() {
    let json = serde_json::to_string(&ScanGateResponse {
        id: 10,
        decision: "WorthLook".to_string(),
        error: None,
    })
    .unwrap();
    assert!(json.contains("\"id\":10"));
    assert!(json.contains("\"decision\":\"WorthLook\""));
    assert!(!json.contains("error"));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `rust-core/`): `cargo test -p sidecar --test protocol_test`
Expected: FAIL to compile — the new payload types don't exist yet and `ConfluenceWire` isn't `Deserialize`.

- [ ] **Step 3: Implement the protocol additions** — in `rust-core/crates/sidecar/src/protocol.rs`, change `ConfluenceWire`'s derive to add `Deserialize`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfluenceWire {
    pub bullish_count: usize,
    pub bearish_count: usize,
    pub neutral_count: usize,
    pub weighted_vote: f64,
}
```

Then, immediately after the existing `PersistCandlesResponse` struct (before the `SidecarRequest` enum), add the new payloads:

```rust
#[derive(Debug, Deserialize)]
pub struct AddWatchlistSymbolRequest {
    pub id: u64,
    pub symbol: String,
}

#[derive(Debug, Deserialize)]
pub struct RemoveWatchlistSymbolRequest {
    pub id: u64,
    pub symbol: String,
}

#[derive(Debug, Deserialize)]
pub struct ListWatchlistRequest {
    pub id: u64,
}

#[derive(Debug, Deserialize)]
pub struct EvaluateScanGateRequest {
    pub id: u64,
    pub symbol: String,
    pub confluence: ConfluenceWire,
}

#[derive(Debug, Serialize)]
pub struct WatchlistResponse {
    pub id: u64,
    pub symbols: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ScanGateResponse {
    pub id: u64,
    /// One of "NoChange" | "WorthLook" | "WorthAiCall" -- produced via
    /// `format!("{decision:?}")`, the same convention `AlgoResultWire::direction`
    /// uses to mirror an `algo_core` enum onto the wire as a Debug string.
    pub decision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
```

- [ ] **Step 4: Implement the handlers** — in `rust-core/crates/sidecar/src/handlers.rs`, extend the top `use` block and add the handlers + helpers. Update the imports:

```rust
use crate::protocol::{
    AddWatchlistSymbolRequest, AlgoResultWire, ComputeRequest, ComputeResponse, ConfluenceWire,
    EvaluateScanGateRequest, ListWatchlistRequest, PersistCandlesRequest, PersistCandlesResponse,
    RemoveWatchlistSymbolRequest, ScanGateResponse, WatchlistResponse,
};
use algo_core::confluence::{compute_confluence, ScorecardSummary};
use algo_core::scan_gate::{evaluate_scan_gate, GateThresholds};
use algo_core::{registry::{self, run_applicable}, Horizon, MarketContext, Timeframe};
use chrono::Utc;
use std::collections::HashMap;
use storage::{Candle, CandleStore, ConfluenceSnapshot, StateStore};
```

Append (after `handle_persist`, before the `#[cfg(test)]` module):

```rust
fn wire_to_scorecard(wire: &ConfluenceWire) -> ScorecardSummary {
    ScorecardSummary {
        bullish_count: wire.bullish_count,
        bearish_count: wire.bearish_count,
        neutral_count: wire.neutral_count,
        weighted_vote: wire.weighted_vote,
    }
}

fn scorecard_to_snapshot(summary: &ScorecardSummary) -> ConfluenceSnapshot {
    ConfluenceSnapshot {
        bullish_count: summary.bullish_count,
        bearish_count: summary.bearish_count,
        neutral_count: summary.neutral_count,
        weighted_vote: summary.weighted_vote,
    }
}

fn snapshot_to_scorecard(snapshot: &ConfluenceSnapshot) -> ScorecardSummary {
    ScorecardSummary {
        bullish_count: snapshot.bullish_count,
        bearish_count: snapshot.bearish_count,
        neutral_count: snapshot.neutral_count,
        weighted_vote: snapshot.weighted_vote,
    }
}

pub fn handle_add_watchlist_symbol(store: &StateStore, request: AddWatchlistSymbolRequest) -> WatchlistResponse {
    match store.add_watchlist_symbol(&request.symbol).and_then(|_| store.watchlist()) {
        Ok(symbols) => WatchlistResponse { id: request.id, symbols, error: None },
        Err(e) => WatchlistResponse { id: request.id, symbols: Vec::new(), error: Some(e.to_string()) },
    }
}

pub fn handle_remove_watchlist_symbol(store: &StateStore, request: RemoveWatchlistSymbolRequest) -> WatchlistResponse {
    match store.remove_watchlist_symbol(&request.symbol).and_then(|_| store.watchlist()) {
        Ok(symbols) => WatchlistResponse { id: request.id, symbols, error: None },
        Err(e) => WatchlistResponse { id: request.id, symbols: Vec::new(), error: Some(e.to_string()) },
    }
}

pub fn handle_list_watchlist(store: &StateStore, request: ListWatchlistRequest) -> WatchlistResponse {
    match store.watchlist() {
        Ok(symbols) => WatchlistResponse { id: request.id, symbols, error: None },
        Err(e) => WatchlistResponse { id: request.id, symbols: Vec::new(), error: Some(e.to_string()) },
    }
}

pub fn handle_evaluate_scan_gate(store: &StateStore, request: EvaluateScanGateRequest) -> ScanGateResponse {
    let curr = wire_to_scorecard(&request.confluence);
    let prev_snapshot = match store.get_last_snapshot(&request.symbol) {
        Ok(snapshot) => snapshot,
        Err(e) => return ScanGateResponse { id: request.id, decision: "NoChange".to_string(), error: Some(e.to_string()) },
    };
    let prev_scorecard = prev_snapshot.as_ref().map(snapshot_to_scorecard);
    let decision = evaluate_scan_gate(prev_scorecard.as_ref(), &curr, &GateThresholds::default());
    // Always store the current tick (even on NoChange): comparing tick-to-tick,
    // not tick-to-last-meaningful-change, lets slow drift eventually register.
    match store.set_last_snapshot(&request.symbol, &scorecard_to_snapshot(&curr)) {
        Ok(()) => ScanGateResponse { id: request.id, decision: format!("{decision:?}"), error: None },
        Err(e) => ScanGateResponse { id: request.id, decision: format!("{decision:?}"), error: Some(e.to_string()) },
    }
}
```

- [ ] **Step 5: Add the handler inline tests** — append inside the existing `#[cfg(test)] mod tests { … }` in `handlers.rs` (after `handle_persist_writes_candles_that_read_back_from_the_kite_source`):

```rust
    fn state_store() -> (tempfile::TempDir, StateStore) {
        use tempfile::tempdir;
        let dir = tempdir().unwrap();
        let store = StateStore::open(&dir.path().join("state.sqlite3")).unwrap();
        (dir, store)
    }

    fn confluence_wire(bullish: usize, bearish: usize, neutral: usize, weighted_vote: f64) -> ConfluenceWire {
        ConfluenceWire { bullish_count: bullish, bearish_count: bearish, neutral_count: neutral, weighted_vote }
    }

    #[test]
    fn handle_add_watchlist_symbol_returns_the_updated_list() {
        let (_dir, store) = state_store();
        let response = handle_add_watchlist_symbol(
            &store,
            AddWatchlistSymbolRequest { id: 1, symbol: "NSE:INFY".to_string() },
        );
        assert_eq!(response.id, 1);
        assert_eq!(response.symbols, vec!["NSE:INFY".to_string()]);
        assert!(response.error.is_none());
    }

    #[test]
    fn handle_remove_watchlist_symbol_returns_the_updated_list() {
        let (_dir, store) = state_store();
        store.add_watchlist_symbol("NSE:INFY").unwrap();
        store.add_watchlist_symbol("NSE:TCS").unwrap();
        let response = handle_remove_watchlist_symbol(
            &store,
            RemoveWatchlistSymbolRequest { id: 2, symbol: "NSE:INFY".to_string() },
        );
        assert_eq!(response.symbols, vec!["NSE:TCS".to_string()]);
    }

    #[test]
    fn handle_list_watchlist_returns_the_current_list() {
        let (_dir, store) = state_store();
        store.add_watchlist_symbol("NSE:INFY").unwrap();
        let response = handle_list_watchlist(&store, ListWatchlistRequest { id: 3 });
        assert_eq!(response.id, 3);
        assert_eq!(response.symbols, vec!["NSE:INFY".to_string()]);
    }

    #[test]
    fn handle_evaluate_scan_gate_returns_worth_look_on_first_scan_and_persists_the_snapshot() {
        let (_dir, store) = state_store();
        let response = handle_evaluate_scan_gate(
            &store,
            EvaluateScanGateRequest { id: 4, symbol: "NSE:INFY".to_string(), confluence: confluence_wire(5, 2, 10, 0.12) },
        );
        assert_eq!(response.decision, "WorthLook");
        assert!(response.error.is_none());
        // The snapshot was persisted, so a second identical call can compare.
        assert!(store.get_last_snapshot("NSE:INFY").unwrap().is_some());
    }

    #[test]
    fn handle_evaluate_scan_gate_returns_no_change_on_an_identical_second_scan() {
        let (_dir, store) = state_store();
        let first = handle_evaluate_scan_gate(
            &store,
            EvaluateScanGateRequest { id: 5, symbol: "NSE:INFY".to_string(), confluence: confluence_wire(5, 2, 10, 0.12) },
        );
        assert_eq!(first.decision, "WorthLook");
        let second = handle_evaluate_scan_gate(
            &store,
            EvaluateScanGateRequest { id: 6, symbol: "NSE:INFY".to_string(), confluence: confluence_wire(5, 2, 10, 0.12) },
        );
        assert_eq!(second.decision, "NoChange");
    }
```

- [ ] **Step 6: Run tests + build to verify they pass**

Run (from `rust-core/`): `cargo test -p sidecar --lib && cargo test -p sidecar --test protocol_test`
Expected: PASS (the new handler inline tests via `--lib`, the new protocol tests via `--test protocol_test`, and every pre-existing test in both). The crate still compiles because `main.rs`'s `match` remains exhaustive over the unchanged two-variant enums.

- [ ] **Step 7: Commit**

```bash
git add rust-core/crates/sidecar/src/protocol.rs rust-core/crates/sidecar/src/handlers.rs rust-core/crates/sidecar/tests/protocol_test.rs
git commit -m "feat(sidecar): watchlist + scan-gate request/response payloads and handlers"
```

---

### Task 4: Sidecar enum variants + `main.rs` dispatch + end-to-end (sidecar)

The coupled change: extend the `SidecarRequest`/`SidecarResponse` tagged enums with the new variants and, in the **same commit**, add the four `main.rs` dispatch arms (each panic-isolated exactly like `Compute`/`PersistCandles`, each falling back to `"no --lake-root configured"` when the state store is `None`), open a second `StateStore` alongside the candle lake, add the tagged-enum round-trip protocol tests, and the compiled-binary end-to-end test. Depends on Task 3 (handlers + payloads).

**Files:**
- Modify: `rust-core/crates/sidecar/src/protocol.rs`
- Modify: `rust-core/crates/sidecar/src/main.rs`
- Modify: `rust-core/crates/sidecar/tests/protocol_test.rs`
- Modify: `rust-core/crates/sidecar/tests/end_to_end_test.rs`

**Interfaces:**
- Consumes: the Task 3 handlers (`handle_add_watchlist_symbol`/`handle_remove_watchlist_symbol`/`handle_list_watchlist`/`handle_evaluate_scan_gate`) and payloads; `storage::StateStore`.
- Produces:
  - `SidecarRequest` gains `AddWatchlistSymbol(AddWatchlistSymbolRequest)`, `RemoveWatchlistSymbol(RemoveWatchlistSymbolRequest)`, `ListWatchlist(ListWatchlistRequest)`, `EvaluateScanGate(EvaluateScanGateRequest)`.
  - `SidecarResponse` gains `Watchlist(WatchlistResponse)`, `ScanGate(ScanGateResponse)`.
  - `main.rs`: `state_db_path(lake_root: &Path) -> PathBuf`, a second `StateStore` opened from the same root, the lake-root dir ensured to exist, and four new `catch_unwind`-isolated match arms.

- [ ] **Step 1: Write the failing tests** — append the tagged round trips to `rust-core/crates/sidecar/tests/protocol_test.rs`:

```rust
#[test]
fn parses_a_tagged_add_watchlist_symbol_request() {
    match parse_request(r#"{"type":"add_watchlist_symbol","id":7,"symbol":"NSE:INFY"}"#).unwrap() {
        SidecarRequest::AddWatchlistSymbol(request) => {
            assert_eq!(request.id, 7);
            assert_eq!(request.symbol, "NSE:INFY");
        }
        _ => panic!("expected an add_watchlist_symbol request"),
    }
}

#[test]
fn parses_a_tagged_remove_watchlist_symbol_request() {
    match parse_request(r#"{"type":"remove_watchlist_symbol","id":8,"symbol":"NSE:INFY"}"#).unwrap() {
        SidecarRequest::RemoveWatchlistSymbol(request) => assert_eq!(request.id, 8),
        _ => panic!("expected a remove_watchlist_symbol request"),
    }
}

#[test]
fn parses_a_tagged_list_watchlist_request() {
    match parse_request(r#"{"type":"list_watchlist","id":9}"#).unwrap() {
        SidecarRequest::ListWatchlist(request) => assert_eq!(request.id, 9),
        _ => panic!("expected a list_watchlist request"),
    }
}

#[test]
fn parses_a_tagged_evaluate_scan_gate_request() {
    match parse_request(
        r#"{"type":"evaluate_scan_gate","id":10,"symbol":"NSE:INFY","confluence":{"bullish_count":5,"bearish_count":2,"neutral_count":10,"weighted_vote":0.12}}"#,
    )
    .unwrap()
    {
        SidecarRequest::EvaluateScanGate(request) => {
            assert_eq!(request.id, 10);
            assert_eq!(request.confluence.neutral_count, 10);
        }
        _ => panic!("expected an evaluate_scan_gate request"),
    }
}

#[test]
fn encodes_a_tagged_watchlist_response() {
    let line = encode_response(&SidecarResponse::Watchlist(WatchlistResponse {
        id: 7,
        symbols: vec!["NSE:INFY".to_string()],
        error: None,
    }));
    assert!(!line.contains('\n'));
    assert!(line.contains("\"type\":\"watchlist\""));
    assert!(line.contains("\"symbols\":[\"NSE:INFY\"]"));
}

#[test]
fn encodes_a_tagged_scan_gate_response() {
    let line = encode_response(&SidecarResponse::ScanGate(ScanGateResponse {
        id: 10,
        decision: "WorthLook".to_string(),
        error: None,
    }));
    assert!(line.contains("\"type\":\"scan_gate\""));
    assert!(line.contains("\"decision\":\"WorthLook\""));
}
```

Append the end-to-end tests to `rust-core/crates/sidecar/tests/end_to_end_test.rs`:

```rust
#[test]
fn watchlist_and_scan_gate_flow_over_stdin_stdout_with_a_lake_root() {
    let dir = tempfile::tempdir().unwrap();
    let lake = dir.path().to_str().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_sidecar"))
        .arg("--lake-root")
        .arg(lake)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("sidecar binary must start");

    let add = r#"{"type":"add_watchlist_symbol","id":1,"symbol":"NSE:INFY"}"#;
    let list = r#"{"type":"list_watchlist","id":2}"#;
    let compute = r#"{"type":"compute","id":3,"symbol":"NSE:INFY","timeframe":"day","closes":[100.0,101.0,102.0,103.0,104.0,105.0,106.0,107.0,108.0,109.0,110.0,111.0,112.0,113.0,114.0,115.0,116.0,117.0,118.0,119.0,120.0]}"#;
    let gate = r#"{"type":"evaluate_scan_gate","id":4,"symbol":"NSE:INFY","confluence":{"bullish_count":8,"bearish_count":1,"neutral_count":2,"weighted_vote":0.5}}"#;

    {
        let stdin = child.stdin.as_mut().unwrap();
        writeln!(stdin, "{add}").unwrap();
        writeln!(stdin, "{list}").unwrap();
        writeln!(stdin, "{compute}").unwrap();
        writeln!(stdin, "{gate}").unwrap();
    }
    drop(child.stdin.take());

    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let mut responses = Vec::new();
    for _ in 0..4 {
        let mut line = String::new();
        reader.read_line(&mut line).expect("stdout must be readable");
        responses.push(serde_json::from_str::<serde_json::Value>(line.trim()).unwrap());
    }
    child.wait().ok();

    assert_eq!(responses[0]["type"], "watchlist");
    assert_eq!(responses[1]["symbols"][0], "NSE:INFY");
    assert_eq!(responses[2]["type"], "compute");
    assert_eq!(responses[3]["type"], "scan_gate");
    // First-ever gate evaluation for this symbol always clears the low bar.
    assert_eq!(responses[3]["decision"], "WorthLook");

    // The state store really opened (not silently None): its db file exists.
    assert!(dir.path().join("state.sqlite3").exists());
}

#[test]
fn a_malformed_evaluate_scan_gate_between_two_valid_ones_does_not_kill_the_sidecar() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_sidecar"))
        .arg("--lake-root")
        .arg(dir.path().to_str().unwrap())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("sidecar binary must start");

    let valid = r#"{"type":"add_watchlist_symbol","id":1,"symbol":"NSE:INFY"}"#;
    // Well-typed tag but a confluence object missing required fields: parses as
    // a request line only if serde accepts it; if it fails to parse it is logged
    // and skipped. Either way the process must answer the two valid requests and
    // exit cleanly, exactly like the existing thin-history regression test.
    let malformed = r#"{"type":"evaluate_scan_gate","id":2,"symbol":"NSE:INFY"}"#;
    let valid_2 = r#"{"type":"list_watchlist","id":3}"#;

    {
        let stdin = child.stdin.as_mut().unwrap();
        writeln!(stdin, "{valid}").unwrap();
        writeln!(stdin, "{malformed}").unwrap();
        writeln!(stdin, "{valid_2}").unwrap();
    }
    drop(child.stdin.take());

    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let mut ids = Vec::new();
    // The malformed line either parses (and answers with id 2) or is skipped, so
    // read until EOF and collect whatever ids came back.
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

- [ ] **Step 2: Run tests to verify they fail**

Run (from `rust-core/`): `cargo test -p sidecar --test protocol_test`
Expected: FAIL to compile — `SidecarRequest::AddWatchlistSymbol` / `SidecarResponse::Watchlist` variants don't exist yet.

- [ ] **Step 3: Extend the enums** — in `rust-core/crates/sidecar/src/protocol.rs`, replace the two enum definitions:

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
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarResponse {
    Compute(ComputeResponse),
    PersistCandles(PersistCandlesResponse),
    Watchlist(WatchlistResponse),
    ScanGate(ScanGateResponse),
}
```

- [ ] **Step 4: Wire `main.rs`** — replace the full contents of `rust-core/crates/sidecar/src/main.rs`:

```rust
use sidecar::handlers::{
    handle_add_watchlist_symbol, handle_evaluate_scan_gate, handle_list_watchlist, handle_persist,
    handle_remove_watchlist_symbol, handle_request,
};
use sidecar::protocol::{
    empty_response, encode_response, parse_request, PersistCandlesResponse, ScanGateResponse,
    SidecarRequest, SidecarResponse, WatchlistResponse,
};
use std::io::{self, BufRead, Write};
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use storage::{CandleStore, StateStore};

fn lake_root_from_args() -> Option<PathBuf> {
    let mut args = std::env::args();
    while let Some(arg) = args.next() {
        if arg == "--lake-root" {
            return args.next().map(PathBuf::from);
        }
    }
    None
}

fn state_db_path(lake_root: &Path) -> PathBuf {
    lake_root.join("state.sqlite3")
}

/// This process is a long-lived sidecar: Electron spawns one instance and
/// drives it for a whole session. A single malformed-but-well-typed request
/// (e.g. a compute algorithm panicking on an edge case we didn't anticipate)
/// must never take the whole loop down with it -- so every per-request call
/// is isolated with `catch_unwind`.
fn main() {
    let lake_root = lake_root_from_args();
    // StateStore::open (unlike CandleStore::open) does not create its parent
    // dir, so ensure the lake root exists before opening either store rather
    // than relying on CandleStore's own create_dir_all running first.
    if let Some(root) = &lake_root {
        let _ = std::fs::create_dir_all(root);
    }
    let store = lake_root.as_ref().and_then(|root| CandleStore::open(root).ok());
    let state_store = lake_root.as_ref().and_then(|root| StateStore::open(&state_db_path(root)).ok());

    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = line.expect("stdin must be readable");
        if line.trim().is_empty() {
            continue;
        }

        let request = match parse_request(&line) {
            Ok(request) => request,
            Err(e) => {
                eprintln!("sidecar: failed to parse request line ({e}): {line:?}");
                continue;
            }
        };

        let response = match request {
            SidecarRequest::Compute(compute) => {
                let id = compute.id;
                let result = panic::catch_unwind(AssertUnwindSafe(|| handle_request(compute)));
                match result {
                    Ok(response) => SidecarResponse::Compute(response),
                    Err(_) => {
                        eprintln!("sidecar: compute request {id} panicked; returning an empty response");
                        SidecarResponse::Compute(empty_response(id))
                    }
                }
            }
            SidecarRequest::PersistCandles(persist) => {
                let id = persist.id;
                match store.as_ref() {
                    Some(store) => {
                        let result = panic::catch_unwind(AssertUnwindSafe(|| handle_persist(store, persist)));
                        match result {
                            Ok(response) => SidecarResponse::PersistCandles(response),
                            Err(_) => {
                                eprintln!("sidecar: persist request {id} panicked");
                                SidecarResponse::PersistCandles(PersistCandlesResponse {
                                    id,
                                    written: 0,
                                    error: Some("persist panicked".to_string()),
                                })
                            }
                        }
                    }
                    None => SidecarResponse::PersistCandles(PersistCandlesResponse {
                        id,
                        written: 0,
                        error: Some("no --lake-root configured".to_string()),
                    }),
                }
            }
            SidecarRequest::AddWatchlistSymbol(request) => {
                let id = request.id;
                match state_store.as_ref() {
                    Some(store) => {
                        let result = panic::catch_unwind(AssertUnwindSafe(|| handle_add_watchlist_symbol(store, request)));
                        match result {
                            Ok(response) => SidecarResponse::Watchlist(response),
                            Err(_) => {
                                eprintln!("sidecar: add_watchlist_symbol request {id} panicked");
                                SidecarResponse::Watchlist(WatchlistResponse { id, symbols: Vec::new(), error: Some("add_watchlist_symbol panicked".to_string()) })
                            }
                        }
                    }
                    None => SidecarResponse::Watchlist(WatchlistResponse { id, symbols: Vec::new(), error: Some("no --lake-root configured".to_string()) }),
                }
            }
            SidecarRequest::RemoveWatchlistSymbol(request) => {
                let id = request.id;
                match state_store.as_ref() {
                    Some(store) => {
                        let result = panic::catch_unwind(AssertUnwindSafe(|| handle_remove_watchlist_symbol(store, request)));
                        match result {
                            Ok(response) => SidecarResponse::Watchlist(response),
                            Err(_) => {
                                eprintln!("sidecar: remove_watchlist_symbol request {id} panicked");
                                SidecarResponse::Watchlist(WatchlistResponse { id, symbols: Vec::new(), error: Some("remove_watchlist_symbol panicked".to_string()) })
                            }
                        }
                    }
                    None => SidecarResponse::Watchlist(WatchlistResponse { id, symbols: Vec::new(), error: Some("no --lake-root configured".to_string()) }),
                }
            }
            SidecarRequest::ListWatchlist(request) => {
                let id = request.id;
                match state_store.as_ref() {
                    Some(store) => {
                        let result = panic::catch_unwind(AssertUnwindSafe(|| handle_list_watchlist(store, request)));
                        match result {
                            Ok(response) => SidecarResponse::Watchlist(response),
                            Err(_) => {
                                eprintln!("sidecar: list_watchlist request {id} panicked");
                                SidecarResponse::Watchlist(WatchlistResponse { id, symbols: Vec::new(), error: Some("list_watchlist panicked".to_string()) })
                            }
                        }
                    }
                    None => SidecarResponse::Watchlist(WatchlistResponse { id, symbols: Vec::new(), error: Some("no --lake-root configured".to_string()) }),
                }
            }
            SidecarRequest::EvaluateScanGate(request) => {
                let id = request.id;
                match state_store.as_ref() {
                    Some(store) => {
                        let result = panic::catch_unwind(AssertUnwindSafe(|| handle_evaluate_scan_gate(store, request)));
                        match result {
                            Ok(response) => SidecarResponse::ScanGate(response),
                            Err(_) => {
                                eprintln!("sidecar: evaluate_scan_gate request {id} panicked");
                                SidecarResponse::ScanGate(ScanGateResponse { id, decision: "NoChange".to_string(), error: Some("evaluate_scan_gate panicked".to_string()) })
                            }
                        }
                    }
                    None => SidecarResponse::ScanGate(ScanGateResponse { id, decision: "NoChange".to_string(), error: Some("no --lake-root configured".to_string()) }),
                }
            }
        };

        writeln!(stdout, "{}", encode_response(&response)).expect("stdout must be writable");
        stdout.flush().expect("stdout must flush");
    }
}
```

- [ ] **Step 5: Run the full sidecar suite to verify it passes**

Run (from `rust-core/`): `cargo test -p sidecar`
Expected: PASS — every prior sidecar test, the new tagged protocol round trips, and both new end-to-end tests (the compiled binary answers `add`→`list`→`compute`→`evaluate_scan_gate`, `state.sqlite3` exists, and a malformed scan-gate line never kills the process).

- [ ] **Step 6: Commit**

```bash
git add rust-core/crates/sidecar/src/protocol.rs rust-core/crates/sidecar/src/main.rs rust-core/crates/sidecar/tests/protocol_test.rs rust-core/crates/sidecar/tests/end_to_end_test.rs
git commit -m "feat(sidecar): route watchlist + scan-gate variants with panic isolation and a state store"
```

---

### Task 5: TypeScript sidecar wire mirror + four `SidecarSupervisor` methods

Mirror the Rust wire shapes into `sidecarProtocol.ts` and add the four `SidecarSupervisor` methods, each just building a tagged request and delegating to the existing `send()` (which already owns id-assignment, the per-request timeout, and pending-map bookkeeping — no new plumbing). Pure TypeScript; the wire shapes are fixed by the spec, so this can proceed in parallel with the Rust tasks.

**Files:**
- Modify: `electron-app/src/main/services/sidecar/sidecarProtocol.ts`
- Modify: `electron-app/src/main/services/sidecar/sidecarSupervisor.ts`
- Modify: `electron-app/test/main/services/sidecar/sidecarProtocol.test.ts`
- Modify: `electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts`

**Interfaces:**
- Consumes: existing `ConfluenceWire` (`sidecarProtocol.ts`), existing `send()`/`nextId`.
- Produces:
  - `interface WatchlistResponseWire { type: "watchlist"; id: number; symbols: string[]; error?: string; }`
  - `interface ScanGateResponseWire { type: "scan_gate"; id: number; decision: "NoChange" | "WorthLook" | "WorthAiCall"; error?: string; }`
  - `SidecarResponseWire` and `SidecarRequestWire` unions extended with the new shapes.
  - `SidecarSupervisor.addWatchlistSymbol(symbol: string): Promise<WatchlistResponseWire>`, `.removeWatchlistSymbol(symbol: string): Promise<WatchlistResponseWire>`, `.listWatchlist(): Promise<WatchlistResponseWire>`, `.evaluateScanGate(symbol: string, confluence: ConfluenceWire): Promise<ScanGateResponseWire>`.

- [ ] **Step 1: Write the failing tests** — append to `electron-app/test/main/services/sidecar/sidecarProtocol.test.ts`:

```typescript
import { encodeRequest } from "../../../../src/main/services/sidecar/sidecarProtocol";
import type {
  ScanGateResponseWire,
  WatchlistResponseWire,
} from "../../../../src/main/services/sidecar/sidecarProtocol";

describe("watchlist + scan-gate wire shapes", () => {
  it("encodes the four new request tags on a single newline-terminated line", () => {
    expect(encodeRequest({ type: "add_watchlist_symbol", id: 1, symbol: "NSE:INFY" })).toBe(
      '{"type":"add_watchlist_symbol","id":1,"symbol":"NSE:INFY"}\n',
    );
    expect(encodeRequest({ type: "remove_watchlist_symbol", id: 2, symbol: "NSE:INFY" })).toBe(
      '{"type":"remove_watchlist_symbol","id":2,"symbol":"NSE:INFY"}\n',
    );
    expect(encodeRequest({ type: "list_watchlist", id: 3 })).toBe('{"type":"list_watchlist","id":3}\n');
    expect(
      encodeRequest({
        type: "evaluate_scan_gate",
        id: 4,
        symbol: "NSE:INFY",
        confluence: { bullish_count: 5, bearish_count: 2, neutral_count: 10, weighted_vote: 0.12 },
      }),
    ).toContain('"type":"evaluate_scan_gate"');
  });

  it("decodes the two new response tags", () => {
    const watchlist = JSON.parse('{"type":"watchlist","id":7,"symbols":["NSE:INFY"]}') as WatchlistResponseWire;
    expect(watchlist.type).toBe("watchlist");
    expect(watchlist.symbols).toEqual(["NSE:INFY"]);
    const gate = JSON.parse('{"type":"scan_gate","id":10,"decision":"WorthLook"}') as ScanGateResponseWire;
    expect(gate.decision).toBe("WorthLook");
  });
});
```

Add the top-of-file import if not present (the existing test only imports `ComputeResponseWire`); the new `describe` block imports `encodeRequest` and the two response types shown above.

Append to `electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts` (inside the existing top-level `describe("SidecarSupervisor", …)` block, reusing its `makeSupervisor`/`readRequests` helpers):

```typescript
  it("resolves addWatchlistSymbol with a watchlist response carrying the matching id", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.addWatchlistSymbol("NSE:INFY");
    await requestsSeen;
    children[0].stdout.write(`${JSON.stringify({ type: "watchlist", id: 1, symbols: ["NSE:INFY"] })}\n`);
    const response = await pending;
    expect(response.type).toBe("watchlist");
    expect(response.symbols).toEqual(["NSE:INFY"]);
  });

  it("resolves removeWatchlistSymbol with the updated list", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.removeWatchlistSymbol("NSE:INFY");
    await requestsSeen;
    children[0].stdout.write(`${JSON.stringify({ type: "watchlist", id: 1, symbols: [] })}\n`);
    expect((await pending).symbols).toEqual([]);
  });

  it("resolves listWatchlist with the current list", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.listWatchlist();
    await requestsSeen;
    children[0].stdout.write(`${JSON.stringify({ type: "watchlist", id: 1, symbols: ["NSE:TCS"] })}\n`);
    expect((await pending).symbols).toEqual(["NSE:TCS"]);
  });

  it("resolves evaluateScanGate with a scan_gate decision", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.evaluateScanGate("NSE:INFY", {
      bullish_count: 5,
      bearish_count: 2,
      neutral_count: 10,
      weighted_vote: 0.12,
    });
    await requestsSeen;
    children[0].stdout.write(`${JSON.stringify({ type: "scan_gate", id: 1, decision: "WorthLook" })}\n`);
    expect((await pending).decision).toBe("WorthLook");
  });

  it("rejects evaluateScanGate on timeout exactly like compute (shared send path, no new timeout code)", async () => {
    const children: FakeChild[] = [];
    const spawnFn = (_command: string, _args: string[]) => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ReturnType<typeof spawnFn>;
    };
    const supervisor = new SidecarSupervisor({ binaryPath: "/fake/sidecar", lakeRoot: "/fake/lake", spawnFn, requestTimeoutMs: 20 });
    supervisor.start();
    await expect(
      supervisor.evaluateScanGate("NSE:INFY", { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 }),
    ).rejects.toThrow(/sidecar request 1 timed out after 20ms/);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `electron-app/`): `npx vitest run test/main/services/sidecar/sidecarProtocol.test.ts test/main/services/sidecar/sidecarSupervisor.test.ts`
Expected: FAIL — the new wire types and the four methods don't exist.

- [ ] **Step 3: Implement the wire mirror** — replace the union/type tail of `electron-app/src/main/services/sidecar/sidecarProtocol.ts` (from `export interface ComputeResponseWire` onward is unchanged; add the two new response interfaces before the `SidecarResponseWire` union, then replace both unions):

```typescript
export interface WatchlistResponseWire {
  type: "watchlist";
  id: number;
  symbols: string[];
  error?: string;
}

export interface ScanGateResponseWire {
  type: "scan_gate";
  id: number;
  decision: "NoChange" | "WorthLook" | "WorthAiCall";
  error?: string;
}

export type SidecarResponseWire =
  | ComputeResponseWire
  | PersistCandlesResponseWire
  | WatchlistResponseWire
  | ScanGateResponseWire;

export type SidecarRequestWire =
  | { type: "compute"; id: number; symbol: string; timeframe: string; closes: number[] }
  | { type: "persist_candles"; id: number; symbol: string; timeframe: string; source: string; candles: CandleWire[] }
  | { type: "add_watchlist_symbol"; id: number; symbol: string }
  | { type: "remove_watchlist_symbol"; id: number; symbol: string }
  | { type: "list_watchlist"; id: number }
  | { type: "evaluate_scan_gate"; id: number; symbol: string; confluence: ConfluenceWire };

export function encodeRequest(request: SidecarRequestWire): string {
  return `${JSON.stringify(request)}\n`;
}
```

- [ ] **Step 4: Implement the four supervisor methods** — in `electron-app/src/main/services/sidecar/sidecarSupervisor.ts`, add the new wire types to the top import from `./sidecarProtocol` (`ConfluenceWire`, `ScanGateResponseWire`, `WatchlistResponseWire`), then add the four methods after `persistCandles`:

```typescript
  addWatchlistSymbol(symbol: string): Promise<WatchlistResponseWire> {
    return this.send({ type: "add_watchlist_symbol", id: this.nextId, symbol }) as Promise<WatchlistResponseWire>;
  }

  removeWatchlistSymbol(symbol: string): Promise<WatchlistResponseWire> {
    return this.send({ type: "remove_watchlist_symbol", id: this.nextId, symbol }) as Promise<WatchlistResponseWire>;
  }

  listWatchlist(): Promise<WatchlistResponseWire> {
    return this.send({ type: "list_watchlist", id: this.nextId }) as Promise<WatchlistResponseWire>;
  }

  evaluateScanGate(symbol: string, confluence: ConfluenceWire): Promise<ScanGateResponseWire> {
    return this.send({ type: "evaluate_scan_gate", id: this.nextId, symbol, confluence }) as Promise<ScanGateResponseWire>;
  }
```

The import line becomes:

```typescript
import {
  CandleWire,
  ComputeResponseWire,
  ConfluenceWire,
  PersistCandlesResponseWire,
  ScanGateResponseWire,
  SidecarRequestWire,
  SidecarResponseWire,
  WatchlistResponseWire,
  encodeRequest,
} from "./sidecarProtocol";
```

- [ ] **Step 5: Run tests + typecheck to verify they pass**

Run (from `electron-app/`): `npx vitest run test/main/services/sidecar/ && npm run typecheck`
Expected: PASS (existing supervisor/protocol tests plus the new ones); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/services/sidecar/sidecarProtocol.ts electron-app/src/main/services/sidecar/sidecarSupervisor.ts electron-app/test/main/services/sidecar/sidecarProtocol.test.ts electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts
git commit -m "feat(sidecar-ts): mirror watchlist + scan-gate wire shapes and supervisor methods"
```

---

### Task 6: `watchlistInstrumentResolver.ts` — never-cache-token symbol resolution

A new main-process module that re-resolves a watchlist symbol string into a live `InstrumentSelection` fresh from Kite on every call (§5.1: instrument identity must never be persisted via a cacheable `instrument_token` — F&O tokens recycle every expiry). It deliberately **duplicates** `renderer/instrumentParsing.ts`'s MCP-response parsing rather than importing it, because that file lives under the `renderer` build target and this lives under `main` — the same "mirror small pure shape logic at a boundary" precedent as `ConfluenceWire`. Independent task (no phase-5d deps beyond the existing `KiteClient`/`InstrumentSelection`).

**Files:**
- Create: `electron-app/src/main/services/kite/watchlistInstrumentResolver.ts`
- Create: `electron-app/test/main/services/kite/watchlistInstrumentResolver.test.ts`

**Interfaces:**
- Consumes: `KiteClient` (as `Pick<KiteClient, "searchInstruments">`), `InstrumentSelection` (`../analysis/analysisEnvelope`).
- Produces:
  - `parseWatchlistSymbol(symbol: string): { exchange: string; tradingsymbol: string } | null`
  - `resolveWatchlistInstrument(kite: Pick<KiteClient, "searchInstruments">, symbol: string): Promise<InstrumentSelection | null>`

- [ ] **Step 1: Write the failing test** — create `electron-app/test/main/services/kite/watchlistInstrumentResolver.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import {
  parseWatchlistSymbol,
  resolveWatchlistInstrument,
} from "../../../../src/main/services/kite/watchlistInstrumentResolver";

describe("parseWatchlistSymbol", () => {
  it("splits a well-formed exchange:tradingsymbol", () => {
    expect(parseWatchlistSymbol("NSE:INFY")).toEqual({ exchange: "NSE", tradingsymbol: "INFY" });
  });

  it("rejects malformed inputs", () => {
    expect(parseWatchlistSymbol("NOEXCHANGE")).toBeNull();
    expect(parseWatchlistSymbol(":INFY")).toBeNull();
    expect(parseWatchlistSymbol("NSE:")).toBeNull();
    expect(parseWatchlistSymbol("")).toBeNull();
  });
});

describe("resolveWatchlistInstrument", () => {
  it("picks the exact (exchange, tradingsymbol) match out of a multi-result response", async () => {
    const kite = {
      searchInstruments: vi.fn().mockResolvedValue({
        data: [
          { tradingsymbol: "INFY", exchange: "BSE", segment: "BSE", instrument_token: 111 },
          { tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 },
        ],
      }),
    };
    const instrument = await resolveWatchlistInstrument(kite, "NSE:INFY");
    expect(kite.searchInstruments).toHaveBeenCalledWith("INFY");
    expect(instrument).toEqual({ symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" });
  });

  it("parses the MCP CallToolResult text-content shape", async () => {
    const kite = {
      searchInstruments: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify([{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }]) }],
      }),
    };
    expect((await resolveWatchlistInstrument(kite, "NSE:INFY"))?.instrumentToken).toBe("408065");
  });

  it("returns null when no candidate's (exchange, tradingsymbol) matches", async () => {
    const kite = {
      searchInstruments: vi.fn().mockResolvedValue({ data: [{ tradingsymbol: "INFY", exchange: "BSE", segment: "BSE", instrument_token: 111 }] }),
    };
    expect(await resolveWatchlistInstrument(kite, "NSE:INFY")).toBeNull();
  });

  it("returns null for a malformed symbol without calling Kite", async () => {
    const kite = { searchInstruments: vi.fn() };
    expect(await resolveWatchlistInstrument(kite, "NOEXCHANGE")).toBeNull();
    expect(kite.searchInstruments).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `electron-app/`): `npx vitest run test/main/services/kite/watchlistInstrumentResolver.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement `watchlistInstrumentResolver.ts`** — create `electron-app/src/main/services/kite/watchlistInstrumentResolver.ts`:

```typescript
import type { KiteClient } from "./kiteClient";
import type { InstrumentSelection } from "../analysis/analysisEnvelope";

interface RawInstrument {
  tradingsymbol?: string;
  symbol?: string;
  exchange?: string;
  segment?: string;
  instrument_token?: number | string;
}

export function parseWatchlistSymbol(symbol: string): { exchange: string; tradingsymbol: string } | null {
  const separatorIndex = symbol.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === symbol.length - 1) return null;
  return { exchange: symbol.slice(0, separatorIndex), tradingsymbol: symbol.slice(separatorIndex + 1) };
}

// Deliberately duplicated from renderer/instrumentParsing.ts (parseInstruments):
// that file lives under the `renderer` build target and this under `main`, two
// separate electron-vite targets. Mirroring the small pure parser at the
// boundary is the same precedent ConfluenceWire follows against ScorecardSummary,
// not an accidental fork.
function textContentPayload(raw: unknown): unknown {
  const content = (raw as { content?: unknown })?.content;
  if (!Array.isArray(content)) return undefined;
  const textPart = content.find(
    (part): part is { type: string; text: string } =>
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string",
  );
  if (!textPart) return undefined;
  try {
    return JSON.parse(textPart.text);
  } catch {
    return undefined;
  }
}

function extractInstrumentList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const withData = (raw as { data?: unknown })?.data;
  if (Array.isArray(withData)) return withData;
  const parsed = textContentPayload(raw);
  if (Array.isArray(parsed)) return parsed;
  const parsedData = (parsed as { data?: unknown })?.data;
  if (Array.isArray(parsedData)) return parsedData;
  return [];
}

function extractInstrumentCandidates(raw: unknown): InstrumentSelection[] {
  return extractInstrumentList(raw)
    .map((entry) => {
      const row = entry as RawInstrument | null | undefined;
      const tradingsymbol = String(row?.tradingsymbol ?? row?.symbol ?? "");
      const exchange = String(row?.exchange ?? "");
      return {
        symbol: exchange && tradingsymbol ? `${exchange}:${tradingsymbol}` : tradingsymbol,
        exchange,
        segment: String(row?.segment ?? ""),
        instrumentToken: String(row?.instrument_token ?? ""),
      };
    })
    .filter((instrument) => instrument.symbol.length > 0 && instrument.instrumentToken.length > 0);
}

export async function resolveWatchlistInstrument(
  kite: Pick<KiteClient, "searchInstruments">,
  symbol: string,
): Promise<InstrumentSelection | null> {
  const parsed = parseWatchlistSymbol(symbol);
  if (!parsed) return null;
  const raw = await kite.searchInstruments(parsed.tradingsymbol);
  const candidates = extractInstrumentCandidates(raw);
  return candidates.find((candidate) => candidate.symbol === symbol) ?? null;
}
```

- [ ] **Step 4: Run test + typecheck to verify they pass**

Run (from `electron-app/`): `npx vitest run test/main/services/kite/watchlistInstrumentResolver.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/kite/watchlistInstrumentResolver.ts electron-app/test/main/services/kite/watchlistInstrumentResolver.test.ts
git commit -m "feat(kite): watchlistInstrumentResolver resolves symbols fresh, never caching tokens"
```

---

### Task 7: `historyStore.ts` — `ScanConfig` singleton table + accessors

Add `ScanConfig` persistence to `HistoryStore`'s existing `history.sqlite3` (not a new file): a single-row `scan_config` table (`CHECK (id = 1)`), seeded idempotently at open, with `getScanConfig`/`setScanConfig`. `ScanConfig` is Electron-side UI preference state, not deterministic-engine state, so it belongs here rather than in the Rust `state.sqlite3`. Real `better-sqlite3` in tests — DB-touching, so prefix runs with `npm rebuild better-sqlite3`. Independent task.

**Files:**
- Modify: `electron-app/src/main/services/history/historyStore.ts`
- Modify: `electron-app/test/main/services/history/historyStore.test.ts`

**Interfaces:**
- Consumes: the existing `HistoryStore` constructor DDL block, `this.db`.
- Produces:
  - `export type ScanIntervalMinutes = 5 | 15 | 30 | 60;`
  - `export interface ScanConfig { enabled: boolean; intervalMinutes: ScanIntervalMinutes; }`
  - `export const DEFAULT_SCAN_CONFIG: ScanConfig = { enabled: false, intervalMinutes: 15 };`
  - `HistoryStore.getScanConfig(): ScanConfig`, `HistoryStore.setScanConfig(config: ScanConfig): void`.

- [ ] **Step 1: Write the failing tests** — append to `electron-app/test/main/services/history/historyStore.test.ts` (the file already imports `HistoryStore`, `tempDbPath`, `monotonicNow`, `memoryStore`):

```typescript
import { DEFAULT_SCAN_CONFIG } from "../../../../src/main/services/history/historyStore";

describe("HistoryStore scan_config", () => {
  it("returns the seeded default on a fresh database", () => {
    const store = memoryStore();
    expect(store.getScanConfig()).toEqual({ enabled: false, intervalMinutes: 15 });
    expect(DEFAULT_SCAN_CONFIG).toEqual({ enabled: false, intervalMinutes: 15 });
    store.close();
  });

  it("round-trips setScanConfig through getScanConfig", () => {
    const store = memoryStore();
    store.setScanConfig({ enabled: true, intervalMinutes: 30 });
    expect(store.getScanConfig()).toEqual({ enabled: true, intervalMinutes: 30 });
    store.close();
  });

  it("does not reset or duplicate the singleton row when re-opened against the same file", () => {
    const dbPath = tempDbPath();
    const first = new HistoryStore({ path: dbPath, now: monotonicNow() });
    first.setScanConfig({ enabled: true, intervalMinutes: 60 });
    first.close();

    const second = new HistoryStore({ path: dbPath, now: monotonicNow() });
    // INSERT OR IGNORE on re-open must not clobber the persisted value back to default.
    expect(second.getScanConfig()).toEqual({ enabled: true, intervalMinutes: 60 });
    second.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `electron-app/`): `npm rebuild better-sqlite3 && npx vitest run test/main/services/history/historyStore.test.ts`
Expected: FAIL — `getScanConfig`/`setScanConfig`/`DEFAULT_SCAN_CONFIG` don't exist.

- [ ] **Step 3: Implement** — in `electron-app/src/main/services/history/historyStore.ts`, add the types after `HistoryStoreOptions`:

```typescript
export type ScanIntervalMinutes = 5 | 15 | 30 | 60;

export interface ScanConfig {
  enabled: boolean;
  intervalMinutes: ScanIntervalMinutes;
}

export const DEFAULT_SCAN_CONFIG: ScanConfig = { enabled: false, intervalMinutes: 15 };
```

Extend the constructor's `this.db.exec(...)` DDL string to add the `scan_config` table and its idempotent seed (append inside the same backtick block, after the two `CREATE INDEX` lines):

```typescript
       CREATE INDEX IF NOT EXISTS sessions_last_active_at_idx ON sessions(last_active_at);
       CREATE TABLE IF NOT EXISTS scan_config (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         enabled INTEGER NOT NULL DEFAULT 0,
         interval_minutes INTEGER NOT NULL DEFAULT 15
       );
       INSERT OR IGNORE INTO scan_config (id, enabled, interval_minutes) VALUES (1, 0, 15);`,
```

Add the two methods before `close()`:

```typescript
  getScanConfig(): ScanConfig {
    const row = this.db.prepare("SELECT enabled, interval_minutes FROM scan_config WHERE id = 1").get() as {
      enabled: number;
      interval_minutes: number;
    };
    return { enabled: row.enabled === 1, intervalMinutes: row.interval_minutes as ScanIntervalMinutes };
  }

  setScanConfig(config: ScanConfig): void {
    this.db
      .prepare("UPDATE scan_config SET enabled = ?, interval_minutes = ? WHERE id = 1")
      .run(config.enabled ? 1 : 0, config.intervalMinutes);
  }
```

- [ ] **Step 4: Run tests + typecheck to verify they pass**

Run (from `electron-app/`): `npm rebuild better-sqlite3 && npx vitest run test/main/services/history/historyStore.test.ts && npm run typecheck`
Expected: PASS (all pre-existing HistoryStore tests plus the three new scan_config tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/history/historyStore.ts electron-app/test/main/services/history/historyStore.test.ts
git commit -m "feat(history): persist ScanConfig as a singleton scan_config row"
```

---

### Task 8: `scanScheduler.ts` — the tick algorithm

The heart of the phase: an opt-in, interval-driven scheduler that, per tick, lists the watchlist, then for each symbol re-resolves its live instrument, assembles the envelope via the exact existing path, calls the gate, and acts on the 3-way decision (`NoChange` = nothing; `WorthLook` = deterministic + notify + persist as a new engine_only session; `WorthAiCall` = full AI-Assisted pipeline via `completeAiAssisted`, skipping intake, + notify + persist as a new ai_assisted session). Fixed scheduler-wide `SCAN_HORIZON`/`SCAN_INTENT_LENS` constants (not per-entry). Tests use fake sidecar/kite/provider/history/notify doubles + an injected fake clock/timer — no real timers, Kite, Claude, or sidecar process. Depends on Tasks 5 (supervisor methods), 6 (resolver), 7 (`ScanConfig`).

**Safety note (must appear in this task's review):** the `WorthAiCall` path calls `provider.completeAiAssisted(envelope, { onNarrativeToken, claudeSessionId, resumeSession })` — the identical `AiAssistedProvider` call AI-Assisted mode already uses. No new tool grant, no Kite write, no new subprocess-spawning path. The user message is written before the AI call and left orphaned on failure (the accepted behavior), and `setClaudeSessionId` is called only after success.

**Files:**
- Create: `electron-app/src/main/scanScheduler.ts`
- Create: `electron-app/test/main/scanScheduler.test.ts`

**Interfaces:**
- Consumes: `SidecarSupervisor` (`Pick<…, "compute" | "persistCandles" | "listWatchlist" | "evaluateScanGate">`), `KiteClient`, `AiAssistedProvider`, `HistoryStore` (`Pick<…, "createSession" | "appendMessage" | "getClaudeSessionId" | "setClaudeSessionId">`), `ScanConfig` (Task 7), `resolveWatchlistInstrument` (Task 6), `assembleEnvelope`, `horizonToFetchParams`, `generateDeterministicResponse`, `AnalysisEnvelope`, `AnalysisResult`, `Horizon`, `IntentLens`, `randomUUID`.
- Produces:
  - `export interface ScanSchedulerDeps { … }` (exact shape below).
  - `export interface ScanTriggerPayload { trigger: "proactive_scan"; symbol: string; horizon: Horizon; intent_lens: IntentLens; }`
  - `export class ScanScheduler` with `constructor(deps: ScanSchedulerDeps, initialConfig: ScanConfig)`, `getConfig(): ScanConfig`, `setConfig(config: ScanConfig): void`, `stop(): void`, `tick(): Promise<void>`.

- [ ] **Step 1: Write the failing tests** — create `electron-app/test/main/scanScheduler.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { ScanScheduler, type ScanSchedulerDeps } from "../../src/main/scanScheduler";
import type { ScanConfig } from "../../src/main/services/history/historyStore";
import { historicalResponse } from "../fixtures/sidecarFixtures";

type Decision = "NoChange" | "WorthLook" | "WorthAiCall";

function computeResult() {
  return {
    type: "compute" as const,
    id: 1,
    algo_results: [
      { algo_id: "rsi", symbol: "NSE:INFY", timeframe: "5minute", horizon: "intraday", direction: "Bullish", magnitude: 0.4, confidence: 0.6, evidence: ["RSI 62"], computed_at: "2026-07-27T00:00:00+00:00" },
    ],
    confluence: { bullish_count: 8, bearish_count: 1, neutral_count: 2, weighted_vote: 0.5 },
  };
}

function searchResult(exchange: string, tradingsymbol: string, token: number) {
  return { data: [{ tradingsymbol, exchange, segment: exchange, instrument_token: token }] };
}

interface HarnessOptions {
  config?: ScanConfig;
  watchlist?: string[];
  decision?: Decision;
  kiteLoggedIn?: boolean;
  completeAiAssisted?: ScanSchedulerDeps["provider"]["completeAiAssisted"];
  computeImpl?: () => Promise<ReturnType<typeof computeResult>>;
  listWatchlistImpl?: () => Promise<{ type: "watchlist"; id: number; symbols: string[] }>;
  searchImpl?: (query: string) => Promise<unknown>;
}

function makeHarness(options: HarnessOptions = {}) {
  const decision: Decision = options.decision ?? "NoChange";
  const watchlist = options.watchlist ?? ["NSE:INFY"];

  const searchInstruments = vi.fn(
    options.searchImpl ?? ((query: string) => Promise.resolve(searchResult("NSE", query, 408065))),
  );
  const getHistoricalData = vi.fn(async () => historicalResponse());
  const kite = { searchInstruments, getHistoricalData };

  const compute = vi.fn(options.computeImpl ?? (async () => computeResult()));
  const persistCandles = vi.fn(async (_s: string, _t: string, candles: { length: number }) => ({
    type: "persist_candles" as const,
    id: 1,
    written: candles.length,
  }));
  const listWatchlist = vi.fn(
    options.listWatchlistImpl ?? (async () => ({ type: "watchlist" as const, id: 1, symbols: watchlist })),
  );
  const evaluateScanGate = vi.fn(async () => ({ type: "scan_gate" as const, id: 1, decision }));
  const sidecar = { compute, persistCandles, listWatchlist, evaluateScanGate };

  const completeAiAssisted =
    options.completeAiAssisted ??
    vi.fn(async () => ({
      verdict: { direction: "bullish", conviction: "high", reasoning: "r", cited_algo_ids: ["rsi"], verify_before_acting: "check LTP" },
      narrative: "Infy looks constructive.",
    }));
  const provider = { intake: vi.fn(), completeAiAssisted };

  const createSession = vi.fn((mode: string) => ({ id: `session-${mode}`, response_mode: mode, created_at: "t", last_active_at: "t", preview: "(no messages yet)" }));
  const appendMessage = vi.fn();
  const getClaudeSessionId = vi.fn().mockReturnValue(null);
  const setClaudeSessionId = vi.fn();
  const history = { createSession, appendMessage, getClaudeSessionId, setClaudeSessionId };

  const notify = vi.fn();

  const intervals: Array<{ cb: () => void; ms: number; handle: NodeJS.Timeout }> = [];
  const cleared: NodeJS.Timeout[] = [];
  let handleCounter = 0;
  const setIntervalFn = (cb: () => void, ms: number) => {
    const handle = ++handleCounter as unknown as NodeJS.Timeout;
    intervals.push({ cb, ms, handle });
    return handle;
  };
  const clearIntervalFn = (handle: NodeJS.Timeout) => cleared.push(handle);

  const deps: ScanSchedulerDeps = {
    sidecar: sidecar as unknown as ScanSchedulerDeps["sidecar"],
    getKite: () => (options.kiteLoggedIn === false ? null : (kite as unknown as ReturnType<ScanSchedulerDeps["getKite"]>)),
    provider: provider as unknown as ScanSchedulerDeps["provider"],
    history: history as unknown as ScanSchedulerDeps["history"],
    notify,
    now: () => new Date("2026-07-27T10:00:00Z"),
    setIntervalFn,
    clearIntervalFn,
  };

  const config: ScanConfig = options.config ?? { enabled: false, intervalMinutes: 15 };
  return {
    scheduler: new ScanScheduler(deps, config),
    spies: { searchInstruments, getHistoricalData, compute, listWatchlist, evaluateScanGate, completeAiAssisted, createSession, appendMessage, getClaudeSessionId, setClaudeSessionId, notify },
    timers: { intervals, cleared },
  };
}

describe("ScanScheduler.tick", () => {
  it("does nothing when Kite is not logged in", async () => {
    const { scheduler, spies } = makeHarness({ kiteLoggedIn: false });
    await scheduler.tick();
    expect(spies.listWatchlist).not.toHaveBeenCalled();
  });

  it("processes watchlist symbols sequentially, not concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const computeImpl = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return computeResult();
    };
    const { scheduler } = makeHarness({ watchlist: ["NSE:INFY", "NSE:TCS"], computeImpl });
    await scheduler.tick();
    expect(maxInFlight).toBe(1);
  });

  it("a NoChange decision writes nothing to history and does not notify", async () => {
    const { scheduler, spies } = makeHarness({ decision: "NoChange" });
    await scheduler.tick();
    expect(spies.createSession).not.toHaveBeenCalled();
    expect(spies.appendMessage).not.toHaveBeenCalled();
    expect(spies.notify).not.toHaveBeenCalled();
  });

  it("a WorthLook decision creates an engine_only session, appends both messages with a proactive_scan trigger, and notifies", async () => {
    const { scheduler, spies } = makeHarness({ decision: "WorthLook" });
    await scheduler.tick();
    expect(spies.createSession).toHaveBeenCalledWith("engine_only");
    expect(spies.appendMessage).toHaveBeenCalledTimes(2);
    const userTurn = spies.appendMessage.mock.calls[0][0];
    expect(userTurn.role).toBe("user");
    expect(userTurn.structuredPayload).toEqual({ trigger: "proactive_scan", symbol: "NSE:INFY", horizon: "intraday", intent_lens: "buying" });
    const assistantTurn = spies.appendMessage.mock.calls[1][0];
    expect(assistantTurn.role).toBe("assistant");
    const notifyBody = spies.notify.mock.calls[0][1];
    expect(assistantTurn.renderedText.split("\n")[0]).toBe(notifyBody);
    expect(spies.completeAiAssisted).not.toHaveBeenCalled();
  });

  it("a WorthAiCall decision creates an ai_assisted session, calls completeAiAssisted with a fresh claudeSessionId and resumeSession false, and persists claude_session_id only after success", async () => {
    const { scheduler, spies } = makeHarness({ decision: "WorthAiCall" });
    await scheduler.tick();
    expect(spies.createSession).toHaveBeenCalledWith("ai_assisted");
    expect(spies.completeAiAssisted).toHaveBeenCalledTimes(1);
    const opts = spies.completeAiAssisted.mock.calls[0][1];
    expect(opts.resumeSession).toBe(false);
    expect(typeof opts.claudeSessionId).toBe("string");
    expect(opts.claudeSessionId.length).toBeGreaterThan(0);
    expect(spies.setClaudeSessionId).toHaveBeenCalledWith("session-ai_assisted", opts.claudeSessionId);
    expect(spies.notify).toHaveBeenCalledTimes(1);
  });

  it("a WorthAiCall failure leaves the user message orphaned and never calls setClaudeSessionId", async () => {
    const completeAiAssisted = vi.fn().mockRejectedValue(new Error("claude failed"));
    const { scheduler, spies } = makeHarness({ decision: "WorthAiCall", completeAiAssisted });
    await scheduler.tick();
    expect(spies.appendMessage).toHaveBeenCalledTimes(1);
    expect(spies.appendMessage.mock.calls[0][0].role).toBe("user");
    expect(spies.setClaudeSessionId).not.toHaveBeenCalled();
    expect(spies.notify).not.toHaveBeenCalled();
  });

  it("skips a symbol that fails to resolve to an instrument without aborting the rest of the tick", async () => {
    const searchImpl = (query: string) =>
      Promise.resolve(query === "INFY" ? { data: [] } : searchResult("NSE", query, 26000));
    const { scheduler, spies } = makeHarness({ decision: "WorthLook", watchlist: ["NSE:INFY", "NSE:TCS"], searchImpl });
    await scheduler.tick();
    // INFY resolved to nothing (skipped); TCS still produced a session.
    expect(spies.createSession).toHaveBeenCalledTimes(1);
    expect(spies.evaluateScanGate).toHaveBeenCalledWith("NSE:TCS", expect.anything());
  });

  it("does not let an error processing one symbol stop the next symbol", async () => {
    let call = 0;
    const computeImpl = async () => {
      call += 1;
      if (call === 1) throw new Error("compute blew up for the first symbol");
      return computeResult();
    };
    const { scheduler, spies } = makeHarness({ decision: "WorthLook", watchlist: ["NSE:INFY", "NSE:TCS"], computeImpl });
    await scheduler.tick();
    expect(spies.createSession).toHaveBeenCalledTimes(1);
  });
});

describe("ScanScheduler timer control", () => {
  it("setConfig restarts the interval, clearing the previous timer and scheduling a new one at the new period", () => {
    const { scheduler, timers } = makeHarness({ config: { enabled: true, intervalMinutes: 15 } });
    expect(timers.intervals).toHaveLength(1);
    expect(timers.intervals[0].ms).toBe(15 * 60_000);
    const firstHandle = timers.intervals[0].handle;

    scheduler.setConfig({ enabled: true, intervalMinutes: 30 });
    expect(timers.cleared).toContain(firstHandle);
    expect(timers.intervals).toHaveLength(2);
    expect(timers.intervals[1].ms).toBe(30 * 60_000);
    expect(scheduler.getConfig()).toEqual({ enabled: true, intervalMinutes: 30 });
  });

  it("does not schedule a timer while scanning is disabled", () => {
    const { timers } = makeHarness({ config: { enabled: false, intervalMinutes: 15 } });
    expect(timers.intervals).toHaveLength(0);
  });

  it("skips an overlapping tick while one is already in flight", async () => {
    let resolveList: (value: { type: "watchlist"; id: number; symbols: string[] }) => void = () => {};
    const listWatchlistImpl = () =>
      new Promise<{ type: "watchlist"; id: number; symbols: string[] }>((resolve) => {
        resolveList = resolve;
      });
    const { scheduler, spies } = makeHarness({ listWatchlistImpl });
    const first = scheduler.tick();
    const second = scheduler.tick();
    resolveList({ type: "watchlist", id: 1, symbols: [] });
    await Promise.all([first, second]);
    expect(spies.listWatchlist).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `electron-app/`): `npx vitest run test/main/scanScheduler.test.ts`
Expected: FAIL — `scanScheduler` module does not exist.

- [ ] **Step 3: Implement `scanScheduler.ts`** — create `electron-app/src/main/scanScheduler.ts`:

```typescript
import { randomUUID } from "node:crypto";
import type { SidecarSupervisor } from "./services/sidecar/sidecarSupervisor";
import type { KiteClient } from "./services/kite/kiteClient";
import type { AiAssistedProvider } from "./services/claude/provider";
import type { HistoryStore, ScanConfig } from "./services/history/historyStore";
import { resolveWatchlistInstrument } from "./services/kite/watchlistInstrumentResolver";
import { assembleEnvelope } from "./services/analysis/analysisEnvelope";
import type { AnalysisEnvelope, IntentLens } from "./services/analysis/contracts";
import { generateDeterministicResponse } from "./services/analysis/deterministicResponseGenerator";
import { horizonToFetchParams } from "./services/analysis/horizonFetchParams";
import type { AnalysisResult, Horizon } from "./ipc/rendererApi";

const SCAN_HORIZON: Horizon = "intraday";
const SCAN_INTENT_LENS: IntentLens = "buying";

export interface ScanSchedulerDeps {
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles" | "listWatchlist" | "evaluateScanGate">;
  getKite: () => KiteClient | null;
  provider: AiAssistedProvider;
  history: Pick<HistoryStore, "createSession" | "appendMessage" | "getClaudeSessionId" | "setClaudeSessionId">;
  notify: (title: string, body: string) => void;
  now?: () => Date;
  setIntervalFn?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
}

export interface ScanTriggerPayload {
  trigger: "proactive_scan";
  symbol: string;
  horizon: Horizon;
  intent_lens: IntentLens;
}

function describeScanTrigger(symbol: string): string {
  return `Proactive scan: ${symbol} · ${SCAN_HORIZON} · ${SCAN_INTENT_LENS}`;
}

export class ScanScheduler {
  private config: ScanConfig;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly setIntervalFn: (callback: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearIntervalFn: (handle: NodeJS.Timeout) => void;

  constructor(private readonly deps: ScanSchedulerDeps, initialConfig: ScanConfig) {
    this.config = initialConfig;
    this.setIntervalFn = deps.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn = deps.clearIntervalFn ?? ((handle) => clearInterval(handle));
    this.restart();
  }

  getConfig(): ScanConfig {
    return this.config;
  }

  setConfig(config: ScanConfig): void {
    this.config = config;
    this.restart();
  }

  stop(): void {
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  private restart(): void {
    this.stop();
    if (!this.config.enabled) return;
    this.timer = this.setIntervalFn(() => void this.tick(), this.config.intervalMinutes * 60_000);
  }

  async tick(): Promise<void> {
    // A tick slower than the interval (a large watchlist, a slow Kite call)
    // must not stack a second overlapping pass on the same symbols.
    if (this.ticking) return;
    this.ticking = true;
    try {
      const kite = this.deps.getKite();
      // Not logged in to Kite today: wait for the next tick. The scheduler never
      // itself triggers a login flow (§8.3 keeps that user-initiated).
      if (!kite) return;
      const watchlist = await this.deps.sidecar.listWatchlist();
      // Sequential, not Promise.all: Kite's historical-data limit is 3 req/sec
      // (§5.1); one symbol fully processed before the next stays under it
      // without a dedicated rate limiter this phase doesn't need yet.
      for (const symbol of watchlist.symbols) {
        await this.tickOneSymbol(kite, symbol);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async tickOneSymbol(kite: KiteClient, symbol: string): Promise<void> {
    try {
      const instrument = await resolveWatchlistInstrument(kite, symbol);
      if (!instrument) {
        console.error(`scan: could not resolve a live instrument for watchlist symbol ${symbol}`);
        return;
      }
      const now = this.deps.now?.() ?? new Date();
      const { timeframe, from, to } = horizonToFetchParams(SCAN_HORIZON, now);
      const envelope = await assembleEnvelope(
        { kite, sidecar: this.deps.sidecar },
        { trigger: "proactive_scan", instrument, timeframe, horizon_requested: SCAN_HORIZON, intent_lens: SCAN_INTENT_LENS, from, to },
      );
      const gate = await this.deps.sidecar.evaluateScanGate(symbol, envelope.confluence);
      if (gate.decision === "NoChange") return;
      if (gate.decision === "WorthLook") {
        await this.recordWorthLook(symbol, envelope);
        return;
      }
      await this.recordWorthAiCall(symbol, envelope);
    } catch (error) {
      // One symbol's failure (a delisted instrument, a transient Kite error)
      // must not take the rest of this tick's watchlist down with it -- the same
      // per-unit isolation as the sidecar's own catch_unwind.
      console.error(`scan: tick failed for ${symbol}: ${(error as Error).message}`);
    }
  }

  private async recordWorthLook(symbol: string, envelope: AnalysisEnvelope): Promise<void> {
    const response = generateDeterministicResponse(envelope);
    const result: AnalysisResult = {
      mode: "engine_only",
      instrument: envelope.instrument,
      horizon: SCAN_HORIZON,
      response,
      algo_results: envelope.algo_results,
    };
    const session = this.deps.history.createSession("engine_only");
    this.deps.history.appendMessage({
      sessionId: session.id,
      role: "user",
      renderedText: describeScanTrigger(symbol),
      structuredPayload: { trigger: "proactive_scan", symbol, horizon: SCAN_HORIZON, intent_lens: SCAN_INTENT_LENS } satisfies ScanTriggerPayload,
    });
    this.deps.history.appendMessage({
      sessionId: session.id,
      role: "assistant",
      renderedText: response.text,
      structuredPayload: result,
    });
    this.deps.notify(`${symbol} — worth a look`, response.text.split("\n")[0]);
  }

  private async recordWorthAiCall(symbol: string, envelope: AnalysisEnvelope): Promise<void> {
    const session = this.deps.history.createSession("ai_assisted");
    this.deps.history.appendMessage({
      sessionId: session.id,
      role: "user",
      renderedText: describeScanTrigger(symbol),
      structuredPayload: { trigger: "proactive_scan", symbol, horizon: SCAN_HORIZON, intent_lens: SCAN_INTENT_LENS } satisfies ScanTriggerPayload,
    });
    const claudeSessionId = randomUUID();
    const { verdict, narrative } = await this.deps.provider.completeAiAssisted(envelope, {
      onNarrativeToken: () => {},
      claudeSessionId,
      resumeSession: false,
    });
    this.deps.history.setClaudeSessionId(session.id, claudeSessionId);
    const result: AnalysisResult = {
      mode: "ai_assisted",
      instrument: envelope.instrument,
      horizon: SCAN_HORIZON,
      intent_lens: SCAN_INTENT_LENS,
      verdict,
      narrative,
      algo_results: envelope.algo_results,
      confluence: envelope.confluence,
    };
    this.deps.history.appendMessage({ sessionId: session.id, role: "assistant", renderedText: narrative, structuredPayload: result });
    this.deps.notify(`${symbol} — AI take ready`, `${verdict.direction} (${verdict.conviction} conviction)`);
  }
}
```

- [ ] **Step 4: Run tests + typecheck to verify they pass**

Run (from `electron-app/`): `npx vitest run test/main/scanScheduler.test.ts && npm run typecheck`
Expected: PASS (all ten scheduler tests + three timer-control tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/scanScheduler.ts electron-app/test/main/scanScheduler.test.ts
git commit -m "feat(scan): ScanScheduler tick reusing the envelope/deterministic/AI pipeline"
```

---

### Task 9: `SettingsApi` + `buildSettingsApi` + `settingsBridge.ts` — the Settings IPC contract

Add the second renderer API (`SettingsApi`/`buildSettingsApi`) and the `ScanConfig` re-export to `rendererApi.ts` (the main window's `RendererApi`/`buildRendererApi` are **unchanged**), plus the `settingsBridge.ts` registrar mirroring `historyBridge.ts`'s DI pattern. `settings:setScanConfig` both persists (`history.setScanConfig`) and applies to the live scheduler (`scanScheduler.setConfig`). `searchInstruments` deliberately routes through the existing process-global `kite:searchInstruments` channel — no settings-scoped duplicate. Depends on Task 7 (`ScanConfig`) and Task 8 (`ScanScheduler` type for the `Pick`).

**Files:**
- Modify: `electron-app/src/main/ipc/rendererApi.ts`
- Create: `electron-app/src/main/ipc/settingsBridge.ts`
- Modify: `electron-app/test/main/ipc/rendererApi.test.ts`
- Create: `electron-app/test/main/ipc/settingsBridge.test.ts`

**Interfaces:**
- Consumes: `ScanConfig` (Task 7), `AppStatus` (existing), `HistoryStore` (Task 7 methods), `ScanScheduler` (Task 8), `SidecarSupervisor` (Task 5 methods), `IpcMain`.
- Produces:
  - `rendererApi.ts`: `export type { ScanConfig, ScanIntervalMinutes } from "../services/history/historyStore";`, `interface SettingsApi { … }`, `function buildSettingsApi(invoke): SettingsApi`.
  - `settingsBridge.ts`: `interface SettingsBridgeDeps { … }`, `function registerSettingsBridge(deps): void`.

- [ ] **Step 1: Write the failing tests** — append a `buildSettingsApi` block to `electron-app/test/main/ipc/rendererApi.test.ts` (the existing "nine bridge methods" test for `buildRendererApi` stays untouched; add the import at the top of the new block):

```typescript
import { buildSettingsApi } from "../../../src/main/ipc/rendererApi";

describe("buildSettingsApi", () => {
  it("routes each Settings channel to the right ipc name", async () => {
    const invoke = vi.fn().mockResolvedValue({});
    const api = buildSettingsApi(invoke);

    await api.getScanConfig();
    expect(invoke).toHaveBeenCalledWith("settings:getScanConfig");

    await api.setScanConfig({ enabled: true, intervalMinutes: 30 });
    expect(invoke).toHaveBeenCalledWith("settings:setScanConfig", { enabled: true, intervalMinutes: 30 });

    await api.listWatchlist();
    expect(invoke).toHaveBeenCalledWith("settings:listWatchlist");

    await api.addWatchlistSymbol("NSE:INFY");
    expect(invoke).toHaveBeenCalledWith("settings:addWatchlistSymbol", { symbol: "NSE:INFY" });

    await api.removeWatchlistSymbol("NSE:INFY");
    expect(invoke).toHaveBeenCalledWith("settings:removeWatchlistSymbol", { symbol: "NSE:INFY" });

    await api.getAccountStatus();
    expect(invoke).toHaveBeenCalledWith("settings:getAccountStatus");

    await api.searchInstruments("infy");
    expect(invoke).toHaveBeenCalledWith("kite:searchInstruments", { query: "infy" });
  });
});
```

Create `electron-app/test/main/ipc/settingsBridge.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { registerSettingsBridge } from "../../../src/main/ipc/settingsBridge";

function harness(deps: {
  history: { getScanConfig: ReturnType<typeof vi.fn>; setScanConfig: ReturnType<typeof vi.fn> };
  scanScheduler: { setConfig: ReturnType<typeof vi.fn> };
  sidecar: { listWatchlist: ReturnType<typeof vi.fn>; addWatchlistSymbol: ReturnType<typeof vi.fn>; removeWatchlistSymbol: ReturnType<typeof vi.fn> };
  getStatus: ReturnType<typeof vi.fn>;
}) {
  const handlers = new Map<string, (event: unknown, arg: unknown) => unknown>();
  registerSettingsBridge({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn as never) } as never,
    history: deps.history as never,
    scanScheduler: deps.scanScheduler as never,
    sidecar: deps.sidecar as never,
    getStatus: deps.getStatus,
  });
  return handlers;
}

describe("registerSettingsBridge", () => {
  it("returns the current config for settings:getScanConfig", () => {
    const config = { enabled: false, intervalMinutes: 15 };
    const handlers = harness({
      history: { getScanConfig: vi.fn().mockReturnValue(config), setScanConfig: vi.fn() },
      scanScheduler: { setConfig: vi.fn() },
      sidecar: { listWatchlist: vi.fn(), addWatchlistSymbol: vi.fn(), removeWatchlistSymbol: vi.fn() },
      getStatus: vi.fn(),
    });
    expect(handlers.get("settings:getScanConfig")!(null, undefined)).toBe(config);
  });

  it("settings:setScanConfig persists, applies to the scheduler, and returns the freshly-read config", () => {
    const setScanConfig = vi.fn();
    const getScanConfig = vi.fn().mockReturnValue({ enabled: true, intervalMinutes: 30 });
    const setConfig = vi.fn();
    const handlers = harness({
      history: { getScanConfig, setScanConfig },
      scanScheduler: { setConfig },
      sidecar: { listWatchlist: vi.fn(), addWatchlistSymbol: vi.fn(), removeWatchlistSymbol: vi.fn() },
      getStatus: vi.fn(),
    });
    const result = handlers.get("settings:setScanConfig")!(null, { enabled: true, intervalMinutes: 30 });
    expect(setScanConfig).toHaveBeenCalledWith({ enabled: true, intervalMinutes: 30 });
    expect(setConfig).toHaveBeenCalledWith({ enabled: true, intervalMinutes: 30 });
    expect(result).toEqual({ enabled: true, intervalMinutes: 30 });
  });

  it("unwraps .symbols from the sidecar for list/add/remove", async () => {
    const handlers = harness({
      history: { getScanConfig: vi.fn(), setScanConfig: vi.fn() },
      scanScheduler: { setConfig: vi.fn() },
      sidecar: {
        listWatchlist: vi.fn().mockResolvedValue({ type: "watchlist", id: 1, symbols: ["NSE:INFY"] }),
        addWatchlistSymbol: vi.fn().mockResolvedValue({ type: "watchlist", id: 2, symbols: ["NSE:INFY", "NSE:TCS"] }),
        removeWatchlistSymbol: vi.fn().mockResolvedValue({ type: "watchlist", id: 3, symbols: [] }),
      },
      getStatus: vi.fn(),
    });
    expect(await handlers.get("settings:listWatchlist")!(null, undefined)).toEqual(["NSE:INFY"]);
    expect(await handlers.get("settings:addWatchlistSymbol")!(null, { symbol: "NSE:TCS" })).toEqual(["NSE:INFY", "NSE:TCS"]);
    expect(await handlers.get("settings:removeWatchlistSymbol")!(null, { symbol: "NSE:INFY" })).toEqual([]);
  });

  it("returns the status object for settings:getAccountStatus", () => {
    const status = { sidecar: "up", kiteSession: "authenticated", driftWarning: null };
    const handlers = harness({
      history: { getScanConfig: vi.fn(), setScanConfig: vi.fn() },
      scanScheduler: { setConfig: vi.fn() },
      sidecar: { listWatchlist: vi.fn(), addWatchlistSymbol: vi.fn(), removeWatchlistSymbol: vi.fn() },
      getStatus: vi.fn().mockReturnValue(status),
    });
    expect(handlers.get("settings:getAccountStatus")!(null, undefined)).toBe(status);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `electron-app/`): `npx vitest run test/main/ipc/rendererApi.test.ts test/main/ipc/settingsBridge.test.ts`
Expected: FAIL — `buildSettingsApi` and `registerSettingsBridge` don't exist.

- [ ] **Step 3: Implement the rendererApi additions** — in `electron-app/src/main/ipc/rendererApi.ts`, add near the existing history re-export lines (top of file):

```typescript
export type { ScanConfig, ScanIntervalMinutes } from "../services/history/historyStore";
import type { ScanConfig } from "../services/history/historyStore";
```

Append at the end of the file (after `buildRendererApi`):

```typescript
export interface SettingsApi {
  getScanConfig(): Promise<ScanConfig>;
  setScanConfig(config: ScanConfig): Promise<ScanConfig>;
  listWatchlist(): Promise<string[]>;
  addWatchlistSymbol(symbol: string): Promise<string[]>;
  removeWatchlistSymbol(symbol: string): Promise<string[]>;
  getAccountStatus(): Promise<AppStatus>;
  searchInstruments(query: string): Promise<unknown>;
}

export function buildSettingsApi(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): SettingsApi {
  return {
    getScanConfig: () => invoke("settings:getScanConfig") as Promise<ScanConfig>,
    setScanConfig: (config) => invoke("settings:setScanConfig", config) as Promise<ScanConfig>,
    listWatchlist: () => invoke("settings:listWatchlist") as Promise<string[]>,
    addWatchlistSymbol: (symbol) => invoke("settings:addWatchlistSymbol", { symbol }) as Promise<string[]>,
    removeWatchlistSymbol: (symbol) => invoke("settings:removeWatchlistSymbol", { symbol }) as Promise<string[]>,
    getAccountStatus: () => invoke("settings:getAccountStatus") as Promise<AppStatus>,
    searchInstruments: (query) => invoke("kite:searchInstruments", { query }),
  };
}
```

- [ ] **Step 4: Implement `settingsBridge.ts`** — create `electron-app/src/main/ipc/settingsBridge.ts`:

```typescript
import type { IpcMain } from "electron";
import type { HistoryStore, ScanConfig } from "../services/history/historyStore";
import type { ScanScheduler } from "../scanScheduler";
import type { SidecarSupervisor } from "../services/sidecar/sidecarSupervisor";
import type { AppStatus } from "./rendererApi";

export interface SettingsBridgeDeps {
  ipcMain: Pick<IpcMain, "handle">;
  history: Pick<HistoryStore, "getScanConfig" | "setScanConfig">;
  scanScheduler: Pick<ScanScheduler, "setConfig">;
  sidecar: Pick<SidecarSupervisor, "listWatchlist" | "addWatchlistSymbol" | "removeWatchlistSymbol">;
  getStatus: () => AppStatus;
}

export function registerSettingsBridge(deps: SettingsBridgeDeps): void {
  deps.ipcMain.handle("settings:getScanConfig", () => deps.history.getScanConfig());
  deps.ipcMain.handle("settings:setScanConfig", (_event, config: ScanConfig) => {
    deps.history.setScanConfig(config);
    deps.scanScheduler.setConfig(config);
    return deps.history.getScanConfig();
  });
  deps.ipcMain.handle("settings:listWatchlist", async () => (await deps.sidecar.listWatchlist()).symbols);
  deps.ipcMain.handle("settings:addWatchlistSymbol", async (_event, args: { symbol: string }) =>
    (await deps.sidecar.addWatchlistSymbol(args.symbol)).symbols,
  );
  deps.ipcMain.handle("settings:removeWatchlistSymbol", async (_event, args: { symbol: string }) =>
    (await deps.sidecar.removeWatchlistSymbol(args.symbol)).symbols,
  );
  deps.ipcMain.handle("settings:getAccountStatus", () => deps.getStatus());
}
```

- [ ] **Step 5: Run tests + typecheck to verify they pass**

Run (from `electron-app/`): `npx vitest run test/main/ipc/rendererApi.test.ts test/main/ipc/settingsBridge.test.ts && npm run typecheck`
Expected: PASS (the existing `buildRendererApi` nine-methods test still green; the new `buildSettingsApi` + `registerSettingsBridge` tests green); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/ipc/rendererApi.ts electron-app/src/main/ipc/settingsBridge.ts electron-app/test/main/ipc/rendererApi.test.ts electron-app/test/main/ipc/settingsBridge.test.ts
git commit -m "feat(ipc): SettingsApi contract and settingsBridge registrar"
```

---

### Task 10: `appLifecycle.ts` — the pure `shouldQuitOnAllWindowsClosed` decision

Extract the `window-all-closed` quit decision as a pure, directly-testable function (the same pattern `bootstrap.ts` uses for `handleKiteResponse`), so the tray/`activate` lifecycle rework (Task 14) has a tested core. Independent — no phase-5d deps.

**Files:**
- Create: `electron-app/src/main/appLifecycle.ts`
- Create: `electron-app/test/main/appLifecycle.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function shouldQuitOnAllWindowsClosed(params: { isQuitting: boolean; scanningEnabled: boolean; platform: NodeJS.Platform }): boolean`.

- [ ] **Step 1: Write the failing test** — create `electron-app/test/main/appLifecycle.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { shouldQuitOnAllWindowsClosed } from "../../src/main/appLifecycle";

describe("shouldQuitOnAllWindowsClosed", () => {
  it("always quits when a quit is already in progress, regardless of platform or scanning", () => {
    for (const platform of ["darwin", "win32", "linux"] as NodeJS.Platform[]) {
      expect(shouldQuitOnAllWindowsClosed({ isQuitting: true, scanningEnabled: false, platform })).toBe(true);
      expect(shouldQuitOnAllWindowsClosed({ isQuitting: true, scanningEnabled: true, platform })).toBe(true);
    }
  });

  it("stays alive on every platform while scanning is enabled and no quit is in progress", () => {
    for (const platform of ["darwin", "win32", "linux"] as NodeJS.Platform[]) {
      expect(shouldQuitOnAllWindowsClosed({ isQuitting: false, scanningEnabled: true, platform })).toBe(false);
    }
  });

  it("with scanning off and no quit, quits on Windows/Linux but stays alive on macOS", () => {
    expect(shouldQuitOnAllWindowsClosed({ isQuitting: false, scanningEnabled: false, platform: "win32" })).toBe(true);
    expect(shouldQuitOnAllWindowsClosed({ isQuitting: false, scanningEnabled: false, platform: "linux" })).toBe(true);
    expect(shouldQuitOnAllWindowsClosed({ isQuitting: false, scanningEnabled: false, platform: "darwin" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `electron-app/`): `npx vitest run test/main/appLifecycle.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement `appLifecycle.ts`** — create `electron-app/src/main/appLifecycle.ts`:

```typescript
export function shouldQuitOnAllWindowsClosed(params: {
  isQuitting: boolean;
  scanningEnabled: boolean;
  platform: NodeJS.Platform;
}): boolean {
  if (params.isQuitting) return true;
  if (params.scanningEnabled) return false;
  return params.platform !== "darwin";
}
```

- [ ] **Step 4: Run test + typecheck to verify they pass**

Run (from `electron-app/`): `npx vitest run test/main/appLifecycle.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/appLifecycle.ts electron-app/test/main/appLifecycle.test.ts
git commit -m "feat(lifecycle): pure shouldQuitOnAllWindowsClosed decision"
```

---

### Task 11: `tray.ts` + icon assets — the tray menu and icon

Add the tray: a pure, unit-tested `buildTrayMenuTemplate` (Show / Settings / separator / Quit) and the `createTray` factory that loads the icon and wires the menu + left-click. Real `Tray`/`nativeImage`/`Menu` construction is Electron-runtime-only, so only `buildTrayMenuTemplate` is unit-tested; `createTray` is exercised via the manual checklist. The two committed PNG icon assets are generated deterministically. Independent — no phase-5d deps.

**Files:**
- Create: `electron-app/src/main/tray.ts`
- Create: `electron-app/test/main/tray.test.ts`
- Create: `electron-app/resources/icons/trayIconTemplate.png` (16×16)
- Create: `electron-app/resources/icons/trayIconTemplate@2x.png` (32×32)

**Interfaces:**
- Consumes: `Tray`, `Menu`, `nativeImage`, `MenuItemConstructorOptions` (`electron`), `path`.
- Produces:
  - `export interface TrayDeps { showMainWindow: () => void; showSettingsWindow: () => void; quit: () => void; iconPath?: string; }`
  - `export function buildTrayMenuTemplate(deps: Pick<TrayDeps, "showMainWindow" | "showSettingsWindow" | "quit">): MenuItemConstructorOptions[]`
  - `export function createTray(deps: TrayDeps): Tray`

- [ ] **Step 1: Write the failing test** — create `electron-app/test/main/tray.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { buildTrayMenuTemplate } from "../../src/main/tray";

describe("buildTrayMenuTemplate", () => {
  it("returns Show, Settings, a separator, then Quit in that order", () => {
    const template = buildTrayMenuTemplate({ showMainWindow: vi.fn(), showSettingsWindow: vi.fn(), quit: vi.fn() });
    expect(template.map((item) => item.label ?? item.type)).toEqual(["Show", "Settings", "separator", "Quit"]);
  });

  it("wires each item's click to the corresponding dependency exactly once", () => {
    const showMainWindow = vi.fn();
    const showSettingsWindow = vi.fn();
    const quit = vi.fn();
    const template = buildTrayMenuTemplate({ showMainWindow, showSettingsWindow, quit });

    (template[0].click as () => void)();
    (template[1].click as () => void)();
    (template[3].click as () => void)();

    expect(showMainWindow).toHaveBeenCalledTimes(1);
    expect(showSettingsWindow).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `electron-app/`): `npx vitest run test/main/tray.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement `tray.ts`** — create `electron-app/src/main/tray.ts`:

```typescript
import { Tray, Menu, nativeImage, type MenuItemConstructorOptions } from "electron";
import path from "node:path";

export interface TrayDeps {
  showMainWindow: () => void;
  showSettingsWindow: () => void;
  quit: () => void;
  iconPath?: string;
}

const DEFAULT_ICON_PATH = path.join(__dirname, "..", "..", "resources", "icons", "trayIconTemplate.png");

export function buildTrayMenuTemplate(
  deps: Pick<TrayDeps, "showMainWindow" | "showSettingsWindow" | "quit">,
): MenuItemConstructorOptions[] {
  return [
    { label: "Show", click: () => deps.showMainWindow() },
    { label: "Settings", click: () => deps.showSettingsWindow() },
    { type: "separator" },
    { label: "Quit", click: () => deps.quit() },
  ];
}

export function createTray(deps: TrayDeps): Tray {
  const icon = nativeImage.createFromPath(deps.iconPath ?? DEFAULT_ICON_PATH);
  const tray = new Tray(icon);
  tray.setToolTip("Trade Assistant");
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(deps)));
  tray.on("click", () => deps.showMainWindow());
  return tray;
}
```

- [ ] **Step 4: Generate the two icon PNGs** — run this throwaway generator (write it to the scratchpad, not the repo; only the two PNGs are committed). It emits valid RGBA PNGs (a filled black disc on transparent) with correct CRCs, so `nativeImage.createFromPath` accepts them:

```bash
mkdir -p resources/icons
node -e '
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");
const table = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); table[n] = c; }
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type, "latin1"); const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0); return Buffer.concat([len, t, data, crc]); };
function makePng(size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const center = (size - 1) / 2; const radius = size / 2 - 1;
  const raw = Buffer.alloc(size * (1 + size * 4));
  let o = 0;
  for (let y = 0; y < size; y++) { raw[o++] = 0; for (let x = 0; x < size; x++) { const inside = (x - center) ** 2 + (y - center) ** 2 <= radius ** 2; raw[o++] = 0; raw[o++] = 0; raw[o++] = 0; raw[o++] = inside ? 255 : 0; } }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
const dir = path.join(process.cwd(), "resources", "icons");
fs.writeFileSync(path.join(dir, "trayIconTemplate.png"), makePng(16));
fs.writeFileSync(path.join(dir, "trayIconTemplate@2x.png"), makePng(32));
console.log("wrote", fs.readdirSync(dir));
'
```

Verify both files exist and are valid PNGs: `file resources/icons/trayIconTemplate.png resources/icons/trayIconTemplate@2x.png` (expect `PNG image data, 16 x 16` and `32 x 32`).

- [ ] **Step 5: Run test + typecheck to verify they pass**

Run (from `electron-app/`): `npx vitest run test/main/tray.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/tray.ts electron-app/test/main/tray.test.ts electron-app/resources/icons/trayIconTemplate.png electron-app/resources/icons/trayIconTemplate@2x.png
git commit -m "feat(tray): tray menu template, createTray factory, and placeholder icon assets"
```

---

### Task 12: Settings window — `SettingsWindow.tsx`, its preload/renderer entry points, and vite config

The whole second `BrowserWindow` class: the pure `settingsWindowOptions` (byte-for-byte the same security flags as `mainWindowOptions`), the `SettingsWindow.tsx` React component (three sections: scanning toggle+interval, watchlist add/remove, read-only status), the renderer `settingsBridge()` accessor, the second preload (`settingsPreload.ts` exposing `tradeAssistantSettings`), `settings.html`, `settingsMain.tsx`, and the second `preload`/`renderer` entries in `electron.vite.config.ts`. Depends on Task 9 (`SettingsApi`/`buildSettingsApi`). The component is jsdom-tested against a fake `SettingsApi`; `settingsWindowOptions` is unit-tested; the preload/html/main/vite plumbing is verified via typecheck + build + the manual checklist.

**Files:**
- Create: `electron-app/src/main/settingsWindow.ts`
- Create: `electron-app/src/main/ipc/settingsPreload.ts`
- Create: `electron-app/src/renderer/settings.html`
- Create: `electron-app/src/renderer/settingsMain.tsx`
- Create: `electron-app/src/renderer/settingsBridge.ts`
- Create: `electron-app/src/renderer/SettingsWindow.tsx`
- Modify: `electron-app/electron.vite.config.ts`
- Create: `electron-app/test/main/settingsWindow.test.ts`
- Create: `electron-app/test/renderer/SettingsWindow.test.tsx`

**Interfaces:**
- Consumes: `SettingsApi`/`buildSettingsApi` (Task 9), `AppStatus`/`ScanConfig`/`ScanIntervalMinutes`/`InstrumentSelection` (`rendererApi.ts`), `parseInstruments` (`renderer/instrumentParsing.ts`), `BrowserWindowConstructorOptions`.
- Produces:
  - `export function settingsWindowOptions(preloadPath: string): BrowserWindowConstructorOptions`
  - `export function settingsBridge(): SettingsApi`
  - `export function SettingsWindow(): JSX.Element`
  - `out/preload/settingsPreload.js` + `out/renderer/settings.html` build outputs.

- [ ] **Step 1: Write the failing tests** — create `electron-app/test/main/settingsWindow.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { settingsWindowOptions } from "../../src/main/settingsWindow";

describe("settingsWindowOptions", () => {
  it("locks the same security posture as the main window and threads the preload", () => {
    const options = settingsWindowOptions("/abs/path/settingsPreload.js");
    expect(options.webPreferences?.contextIsolation).toBe(true);
    expect(options.webPreferences?.sandbox).toBe(true);
    expect(options.webPreferences?.nodeIntegration).toBe(false);
    expect(options.webPreferences?.preload).toBe("/abs/path/settingsPreload.js");
  });
});
```

Create `electron-app/test/renderer/SettingsWindow.test.tsx`:

```typescript
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsWindow } from "../../src/renderer/SettingsWindow";
import type { SettingsApi } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);

function installSettingsBridge(overrides: Partial<SettingsApi> = {}): SettingsApi {
  const api: SettingsApi = {
    getScanConfig: vi.fn().mockResolvedValue({ enabled: false, intervalMinutes: 15 }),
    setScanConfig: vi.fn().mockResolvedValue({ enabled: false, intervalMinutes: 15 }),
    listWatchlist: vi.fn().mockResolvedValue([]),
    addWatchlistSymbol: vi.fn().mockResolvedValue(["NSE:INFY"]),
    removeWatchlistSymbol: vi.fn().mockResolvedValue([]),
    getAccountStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
    searchInstruments: vi.fn().mockResolvedValue({ data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }] }),
    ...overrides,
  };
  (window as unknown as { tradeAssistantSettings: SettingsApi }).tradeAssistantSettings = api;
  return api;
}

describe("SettingsWindow", () => {
  it("toggling the scan checkbox calls setScanConfig with the flipped enabled", async () => {
    const api = installSettingsBridge();
    render(<SettingsWindow />);
    const checkbox = await screen.findByLabelText(/enable proactive scanning/i);
    fireEvent.click(checkbox);
    expect(api.setScanConfig).toHaveBeenCalledWith({ enabled: true, intervalMinutes: 15 });
  });

  it("changing the interval select calls setScanConfig with the new intervalMinutes", async () => {
    const api = installSettingsBridge();
    render(<SettingsWindow />);
    const select = await screen.findByLabelText(/scan interval/i);
    fireEvent.change(select, { target: { value: "30" } });
    expect(api.setScanConfig).toHaveBeenCalledWith({ enabled: false, intervalMinutes: 30 });
  });

  it("typing a query searches and renders results; clicking Add re-renders the watchlist from the returned array", async () => {
    const api = installSettingsBridge({ addWatchlistSymbol: vi.fn().mockResolvedValue(["NSE:INFY"]) });
    render(<SettingsWindow />);
    fireEvent.change(await screen.findByLabelText(/instrument search/i), { target: { value: "infy" } });
    const addButton = await screen.findByText("Add NSE:INFY");
    fireEvent.click(addButton);
    expect(api.addWatchlistSymbol).toHaveBeenCalledWith("NSE:INFY");
    await waitFor(() => expect(screen.getByText("Remove")).toBeTruthy());
  });

  it("clicking Remove calls removeWatchlistSymbol", async () => {
    const api = installSettingsBridge({ listWatchlist: vi.fn().mockResolvedValue(["NSE:INFY"]), removeWatchlistSymbol: vi.fn().mockResolvedValue([]) });
    render(<SettingsWindow />);
    const removeButton = await screen.findByText("Remove");
    fireEvent.click(removeButton);
    expect(api.removeWatchlistSymbol).toHaveBeenCalledWith("NSE:INFY");
  });

  it("renders the account status fields from getAccountStatus", async () => {
    installSettingsBridge();
    render(<SettingsWindow />);
    expect(await screen.findByText(/Sidecar: up/)).toBeTruthy();
    expect(await screen.findByText(/Kite session: authenticated/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `electron-app/`): `npx vitest run test/main/settingsWindow.test.ts test/renderer/SettingsWindow.test.tsx`
Expected: FAIL — `settingsWindow` / `SettingsWindow` modules do not exist.

- [ ] **Step 3: Implement `settingsWindow.ts`** — create `electron-app/src/main/settingsWindow.ts`:

```typescript
import type { BrowserWindowConstructorOptions } from "electron";

export function settingsWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 480,
    height: 640,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  };
}
```

- [ ] **Step 4: Implement the renderer `settingsBridge.ts`** — create `electron-app/src/renderer/settingsBridge.ts`:

```typescript
import type { SettingsApi } from "../main/ipc/rendererApi";

export function settingsBridge(): SettingsApi {
  return (window as unknown as { tradeAssistantSettings: SettingsApi }).tradeAssistantSettings;
}
```

- [ ] **Step 5: Implement `SettingsWindow.tsx`** — create `electron-app/src/renderer/SettingsWindow.tsx`:

```typescript
import { useEffect, useState } from "react";
import type { AppStatus, InstrumentSelection, ScanConfig, ScanIntervalMinutes } from "../main/ipc/rendererApi";
import { settingsBridge } from "./settingsBridge";
import { parseInstruments } from "./instrumentParsing";

const INTERVAL_OPTIONS: ScanIntervalMinutes[] = [5, 15, 30, 60];
const SEARCH_DEBOUNCE_MS = 300;

export function SettingsWindow(): JSX.Element {
  const [config, setConfig] = useState<ScanConfig>({ enabled: false, intervalMinutes: 15 });
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<InstrumentSelection[]>([]);
  const [status, setStatus] = useState<AppStatus | null>(null);

  useEffect(() => {
    void settingsBridge().getScanConfig().then(setConfig);
    void settingsBridge().listWatchlist().then(setWatchlist);
    void settingsBridge().getAccountStatus().then(setStatus);
  }, []);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const parsed = parseInstruments(await settingsBridge().searchInstruments(query));
      if (!cancelled) setResults(parsed);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const applyConfig = async (next: ScanConfig): Promise<void> => {
    setConfig(next);
    await settingsBridge().setScanConfig(next);
  };

  return (
    <section className="settings">
      <fieldset>
        <legend>Proactive scanning</legend>
        <label>
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(event) => void applyConfig({ ...config, enabled: event.target.checked })}
          />
          Enable proactive scanning
        </label>
        <label>
          Interval
          <select
            aria-label="scan interval"
            value={config.intervalMinutes}
            onChange={(event) => void applyConfig({ ...config, intervalMinutes: Number(event.target.value) as ScanIntervalMinutes })}
          >
            {INTERVAL_OPTIONS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes} min
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset>
        <legend>Watchlist</legend>
        <input
          aria-label="instrument search"
          placeholder="Search instrument"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ul className="results">
          {results.map((instrument) => (
            <li key={instrument.instrumentToken}>
              <button type="button" onClick={async () => setWatchlist(await settingsBridge().addWatchlistSymbol(instrument.symbol))}>
                Add {instrument.symbol}
              </button>
            </li>
          ))}
        </ul>
        <ul className="watchlist">
          {watchlist.map((symbol) => (
            <li key={symbol}>
              {symbol}
              <button type="button" onClick={async () => setWatchlist(await settingsBridge().removeWatchlistSymbol(symbol))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      </fieldset>

      <fieldset>
        <legend>Account status</legend>
        <div>Sidecar: {status?.sidecar ?? "…"}</div>
        <div>Kite session: {status?.kiteSession ?? "…"}</div>
        {status?.driftWarning && <div className="warning">{status.driftWarning}</div>}
        <p className="banner-hint">AI-Assisted needs the claude CLI authenticated — run `claude auth login`.</p>
      </fieldset>
    </section>
  );
}
```

- [ ] **Step 6: Implement the entry points** — create `electron-app/src/main/ipc/settingsPreload.ts`:

```typescript
import { contextBridge, ipcRenderer } from "electron";
import { buildSettingsApi } from "./rendererApi";

const api = buildSettingsApi((channel, ...args) => ipcRenderer.invoke(channel, ...args));

contextBridge.exposeInMainWorld("tradeAssistantSettings", api);
```

Create `electron-app/src/renderer/settings.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'self'; style-src 'self'; object-src 'none'"
    />
    <title>Trade Assistant — Settings</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./settingsMain.tsx"></script>
  </body>
</html>
```

Create `electron-app/src/renderer/settingsMain.tsx`:

```typescript
import { createRoot } from "react-dom/client";
import { SettingsWindow } from "./SettingsWindow";
import "./style.css";

const container = document.getElementById("root");
if (container) createRoot(container).render(<SettingsWindow />);
```

- [ ] **Step 7: Add the second build entries** — in `electron-app/electron.vite.config.ts`, replace the `preload` block's `rollupOptions` and the `renderer` block's `rollupOptions.input`:

```typescript
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          preload: resolve(__dirname, "src/main/ipc/preload.ts"),
          settingsPreload: resolve(__dirname, "src/main/ipc/settingsPreload.ts"),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          settings: resolve(__dirname, "src/renderer/settings.html"),
        },
      },
    },
    plugins: [
      react(),
      {
        name: "trade-assistant-dev-csp",
        transformIndexHtml(html, ctx) {
          if (!ctx.server) return html;
          return html.replace(
            /(<meta http-equiv="Content-Security-Policy" content=")[^"]*(")/,
            `$1${DEV_CSP}$2`,
          );
        },
      },
    ],
  },
```

- [ ] **Step 8: Run tests + typecheck + build to verify they pass**

Run (from `electron-app/`): `npx vitest run test/main/settingsWindow.test.ts test/renderer/SettingsWindow.test.tsx && npm run typecheck`
Expected: PASS (all five component tests + the options test); typecheck clean. Then confirm the second entry points build: `npm run build` and verify `out/preload/settingsPreload.js` and `out/renderer/settings.html` exist.

- [ ] **Step 9: Commit**

```bash
git add electron-app/src/main/settingsWindow.ts electron-app/src/main/ipc/settingsPreload.ts electron-app/src/renderer/settings.html electron-app/src/renderer/settingsMain.tsx electron-app/src/renderer/settingsBridge.ts electron-app/src/renderer/SettingsWindow.tsx electron-app/electron.vite.config.ts electron-app/test/main/settingsWindow.test.ts electron-app/test/renderer/SettingsWindow.test.tsx
git commit -m "feat(settings): Settings window, preload/renderer entry points, and vite config"
```

---

### Task 13: `bootstrap.ts` — hoist IPC registration out of `createMainWindow` (the spec-caught bug fix)

The real correctness fix the spec's self-review caught, done as a standalone, behavior-preserving refactor **before** the tray/settings wiring that would trigger the latent bug. Today `registerStatusBridge`/`registerAnalysisBridge`/`registerHistoryBridge` run *inside* `createMainWindow()`, which is called exactly once — so calling `ipcMain.handle(...)` twice (which tray "Show"/`activate` will do once window recreation exists) would throw "Attempted to register a second handler". This task moves all three registrations to run once at `createApp()`'s top level, makes `mainWindow` closured nullable state that `createMainWindow` sets and its `closed` handler clears, adds `showMainWindow` (recreate-or-focus), and redefines `sendToRenderer` to read the *current* `mainWindow` at call time. `AppRuntime` is unchanged (still `start`/`stop`), `main.ts` is untouched, and the full suite stays green — this commit adds no new behavior, it only relocates existing behavior so Task 14 can be purely additive.

**Files:**
- Modify: `electron-app/src/main/bootstrap.ts`

**Interfaces:**
- Consumes: existing `registerStatusBridge`/`registerAnalysisBridge`/`registerHistoryBridge`, `makeNarrativeSender`, `mainWindowOptions`.
- Produces: `mainWindow`/`showMainWindow`/`sendToRenderer` internal restructure; `createMainWindow` no longer registers IPC. No exported-interface change (`AppRuntime` still `{ start, stop }`; `handleKiteResponse` unchanged).

- [ ] **Step 1: Confirm the current suite is green** (baseline — this refactor must not change it)

Run (from `electron-app/`): `npm test`
Expected: PASS (establishes the green baseline the refactor preserves).

- [ ] **Step 2: Implement the hoist** — replace the full contents of `electron-app/src/main/bootstrap.ts` (everything from `export function createApp` down; the imports and `handleKiteResponse`/`postForm` above it are unchanged):

```typescript
export function createApp(): AppRuntime {
  // loadKiteConfig reads process.env directly; nothing else in this codebase
  // populates it from electron-app/.env, so this must run first.
  dotenv.config({ path: path.join(app.getAppPath(), ".env") });
  const config = loadKiteConfig();
  const supervisor = new SidecarSupervisor({
    binaryPath:
      process.env.SIDECAR_BINARY ??
      path.join(__dirname, "..", "..", "..", "rust-core", "target", "debug", "sidecar"),
    lakeRoot: process.env.TRADE_ASSISTANT_LAKE ?? path.join(app.getPath("userData"), "candle-lake"),
  });
  const sessionState = new KiteSessionState();
  const provider = new ClaudeCliProvider();
  const history = new HistoryStore({
    path: process.env.TRADE_ASSISTANT_HISTORY_DB ?? path.join(app.getPath("userData"), "history.sqlite3"),
  });

  let sidecarStatus: SidecarStatus = "down";
  let driftWarning: string | null = null;
  let session: KiteSession | null = null;
  let loginInFlight: Promise<LoginResult> | null = null;
  let mainWindow: BrowserWindow | null = null;
  const bannerHandlers: ((banner: BannerEvent) => void)[] = [];

  const dispatchBanner = (banner: BannerEvent): void => bannerHandlers.forEach((handler) => handler(banner));

  supervisor.on("statusChange", (status: SidecarStatus) => {
    sidecarStatus = status;
  });
  sessionState.on("banner", dispatchBanner);
  sessionState.on("change", (status: KiteSessionStatus) => {
    if (status === "needsLogin" && session) {
      const closing = session;
      session = null;
      void closing.close().catch(() => {});
    }
  });

  const currentStatus = (): AppStatus => ({ sidecar: sidecarStatus, kiteSession: sessionState.status, driftWarning });

  const login = (): Promise<LoginResult> => {
    if (loginInFlight) return loginInFlight;
    loginInFlight = (async (): Promise<LoginResult> => {
      try {
        const previousSession = session;
        const newSession = await runKiteLogin({
          config,
          captureRequestToken,
          exchangeAccessToken,
          postForm,
          openExternal: (url) => shell.openExternal(url),
          onKiteResponse: (response) => handleKiteResponse(sessionState, response),
        });
        if (previousSession && previousSession !== newSession) {
          void previousSession.close().catch(() => {});
        }
        session = newSession;
        driftWarning = newSession.drift.hasDrift
          ? `MCP tools changed: added [${newSession.drift.added.join(", ")}], removed [${newSession.drift.removed.join(", ")}]`
          : null;
        if (newSession.drift.hasDrift) {
          dispatchBanner({ kind: "mcpDrift", message: driftWarning as string });
        }
        sessionState.markAuthenticated();
        return { status: "authenticated" };
      } catch (error) {
        sessionState.markNeedsLogin();
        return { status: "error", message: (error as Error).message };
      } finally {
        loginInFlight = null;
      }
    })();
    return loginInFlight;
  };

  // Reads the current mainWindow at call time rather than closing over one fixed
  // window instance, so a recreated window (tray "Show"/activate) still receives
  // pushed banner/narrative events.
  const sendToRenderer = (channel: string, payload: unknown): void => {
    mainWindow?.webContents.send(channel, payload);
  };

  const createMainWindow = (): BrowserWindow => {
    const window = new BrowserWindow(mainWindowOptions(path.join(__dirname, "..", "preload", "preload.js")));
    mainWindow = window;
    window.on("closed", () => {
      mainWindow = null;
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|mailto):/.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl) window.loadURL(rendererUrl);
    else window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
    return window;
  };

  const showMainWindow = (): void => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    createMainWindow();
  };

  // IPC handlers are registered exactly once, decoupled from window creation:
  // ipcMain.handle throws on a second registration for the same channel, and
  // createMainWindow can now run more than once (showMainWindow after a close).
  registerStatusBridge({
    ipcMain,
    getStatus: currentStatus,
    onBanner: (handler) => bannerHandlers.push(handler),
    sendToRenderer,
  });
  registerAnalysisBridge({
    ipcMain,
    login,
    getSession: () => session,
    sidecar: supervisor,
    provider,
    history,
    sendNarrative: makeNarrativeSender(sendToRenderer),
    markNeedsLogin: () => sessionState.markNeedsLogin(),
  });
  registerHistoryBridge({ ipcMain, history });

  return {
    start: () => {
      supervisor.start();
      createMainWindow();
    },
    stop: () => {
      void session?.close().catch(() => {});
      history.close();
      supervisor.stop();
    },
  };
}
```

- [ ] **Step 3: Run the full suite + typecheck to verify nothing changed**

Run (from `electron-app/`): `npm test && npm run typecheck`
Expected: PASS — identical green result to Step 1. `bootstrap.test.ts` (only `handleKiteResponse`) is unaffected; no behavior changed, registrations simply moved to createApp top level (still run once, since createMainWindow was called once).

- [ ] **Step 4: Commit**

```bash
git add electron-app/src/main/bootstrap.ts
git commit -m "refactor(bootstrap): register IPC once at createApp, look up the window dynamically"
```

---

### Task 14: Final wiring — bootstrap scheduler/tray/settings + `main.ts` lifecycle + end-to-end proof

Compose everything: construct the `ScanScheduler` (seeded from `history.getScanConfig()`), the `Tray`, the Settings window (recreate-or-focus, like the main window), the `notify` closure around Electron's `Notification`, and register the Settings bridge. Extend `AppRuntime` with `showMainWindow`/`isScanningEnabled` and rework `main.ts`'s `before-quit`/`window-all-closed`/`activate` handlers around `shouldQuitOnAllWindowsClosed`. Prove the scheduler composes with a **real** `HistoryStore` (temp file) end-to-end via fakes (no real subprocess/network/timers). Depends on Tasks 6, 8, 9, 10, 11, 12, 13.

**Safety note (must appear in this task's review):** this task only constructs and wires already-built pieces. The `ScanScheduler`'s `provider` is the same `ClaudeCliProvider`; `getKite: () => session?.kite ?? null` hands it the same read-only `KiteClient` the rest of the app uses; `notify` only shows a desktop `Notification`. No new tool grant, no Kite write, no new subprocess path.

**Files:**
- Modify: `electron-app/src/main/bootstrap.ts`
- Modify: `electron-app/src/main/main.ts`
- Create: `electron-app/test/main/scanScheduler.integration.test.ts`

**Interfaces:**
- Consumes: `ScanScheduler` (Task 8), `createTray` (Task 11), `settingsWindowOptions` (Task 12), `registerSettingsBridge` (Task 9), `shouldQuitOnAllWindowsClosed` (Task 10), `Notification`/`Tray` (electron), the real `HistoryStore` (Task 7).
- Produces: `AppRuntime` gains `showMainWindow(): void` and `isScanningEnabled(): boolean`; `main.ts` gains `before-quit`/`activate` handlers and a reworked `window-all-closed`.

- [ ] **Step 1: Write the failing integration test** — create `electron-app/test/main/scanScheduler.integration.test.ts` (a real `HistoryStore` temp file + a real `ScanScheduler` + fake sidecar/kite/provider/notify, driving one tick):

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScanScheduler, type ScanSchedulerDeps } from "../../src/main/scanScheduler";
import { HistoryStore } from "../../src/main/services/history/historyStore";
import { historicalResponse } from "../fixtures/sidecarFixtures";

const tempDirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ta-scan-"));
  tempDirs.push(dir);
  return path.join(dir, "history.sqlite3");
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function computeResult() {
  return {
    type: "compute" as const,
    id: 1,
    algo_results: [
      { algo_id: "rsi", symbol: "NSE:INFY", timeframe: "5minute", horizon: "intraday", direction: "Bullish", magnitude: 0.4, confidence: 0.6, evidence: ["RSI 62"], computed_at: "2026-07-27T00:00:00+00:00" },
    ],
    confluence: { bullish_count: 8, bearish_count: 1, neutral_count: 2, weighted_vote: 0.5 },
  };
}

function makeDeps(history: HistoryStore, decision: "WorthLook" | "WorthAiCall"): ScanSchedulerDeps {
  const kite = {
    searchInstruments: vi.fn(async (q: string) => ({ data: [{ tradingsymbol: q, exchange: "NSE", segment: "NSE", instrument_token: 408065 }] })),
    getHistoricalData: vi.fn(async () => historicalResponse()),
  };
  const sidecar = {
    compute: vi.fn(async () => computeResult()),
    persistCandles: vi.fn(async (_s: string, _t: string, candles: { length: number }) => ({ type: "persist_candles" as const, id: 1, written: candles.length })),
    listWatchlist: vi.fn(async () => ({ type: "watchlist" as const, id: 1, symbols: ["NSE:INFY"] })),
    evaluateScanGate: vi.fn(async () => ({ type: "scan_gate" as const, id: 1, decision })),
  };
  const provider = {
    intake: vi.fn(),
    completeAiAssisted: vi.fn(async () => ({
      verdict: { direction: "bullish", conviction: "high", reasoning: "r", cited_algo_ids: ["rsi"], verify_before_acting: "check LTP" },
      narrative: "Infy looks constructive.",
    })),
  };
  return {
    sidecar: sidecar as unknown as ScanSchedulerDeps["sidecar"],
    getKite: () => kite as unknown as ReturnType<ScanSchedulerDeps["getKite"]>,
    provider: provider as unknown as ScanSchedulerDeps["provider"],
    history,
    notify: vi.fn(),
    now: () => new Date("2026-07-27T10:00:00Z"),
    setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
    clearIntervalFn: () => {},
  };
}

describe("ScanScheduler composed with a real HistoryStore", () => {
  it("a WorthLook tick persists a real engine_only session with a proactive_scan trigger", async () => {
    const history = new HistoryStore({ path: tempDbPath() });
    const scheduler = new ScanScheduler(makeDeps(history, "WorthLook"), history.getScanConfig());
    await scheduler.tick();

    const sessions = history.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].response_mode).toBe("engine_only");
    const detail = history.getSession(sessions[0].id);
    expect(detail?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(detail?.messages[0].structured_payload).toEqual({ trigger: "proactive_scan", symbol: "NSE:INFY", horizon: "intraday", intent_lens: "buying" });
    history.close();
  });

  it("a WorthAiCall tick persists a real ai_assisted session and pins a claude_session_id", async () => {
    const history = new HistoryStore({ path: tempDbPath() });
    const scheduler = new ScanScheduler(makeDeps(history, "WorthAiCall"), history.getScanConfig());
    await scheduler.tick();

    const sessions = history.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].response_mode).toBe("ai_assisted");
    expect(history.getClaudeSessionId(sessions[0].id)).not.toBeNull();
    history.close();
  });
});
```

- [ ] **Step 2: Run the integration test to verify it fails** (then passes once bootstrap/main are wired — it exercises `ScanScheduler` + `HistoryStore` directly, so it goes green as soon as those exist; if red, fix wiring, never the assertions)

Run (from `electron-app/`): `npm rebuild better-sqlite3 && npx vitest run test/main/scanScheduler.integration.test.ts`
Expected: PASS (Tasks 7 + 8 already provide `HistoryStore.getScanConfig` and `ScanScheduler`).

- [ ] **Step 3: Wire `bootstrap.ts`** — replace the full contents of `electron-app/src/main/bootstrap.ts`:

```typescript
import { app, BrowserWindow, ipcMain, Notification, shell, type Tray } from "electron";
import dotenv from "dotenv";
import path from "node:path";
import { mainWindowOptions } from "./mainWindow";
import { settingsWindowOptions } from "./settingsWindow";
import { SidecarSupervisor } from "./services/sidecar/sidecarSupervisor";
import { KiteSessionState, classifyKiteResponse } from "./services/kite/kiteSessionState";
import { loadKiteConfig } from "./services/kite/kiteConfig";
import { runKiteLogin } from "./services/kite/kiteLogin";
import type { KiteSession } from "./services/kite/kiteLogin";
import { captureRequestToken, exchangeAccessToken } from "./services/kite/kiteOAuth";
import { ClaudeCliProvider } from "./services/claude/claudeCliProvider";
import { registerStatusBridge } from "./ipc/appBridge";
import { registerAnalysisBridge } from "./ipc/analysisBridge";
import { registerHistoryBridge } from "./ipc/historyBridge";
import { registerSettingsBridge } from "./ipc/settingsBridge";
import { makeNarrativeSender } from "./ipc/narrativeBridge";
import { HistoryStore } from "./services/history/historyStore";
import { ScanScheduler } from "./scanScheduler";
import { createTray } from "./tray";
import type { AppStatus, BannerEvent, KiteSessionStatus, LoginResult, SidecarStatus } from "./ipc/rendererApi";

export interface AppRuntime {
  start(): void;
  stop(): void;
  showMainWindow(): void;
  isScanningEnabled(): boolean;
}

// classifyKiteResponse fails closed: ordinary successful reads classify as
// "unknown", so this only ever acts on the needsLogin verdict -- mirrors
// looksLikeSessionExpiry's one-directional check on thrown errors.
export function handleKiteResponse(sessionState: KiteSessionState, response: unknown): void {
  if (classifyKiteResponse(response) === "needsLogin") sessionState.markNeedsLogin();
}

async function postForm(url: string, form: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Kite-Version": "3" },
    body: new URLSearchParams(form).toString(),
  });
  return response.json();
}

export function createApp(): AppRuntime {
  // loadKiteConfig reads process.env directly; nothing else in this codebase
  // populates it from electron-app/.env, so this must run first.
  dotenv.config({ path: path.join(app.getAppPath(), ".env") });
  const config = loadKiteConfig();
  const supervisor = new SidecarSupervisor({
    binaryPath:
      process.env.SIDECAR_BINARY ??
      path.join(__dirname, "..", "..", "..", "rust-core", "target", "debug", "sidecar"),
    lakeRoot: process.env.TRADE_ASSISTANT_LAKE ?? path.join(app.getPath("userData"), "candle-lake"),
  });
  const sessionState = new KiteSessionState();
  const provider = new ClaudeCliProvider();
  const history = new HistoryStore({
    path: process.env.TRADE_ASSISTANT_HISTORY_DB ?? path.join(app.getPath("userData"), "history.sqlite3"),
  });

  let sidecarStatus: SidecarStatus = "down";
  let driftWarning: string | null = null;
  let session: KiteSession | null = null;
  let loginInFlight: Promise<LoginResult> | null = null;
  let mainWindow: BrowserWindow | null = null;
  let settingsWindow: BrowserWindow | null = null;
  // Retained so Electron does not garbage-collect the tray icon (a documented
  // Electron gotcha for an otherwise-unreferenced Tray).
  let tray: Tray | null = null;
  const bannerHandlers: ((banner: BannerEvent) => void)[] = [];

  const dispatchBanner = (banner: BannerEvent): void => bannerHandlers.forEach((handler) => handler(banner));

  supervisor.on("statusChange", (status: SidecarStatus) => {
    sidecarStatus = status;
  });
  sessionState.on("banner", dispatchBanner);
  sessionState.on("change", (status: KiteSessionStatus) => {
    if (status === "needsLogin" && session) {
      const closing = session;
      session = null;
      void closing.close().catch(() => {});
    }
  });

  const currentStatus = (): AppStatus => ({ sidecar: sidecarStatus, kiteSession: sessionState.status, driftWarning });

  const login = (): Promise<LoginResult> => {
    if (loginInFlight) return loginInFlight;
    loginInFlight = (async (): Promise<LoginResult> => {
      try {
        const previousSession = session;
        const newSession = await runKiteLogin({
          config,
          captureRequestToken,
          exchangeAccessToken,
          postForm,
          openExternal: (url) => shell.openExternal(url),
          onKiteResponse: (response) => handleKiteResponse(sessionState, response),
        });
        if (previousSession && previousSession !== newSession) {
          void previousSession.close().catch(() => {});
        }
        session = newSession;
        driftWarning = newSession.drift.hasDrift
          ? `MCP tools changed: added [${newSession.drift.added.join(", ")}], removed [${newSession.drift.removed.join(", ")}]`
          : null;
        if (newSession.drift.hasDrift) {
          dispatchBanner({ kind: "mcpDrift", message: driftWarning as string });
        }
        sessionState.markAuthenticated();
        return { status: "authenticated" };
      } catch (error) {
        sessionState.markNeedsLogin();
        return { status: "error", message: (error as Error).message };
      } finally {
        loginInFlight = null;
      }
    })();
    return loginInFlight;
  };

  const sendToRenderer = (channel: string, payload: unknown): void => {
    mainWindow?.webContents.send(channel, payload);
  };

  const createMainWindow = (): BrowserWindow => {
    const window = new BrowserWindow(mainWindowOptions(path.join(__dirname, "..", "preload", "preload.js")));
    mainWindow = window;
    window.on("closed", () => {
      mainWindow = null;
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|mailto):/.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl) window.loadURL(rendererUrl);
    else window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
    return window;
  };

  const showMainWindow = (): void => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    createMainWindow();
  };

  const createSettingsWindow = (): BrowserWindow => {
    const window = new BrowserWindow(settingsWindowOptions(path.join(__dirname, "..", "preload", "settingsPreload.js")));
    settingsWindow = window;
    window.on("closed", () => {
      settingsWindow = null;
    });
    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl) window.loadURL(`${rendererUrl}/settings.html`);
    else window.loadFile(path.join(__dirname, "..", "renderer", "settings.html"));
    return window;
  };

  const showSettingsWindow = (): void => {
    if (settingsWindow) {
      settingsWindow.show();
      settingsWindow.focus();
      return;
    }
    createSettingsWindow();
  };

  const sendScanNotification = (title: string, body: string): void => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body });
    // Resolves showMainWindow at click time (long after every const above is
    // assigned), so a notification click reaches whichever window is current.
    notification.on("click", () => showMainWindow());
    notification.show();
  };

  const scanScheduler = new ScanScheduler(
    {
      sidecar: supervisor,
      getKite: () => session?.kite ?? null,
      provider,
      history,
      notify: sendScanNotification,
    },
    history.getScanConfig(),
  );

  registerStatusBridge({
    ipcMain,
    getStatus: currentStatus,
    onBanner: (handler) => bannerHandlers.push(handler),
    sendToRenderer,
  });
  registerAnalysisBridge({
    ipcMain,
    login,
    getSession: () => session,
    sidecar: supervisor,
    provider,
    history,
    sendNarrative: makeNarrativeSender(sendToRenderer),
    markNeedsLogin: () => sessionState.markNeedsLogin(),
  });
  registerHistoryBridge({ ipcMain, history });
  registerSettingsBridge({ ipcMain, history, scanScheduler, sidecar: supervisor, getStatus: currentStatus });

  return {
    start: () => {
      supervisor.start();
      createMainWindow();
      tray = createTray({ showMainWindow, showSettingsWindow, quit: () => app.quit() });
    },
    stop: () => {
      // Stop the scheduler first, before the sidecar/history teardown it depends
      // on. stop() only clears the interval timer; a tick already in flight is
      // caught by tickOneSymbol's own try/catch if it hits a closed store.
      scanScheduler.stop();
      void session?.close().catch(() => {});
      history.close();
      supervisor.stop();
      tray?.destroy();
      tray = null;
    },
    showMainWindow,
    isScanningEnabled: () => scanScheduler.getConfig().enabled,
  };
}
```

- [ ] **Step 4: Wire `main.ts`** — replace the full contents of `electron-app/src/main/main.ts`:

```typescript
import { app } from "electron";
import { createApp } from "./bootstrap";
import { shouldQuitOnAllWindowsClosed } from "./appLifecycle";

const runtime = createApp();
let isQuitting = false;

app.whenReady().then(() => {
  runtime.start();
});

app.on("before-quit", () => {
  isQuitting = true;
  runtime.stop();
});

app.on("window-all-closed", () => {
  if (shouldQuitOnAllWindowsClosed({ isQuitting, scanningEnabled: runtime.isScanningEnabled(), platform: process.platform })) {
    app.quit();
  }
});

app.on("activate", () => {
  runtime.showMainWindow();
});
```

- [ ] **Step 5: Full-suite + typecheck + build gate**

Run (from `electron-app/`): `npm test && npm run typecheck && npm run build`
Expected: ALL green (`pretest` restores the system-Node `better-sqlite3` build); typecheck clean; the build emits `out/preload/settingsPreload.js` and `out/renderer/settings.html`. Also run the Rust workspace once from `rust-core/`: `cargo test` — all crates green.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/bootstrap.ts electron-app/src/main/main.ts electron-app/test/main/scanScheduler.integration.test.ts
git commit -m "feat(app): wire scan scheduler, tray, settings window, and tray-resident lifecycle"
```

- [ ] **Step 7: Manual verification checklist** (run once via `npm start`; live items require a real Kite session + authenticated `claude` and are never a blocker for calling 5d done — P5d§14)

**Automatable (mocked/real bridge + `npm start`):**
- Settings opens from the tray's "Settings" item, showing the scan toggle (off), interval picker (15), an empty watchlist, and the Kite/sidecar status fields.
- Searching and adding an instrument updates the watchlist list; removing it empties the list again.
- Toggling scanning on, then closing the main window, leaves the process alive (tray icon remains; `npm start`'s process does not exit).
- The tray's "Show" item re-opens the main window (proving the hoisted IPC registration survives a window recreation — no "second handler" throw).
- The tray's "Quit" item exits the process cleanly.

**Live follow-ups (real Kite login + real `claude` auth, a short interval like 5 minutes):**
- With one real symbol on the watchlist and scanning enabled: a `NoChange` tick produces no new History entry and no notification.
- A tick with a real confluence shift creates a new Engine-Only session in `HistorySidebar` (`trigger: "proactive_scan"` in its stored payload) and fires a desktop notification whose body is the deterministic headline's first line.
- Given a large enough swing (or by temporarily lowering `GateThresholds` for the test), a tick produces a full AI-Assisted session — persona pipeline, narrative, its own notification.
- Reopening that AI-Assisted session and sending a follow-up behaves as an ordinary AI-Assisted chat (confirming P5d§8.5's "no special-casing on reopen" directly): the next turn shows `--resume <uuid>` where the scan's turn pinned `--session-id <uuid>`.
- Inspecting `claude --debug`: the scan-fired narrative call offers no tool beyond the existing Kite reads + `WebSearch`/`WebFetch` — the grant is unchanged this phase.

---

## Self-Review

Run after the plan was written; findings fixed inline above.

**1. Spec coverage (against `2026-07-27-phase5d-settings-scan-scheduler-design.md`):**
- P5d§2 scope (in/out) → Tasks 1–14 cover every in-scope item; nothing touches the order-placement surface, the per-session mode prompt, Phase 6/7, per-symbol aggregation, OS-level scheduling, per-entry horizon/lens, or UI-tunable thresholds.
- P5d§3.1 existing watchlist schema (unchanged) → preserved verbatim in Task 2.
- P5d§3.2 `remove_watchlist_symbol` (idempotent DELETE) → Task 2.
- P5d§3.3 `scan_snapshots` table, `ConfluenceSnapshot`, `serde`/`serde_json` deps, `StorageError::Json` → Task 2.
- P5d§3.4 `get_last_snapshot`/`set_last_snapshot` (upsert) + `open()` DDL → Task 2.
- P5d§3.5 `state_store_test.rs` five additions → Task 2 (exact test names).
- P5d§4 + §4.1 + §4.2 + §4.3 `scan_gate` function, thresholds/formula derivation comment, `lib.rs` wiring, nine unit tests → Task 1.
- P5d§5.1 protocol variants + `ConfluenceWire` `Deserialize` → payload structs Task 3, tagged enum variants Task 4.
- P5d§5.2 `protocol_test.rs` round trips → standalone/struct-level Task 3, tagged-enum Task 4.
- P5d§5.3 four handlers + conversion helpers + four inline handler tests → Task 3.
- P5d§6 `main.rs` opens `StateStore`, ensures the lake-root dir, routes the four variants with `catch_unwind`, `end_to_end_test.rs` → Task 4.
- P5d§7.1/7.2/7.3 `sidecarProtocol.ts` mirror, four `SidecarSupervisor` methods, encode/decode + resolve/timeout tests → Task 5.
- P5d§8.1 fixed `SCAN_HORIZON`/`SCAN_INTENT_LENS` constants → Task 8.
- P5d§8.2 `watchlistInstrumentResolver.ts` (never-cache-token, duplicated parsing) + tests → Task 6.
- P5d§8.3 tick algorithm (skip on no Kite, sequential loop, overlap guard, per-symbol try/catch) → Task 8.
- P5d§8.4 three gate outcomes (`recordWorthLook`/`recordWorthAiCall`) → Task 8.
- P5d§8.5 each fired tick is its own fresh session (`resumeSession: false`, fresh `randomUUID`) → Task 8.
- P5d§8.6 `scanScheduler.test.ts` → Task 8 (the ten named cases plus one additive "disabled → no timer" case).
- P5d§8.7 `sendScanNotification` closure + scheduler construction in bootstrap → Task 14.
- P5d§9.1 icon assets → Task 11 (deterministic PNG generator, both files committed).
- P5d§9.2 `buildTrayMenuTemplate`/`createTray` + `tray.test.ts` → Task 11.
- P5d§9.3 `shouldQuitOnAllWindowsClosed` + `main.ts` lifecycle → Task 10 (pure fn + test) and Task 14 (`main.ts`).
- P5d§9.4 `AppRuntime` extension, window singleton tracking, `showMainWindow`/`showSettingsWindow`, `stop()` order, `start()` tray, `isScanningEnabled`, IPC-hoist fix → Task 13 (hoist) + Task 14 (the rest).
- P5d§9.5 `appLifecycle.test.ts` → Task 10.
- P5d§10.1 `settingsWindowOptions` + test → Task 12.
- P5d§10.2 second preload/renderer entry points + `electron.vite.config.ts` → Task 12.
- P5d§10.3 `SettingsWindow.tsx` (three sections, static claude-auth hint reused verbatim) → Task 12.
- P5d§10.4 `SettingsWindow.test.tsx` → Task 12.
- P5d§11.1 `settingsBridge.ts` (persist + apply-to-scheduler; `searchInstruments` reuses `kite:searchInstruments`) → Task 9.
- P5d§11.2 `SettingsApi`/`buildSettingsApi` + `ScanConfig` re-export (main `RendererApi` unchanged) → Task 9.
- P5d§11.3 `settingsBridge.test.ts` → Task 9.
- P5d§12 `ScanConfig`/`ScanIntervalMinutes`/`DEFAULT_SCAN_CONFIG`, `scan_config` singleton table + seed + accessors + tests → Task 7; scheduler seeded from `history.getScanConfig()` → Task 14.
- P5d§13 testing strategy → every task's tests + Task 14's real-`HistoryStore` integration proof.
- P5d§14 manual checklist → Task 14 Step 7.
- P5d§15 flagged tensions → all honored: IPC-hoist is its own Task 13 (item 1); the macOS `window-all-closed` behavior change is realized by Task 10 + Task 14 (item 2); `storage` gains `serde` but not `algo-core` (item 3, Task 2); the first second-`BrowserWindow` build-config change is Task 12 (item 4); per-entry horizon/lens stays rejected in favor of constants (item 5, Task 8); `AnalysisEnvelope.trigger: "proactive_scan"` is first populated by `assembleEnvelope` in Task 8 (item 6); `Notification`/`Tray` add no npm dep (item 7, Tasks 11/14).
- P5d§16 file layout → every named create/modify maps to a task; the "explicitly considered, not changed" list (`package.json`, `preload.ts`, `analysisBridge.ts`, `historyBridge.ts`, `App.tsx`/`ChatView.tsx`/`AnalysisResult.tsx`/`HomeScreen.tsx`/`HistorySidebar.tsx`, `instrumentParsing.ts`) is respected — none are modified.
- P5d§17 out of scope → nothing in any task implements order placement, mode-prompt pre-answering, Phase 6/7, cross-symbol aggregation, OS-level scheduling, per-entry config, UI thresholds, session rename/delete/export, the `auto` horizon, a polished icon, or notification deep-linking.

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"add appropriate error handling"/"similar to Task N"/"write tests for the above". Every implementation step shows complete code (Rust and TS); every test step shows real assertions; every run step shows an exact command + expected result. The icon assets are produced by a concrete, CRC-correct PNG generator, not left as "create an icon".

**3. Type consistency (cross-task, both toolchains):**
- Rust: `ScorecardSummary`'s four fields ≡ `ConfluenceSnapshot` (Task 2) ≡ `ConfluenceWire` (Task 3) — the conversion helpers `wire_to_scorecard`/`scorecard_to_snapshot`/`snapshot_to_scorecard` (Task 3) map them field-for-field. `evaluate_scan_gate(Option<&ScorecardSummary>, &ScorecardSummary, &GateThresholds) -> GateDecision` (Task 1) is called by `handle_evaluate_scan_gate` with `prev_scorecard.as_ref()` (Task 3). `WatchlistResponse`/`ScanGateResponse` (Task 3) are the exact variants `main.rs` constructs (Task 4). The four handler signatures (`handle_*`) defined in Task 3 are the exact ones `main.rs` calls in Task 4.
- TS: `WatchlistResponseWire`/`ScanGateResponseWire` (Task 5) are consumed by `settingsBridge` via `.symbols` (Task 9) and by `ScanScheduler` via `.decision` (Task 8). The four `SidecarSupervisor` method names (Task 5) match every `Pick<SidecarSupervisor, …>` (Tasks 8, 9). `ScanConfig`/`ScanIntervalMinutes` (Task 7) is imported from `historyStore` by the scheduler (Task 8) and re-exported through `rendererApi` for the Settings renderer (Tasks 9, 12) — one shape `{ enabled: boolean; intervalMinutes: ScanIntervalMinutes }` everywhere. `ScanScheduler.setConfig/getConfig/stop/tick` (Task 8) match `settingsBridge`'s `Pick<…, "setConfig">` (Task 9) and bootstrap's `getConfig().enabled`/`stop()` (Task 14). `SettingsApi`/`buildSettingsApi` (Task 9) is used by `settingsPreload.ts`, `settingsBridge()`, and `SettingsWindow.tsx` (Task 12) with identical method names/signatures. `resolveWatchlistInstrument`'s `Pick<KiteClient, "searchInstruments">` (Task 6) accepts the real `KiteClient` the scheduler passes (Task 8). `AppRuntime` grows `showMainWindow`/`isScanningEnabled` (Task 14) exactly as `main.ts` consumes them (Task 14). `shouldQuitOnAllWindowsClosed`'s param object (Task 10) matches `main.ts`'s call site (Task 14).

**4. Safety:** No task expands Claude's tool access or adds a Kite write path. The `WorthAiCall` scan path (Task 8) calls the identical `AiAssistedProvider.completeAiAssisted` AI-Assisted mode already uses; `claudeSessionId` is a self-generated `randomUUID()`, never argv passthrough. The scheduler reaches Kite only through `getKite()`'s read-only `KiteClient` and the sidecar's read-only `compute`/`persistCandles`/gate calls. Tasks 8 and 14 each carry an explicit safety note in their body. `notify` only shows a desktop `Notification`.

**Deviations / gaps I resolved (none left as open questions for the human):**
1. **Sidecar split forced by enum exhaustiveness (packaging, not a spec change).** Adding variants to the `SidecarRequest` enum makes `main.rs`'s `match` non-exhaustive, so the enum extension and the `main.rs` dispatch arms *must* land in one commit. I therefore split P5d§5–§6 into Task 3 (payload structs + `ConfluenceWire` `Deserialize` + handlers + their tests — no enum touch, crate still compiles) and Task 4 (enum variants + `main.rs` + tagged/e2e tests, atomically). Every type and wire shape still matches the spec exactly; only the commit boundary is a planning decision.
2. **Bootstrap hoist as a standalone Task 13.** The spec (P5d§9.4/§15 item 1) describes the IPC-registration hoist as a necessary companion fix. I sequenced it as its own behavior-preserving refactor (full suite stays green, `AppRuntime` unchanged, `main.ts` untouched) immediately before Task 14's additive tray/settings wiring, so the risky restructure is reviewable in isolation from the new feature code. This is the spec's own dependency logic, made explicit.
3. **Tray reference retention + teardown (spec elision resolved).** The spec's `start()` snippet calls `createTray({…})` without storing the result, and its `stop()` snippet omits tray teardown. An unreferenced Electron `Tray` can be garbage-collected (its icon vanishes), so Task 14 retains it in a closured `let tray: Tray | null` and calls `tray?.destroy()` in `stop()`. This is a faithful implementation of "the tray is created once, unconditionally, at app startup," not a redesign — flagged here for the reviewer.
4. **`ScanSchedulerDeps.history` includes `getClaudeSessionId`, which the scheduler never calls** (scan sessions are always fresh, so `resumeSession` is always `false`). I kept the `Pick` exactly as P5d§8.3 wrote it rather than trimming it — spec-exact, harmless, and it keeps the deps shape stable if a future phase does want reopen-continuation inside a scan session.
5. **Bootstrap has no unit test (as in Phase 5c).** `createApp` is Electron-runtime-bound (`app.getPath`, `ipcMain`, `BrowserWindow`, `Tray`, `Notification`); `bootstrap.test.ts` covers only the pure `handleKiteResponse`. The new wiring is instead covered by `settingsBridge.test.ts` + `scanScheduler.test.ts` + `scanScheduler.integration.test.ts` (real `HistoryStore`) + typecheck + build + full-suite-green + the P5d§14 manual checklist. Stated in Tasks 13 and 14 rather than left implicit.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-27-phase5d-settings-scan-scheduler-plan.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks. Tasks 1–2 (Rust building blocks) and Tasks 5–7 + 10 + 11 (independent TS leaves) are parallelizable; Tasks 3→4 (Rust sidecar), 8 (needs 5/6/7), 9 (needs 7/8), 12 (needs 9), 13→14 (needs everything) are serialized by their dependencies.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
