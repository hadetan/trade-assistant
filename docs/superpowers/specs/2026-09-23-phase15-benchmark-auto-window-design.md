# Phase 15 — Automatic Benchmark Window Selection

Status: approved by user 2026-09-23. Pending implementation planning.

Author: design produced via superpowers:brainstorming, triggered by a live incident: a
non-technical user picked `NSE:20MICRONS` and an algorithm needing 517 days in the Benchmark tab,
left the UI's own default date in place, and got `20MICRONS has 286 of the 517 days this run
needs around the selected day. Try an earlier date, or a symbol with more history.` The message
is accurate — P14 (`docs/superpowers/specs/2026-09-18-phase14-benchmark-bhavcopy-backfill-design.md`)
built exactly this refusal on purpose, to replace a worse bug where an insufficient run silently
produced garbage. But the user has no way to know what "days around the selected day" means or
which direction "earlier" should go, and can't be expected to. Section references: "P14§N" → the
document above; "P15§N" → this document.

## P15§1 Root cause

`BenchmarkView.tsx:178`, `onSelectEntry`, defaults the test date to the symbol's **earliest known
bar** the moment a symbol is picked, before an algorithm is even chosen and without ever
recomputing when the algorithm changes. For any algorithm with a real lookback requirement, the
earliest bar is close to the worst possible day to test — it has almost no history *before* it.
This is a UI defaulting choice, not a property of the data, and it silently sets every user up to
hit P14's (correct) refusal on the very first try, needing knowledge of `lookback`/`lookahead`
semantics to recover from it manually.

The date field and a "lookahead bars" number field are both manually editable
(`BenchmarkView.tsx:300,316`), which compounds the problem: two numeric controls whose valid
combination depends on internal details (`day_backfill.rs`'s leading/trailing split) that were
never meant to be user-facing.

## P15§2 Scope

**In scope:**

1. The backend resolves the test day itself, using only trading-day rows it already has —
   requiring zero new calendar/holiday logic (P15§3).
2. The date field and the lookahead-bars field are removed from the Benchmark screen entirely.
   Picking a symbol and an algorithm is enough to run (P15§4).
3. The two `insufficientHistory` banners are replaced with one plain sentence per reason, with no
   numbers a non-technical user would need to interpret (P15§4).
4. A symbol proven insufficient for the selected algorithm is greyed out in the picker for the
   rest of the session, so the same failure can't be hit twice in one sitting (P15§4).
5. The resolved test day is surfaced in the results view for transparency, even though nothing
   requires picking or understanding it beforehand.

**Not in scope (explicit decisions):**

- **Proactively checking every symbol in the list up front**, so the picker shows accurate
  grey-outs before any attempt. Rejected: whether a symbol/algorithm pair works can depend on
  fetching more archive history, which this app already treats as lazy and on-demand
  (P14§2's "backfill stays lazy" decision) — running that for every visible symbol just to grey
  out a list would violate that same principle for a cosmetic gain. Greying out happens lazily,
  after the first real attempt against a given pair.
- **Persisting the greyed-out set across app restarts.** Session-only, in-memory. It exists to stop
  repeating an already-known-bad attempt in one sitting, not to be a durable record of every
  symbol's history depth (which changes over time anyway as more bhavcopy data is backfilled).
- **Any change to the backfill/fetch behavior itself** (politeness delay, absent-day heuristic,
  archive-exhausted detection) — all of P14§2–§6 stays exactly as built. This phase only changes
  *which day gets tested* and *what the user sees*, not how history gets fetched or verified.

**Locked decisions:**

1. **The backend picks the day, not the screen.** Rejected alternative: computing the candidate
   day in the renderer/TypeScript layer. That would mean re-implementing NSE
   weekend/holiday-aware trading-day math outside the Rust `ingestion` crate that already owns
   it — duplicate logic the codebase has already been burned by three times in this exact
   subsystem (`BenchmarkView.tsx:29-33`'s boundary-encoding comment references "round 3" of that
   bug class). One implementation, in the crate that already has it.
2. **Candidate selection uses row-counting on already-known candles, not new calendar-walking
   code.** See P15§3 — this reuses `day_backfill.rs`'s existing tested leading/trailing logic
   unchanged and adds no new date arithmetic.
3. **Lookahead becomes fully automatic**, same as the date. `defaultLookaheadForHorizon` already
   exists and is pure (`benchmarkRunner.ts:71-73`) — it simply stops being overridable from the
   screen.
4. **Only a "symbol_history" refusal greys out a pair; "archive_unreachable" does not.** The first
   is a fact about the symbol that won't change on retry. The second is a network condition that
   might succeed a minute later — permanently disabling the symbol for a transient failure would
   be worse than today's behavior, not better.
5. **The wire message is renamed to match its broadened job.** `EnsureDayBackfillRequest` /
   `DayBackfillResponse` become `ResolveBenchmarkWindowRequest` / `ResolveBenchmarkWindowResponse`
   (P15§3) — the caller no longer supplies `from_ts` at all, so the old name ("ensure backfill for
   a day you give me") no longer describes what it does. This is an internal IPC contract between
   Electron and the sidecar with no external consumers or stored history to stay compatible with,
   so it is changed cleanly rather than kept alongside a legacy path.
6. **`day_backfill.rs` is renamed `benchmark_window.rs`** to keep matching its actual
   responsibility (per this codebase's file-naming convention) now that it resolves a window, not
   just backfills a given one.

## P15§3 Backend: resolving the candidate day

The existing `handle_ensure_day_backfill` body (leading/trailing split, backfill walk, absent-day
and archive-exhausted handling — `day_backfill.rs:47-223`) is unchanged. One step is added in
front of it: picking `from_ts` internally instead of reading it from the request.

```rust
// benchmark_window.rs (renamed from day_backfill.rs)
pub struct ResolveBenchmarkWindowRequest {
    pub id: u64,
    pub symbol: String,
    pub algo_id: String,
    pub lookahead: usize,
}

