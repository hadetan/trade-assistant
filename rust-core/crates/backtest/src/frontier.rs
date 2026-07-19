use algo_core::{Horizon, MarketContext, Timeframe};
use chrono::DateTime;
use storage::Candle;

/// Build the `MarketContext` visible at frontier index `i`: exactly the closes of
/// `series[0..=i]`, with `as_of` set to bar i's timestamp as absolute UTC — never
/// the wall clock, never a future bar (anti-lookahead, design §6.4).
pub fn context_at(
    series: &[Candle],
    frontier_index: usize,
    symbol: &str,
    timeframe: Timeframe,
    horizon: Horizon,
) -> MarketContext {
    let closes = series[..=frontier_index].iter().map(|c| c.close).collect();
    let as_of = DateTime::from_timestamp(series[frontier_index].ts, 0)
        .expect("candle ts is a valid Unix epoch");
    MarketContext { symbol: symbol.to_string(), timeframe, horizon, closes, as_of }
}
