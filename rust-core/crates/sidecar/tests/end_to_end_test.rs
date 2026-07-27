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

#[test]
fn a_malformed_line_is_logged_to_stderr_instead_of_silently_dropped() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_sidecar"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("sidecar binary must start");

    {
        let stdin = child.stdin.as_mut().unwrap();
        writeln!(stdin, "not valid json").unwrap();
    }
    drop(child.stdin.take());

    let stderr = child.stderr.take().unwrap();
    let mut reader = BufReader::new(stderr);
    let mut stderr_line = String::new();
    reader.read_line(&mut stderr_line).unwrap();

    child.wait().ok();

    assert!(
        stderr_line.contains("failed to parse"),
        "expected a parse-error log on stderr, got: {stderr_line:?}"
    );
    assert!(stderr_line.contains("not valid json"));
}

#[test]
fn watchlist_and_scan_gate_flow_over_stdin_stdout_with_a_lake_root() {
    let dir = tempfile::tempdir().unwrap();
    let lake = dir.path().to_str().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_sidecar"))
        .arg("--lake-root")
        .arg(lake)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("sidecar binary must start");

    let add = r#"{"type":"add_watchlist_symbol","id":1,"symbol":"NSE:INFY"}"#;
    let list = r#"{"type":"list_watchlist","id":2}"#;
    let compute = r#"{"type":"compute","id":3,"symbol":"NSE:INFY","timeframe":"day","closes":[100.0,101.0,102.0,103.0,104.0,105.0,106.0,107.0,108.0,109.0,110.0,111.0,112.0,113.0,114.0,115.0,116.0,117.0,118.0,119.0,120.0]}"#;
    let gate = r#"{"type":"evaluate_scan_gate","id":4,"symbol":"NSE:INFY","confluence":{"bullish_count":8,"bearish_count":1,"neutral_count":2,"weighted_vote":0.5}}"#;

    {
        let stdin = child.stdin.as_mut().unwrap();
        writeln!(stdin, "{add}").unwrap();
        writeln!(stdin, "{list}").unwrap();
        writeln!(stdin, "{compute}").unwrap();
        writeln!(stdin, "{gate}").unwrap();
    }
    drop(child.stdin.take());

    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let mut responses = Vec::new();
    for _ in 0..4 {
        let mut line = String::new();
        reader.read_line(&mut line).expect("stdout must be readable");
        responses.push(serde_json::from_str::<serde_json::Value>(line.trim()).unwrap());
    }
    child.wait().ok();

    assert_eq!(responses[0]["type"], "watchlist");
    assert_eq!(responses[1]["symbols"][0], "NSE:INFY");
    assert_eq!(responses[2]["type"], "compute");
    assert_eq!(responses[3]["type"], "scan_gate");
    // First-ever gate evaluation for this symbol always clears the low bar.
    assert_eq!(responses[3]["decision"], "WorthLook");

    // The state store really opened (not silently None): its db file exists.
    assert!(dir.path().join("state.sqlite3").exists());
}

#[test]
fn a_malformed_evaluate_scan_gate_between_two_valid_ones_does_not_kill_the_sidecar() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_sidecar"))
        .arg("--lake-root")
        .arg(dir.path().to_str().unwrap())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("sidecar binary must start");

    let valid = r#"{"type":"add_watchlist_symbol","id":1,"symbol":"NSE:INFY"}"#;
    // Well-typed tag but a confluence object missing required fields: parses as
    // a request line only if serde accepts it; if it fails to parse it is logged
    // and skipped. Either way the process must answer the two valid requests and
    // exit cleanly, exactly like the existing thin-history regression test.
    let malformed = r#"{"type":"evaluate_scan_gate","id":2,"symbol":"NSE:INFY"}"#;
    let valid_2 = r#"{"type":"list_watchlist","id":3}"#;

    {
        let stdin = child.stdin.as_mut().unwrap();
        writeln!(stdin, "{valid}").unwrap();
        writeln!(stdin, "{malformed}").unwrap();
        writeln!(stdin, "{valid_2}").unwrap();
    }
    drop(child.stdin.take());

    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let mut ids = Vec::new();
    // The malformed line either parses (and answers with id 2) or is skipped, so
    // read until EOF and collect whatever ids came back.
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap() == 0 {
            break;
        }
        if line.trim().is_empty() {
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        ids.push(value["id"].as_u64().unwrap());
    }

    let status = child.wait().expect("sidecar must be waitable, not crashed");
    assert!(status.success(), "sidecar should exit cleanly, not crash: {status:?}");
    assert!(ids.contains(&1), "the first valid request must be answered");
    assert!(ids.contains(&3), "the second valid request must be answered");
}
