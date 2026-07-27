# Phase 5d — Settings Window + Proactive Scan Scheduler

Status: approved by user 2026-07-27 (brainstorming dialogue), pending implementation planning.
Author: design produced via superpowers:brainstorming, concretizing §8.1 (process topology & scheduling) and §8.4 (Settings window) of `docs/superpowers/specs/2026-07-18-trade-assistant-design.md`, and finishing the Phase 5 decomposition begun in `docs/superpowers/specs/2026-07-25-phase5a-live-wiring-design.md` / `docs/superpowers/specs/2026-07-26-phase5b-ai-assisted-chat-design.md` / `docs/superpowers/specs/2026-07-27-phase5c-session-history-design.md`. Section references: "§N" → master design; "P5c§N" → the Phase 5c spec; "P5d§N" → this document.

## P5d§1 Purpose

§8.1 of the master design sketched proactive scanning as a deterministic pre-Claude gate deciding "whether a given scan tick is worth spending an actual Claude call on... or just re-rendering a deterministic summary," running only when the user opts in via Settings, with Electron staying tray-resident so the scheduler survives no chat window being open. §8.4 sketched the Settings window itself: a scan on/off toggle (default off), watchlist membership, and a read-only Kite/Claude status display. Both sections described the *shape* of this feature; neither specified a schema, a wire protocol, a gate formula, or a file layout. This document supersedes both sketches with the full, concrete design: exact Rust storage schema and pure-function gate logic, exact sidecar wire-protocol additions, the exact scan-scheduler tick algorithm, the exact tray/window lifecycle, and the exact Settings IPC contract.

Phase 5d's place in the roadmap (`docs/superpowers/plans/2026-07-18-implementation-roadmap.md` §"Phase 5"): it is the fourth and final sub-phase of Phase 5 (5a → 5b → 5c → 5d). 5a wired Engine-Only end-to-end live; 5b added AI-Assisted mode and the response-mode picker; 5c added the persisted session/history store and real Claude conversational continuity for the narrative call. This phase adds the last two items the roadmap's Phase 5 file-list sketch named but never detailed — `scanScheduler.ts` and `SettingsWindow.tsx` — by wiring the scan scheduler to the same `assembleEnvelope` / `generateDeterministicResponse` / `ClaudeCliProvider.completeAiAssisted` / `HistoryStore` machinery 5a–5c already built, not a parallel path. **Once this phase is done, Phase 5 as a whole is done.** Phase 6 (Benchmark UI, §10.4) and Phase 7 (platform/build/packaging, §11) are next on the roadmap and remain unscoped by this document.

Everything obeys the master hard constraints (§2, §4): **the app never places, modifies, cancels, or automates an order.** This phase adds no Kite write-tool method, no new Claude tool grant, and no code path that could reach `place_order`/`modify_order`/`cancel_order`/`place_gtt_order`/`modify_gtt_order`/`delete_gtt_order` — the scan scheduler only ever calls the same read-only `KiteClient` methods and the same `Provider`/`AiAssistedProvider` interfaces every other phase already uses. Proactive scanning, per §2, only ever produces information for the user to read (a history entry, a desktop notification); it never acts. This invariant is restated here, as in every phase, precisely because it is unaffected.

## P5d§2 Scope

**In scope:**

1. Rust: extend the existing, currently-unwired `StateStore` (`rust-core/crates/storage/src/state_store.rs`) with `remove_watchlist_symbol` and a new `scan_snapshots` table + accessors (P5d§3).
2. Rust: a new pure function `algo_core::scan_gate::evaluate_scan_gate` and its supporting types, unit-tested directly, no I/O (P5d§4).
3. Rust: new sidecar protocol request/response variants (`AddWatchlistSymbol`, `RemoveWatchlistSymbol`, `ListWatchlist`, `EvaluateScanGate`) routed through `main.rs`'s existing per-request `catch_unwind` isolation (P5d§5).
4. TypeScript: the wire-protocol mirror in `sidecarProtocol.ts` and four new `SidecarSupervisor` methods, following the exact existing per-request-timeout pattern (P5d§6).
5. TypeScript: a new `ScanScheduler` (`electron-app/src/main/scanScheduler.ts`) — opt-in, tray-resident, configurable interval, reusing `assembleEnvelope`/`generateDeterministicResponse`/`ClaudeCliProvider.completeAiAssisted`/`HistoryStore` exactly as every other analysis path does (P5d§7).
6. A tray icon + context menu (`electron-app/src/main/tray.ts`) and the exact `window-all-closed`/`activate`/`before-quit` lifecycle interaction this requires (P5d§8).
7. A dedicated Settings window — its own `BrowserWindow`, preload, and renderer entry point, mirroring `mainWindow.ts`'s exact security posture (P5d§9).
8. New IPC: `settings:getScanConfig`/`setScanConfig`, `settings:listWatchlist`/`addWatchlistSymbol`/`removeWatchlistSymbol`, `settings:getAccountStatus`, via a new `settingsBridge.ts` (P5d§10).
9. `ScanConfig` (enabled + interval) persistence across app restarts (P5d§12).

**Not in scope (deferred, or permanently out of scope — P5d§17 has the full list):**

- Any change to the no-order-placement safety invariant (§2, §4).
- Any change to the mandatory per-session AI-Assisted/Engine-Only prompt (§9) — Settings still never pre-answers it.
- Phase 6 (Benchmark UI) and Phase 7 (packaging/CI).
- Multi-instrument/portfolio-level aggregation beyond a flat watchlist symbol list.
- Any scan-interval enforcement beyond a simple in-process timer — no OS-level cron/launchd/scheduled-task integration.
- Per-watchlist-entry horizon/intent-lens configuration (resolved as fixed constants instead — P5d§7.1).
- Tunable gate thresholds exposed in the UI (fixed Rust-side defaults only — P5d§4).

## P5d§3 Storage: `StateStore` extensions

### P5d§3.1 Existing schema (unchanged)

`rust-core/crates/storage/src/state_store.rs` today has one table and two methods:

```rust
CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL UNIQUE,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
)
```

