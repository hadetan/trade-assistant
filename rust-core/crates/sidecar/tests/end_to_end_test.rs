use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

#[test]
fn compiled_binary_computes_algorithms_over_stdin_stdout() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_sidecar"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("sidecar binary must start");

    let request = r#"{"type":"compute","id":1,"symbol":"NSE:INFY","timeframe":"day","closes":[100.0,101.0,102.0,103.0,104.0,105.0,106.0,107.0,108.0,109.0,110.0,111.0,112.0,113.0,114.0,115.0,116.0,117.0,118.0,119.0,120.0]}"#;

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
    // Every default-catalog algorithm with required_lookback <= 21 (30 of
    // the 34, incl. sma/ema/rsi); adx/garch/macd/ichimoku need more history.
    assert_eq!(algo_results.len(), 30);
    assert!(response["confluence"]["bullish_count"].is_number());
}

#[test]
fn a_thin_history_request_between_two_valid_ones_does_not_kill_the_sidecar() {
    // Regression test for the CRITICAL availability bug: a well-formed
    // ComputeRequest with fewer closes than an algorithm's
    // required_lookback() used to panic ("attempt to subtract with
    // overflow") inside sma.rs's slice arithmetic and take the whole
    // long-lived process down for the rest of the session. This feeds
    // [valid, too-few-closes, valid] in one invocation and asserts all
    // three requests get a well-formed response and the process exits
    // cleanly on its own once stdin closes -- i.e. it never crashed.
    let mut child = Command::new(env!("CARGO_BIN_EXE_sidecar"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("sidecar binary must start");

    let valid_request = r#"{"type":"compute","id":1,"symbol":"NSE:INFY","timeframe":"day","closes":[100.0,101.0,102.0,103.0,104.0,105.0,106.0,107.0,108.0,109.0,110.0,111.0,112.0,113.0,114.0,115.0,116.0,117.0,118.0,119.0,120.0]}"#;
    // Only 3 closes: shorter than rsi (15) and sma/ema (20)'s
    // required_lookback, though not every catalog algorithm -- a handful of
    // OHLCV-derived algorithms declare required_lookback <= 3.
    let too_few_closes_request =
        r#"{"type":"compute","id":2,"symbol":"NSE:NEWLISTING","timeframe":"day","closes":[100.0,101.0,102.0]}"#;
    let valid_request_2 = r#"{"type":"compute","id":3,"symbol":"NSE:INFY","timeframe":"day","closes":[100.0,101.0,102.0,103.0,104.0,105.0,106.0,107.0,108.0,109.0,110.0,111.0,112.0,113.0,114.0,115.0,116.0,117.0,118.0,119.0,120.0]}"#;

    {
        let stdin = child.stdin.as_mut().unwrap();
        writeln!(stdin, "{valid_request}").unwrap();
        writeln!(stdin, "{too_few_closes_request}").unwrap();
        writeln!(stdin, "{valid_request_2}").unwrap();
    }
    // Close stdin so the sidecar's read loop sees EOF and exits on its own
    // once it has answered all three requests, instead of blocking forever.
    drop(child.stdin.take());

    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);

    let mut responses = Vec::new();
    for _ in 0..3 {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .expect("stdout must be readable");
        assert!(
            !line.trim().is_empty(),
            "expected a response line for every request; the process may have died"
        );
        let response: serde_json::Value = serde_json::from_str(line.trim())
            .expect("each line must be a well-formed JSON response");
        responses.push(response);
    }

    let status = child
        .wait()
        .expect("sidecar process must be waitable, not killed by a crash");
    assert!(
        status.success(),
        "sidecar should exit cleanly on EOF, not crash: {status:?}"
    );

    assert_eq!(responses[0]["id"], 1);
    assert_eq!(responses[0]["algo_results"].as_array().unwrap().len(), 30);

    assert_eq!(responses[1]["id"], 2);
    // 18 of the 34 default-catalog algorithms declare required_lookback <= 3
    // and still run (well-formed response either way, not a panic). Most
    // need OHLC/volume/peer/chain context this closes-only request doesn't
    // supply and no-op to Neutral, except ou_half_life: with no peer leg it
    // falls back to single-instrument mean reversion on closes itself
    // (see ou_half_life.rs's `spread_series`), and this rising 3-bar series
    // has a z-score > 1, i.e. Bearish.
    assert_eq!(responses[1]["algo_results"].as_array().unwrap().len(), 18);
    assert_eq!(responses[1]["confluence"]["bullish_count"], 0);
    assert_eq!(responses[1]["confluence"]["bearish_count"], 1);
    let weighted_vote = responses[1]["confluence"]["weighted_vote"].as_f64().unwrap();
    assert!((weighted_vote - (-1.0 / 18.0)).abs() < 1e-9);

    assert_eq!(responses[2]["id"], 3);
    assert_eq!(responses[2]["algo_results"].as_array().unwrap().len(), 30);
}
