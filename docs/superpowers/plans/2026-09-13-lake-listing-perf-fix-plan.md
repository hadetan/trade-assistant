# Lake Listing Performance Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `CandleStore::list_symbols` read partition bounds (`from_ts`/`to_ts`/`candle_count`) directly off the manifest instead of re-deriving them per-partition via a fresh in-memory DuckDB connection and parquet aggregate query, eliminating the 138.78s / 399 CPU-second cost measured against a real 2,455-symbol lake.

**Architecture:** `write_sourced_candles` already builds a fully sorted, in-memory `Vec<Candle>` (`ordered`) before writing parquet. Bounds are computed from that vector with `.first()`/`.last()`/`.len()` — no new I/O — and stored on the `LakePartitionKey` manifest line, appended on every write (not just first-write). `read_partition_keys` folds duplicate `(symbol, timeframe, source)` lines last-line-wins, so a partition's bounds always reflect its most recent write while the manifest file itself stays append-only. `list_symbols` then becomes a pure manifest read with a cheap file-existence check — no DuckDB, no parquet I/O.

**Tech Stack:** Rust, `duckdb` crate (removed from this specific path), `serde`/`serde_json` for the JSONL manifest, `tempfile` for tests.

## Global Constraints

- `snake_case` for functions/variables, `PascalCase` for types (per `CLAUDE.md`).
- One clear responsibility per file; no file splitting needed here (both files stay within their existing responsibilities).
- No comments except non-obvious *why* — never restate what the next line does, never a numbered step comment block above a function (per `CLAUDE.md`).
- Pure logic separated from I/O where the codebase already does so — `lake_manifest.rs` (manifest I/O) and `candle_store.rs` (parquet I/O) keep their existing boundary; this fix removes I/O from `list_symbols`, it does not add any.
- Single-writer/single-process assumption already holds — no concurrent writer exists anywhere in this codebase (P11§6). Last-line-wins is safe on that basis. Do not add locking, mutexes, or file coordination of any kind.
- No backward-compatibility parsing for the old (bounds-less) manifest schema. This is an explicitly rejected approach in the spec — the user will delete and re-ingest their local dev lake (P11§7). Do not add a fallback/migration path.
- Do not touch ingest-time write cost beyond what's specified, `read_partition`/`write_partition`'s own DuckDB usage for actual candle data, or any sidecar wire-protocol/TypeScript file — `LakeSymbolEntry`'s shape is unchanged, so zero IPC/TS edits belong in this plan.

## File Structure

No new files. Two existing files change:

- `rust-core/crates/storage/src/lake_manifest.rs` — `LakePartitionKey` gains three fields; `read_partition_keys` changes its dedup rule from first-seen (whole-struct equality) to last-line-wins (keyed on `(symbol, timeframe, source)`). Gains its first `#[cfg(test)] mod tests` block (none exists today).
- `rust-core/crates/storage/src/candle_store.rs` — `write_sourced_candles` computes and always appends bounds; `partition_bounds` is deleted; `list_symbols` is simplified to a pure manifest read. New test added to the existing `mod tests` block.

No changes to `rust-core/crates/sidecar/src/handlers.rs` — its existing test at line 549 is verified, not edited.

---

### Task 1: Manifest carries bounds; `list_symbols` reads them instead of re-deriving them from parquet

**Files:**
- Modify: `rust-core/crates/storage/src/lake_manifest.rs` (full file, currently 47 lines)
- Modify: `rust-core/crates/storage/src/candle_store.rs:127-198` (`write_sourced_candles`, `partition_bounds`, `list_symbols`)
- Test: `rust-core/crates/storage/src/lake_manifest.rs` (new `mod tests`)
- Test: `rust-core/crates/storage/src/candle_store.rs` (existing `mod tests`, new test added)

