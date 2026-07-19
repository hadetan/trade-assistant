use crate::error::{Result, StorageError};
use duckdb::{params, Connection};
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
        let path_str = path.to_string_lossy();
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
        let path_str = path.to_string_lossy();
        conn.execute(&format!("COPY candles TO '{path_str}' (FORMAT PARQUET)"), [])?;
        Ok(())
    }

    pub fn write_candles(&self, symbol: &str, timeframe: &str, candles: &[Candle]) -> Result<()> {
        self.write_partition(&self.partition_path(symbol, timeframe), candles)
    }

    pub fn read_candles(&self, symbol: &str, timeframe: &str) -> Result<Vec<Candle>> {
        self.read_partition(&self.partition_path(symbol, timeframe))
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
