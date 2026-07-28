use crate::error::{Result, StorageError};
use crate::lake_manifest::{self, LakePartitionKey};
use duckdb::{params, Connection};
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

pub struct CandleStore {
    root: PathBuf,
}

impl CandleStore {
    pub fn open(root: &Path) -> Result<Self> {
        std::fs::create_dir_all(root).map_err(StorageError::Io)?;
        Ok(Self { root: root.to_path_buf() })
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

    pub fn read_sourced_candles(&self, symbol: &str, timeframe: &str, source: &str) -> Result<Vec<Candle>> {
        self.read_partition(&self.sourced_partition_path(symbol, timeframe, source))
    }

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
}
