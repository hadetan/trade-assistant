use algo_core::benchmark_classify::{classify_decision, Outcome, DEFAULT_NEUTRAL_BAND};
use algo_core::Direction;

#[test]
fn bullish_with_a_positive_return_is_correct() {
    assert_eq!(classify_decision(Direction::Bullish, 0.05, DEFAULT_NEUTRAL_BAND), Outcome::Correct);
}

#[test]
fn bullish_with_a_negative_return_is_incorrect() {
    assert_eq!(classify_decision(Direction::Bullish, -0.05, DEFAULT_NEUTRAL_BAND), Outcome::Incorrect);
}

#[test]
fn bearish_with_a_negative_return_is_correct() {
    assert_eq!(classify_decision(Direction::Bearish, -0.05, DEFAULT_NEUTRAL_BAND), Outcome::Correct);
}

#[test]
fn neutral_direction_is_always_neutral_regardless_of_return() {
    assert_eq!(classify_decision(Direction::Neutral, 0.42, DEFAULT_NEUTRAL_BAND), Outcome::Neutral);
    assert_eq!(classify_decision(Direction::Neutral, -0.42, DEFAULT_NEUTRAL_BAND), Outcome::Neutral);
}

#[test]
fn a_tiny_return_within_the_band_is_neutral_even_for_a_directional_call() {
    assert_eq!(classify_decision(Direction::Bullish, 0.0005, DEFAULT_NEUTRAL_BAND), Outcome::Neutral);
}

#[test]
fn a_return_exactly_at_the_band_edge_is_neutral() {
    // realized_return.abs() == neutral_band -> Neutral (inclusive `<=`).
    assert_eq!(classify_decision(Direction::Bullish, DEFAULT_NEUTRAL_BAND, DEFAULT_NEUTRAL_BAND), Outcome::Neutral);
    assert_eq!(classify_decision(Direction::Bearish, -DEFAULT_NEUTRAL_BAND, DEFAULT_NEUTRAL_BAND), Outcome::Neutral);
}
