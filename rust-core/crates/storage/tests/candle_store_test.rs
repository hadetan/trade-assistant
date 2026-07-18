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

#[test]
fn read_candles_isolates_partitions_and_does_not_leak_across_symbols_or_timeframes() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();

    let infy_minute = vec![
        Candle { ts: 1_700_000_000, open: 100.0, high: 101.0, low: 99.5, close: 100.5, volume: 1000 },
        Candle { ts: 1_700_000_060, open: 100.5, high: 102.0, low: 100.0, close: 101.5, volume: 1200 },
    ];
    let infy_day = vec![
        Candle { ts: 1_700_000_000, open: 999.0, high: 999.0, low: 999.0, close: 999.0, volume: 9 },
    ];
    let tcs_minute = vec![
        Candle { ts: 1_700_000_000, open: 500.0, high: 505.0, low: 495.0, close: 501.0, volume: 300 },
        Candle { ts: 1_700_000_060, open: 501.0, high: 506.0, low: 500.0, close: 503.0, volume: 320 },
        Candle { ts: 1_700_000_120, open: 503.0, high: 507.0, low: 502.0, close: 504.0, volume: 340 },
    ];

    // Two different symbols, and the same symbol at a different timeframe --
    // three distinct partitions in total.
    store.write_candles("NSE:INFY", "minute", &infy_minute).unwrap();
    store.write_candles("NSE:INFY", "day", &infy_day).unwrap();
    store.write_candles("NSE:TCS", "minute", &tcs_minute).unwrap();

    let read_back = store.read_candles("NSE:INFY", "minute").unwrap();

    assert_eq!(read_back, infy_minute, "must get exactly the NSE:INFY/minute partition");
    assert_eq!(read_back.len(), 2, "must not pick up rows from the other two partitions");
    assert!(
        read_back.iter().all(|c| c.close != 999.0 && c.close != 501.0 && c.close != 503.0 && c.close != 504.0),
        "must not contain any rows from the NSE:INFY/day or NSE:TCS/minute partitions"
    );
}

#[test]
fn write_and_read_survive_symbol_with_quote_and_path_traversal_characters() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();

    let candles = vec![
        Candle { ts: 1_700_000_000, open: 10.0, high: 11.0, low: 9.5, close: 10.5, volume: 42 },
    ];

    // A symbol crafted to (a) break out of the SQL string literal via a quote,
    // and (b) attempt to traverse outside `root` via `../`. Sanitization must
    // neutralize both so the write/read round-trip still succeeds cleanly.
    let hostile_symbol = "../../etc/NSE:INFY'; DROP TABLE candles; --";

    store.write_candles(hostile_symbol, "minute", &candles).unwrap();
    let read_back = store.read_candles(hostile_symbol, "minute").unwrap();

    assert_eq!(read_back, candles);

    // No traversal happened: the store root contains exactly the one
    // partition file that was written, nothing escaped upward or created
    // unexpected subdirectories.
    let entries: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect::<Result<_, _>>().unwrap();
    assert_eq!(entries.len(), 1, "expected exactly one partition file directly inside root");
    assert!(entries[0].path().is_file());
}