**Interfaces:**
- Consumes: nothing new from outside this task — `Candle { ts, open, high, low, close, volume }` and `CandleStore::open`/`write_sourced_candles`/`list_symbols`/`LakeSymbolEntry` already exist unchanged in `candle_store.rs`.
- Produces: `LakePartitionKey { symbol: String, timeframe: String, source: String, from_ts: i64, to_ts: i64, candle_count: usize }` (three new required fields) and `read_partition_keys(root: &Path) -> Result<Vec<LakePartitionKey>>` with last-line-wins dedup semantics. Both are used internally by `candle_store.rs` only — no other crate references `LakePartitionKey` (confirmed: `list_symbols` is the only external-facing surface, and its return type `LakeSymbolEntry` is unchanged, so `sidecar/src/handlers.rs` needs no edits).

This is a single task because the two files are mutually non-compiling in isolation: `candle_store.rs`'s `LakePartitionKey { symbol, timeframe, source }` literal must gain the three new fields in the same change as the struct definition, or the crate does not build. A reviewer cannot sensibly approve "add fields to the struct" independently of "update the one call site that constructs it."

The steps below are ordered so each new test is genuinely red before its fix, even though the manifest change and the candle_store change are coupled:

- [ ] **Step 1: Write the failing manifest test (last-line-wins)**

Add to the bottom of `rust-core/crates/storage/src/lake_manifest.rs` (this file currently has no test module):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn read_partition_keys_last_line_wins_on_bounds_for_the_same_partition() {
        let dir = tempdir().unwrap();
        append_partition_key(
            dir.path(),
            &LakePartitionKey {
                symbol: "NSE:INFY".to_string(),
                timeframe: "day".to_string(),
                source: "bhavcopy".to_string(),
                from_ts: 100,
                to_ts: 200,
                candle_count: 5,
            },
        )
        .unwrap();
        append_partition_key(
            dir.path(),
            &LakePartitionKey {
                symbol: "NSE:INFY".to_string(),
                timeframe: "day".to_string(),
                source: "bhavcopy".to_string(),
                from_ts: 100,
                to_ts: 300,
                candle_count: 8,
            },
        )
        .unwrap();

        let keys = read_partition_keys(dir.path()).unwrap();

        assert_eq!(keys.len(), 1, "duplicate (symbol, timeframe, source) must fold to one entry");
        assert_eq!(keys[0].to_ts, 300, "last write's bounds must win");
        assert_eq!(keys[0].candle_count, 8, "last write's candle_count must win");
    }
}
```

- [ ] **Step 2: Run the test, confirm it fails to compile**

Run: `cd rust-core && cargo test -p storage lake_manifest`
Expected: FAIL to compile — `LakePartitionKey` has no fields `from_ts`, `to_ts`, `candle_count` yet.

- [ ] **Step 3: Add the bounds fields to `LakePartitionKey` and change `read_partition_keys` to last-line-wins**

Replace the full contents of `rust-core/crates/storage/src/lake_manifest.rs` (keeping the new `mod tests` block from Step 1 at the bottom) with:

```rust
use crate::error::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LakePartitionKey {
    pub symbol: String,
    pub timeframe: String,
    pub source: String,
    pub from_ts: i64,
    pub to_ts: i64,
    pub candle_count: usize,
}

fn manifest_path(root: &Path) -> PathBuf {
    root.join("lake_manifest.jsonl")
}

pub fn append_partition_key(root: &Path, key: &LakePartitionKey) -> Result<()> {
    let line = serde_json::to_string(key)?;
    let mut file = OpenOptions::new().create(true).append(true).open(manifest_path(root))?;
    writeln!(file, "{line}")?;
    Ok(())
}

