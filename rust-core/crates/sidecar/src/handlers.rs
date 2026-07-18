use crate::protocol::{AlgoResultWire, ComputeRequest, ComputeResponse, ConfluenceWire};
use algo_core::{confluence::compute_confluence, registry, Horizon, MarketContext, Timeframe};
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

    let outputs: Vec<_> = registry::all().iter().map(|algo| algo.compute(&ctx)).collect();

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
