use chrono::{Datelike, NaiveDate, Weekday};
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

fn run_bhavcopy(store: &CandleStore, args: &HashMap<String, String>) -> Result<(), Box<dyn Error>> {
    let exchange = arg(args, "exchange")?;
    let from = parse_date(&arg(args, "from")?)?;
    let to = parse_date(&arg(args, "to")?)?;
    if to < from {
        return Err(format!("--to {to} is before --from {from}").into());
    }
    let mut date = from;
    let mut total = 0usize;
    loop {
        // Weekends are never trading days, so a fetch would always 404 -- skip
        // them without a network attempt. A weekday-holiday 404 surfaces as a
        // hard fetch error below (P6§13): the run is rerunnable for that date.
        if !matches!(date.weekday(), Weekday::Sat | Weekday::Sun) {
            let bytes = fetch_udiff_bhavcopy(date, &exchange)
                .map_err(|e| format!("fetch failed for {date} {exchange}: {e}"))?;
            let n = import_bhavcopy_files(store, &exchange, &[bytes])
                .map_err(|e| format!("import failed for {date} {exchange}: {e}"))?;
            eprintln!("ingested {n} candles for {date} {exchange}");
            total += n;
        }
        if date == to {
            break;
        }
        date = date.succ_opt().ok_or("date overflow")?;
    }
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
    use super::parse_date;

    #[test]
    fn parse_date_accepts_iso_and_rejects_garbage() {
        assert_eq!(parse_date("2024-01-15").unwrap(), chrono::NaiveDate::from_ymd_opt(2024, 1, 15).unwrap());
        assert!(parse_date("15/01/2024").is_err());
        assert!(parse_date("not-a-date").is_err());
    }
}
