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

pub fn parse_request(line: &str) -> serde_json::Result<ComputeRequest> {
    serde_json::from_str(line)
}

pub fn encode_response(response: &ComputeResponse) -> String {
    serde_json::to_string(response).expect("ComputeResponse always serializes")
}

/// A well-formed "nothing ran" response for a given request id: no algorithm
/// results and a zeroed confluence scorecard. Used when a request cannot be
/// answered normally (e.g. a caught panic) so the stdio protocol still emits
/// exactly one response line per parsed request and the client never blocks
/// waiting for a missing id. Matches the shape `handle_request` produces when
/// no algorithm has enough data to run.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_response_is_zeroed_and_carries_the_request_id() {
        let response = empty_response(99);
        assert_eq!(response.id, 99);
        assert!(response.algo_results.is_empty());
        assert_eq!(response.confluence.bullish_count, 0);
        assert_eq!(response.confluence.bearish_count, 0);
        assert_eq!(response.confluence.neutral_count, 0);
        assert_eq!(response.confluence.weighted_vote, 0.0);

        let line = encode_response(&response);
        assert!(line.contains("\"id\":99"));
        assert!(!line.contains('\n'));
    }
}