`add_watchlist_symbol(symbol: &str) -> Result<()>` (an `INSERT OR IGNORE`, idempotent) and `watchlist() -> Result<Vec<String>>` (ordered by insertion `id`). `symbol` is the same `exchange:tradingsymbol` key the master design uses everywhere else (§5.1's "key all persisted data on `exchange:tradingsymbol`, never on the numeric `instrument_token`") — the existing test file already uses this shape (`"NSE:INFY"`, `"NSE:TCS"`).

### P5d§3.2 New method: `remove_watchlist_symbol`

```rust
pub fn remove_watchlist_symbol(&self, symbol: &str) -> Result<()> {
    self.conn.execute("DELETE FROM watchlist WHERE symbol = ?1", [symbol])?;
    Ok(())
}
```

Removing a symbol not currently on the watchlist is a harmless no-op (0 rows affected, no error) — the same idempotence philosophy as `add_watchlist_symbol`'s `INSERT OR IGNORE`.

### P5d§3.3 New table: `scan_snapshots`

The scan gate's memory — "what did this symbol's confluence look like last time it was scanned" — lives in Rust, per the locked decision: proactive scanning is deterministic-engine-adjacent state, and Rust already owns the algorithm/confluence computation (§6.3), so it owns the delta computation's own memory too, rather than Electron maintaining a shadow copy.

```sql
CREATE TABLE IF NOT EXISTS scan_snapshots (
  symbol TEXT PRIMARY KEY,
  confluence_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)
```

`confluence_json` is a serialized `ConfluenceSnapshot`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConfluenceSnapshot {
    pub bullish_count: usize,
    pub bearish_count: usize,
    pub neutral_count: usize,
    pub weighted_vote: f64,
}
```

These four fields mirror `ConfluenceWire`'s exact shape (`rust-core/crates/sidecar/src/protocol.rs`) and `algo_core::confluence::ScorecardSummary`'s exact shape — deliberately, not by coincidence. `ConfluenceSnapshot` is **not** a re-export of either: it is defined locally in `storage` and mirrored across the boundary, exactly matching how `sidecar::protocol::ConfluenceWire` already mirrors `algo_core::confluence::ScorecardSummary` field-for-field rather than importing it directly (`handlers.rs`'s `handle_request` manually maps `confluence.bullish_count` etc. into `ConfluenceWire` today). `storage` gains no new dependency on `algo-core` because of this — the two crates stay exactly as decoupled as they are today (`storage`'s only dependencies remain `rusqlite`/`duckdb`, plus the two new `serde`/`serde_json` entries below); the actual `ScorecardSummary`-typed comparison happens inside the sidecar's handler layer, which already depends on both crates (P5d§5.3).

New `storage/Cargo.toml` dependencies (matching the versions already used by the `sidecar` crate):

```toml
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

New `StorageError` variant (`rust-core/crates/storage/src/error.rs`), following the existing `Io`/`Duckdb`/`Sqlite` pattern exactly:

```rust
#[derive(Debug)]
pub enum StorageError {
    Io(std::io::Error),
    Duckdb(duckdb::Error),
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
}
```

with `StorageError::Json(e) => write!(f, "storage json error: {e}")` in `Display`, and `impl From<serde_json::Error> for StorageError` mirroring the three existing `From` impls.

### P5d§3.4 New accessor methods

```rust
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
```

`set_last_snapshot` is an upsert (SQLite's `ON CONFLICT ... DO UPDATE`, available in the bundled `rusqlite`/SQLite version this workspace already pins) — every scan tick for a symbol overwrites that symbol's one row rather than accumulating history; `scan_snapshots` is a "last observation" cache, not a time series. (A time series of every past confluence snapshot is not needed by anything in this phase — the deterministic/AI responses that get persisted permanently already live in `HistoryStore`'s `messages` table, P5c§3.1, and this phase's scan-originated sessions reuse that same table via `appendMessage`, P5d§8.4.)

`open()` gains the `scan_snapshots` `CREATE TABLE IF NOT EXISTS` alongside the existing `watchlist` one, in the same idempotent-DDL-at-open style already used there.

### P5d§3.5 Test additions (`rust-core/crates/storage/tests/state_store_test.rs`)

- `remove_watchlist_symbol_removes_only_the_named_symbol` — add two, remove one, assert the other remains.
- `removing_a_symbol_not_on_the_watchlist_is_a_harmless_no_op` — remove on an empty/mismatched store, assert no error.
- `get_last_snapshot_returns_none_for_a_symbol_never_scanned`.
- `set_last_snapshot_then_get_last_snapshot_round_trips` — exact field equality.
- `set_last_snapshot_twice_overwrites_rather_than_duplicating` — call twice with different values, assert `get_last_snapshot` returns only the second value (proving the upsert, not an accumulating insert).

## P5d§4 `scan_gate.rs`: the pure gate function

New file: `rust-core/crates/algo-core/src/scan_gate.rs`. Pure, deterministic, no I/O — directly unit-tested, matching this crate's established style for a pure aggregation-adjacent module (`confluence.rs` is the closest sibling).

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
        // history) -- there is nothing real to compare or to show, so this
        // never counts as a change regardless of what `prev` was.
        return GateDecision::NoChange;
    }

    let Some(prev) = prev else {
        // First time this symbol has ever been scanned: there is no baseline
        // to diff against, but the user does want to see at least one read
        // rather than have it silently swallowed forever -- so the very
        // first observation always clears the low bar.
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

### P5d§4.1 Why this formula, and why these defaults

`ScorecardSummary` (`algo_core::confluence`) has exactly four fields: `bullish_count`, `bearish_count`, `neutral_count`, `weighted_vote` (documented range roughly `[-1.0, 1.0]`). Two independent signals are derivable from these: how far the **weighted vote** moved (`vote_delta`, range `[0, 2]`), and how far the **net directional count** moved, normalized by how many algorithms actually voted this tick (`net_delta` — comparable scale, since it's a ratio of the same three counts). The brainstorm's own framing ("weighted-vote swing and/or bullish/bearish count flips") is an **or**: either signal moving far enough is reason enough to escalate. `gate_delta = vote_delta.max(net_delta)` implements that "or" as a single scalar so both thresholds are applied to one number — the small threshold crosses into `WorthLook`, the larger one into `WorthAiCall` — rather than needing two independent threshold pairs that could disagree with each other.

Default numbers, derived from this codebase's actual current catalog rather than picked arbitrarily: the release registry (`rust-core/crates/algo-core/tests/registry_count_test.rs`'s `EXPECTED_DEFAULT_IDS`) has **34 algorithms**, and the sidecar's `handle_request` currently runs `compute_confluence` with equal (1.0) weights for every one that clears its lookback gate (`HashMap::new()` defaulting via `unwrap_or(&1.0)`, per `handlers.rs`). Under equal weighting, one algorithm flipping between Bullish and Bearish moves `weighted_sum` by `2 * weight` while `weight_total` stays roughly the full algorithm count — so one flip shifts `weighted_vote` by roughly `2/34 ≈ 0.06`. On that basis:

- `worth_look_delta = 0.10` — a little under two algorithms' worth of net directional change (`2 × 0.06 ≈ 0.12`, i.e. "a couple of algorithms just changed their read since last tick" is the bar for "glance at this"). Chosen as a round number close to, not exactly equal to, that two-algorithm estimate, since real weights will stop being uniform once the backtest engine's hit-rate weighting lands (§6.3) and this threshold is meant to represent "a real shift," not a number tied permanently to today's equal-weight scheme.
- `worth_ai_call_delta = 0.25` — roughly double `worth_look_delta`, corresponding to on the order of four-plus algorithms' worth of net change (`4 × 0.06 ≈ 0.24`) — clearly more than noise, a bar worth spending an actual Claude call on.

Both numbers are v1 starting points, not a claim that "34" or "0.06" stays literally accurate as the weighting scheme evolves — they are documented here precisely so a future tuning pass has a stated baseline to reason from rather than an unexplained magic number. `GateThresholds` is a plain struct (not persisted, not exposed in the Settings UI — P5d§17) so tuning it later is a one-line code change, not a schema migration.

The `curr_total == 0` guard exists because `compute_confluence` (§6.3) already defaults `weighted_vote` to `0.0` when nothing voted; without this guard, a symbol that transiently has too little history to run any algorithm would look like "everything just flipped to zero," which would spuriously trigger `WorthAiCall` against a data gap rather than a real market signal.

### P5d§4.2 `lib.rs` wiring

`rust-core/crates/algo-core/src/lib.rs` gains `pub mod scan_gate;`, matching how `confluence`/`registry` are already exposed as public module namespaces (not root-re-exported) — callers use `algo_core::scan_gate::{evaluate_scan_gate, GateDecision, GateThresholds}`, the same access pattern as `algo_core::confluence::compute_confluence`.

### P5d§4.3 Test file (`rust-core/crates/algo-core/tests/scan_gate_test.rs`, new)

Following the established convention that later-catalog-addition modules get a dedicated `tests/<name>_test.rs` file rather than inline `#[cfg(test)]` tests (e.g. `adx.rs`/`adx_test.rs` — the three Phase-1 baseline indicators are the only ones with inline tests):

- `first_ever_scan_of_a_symbol_is_worth_a_look` — `prev = None`, `curr` has real counts → `WorthLook`.
- `first_ever_scan_with_zero_algorithm_outputs_is_no_change` — `prev = None`, `curr` all-zero counts → `NoChange` (proves the zero-total guard runs before the `prev.is_none()` check).
- `identical_scorecards_are_no_change` — `prev == curr` → `NoChange`.
- `a_moderate_vote_swing_crosses_into_worth_look` — delta strictly between `0.10` and `0.25` → `WorthLook`.
- `a_large_vote_swing_crosses_into_worth_ai_call` — delta `>= 0.25` → `WorthAiCall`.
- `exactly_the_worth_look_threshold_counts_as_worth_look` — delta `== 0.10` exactly → `WorthLook` (proves the comparison is inclusive `>=`).
- `exactly_the_worth_ai_call_threshold_counts_as_worth_ai_call` — delta `== 0.25` exactly → `WorthAiCall`.
- `a_quiet_vote_with_a_loud_count_flip_still_escalates` — a constructed case where `weighted_vote` barely moves (e.g. `0.50 → 0.52`, `vote_delta = 0.02`, below even `worth_look_delta`) but the bullish/bearish counts swing hard (e.g. `{bullish:5, bearish:5, neutral:0}` net ratio `0.0` → `{bullish:9, bearish:1, neutral:0}` net ratio `0.8`, `net_delta = 0.8`) → `WorthAiCall`. This is the test that proves the `max()` combination is load-bearing, not decorative: a vote-only formula would have called this `NoChange`.
- `below_both_thresholds_is_no_change` — a small, realistic delta (e.g. one algorithm's worth, `~0.06`) → `NoChange`.

## P5d§5 Sidecar protocol additions

### P5d§5.1 New request/response variants (`rust-core/crates/sidecar/src/protocol.rs`)

`ConfluenceWire` gains `Deserialize` (it is currently `Serialize`-only, since it has only ever been produced, never consumed, by the sidecar — `EvaluateScanGate` is the first request that needs to receive one back):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfluenceWire {
    pub bullish_count: usize,
    pub bearish_count: usize,
    pub neutral_count: usize,
    pub weighted_vote: f64,
}
```

New request payloads:

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
```

New response payloads. `Add`/`Remove`/`List` all return the same shape — the resulting full watchlist after whatever mutation (if any) just happened — so three near-identical operations share one response type instead of three:

```rust
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
    /// already uses to mirror `algo_core::Direction` onto the wire as a plain
    /// Debug-formatted string rather than a bespoke serde enum.
    pub decision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
```

Extended tagged enums (`#[serde(tag = "type", rename_all = "snake_case")]`, unchanged convention):

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

Wire shapes, concretely:

```json
{"type":"add_watchlist_symbol","id":7,"symbol":"NSE:INFY"}
{"type":"remove_watchlist_symbol","id":8,"symbol":"NSE:INFY"}
{"type":"list_watchlist","id":9}
{"type":"evaluate_scan_gate","id":10,"symbol":"NSE:INFY","confluence":{"bullish_count":5,"bearish_count":2,"neutral_count":10,"weighted_vote":0.12}}
```

```json
{"type":"watchlist","id":7,"symbols":["NSE:INFY"]}
{"type":"scan_gate","id":10,"decision":"WorthLook"}
```

### P5d§5.2 `protocol_test.rs` additions

Parse/encode round trips for each of the four new request tags and the two new response tags, matching the existing `parses_a_tagged_compute_request`/`persist_response_omits_error_field_when_none` style — including a round trip proving `ConfluenceWire` now deserializes correctly (a JSON object with the four numeric fields parses into the same values it would serialize to).

### P5d§5.3 New handlers (`rust-core/crates/sidecar/src/handlers.rs`)

```rust
use algo_core::confluence::ScorecardSummary;
use algo_core::scan_gate::{evaluate_scan_gate, GateThresholds};
use storage::{ConfluenceSnapshot, StateStore};
use crate::protocol::{
    AddWatchlistSymbolRequest, ConfluenceWire, EvaluateScanGateRequest, ListWatchlistRequest,
    RemoveWatchlistSymbolRequest, ScanGateResponse, WatchlistResponse,
};

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
    match store.set_last_snapshot(&request.symbol, &scorecard_to_snapshot(&curr)) {
        Ok(()) => ScanGateResponse { id: request.id, decision: format!("{decision:?}"), error: None },
        Err(e) => ScanGateResponse { id: request.id, decision: format!("{decision:?}"), error: Some(e.to_string()) },
    }
}
```

The stored snapshot is always the current tick's confluence, even on a `NoChange` decision — otherwise a slow drift (many `NoChange` ticks each individually below threshold, but adding up over time) would never register, since every comparison would keep diffing against the same stale baseline. Comparing tick-to-tick (not "tick to last-meaningful-change") is the correct, simpler semantics and is what "last-seen snapshot per symbol" in the brainstorm's own wording means.

Four new inline tests in `handlers.rs`, matching its existing inline-test convention (this crate keeps handler tests in the same file, unlike `algo-core`'s separate-file convention — see the existing `handle_persist_writes_candles_that_read_back_from_the_kite_source` test): `handle_add_watchlist_symbol_returns_the_updated_list`, `handle_remove_watchlist_symbol_returns_the_updated_list`, `handle_list_watchlist_returns_the_current_list`, `handle_evaluate_scan_gate_returns_worth_look_on_first_scan_and_persists_the_snapshot`, `handle_evaluate_scan_gate_returns_no_change_on_an_identical_second_scan` (call it twice with the same `ConfluenceWire`, assert the second call is `NoChange`).

## P5d§6 `main.rs`: opening the state store and routing the new variants

Today's `lake_root_from_args()` is consumed directly into `CandleStore::open`. This phase opens a second store from the same root, so the root is bound once and both stores derive from it — and, since `StateStore::open` (unlike `CandleStore::open`) does not create its parent directory itself, `main` explicitly ensures the lake-root directory exists before opening either store, rather than relying on `CandleStore::open`'s own `create_dir_all` side effect running first:

```rust
fn state_db_path(lake_root: &Path) -> PathBuf {
    lake_root.join("state.sqlite3")
}

fn main() {
    let lake_root = lake_root_from_args();
    if let Some(root) = &lake_root {
        let _ = std::fs::create_dir_all(root);
    }
    let store = lake_root.as_ref().and_then(|root| CandleStore::open(root).ok());
    let state_store = lake_root.as_ref().and_then(|root| StateStore::open(&state_db_path(root)).ok());

    // ... existing stdin loop ...
}
```

Four new match arms in the request loop, each wrapped in the same `panic::catch_unwind(AssertUnwindSafe(...))` isolation as `Compute`/`PersistCandles`, and each falling back to the same `"no --lake-root configured"` message when `state_store` is `None`:

```rust
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
```

`RemoveWatchlistSymbol` and `ListWatchlist` follow the identical shape (swap in `handle_remove_watchlist_symbol`/`handle_list_watchlist`). `EvaluateScanGate` follows the same shape, returning `SidecarResponse::ScanGate(...)` with the `"no --lake-root configured"` fallback carrying `decision: "NoChange".to_string()`.

`rust-core/crates/sidecar/tests/end_to_end_test.rs` gains: a test that spawns the compiled binary with `--lake-root <tempdir>`, feeds `add_watchlist_symbol` → `list_watchlist` → `compute` → `evaluate_scan_gate` in sequence, and asserts the responses chain correctly (the watchlist contains the added symbol; the scan-gate response is `"WorthLook"` on the symbol's first-ever evaluation) and that `state.sqlite3` actually exists inside the tempdir afterward (proving the state store really opened, not silently `None`) — plus a panic-isolation regression test mirroring the existing `a_thin_history_request_between_two_valid_ones_does_not_kill_the_sidecar` test, sandwiching a malformed `evaluate_scan_gate` request between two valid ones and asserting the process answers all three and exits cleanly.

## P5d§7 TypeScript sidecar mirror

### P5d§7.1 `sidecarProtocol.ts` additions

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
```

### P5d§7.2 `SidecarSupervisor` additions

Four new methods, following `compute`/`persistCandles`'s exact existing shape — each just builds a tagged request object and delegates to the already-existing `send()`, which already owns id-assignment, the per-request timeout, and pending-map bookkeeping. No new timeout logic, no new plumbing:

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

### P5d§7.3 Test additions

`sidecarProtocol.test.ts`: encode/decode coverage for the four new request shapes and two new response shapes. `sidecarSupervisor.test.ts`: each of the four new methods resolves via a fake child process responding with the matching `type` tag (mirroring the existing `compute`/`persistCandles` resolution tests), and each rejects on timeout exactly like the existing `compute` timeout test (proving no new timeout code path was introduced — they all share `send()`'s one implementation).

## P5d§8 Scan scheduler (`electron-app/src/main/scanScheduler.ts`, new)

### P5d§8.1 What a watchlist entry carries — resolved concretely

A watchlist entry, as stored by Rust (P5d§3), is **just its `exchange:tradingsymbol` string** — nothing more. This is a deliberate choice, not an oversight: the sidecar's new `AddWatchlistSymbol`/`RemoveWatchlistSymbol`/`ListWatchlist` are explicitly "thin wrappers over `StateStore`" (P5d§5.1), and `StateStore`'s watchlist table stays membership-only rather than gaining per-entry `horizon`/`intent_lens` columns. Instead, **every scan tick uses one fixed horizon and one fixed intent lens for every watchlist symbol**, defined as module-level constants in `scanScheduler.ts`:

```typescript
const SCAN_HORIZON: Horizon = "intraday";
const SCAN_INTENT_LENS: IntentLens = "buying";
```

`"intraday"` is chosen because it matches the scheduler's own tick cadence (5–60 minutes, P5d§12): `horizonToFetchParams("intraday", now)` fetches 5-minute candles over a 5-day lookback, which is data that actually changes meaningfully between ticks at these intervals — `"positional"` (day candles, 365-day lookback) would barely change within a single trading day no matter how often the scheduler ticks, making frequent re-computation mostly wasted work. `"buying"` is chosen because a watchlist is conceptually a list of names being *considered*, not a list of already-held positions (`§8.4`'s "watchlist/portfolio membership" — this design treats it as the watchlist, not the portfolio); `"buying"`'s framing ("is this worth an entry") fits that better than `"selling"`'s ("should I exit this"). Neither constant is exposed in the Settings UI in this phase (P5d§17) — extending the watchlist schema to carry per-entry values is a natural, well-scoped future extension if it's ever needed, but this phase does not build it.

Because a watchlist entry is only ever a bare symbol string, and instrument identity must never be persisted via a cacheable `instrument_token` (§5.1 — F&O tokens recycle every expiry), the scheduler re-resolves a full `InstrumentSelection` (`symbol`, `exchange`, `segment`, `instrumentToken`) fresh from Kite on every tick, per symbol.

### P5d§8.2 Resolving a watchlist symbol into a live instrument

New file: `electron-app/src/main/services/kite/watchlistInstrumentResolver.ts`.

```typescript
export function parseWatchlistSymbol(symbol: string): { exchange: string; tradingsymbol: string } | null {
  const separatorIndex = symbol.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === symbol.length - 1) return null;
  return { exchange: symbol.slice(0, separatorIndex), tradingsymbol: symbol.slice(separatorIndex + 1) };
}

export async function resolveWatchlistInstrument(
  kite: Pick<KiteClient, "searchInstruments">,
  symbol: string,
): Promise<InstrumentSelection | null> {
  const parsed = parseWatchlistSymbol(symbol);
  if (!parsed) return null;
  const raw = await kite.searchInstruments(parsed.tradingsymbol);
  const candidates = extractInstrumentCandidates(raw); // same MCP-response-shape parsing as below
  return candidates.find((candidate) => candidate.symbol === symbol) ?? null;
}
```

`extractInstrumentCandidates` reimplements the exact same raw-MCP-response parsing already in `electron-app/src/renderer/instrumentParsing.ts`'s `parseInstruments` (the three response shapes it already handles: a flat array, a Kite REST-style `{data:[...]}` envelope, or the MCP SDK's `{content:[{type:'text', text:'...'}]}` shape) — deliberately **duplicated**, not imported, because `instrumentParsing.ts` lives under `src/renderer/` and `scanScheduler.ts` lives under `src/main/`: those are two separate `electron-vite` build targets (`main`/`renderer` in `electron.vite.config.ts`), and the established direction in this codebase is that main-process types cross into the renderer via `rendererApi.ts`, never the reverse. This mirrors the same "mirror small pure parsing/shape logic at each boundary rather than share it across a boundary that otherwise shouldn't depend on it" precedent already established by `ConfluenceWire` mirroring `ScorecardSummary` (P5d§3.3) — a second small, deliberate duplication of the same kind, not an inconsistency.

If no exact `(exchange, tradingsymbol)` match is found (e.g. a delisted symbol), `resolveWatchlistInstrument` returns `null` rather than throwing — the caller (P5d§8.3) treats this as "skip this symbol this tick," not a fatal error.

Test file: `electron-app/test/main/services/kite/watchlistInstrumentResolver.test.ts` — `parseWatchlistSymbol` accepts a well-formed `"NSE:INFY"` and rejects `"NOEXCHANGE"`/`":INFY"`/`"NSE:"`/`""`; `resolveWatchlistInstrument` picks the exact match out of a multi-result raw response and returns `null` when no candidate's `(exchange, tradingsymbol)` matches.

### P5d§8.3 The tick algorithm

```typescript
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
      if (!kite) return; // not logged in to Kite today; wait for the next tick -- the
                          // scheduler never itself triggers a login flow (§8.3 keeps
                          // that user-initiated).
      const watchlist = await this.deps.sidecar.listWatchlist();
      // Sequential, not Promise.all: Kite's historical-data rate limit is 3
      // req/sec (§5.1) and a scan can cover many symbols; processing one
      // symbol fully (fetch, persist, compute, gate) before starting the next
      // is the simplest way to stay under that limit without a dedicated
      // request-rate limiter this phase doesn't need yet.
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
      // must not take the rest of this tick's watchlist down with it -- the
      // same per-unit isolation philosophy as the sidecar's own catch_unwind.
      console.error(`scan: tick failed for ${symbol}: ${(error as Error).message}`);
    }
  }

  // recordWorthLook / recordWorthAiCall -- P5d§8.4
}
```

`assembleEnvelope` and `horizonToFetchParams` are imported and used exactly as `analysisBridge.ts`'s `runAnalysisRequest`/`runAiAssistedRequest` already use them — no parallel computation path. `trigger: "proactive_scan"` is passed through to `assembleEnvelope`'s params, which places it on the resulting `AnalysisEnvelope.trigger` — the first real population of that field since it was added, unused, in Phase 4 (`contracts.ts`'s `trigger: "reactive" | "proactive_scan"`).

If `getKite()` returns `null` (no active Kite session — the daily token has not been refreshed, or the user has simply never logged in this run), the **entire tick** is skipped: no watchlist symbols are processed, nothing is written to history, no notification fires. The scheduler does not attempt to trigger `login()` itself; §8.3 keeps Kite login a user-initiated action via the existing banner/login flow, and the next tick will simply try again.

### P5d§8.4 The three gate outcomes

**`NoChange`:** nothing happens at all — no history entry, no notification. This is a deliberate choice to avoid flooding history with no-op entries every 5–60 minutes for every watchlist symbol; a scan tick that found nothing new leaves no trace.

**`WorthLook`:** the deterministic path, reusing `generateDeterministicResponse` exactly as Engine-Only mode does, persisted as a **brand-new session**:

```typescript
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
```

This two-message shape (a synthetic "user" turn describing the trigger, then the assistant reply) exactly mirrors `runAnalysisRequest`'s existing `describeEngineOnlyQuery`-then-`generateDeterministicResponse` ordering — a scan-originated session reads, in `HistorySidebar`/`AnalysisResult`'s existing rendering (P5c§8.6), exactly like an ordinary Engine-Only session, just with a "Proactive scan: ..." first line instead of a real free-text/wizard query. The notification body is `response.text`'s first line — `generateDeterministicResponse`'s own headline sentence (`deterministicResponseGenerator.ts`'s `headlineFor`, e.g. `"Overall read: bullish (medium conviction)."`), since the full text's first line is already written to read as a standalone summary.

**`WorthAiCall`:** the full AI-Assisted pipeline, via `ClaudeCliProvider.completeAiAssisted`, **skipping `intake`** — instrument and horizon are already resolved (P5d§8.1/8.2), so there is nothing for `intake` to extract from free text:

```typescript
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
    onNarrativeToken: () => {}, // no live renderer is streaming this tick's narrative
    claudeSessionId,
    resumeSession: false, // every scan-fired session is brand new -- P5d§8.5
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
```

`CompleteAiAssistedOptions.onNarrativeToken` is a required field (`provider.ts`) because AI-Assisted mode always streams; a scan tick has no live renderer subscribed to `analysis:narrative` for this request, so it passes a no-op and only consumes the final resolved `{ verdict, narrative }`. `researchNotes` is omitted (it is optional, and normally comes from `intake`, which this path skips — no web/news research happens for a scan-originated call, matching how Engine-Only mode already has no `news_context` per §9.2). If `completeAiAssisted` throws, the user message written just above stays orphaned (no assistant reply, no notification) — the exact same accepted "orphaned turn" behavior P5c§7.3 already established for `runAiAssistedRequest`, reached here via `tickOneSymbol`'s per-symbol `try`/`catch` (P5d§8.3) instead of `analysisBridge.ts`'s IPC-level one.

### P5d§8.5 Why "each fired tick is its own session" costs nothing later

Each `WorthLook`/`WorthAiCall` outcome creates a brand-new session (`createSession`), never appends to a prior scan's session — the simplest possible mapping onto Phase 5c's session model, and the explicitly approved choice over a long-running per-symbol thread. For `WorthAiCall`, this means `claudeSessionId` is always freshly pinned (`randomUUID()`, `resumeSession: false`) — there is never a "previous scan session for this symbol" to resume, since none exists. One useful consequence, not requiring any special-casing anywhere else in the codebase: a scan-originated `ai_assisted` session is, from that point on, an **entirely ordinary** `ai_assisted` session. If the user later opens it from `HistorySidebar` and sends a follow-up message, P5c§7.3's/P5c§8.5's existing reopen-and-continue logic (`getClaudeSessionId` returns the id this scheduler just set, `resumeSession: true` on the next turn) just works, unmodified.

### P5d§8.6 Test additions (`electron-app/test/main/scanScheduler.test.ts`, new)

Fake `sidecar`/`getKite`/`provider`/`history`/`notify` doubles (no real Kite, sidecar process, or Claude subprocess):

- `tick does nothing when Kite is not logged in` — `getKite` returns `null`; asserts `sidecar.listWatchlist` is never called.
- `tick processes watchlist symbols sequentially, not concurrently` — a fake `sidecar.compute` that tracks an in-flight counter; asserts the counter never exceeds 1.
- `a NoChange decision writes nothing to history and does not notify`.
- `a WorthLook decision creates an engine_only session with a proactive_scan trigger payload, appends both messages, and notifies` — asserts the exact `ScanTriggerPayload` shape and that `response.text`'s first line is the notification body.
- `a WorthAiCall decision creates an ai_assisted session, calls completeAiAssisted with a fresh claudeSessionId and resumeSession: false, and persists the claude_session_id only after success`.
- `a WorthAiCall failure leaves the user message orphaned and never calls setClaudeSessionId` — mirrors P5c§7.3's own analogous test for `runAiAssistedRequest`.
- `a symbol that fails to resolve to an instrument is skipped without aborting the rest of the tick` — `resolveWatchlistInstrument` (or the underlying `kite.searchInstruments`) returns nothing useful for symbol A; symbol B still gets processed.
- `an error thrown while processing one symbol does not stop the next symbol` — a fake `sidecar.compute` throws for symbol A only.
- `setConfig restarts the interval, clearing the previous timer and scheduling a new one at the new period` — asserts against the injected `setIntervalFn`/`clearIntervalFn` fakes' call arguments.
- `an overlapping tick is skipped while one is already in flight` — a slow fake `sidecar.listWatchlist`; call `tick()` twice without awaiting the first; assert `listWatchlist` was only invoked once.

### P5d§8.7 `notify` and construction in `bootstrap.ts`

`Notification` is, like `Tray`, part of Electron's own main-process API — confirmed directly (`electron-app/package.json` has no notification-related dependency today, and none is added by this phase). `bootstrap.ts` wires a small `notify` closure around it, guarded by `Notification.isSupported()` (a real static method Electron exposes, since not every OS/session has notification support available), and routes a click on the notification to the same `showMainWindow` the tray's "Show" item uses:

```typescript
import { Notification } from "electron";

const sendScanNotification = (title: string, body: string): void => {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
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
```

`sendScanNotification`'s body references the `showMainWindow` `const` before that `const`'s own declaration appears further down `createApp()`'s function body — this is safe and requires no special ordering: `sendScanNotification` is only ever *invoked* later, from inside a running `tick()` (long after every top-level `const` in `createApp()` has been assigned), not at the point it's defined, so the closure resolves `showMainWindow` correctly at call time. `bootstrap.ts` already relies on this same forward-reference-inside-a-closure shape today (e.g. `sessionState.on("change", ...)`'s handler closes over `session`, a `let` declared earlier but reassigned later, resolved at event-fire time). The effect: a notification click reliably reaches whichever `BrowserWindow` is current at click time, exactly like `sendToRenderer` (P5d§9.4). Clicking a notification does not deep-link to the specific session it was about (P5d§17) — it only brings the main window to the front; the user finds the new session in `HistorySidebar` themselves, the same as they would for any other new entry.

## P5d§9 Tray (`electron-app/src/main/tray.ts`, new)

### P5d§9.1 Icon asset — resolved concretely

No icon asset of any kind (`.png`/`.icns`/`.ico`) exists anywhere in the repo today (confirmed: `find electron-app -iname "*.png" -o -iname "*.icns" -o -iname "*.ico"`, excluding `node_modules`, returns nothing). This phase adds two small binary assets, checked into the repo:

- `electron-app/resources/icons/trayIconTemplate.png` — 16×16, a simple flat monochrome glyph (black shape on a transparent background — a filled circle or a minimal three-bar "chart" mark; exact artwork is a one-off, trivial creation at implementation time, not a design decision this document needs to adjudicate further).
- `electron-app/resources/icons/trayIconTemplate@2x.png` — the same glyph at 32×32, for Retina displays.

The `...Template` filename suffix is a macOS-specific convention Electron's `nativeImage` recognizes automatically: a template image is treated as a mask and adapts to the current menu-bar light/dark appearance. This suffix is inert (silently ignored) on Windows/Linux, where the tray icon simply renders as-is — so one pair of files serves all three platforms without conditional logic. This is a deliberate v1 placeholder, not a blocker: nothing about the rest of this design depends on the glyph's specific artwork, and swapping it for a more polished icon later is a file-replacement, not a code change.

### P5d§9.2 Tray construction and menu

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

The tray is created once, unconditionally, at app startup (`bootstrap.ts`'s `start()`) — it exists regardless of whether scanning itself is on, so Settings/Quit are always reachable from it. Only the *window-all-closed* behavior (P5d§9.3) is gated on the scanning toggle.

`buildTrayMenuTemplate` is a pure function (no real `Tray`/`Menu` construction) and is what gets unit tested; `createTray` itself, like `mainWindow.ts`'s `createMainWindow`, is exercised only via the manual verification checklist (P5d§13) — real Electron `Tray`/`nativeImage` objects don't exist in the plain-Node vitest environment this project already runs its main-process tests under.

Test file: `electron-app/test/main/tray.test.ts` — `buildTrayMenuTemplate` returns exactly four entries (`"Show"`, `"Settings"`, a separator, `"Quit"`) in that order, and invoking each item's `click` calls the corresponding dependency function exactly once.

### P5d§9.3 Lifecycle: `window-all-closed` / `activate` / `before-quit`

Today's `main.ts` is two handlers: `app.whenReady()` starts the runtime, and `window-all-closed` unconditionally calls `runtime.stop()` then quits on non-macOS. There is no `activate` handler at all — nothing currently recreates a window once all are closed, on any platform. This phase must resolve exactly what "Show" does when there is no open `BrowserWindow` (re-create it), and exactly when the app should stay alive without any window open (only when scanning is on), which forces adding the previously-missing `activate` handler and reworking `window-all-closed` together, not independently.

The decision logic is extracted as a pure, directly-testable function — the same pattern `bootstrap.ts` already uses for `handleKiteResponse` — in a new file, `electron-app/src/main/appLifecycle.ts`:

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

`main.ts` becomes:

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

Case-by-case:

- **Scanning off, any platform, last window closed normally:** `isQuitting` is `false`, `scanningEnabled` is `false` → `shouldQuitOnAllWindowsClosed` returns `platform !== "darwin"` — quits on Windows/Linux, stays alive with zero windows on macOS. This matches today's exact behavior on non-macOS. On macOS it is a deliberate small improvement over today: previously `runtime.stop()` ran unconditionally on `window-all-closed` even when the app wasn't quitting, which (with no `activate` handler at all) left no way to bring a window back short of relaunching the whole app. Now `stop()` only ever runs from `before-quit`, so nothing is torn down merely because the last window closed, and the new `activate` handler can genuinely recreate the window afterward.
- **Scanning on, any platform, last window closed normally:** `scanningEnabled` is `true`, `isQuitting` is `false` → returns `false` — the app stays alive, tray-resident, with the scheduler's timer still running. This is the behavior §8.1 describes ("Electron main stays tray-resident so the scheduler can run on a timer without a chat window needing to be open"), now uniform across macOS/Windows/Linux rather than only macOS's incidental default.
- **Tray "Quit" clicked (any platform, any scanning state):** calls `app.quit()` directly → fires `before-quit` → `isQuitting = true`, `runtime.stop()` runs (stopping the scan scheduler, the sidecar supervisor, and closing the history store, in that order — P5d§9.4) → if any windows remain open, Electron's own quit sequence closes them, which fires `window-all-closed`; `shouldQuitOnAllWindowsClosed` sees `isQuitting: true` and returns `true`, calling `app.quit()` again — idempotent, since a quit is already in progress.
- **Dock icon clicked on macOS with zero windows open (`activate`):** `runtime.showMainWindow()` runs regardless of scanning state — recreates the main window if none exists, or focuses the existing one.

### P5d§9.4 `AppRuntime` and `bootstrap.ts` changes this requires

`AppRuntime` gains two methods:

```typescript
export interface AppRuntime {
  start(): void;
  stop(): void;
  showMainWindow(): void;
  isScanningEnabled(): boolean;
}
```

`bootstrap.ts` tracks the main window (and, separately, the Settings window) as closured, nullable state so they can be recreated:

```typescript
let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;

const createMainWindow = (): BrowserWindow => {
  const window = new BrowserWindow(mainWindowOptions(path.join(__dirname, "..", "preload", "preload.js")));
  mainWindow = window;
  window.on("closed", () => { mainWindow = null; });
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
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); return; }
  createMainWindow();
};

