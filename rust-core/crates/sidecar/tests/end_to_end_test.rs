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

    let valid_request = r#"{"id":1,"symbol":"NSE:INFY","timeframe":"day","closes":[100.0,101.0,102.0,103.0,104.0,105.0,106.0,107.0,108.0,109.0,110.0,111.0,112.0,113.0,114.0,115.0,116.0,117.0,118.0,119.0,120.0]}"#;
    // Only 3 closes: shorter than every registered algorithm's
    // required_lookback (rsi needs 15, sma/ema need 20).
    let too_few_closes_request =
        r#"{"id":2,"symbol":"NSE:NEWLISTING","timeframe":"day","closes":[100.0,101.0,102.0]}"#;
    let valid_request_2 = r#"{"id":3,"symbol":"NSE:INFY","timeframe":"day","closes":[100.0,101.0,102.0,103.0,104.0,105.0,106.0,107.0,108.0,109.0,110.0,111.0,112.0,113.0,114.0,115.0,116.0,117.0,118.0,119.0,120.0]}"#;

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
    assert_eq!(responses[0]["algo_results"].as_array().unwrap().len(), 3);

    assert_eq!(responses[1]["id"], 2);
    // No algorithm has enough lookback for 3 closes -- well-formed empty
    // response, not a panic.
    assert_eq!(responses[1]["algo_results"].as_array().unwrap().len(), 0);
    assert_eq!(responses[1]["confluence"]["bullish_count"], 0);
    assert_eq!(responses[1]["confluence"]["weighted_vote"], 0.0);

    assert_eq!(responses[2]["id"], 3);
    assert_eq!(responses[2]["algo_results"].as_array().unwrap().len(), 3);
}