pub fn read_partition_keys(root: &Path) -> Result<Vec<LakePartitionKey>> {
    let path = manifest_path(root);
    // A missing manifest is an empty lake, not an error -- mirrors
    // read_partition's "never-written partition is empty" convention.
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = std::fs::read_to_string(&path)?;
    let mut order: Vec<(String, String, String)> = Vec::new();
    let mut latest: HashMap<(String, String, String), LakePartitionKey> = HashMap::new();
    for line in contents.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let key: LakePartitionKey = serde_json::from_str(line)?;
        let dedup_key = (key.symbol.clone(), key.timeframe.clone(), key.source.clone());
        if !latest.contains_key(&dedup_key) {
            order.push(dedup_key.clone());
        }
        // Append-only manifest, so a later line for the same partition always
        // reflects a more recent write -- last-line-wins resolves staleness
        // here instead of rewriting history on every append.
        latest.insert(dedup_key, key);
    }
    Ok(order.into_iter().map(|k| latest.remove(&k).unwrap()).collect())
}
```

Then, in `rust-core/crates/storage/src/candle_store.rs`, make the minimal edit needed for the crate to compile again — fill in the three new fields on the existing `LakePartitionKey` literal inside `write_sourced_candles` (the `is_new_partition` gating stays as-is for this step; it is removed in Step 8). Change:

```rust
    pub fn write_sourced_candles(
        &self,
        symbol: &str,
        timeframe: &str,
        source: &str,
        candles: &[Candle],
    ) -> Result<()> {
        let path = self.sourced_partition_path(symbol, timeframe, source);
        let is_new_partition = !path.exists();
        // Read-merge-write keyed on ts: existing partition + incoming, incoming
        // wins on duplicate ts, output sorted ascending. Makes re-ingesting the
        // same day idempotent and lets day-by-day bhavcopy pulls accumulate.
        let mut merged: BTreeMap<i64, Candle> =
            self.read_partition(&path)?.into_iter().map(|c| (c.ts, c)).collect();
        for candle in candles {
            merged.insert(candle.ts, candle.clone());
        }
        let ordered: Vec<Candle> = merged.into_values().collect();
        self.write_partition(&path, &ordered)?;
        if is_new_partition {
            lake_manifest::append_partition_key(
                &self.root,
                &LakePartitionKey {
                    symbol: symbol.to_string(),
                    timeframe: timeframe.to_string(),
                    source: source.to_string(),
                },
            )?;
        }
        Ok(())
    }
```

to:

```rust
    pub fn write_sourced_candles(
        &self,
        symbol: &str,
        timeframe: &str,
        source: &str,
        candles: &[Candle],
    ) -> Result<()> {
        let path = self.sourced_partition_path(symbol, timeframe, source);
        let is_new_partition = !path.exists();
        // Read-merge-write keyed on ts: existing partition + incoming, incoming
        // wins on duplicate ts, output sorted ascending. Makes re-ingesting the
        // same day idempotent and lets day-by-day bhavcopy pulls accumulate.
        let mut merged: BTreeMap<i64, Candle> =
            self.read_partition(&path)?.into_iter().map(|c| (c.ts, c)).collect();
        for candle in candles {
            merged.insert(candle.ts, candle.clone());
        }
        let ordered: Vec<Candle> = merged.into_values().collect();
        self.write_partition(&path, &ordered)?;
        let from_ts = ordered.first().map(|c| c.ts).unwrap_or(0);
        let to_ts = ordered.last().map(|c| c.ts).unwrap_or(0);
        let candle_count = ordered.len();
        if is_new_partition {
            lake_manifest::append_partition_key(
                &self.root,
                &LakePartitionKey {
                    symbol: symbol.to_string(),
                    timeframe: timeframe.to_string(),
                    source: source.to_string(),
                    from_ts,
                    to_ts,
                    candle_count,
                },
            )?;
        }
        Ok(())
    }
