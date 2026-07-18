use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Bullish,
    Bearish,
    Neutral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Horizon {
    Intraday,
    Positional,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Timeframe {
    Minute,
    FiveMinute,
    FifteenMinute,
    Day,
}

/// What an `Algorithm::compute()` call needs. `closes` is the only series
/// Phase 1's indicators read; later phases extend this with open/high/low/
/// volume/oi as new algorithms need them.
pub struct MarketContext {
    pub symbol: String,
    pub timeframe: Timeframe,
    pub horizon: Horizon,
    pub closes: Vec<f64>,
    /// The evaluation instant: the live wall-clock at the I/O boundary in
    /// production, or the replay frontier's simulated time during backtest.
    /// Supplied by the caller so `compute()` stays pure and replayed
    /// decisions carry their historical timestamp, not today's.
    pub as_of: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct AlgoOutput {
    pub algo_id: &'static str,
    pub symbol: String,
    pub timeframe: Timeframe,
    pub horizon: Horizon,
    pub direction: Direction,
    pub magnitude: f64,
    pub confidence: f64,
    pub evidence: Vec<String>,
    pub computed_at: DateTime<Utc>,
}

pub trait Algorithm: Send + Sync {
    fn id(&self) -> &'static str;
    fn required_lookback(&self) -> usize;
    fn applicable_horizons(&self) -> &'static [Horizon];
    fn compute(&self, ctx: &MarketContext) -> AlgoOutput;
}

/// Direction + confidence from how far the latest close sits from a baseline
/// (e.g. a moving average). Shared by price-vs-MA indicators; RSI and other
/// non-baseline indicators classify differently and do not use this.
pub fn classify_by_distance(latest_close: f64, baseline: f64) -> (Direction, f64) {
    let distance = (latest_close - baseline) / baseline;
    let direction = if distance.abs() < 1e-6 {
        Direction::Neutral
    } else if distance > 0.0 {
        Direction::Bullish
    } else {
        Direction::Bearish
    };
    (direction, distance.abs().min(1.0))
}