const createSettingsWindow = (): BrowserWindow => {
  const window = new BrowserWindow(settingsWindowOptions(path.join(__dirname, "..", "preload", "settingsPreload.js")));
  settingsWindow = window;
  window.on("closed", () => { settingsWindow = null; });
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) window.loadURL(`${rendererUrl}/settings.html`);
  else window.loadFile(path.join(__dirname, "..", "renderer", "settings.html"));
  return window;
};

const showSettingsWindow = (): void => {
  if (settingsWindow) { settingsWindow.show(); settingsWindow.focus(); return; }
  createSettingsWindow();
};
```

**Necessary companion fix, not purely additive:** today, `registerStatusBridge`/`registerAnalysisBridge`/`registerHistoryBridge` are all called *inside* `createMainWindow()`, capturing that specific window's `webContents.send` in a closure. `createMainWindow()` was previously only ever invoked once (from `start()`), so this was never a problem. Now that `showMainWindow()` can call `createMainWindow()` a second time (after the window was closed and later re-shown), calling `ipcMain.handle(...)` a second time for the same channel name throws ("Attempted to register a second handler..."). This phase moves all `ipcMain.handle` registrations (the three existing ones, plus the new `registerSettingsBridge`, P5d§10.3) to run exactly once, at the top level of `createApp()`, decoupled from window creation — and `sendToRenderer` is redefined to read the *current* `mainWindow` closure variable at call time rather than closing over one fixed window instance:

```typescript
const sendToRenderer = (channel: string, payload: unknown): void => {
  mainWindow?.webContents.send(channel, payload);
};