```

- [ ] **Step 4: Run the manifest test, confirm it passes**

Run: `cd rust-core && cargo test -p storage lake_manifest`
Expected: PASS — `read_partition_keys_last_line_wins_on_bounds_for_the_same_partition` passes; crate compiles.

- [ ] **Step 5: Simplify `list_symbols` to read bounds off the manifest, delete `partition_bounds`**

In `rust-core/crates/storage/src/candle_store.rs`, delete the `partition_bounds` method entirely (its only caller is `list_symbols`, edited next):

```rust
    fn partition_bounds(&self, path: &Path) -> Result<(i64, i64, usize)> {
        let path_str = Self::escape_sql_literal(&path.to_string_lossy());
        let conn = Connection::open_in_memory()?;
        let (min_ts, max_ts, count): (i64, i64, i64) = conn.query_row(
            &format!("SELECT min(ts), max(ts), count(*) FROM read_parquet('{path_str}')"),
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        Ok((min_ts, max_ts, count as usize))
    }
```

Replace `list_symbols` — currently:

```rust
    pub fn list_symbols(&self) -> Result<Vec<LakeSymbolEntry>> {
        let keys = lake_manifest::read_partition_keys(&self.root)?;
        let mut entries = Vec::new();
        for key in keys {
            let path = self.sourced_partition_path(&key.symbol, &key.timeframe, &key.source);
            // Defensive: a manifested key whose partition file is gone is skipped
            // rather than erroring the whole listing.
            if !path.exists() {
                continue;
            }
            let (from_ts, to_ts, candle_count) = self.partition_bounds(&path)?;
            entries.push(LakeSymbolEntry {
                symbol: key.symbol,
                timeframe: key.timeframe,
                source: key.source,
                from_ts,
                to_ts,
                candle_count,
            });
        }
        entries.sort_by(|a, b| {
            (&a.symbol, &a.timeframe, &a.source).cmp(&(&b.symbol, &b.timeframe, &b.source))
        });
        Ok(entries)
    }
```

with:

```rust
    pub fn list_symbols(&self) -> Result<Vec<LakeSymbolEntry>> {
        let keys = lake_manifest::read_partition_keys(&self.root)?;
        // Defensive: a manifested key whose partition file is gone is skipped
        // rather than erroring the whole listing.
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

At this point `Connection` may become an unused import if nothing else in the file uses it directly — it does not: `read_partition` and `write_partition` both still call `Connection::open_in_memory()`, so the `use duckdb::{params, Connection};` import at the top of the file stays unchanged.

- [ ] **Step 6: Run the full storage suite, confirm it still compiles and passes**

Run: `cd rust-core && cargo test -p storage`
Expected: PASS — all existing tests (including the three in `candle_store.rs`'s `mod tests` and the new one in `lake_manifest.rs`) pass. `list_symbols` now does zero DuckDB/parquet I/O.

- [ ] **Step 7: Write the failing candle_store test (cumulative bounds across two disjoint writes)**

Add to the existing `mod tests` block in `rust-core/crates/storage/src/candle_store.rs` (alongside `write_partition_replaces_prior_contents_fully` etc.):

```rust
    #[test]
    fn list_symbols_reflects_cumulative_bounds_after_two_disjoint_writes() {
        let dir = tempdir().unwrap();
        let store = CandleStore::open(dir.path()).unwrap();

        store
            .write_sourced_candles(
                "NSE:INFY",
                "day",
                "bhavcopy",
                &[Candle { ts: 100, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1 }],
            )
            .unwrap();
        store
            .write_sourced_candles(
                "NSE:INFY",
                "day",
                "bhavcopy",
                &[Candle { ts: 200, open: 2.0, high: 2.0, low: 2.0, close: 2.0, volume: 2 }],
            )
            .unwrap();

        let entries = store.list_symbols().unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].from_ts, 100, "bounds must cover the first write's earliest candle");
        assert_eq!(entries[0].to_ts, 200, "bounds must cover the second write's latest candle, not just the first write's");
        assert_eq!(entries[0].candle_count, 2, "count must be cumulative across both writes");
    }
```

- [ ] **Step 8: Run the test, confirm it fails**

Run: `cd rust-core && cargo test -p storage candle_store`
Expected: FAIL — `list_symbols_reflects_cumulative_bounds_after_two_disjoint_writes` fails on the `to_ts` assertion. Cause: `write_sourced_candles` still gates `append_partition_key` behind `is_new_partition` (from Step 3), so the second write's up-to-date bounds are never appended to the manifest; `list_symbols` (simplified in Step 5) now reads the manifest only, so it reports the stale first-write bounds (`to_ts == 100`, `candle_count == 1`).

- [ ] **Step 9: Remove the `is_new_partition` gating so every write appends current bounds**

In `rust-core/crates/storage/src/candle_store.rs`, change `write_sourced_candles` from:

```rust
    pub fn write_sourced_candles(
        &self,
        symbol: &str,
        timeframe: &str,
        source: &str,
        candles: &[Candle],
    ) -> Result<()> {
        let path = self.sourced_partition_path(symbol, timeframe, source);
        let is_new_partition = !path.exists();
        // Read-merge-write keyed on ts: existing partition + incoming, incoming
        // wins on duplicate ts, output sorted ascending. Makes re-ingesting the
        // same day idempotent and lets day-by-day bhavcopy pulls accumulate.
        let mut merged: BTreeMap<i64, Candle> =
            self.read_partition(&path)?.into_iter().map(|c| (c.ts, c)).collect();
        for candle in candles {
            merged.insert(candle.ts, candle.clone());
        }
        let ordered: Vec<Candle> = merged.into_values().collect();
        self.write_partition(&path, &ordered)?;
        let from_ts = ordered.first().map(|c| c.ts).unwrap_or(0);
        let to_ts = ordered.last().map(|c| c.ts).unwrap_or(0);
        let candle_count = ordered.len();
        if is_new_partition {
            lake_manifest::append_partition_key(
                &self.root,
                &LakePartitionKey {
                    symbol: symbol.to_string(),
                    timeframe: timeframe.to_string(),
                    source: source.to_string(),
                    from_ts,
                    to_ts,
                    candle_count,
                },
            )?;
        }
        Ok(())
    }
```

to:

```rust
    pub fn write_sourced_candles(
        &self,
        symbol: &str,
        timeframe: &str,
        source: &str,
        candles: &[Candle],
    ) -> Result<()> {
        let path = self.sourced_partition_path(symbol, timeframe, source);
        // Read-merge-write keyed on ts: existing partition + incoming, incoming
        // wins on duplicate ts, output sorted ascending. Makes re-ingesting the
        // same day idempotent and lets day-by-day bhavcopy pulls accumulate.
        let mut merged: BTreeMap<i64, Candle> =
            self.read_partition(&path)?.into_iter().map(|c| (c.ts, c)).collect();
        for candle in candles {
            merged.insert(candle.ts, candle.clone());
        }
        let ordered: Vec<Candle> = merged.into_values().collect();
        self.write_partition(&path, &ordered)?;
        let from_ts = ordered.first().map(|c| c.ts).unwrap_or(0);
        let to_ts = ordered.last().map(|c| c.ts).unwrap_or(0);
        let candle_count = ordered.len();
        lake_manifest::append_partition_key(
            &self.root,
            &LakePartitionKey {
                symbol: symbol.to_string(),
                timeframe: timeframe.to_string(),
                source: source.to_string(),
                from_ts,
                to_ts,
                candle_count,
            },
        )?;
        Ok(())
    }
```

(`append_partition_key` is now called on every write, carrying current bounds, not gated behind `is_new_partition`; last-line-wins in `read_partition_keys` — Step 3 — resolves the resulting duplicate manifest lines on read.)

- [ ] **Step 10: Run the test, confirm it passes**

Run: `cd rust-core && cargo test -p storage candle_store`
Expected: PASS — `list_symbols_reflects_cumulative_bounds_after_two_disjoint_writes` now passes (second write appends `{from_ts: 100, to_ts: 200, candle_count: 2}`, last-line-wins picks it).

- [ ] **Step 11: Run the full storage crate suite**

Run: `cd rust-core && cargo test -p storage`
Expected: PASS — every test in `lake_manifest.rs` and `candle_store.rs` passes, including the three pre-existing `candle_store.rs` tests (`write_partition_replaces_prior_contents_fully`, `a_write_failure_at_the_tmp_stage_never_touches_the_real_partition`, `partition_path_sanitizes_quotes_and_traversal_sequences`), unaffected by this change.

- [ ] **Step 12: Confirm the sidecar's existing lake-listing test still passes unchanged**

Run: `cd rust-core && cargo test -p sidecar handle_list_lake_symbols_returns_one_entry_per_written_partition`
Expected: PASS — `handle_list_lake_symbols_returns_one_entry_per_written_partition` (`rust-core/crates/sidecar/src/handlers.rs:549`) passes with no edits to `handlers.rs`, confirming `LakeSymbolEntry`'s wire shape and one-entry-per-partition behavior are preserved.

- [ ] **Step 13: Commit**

```bash
git add rust-core/crates/storage/src/lake_manifest.rs rust-core/crates/storage/src/candle_store.rs
git commit -m "perf(storage): read lake partition bounds from manifest instead of per-partition DuckDB scan"
```

---

## Self-Review

**1. Spec coverage:**
- P11§2 item 1 (manifest schema extension, every-write append, last-line-wins dedup) → Task 1, Steps 1-4.
- P11§2 item 2 (`write_sourced_candles` derives bounds from `ordered`, `list_symbols` reads manifest directly, `partition_bounds` deleted) → Task 1, Steps 5, 9-10.
- P11§2 item 3 / P11§7 (no compat parsing; user re-ingests) → covered by Global Constraints explicitly forbidding a migration path; no task adds one.
- P11§3 (exact `LakePartitionKey` shape, `append_partition_key` unchanged in shape, `read_partition_keys` last-line-wins semantics) → Step 3's struct and function bodies match verbatim.
- P11§4 (exact `from_ts`/`to_ts`/`candle_count` derivation, exact `list_symbols` body, `path.exists()` preserved) → Steps 3, 5, 9 match the spec's code blocks verbatim.
- P11§5 (three testing requirements: existing sidecar test unchanged, new manifest last-line-wins test, new candle_store cumulative-bounds test) → Steps 1, 7, 12 respectively.
- P11§6 (no locking, single-writer assumption) → stated in Global Constraints, no locking code introduced anywhere.
- No task touches ingest write cost, `read_partition`/`write_partition`'s DuckDB usage, or any TS/wire file — confirmed absent from the diff described above.

**2. Placeholder scan:** No "TBD"/"TODO"/"handle edge cases"/"similar to above" language anywhere in the steps; every code step shows complete, real, compilable code (verified against the actual current file contents read from the repo, not paraphrased).

**3. Type consistency:** `LakePartitionKey` fields (`symbol: String, timeframe: String, source: String, from_ts: i64, to_ts: i64, candle_count: usize`) are identical across Step 3's struct definition, the Step 3/Step 9 literals in `candle_store.rs`, and the Step 1/Step 7 test constructions. `LakeSymbolEntry`'s fields (already defined pre-existing at `candle_store.rs:17-25`) are untouched and match `list_symbols`'s field-by-field mapping in Step 5. `read_partition_keys(root: &Path) -> Result<Vec<LakePartitionKey>>` and `append_partition_key(root: &Path, key: &LakePartitionKey) -> Result<()>` signatures are unchanged from the current file and used identically in both the manifest test and `candle_store.rs`'s call sites.

One deliberate deviation from the task-brief's literal step ordering, noted for the reviewer: `partition_bounds` deletion and `list_symbols` simplification (Step 5) happen *before* the new candle_store test is written (Step 7), rather than after, per the brief's suggested "write test, verify fails, implement, verify passes" sequence. This is necessary for the test to be genuinely red — with the old DuckDB-based `partition_bounds` still in place, it recomputes bounds directly from the merged parquet file and would already report correct cumulative bounds regardless of manifest state, so the test would pass immediately and never catch a real regression. Reordering `list_symbols`'s simplification earlier, while leaving `is_new_partition` gating in place until Step 9, produces a real failing test (Step 8) driven by the actual last-line-wins/every-write-append mechanism being validated.
