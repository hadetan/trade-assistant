use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct ComputeRequest {
    pub id: u64,
    pub symbol: String,
    pub timeframe: String,
    /// "intraday" | "positional".
    pub horizon: String,
    /// Full OHLCV, ascending by ts; the last element is the frontier bar.
    pub candles: Vec<CandleWire>,
}

#[derive(Debug, Serialize)]
pub struct AlgoResultWire {
    pub algo_id: String,
    pub symbol: String,
    pub timeframe: String,
    pub horizon: String,
    pub direction: String,
    pub magnitude: f64,
    pub confidence: f64,
    pub evidence: Vec<String>,
    pub computed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
pub struct AddWatchlistSymbolRequest {
    pub id: u64,
    pub symbol: String,
}

#[derive(Debug, Deserialize)]
pub struct RemoveWatchlistSymbolRequest {
    pub id: u64,
    pub symbol: String,
}

#[derive(Debug, Deserialize)]
pub struct ListWatchlistRequest {
    pub id: u64,
}

#[derive(Debug, Deserialize)]
pub struct EvaluateScanGateRequest {
    pub id: u64,
    pub symbol: String,
    pub confluence: ConfluenceWire,
}

#[derive(Debug, Serialize)]
pub struct WatchlistResponse {
    pub id: u64,
    pub symbols: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ScanGateResponse {
    pub id: u64,
    /// One of "NoChange" | "WorthLook" | "WorthAiCall" -- produced via
    /// `format!("{decision:?}")`, the same convention `AlgoResultWire::direction`
    /// uses to mirror an `algo_core` enum onto the wire as a Debug string.
    pub decision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListLakeSymbolsRequest {
    pub id: u64,
}

#[derive(Debug, Deserialize)]
pub struct ReadLakeCandlesRequest {
    pub id: u64,
    pub symbol: String,
    pub timeframe: String,
    pub source: String,
}

#[derive(Debug, Deserialize)]
pub struct BenchmarkComputeRequest {
    pub id: u64,
    pub symbol: String,
    pub timeframe: String,
    /// "intraday" | "positional".
    pub horizon: String,
    /// The visible window series[0..=frontier], ascending by ts.
    pub candles: Vec<CandleWire>,
    pub algo_id: String,
}

#[derive(Debug, Deserialize)]
pub struct EvaluateScanGateStatelessRequest {
    pub id: u64,
    pub prev: Option<ConfluenceWire>,
    pub curr: ConfluenceWire,
}

#[derive(Debug, Deserialize)]
pub struct ListAlgorithmsRequest {
    pub id: u64,
}

#[derive(Debug, Deserialize)]
pub struct EnsureDayBackfillRequest {
    pub id: u64,
    pub symbol: String,
    /// Sizing is per the single selected algorithm, not a max across all of
    /// them: the Benchmark UI already requires picking exactly one (P14§2
    /// locked decision 2).
    pub algo_id: String,
    /// The scoring window of the run asking for the backfill (its
    /// `lookaheadBars`). Sizing needs it because a frontier is only usable when
    /// a real bar exists `lookahead` bars after it, so the algorithm's own
    /// lookback alone never leaves room to score anything.
    pub lookahead: usize,
    /// START of the single day the run will actually test (its `fromTs`): UTC
    /// midnight of the selected calendar day, Unix epoch seconds. No caller
    /// builds this directly anymore -- `pick_candidate_from_ts` in
    /// `benchmark_window.rs` computes it server-side from the lake's own rows
    /// (P15§3). NOT that day's candle stamp -- a bhavcopy day candle carries
    /// `ist_session_close_epoch` (15:30 IST = 10:00 UTC), so the selection's
    /// own bar sits 36000s AFTER this value. Since this source is day-only,
    /// the selected partition is implicitly `[from_ts, from_ts + 86_400)`, and
    /// that upper edge -- not `from_ts` -- is where `benchmark_window` splits
    /// leading from trailing context.
    ///
    /// Sizing is meaningless without it: the Benchmark UI tests exactly one
    /// candle per run, so what matters is that *that* candle has enough bars
    /// before and after it, not that the partition is deep in total.
    pub from_ts: i64,
}

#[derive(Debug, Serialize)]
pub struct DayBackfillResponse {
    pub id: u64,
    /// Of the `need` bars this run wants, how many it can actually use:
    /// `min(leading, lookback) + min(trailing, lookahead)`, split at the END of
    /// the selected day (`from_ts + 86_400`) so the selection's own bar counts
    /// as leading context and not as something to score against. Zero when the
    /// symbol has no candle on the selected day at all -- there is no bar to
    /// decide about, which is a different shortfall from a thin one.
    /// Capped on each side deliberately, so `sufficient: false` always
    /// implies `have < need` whichever side is short -- reporting a raw row
    /// count let an insufficient answer render as "has 22 days; needs 20",
    /// which reads as a contradiction. The cap can undersell a deep symbol
    /// whose *trailing* side is the blocker; see `benchmark_window`.
    pub have: usize,
    /// The total bars this run needs before it can produce even one result: the
    /// algorithm's own required_lookback plus the run's lookahead scoring
    /// window.
    pub need: usize,
    /// false => `have` is the symbol's full available real history, capped by
    /// the "10 consecutive absent trading days" heuristic (P14§2 item 4) --
    /// UNLESS `archive_exhausted` is set, in which case `have` is only what the
    /// walk managed to collect before the archive went quiet.
    pub sufficient: bool,
    /// The walk stopped because CLOSED_DAY_LIMIT weekdays in a row had no file
    /// at all. Always serialized (like `sufficient`) rather than skipped when
    /// false: this is a third outcome, and a consumer must never have to infer
    /// it from an absent key (decision (xviii)).
    pub archive_exhausted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ResolveBenchmarkWindowRequest {
    pub id: u64,
    pub symbol: String,
    pub algo_id: String,
    /// The requesting run's scoring window (its `lookaheadBars`) -- everything
    /// else about which day to test is resolved server-side (P15§3).
    pub lookahead: usize,
}

#[derive(Debug, Serialize)]
pub struct ResolveBenchmarkWindowResponse {
    pub id: u64,
    /// The day actually resolved and tested: UTC midnight of that calendar
    /// day, in the same encoding `EnsureDayBackfillRequest::from_ts` used
    /// when a caller supplied it directly.
    pub from_ts: i64,
    pub have: usize,
    pub need: usize,
    pub sufficient: bool,
    pub archive_exhausted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AlgorithmWire {
    pub id: String,
    /// "fast" | "slow" -- see handlers::handle_list_algorithms for the split.
    pub cost: String,
    /// The algorithm's own Algorithm::required_lookback(). The Electron side
    /// sizes its warm-up backfill against the maximum of these (P13§4.2), so a
    /// newly linked model widens the fetch window without a code change here.
    pub required_lookback: usize,
}

#[derive(Debug, Serialize)]
pub struct ListAlgorithmsResponse {
    pub id: u64,
    pub algorithms: Vec<AlgorithmWire>,
}

#[derive(Debug, Serialize)]
pub struct LakeSymbolWire {
    pub symbol: String,
    pub timeframe: String,
    pub source: String,
    pub from_ts: i64,
    pub to_ts: i64,
    pub candle_count: usize,
    pub first_seen_from_ts: i64,
    pub first_seen_to_ts: i64,
    pub first_seen_candle_count: usize,
}

#[derive(Debug, Serialize)]
pub struct LakeSymbolsResponse {
    pub id: u64,
    pub entries: Vec<LakeSymbolWire>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LakeCandlesResponse {
    pub id: u64,
    pub candles: Vec<CandleWire>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BenchmarkComputeResponse {
    pub id: u64,
    pub algo_results: Vec<AlgoResultWire>,
    pub confluence: ConfluenceWire,
}

/// The "nothing ran / panicked" benchmark_compute answer for `id`: no algorithm
/// results, entirely zeroed confluence. Mirrors `empty_response`'s role for
/// `Compute` -- the client blocks on `id`, so it is still owed one line.
pub fn benchmark_empty_response(id: u64) -> BenchmarkComputeResponse {
    BenchmarkComputeResponse {
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
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarRequest {
    Compute(ComputeRequest),
    PersistCandles(PersistCandlesRequest),
    AddWatchlistSymbol(AddWatchlistSymbolRequest),
    RemoveWatchlistSymbol(RemoveWatchlistSymbolRequest),
    ListWatchlist(ListWatchlistRequest),
    EvaluateScanGate(EvaluateScanGateRequest),
    ListLakeSymbols(ListLakeSymbolsRequest),
    ReadLakeCandles(ReadLakeCandlesRequest),
    BenchmarkCompute(BenchmarkComputeRequest),
    EvaluateScanGateStateless(EvaluateScanGateStatelessRequest),
    ListAlgorithms(ListAlgorithmsRequest),
    ResolveBenchmarkWindow(ResolveBenchmarkWindowRequest),
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarResponse {
    Compute(ComputeResponse),
    PersistCandles(PersistCandlesResponse),
    Watchlist(WatchlistResponse),
    ScanGate(ScanGateResponse),
    LakeSymbols(LakeSymbolsResponse),
    LakeCandles(LakeCandlesResponse),
    BenchmarkCompute(BenchmarkComputeResponse),
    Algorithms(ListAlgorithmsResponse),
    BenchmarkWindow(ResolveBenchmarkWindowResponse),
}

pub fn parse_request(line: &str) -> serde_json::Result<SidecarRequest> {
    serde_json::from_str(line)
}

pub fn encode_response(response: &SidecarResponse) -> String {
    serde_json::to_string(response).expect("SidecarResponse always serializes")
}

#[derive(Debug, Serialize)]
pub struct ProgressLine {
    pub r#type: &'static str,
    pub id: u64,
    pub step: String,
    pub status: String,
    /// Present only for a step that can say "N of M" -- today just the day
    /// backfill walk. Skipped when absent so every pre-existing progress line
    /// is byte-for-byte what it was before (P14§5).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
}

pub fn encode_progress(id: u64, step: &str, status: &str) -> String {
    serde_json::to_string(&ProgressLine {
        r#type: "progress",
        id,
        step: step.to_string(),
        status: status.to_string(),
        index: None,
        total: None,
    })
    .expect("ProgressLine always serializes")
}

pub fn encode_progress_counted(id: u64, step: &str, status: &str, index: usize, total: usize) -> String {
    serde_json::to_string(&ProgressLine {
        r#type: "progress",
        id,
        step: step.to_string(),
        status: status.to_string(),
        index: Some(index),
        total: Some(total),
    })
    .expect("ProgressLine always serializes")
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
    fn parses_a_tagged_compute_request_carrying_full_ohlcv_and_a_horizon() {
        let line = r#"{"type":"compute","id":5,"symbol":"NSE:INFY","timeframe":"5minute","horizon":"intraday","candles":[{"ts":100,"open":1.0,"high":2.0,"low":0.5,"close":1.5,"volume":10}]}"#;
        match parse_request(line).unwrap() {
            SidecarRequest::Compute(request) => {
                assert_eq!(request.id, 5);
                assert_eq!(request.horizon, "intraday");
                assert_eq!(request.candles.len(), 1);
                assert_eq!(request.candles[0].volume, 10);
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

    #[test]
    fn encode_progress_emits_a_single_line_progress_object() {
        let line = encode_progress(7, "compute", "running");
        assert!(line.contains("\"type\":\"progress\""));
        assert!(line.contains("\"id\":7"));
        assert!(line.contains("\"step\":\"compute\""));
        assert!(line.contains("\"status\":\"running\""));
        assert!(!line.contains('\n'));
        // per-algorithm step is just another string in the same field
        assert!(encode_progress(7, "rsi", "done").contains("\"step\":\"rsi\""));
    }

    #[test]
    fn encode_progress_omits_the_count_fields_so_every_existing_line_stays_byte_identical() {
        let line = encode_progress(7, "compute", "running");
        assert!(!line.contains("index"), "an uncounted step must not gain an index key: {line}");
        assert!(!line.contains("total"), "an uncounted step must not gain a total key: {line}");
        assert_eq!(
            line,
            r#"{"type":"progress","id":7,"step":"compute","status":"running"}"#
        );
    }

    #[test]
    fn encode_progress_counted_carries_the_day_index_and_total_alongside_the_step() {
        let line = encode_progress_counted(9, "backfill", "running", 143, 256);
        assert!(line.contains("\"type\":\"progress\""));
        assert!(line.contains("\"id\":9"));
        assert!(line.contains("\"step\":\"backfill\""));
        assert!(line.contains("\"status\":\"running\""));
        assert!(line.contains("\"index\":143"));
        assert!(line.contains("\"total\":256"));
        assert!(!line.contains('\n'));
    }

    #[test]
    fn encode_progress_counted_reports_a_zero_denominator_rather_than_omitting_it() {
        // A symbol that needs nothing still emits a well-formed counted line if
        // anything ever walks zero days -- Some(0) is not None.
        let line = encode_progress_counted(9, "backfill", "running", 0, 0);
        assert!(line.contains("\"index\":0"));
        assert!(line.contains("\"total\":0"));
    }
}
