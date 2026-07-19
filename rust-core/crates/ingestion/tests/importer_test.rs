use ingestion::importer::{import_bhavcopy_files, import_intraday_files};
use storage::CandleStore;
use tempfile::tempdir;

const BHAV: &[u8] = include_bytes!("fixtures/nse_bhavcopy_udiff_sample.csv");
const MINUTE: &[u8] = include_bytes!("fixtures/kaggle_banknifty_minute_sample.csv");

#[test]
fn bhavcopy_import_lands_eq_candles_tagged_bhavcopy() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();

    let n = import_bhavcopy_files(&store, "NSE", &[BHAV.to_vec()]).unwrap();
    assert_eq!(n, 2, "INFY + TCS; BE-series row skipped");

    let infy = store.read_sourced_candles("NSE:INFY", "day", "bhavcopy").unwrap();
    assert_eq!(infy.len(), 1);
    assert_eq!(infy[0].close, 1520.75);
    assert_eq!(infy[0].ts, 1_705_312_800);
    // not written under a different source
    assert!(store.read_sourced_candles("NSE:INFY", "day", "kaggle").unwrap().is_empty());
}

#[test]
fn intraday_import_lands_minute_candles_tagged_by_source() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();

    let n = import_intraday_files(&store, "kaggle", &[("NSE:BANKNIFTY".to_string(), MINUTE.to_vec())]).unwrap();
    assert_eq!(n, 3);

    let bars = store.read_sourced_candles("NSE:BANKNIFTY", "minute", "kaggle").unwrap();
    assert_eq!(bars.len(), 3);
    assert_eq!(bars[0].ts, 1_609_472_700);
}
