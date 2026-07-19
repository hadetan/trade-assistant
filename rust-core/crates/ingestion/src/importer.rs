use crate::bhavcopy::parse_udiff_equity_bhavcopy;
use crate::error::IngestionError;
use crate::intraday::parse_intraday_ohlcv;
use std::collections::HashMap;
use storage::{Candle, CandleStore};

/// Parse each daily bhavcopy file, group candles by symbol across the batch, and
/// write each symbol's series into the lake tagged `source = "bhavcopy"`. The
/// store's append-merge (Task 4) accumulates across batches/days idempotently.
pub fn import_bhavcopy_files(store: &CandleStore, exchange: &str, files: &[Vec<u8>]) -> Result<usize, IngestionError> {
    let mut by_symbol: HashMap<String, Vec<Candle>> = HashMap::new();
    for bytes in files {
        for parsed in parse_udiff_equity_bhavcopy(bytes, exchange)? {
            by_symbol.entry(parsed.symbol).or_default().push(parsed.candle);
        }
    }
    let mut count = 0;
    for (symbol, candles) in &by_symbol {
        store.write_sourced_candles(symbol, "day", "bhavcopy", candles)?;
        count += candles.len();
    }
    Ok(count)
}

/// `files` is `(symbol, csv_bytes)` — community intraday archives are per-symbol.
/// `source` is "kaggle" or "github_archive".
pub fn import_intraday_files(
    store: &CandleStore,
    source: &str,
    files: &[(String, Vec<u8>)],
) -> Result<usize, IngestionError> {
    let mut count = 0;
    for (symbol, bytes) in files {
        let candles: Vec<Candle> = parse_intraday_ohlcv(bytes, symbol)?.into_iter().map(|p| p.candle).collect();
        let n = candles.len();
        store.write_sourced_candles(symbol, "minute", source, &candles)?;
        count += n;
    }
    Ok(count)
}
