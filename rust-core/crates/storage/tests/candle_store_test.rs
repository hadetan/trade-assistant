use storage::{Candle, CandleStore, LakeSymbolEntry};
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

#[test]
fn write_and_read_survive_a_lake_root_path_containing_a_single_quote() {
    // The lake root is the user's own filesystem path, not a sanitized
    // component -- a legitimate path like /Users/o'brien/lake must not break
    // the DuckDB COPY/read_parquet SQL string literals.
    let dir = tempdir().unwrap();
    let quoted_root = dir.path().join("o'brien");
    let store = CandleStore::open(&quoted_root).unwrap();

    let candles = vec![
        Candle { ts: 1_700_000_000, open: 10.0, high: 11.0, low: 9.5, close: 10.5, volume: 42 },
    ];

    store.write_candles("NSE:INFY", "minute", &candles).unwrap();
    let read_back = store.read_candles("NSE:INFY", "minute").unwrap();

    assert_eq!(read_back, candles);
}

#[test]
fn read_candles_on_never_written_partition_returns_empty_vec() {
    // design §5.1: a from/to window with no data is "empty, not error".
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();

    let got = store.read_candles("NSE:NEVERWRITTEN", "day").unwrap();

    assert!(got.is_empty());
}

#[test]
fn open_on_uncreatable_root_returns_err_not_panic() {
    // create_dir_all fails when an ancestor of the requested root is a file.
    let dir = tempdir().unwrap();
    let file_path = dir.path().join("iamafile");
    std::fs::write(&file_path, b"x").unwrap();
    let bogus_root = file_path.join("subdir");

    let result = CandleStore::open(&bogus_root);

    assert!(result.is_err());
}

#[test]
fn write_sourced_candles_appends_merges_dedups_and_sorts() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();

    store
        .write_sourced_candles("NSE:INFY", "day", "bhavcopy", &[
            Candle { ts: 100, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 10 },
            Candle { ts: 200, open: 2.0, high: 2.0, low: 2.0, close: 2.0, volume: 20 },
        ])
        .unwrap();
    // Second batch overlaps ts=200 (new value wins) and adds ts=300; ts arrives
    // out of order to prove the merge sorts.
    store
        .write_sourced_candles("NSE:INFY", "day", "bhavcopy", &[
            Candle { ts: 300, open: 3.0, high: 3.0, low: 3.0, close: 3.0, volume: 30 },
            Candle { ts: 200, open: 2.5, high: 2.5, low: 2.5, close: 2.5, volume: 25 },
        ])
        .unwrap();

    let got = store.read_sourced_candles("NSE:INFY", "day", "bhavcopy").unwrap();

    assert_eq!(got.len(), 3);
    assert_eq!(got.iter().map(|c| c.ts).collect::<Vec<_>>(), vec![100, 200, 300]);
    assert_eq!(got[1].close, 2.5, "incoming candle must win on duplicate ts");
}

#[test]
fn read_sourced_candles_on_missing_source_is_empty() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();
    assert!(store.read_sourced_candles("NSE:INFY", "day", "kaggle").unwrap().is_empty());
}

#[test]
fn sources_are_partitioned_separately_for_the_same_symbol() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();
    store.write_sourced_candles("NSE:INFY", "day", "bhavcopy",
        &[Candle { ts: 100, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 10 }]).unwrap();
    store.write_sourced_candles("NSE:INFY", "day", "kaggle",
        &[Candle { ts: 100, open: 9.0, high: 9.0, low: 9.0, close: 9.0, volume: 90 }]).unwrap();

    assert_eq!(store.read_sourced_candles("NSE:INFY", "day", "bhavcopy").unwrap()[0].close, 1.0);
    assert_eq!(store.read_sourced_candles("NSE:INFY", "day", "kaggle").unwrap()[0].close, 9.0);
}

#[test]
fn list_symbols_on_an_empty_lake_returns_empty() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();
    assert_eq!(store.list_symbols().unwrap(), Vec::<LakeSymbolEntry>::new());
}

#[test]
fn list_symbols_groups_multi_source_multi_symbol_correctly() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();
    let c = |ts: i64| Candle { ts, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1 };

    store.write_sourced_candles("NSE:INFY", "day", "bhavcopy", &[c(100)]).unwrap();
    store.write_sourced_candles("NSE:TCS", "day", "bhavcopy", &[c(100)]).unwrap();
    store.write_sourced_candles("NSE:INFY", "minute", "kaggle", &[c(100)]).unwrap();

    let entries = store.list_symbols().unwrap();
    // Sorted by (symbol, timeframe, source); the "NSE:INFY" colon survives the
    // round trip, proving the manifest -- not the lossy filename -- drives identity.
    assert_eq!(entries.len(), 3);
    assert_eq!((entries[0].symbol.as_str(), entries[0].timeframe.as_str(), entries[0].source.as_str()), ("NSE:INFY", "day", "bhavcopy"));
    assert_eq!((entries[1].symbol.as_str(), entries[1].timeframe.as_str(), entries[1].source.as_str()), ("NSE:INFY", "minute", "kaggle"));
    assert_eq!((entries[2].symbol.as_str(), entries[2].timeframe.as_str(), entries[2].source.as_str()), ("NSE:TCS", "day", "bhavcopy"));
}

#[test]
fn list_symbols_reports_correct_ts_bounds_and_count() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();
    let c = |ts: i64| Candle { ts, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1 };
    store.write_sourced_candles("NSE:INFY", "day", "bhavcopy", &[c(100), c(200), c(300)]).unwrap();

    let entries = store.list_symbols().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].from_ts, 100);
    assert_eq!(entries[0].to_ts, 300);
    assert_eq!(entries[0].candle_count, 3);
}

#[test]
fn re_ingesting_the_same_partition_does_not_duplicate_its_manifest_entry() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();
    let c = |ts: i64| Candle { ts, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1 };

    store.write_sourced_candles("NSE:INFY", "day", "bhavcopy", &[c(100), c(200)]).unwrap();
    store.write_sourced_candles("NSE:INFY", "day", "bhavcopy", &[c(300)]).unwrap();

    let entries = store.list_symbols().unwrap();
    assert_eq!(entries.len(), 1, "re-ingesting the same partition appends its identity exactly once");
    assert_eq!(entries[0].candle_count, 3, "count reflects the merged total");
}
