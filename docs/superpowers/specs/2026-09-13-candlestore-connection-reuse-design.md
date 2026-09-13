# CandleStore Connection Reuse — Design

Status: approved by user 2026-09-13 (conversational diagnosis + brainstorming), pending implementation planning.
Author: design produced via superpowers:brainstorming, triggered by a live incident: ingesting one day of NSE bhavcopy data (~2,400 symbols) took 95.78s wall-clock / 294 CPU-seconds and pegged the `ingest` process at 398% CPU across 8 threads (confirmed via Activity Monitor and independently reproduced). Section references: "P11§N" → `docs/superpowers/specs/2026-09-13-phase11-lake-listing-perf-fix-design.md`; "CSR§N" → this document ("CandleStore Reuse").

## CSR§1 Purpose

P11 fixed `list_symbols` opening a fresh `duckdb::Connection::open_in_memory()` per partition file just to read bounds. This document fixes the same underlying disease in the two methods P11 explicitly left untouched: `CandleStore::read_partition` and `CandleStore::write_partition` (`rust-core/crates/storage/src/candle_store.rs`), which back `write_sourced_candles` — called once per symbol on every ingest day, and by the sidecar's live `persist` handler on every save.

**Measured evidence, not assumption:** stack-sampled the real `ingest` process (macOS `sample`, no code changes) mid-run. The dominant frames were not candle I/O:
- `thread_start` / `_pthread_start` / `duckdb::TaskScheduler::ExecuteForever` — a full multi-threaded DuckDB worker pool spun up and torn down on every connection
- `duckdb::ComputeSHA256FileSegment` → `mbedtls_sha256_update` / `mbedtls_internal_sha256_process` — DuckDB hashing the file's contents on every read and write
- Actual data I/O (`duckdb::LocalFileSystem::Read`, `pread`) was a small fraction of total samples by comparison

`write_sourced_candles` (`candle_store.rs:127-160`) does a read-merge-write: `read_partition` opens one connection to read the existing partition, `write_partition` opens a second to write the merged result. At ~2,400 symbols/day, that's ~4,800 full DuckDB engine bootups (each paying thread-pool spin-up + SHA256 hashing) for what is, in actual data terms, a few KB per symbol.

## CSR§2 Scope

**In scope:**

1. `rust-core/crates/storage/src/candle_store.rs`: `CandleStore` gains a `conn: Connection` field, constructed once in `CandleStore::open` with `threads(1)` and `enable_object_cache(false)` set via `duckdb::Config`. `read_partition` and `write_partition` use `&self.conn` instead of calling `Connection::open_in_memory()` each time (CSR§3, CSR§4).
2. `write_partition`'s `CREATE TABLE candles (...)` becomes `CREATE OR REPLACE TABLE candles (...)` — required once the connection (and its in-memory database) persists across calls, since the second call would otherwise hit "table already exists" (CSR§4).
3. Re-measurement after implementation: the same timed-run + `sample`-profile + CPU% method used to find this bug, run again to prove the fix, not just assert it (CSR§6).

**Not in scope:**

- Any change to the one-file-per-symbol partition layout (batching multiple symbols into fewer/larger parquet files). Real potential upside, but a layout change with ripple effects on `list_symbols`/`read_sourced_candles`/the manifest — a separate, later decision if this fix's numbers aren't good enough on their own.
- Any change to `list_symbols` or the manifest (P11, already fixed, uses zero DuckDB).
- Any change to the `ingest` CLI, `import_bhavcopy_files`/`import_intraday_files`, or the sidecar's request/response protocol — this is purely a `storage`-crate internal change; every caller of `write_sourced_candles`/`read_sourced_candles`/`read_candles`/`write_candles` is unaffected in signature or behavior.
- Concurrency/locking: unchanged single-writer, single-process assumption (P11§6) — a single persistent `Connection` per `CandleStore` instance is exactly as safe as the current single-threaded call pattern, since nothing in this codebase shares a `CandleStore` across threads.

**Locked decisions:**

1. One `Connection` per `CandleStore`, opened once at `CandleStore::open`, held for the store's full lifetime — not a connection pool, not a connection-per-batch. The sidecar already constructs exactly one `CandleStore` for its whole process lifetime (`main.rs:74`); the `ingest` CLI constructs exactly one per invocation. Neither needs more than one connection ever.
2. `threads(1)`: DuckDB's own parallel query engine offers no benefit for single-row-group, few-KB parquet files read/written one at a time — it only adds thread-hop overhead. Forcing serial execution removes that overhead outright rather than tuning it.
3. `enable_object_cache(false)`: this setting is DuckDB's Parquet-metadata cache, keyed by a content hash (the SHA256 computation observed in the profile) — a cache that only pays off on repeated reads of the *same* file, which never happens here (every partition is touched once per ingest day, then moved on from). Disabling it removes the hashing cost for zero loss of benefit.
4. `CREATE OR REPLACE TABLE` (not `DROP TABLE IF EXISTS` + `CREATE TABLE`, not a UUID-suffixed table name per call) — one statement, same cost, no accumulating table-name bookkeeping.

## CSR§3 `CandleStore` struct and `open` (candle_store.rs)

