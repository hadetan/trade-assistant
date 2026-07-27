mod algorithm;
pub mod confluence;
mod forecast;
mod indicators;
mod options;
mod quant;
pub mod registry;
pub mod scan_gate;

pub use algorithm::{
    classify_by_distance, relative_magnitude, AlgoOutput, Algorithm, Direction, Horizon,
    MarketContext, Timeframe,
};
pub use indicators::{EmaAlgorithm, RsiAlgorithm, SmaAlgorithm};
pub use options::context::{HigherTfSeries, OptionChainSnapshot, OptionsContext, PeerSeries, StrikeRow};
#[cfg(feature = "kronos")]
pub use forecast::kronos::{KronosAlgorithm, KronosForecast};
