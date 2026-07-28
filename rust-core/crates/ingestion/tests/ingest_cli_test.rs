use std::process::Command;
use storage::CandleStore;
use tempfile::tempdir;

const MINUTE: &[u8] = include_bytes!("fixtures/kaggle_banknifty_minute_sample.csv");

#[test]
fn intraday_mode_imports_csv_files_from_a_dir_into_the_lake_with_no_network() {
    let lake = tempdir().unwrap();
    let src = tempdir().unwrap();
    // The community-archive layout is one CSV per symbol; the CLI derives the
    // symbol from the filename stem, so a colon in the stem must survive.
    std::fs::write(src.path().join("NSE:BANKNIFTY.csv"), MINUTE).unwrap();

    let status = Command::new(env!("CARGO_BIN_EXE_ingest"))
        .args([
            "--lake",
            lake.path().to_str().unwrap(),
            "--mode",
            "intraday",
            "--source",
            "kaggle",
            "--dir",
            src.path().to_str().unwrap(),
        ])
        .status()
        .expect("ingest binary must start");
    assert!(status.success(), "ingest --mode intraday must exit 0");

    let store = CandleStore::open(lake.path()).unwrap();
    let bars = store.read_sourced_candles("NSE:BANKNIFTY", "minute", "kaggle").unwrap();
    assert_eq!(bars.len(), 3, "the three fixture minute bars must land under source=kaggle");
    // The write path also appended a manifest identity (Task 2 consumes it).
    assert!(lake.path().join("lake_manifest.jsonl").exists());
}

#[test]
fn missing_required_flag_exits_non_zero() {
    let status = Command::new(env!("CARGO_BIN_EXE_ingest"))
        .args(["--mode", "intraday"])
        .status()
        .expect("ingest binary must start");
    assert!(!status.success(), "a missing --lake must fail loudly, not default silently");
}