registerStatusBridge({ ipcMain, getStatus: currentStatus, onBanner: (handler) => bannerHandlers.push(handler), sendToRenderer });
registerAnalysisBridge({
  ipcMain, login, getSession: () => session, sidecar: supervisor, provider, history,
  sendNarrative: makeNarrativeSender(sendToRenderer),
  markNeedsLogin: () => sessionState.markNeedsLogin(),
});
registerHistoryBridge({ ipcMain, history });
registerSettingsBridge({ ipcMain, history, scanScheduler, sidecar: supervisor, getStatus: currentStatus });
```

`AppRuntime.stop()` now stops the scheduler first, before the sidecar/history teardown it depends on:

```typescript
stop: () => {
  scanScheduler.stop();
  void session?.close().catch(() => {});
  history.close();
  supervisor.stop();
},
```

`scanScheduler.stop()` only clears the interval timer, so it prevents any *future* tick from starting; it does not forcibly abort a tick already in flight at the moment of shutdown. If a tick happens to be mid-flight when `stop()` runs, its remaining `history.appendMessage`/`sidecar` calls may throw against an already-closed store — this is caught by `tickOneSymbol`'s own `try`/`catch` (P5d§8.3) and logged, not a crash. This is an accepted, low-probability edge case, not a gap: the existing `SidecarSupervisor.stop()` has the same shape today (it clears pending-request timers and kills the child process without waiting for in-flight requests to settle), so this phase introduces no new class of shutdown risk beyond what already exists.

`AppRuntime.start()` additionally creates the tray:

```typescript
start: () => {
  supervisor.start();
  createMainWindow();
  createTray({ showMainWindow, showSettingsWindow, quit: () => app.quit() });
},
```

`isScanningEnabled: () => scanScheduler.getConfig().enabled`.

### P5d§9.5 Test additions

`electron-app/test/main/appLifecycle.test.ts` (new): `shouldQuitOnAllWindowsClosed` — `isQuitting: true` returns `true` regardless of the other two params; `scanningEnabled: true, isQuitting: false` returns `false` on every platform value; `scanningEnabled: false, isQuitting: false` returns `true` for `"win32"`/`"linux"` and `false` for `"darwin"`.

## P5d§10 Settings window

### P5d§10.1 Security config — identical to `mainWindow.ts`, non-negotiably

New file `electron-app/src/main/settingsWindow.ts`:

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

The `webPreferences` block is byte-for-byte the same three security flags as `mainWindowOptions` — only `width`/`height` differ, appropriate for a small single-purpose panel rather than a chat window. Test file `electron-app/test/main/settingsWindow.test.ts` mirrors `mainWindow.test.ts`'s existing test exactly: asserts `contextIsolation`/`sandbox`/`nodeIntegration` are `true`/`true`/`false` and the preload path is threaded through.

### P5d§10.2 A second preload + renderer entry point

This is the first time the app has more than one `BrowserWindow` class, which means a second preload script and a second renderer HTML page — `electron-vite`'s `preload`/`renderer` build configs both need a second entry:

`electron-app/electron.vite.config.ts` (modified):

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
  // ...existing plugins unchanged...
},
```

