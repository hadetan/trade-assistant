# Phase 11 — Lake Symbol Listing Performance Fix

Status: approved by user 2026-09-13 (conversational diagnosis + brainstorming), pending implementation planning.
Author: design produced via superpowers:brainstorming, triggered by a live incident: opening the Benchmark screen (Phase 6, P6§4) timed out and pegged CPU. Section references: "P6§N" → `docs/superpowers/specs/2026-07-27-phase6-benchmark-ui-design.md`; "P11§N" → this document.

## P11§1 Purpose

P6§4.1 stated: "the per-partition time bounds and row count *are* derivable (a cheap DuckDB aggregate over the partition)." That assumption was true at the small partition counts the phase was designed and tested against, but it does not hold at real lake scale. Measured directly against the sidecar binary and a real ~2,455-symbol lake (via `list_lake_symbols`, no UI involved): **138.78s wall-clock, 399.07 CPU-seconds**, entirely inside `CandleStore::list_symbols`. Every partition costs a fresh `duckdb::Connection::open_in_memory()` plus a `read_parquet` aggregate query just to answer "what are this partition's bounds" — an operation whose answer was already known, for free, the moment the partition was written.

This is what caused the reported symptom: the Benchmark screen's `listLakeSymbols` IPC call (fired on mount, before any algorithm ever runs) blew past its 30s sidecar-request timeout, and the burst of DuckDB engine spin-ups drove sustained multi-core CPU load ("machine going kaboom") for a request that does no benchmark compute at all.