pub struct ResolveBenchmarkWindowResponse {
    pub id: u64,
    pub from_ts: i64,       // new: the day actually resolved and tested
    pub have: usize,
    pub need: usize,
    pub sufficient: bool,
    pub archive_exhausted: bool,
    pub error: Option<String>,
}
```

Candidate selection, using only rows already in `existing` (no fetch, no calendar walking):

- **Empty lake:** candidate day = `today` (matches today's existing fallback start point).
- **`existing.len() > lookahead`:** sort by `ts` descending; the candidate day is the date of the
  candle at index `lookahead` (the `(lookahead + 1)`-th newest). By construction, exactly
  `lookahead` candles already sit at-or-after that day's end — the trailing side is satisfied
  using only data already on disk, no fetch ever required for it.
- **`existing.len() <= lookahead`:** trailing can never reach `lookahead` no matter which day is
  picked (there aren't enough rows in the whole lake). Candidate day = the earliest existing
  candle's date, which drives straight into the already-tested `trailing < lookahead` branch
  (`day_backfill.rs:119-132`) and returns `sufficient: false` immediately, with zero fetches
  attempted — a real "this can't work" answer, not a slow one.

Once the candidate day is picked, everything downstream — leading-side backfill walk, absent-day
limit, archive-exhausted detection, the final authoritative recount — runs exactly as it does
today, unmodified.

## P15§4 Frontend: screen and copy changes

- `BenchmarkView.tsx`: remove the date `TextField` (`:316`) and the lookahead `TextField`
  (`:300`) from the setup form. `onSelectEntry` (`:175-180`) no longer sets a date. `onRun`
  (`:182-210`) sends `{ symbol, timeframe, source, horizon, algoId }` only — `runBenchmark` (main
  process) derives lookahead via `defaultLookaheadForHorizon(horizon)` and asks the sidecar to
  resolve the window; it no longer accepts `fromTs`/`lookaheadBars` from the caller at all.
- Progress: unchanged. The existing "Backfilling history — N/M days" progress display
  (`progressLabel`, `:36-41`) already covers the wait while the backend resolves and fills in
  leading context.
- `InsufficientHistory` (`:43-77`) is replaced with two plain sentences, no numbers:
  - `archive_unreachable`: *"Couldn't reach far enough back for {symbol} right now. Try again in
    a bit."*
  - `symbol_history` (default/permanent case): *"{symbol} doesn't have enough trading history for
    this test. Try a different stock."*
- Results view: add one small caption near the summary/chart showing the resolved test day (e.g.
  "Tested Aug 3, 2023"), sourced from the response's new `from_ts`, purely informational.
- Symbol picker: maintain an in-memory `Set<string>` keyed by `` `${symbol}:${algoId}` `` of pairs
  that returned `symbol_history`. Entries in that set, for the currently selected algorithm, render
  disabled in the symbol list with a short inline note (e.g. "not enough history for this test").
  Cleared on app restart; never persisted.

## P15§5 Testing

**Rust (`benchmark_window.rs`, extending the existing test module):**
- A lake with more real rows than `lookahead` resolves a candidate day that reproduces today's
  "already sufficient, zero fetches" case exactly (same assertions as
  `an_already_deep_enough_lake_answers_immediately_with_zero_fetches`, driven through the new
  entry point instead of a caller-supplied `from_ts`).
- A lake with `<= lookahead` total rows refuses immediately with `sufficient: false` and zero
  fetch attempts.
- A lake needing leading-side backfill still triggers the existing backward walk and produces the
  same `have`/`need`/`archive_exhausted` semantics as today, with the additional assertion that
  the response's `from_ts` matches the day actually picked.

**TypeScript (`BenchmarkView.test.tsx`, `benchmarkRunner.test.ts`):**
- No date or lookahead input exists on the rendered form; Run is enabled once a symbol and an
  algorithm are both selected.
- A `symbol_history` result renders the plain-sentence copy and disables that symbol in the list
  for the current algorithm; switching algorithms re-enables it (the greyed set is keyed per
  algorithm).
- An `archive_unreachable` result renders its own plain sentence and does **not** disable the
  symbol.
- A successful result shows the resolved `from_ts` as a formatted date near the results.
