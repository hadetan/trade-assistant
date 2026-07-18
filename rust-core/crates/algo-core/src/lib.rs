mod algorithm;
pub mod confluence;
mod indicators;
pub mod registry;

pub use algorithm::{
    classify_by_distance, AlgoOutput, Algorithm, Direction, Horizon, MarketContext, Timeframe,
};
pub use indicators::{EmaAlgorithm, RsiAlgorithm, SmaAlgorithm};