This document fixes `list_symbols` only. It does not touch ingest-time write cost or the benchmark compute path — those are separate concerns (ingest is an already-tolerated one-time background cost; benchmark run cost is Phase 12's scope).

## P11§2 Scope

**In scope:**

1. `rust-core/crates/storage/src/lake_manifest.rs`: extend `LakePartitionKey` with `from_ts: i64`, `to_ts: i64`, `candle_count: usize`, computed and appended on **every** `write_sourced_candles` call (not just first-write), and change `read_partition_keys` to fold duplicate `(symbol, timeframe, source)` entries **last-line-wins** instead of first-seen (P11§3).
2. `rust-core/crates/storage/src/candle_store.rs`: `write_sourced_candles` derives `from_ts`/`to_ts`/`candle_count` from the already-in-memory sorted `ordered: Vec<Candle>` (no new I/O) and passes them to `append_partition_key`. `list_symbols` reads bounds directly off the manifest entry — `partition_bounds` and its DuckDB query are deleted entirely (P11§4).
3. One-time local migration: the existing on-disk `lake_manifest.jsonl` (written by the pre-fix code, key-only, no bounds) does not match the new schema. Rather than add fallback/compat parsing for old-format lines, the user deletes the local dev lake and re-runs `ingest` once, since it is public data cheaply re-fetched at this data volume (P11§9).

**Not in scope:**

- Ingest-time write cost (`write_partition`'s own per-file DuckDB connection) — unchanged, remains a background one-time cost per ingest run.
- Any change to `read_partition`/`write_partition`'s DuckDB usage for actual candle data — only the *bounds-only* metadata query is eliminated.
- Benchmark run/compute cost, algorithm selection, progress streaming, or cancellation — Phase 12.
- Any sidecar wire-protocol or TypeScript change — `LakeSymbolEntry`'s shape (`symbol`/`timeframe`/`source`/`from_ts`/`to_ts`/`candle_count`) is unchanged; only how `list_symbols` computes it changes. `LakeSymbolWire`, `benchmarkBridge.ts`, and `BenchmarkView.tsx` require zero edits.

**Locked decisions:**

1. Bounds are computed once, in Rust, from data already in memory at write time — never re-derived from parquet at read/list time.
2. The manifest stays append-only (crash-safe, no in-place file rewrite); staleness is resolved by last-line-wins on read, not by rewriting history.
3. No backward-compat parsing for the old (bounds-less) manifest schema — the local lake is dev-only public data, cheaply regenerated; a migration shim would add permanent complexity for a one-time, single-machine transition.

## P11§3 Manifest schema change (`lake_manifest.rs`)

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LakePartitionKey {
    pub symbol: String,
    pub timeframe: String,
    pub source: String,
    pub from_ts: i64,
    pub to_ts: i64,
    pub candle_count: usize,
}
```

`append_partition_key` is unchanged in shape (still one `writeln!` of one JSON line) — it's simply called on every write now, carrying current bounds, not gated behind `is_new_partition`.

`read_partition_keys` changes its dedup rule: fold into an ordered map keyed on `(symbol, timeframe, source)`, where each subsequent line for the same key **overwrites** the previous (last-line-wins), then return the deduped values in insertion order of first appearance. This makes a partition's bounds reflect its most recent write, while the manifest file itself never needs in-place rewriting — appending one line per write keeps the write path's cost unchanged (one cheap append, as today). Growth of the manifest file across many ingest runs (thousands of appended lines) is bounded and cheap to fold: parsing ~10-20k short JSON lines is milliseconds, versus the 138s DuckDB-per-file cost being replaced.

## P11§4 `candle_store.rs` changes

`write_sourced_candles`: after computing `ordered: Vec<Candle>` (already sorted by `ts` via the existing `BTreeMap` merge), derive:

```rust
let from_ts = ordered.first().map(|c| c.ts).unwrap_or(0);
let to_ts = ordered.last().map(|c| c.ts).unwrap_or(0);
let candle_count = ordered.len();
```

and pass these into `LakePartitionKey` on every call (drop the `is_new_partition` conditional — always append; last-line-wins handles correctness).

`partition_bounds` (candle_store.rs:163-171) is deleted. `list_symbols` becomes:

```rust
pub fn list_symbols(&self) -> Result<Vec<LakeSymbolEntry>> {
    let keys = lake_manifest::read_partition_keys(&self.root)?;
    let mut entries: Vec<LakeSymbolEntry> = keys
        .into_iter()
        .filter(|key| self.sourced_partition_path(&key.symbol, &key.timeframe, &key.source).exists())
        .map(|key| LakeSymbolEntry {
            symbol: key.symbol,
            timeframe: key.timeframe,
            source: key.source,
            from_ts: key.from_ts,
            to_ts: key.to_ts,
            candle_count: key.candle_count,
        })
        .collect();
    entries.sort_by(|a, b| (&a.symbol, &a.timeframe, &a.source).cmp(&(&b.symbol, &b.timeframe, &b.source)));
    Ok(entries)
}
```

No DuckDB connection, no parquet read, anywhere in this function. The `path.exists()` defensive check (a manifested key whose file was deleted out-of-band) is preserved.

## P11§5 Testing

- Existing unit test `handle_list_lake_symbols_returns_one_entry_per_written_partition` (handlers.rs:549) continues to pass unchanged — behavior (one entry per written partition) is preserved, only the mechanism changes.
- New unit test in `lake_manifest.rs`: writing the same key twice with different bounds, `read_partition_keys` returns exactly one entry reflecting the second (last) write's bounds.
- New unit test in `candle_store.rs`: `write_sourced_candles` called twice for the same symbol with disjoint date ranges (mirrors real day-by-day ingest) — `list_symbols` reflects the merged, cumulative `from_ts`/`to_ts`/`candle_count` after both writes, not just the first.
- No network- or DuckDB-timing-dependent test is added; the fix is verified by behavior (correct bounds), not by asserting a wall-clock threshold.

## P11§6 Risk

Single-writer, single-process assumption already holds today (P6§4.1's design; no concurrent writer exists anywhere in this codebase) — last-line-wins is safe because writes are never concurrent. No new invariant is introduced beyond what already existed.

**Accepted trade-off — crash-window staleness (found in final review, accepted rather than fixed):** `write_sourced_candles` is a two-step sequence — `write_partition` (atomic rename) commits the parquet file, then `append_partition_key` appends the new bounds. A process kill between those two steps leaves the manifest's bounds for that partition stale (understating what's actually on disk) until the same partition is written to again. Pre-fix, this window was harmless: `partition_bounds` recomputed live from parquet on every list, so a crash here was invisible. Post-fix, a crash in this exact window can under-report `to_ts`/`candle_count` for one partition indefinitely if that symbol is never re-ingested. This is display-only (never corrupts candle data itself) and self-heals on the next write to that key; given the single-user, pre-1.0, locally-run nature of this tool, this is accepted as-is rather than made atomic (e.g. via a combined write+manifest transaction), which would add real complexity for a narrow, self-healing, non-destructive failure window.

## P11§7 Rollout note (local dev lake)

The lake currently on disk (`~/trade-assistant-lake`, ~2,455 symbols across the ingested date range) was populated by the pre-fix code and its manifest lacks the new bounds fields. After this fix lands, delete `lake_manifest.jsonl` (or the whole lake directory) and re-run `ingest` for the same date range — the parquet partitions are rebuilt idempotently (day-by-day merge-on-ts) and the manifest is regenerated in the new format from scratch, at the cost of one re-fetch from the public bhavcopy archive (already known to work, ~a few minutes for the range ingested so far).
