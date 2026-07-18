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
    pub fn open(root: &Path) -> duckdb::Result<Self> {
        std::fs::create_dir_all(root).expect("candle lake root must be creatable");
        Ok(Self { root: root.to_path_buf() })
    }

    fn partition_path(&self, symbol: &str, timeframe: &str) -> PathBuf {
        let safe_symbol = symbol.replace(':', "_");
        self.root.join(format!("{safe_symbol}_{timeframe}.parquet"))
    }

    pub fn write_candles(
        &self,
        symbol: &str,
        timeframe: &str,
        candles: &[Candle],
    ) -> duckdb::Result<()> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            "CREATE TABLE candles (ts BIGINT, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume BIGINT)",
        )?;

        let mut appender = conn.appender("candles")?;
        for candle in candles {
            appender.append_row(params![
                candle.ts,
                candle.open,
                candle.high,
                candle.low,
                candle.close,
                candle.volume
            ])?;
        }
        appender.flush()?;

        let path = self.partition_path(symbol, timeframe);
        let path_str = path.to_string_lossy();
        conn.execute(
            &format!("COPY candles TO '{path_str}' (FORMAT PARQUET)"),
            [],
        )?;

        Ok(())
    }

    pub fn read_candles(&self, symbol: &str, timeframe: &str) -> duckdb::Result<Vec<Candle>> {
        let path = self.partition_path(symbol, timeframe);
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

        rows.collect()
    }
}
