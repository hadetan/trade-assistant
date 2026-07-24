use sidecar::protocol::{
    empty_response, encode_response, parse_request, AlgoResultWire, ComputeResponse,
    ConfluenceWire, SidecarRequest, SidecarResponse,
};

#[test]
fn request_round_trips_from_json_line() {
    let line = r#"{"type":"compute","id":1,"symbol":"NSE:INFY","timeframe":"day","closes":[100.0,101.0,102.0]}"#;

    let request = match parse_request(line).unwrap() {
        SidecarRequest::Compute(request) => request,
        _ => panic!("expected a compute request"),
    };

    assert_eq!(request.id, 1);
    assert_eq!(request.symbol, "NSE:INFY");
    assert_eq!(request.closes, vec![100.0, 101.0, 102.0]);
}

#[test]
fn response_encodes_to_a_single_json_line() {
    let response = SidecarResponse::Compute(ComputeResponse {
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
    });

    let line = encode_response(&response);

    assert!(!line.contains('\n'));
    assert!(line.contains("\"id\":1"));
    assert!(line.contains("\"algo_id\":\"sma\""));
}

#[test]
fn empty_response_answers_the_given_id_with_zeroed_everything() {
    // Used both when no algorithm has enough lookback and (after this fix)
    // when a request panics mid-compute -- either way the client is still
    // owed exactly one well-formed response line for its `id`.
    let response = empty_response(99);

    assert_eq!(response.id, 99);
    assert!(response.algo_results.is_empty());
    assert_eq!(response.confluence.bullish_count, 0);
    assert_eq!(response.confluence.bearish_count, 0);
    assert_eq!(response.confluence.neutral_count, 0);
    assert_eq!(response.confluence.weighted_vote, 0.0);
}
