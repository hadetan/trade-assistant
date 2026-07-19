use std::process::Command;
use storage::{Candle, CandleStore};
use tempfile::tempdir;

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
