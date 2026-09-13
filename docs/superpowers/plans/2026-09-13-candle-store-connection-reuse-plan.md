# Candle Store Connection Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `CandleStore::read_partition`/`write_partition` from opening a brand-new in-memory DuckDB `Connection` on every call; hold one `Connection` for the whole lifetime of a `CandleStore` instead, eliminating ~4,800 redundant DuckDB engine bootups (thread-pool spin-up + SHA256 file-segment hashing) per ingest day.

**Architecture:** `CandleStore` gains a `conn: Connection` field built once in `open()` with `threads(1)` and `enable_object_cache(false)` (both meaningless/wasteful for this workload's single-row-group, few-KB, touch-once parquet files). `read_partition` and `write_partition` use `&self.conn` instead of opening their own connection; `write_partition`'s `CREATE TABLE` becomes `CREATE OR REPLACE TABLE` since the table now lives in a database that persists across calls instead of one thrown away after each call.

**Tech Stack:** Rust, `duckdb` crate v1.10504.0 (declared as `"1.0"` with `bundled` feature in `rust-core/crates/storage/Cargo.toml`), `tempfile` for test fixtures.

## Global Constraints

- `snake_case` for functions/variables, `PascalCase` for types (per this repo's `CLAUDE.md`).
- One clear responsibility per file; pure logic separated from I/O where the codebase already does so (`candle_store.rs` is the I/O boundary for this crate — unchanged by this plan).
- No comments except non-obvious *why* — never restate what the next line does, never a numbered step-by-step comment block above a function.
- No locking/mutex/`Arc` introduced anywhere in this plan. Every `CandleStore` in this codebase is constructed and used single-threaded for its entire lifetime — the sidecar constructs exactly one at `main.rs:76` and drives it from its single-threaded stdin-processing loop, and the `ingest`/`replay` CLIs are single-threaded. A single non-`Sync` `Connection` field is therefore safe as-is; do not add synchronization for a multi-threaded use case no current caller has.
- Do not touch `list_symbols`/the manifest, the `ingest` CLI, `import_bhavcopy_files`/`import_intraday_files`, the sidecar's request/response protocol, the one-file-per-symbol partition layout, or any locking/concurrency mechanism — all explicitly out of scope per the approved design.

---

## File Structure

No new files. One file changes behavior, one file gains two new tests:

- **Modify:** `rust-core/crates/storage/src/candle_store.rs` — `CandleStore` struct gains a `conn: Connection` field; `open` constructs it once; `read_partition`/`write_partition` use `self.conn` instead of opening a fresh connection each call; `write_partition`'s `CREATE TABLE` becomes `CREATE OR REPLACE TABLE`; its `mod tests` block gains two new tests.
- **Unchanged, must keep passing:** `rust-core/crates/storage/tests/candle_store_test.rs` (13 existing integration tests) — no edits in this plan.
- **Unchanged, must keep compiling/passing:** `rust-core/crates/sidecar/**` — depends on `storage::CandleStore`; constructs one at `main.rs:76`. Proves the new struct shape doesn't break its only other consumer.

---

### Task 1: Give `CandleStore` a persistent connection and prove it's behaviorally identical

**Files:**
- Modify: `rust-core/crates/storage/src/candle_store.rs:1-4` (import line), `:27-35` (struct + `open`), `:66-87` (`read_partition`), `:89-110` (`write_partition`), `:187-291` (`mod tests` — add two new tests)
- Test: `rust-core/crates/storage/src/candle_store.rs` (`mod tests` block, in-file) and `rust-core/crates/storage/tests/candle_store_test.rs` (unchanged, run as regression)

**Interfaces:**
- Consumes: `duckdb::Config` (new import) — `Config::default().threads(1)?.enable_object_cache(false)?` returns `Result<Config, duckdb::Error>`; `Connection::open_in_memory_with_flags(config: Config) -> duckdb::Result<Connection>` (both confirmed against `duckdb` v1.10504.0 vendored source per the approved design doc).
- Produces: `CandleStore` struct shape (`root: PathBuf`, `conn: Connection`) — no public API changes; `open`, `write_candles`, `read_candles`, `write_sourced_candles`, `read_sourced_candles`, `list_symbols` all keep their existing signatures. Every existing caller (sidecar, `ingest`/`replay` CLIs, both test suites) is unaffected.

**Why this is not TDD-in-the-red-sense:** This is a performance/architecture change, not a behavior change. The current per-call `Connection::open_in_memory()` code already produces correct read/write results — it's just slow. The two new tests added in this task (steps 8–9) would pass equally well against today's code, because nothing about *what* gets written or read changes, only *how many connections* it costs to do it. So there is no fabricated RED step here: implement the fix first (steps 1–5), then add the two new tests as regression coverage proving the shared-connection code is behaviorally identical to the old code (steps 6–9), then run the full suite (steps 10–11), then commit (step 12).

- [ ] **Step 1: Change the import line to bring in `Config`**

Current (`candle_store.rs:3`):

```rust
use duckdb::{params, Connection};
```

New:

```rust
use duckdb::{params, Config, Connection};
```

- [ ] **Step 2: Add the `conn` field and build it once in `open`**

Current (`candle_store.rs:27-35`):

```rust
pub struct CandleStore {
    root: PathBuf,
}

impl CandleStore {
    pub fn open(root: &Path) -> Result<Self> {
        std::fs::create_dir_all(root).map_err(StorageError::Io)?;
        Ok(Self { root: root.to_path_buf() })
    }
```

New:

```rust
pub struct CandleStore {
    root: PathBuf,
    conn: Connection,
}

impl CandleStore {
    pub fn open(root: &Path) -> Result<Self> {
        std::fs::create_dir_all(root).map_err(StorageError::Io)?;
        let config = Config::default().threads(1)?.enable_object_cache(false)?;
        let conn = Connection::open_in_memory_with_flags(config)?;
        Ok(Self { root: root.to_path_buf(), conn })
    }
```

No signature change: `open`'s existing `-> Result<Self>` return type already accommodates the extra fallible steps (both `Config::threads`/`Config::enable_object_cache` and `Connection::open_in_memory_with_flags` return `duckdb::Result`, which converts via `?` into this crate's `Result` the same way the pre-existing `Connection::open_in_memory()?` calls already did).

- [ ] **Step 3: Point `read_partition` at `self.conn`**

Current (`candle_store.rs:66-87`):

```rust
    fn read_partition(&self, path: &Path) -> Result<Vec<Candle>> {
        // design §5.1: a never-written partition is empty, not an error.
        if !path.exists() {
            return Ok(Vec::new());
        }
        let path_str = Self::escape_sql_literal(&path.to_string_lossy());
        let conn = Connection::open_in_memory()?;
        let mut stmt = conn.prepare(&format!(
            "SELECT ts, open, high, low, close, volume FROM read_parquet('{path_str}') ORDER BY ts ASC"
        ))?;
        let rows = stmt.query_map([], |row| {
            Ok(Candle {
                ts: row.get(0)?,
                open: row.get(1)?,
                high: row.get(2)?,
                low: row.get(3)?,
                close: row.get(4)?,
                volume: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<duckdb::Result<Vec<Candle>>>()?)
    }
```

New: delete the `let conn = Connection::open_in_memory()?;` line, use `self.conn.prepare(...)`:

```rust
    fn read_partition(&self, path: &Path) -> Result<Vec<Candle>> {
        // design §5.1: a never-written partition is empty, not an error.
        if !path.exists() {
            return Ok(Vec::new());
        }
        let path_str = Self::escape_sql_literal(&path.to_string_lossy());
        let mut stmt = self.conn.prepare(&format!(
            "SELECT ts, open, high, low, close, volume FROM read_parquet('{path_str}') ORDER BY ts ASC"
        ))?;
        let rows = stmt.query_map([], |row| {
            Ok(Candle {
                ts: row.get(0)?,
                open: row.get(1)?,
                high: row.get(2)?,
                low: row.get(3)?,
                close: row.get(4)?,
                volume: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<duckdb::Result<Vec<Candle>>>()?)
    }
```

No signature change — still `&self`; `Connection::prepare` and the downstream `Statement`/`Rows` methods used here only require `&Connection`.

- [ ] **Step 4: Point `write_partition` at `self.conn` and switch to `CREATE OR REPLACE TABLE`**

Current (`candle_store.rs:89-110`):

```rust
    fn write_partition(&self, path: &Path, candles: &[Candle]) -> Result<()> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            "CREATE TABLE candles (ts BIGINT, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume BIGINT)",
        )?;
        let mut appender = conn.appender("candles")?;
        for candle in candles {
            appender.append_row(params![
                candle.ts, candle.open, candle.high, candle.low, candle.close, candle.volume
            ])?;
        }
        appender.flush()?;

        let tmp_path = PathBuf::from(format!("{}.tmp", path.to_string_lossy()));
        let tmp_path_str = Self::escape_sql_literal(&tmp_path.to_string_lossy());
        conn.execute(&format!("COPY candles TO '{tmp_path_str}' (FORMAT PARQUET)"), [])?;
        // Rename is atomic on the same filesystem, so a crash mid-COPY (or mid
        // re-ingest merge) leaves the previous partition intact instead of a
        // half-written file at `path`.
        std::fs::rename(&tmp_path, path)?;
        Ok(())
    }
```

New:

```rust
    fn write_partition(&self, path: &Path, candles: &[Candle]) -> Result<()> {
        self.conn.execute_batch(
            "CREATE OR REPLACE TABLE candles (ts BIGINT, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume BIGINT)",
        )?;
        let mut appender = self.conn.appender("candles")?;
        for candle in candles {
            appender.append_row(params![
                candle.ts, candle.open, candle.high, candle.low, candle.close, candle.volume
            ])?;
        }
        appender.flush()?;

        let tmp_path = PathBuf::from(format!("{}.tmp", path.to_string_lossy()));
        let tmp_path_str = Self::escape_sql_literal(&tmp_path.to_string_lossy());
        self.conn.execute(&format!("COPY candles TO '{tmp_path_str}' (FORMAT PARQUET)"), [])?;
        // Rename is atomic on the same filesystem, so a crash mid-COPY (or mid
        // re-ingest merge) leaves the previous partition intact instead of a
        // half-written file at `path`.
        std::fs::rename(&tmp_path, path)?;
        Ok(())
    }
```

`OR REPLACE` is required, not optional style: without it, the second `write_partition` call on the same `CandleStore` (the second symbol ingested in a run) fails with a DuckDB "table candles already exists" error, since the table now lives in the connection's persistent in-memory database rather than a throwaway one destroyed with the old per-call connection.

Note for later reference (no code needed): if a `write_partition` call fails partway — e.g. the COPY-to-temp step errors out — the connection's in-memory `candles` table is left holding that failed call's rows after the method returns `Err`. This is harmless and self-healing: the very next `write_partition` call, for any symbol, issues `CREATE OR REPLACE TABLE candles (...)` again before appending anything, so the stale in-memory rows never leak into a later read or write. The existing test in Step 6 below already proves the on-disk partition file is untouched by a failed write regardless of what transiently sits in the in-memory table.

- [ ] **Step 5: Build and confirm the crate compiles**

Run: `cd rust-core && cargo build -p storage`
Expected: builds with no errors.

- [ ] **Step 6: Run the existing `storage` test suite to confirm no regression yet**

Run: `cd rust-core && cargo test -p storage`
Expected: all pre-existing tests pass unchanged — 4 tests in `candle_store.rs`'s `mod tests` (`write_partition_replaces_prior_contents_fully`, `a_write_failure_at_the_tmp_stage_never_touches_the_real_partition`, `partition_path_sanitizes_quotes_and_traversal_sequences`, `list_symbols_reflects_cumulative_bounds_after_two_disjoint_writes`) plus 13 tests in `rust-core/crates/storage/tests/candle_store_test.rs`. In particular, `a_write_failure_at_the_tmp_stage_never_touches_the_real_partition` must still pass: it proves the on-disk partition file is untouched by a failed write, which is unaffected by the note in Step 4 about the transient in-memory table state.

- [ ] **Step 7: Add the "two different symbols share one connection" test**

Add to `rust-core/crates/storage/src/candle_store.rs`'s existing `mod tests` block, after `list_symbols_reflects_cumulative_bounds_after_two_disjoint_writes`:

```rust
    #[test]
    fn two_different_symbols_written_to_the_same_store_read_back_independently() {
        let dir = tempdir().unwrap();
        let store = CandleStore::open(dir.path()).unwrap();

        store
            .write_sourced_candles(
                "NSE:INFY",
                "day",
                "bhavcopy",
                &[Candle { ts: 100, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 10 }],
            )
            .unwrap();
        store
            .write_sourced_candles(
                "NSE:TCS",
                "day",
                "bhavcopy",
                &[
                    Candle { ts: 200, open: 2.0, high: 2.0, low: 2.0, close: 2.0, volume: 20 },
                    Candle { ts: 300, open: 3.0, high: 3.0, low: 3.0, close: 3.0, volume: 30 },
                ],
            )
            .unwrap();

        let infy = store.read_sourced_candles("NSE:INFY", "day", "bhavcopy").unwrap();
        let tcs = store.read_sourced_candles("NSE:TCS", "day", "bhavcopy").unwrap();

        assert_eq!(infy.len(), 1, "NSE:INFY must keep exactly its own one candle");
        assert_eq!(infy[0].ts, 100);
        assert_eq!(tcs.len(), 2, "NSE:TCS must keep exactly its own two candles");
        assert_eq!(tcs.iter().map(|c| c.ts).collect::<Vec<_>>(), vec![200, 300]);
    }
```

This proves `CREATE OR REPLACE TABLE` against the shared connection isolates each symbol's write correctly rather than leaking rows between symbols that share the one connection.

- [ ] **Step 8: Add the "read then write again against the shared connection" test**

Add directly after the test from Step 7, still inside `mod tests`:

```rust
    #[test]
    fn write_then_read_then_write_again_round_trips_against_the_shared_connection() {
        let dir = tempdir().unwrap();
        let store = CandleStore::open(dir.path()).unwrap();

        store
            .write_sourced_candles(
                "NSE:INFY",
                "day",
                "bhavcopy",
                &[Candle { ts: 100, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 10 }],
            )
            .unwrap();

        let first_read = store.read_sourced_candles("NSE:INFY", "day", "bhavcopy").unwrap();
        assert_eq!(first_read.len(), 1);
        assert_eq!(first_read[0].ts, 100);

        // write_sourced_candles itself does read_partition-then-write_partition
        // internally; this second call forces that same sequence to run again
        // against the store's one persistent connection.
        store
            .write_sourced_candles(
                "NSE:INFY",
                "day",
                "bhavcopy",
                &[Candle { ts: 200, open: 2.0, high: 2.0, low: 2.0, close: 2.0, volume: 20 }],
            )
            .unwrap();

        let second_read = store.read_sourced_candles("NSE:INFY", "day", "bhavcopy").unwrap();
        assert_eq!(second_read.len(), 2, "must have merged, not replaced, the first candle");
        assert_eq!(second_read.iter().map(|c| c.ts).collect::<Vec<_>>(), vec![100, 200]);
    }
```

This proves the read-then-write sequence inside `write_sourced_candles` still round-trips correctly when both halves run against one persistent connection instead of two independent throwaway ones.

- [ ] **Step 9: Run the full `storage` suite including the two new tests**

Run: `cd rust-core && cargo test -p storage`
Expected: PASS — the 4 pre-existing `candle_store.rs` tests, the 2 new tests from Steps 7–8 (6 total in `mod tests`), plus the 13 pre-existing tests in `candle_store_test.rs` (19 tests total in the `storage` crate).

- [ ] **Step 10: Run the `sidecar` crate's tests to confirm its only other consumer still compiles and works**

Run: `cd rust-core && cargo test -p sidecar`
Expected: PASS, unchanged — confirms `sidecar` (which constructs a `CandleStore` at `main.rs:76` and depends on `storage`) still compiles and behaves correctly against the new `CandleStore` struct shape (extra `conn` field, same public API).

- [ ] **Step 11: Commit**

```bash
cd /Users/salman/ws/trade-assistant
git add rust-core/crates/storage/src/candle_store.rs
git commit -m "perf(storage): reuse one DuckDB connection per CandleStore instead of one per call

read_partition/write_partition each opened a fresh in-memory DuckDB
Connection on every invocation. write_sourced_candles calls both once per
symbol per ingest day (~2,400 symbols/day), so that was ~4,800 full engine
bootups/day, each paying thread-pool spin-up + SHA256 file-segment hashing
(measured at 95.78s wall / 294 CPU-s / 398% CPU across 8 threads for one
day via sample profiling). CandleStore now holds one Connection for its
whole lifetime, built with threads(1) and enable_object_cache(false) since
neither DuckDB's parallel query engine nor its parquet-metadata cache pay
off for single-row-group, few-KB, touch-once-per-day partition files."
```

---

## Self-Review

**1. Spec coverage:**
- CSR§2 item 1 (struct field + `open` construction) → Task 1 Steps 1–2. Covered.
- CSR§2 item 2 (`CREATE OR REPLACE TABLE`) → Task 1 Step 4. Covered.
- CSR§2 item 3 (re-measurement) → explicitly out of scope for this plan's automated steps per CSR§5 ("No wall-clock-threshold assertion in the automated suite... verified by the manual re-measurement in CSR§6, not by an automated timing test"); CSR§6 is a manual, post-implementation verification the plan does not need to script. Not a gap — it's an intentionally manual step outside this plan's task/commit loop, consistent with the design doc's own scoping.
- CSR§3 (struct/`open`/import change) → Task 1 Steps 1–2. Covered, code matches spec verbatim.
- CSR§4 (`read_partition`/`write_partition` bodies) → Task 1 Steps 3–4. Covered, code matches spec verbatim including the `OR REPLACE` rationale.
- CSR§5 (testing: existing tests keep passing, two new tests, no timing assertion) → Task 1 Steps 6, 7, 8, 9, 10. Covered. The two new tests were written to closely match the spec's own descriptions (two different symbols; read-then-write-again), using `write_sourced_candles`/`read_sourced_candles` as directed.
- CSR§7 (risk: no `Send`/`Sync` requirement, single-threaded assumption) → captured in Global Constraints section and Step 4/plan header rationale.
- The prompt's instruction to avoid a fabricated RED step is addressed head-on in Task 1's framing paragraph before Step 1, explaining why these two tests would already pass against the old code and structuring the steps accordingly (implement first, then add regression tests, then run everything).

**2. Placeholder scan:** No "TBD"/"similar to above"/unshown code. Every step with a code change shows the complete before/after snippet taken verbatim from the actual files read (`candle_store.rs`) or the approved spec. Both new tests are fully written out, not described.

**3. Type consistency:** `CandleStore` fields (`root: PathBuf`, `conn: Connection`), method signatures (`open(root: &Path) -> Result<Self>`, `read_partition(&self, path: &Path) -> Result<Vec<Candle>>`, `write_partition(&self, path: &Path, candles: &[Candle]) -> Result<()>`), and the public methods used in the new tests (`write_sourced_candles(&self, symbol: &str, timeframe: &str, source: &str, candles: &[Candle]) -> Result<()>`, `read_sourced_candles(&self, symbol: &str, timeframe: &str, source: &str) -> Result<Vec<Candle>>`) all match the real file exactly as read from `rust-core/crates/storage/src/candle_store.rs:112-164`. `Candle` field names/types (`ts: i64, open: f64, high: f64, low: f64, close: f64, volume: i64`) match the struct at `candle_store.rs:7-15` and are used identically in the new tests.

No gaps found; no fixes needed beyond what's already reflected above.
