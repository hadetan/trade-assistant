use crate::error::{Result, StorageError};
use crate::lake_manifest::{self, LakePartitionKey};
use duckdb::{params, Config, Connection};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct Candle {
    pub ts: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LakeSymbolEntry {
    pub symbol: String,
    pub timeframe: String,
    pub source: String,
    pub from_ts: i64,
    pub to_ts: i64,
    pub candle_count: usize,
}

// `Connection` wraps a `RefCell`, so it is `Send` but not `Sync` -- holding
// one here makes `CandleStore` lose the `Sync` (and therefore `Arc`'s `Send`)
// it had when this struct was just a `PathBuf`. That's accepted, not
// overlooked: every construction site in this workspace (sidecar's
// single-threaded stdin loop, the one-shot ingest/replay CLIs, tests) owns
// one `CandleStore` on one thread for its whole lifetime -- nothing shares
// it via `Arc`. Reaching for a `Mutex<Connection>` to preserve `Sync` no
// caller needs would reintroduce the lock-contention cost this struct exists
// to remove. See docs/superpowers/specs/2026-09-13-candlestore-connection-reuse-design.md
// CSR§7 for the full reasoning.
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

    /// Restrict a partition-key component (symbol/timeframe) to a safe character
    /// set so it can never break out of the derived filename: every character
    /// that is not ASCII alphanumeric is replaced with `_`. This guarantees the
    /// output contains no quote characters (can't break the surrounding SQL
    /// string literal in `write_candles`/`read_candles`), no path separators
    /// (`/`, `\`), and no `.` at all, so `..` traversal is impossible.
    fn sanitize_component(input: &str) -> String {
        input
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect()
    }

    /// Escape single quotes for safe embedding in a DuckDB SQL string literal.
    /// `sanitize_component` cleans the symbol/timeframe filename parts, but the
    /// lake `root` is the user's own filesystem path and may legitimately
    /// contain a `'` (e.g. `/Users/o'brien/lake`), which would otherwise break
    /// the `COPY`/`read_parquet` statements. DuckDB takes the path as a SQL
    /// literal, not a bindable parameter, so escaping is the correct mechanism.
    fn escape_sql_literal(input: &str) -> String {
        input.replace('\'', "''")
    }

    fn partition_path(&self, symbol: &str, timeframe: &str) -> PathBuf {
        let safe_symbol = Self::sanitize_component(symbol);
        let safe_timeframe = Self::sanitize_component(timeframe);
        self.root.join(format!("{safe_symbol}_{safe_timeframe}.parquet"))
    }

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

    pub fn write_candles(&self, symbol: &str, timeframe: &str, candles: &[Candle]) -> Result<()> {
        self.write_partition(&self.partition_path(symbol, timeframe), candles)
    }

    pub fn read_candles(&self, symbol: &str, timeframe: &str) -> Result<Vec<Candle>> {
        self.read_partition(&self.partition_path(symbol, timeframe))
    }

    fn sourced_partition_path(&self, symbol: &str, timeframe: &str, source: &str) -> PathBuf {
        let s = Self::sanitize_component(symbol);
        let t = Self::sanitize_component(timeframe);
        let src = Self::sanitize_component(source);
        self.root.join(format!("{s}_{t}_{src}.parquet"))
    }

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

    pub fn read_sourced_candles(&self, symbol: &str, timeframe: &str, source: &str) -> Result<Vec<Candle>> {
        self.read_partition(&self.sourced_partition_path(symbol, timeframe, source))
    }

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
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// A symbol containing a single quote (SQL string-literal breakout) and a
    /// path-traversal sequence (directory escape) must produce a partition
    /// filename that stays a single component directly under `root`, with no
    /// quote characters, no path separators, and no `..` sequence.
    #[test]
    fn write_partition_replaces_prior_contents_fully() {
        let dir = tempdir().unwrap();
        let store = CandleStore::open(dir.path()).unwrap();

        let first = vec![Candle { ts: 1, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1 }];
        store.write_candles("NSE:INFY", "day", &first).unwrap();

        let second = vec![Candle { ts: 2, open: 2.0, high: 2.0, low: 2.0, close: 2.0, volume: 2 }];
        store.write_candles("NSE:INFY", "day", &second).unwrap();

        let read_back = store.read_candles("NSE:INFY", "day").unwrap();
        assert_eq!(read_back, second, "second write must fully replace the first, not merge/append");

        let path = store.partition_path("NSE:INFY", "day");
        let tmp_path = PathBuf::from(format!("{}.tmp", path.to_string_lossy()));
        assert!(!tmp_path.exists(), "temp file must be cleaned up (renamed away) after a successful write");
    }

    #[test]
    fn a_write_failure_at_the_tmp_stage_never_touches_the_real_partition() {
        let dir = tempdir().unwrap();
        let store = CandleStore::open(dir.path()).unwrap();

        let original = vec![Candle { ts: 1, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1 }];
        store.write_candles("NSE:INFY", "day", &original).unwrap();

        // Occupy the sibling temp path with a directory so the COPY-to-temp step
        // fails before the atomic rename ever runs. This proves write_partition
        // targets `{path}.tmp` first rather than writing `path` in place: a
        // pre-rename write path lets a crash mid-COPY corrupt only a throwaway
        // temp file, never the previously-committed partition.
        let path = store.partition_path("NSE:INFY", "day");
        let tmp_path = PathBuf::from(format!("{}.tmp", path.to_string_lossy()));
        std::fs::create_dir(&tmp_path).unwrap();

        let result = store.write_candles(
            "NSE:INFY",
            "day",
            &[Candle { ts: 2, open: 2.0, high: 2.0, low: 2.0, close: 2.0, volume: 2 }],
        );

        assert!(result.is_err(), "a blocked temp-file stage must surface as an error, not silently succeed");
        let read_back = store.read_candles("NSE:INFY", "day").unwrap();
        assert_eq!(read_back, original, "a failed write must never disturb the previously-committed partition");
    }

    #[test]
    fn a_failed_write_never_leaks_its_rows_into_the_next_successful_write() {
        let dir = tempdir().unwrap();
        let store = CandleStore::open(dir.path()).unwrap();

        let original = vec![Candle { ts: 1, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1 }];
        store.write_candles("NSE:INFY", "day", &original).unwrap();

        // Same failure trick as the test above: block the tmp-file stage so the
        // in-memory `candles` table is populated with this call's row but the
        // COPY step never completes. The shared connection now holds a stale
        // `candles` table after returning Err -- the next write must not leak
        // it (CREATE OR REPLACE TABLE must fully replace, not merge with, that
        // stale state).
        let path = store.partition_path("NSE:INFY", "day");
        let tmp_path = PathBuf::from(format!("{}.tmp", path.to_string_lossy()));
        std::fs::create_dir(&tmp_path).unwrap();
        let failed = store.write_candles(
            "NSE:INFY",
            "day",
            &[Candle { ts: 2, open: 2.0, high: 2.0, low: 2.0, close: 2.0, volume: 2 }],
        );
        assert!(failed.is_err());
        std::fs::remove_dir(&tmp_path).unwrap();

        let next = vec![Candle { ts: 3, open: 3.0, high: 3.0, low: 3.0, close: 3.0, volume: 3 }];
        store.write_candles("NSE:INFY", "day", &next).unwrap();

        let read_back = store.read_candles("NSE:INFY", "day").unwrap();
        assert_eq!(read_back, next, "a successful write after a failed one must contain only its own rows, none leaked from the failed attempt");
    }

    #[test]
    fn partition_path_sanitizes_quotes_and_traversal_sequences() {
        let dir = tempdir().unwrap();
        let store = CandleStore::open(dir.path()).unwrap();

        let hostile_symbol = "../../etc/NSE:INFY'; DROP TABLE candles; --";
        let path = store.partition_path(hostile_symbol, "minute");

        // Stays a direct child of root: no traversal out of the lake directory.
        assert_eq!(path.parent(), Some(store.root.as_path()));

        let filename = path.file_name().unwrap().to_str().unwrap();
        assert!(!filename.contains('\''), "filename must not contain a quote: {filename}");
        assert!(!filename.contains('"'), "filename must not contain a quote: {filename}");
        assert!(!filename.contains('/'), "filename must not contain a path separator: {filename}");
        assert!(!filename.contains('\\'), "filename must not contain a path separator: {filename}");
        assert!(!filename.contains(".."), "filename must not contain a traversal sequence: {filename}");
    }

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
}
