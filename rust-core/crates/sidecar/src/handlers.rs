use crate::protocol::{AlgoResultWire, ComputeRequest, ComputeResponse, ConfluenceWire};
use algo_core::{confluence::compute_confluence, registry::{self, run_applicable}, Horizon, MarketContext, Timeframe};
use chrono::Utc;
use std::collections::HashMap;

pub fn handle_request(request: ComputeRequest) -> ComputeResponse {
    let timeframe = match request.timeframe.as_str() {
        "minute" => Timeframe::Minute,
        "5minute" => Timeframe::FiveMinute,
        "15minute" => Timeframe::FifteenMinute,
        _ => Timeframe::Day,
    };

    let ctx = MarketContext {
        symbol: request.symbol.clone(),
        timeframe,
        horizon: Horizon::Positional,
        closes: request.closes,
        as_of: Utc::now(),
    };

    // Route every compute() call through the one shared lookback gate
    // (algo_core::registry::run_applicable) so the sidecar and the backtest
    // engine cannot drift on the insufficient-history contract.
    let algos = registry::all();
    let outputs = run_applicable(&algos, &ctx);

    // Phase 1 uses equal weights for every algorithm; a later phase's
    // backtest engine supplies real rolling-hit-rate weights here instead.
    let weights: HashMap<&str, f64> = HashMap::new();
    let confluence = compute_confluence(&outputs, &weights);

    let algo_results = outputs
        .iter()
        .map(|output| AlgoResultWire {
            algo_id: output.algo_id.to_string(),
            direction: format!("{:?}", output.direction),
            confidence: output.confidence,
            evidence: output.evidence.clone(),
        })
        .collect();

    ComputeResponse {
        id: request.id,
        algo_results,
        confluence: ConfluenceWire {
            bullish_count: confluence.bullish_count,
            bearish_count: confluence.bearish_count,
            neutral_count: confluence.neutral_count,
            weighted_vote: confluence.weighted_vote,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn closes_seq(n: usize) -> Vec<f64> {
        (0..n).map(|i| 100.0 + i as f64).collect()
    }

    fn request(id: u64, closes: Vec<f64>) -> ComputeRequest {
        ComputeRequest {
            id,
            symbol: "NSE:NEWLISTING".to_string(),
            timeframe: "day".to_string(),
            closes,
        }
    }

    #[test]
    fn skips_algorithms_without_enough_lookback_instead_of_panicking() {
        // 15 closes: enough for rsi (required_lookback = period + 1 = 15),
        // but short of sma/ema's required_lookback of 20. Before the fix,
        // calling sma/ema here underflowed `closes.len() - period` and
        // panicked the whole process.
        let response = handle_request(request(42, closes_seq(15)));

        assert_eq!(response.id, 42);
        assert_eq!(response.algo_results.len(), 1);
        assert_eq!(response.algo_results[0].algo_id, "rsi");
    }

    #[test]
    fn empty_closes_yields_well_formed_zeroed_response() {
        // No algorithm has enough lookback for zero closes -- handle_request
        // must still return a well-formed response, not panic.
        let response = handle_request(request(7, vec![]));

        assert_eq!(response.id, 7);
        assert!(response.algo_results.is_empty());
        assert_eq!(response.confluence.bullish_count, 0);
        assert_eq!(response.confluence.bearish_count, 0);
        assert_eq!(response.confluence.neutral_count, 0);
        assert_eq!(response.confluence.weighted_vote, 0.0);
        assert!(!response.confluence.weighted_vote.is_nan());
    }

    #[test]
    fn sufficient_closes_runs_all_registered_algorithms() {
        let response = handle_request(request(1, closes_seq(21)));

        assert_eq!(response.algo_results.len(), 3);
    }
}
