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
    let window = &series[..=frontier_index];
    let closes = window.iter().map(|c| c.close).collect();
    let opens = window.iter().map(|c| c.open).collect();
    let highs = window.iter().map(|c| c.high).collect();
    let lows = window.iter().map(|c| c.low).collect();
    let volumes = window.iter().map(|c| c.volume as f64).collect();
    let timestamps = window.iter().map(|c| c.ts).collect();
    let as_of = DateTime::from_timestamp(series[frontier_index].ts, 0)
        .expect("candle ts is a valid Unix epoch");
    MarketContext {
        symbol: symbol.to_string(),
        timeframe,
        horizon,
        closes,
        opens,
        highs,
        lows,
        volumes,
        timestamps,
        options: None,
        chain: None,
        peer: None,
        higher_tf: None,
        as_of,
    }
}
