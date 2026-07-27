use sidecar::protocol::{
    empty_response, encode_response, parse_request, AddWatchlistSymbolRequest, AlgoResultWire,
    ComputeResponse, ConfluenceWire, EvaluateScanGateRequest, ListWatchlistRequest,
    RemoveWatchlistSymbolRequest, ScanGateResponse, SidecarRequest, SidecarResponse,
    WatchlistResponse,
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
            symbol: "NSE:INFY".to_string(),
            timeframe: "day".to_string(),
            horizon: "positional".to_string(),
            direction: "Bullish".to_string(),
            magnitude: 0.0123,
            confidence: 0.5,
            evidence: vec!["close above SMA".to_string()],
            computed_at: "2026-07-24T00:00:00+00:00".to_string(),
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
    assert!(line.contains("\"symbol\":\"NSE:INFY\""));
    assert!(line.contains("\"timeframe\":\"day\""));
    assert!(line.contains("\"horizon\":\"positional\""));
    assert!(line.contains("\"magnitude\":0.0123"));
    assert!(line.contains("\"computed_at\":\"2026-07-24T00:00:00+00:00\""));
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

#[test]
fn confluence_wire_deserializes_from_a_json_object() {
    let json = r#"{"bullish_count":5,"bearish_count":2,"neutral_count":10,"weighted_vote":0.12}"#;
    let wire: ConfluenceWire = serde_json::from_str(json).unwrap();
    assert_eq!(wire.bullish_count, 5);
    assert_eq!(wire.bearish_count, 2);
    assert_eq!(wire.neutral_count, 10);
    assert!((wire.weighted_vote - 0.12).abs() < 1e-9);
}

#[test]
fn add_watchlist_symbol_request_payload_deserializes() {
    let req: AddWatchlistSymbolRequest =
        serde_json::from_str(r#"{"id":7,"symbol":"NSE:INFY"}"#).unwrap();
    assert_eq!(req.id, 7);
    assert_eq!(req.symbol, "NSE:INFY");
}

#[test]
fn remove_watchlist_symbol_request_payload_deserializes() {
    let req: RemoveWatchlistSymbolRequest =
        serde_json::from_str(r#"{"id":8,"symbol":"NSE:INFY"}"#).unwrap();
    assert_eq!(req.id, 8);
    assert_eq!(req.symbol, "NSE:INFY");
}

#[test]
fn list_watchlist_request_payload_deserializes() {
    let req: ListWatchlistRequest = serde_json::from_str(r#"{"id":9}"#).unwrap();
    assert_eq!(req.id, 9);
}

#[test]
fn evaluate_scan_gate_request_payload_deserializes_with_its_confluence() {
    let req: EvaluateScanGateRequest = serde_json::from_str(
        r#"{"id":10,"symbol":"NSE:INFY","confluence":{"bullish_count":5,"bearish_count":2,"neutral_count":10,"weighted_vote":0.12}}"#,
    )
    .unwrap();
    assert_eq!(req.id, 10);
    assert_eq!(req.symbol, "NSE:INFY");
    assert_eq!(req.confluence.bullish_count, 5);
}

#[test]
fn watchlist_response_omits_error_field_when_none() {
    let json = serde_json::to_string(&WatchlistResponse {
        id: 7,
        symbols: vec!["NSE:INFY".to_string()],
        error: None,
    })
    .unwrap();
    assert!(json.contains("\"id\":7"));
    assert!(json.contains("\"symbols\":[\"NSE:INFY\"]"));
    assert!(!json.contains("error"));
}

#[test]
fn scan_gate_response_serializes_its_decision_string() {
    let json = serde_json::to_string(&ScanGateResponse {
        id: 10,
        decision: "WorthLook".to_string(),
        error: None,
    })
    .unwrap();
    assert!(json.contains("\"id\":10"));
    assert!(json.contains("\"decision\":\"WorthLook\""));
    assert!(!json.contains("error"));
}
