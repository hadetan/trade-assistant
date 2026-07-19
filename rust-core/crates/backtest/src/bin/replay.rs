use algo_core::{registry, Timeframe};
use backtest::engine::run_replay;
use ingestion::importer::import_bhavcopy_files;
use std::collections::HashMap;
use std::error::Error;
use std::ffi::OsStr;
use std::path::PathBuf;
use storage::CandleStore;

const USAGE: &str = "usage: replay --lake <dir> --symbol <sym> --timeframe <day|minute|5minute|15minute> \
--source <src> --horizon <n> [--ingest-dir <dir>]";

fn arg(map: &HashMap<String, String>, key: &str) -> Result<String, Box<dyn Error>> {
    map.get(key)
        .cloned()
        .ok_or_else(|| format!("missing required --{key}\n{USAGE}").into())
}

fn parse_args() -> Result<HashMap<String, String>, Box<dyn Error>> {
    let mut map = HashMap::new();
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        if let Some(key) = flag.strip_prefix("--") {
            let value = args.next().ok_or_else(|| format!("--{key} needs a value\n{USAGE}"))?;
            map.insert(key.to_string(), value);
        }
    }
    Ok(map)
}

fn parse_timeframe(s: &str) -> Result<Timeframe, Box<dyn Error>> {
    match s {
        "minute" => Ok(Timeframe::Minute),
        "5minute" => Ok(Timeframe::FiveMinute),
        "15minute" => Ok(Timeframe::FifteenMinute),
        "day" => Ok(Timeframe::Day),
        other => {
            Err(format!("unrecognized --timeframe '{other}' (valid: day, minute, 5minute, 15minute)").into())
        }
    }
}

fn parse_symbol(s: &str) -> Result<(&str, &str), Box<dyn Error>> {
    match s.split_once(':') {
        Some((exchange, ticker)) if !exchange.is_empty() && !ticker.is_empty() => Ok((exchange, ticker)),
        _ => Err(format!("--symbol must be EXCHANGE:TICKER (e.g. NSE:INFY), got '{s}'").into()),
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let args = parse_args()?;
    let lake = PathBuf::from(arg(&args, "lake")?);
    let symbol = arg(&args, "symbol")?;
    let timeframe_str = arg(&args, "timeframe")?;
    let source = arg(&args, "source")?;
    let horizon: usize =
        arg(&args, "horizon")?.parse().map_err(|e| format!("--horizon must be an integer: {e}"))?;

    // Validate up front so a typo'd --timeframe fails loudly instead of
    // silently defaulting while `read_sourced_candles` reads the raw string.
    let timeframe = parse_timeframe(&timeframe_str)?;
    // A malformed --symbol (missing exchange or ticker) would otherwise be
    // ingested under an invalid exchange prefix; reject it here.
    let (exchange, _ticker) = parse_symbol(&symbol)?;

    let store = CandleStore::open(&lake).map_err(|e| format!("cannot open --lake '{}': {e}", lake.display()))?;

    if let Some(ingest_dir) = args.get("ingest-dir") {
        let mut files = Vec::new();
        let entries = std::fs::read_dir(ingest_dir)
            .map_err(|e| format!("cannot read --ingest-dir '{ingest_dir}': {e}"))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("cannot read entry in --ingest-dir '{ingest_dir}': {e}"))?;
            let path = entry.path();
            if path.is_file() && path.extension() == Some(OsStr::new("csv")) {
                let bytes = std::fs::read(&path)
                    .map_err(|e| format!("cannot read bhavcopy file '{}': {e}", path.display()))?;
                files.push(bytes);
            }
        }
        let n = import_bhavcopy_files(&store, exchange, &files)
            .map_err(|e| format!("failed to import bhavcopy files from '{ingest_dir}': {e}"))?;
        eprintln!("ingested {n} candles from {ingest_dir}");
    }

    let series = store.read_sourced_candles(&symbol, &timeframe_str, &source)?;
    if series.is_empty() {
        eprintln!("no candles for {symbol} {timeframe_str} source={source}");
        return Ok(());
    }

    let algos = registry::all();
    let report = run_replay(&series, &algos, horizon, &symbol, timeframe);

    for stat in &report.per_algo {
        println!("{}\t{:.4}\t{:.6}\t{}", stat.algo_id, stat.hit_rate(), stat.expectancy(), stat.directional_calls);
    }
    if report.per_algo.is_empty() {
        eprintln!("no directional calls (insufficient history for any algorithm)");
    }
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::parse_symbol;

    #[test]
    fn accepts_exchange_and_ticker() {
        assert_eq!(parse_symbol("NSE:INFY").unwrap(), ("NSE", "INFY"));
    }

    #[test]
    fn rejects_symbols_missing_exchange_or_ticker() {
        for bad in ["INFY", ":INFY", "NSE:", ":", ""] {
            assert!(parse_symbol(bad).is_err(), "{bad:?} should be rejected");
        }
    }
}
