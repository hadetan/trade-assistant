use crate::{AlgoOutput, Direction};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub struct ScorecardSummary {
    pub bullish_count: usize,
    pub bearish_count: usize,
    pub neutral_count: usize,
    /// Range roughly [-1.0, 1.0]: sum of (direction_sign * weight) / sum of weights.
    /// Positive leans bullish, negative leans bearish.
    pub weighted_vote: f64,
}

/// `weights` maps an algorithm's `algo_id` to its current weight — in this
/// phase, tests supply equal (1.0) weights; a later phase's backtest engine
/// supplies each algorithm's rolling historical hit-rate instead. An
/// `algo_id` missing from `weights` defaults to 1.0 so new algorithms are
/// never silently dropped from the vote before they have backtest history.
pub fn compute_confluence(
    outputs: &[AlgoOutput],
    weights: &HashMap<&str, f64>,
) -> ScorecardSummary {
    let mut bullish_count = 0;
    let mut bearish_count = 0;
    let mut neutral_count = 0;
    let mut weighted_sum = 0.0;
    let mut weight_total = 0.0;

    for output in outputs {
        let weight = *weights.get(output.algo_id).unwrap_or(&1.0);
        weight_total += weight;

        match output.direction {
            Direction::Bullish => {
                bullish_count += 1;
                weighted_sum += weight;
            }
            Direction::Bearish => {
                bearish_count += 1;
                weighted_sum -= weight;
            }
            Direction::Neutral => {
                neutral_count += 1;
            }
        }
    }

    let weighted_vote = if weight_total > 0.0 {
        weighted_sum / weight_total
    } else {
        0.0
    };

    ScorecardSummary {
        bullish_count,
        bearish_count,
        neutral_count,
        weighted_vote,
    }
}
