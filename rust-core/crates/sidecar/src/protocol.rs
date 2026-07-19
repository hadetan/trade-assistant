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

pub fn parse_request(line: &str) -> serde_json::Result<ComputeRequest> {
    serde_json::from_str(line)
}

pub fn encode_response(response: &ComputeResponse) -> String {
    serde_json::to_string(response).expect("ComputeResponse always serializes")
}
