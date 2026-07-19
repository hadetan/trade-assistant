use algo_core::confluence::compute_confluence;
use algo_core::{AlgoOutput, Direction, Horizon, Timeframe};
use backtest::engine::{AlgoStats, ReplayReport};
use chrono::Utc;
use std::collections::HashMap;

fn output(algo_id: &'static str, direction: Direction) -> AlgoOutput {
    AlgoOutput {
        algo_id,
        symbol: "NSE:TEST".to_string(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        direction,
        magnitude: 1.0,
        confidence: 1.0,
        evidence: vec![],
        computed_at: Utc::now(),
    }
}

#[test]
fn hit_rate_weights_feed_compute_confluence() {
    // "a" hit-rate 0.8, "b" hit-rate 0.4.
    let report = ReplayReport {
        per_algo: vec![
            AlgoStats { algo_id: "a".to_string(), directional_calls: 5, hits: 4, sum_signed_return: 0.0 },
            AlgoStats { algo_id: "b".to_string(), directional_calls: 5, hits: 2, sum_signed_return: 0.0 },
        ],
    };
    let owned = report.hit_rate_weights();
    assert!((owned["a"] - 0.8).abs() < 1e-12);
    assert!((owned["b"] - 0.4).abs() < 1e-12);

    let weights: HashMap<&str, f64> = owned.iter().map(|(k, v)| (k.as_str(), *v)).collect();
    let outputs = vec![output("a", Direction::Bullish), output("b", Direction::Bearish)];
    let scorecard = compute_confluence(&outputs, &weights);

    // weight_total = 0.8 + 0.4 = 1.2; weighted_sum = +0.8 - 0.4 = 0.4; vote = 0.4/1.2 = 1/3
    assert_eq!(scorecard.bullish_count, 1);
    assert_eq!(scorecard.bearish_count, 1);
    assert!((scorecard.weighted_vote - (1.0 / 3.0)).abs() < 1e-12);
}
