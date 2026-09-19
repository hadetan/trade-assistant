use chrono::NaiveDate;
use ingestion::backfill::{fetch_trading_day, DayFetcher, TradingDay};
use ingestion::importer::{import_bhavcopy_files, import_intraday_files};
use ingestion::io::fetch_udiff_bhavcopy;
use std::collections::HashMap;
use std::error::Error;
use std::ffi::OsStr;
use std::path::PathBuf;
use storage::CandleStore;

const USAGE: &str = "usage: ingest --lake <dir> --mode bhavcopy --exchange <NSE|BSE> --from <YYYY-MM-DD> --to <YYYY-MM-DD>\n       ingest --lake <dir> --mode intraday --source <kaggle|github_archive> --dir <dir>";

fn arg(map: &HashMap<String, String>, key: &str) -> Result<String, Box<dyn Error>> {
    map.get(key).cloned().ok_or_else(|| format!("missing required --{key}\n{USAGE}").into())
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

fn parse_date(s: &str) -> Result<NaiveDate, Box<dyn Error>> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|e| format!("bad date '{s}': {e}").into())
}

fn ingest_day_range(
    store: &CandleStore,
    exchange: &str,
    from: NaiveDate,
    to: NaiveDate,
    fetch: DayFetcher<'_>,
) -> Result<usize, Box<dyn Error>> {
    let mut date = from;
    let mut total = 0usize;
    loop {
        let day = fetch_trading_day(exchange, date, fetch)
            .map_err(|e| format!("fetch failed for {date} {exchange}: {e}"))?;
        if let TradingDay::Traded(bytes) = day {
            let n = import_bhavcopy_files(store, exchange, &[bytes])
                .map_err(|e| format!("import failed for {date} {exchange}: {e}"))?;
            eprintln!("ingested {n} candles for {date} {exchange}");
            total += n;
        }
        if date == to {
            break;
        }
        date = date.succ_opt().ok_or("date overflow")?;
    }
    Ok(total)
}

fn run_bhavcopy(store: &CandleStore, args: &HashMap<String, String>) -> Result<(), Box<dyn Error>> {
    let exchange = arg(args, "exchange")?;
    let from = parse_date(&arg(args, "from")?)?;
    let to = parse_date(&arg(args, "to")?)?;
    if to < from {
        return Err(format!("--to {to} is before --from {from}").into());
    }
    let mut fetch = |exchange: &str, date: NaiveDate| fetch_udiff_bhavcopy(date, exchange);
    let total = ingest_day_range(store, &exchange, from, to, &mut fetch)?;
    eprintln!("done: {total} candles across [{from}, {to}] {exchange}");
    Ok(())
}

fn run_intraday(store: &CandleStore, args: &HashMap<String, String>) -> Result<(), Box<dyn Error>> {
    let source = arg(args, "source")?;
    let dir = arg(args, "dir")?;
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("cannot read --dir '{dir}': {e}"))? {
        let path = entry?.path();
        if path.is_file() && path.extension() == Some(OsStr::new("csv")) {
            let symbol = path
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or_else(|| format!("cannot derive a symbol from filename '{}'", path.display()))?
                .to_string();
            let bytes = std::fs::read(&path).map_err(|e| format!("cannot read '{}': {e}", path.display()))?;
            files.push((symbol, bytes));
        }
    }
    let n = import_intraday_files(store, &source, &files).map_err(|e| format!("intraday import failed: {e}"))?;
    eprintln!("ingested {n} candles from {dir} (source={source})");
    Ok(())
}

fn run() -> Result<(), Box<dyn Error>> {
    let args = parse_args()?;
    let lake = PathBuf::from(arg(&args, "lake")?);
    let store = CandleStore::open(&lake).map_err(|e| format!("cannot open --lake '{}': {e}", lake.display()))?;
    match arg(&args, "mode")?.as_str() {
        "bhavcopy" => run_bhavcopy(&store, &args),
        "intraday" => run_intraday(&store, &args),
        other => Err(format!("unrecognized --mode '{other}' (valid: bhavcopy, intraday)\n{USAGE}").into()),
    }
}

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{ingest_day_range, parse_date};
    use chrono::NaiveDate;
    use ingestion::error::IngestionError;
    use storage::CandleStore;
    use tempfile::tempdir;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).expect("test dates are valid")
    }

    // Per-date TradDt: the shared fixture's is hardcoded, and write_sourced_candles
    // merges on ts, so a fixed date would collapse every day into one candle.
    fn bhavcopy_csv(day: NaiveDate, symbols: &[&str]) -> Vec<u8> {
        let mut out = String::from(
            "TradDt,FinInstrmTp,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd\n",
        );
        for symbol in symbols {
            out.push_str(&format!("{day},STK,{symbol},EQ,10.0,11.0,9.0,10.5,10.5,10.0,1000,10500.0,7\n"));
        }
        out.into_bytes()
    }

    #[test]
    fn parse_date_accepts_iso_and_rejects_garbage() {
        assert_eq!(parse_date("2024-01-15").unwrap(), chrono::NaiveDate::from_ymd_opt(2024, 1, 15).unwrap());
        assert!(parse_date("15/01/2024").is_err());
        assert!(parse_date("not-a-date").is_err());
    }

    #[test]
    fn a_weekday_holiday_404_is_skipped_instead_of_aborting_the_whole_range() {
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            if d == date(2024, 1, 12) {
                Err(IngestionError::NotFound)
            } else {
                Ok(bhavcopy_csv(d, &["INFY", "TCS"]))
            }
        };

        let total =
            ingest_day_range(&store, "NSE", date(2024, 1, 11), date(2024, 1, 15), &mut fetch).unwrap();

        // Thu 11 imported, Fri 12 a holiday, Sat 13 / Sun 14 never attempted, Mon 15 imported.
        assert_eq!(attempts, vec![date(2024, 1, 11), date(2024, 1, 12), date(2024, 1, 15)]);
        assert_eq!(total, 4, "two EQ rows on each of the two traded days");
        assert_eq!(store.read_sourced_candles("NSE:INFY", "day", "bhavcopy").unwrap().len(), 2);
    }

    #[test]
    fn weekends_are_skipped_with_no_network_attempt_at_all() {
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let mut attempts: Vec<NaiveDate> = Vec::new();
        let mut fetch = |_e: &str, d: NaiveDate| {
            attempts.push(d);
            Ok(bhavcopy_csv(d, &["INFY"]))
        };

        let total = ingest_day_range(&store, "NSE", date(2024, 1, 13), date(2024, 1, 14), &mut fetch).unwrap();

        assert!(attempts.is_empty());
        assert_eq!(total, 0);
    }

    #[test]
    fn a_non_404_fetch_error_still_aborts_the_range_but_keeps_the_days_already_written() {
        let lake = tempdir().unwrap();
        let store = CandleStore::open(lake.path()).unwrap();
        let mut fetch = |_e: &str, d: NaiveDate| {
            if d == date(2024, 1, 12) {
                Err(IngestionError::Fetch("network down".to_string()))
            } else {
                Ok(bhavcopy_csv(d, &["INFY"]))
            }
        };

        let error = ingest_day_range(&store, "NSE", date(2024, 1, 11), date(2024, 1, 15), &mut fetch)
            .expect_err("a non-404 must still abort the run");
        assert!(error.to_string().contains("network down"), "got {error}");
        // The run is rerunnable for the failing date: Thursday's write survived.
        assert_eq!(store.read_sourced_candles("NSE:INFY", "day", "bhavcopy").unwrap().len(), 1);
    }
}