This produces `out/preload/settingsPreload.js` and `out/renderer/settings.html` alongside the existing `out/preload/preload.js`/`out/renderer/index.html` — the same sibling-file layout `createSettingsWindow` (P5d§9.4) already assumes.

New `electron-app/src/main/ipc/settingsPreload.ts`, mirroring `preload.ts` exactly, exposing a distinct global:

```typescript
import { contextBridge, ipcRenderer } from "electron";
import { buildSettingsApi } from "./rendererApi";

const api = buildSettingsApi((channel, ...args) => ipcRenderer.invoke(channel, ...args));

contextBridge.exposeInMainWorld("tradeAssistantSettings", api);
```

New `electron-app/src/renderer/settings.html` (identical CSP meta tag to `index.html`) and `electron-app/src/renderer/settingsMain.tsx` (mirroring `main.tsx`, rendering `<SettingsWindow />` instead of `<App />`), and `electron-app/src/renderer/settingsBridge.ts` (mirroring `renderer/bridge.ts`):

```typescript
import type { SettingsApi } from "../main/ipc/rendererApi";

export function settingsBridge(): SettingsApi {
  return (window as unknown as { tradeAssistantSettings: SettingsApi }).tradeAssistantSettings;
}
```

### P5d§10.3 `SettingsWindow.tsx` — UI elements

