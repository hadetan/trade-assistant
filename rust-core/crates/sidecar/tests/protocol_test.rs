use sidecar::protocol::{encode_response, parse_request, AlgoResultWire, ComputeResponse, ConfluenceWire};

#[test]
fn request_round_trips_from_json_line() {
    let line = r#"{"id":1,"symbol":"NSE:INFY","timeframe":"day","closes":[100.0,101.0,102.0]}"#;

    let request = parse_request(line).unwrap();

    assert_eq!(request.id, 1);
    assert_eq!(request.symbol, "NSE:INFY");
    assert_eq!(request.closes, vec![100.0, 101.0, 102.0]);
}

#[test]
fn response_encodes_to_a_single_json_line() {
    let response = ComputeResponse {
        id: 1,
        algo_results: vec![AlgoResultWire {
            algo_id: "sma".to_string(),
            direction: "Bullish".to_string(),
            confidence: 0.5,
            evidence: vec!["close above SMA".to_string()],
        }],
        confluence: ConfluenceWire {
            bullish_count: 1,
            bearish_count: 0,
            neutral_count: 0,
            weighted_vote: 1.0,
        },
    };

    let line = encode_response(&response);

    assert!(!line.contains('\n'));
    assert!(line.contains("\"id\":1"));
    assert!(line.contains("\"algo_id\":\"sma\""));
}
