use crate::Direction;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Correct,
    Incorrect,
    Neutral,
}

/// A realized return whose absolute value is within this band of zero is a
/// "flat market, no real move" -- classified Neutral even for a directional
/// call. 0.1%, a starting default following the DIRECTION_DEADBAND = 0.05
/// precedent in deterministicResponseGenerator.ts. Not a locked constant
/// needing a config UI in this phase.
pub const DEFAULT_NEUTRAL_BAND: f64 = 0.001;

pub fn classify_decision(direction: Direction, realized_return: f64, neutral_band: f64) -> Outcome {
    // A neutral call is never right or wrong about a move it did not predict.
    if direction == Direction::Neutral {
        return Outcome::Neutral;
    }
    // A directional call in a market that barely moved is a non-event, not a
    // hit or a miss -- scored Neutral so a flat tape does not inflate either count.
    if realized_return.abs() <= neutral_band {
        return Outcome::Neutral;
    }
    let matches = match direction {
        Direction::Bullish => realized_return > 0.0,
        Direction::Bearish => realized_return < 0.0,
        Direction::Neutral => unreachable!("handled above"),
    };
    if matches {
        Outcome::Correct
    } else {
        Outcome::Incorrect
    }
}
