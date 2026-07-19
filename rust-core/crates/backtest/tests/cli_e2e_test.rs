use std::process::Command;
use storage::{Candle, CandleStore};
use tempfile::tempdir;

/// The bhavcopy fixture already committed for the ingestion crate's parser
/// tests. Reused here (copied byte-for-byte into a temp `--ingest-dir`) so
/// the replay CLI's importer-reuse path is exercised against the same
/// real-world sample the parser is tested against.
const COMMITTED_BHAVCOPY_FIXTURE: &[u8] =
    include_bytes!("../../ingestion/tests/fixtures/nse_bhavcopy_udiff_sample.csv");

#[test]
fn replay_binary_reads_lake_and_prints_per_algorithm_report() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();

    // 25 rising daily candles: enough history for sma(20)/ema(20)/rsi(14).
    let base = 1_700_000_000;
    let candles: Vec<Candle> = (0..25)
        .map(|i| {
            let c = 100.0 + i as f64;
            Candle { ts: base + i as i64 * 86_400, open: c, high: c, low: c, close: c, volume: 1000 }
        })
        .collect();
    store.write_sourced_candles("NSE:INFY", "day", "bhavcopy", &candles).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_replay"))
        .args([
            "--lake", dir.path().to_str().unwrap(),
            "--symbol", "NSE:INFY",
            "--timeframe", "day",
            "--source", "bhavcopy",
            "--horizon", "1",
        ])
        .output()
        .expect("replay binary must run");

    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("sma"), "report missing sma: {stdout}");
    assert!(stdout.contains("ema"), "report missing ema: {stdout}");
    assert!(stdout.contains("rsi"), "report missing rsi: {stdout}");
}

/// Exercises `--ingest-dir` end-to-end: a directory of bhavcopy CSVs is
/// imported into a fresh lake via `import_bhavcopy_files`, then replayed —
/// as opposed to the test above, which seeds the `CandleStore` directly and
/// never touches the importer-reuse path this CLI adds.
#[test]
fn replay_binary_imports_bhavcopy_dir_via_ingest_dir_and_prints_report() {
    let ingest_dir = tempdir().unwrap();
    let lake_dir = tempdir().unwrap();

    // File 1: the real, committed bhavcopy fixture (proves an arbitrary
    // pre-existing bhavcopy file dropped in the ingest dir is picked up).
    std::fs::write(ingest_dir.path().join("nse_bhavcopy_sample.csv"), COMMITTED_BHAVCOPY_FIXTURE).unwrap();

    // File 2: a second, synthetic bhavcopy file supplying 25 rising trading
    // days for INFY (disjoint dates from the fixture above) so there is
    // enough history for sma(20)/ema(20)/rsi(14) to produce directional
    // calls once imported. Same UDiFF column layout as the committed fixture.
    let header = "TradDt,FinInstrmTp,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,\
TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd";
    let mut synthetic = String::from(header);
    synthetic.push('\n');
    for day in 1..=25u32 {
        let c = 100.0 + day as f64;
        synthetic.push_str(&format!(
            "2024-02-{day:02},STK,INFY,EQ,{c:.2},{c:.2},{c:.2},{c:.2},{c:.2},{c:.2},1000,100000.00,10\n"
        ));
    }
    std::fs::write(ingest_dir.path().join("nse_bhavcopy_synthetic_history.csv"), synthetic).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_replay"))
        .args([
            "--lake", lake_dir.path().to_str().unwrap(),
            "--ingest-dir", ingest_dir.path().to_str().unwrap(),
            "--symbol", "NSE:INFY",
            "--timeframe", "day",
            "--source", "bhavcopy",
            "--horizon", "1",
        ])
        .output()
        .expect("replay binary must run");

    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("sma"), "report missing sma: {stdout}");
    assert!(stdout.contains("ema"), "report missing ema: {stdout}");
    assert!(stdout.contains("rsi"), "report missing rsi: {stdout}");

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("ingested"), "expected an ingest confirmation on stderr: {stderr}");
}

/// Regression guard for graceful CLI error handling: a bad invocation must
/// exit non-zero with a human-readable stderr message, not a Rust panic
/// backtrace (exit code 101 / "panicked at").
#[test]
fn replay_binary_reports_errors_gracefully_instead_of_panicking() {
    // Missing all required args.
    let output = Command::new(env!("CARGO_BIN_EXE_replay")).output().expect("replay binary must run");
    assert!(!output.status.success(), "expected failure exit status for missing args");
    assert_ne!(output.status.code(), Some(101), "must not panic (exit 101)");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stderr.is_empty(), "expected a stderr message");
    assert!(!stderr.contains("panicked at"), "must not print a panic backtrace: {stderr}");

    // Nonexistent / unreadable --lake path (a regular file, so create_dir_all
    // on it fails cleanly rather than panicking).
    let dir = tempdir().unwrap();
    let bogus_lake = dir.path().join("not_a_dir");
    std::fs::write(&bogus_lake, b"not a directory").unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_replay"))
        .args([
            "--lake", bogus_lake.to_str().unwrap(),
            "--symbol", "NSE:INFY",
            "--timeframe", "day",
            "--source", "bhavcopy",
            "--horizon", "1",
        ])
        .output()
        .expect("replay binary must run");

    assert!(!output.status.success(), "expected failure exit status for unusable --lake");
    assert_ne!(output.status.code(), Some(101), "must not panic (exit 101)");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stderr.is_empty(), "expected a stderr message");
    assert!(!stderr.contains("panicked at"), "must not print a panic backtrace: {stderr}");
}

/// Fix 3 regression guard: an unrecognized `--timeframe` must error out
/// instead of silently defaulting to `Timeframe::Day`.
#[test]
fn replay_binary_rejects_unrecognized_timeframe() {
    let dir = tempdir().unwrap();
    let store = CandleStore::open(dir.path()).unwrap();
    let candles = vec![Candle { ts: 1_700_000_000, open: 100.0, high: 100.0, low: 100.0, close: 100.0, volume: 1 }];
    store.write_sourced_candles("NSE:INFY", "minutes", "bhavcopy", &candles).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_replay"))
        .args([
            "--lake", dir.path().to_str().unwrap(),
            "--symbol", "NSE:INFY",
            "--timeframe", "minutes", // typo: valid value is "minute"
            "--source", "bhavcopy",
            "--horizon", "1",
        ])
        .output()
        .expect("replay binary must run");

    assert!(!output.status.success(), "expected failure exit status for unrecognized --timeframe");
    assert_ne!(output.status.code(), Some(101), "must not panic (exit 101)");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("timeframe"), "expected an error mentioning timeframe: {stderr}");
    assert!(!stderr.contains("panicked at"), "must not print a panic backtrace: {stderr}");
}