Current:

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

`use duckdb::{params, Connection};` at the top of the file becomes `use duckdb::{params, Config, Connection};`. `Config`'s `.threads()`/`.enable_object_cache()` each return `Result<Self>` (confirmed against `duckdb` v1.10504.0's vendored source, `duckdb-1.10504.0/src/config.rs`) — chain with `?` as shown; `open`'s existing `-> Result<Self>` return type already accommodates the extra fallible steps, no signature change needed.

## CSR§4 `read_partition` / `write_partition`

Current `read_partition` (candle_store.rs:66-87):

```rust
    fn read_partition(&self, path: &Path) -> Result<Vec<Candle>> {
        if !path.exists() {
            return Ok(Vec::new());
        }
        let path_str = Self::escape_sql_literal(&path.to_string_lossy());
        let conn = Connection::open_in_memory()?;
        let mut stmt = conn.prepare(&format!(
            "SELECT ts, open, high, low, close, volume FROM read_parquet('{path_str}') ORDER BY ts ASC"
        ))?;
        // ...
    }
```

New: delete the `let conn = Connection::open_in_memory()?;` line; every subsequent `conn.` reference in the method body becomes `self.conn.`. No other change — the method still takes `&self`, since every `Connection` method used here (`prepare`, and downstream `Statement`/`Rows` methods) already only requires `&Connection` (confirmed against the crate's public `impl Connection` in `lib.rs`, as opposed to the internal `InnerConnection`'s `&mut self` methods, which are not what `Connection`'s public API exposes).

Current `write_partition` (candle_store.rs:89-110):

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
        std::fs::rename(&tmp_path, path)?;
        Ok(())
    }
```

New: delete `let conn = Connection::open_in_memory()?;`, every `conn.` becomes `self.conn.`, and the `CREATE TABLE` statement gains `OR REPLACE`:

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
        std::fs::rename(&tmp_path, path)?;
        Ok(())
    }
```

Without `OR REPLACE`, the second call to `write_partition` on the same `CandleStore` (i.e. the second symbol ingested in a run) would fail with a DuckDB "table candles already exists" error, since the table now lives in the connection's persistent in-memory database rather than a throwaway one destroyed with the old per-call connection.

## CSR§5 Testing

- Every existing test in `candle_store.rs`'s `mod tests` and `rust-core/crates/storage/tests/candle_store_test.rs` must keep passing unchanged — this is an internal mechanism change with no behavioral difference in what `read_candles`/`write_candles`/`read_sourced_candles`/`write_sourced_candles`/`list_symbols` return.
- New test: write two different symbols' candles to the same `CandleStore` instance (two calls to `write_sourced_candles`, forcing two `write_partition` calls against the shared connection), then read both back via `read_sourced_candles` and assert both are correct and independent — proves `CREATE OR REPLACE TABLE` isolates each write correctly rather than leaking rows between symbols.
- New test: write to one symbol, read it back, then write to it again with additional candles (forces `read_partition` then `write_partition` against the shared connection within one `write_sourced_candles` call) — proves the read-then-write sequence against one persistent connection still round-trips correctly.
- No wall-clock-threshold assertion in the automated suite (matches P11§5's precedent) — the performance claim is verified by the manual re-measurement in CSR§6, not by an automated timing test.

## CSR§6 Verification (manual, post-implementation)

Re-run the exact method used to diagnose this:
1. `time ./target/release/ingest --lake <fresh-or-existing-lake> --mode bhavcopy --exchange NSE --from <date> --to <date>` for a single day already represented by many existing partitions (steady-state read+write cost), compare wall-clock and CPU-seconds against the baseline (95.78s real / 294 CPU-s).
2. `sample <pid> <n> -f <file>` on the running process, confirm `thread_start`/`ComputeSHA256FileSegment`/`mbedtls_sha256_*` no longer dominate the profile.
3. Activity Monitor (or `ps`/`top`) %CPU during the run, compare against the previously observed 398%/8 threads.

## CSR§7 Risk

- `Connection` is not required to be `Send`/`Sync` here: every `CandleStore` in this codebase is constructed and used on a single thread for its entire lifetime (the sidecar's stdin-processing loop is single-threaded per P11's prior investigation; the `ingest`/`replay` CLIs are single-threaded). Adding a `Connection` field does not change `CandleStore`'s concurrency profile.
- `enable_object_cache(false)` and `threads(1)` are per-connection settings with no cross-process or on-disk effect — safe to change without any migration or compatibility concern, unlike P11's manifest schema change.
- If a future phase needs `CandleStore` used from multiple threads, this design does not support that as-is (a single shared `Connection` would need external synchronization) — not a concern for any current caller, and out of scope to pre-build for.
- **Memory floor (found in final review):** measured peak memory footprint per `CandleStore` instance rose from ~12MB (many short-lived connections, each small) to ~84MB (one long-lived connection, held for the store's whole lifetime) during a single-day ingest run. This is a fixed, one-time cost per process — the sidecar carries it for its entire runtime, `ingest`/`replay` for the duration of one invocation — not a per-symbol or per-call cost, and is negligible on any machine this tool targets. Noted here so a future memory-profiling investigation isn't surprised by it.
