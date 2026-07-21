use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct ComputeRequest {
    pub id: u64,
    pub symbol: String,
    pub timeframe: String,
    pub closes: Vec<f64>,
}

#[derive(Debug, Serialize)]
pub struct AlgoResultWire {
    pub algo_id: String,
    pub direction: String,
    pub confidence: f64,
    pub evidence: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ConfluenceWire {
    pub bullish_count: usize,
    pub bearish_count: usize,
    pub neutral_count: usize,
    pub weighted_vote: f64,
}

#[derive(Debug, Serialize)]
pub struct ComputeResponse {
    pub id: u64,
    pub algo_results: Vec<AlgoResultWire>,
    pub confluence: ConfluenceWire,
}

/// The "nothing ran" response for `id`: no algorithm results and entirely
/// zeroed confluence. This is owed to the client whenever no compute result
/// exists for a request that nonetheless needs exactly one answered response
/// line -- e.g. a request whose history was too short for every registered
/// algorithm, or (see `main`'s per-request `catch_unwind`) a request that
/// panicked mid-compute. The client blocks on `id`, so skipping the response
/// line entirely would hang it forever.
pub fn empty_response(id: u64) -> ComputeResponse {
    ComputeResponse {
        id,
        algo_results: Vec::new(),
        confluence: ConfluenceWire {
            bullish_count: 0,
            bearish_count: 0,
            neutral_count: 0,
            weighted_vote: 0.0,
        },
    }
}

#[derive(Debug, Deserialize)]
pub struct CandleWire {
    pub ts: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: i64,
}

#[derive(Debug, Deserialize)]
pub struct PersistCandlesRequest {
    pub id: u64,
    pub symbol: String,
    pub timeframe: String,
    pub source: String,
    pub candles: Vec<CandleWire>,
}

#[derive(Debug, Serialize)]
pub struct PersistCandlesResponse {
    pub id: u64,
    pub written: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarRequest {
    Compute(ComputeRequest),
    PersistCandles(PersistCandlesRequest),
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarResponse {
    Compute(ComputeResponse),
    PersistCandles(PersistCandlesResponse),
}

pub fn parse_request(line: &str) -> serde_json::Result<SidecarRequest> {
    serde_json::from_str(line)
}

pub fn encode_response(response: &SidecarResponse) -> String {
    serde_json::to_string(response).expect("SidecarResponse always serializes")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_response_wraps_as_a_tagged_compute_response_carrying_the_id() {
        let response = SidecarResponse::Compute(empty_response(99));
        let line = encode_response(&response);
        assert!(line.contains("\"id\":99"));
        assert!(line.contains("\"type\":\"compute\""));
        assert!(!line.contains('\n'));
    }

    #[test]
    fn parses_a_tagged_compute_request() {
        let line = r#"{"type":"compute","id":5,"symbol":"NSE:INFY","timeframe":"day","closes":[1.0,2.0]}"#;
        match parse_request(line).unwrap() {
            SidecarRequest::Compute(request) => {
                assert_eq!(request.id, 5);
                assert_eq!(request.closes, vec![1.0, 2.0]);
            }
            _ => panic!("expected a compute request"),
        }
    }

    #[test]
    fn parses_a_tagged_persist_candles_request() {
        let line = r#"{"type":"persist_candles","id":6,"symbol":"NSE:INFY","timeframe":"day","source":"kite","candles":[{"ts":1710000000,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":100}]}"#;
        match parse_request(line).unwrap() {
            SidecarRequest::PersistCandles(request) => {
                assert_eq!(request.id, 6);
                assert_eq!(request.source, "kite");
                assert_eq!(request.candles.len(), 1);
                assert_eq!(request.candles[0].volume, 100);
            }
            _ => panic!("expected a persist_candles request"),
        }
    }

    #[test]
    fn persist_response_omits_error_field_when_none() {
        let response = SidecarResponse::PersistCandles(PersistCandlesResponse {
            id: 6,
            written: 1,
            error: None,
        });
        let line = encode_response(&response);
        assert!(line.contains("\"type\":\"persist_candles\""));
        assert!(line.contains("\"written\":1"));
        assert!(!line.contains("error"));
    }
}
