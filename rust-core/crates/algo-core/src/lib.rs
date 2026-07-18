mod algorithm;
mod indicators;

pub use algorithm::{
    classify_by_distance, AlgoOutput, Algorithm, Direction, Horizon, MarketContext, Timeframe,
};
pub use indicators::SmaAlgorithm;
