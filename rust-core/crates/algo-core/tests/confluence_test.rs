use algo_core::{confluence::compute_confluence, AlgoOutput, Direction, Horizon, Timeframe};
use chrono::Utc;
use std::collections::HashMap;

fn output(algo_id: &'static str, direction: Direction) -> AlgoOutput {
    AlgoOutput {
        algo_id,
        symbol: "TEST".to_string(),
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
fn two_bullish_one_bearish_with_equal_weights_favors_bullish() {
    let outputs = vec![
        output("sma", Direction::Bullish),
        output("ema", Direction::Bullish),
        output("rsi", Direction::Bearish),
    ];
    let weights: HashMap<&str, f64> =
        [("sma", 1.0), ("ema", 1.0), ("rsi", 1.0)].into_iter().collect();

    let scorecard = compute_confluence(&outputs, &weights);

    assert_eq!(scorecard.bullish_count, 2);
    assert_eq!(scorecard.bearish_count, 1);
    assert_eq!(scorecard.neutral_count, 0);
    // weighted vote: (1.0 + 1.0 - 1.0) / 3.0 = 0.333...
    assert!((scorecard.weighted_vote - (1.0 / 3.0)).abs() < 1e-9);
}
