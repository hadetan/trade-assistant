use algo_core::{registry, Timeframe};
use backtest::engine::run_replay;
use ingestion::importer::import_bhavcopy_files;
use std::collections::HashMap;
use std::path::PathBuf;
use storage::CandleStore;

fn arg(map: &HashMap<String, String>, key: &str) -> String {
    map.get(key).unwrap_or_else(|| panic!("missing required --{key}")).clone()
}

fn parse_args() -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        if let Some(key) = flag.strip_prefix("--") {
            let value = args.next().unwrap_or_else(|| panic!("--{key} needs a value"));
            map.insert(key.to_string(), value);
        }
    }
    map
}

fn main() {
    let args = parse_args();
    let lake = PathBuf::from(arg(&args, "lake"));
    let symbol = arg(&args, "symbol");
    let timeframe_str = arg(&args, "timeframe");
    let source = arg(&args, "source");
    let horizon: usize = arg(&args, "horizon").parse().expect("--horizon must be an integer");

    let store = CandleStore::open(&lake).expect("open candle lake");

    if let Some(ingest_dir) = args.get("ingest-dir") {
        let mut files = Vec::new();
        for entry in std::fs::read_dir(ingest_dir).expect("read ingest dir") {
            let path = entry.expect("dir entry").path();
            if path.is_file() {
                files.push(std::fs::read(&path).expect("read bhavcopy file"));
            }
        }
        let n = import_bhavcopy_files(&store, "NSE", &files).expect("import bhavcopy");
        eprintln!("ingested {n} candles from {ingest_dir}");
    }

    let timeframe = match timeframe_str.as_str() {
        "minute" => Timeframe::Minute,
        "5minute" => Timeframe::FiveMinute,
        "15minute" => Timeframe::FifteenMinute,
        _ => Timeframe::Day,
    };

    let series = store
        .read_sourced_candles(&symbol, &timeframe_str, &source)
        .expect("read candles");
    if series.is_empty() {
        eprintln!("no candles for {symbol} {timeframe_str} source={source}");
        return;
    }

    let algos = registry::all();
    let report = run_replay(&series, &algos, horizon, &symbol, timeframe);

    for stat in &report.per_algo {
        println!(
            "{}\t{:.4}\t{:.6}\t{}",
            stat.algo_id,
            stat.hit_rate(),
            stat.expectancy(),
            stat.directional_calls
        );
    }
    if report.per_algo.is_empty() {
        eprintln!("no directional calls (insufficient history for any algorithm)");
    }
}