New `electron-app/src/renderer/SettingsWindow.tsx`. Three sections:

1. **Proactive scanning:** a checkbox (on/off, reflecting `ScanConfig.enabled`) and a `<select>` of the four interval options (`5 | 15 | 30 | 60` minutes, default `15`). Both call `settingsBridge().setScanConfig({...})` immediately on change — there is no separate "Save" button; changes take effect the moment they're made, the same live-effect posture every other Settings-adjacent control in this app already has.
2. **Watchlist:** a search box reusing `parseInstruments` from the sibling `renderer/instrumentParsing.ts` file exactly as `InstrumentSearch.tsx` already does (this is a renderer-to-renderer import, not a boundary crossing — unlike `scanScheduler.ts`'s own separate small duplication, P5d§8.2), calling `settingsBridge().searchInstruments(query)` (which, per P5d§11.1, is wired straight through to the existing `kite:searchInstruments` channel) and rendering results as "Add <symbol>" buttons; each click calls `addWatchlistSymbol(instrument.symbol)` and re-renders the returned list. Each existing watchlist entry has its own "Remove" button calling `removeWatchlistSymbol(symbol)`.
3. **Account status (read-only):** `getAccountStatus()` reuses the exact existing `AppStatus` shape (`sidecar`, `kiteSession`, `driftWarning`) — no new status shape is invented. Claude's own auth status has no live-checked signal anywhere in this codebase today (`App.tsx`'s existing "AI-Assisted needs the claude CLI authenticated — run `claude auth login`" line is static hint text, not a polled status field) — Settings reuses that exact same static hint text rather than fabricating a new `claudeAuthenticated` field nothing else in the app tracks.

### P5d§10.4 Test additions

`electron-app/test/renderer/SettingsWindow.test.tsx` (new), using a fake `SettingsApi` double (mirroring `testBridge.ts`'s stubbing style): toggling the scan checkbox calls `setScanConfig` with the flipped `enabled`; changing the interval `<select>` calls `setScanConfig` with the new `intervalMinutes`; typing a query calls `searchInstruments` and renders results; clicking "Add" calls `addWatchlistSymbol` and the watchlist list re-renders from the returned array; clicking "Remove" calls `removeWatchlistSymbol`; the status section renders `AppStatus.sidecar`/`kiteSession` values from a fake `getAccountStatus` response.

## P5d§11 IPC contract

### P5d§11.1 `settingsBridge.ts` (new, `electron-app/src/main/ipc/settingsBridge.ts`)

Mirrors `historyBridge.ts`'s exact DI/registration pattern:

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

`settings:setScanConfig` both persists the new config (`history.setScanConfig`) and immediately applies it to the live scheduler (`scanScheduler.setConfig`, which restarts its timer per P5d§8.3) — a single round trip covers both.

**`searchInstruments` is deliberately not registered here.** The Settings renderer's `searchInstruments` (used for the watchlist add flow, P5d§10.3) invokes the exact same `"kite:searchInstruments"` channel `registerAnalysisBridge` already registers today — `ipcMain.handle` registrations are process-global, not scoped to the window/preload that happens to call them, so no second registration is needed or created. This is the concrete meaning of "reusing the existing `searchInstruments` bridge call for the add flow": literally the same channel, not a settings-scoped duplicate.

### P5d§11.2 `rendererApi.ts` additions

The main chat window's `RendererApi`/`buildRendererApi` are **unchanged** by this phase. A second, separate API is added to the same file, since `rendererApi.ts` is this app's one shared IPC contract file — both windows' bridges live in it:

```typescript
export type { ScanConfig, ScanIntervalMinutes } from "../services/history/historyStore";
import type { ScanConfig } from "../services/history/historyStore";

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

`buildSettingsApi` takes only an `invoke` function, not `subscribe` — the Settings window has no push-channel event to receive (no equivalent of `banner:push`/`analysis:narrative`), so its preload wiring is simpler than the main window's.

### P5d§11.3 Test additions

`electron-app/test/main/ipc/settingsBridge.test.ts` (new), mirroring `historyBridge.test.ts`'s `Map`-of-channel-to-handler style with fake `Pick<...>` doubles: each channel forwards to the right dependency method; `settings:setScanConfig` calls both `history.setScanConfig` and `scanScheduler.setConfig` (in that order) and returns the freshly-read config; `settings:listWatchlist`/`addWatchlistSymbol`/`removeWatchlistSymbol` correctly unwrap `.symbols` from the sidecar's `WatchlistResponseWire`.

## P5d§12 `ScanConfig` persistence

**Decision: a new tiny table in `HistoryStore`'s existing SQLite database** (`history.sqlite3`, `electron-app/src/main/services/history/historyStore.ts`), not a new file. Justification: `HistoryStore` is already the one Electron-main-owned, already-wired, already-tested local SQLite store (P5c§3); `ScanConfig` is two scalar fields that need exactly the same properties `HistoryStore` already provides (survives app restart, single local file, no concurrent-writer concerns for a single-user app) — adding a third persistence file (with its own native-module open/rebuild lifecycle, on top of the Rust sidecar's `state.sqlite3` and the existing `history.sqlite3`) for two booleans/an enum would be needless proliferation. `state.sqlite3` (P5d§3) is not used for this instead, because `ScanConfig` is Electron-side app/UI preference state, not deterministic-engine-adjacent computation state — matching §3's existing ownership table split ("Chat/session history persistence" vs. "Candle/indicator storage," each with a different owner).

Schema addition to `historyStore.ts`'s constructor DDL (idempotent, run every open, per P5c§3.4's established convention):

```sql
CREATE TABLE IF NOT EXISTS scan_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  interval_minutes INTEGER NOT NULL DEFAULT 15
);
```

The `CHECK (id = 1)` constraint enforces a single-row settings-singleton table — a standard SQLite idiom. Seeded once, idempotently, right after the `CREATE TABLE`:

```sql
INSERT OR IGNORE INTO scan_config (id, enabled, interval_minutes) VALUES (1, 0, 15);
```

New types and methods:

```typescript
export type ScanIntervalMinutes = 5 | 15 | 30 | 60;

