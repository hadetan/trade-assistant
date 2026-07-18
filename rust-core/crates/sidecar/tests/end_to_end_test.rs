use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

#[test]
fn compiled_binary_computes_algorithms_over_stdin_stdout() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_sidecar"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("sidecar binary must start");

    let request = r#"{"id":1,"symbol":"NSE:INFY","timeframe":"day","closes":[100.0,101.0,102.0,103.0,104.0,105.0,106.0,107.0,108.0,109.0,110.0,111.0,112.0,113.0,114.0,115.0,116.0,117.0,118.0,119.0,120.0]}"#;

    {
        let stdin = child.stdin.as_mut().unwrap();
        writeln!(stdin, "{request}").unwrap();
    }

    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let mut response_line = String::new();
    reader.read_line(&mut response_line).unwrap();

    child.kill().ok();
    child.wait().ok();

    let response: serde_json::Value = serde_json::from_str(response_line.trim()).unwrap();

    assert_eq!(response["id"], 1);
    let algo_results = response["algo_results"].as_array().unwrap();
    // sma, ema, rsi -- exactly the three Phase 1 algorithms
    assert_eq!(algo_results.len(), 3);
    assert!(response["confluence"]["bullish_count"].is_number());
}
