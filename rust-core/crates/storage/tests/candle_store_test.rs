use storage::{Candle, CandleStore};
use tempfile::tempdir;

#[test]
fn candles_round_trip_through_parquet_via_duckdb() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();

    let candles = vec![
        Candle { ts: 1_700_000_000, open: 100.0, high: 101.0, low: 99.5, close: 100.5, volume: 1000 },
        Candle { ts: 1_700_000_060, open: 100.5, high: 102.0, low: 100.0, close: 101.5, volume: 1200 },
    ];

    store.write_candles("NSE:INFY", "minute", &candles).unwrap();
    let read_back = store.read_candles("NSE:INFY", "minute").unwrap();

    assert_eq!(read_back.len(), 2);
    assert_eq!(read_back[0].close, 100.5);
    assert_eq!(read_back[1].close, 101.5);
}
