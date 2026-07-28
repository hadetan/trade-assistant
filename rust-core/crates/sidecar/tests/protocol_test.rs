use sidecar::protocol::{
    empty_response, encode_response, parse_request, AddWatchlistSymbolRequest, AlgoResultWire,
    ComputeResponse, ConfluenceWire, EvaluateScanGateRequest, ListWatchlistRequest,
    RemoveWatchlistSymbolRequest, ScanGateResponse, SidecarRequest, SidecarResponse,
    WatchlistResponse,
};
use sidecar::protocol::{
    benchmark_empty_response, BenchmarkComputeRequest, BenchmarkComputeResponse, CandleWire,
    EvaluateScanGateStatelessRequest, LakeCandlesResponse, LakeSymbolWire, LakeSymbolsResponse,
    ListLakeSymbolsRequest, ReadLakeCandlesRequest,
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

#[test]
fn parses_a_tagged_add_watchlist_symbol_request() {
    match parse_request(r#"{"type":"add_watchlist_symbol","id":7,"symbol":"NSE:INFY"}"#).unwrap() {
        SidecarRequest::AddWatchlistSymbol(request) => {
            assert_eq!(request.id, 7);
            assert_eq!(request.symbol, "NSE:INFY");
        }
        _ => panic!("expected an add_watchlist_symbol request"),
    }
}

#[test]
fn parses_a_tagged_remove_watchlist_symbol_request() {
    match parse_request(r#"{"type":"remove_watchlist_symbol","id":8,"symbol":"NSE:INFY"}"#).unwrap() {
        SidecarRequest::RemoveWatchlistSymbol(request) => assert_eq!(request.id, 8),
        _ => panic!("expected a remove_watchlist_symbol request"),
    }
}

#[test]
fn parses_a_tagged_list_watchlist_request() {
    match parse_request(r#"{"type":"list_watchlist","id":9}"#).unwrap() {
        SidecarRequest::ListWatchlist(request) => assert_eq!(request.id, 9),
        _ => panic!("expected a list_watchlist request"),
    }
}

#[test]
fn parses_a_tagged_evaluate_scan_gate_request() {
    match parse_request(
        r#"{"type":"evaluate_scan_gate","id":10,"symbol":"NSE:INFY","confluence":{"bullish_count":5,"bearish_count":2,"neutral_count":10,"weighted_vote":0.12}}"#,
    )
    .unwrap()
    {
        SidecarRequest::EvaluateScanGate(request) => {
            assert_eq!(request.id, 10);
            assert_eq!(request.confluence.neutral_count, 10);
        }
        _ => panic!("expected an evaluate_scan_gate request"),
    }
}

#[test]
fn encodes_a_tagged_watchlist_response() {
    let line = encode_response(&SidecarResponse::Watchlist(WatchlistResponse {
        id: 7,
        symbols: vec!["NSE:INFY".to_string()],
        error: None,
    }));
    assert!(!line.contains('\n'));
    assert!(line.contains("\"type\":\"watchlist\""));
    assert!(line.contains("\"symbols\":[\"NSE:INFY\"]"));
}

#[test]
fn encodes_a_tagged_scan_gate_response() {
    let line = encode_response(&SidecarResponse::ScanGate(ScanGateResponse {
        id: 10,
        decision: "WorthLook".to_string(),
        error: None,
    }));
    assert!(line.contains("\"type\":\"scan_gate\""));
    assert!(line.contains("\"decision\":\"WorthLook\""));
}

#[test]
fn list_lake_symbols_request_payload_deserializes() {
    let req: ListLakeSymbolsRequest = serde_json::from_str(r#"{"id":20}"#).unwrap();
    assert_eq!(req.id, 20);
}

#[test]
fn read_lake_candles_request_payload_deserializes_with_its_source() {
    let req: ReadLakeCandlesRequest =
        serde_json::from_str(r#"{"id":21,"symbol":"NSE:INFY","timeframe":"day","source":"bhavcopy"}"#).unwrap();
    assert_eq!(req.id, 21);
    assert_eq!(req.symbol, "NSE:INFY");
    assert_eq!(req.timeframe, "day");
    assert_eq!(req.source, "bhavcopy");
}

#[test]
fn benchmark_compute_request_payload_deserializes_its_candle_window() {
    let req: BenchmarkComputeRequest = serde_json::from_str(
        r#"{"id":22,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":1710000000,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100}]}"#,
    )
    .unwrap();
    assert_eq!(req.id, 22);
    assert_eq!(req.horizon, "positional");
    assert_eq!(req.candles.len(), 1);
    assert_eq!(req.candles[0].volume, 100);
}

#[test]
fn evaluate_scan_gate_stateless_request_payload_deserializes_with_a_null_prev() {
    let req: EvaluateScanGateStatelessRequest = serde_json::from_str(
        r#"{"id":23,"prev":null,"curr":{"bullish_count":5,"bearish_count":2,"neutral_count":10,"weighted_vote":0.12}}"#,
    )
    .unwrap();
    assert_eq!(req.id, 23);
    assert!(req.prev.is_none());
    assert_eq!(req.curr.bullish_count, 5);
}

#[test]
fn lake_symbols_response_serializes_its_entries() {
    let json = serde_json::to_string(&LakeSymbolsResponse {
        id: 20,
        entries: vec![LakeSymbolWire {
            symbol: "NSE:INFY".to_string(),
            timeframe: "day".to_string(),
            source: "bhavcopy".to_string(),
            from_ts: 1_690_000_000,
            to_ts: 1_710_000_000,
            candle_count: 240,
        }],
        error: None,
    })
    .unwrap();
    assert!(json.contains("\"symbol\":\"NSE:INFY\""));
    assert!(json.contains("\"candle_count\":240"));
    assert!(!json.contains("error"));
}

#[test]
fn lake_candles_response_serializes_all_six_candle_fields_proving_candle_wire_now_serializes() {
    let json = serde_json::to_string(&LakeCandlesResponse {
        id: 21,
        candles: vec![CandleWire { ts: 1_710_000_000, open: 1.0, high: 2.0, low: 0.5, close: 1.5, volume: 100 }],
        error: None,
    })
    .unwrap();
    for field in ["\"ts\":1710000000", "\"open\":1.0", "\"high\":2.0", "\"low\":0.5", "\"close\":1.5", "\"volume\":100"] {
        assert!(json.contains(field), "missing {field} in {json}");
    }
}

#[test]
fn benchmark_compute_response_serializes_and_empty_helper_is_zeroed() {
    let empty = benchmark_empty_response(22);
    assert_eq!(empty.id, 22);
    assert!(empty.algo_results.is_empty());
    assert_eq!(empty.confluence.bullish_count, 0);
    assert_eq!(empty.confluence.neutral_count, 0);
    let json = serde_json::to_string(&BenchmarkComputeResponse {
        id: 22,
        algo_results: Vec::new(),
        confluence: empty.confluence,
    })
    .unwrap();
    assert!(json.contains("\"id\":22"));
}

#[test]
fn parses_a_tagged_list_lake_symbols_request() {
    match parse_request(r#"{"type":"list_lake_symbols","id":20}"#).unwrap() {
        SidecarRequest::ListLakeSymbols(request) => assert_eq!(request.id, 20),
        _ => panic!("expected a list_lake_symbols request"),
    }
}

#[test]
fn parses_a_tagged_read_lake_candles_request() {
    match parse_request(r#"{"type":"read_lake_candles","id":21,"symbol":"NSE:INFY","timeframe":"day","source":"bhavcopy"}"#).unwrap() {
        SidecarRequest::ReadLakeCandles(request) => {
            assert_eq!(request.id, 21);
            assert_eq!(request.source, "bhavcopy");
        }
        _ => panic!("expected a read_lake_candles request"),
    }
}

#[test]
fn parses_a_tagged_benchmark_compute_request() {
    match parse_request(
        r#"{"type":"benchmark_compute","id":22,"symbol":"NSE:INFY","timeframe":"day","horizon":"positional","candles":[{"ts":1710000000,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100}]}"#,
    )
    .unwrap()
    {
        SidecarRequest::BenchmarkCompute(request) => {
            assert_eq!(request.id, 22);
            assert_eq!(request.candles.len(), 1);
        }
        _ => panic!("expected a benchmark_compute request"),
    }
}

#[test]
fn parses_a_tagged_evaluate_scan_gate_stateless_request() {
    match parse_request(
        r#"{"type":"evaluate_scan_gate_stateless","id":23,"prev":null,"curr":{"bullish_count":5,"bearish_count":2,"neutral_count":10,"weighted_vote":0.12}}"#,
    )
    .unwrap()
    {
        SidecarRequest::EvaluateScanGateStateless(request) => {
            assert_eq!(request.id, 23);
            assert!(request.prev.is_none());
        }
        _ => panic!("expected an evaluate_scan_gate_stateless request"),
    }
}

#[test]
fn encodes_a_tagged_lake_symbols_response() {
    let line = encode_response(&SidecarResponse::LakeSymbols(LakeSymbolsResponse {
        id: 20,
        entries: vec![LakeSymbolWire {
            symbol: "NSE:INFY".to_string(),
            timeframe: "day".to_string(),
            source: "bhavcopy".to_string(),
            from_ts: 1_690_000_000,
            to_ts: 1_710_000_000,
            candle_count: 240,
        }],
        error: None,
    }));
    assert!(!line.contains('\n'));
    assert!(line.contains("\"type\":\"lake_symbols\""));
    assert!(line.contains("\"candle_count\":240"));
}

#[test]
fn encodes_a_tagged_lake_candles_response() {
    let line = encode_response(&SidecarResponse::LakeCandles(LakeCandlesResponse {
        id: 21,
        candles: vec![CandleWire { ts: 1_710_000_000, open: 1.0, high: 2.0, low: 0.5, close: 1.5, volume: 100 }],
        error: None,
    }));
    assert!(line.contains("\"type\":\"lake_candles\""));
    assert!(line.contains("\"volume\":100"));
}

#[test]
fn encodes_a_tagged_benchmark_compute_response() {
    let line = encode_response(&SidecarResponse::BenchmarkCompute(benchmark_empty_response(22)));
    assert!(line.contains("\"type\":\"benchmark_compute\""));
    assert!(line.contains("\"id\":22"));
}