export interface ScanConfig {
  enabled: boolean;
  intervalMinutes: ScanIntervalMinutes;
}

export const DEFAULT_SCAN_CONFIG: ScanConfig = { enabled: false, intervalMinutes: 15 };
```

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

`enabled: false, intervalMinutes: 15` matches §8.4's explicit "default off" requirement and the brainstorm's explicit "configurable in Settings... 5/15/30/60 min, default 15."

Test additions to `historyStore.test.ts`: `getScanConfig` on a fresh database returns `{ enabled: false, intervalMinutes: 15 }` (the seeded default row); `setScanConfig` round-trips through `getScanConfig`; opening the store twice against the same file does not reset or duplicate the singleton row (`INSERT OR IGNORE` idempotence, the same property already tested for the `sessions`/`messages` DDL).

`ScanScheduler` is constructed in `bootstrap.ts` with `history.getScanConfig()` as its `initialConfig` — so a scanning-enabled state left on from a previous run resumes automatically on the next app launch, which is the entire point of persisting it.

## P5d§13 Testing strategy summary

**Rust:**
- `scan_gate_test.rs` (new) — pure-function unit tests, no I/O, per P5d§4.3.
- `state_store_test.rs` extensions — `remove_watchlist_symbol` and `scan_snapshots` accessor round trips, per P5d§3.5.
- `protocol_test.rs` extensions — parse/encode coverage for the four new request/two new response wire shapes, per P5d§5.2.
- `handlers.rs` inline test additions — the four new handler functions, per P5d§5.3.
- `end_to_end_test.rs` extensions — a real compiled-binary stdin/stdout round trip through `add_watchlist_symbol` → `list_watchlist` → `compute` → `evaluate_scan_gate`, plus a panic-isolation regression test for the new variants, per P5d§6.

**TypeScript:**
- `sidecarProtocol.test.ts` / `sidecarSupervisor.test.ts` extensions — wire encode/decode and the four new `SidecarSupervisor` methods' resolve/timeout behavior, per P5d§7.3.
- `watchlistInstrumentResolver.test.ts` (new) — pure parsing plus the exact-match resolution rule, per P5d§8.2.
- `scanScheduler.test.ts` (new) — scheduler tick tests against fake sidecar/kite/provider/history/notify doubles and an injected fake clock/timer, per P5d§8.6: no real timers, no real Kite/Claude/sidecar process — `tick()` is called directly, and `setIntervalFn`/`clearIntervalFn` injection makes the interval-scheduling behavior itself assertable without waiting real minutes.
- `tray.test.ts` (new) — the pure `buildTrayMenuTemplate`, per P5d§9.2.
- `appLifecycle.test.ts` (new) — the pure `shouldQuitOnAllWindowsClosed`, per P5d§9.5.
- `settingsWindow.test.ts` (new) — the pure `settingsWindowOptions`, per P5d§10.1.
- `settingsBridge.test.ts` (new) — IPC bridge tests, per P5d§11.3, mirroring `historyBridge.test.ts`'s established pattern (a fake `Pick<...>` double per channel, asserting correct forwarding).
- `historyStore.test.ts` extensions — `scan_config` seeding/round-trip, per P5d§12.
- `SettingsWindow.test.tsx` (new) — renderer component behavior against a fake `SettingsApi`, per P5d§10.4.

## P5d§14 Manual verification checklist

Mirrors P5a§11/P5b§11/P5c§10: an automatable golden path, never a blocker for calling 5d done.

**Automatable (mocked bridge + `npm start`):** Settings opens from the tray's "Settings" item, showing the scan toggle (off), interval picker (15), an empty watchlist, and the Kite/sidecar status fields; searching and adding an instrument updates the watchlist list; removing it empties the list again; toggling scanning on, then closing the main window, leaves the process alive (the tray icon remains, `npm start`'s process does not exit); the tray's "Show" item re-opens the main window; the tray's "Quit" item exits the process cleanly.

**Live follow-ups (real Kite login + real `claude` auth, a short interval like 5 minutes for observation):** with one real symbol on the watchlist and scanning enabled, confirm over a few ticks that a `NoChange` tick produces no new entry in History and no notification; that a tick producing a real confluence shift creates a new Engine-Only session in History (visible in `HistorySidebar`, `trigger: "proactive_scan"` in its stored payload) and fires a desktop notification; that, given enough observation time for a larger swing (or by temporarily lowering `GateThresholds` for the test), a tick produces a full AI-Assisted session — persona pipeline, narrative, its own notification — and that reopening that session afterward and sending a follow-up message behaves as an ordinary AI-Assisted chat (confirming P5d§8.5's "no special-casing needed on reopen" property directly, not just by code inspection).

## P5d§15 Relationship to existing design (flagged tensions & resolutions)

1. **`bootstrap.ts`'s IPC-registration timing changes, not just extends.** Today, `registerStatusBridge`/`registerAnalysisBridge`/`registerHistoryBridge` are called inside `createMainWindow()`, which was previously only ever invoked once. This phase's tray "Show"/`activate` support means the main window can be recreated, and calling `ipcMain.handle` twice for the same channel throws — so this phase must move all bridge registrations to run exactly once, at `createApp()`'s top level, and make `sendToRenderer` read the current window dynamically rather than close over a fixed one (P5d§9.4). This is a real, necessary restructuring of already-shipped Phase 5a–5c code, not purely additive — called out explicitly rather than left as an implicit side effect a future reader might not expect.
2. **`window-all-closed`'s macOS behavior genuinely changes, even with scanning off.** Today, `runtime.stop()` runs unconditionally whenever all windows close, on every platform, including macOS (where the app doesn't quit but everything is torn down anyway, with no `activate` handler to recover). This phase makes `stop()` run only on a genuine quit (P5d§9.3) — a deliberate, small, justified fix bundled into this phase because the new tray/`activate` support forces the question to be answered precisely; it was not separately requested as a bug fix, but leaving the old behavior in place would make the new "stay resident" feature inconsistent with what happens when scanning is off.
3. **`storage` gains its first `serde`/`serde_json` dependency, but not a dependency on `algo-core`.** `ConfluenceSnapshot` deliberately mirrors `ScorecardSummary`'s four fields rather than importing the type, keeping `storage` exactly as decoupled from `algo-core` as it is today (P5d§3.3) — consistent with this codebase's existing precedent of mirroring small shapes across a boundary (`ConfluenceWire` already does this to `ScorecardSummary` in the sidecar crate) rather than collapsing the boundary.
4. **This is the first time the app has more than one `BrowserWindow` class**, requiring a second preload/renderer entry point in `electron.vite.config.ts` (P5d§10.2) — a real, if standard, build-config change, not something any prior phase needed.
5. **Per-watchlist-entry `horizon`/`intent_lens` was considered and explicitly rejected** in favor of fixed scheduler-wide constants (P5d§8.1), to keep the Rust watchlist a genuinely thin membership-only wrapper (matching this phase's own framing of the new sidecar requests as "thin wrappers over `StateStore`") rather than growing its schema for a feature no other part of this phase's scope needs yet.
6. **`AnalysisEnvelope.trigger: "proactive_scan"` is populated for the first time.** The field has existed, unused, since Phase 4's `contracts.ts` (mirroring how P5c§11 flagged the similar situation for `AnalysisEnvelope.session_id`, which remains unpopulated) — this phase is what finally exercises it.
7. **`Notification`/`Tray` are genuinely new Electron surfaces for this app**, confirmed built into Electron itself (no new npm dependency — `electron-app/package.json` needed no changes for either) rather than assumed.

## P5d§16 File layout summary

**New — Rust:**
- `rust-core/crates/algo-core/src/scan_gate.rs` — `GateDecision`, `GateThresholds`, `evaluate_scan_gate` (P5d§4).
- `rust-core/crates/algo-core/tests/scan_gate_test.rs` (P5d§4.3).

**Modified — Rust:**
- `rust-core/crates/storage/src/state_store.rs` — `remove_watchlist_symbol`, `scan_snapshots` table, `ConfluenceSnapshot`, `get_last_snapshot`/`set_last_snapshot` (P5d§3).
- `rust-core/crates/storage/src/error.rs` — `StorageError::Json` variant (P5d§3.3).
- `rust-core/crates/storage/src/lib.rs` — re-export `ConfluenceSnapshot`.
- `rust-core/crates/storage/Cargo.toml` — add `serde`/`serde_json` (P5d§3.3).
- `rust-core/crates/storage/tests/state_store_test.rs` (P5d§3.5).
- `rust-core/crates/algo-core/src/lib.rs` — `pub mod scan_gate;` (P5d§4.2).
- `rust-core/crates/sidecar/src/protocol.rs` — new request/response variants, `ConfluenceWire` gains `Deserialize` (P5d§5.1).
- `rust-core/crates/sidecar/src/handlers.rs` — four new handlers + conversion helpers (P5d§5.3).
- `rust-core/crates/sidecar/src/main.rs` — open `StateStore`, route the four new variants with `catch_unwind` (P5d§6).
- `rust-core/crates/sidecar/tests/protocol_test.rs`, `rust-core/crates/sidecar/tests/end_to_end_test.rs` (P5d§5.2, P5d§6).

**New — TypeScript:**
- `electron-app/src/main/scanScheduler.ts` (P5d§8).
- `electron-app/src/main/services/kite/watchlistInstrumentResolver.ts` (P5d§8.2).
- `electron-app/src/main/tray.ts` (P5d§9).
- `electron-app/src/main/appLifecycle.ts` — `shouldQuitOnAllWindowsClosed` (P5d§9.3).
- `electron-app/src/main/settingsWindow.ts` (P5d§10.1).
- `electron-app/src/main/ipc/settingsBridge.ts` (P5d§11.1).
- `electron-app/src/main/ipc/settingsPreload.ts` (P5d§10.2).
- `electron-app/src/renderer/SettingsWindow.tsx` (P5d§10.3).
- `electron-app/src/renderer/settingsMain.tsx`, `electron-app/src/renderer/settings.html`, `electron-app/src/renderer/settingsBridge.ts` (P5d§10.2).
- `electron-app/resources/icons/trayIconTemplate.png`, `electron-app/resources/icons/trayIconTemplate@2x.png` (P5d§9.1).
- `electron-app/test/main/scanScheduler.test.ts`, `electron-app/test/main/services/kite/watchlistInstrumentResolver.test.ts`, `electron-app/test/main/tray.test.ts`, `electron-app/test/main/appLifecycle.test.ts`, `electron-app/test/main/settingsWindow.test.ts`, `electron-app/test/main/ipc/settingsBridge.test.ts`, `electron-app/test/renderer/SettingsWindow.test.tsx` (P5d§13).

**Modified — TypeScript:**
- `electron-app/src/main/services/sidecar/sidecarProtocol.ts` — `WatchlistResponseWire`, `ScanGateResponseWire` and the four new request variants (P5d§7.1).
- `electron-app/src/main/services/sidecar/sidecarSupervisor.ts` — `addWatchlistSymbol`/`removeWatchlistSymbol`/`listWatchlist`/`evaluateScanGate` (P5d§7.2).
- `electron-app/src/main/services/history/historyStore.ts` — `ScanConfig`/`ScanIntervalMinutes`/`DEFAULT_SCAN_CONFIG`, `scan_config` table, `getScanConfig`/`setScanConfig` (P5d§12).
- `electron-app/src/main/ipc/rendererApi.ts` — `SettingsApi`/`buildSettingsApi`, `ScanConfig` re-export (P5d§11.2).
- `electron-app/src/main/main.ts` — `before-quit`/`window-all-closed`/`activate` lifecycle (P5d§9.3).
- `electron-app/src/main/bootstrap.ts` — `ScanScheduler`/tray construction, main-window/settings-window singleton tracking, `showMainWindow`/`showSettingsWindow`/`isScanningEnabled`, IPC-registration timing fix (P5d§9.4).
- `electron-app/electron.vite.config.ts` — second `preload`/`renderer` entry points (P5d§10.2).
- `electron-app/test/main/bootstrap.test.ts`, `electron-app/test/main/mainWindow.test.ts`, `electron-app/test/main/services/history/historyStore.test.ts`, `electron-app/test/main/services/sidecar/sidecarProtocol.test.ts`, `electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts` — extended per P5d§13.

**Explicitly considered, not changed:**
- `electron-app/package.json` — `Tray`/`Notification` are built into Electron itself; no new npm dependency (confirmed directly, P5d§15 item 7).
- `electron-app/src/main/ipc/preload.ts` — unchanged; the Settings window gets its own separate preload rather than this one growing a second exposed global.
- `electron-app/src/main/ipc/analysisBridge.ts`, `electron-app/src/main/ipc/historyBridge.ts` — unaffected; the scan scheduler calls the underlying services (`assembleEnvelope`, `HistoryStore`, `ClaudeCliProvider`) directly, not through these IPC bridges (there is no renderer on the other end of a scan tick).
- `electron-app/src/renderer/App.tsx`, `ChatView.tsx`, `AnalysisResult.tsx`, `HomeScreen.tsx`, `HistorySidebar.tsx` — unaffected; a scan-originated session renders through their existing, unmodified logic exactly like any other session (P5d§8.4).
- `electron-app/src/renderer/instrumentParsing.ts` — unchanged; both `SettingsWindow.tsx` (same-process renderer import) and `watchlistInstrumentResolver.ts` (a deliberate separate main-process copy, P5d§8.2) use it/its logic without modifying it.

## P5d§17 Out of scope for this phase

- **Any change to the hard no-order-placement safety invariant (§2, §4).** Unaffected, as every phase in this project restates: no method, no allowed Kite tool, and no code path added here can place, modify, or cancel an order or a GTT. The scan scheduler only ever calls the same read-only `KiteClient` methods every other analysis path already uses.
- **Any change to the mandatory per-session AI-Assisted/Engine-Only prompt (§9).** Settings still never pre-answers or caches a default for that choice — it remains asked fresh every session, exactly as §8.4 requires.
- **Phase 6 (Benchmark UI) and Phase 7 (packaging/CI/platform).** Not scoped, not touched, not anticipated beyond leaving their interfaces alone.
- **Any multi-instrument/portfolio-level aggregation beyond a flat watchlist symbol list.** No grouping, weighting, or correlation across watchlist symbols — the scheduler treats each symbol entirely independently, one tick loop iteration at a time.
- **Any scan-interval enforcement beyond a simple in-process timer.** No OS-level cron/launchd/Windows Task Scheduler integration — matching §8.1's own framing exactly, the app must be running (tray-resident, if all windows are closed) for scans to fire at all; there is no "scan while fully quit" capability, and none is planned.
- **Per-watchlist-entry horizon/intent-lens configuration.** Resolved as fixed scheduler-wide constants instead (P5d§8.1) — extending the schema to carry per-entry configuration is a clean future extension, not built here.
- **Tunable gate thresholds in the UI.** `GateThresholds::default()`'s two numbers (P5d§4.1) are fixed in Rust source for v1; no Settings control reads or writes them.
- **Session renaming, deletion, or export UI, and the `auto` horizon.** Both remain exactly as deferred as P5c left them (P5c§13) — nothing in this phase revisits either.
- **A polished tray/app icon.** P5d§9.1's placeholder PNG pair is the complete v1 resolution; a better icon later is a file swap, not a design change.
- **Deep-linking a notification click to the specific session it was about.** Clicking a scan notification only brings the main window to the front (P5d§8.7); routing straight into that session's transcript would need session-aware window-focus plumbing this phase doesn't build — the user finds the new entry in `HistorySidebar` themselves.
