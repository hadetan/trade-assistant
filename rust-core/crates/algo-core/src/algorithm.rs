use crate::options::context::{HigherTfSeries, OptionChainSnapshot, OptionsContext, PeerSeries};
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
/// every algorithm can rely on; `opens`/`highs`/`lows`/`volumes`/`timestamps`
/// are aligned 1:1 with `closes` when the caller has OHLCV data (backtest),
/// else empty (e.g. the closes-only live sidecar path, Q2) -- so any
/// algorithm reading them MUST guard on their length first (see the no-op
/// guard convention in the algorithm-catalog plan). `options`/`chain`/`peer`/
/// `higher_tf` are likewise absent unless the caller has that context.
pub struct MarketContext {
    pub symbol: String,
    pub timeframe: Timeframe,
    pub horizon: Horizon,
    pub closes: Vec<f64>,
    pub opens: Vec<f64>,
    pub highs: Vec<f64>,
    pub lows: Vec<f64>,
    pub volumes: Vec<f64>,
    /// Absolute Unix epoch per bar (e.g. session-anchored VWAP resets).
    pub timestamps: Vec<i64>,
    /// Greeks/IV/OI-buildup input.
    pub options: Option<OptionsContext>,
    /// PCR/Max-Pain input.
    pub chain: Option<OptionChainSnapshot>,
    /// Cointegration/OU spread's second leg.
    pub peer: Option<PeerSeries>,
    /// Forward-filled higher-timeframe closes for MTF confluence.
    pub higher_tf: Option<HigherTfSeries>,
    /// The evaluation instant: the live wall-clock at the I/O boundary in
    /// production, or the replay frontier's simulated time during backtest.
    /// Supplied by the caller so `compute()` stays pure and replayed
    /// decisions carry their historical timestamp, not today's.
    pub as_of: DateTime<Utc>,
}

impl MarketContext {
    /// Preserves the Phase-1 shape (closes-only): empty OHLCV series and
    /// `None` for every options/peer/MTF extra. For callers and tests that
    /// only ever populated `closes`.
    pub fn from_closes(
        symbol: impl Into<String>,
        timeframe: Timeframe,
        horizon: Horizon,
        closes: Vec<f64>,
        as_of: DateTime<Utc>,
    ) -> Self {
        Self {
            symbol: symbol.into(),
            timeframe,
            horizon,
            closes,
            opens: Vec::new(),
            highs: Vec::new(),
            lows: Vec::new(),
            volumes: Vec::new(),
            timestamps: Vec::new(),
            options: None,
            chain: None,
            peer: None,
            higher_tf: None,
            as_of,
        }
    }
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
    /// Precondition: `ctx.closes.len() >= self.required_lookback()`. Implementations
    /// may panic (slice underflow) if called with less history. Callers MUST NOT
    /// call this directly — route through `registry::run_applicable`, which gates
    /// every algorithm on this precondition in one place.
    fn compute(&self, ctx: &MarketContext) -> AlgoOutput;
}

/// Direction + confidence from how far the latest close sits from a baseline
/// (e.g. a moving average). Shared by price-vs-MA indicators; RSI and other
/// non-baseline indicators classify differently and do not use this.
pub fn classify_by_distance(latest_close: f64, baseline: f64) -> (Direction, f64) {
    if baseline.abs() < 1e-12 {
        // A zero/near-zero baseline would divide into inf/NaN below,
        // producing a spurious direction and a confidence that pollutes
        // downstream confluence weights. No baseline means no opinion.
        return (Direction::Neutral, 0.0);
    }
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

/// `|latest_close - baseline| / baseline`, guarded against a zero/near-zero
/// baseline the same way `classify_by_distance` guards its own division.
/// SMA/EMA compute their `magnitude` field independently of
/// `classify_by_distance`'s confidence, via the same division, so they share
/// this helper rather than each re-deriving the guard.
pub fn relative_magnitude(latest_close: f64, baseline: f64) -> f64 {
    if baseline.abs() < 1e-12 {
        return 0.0;
    }
    ((latest_close - baseline) / baseline).abs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_by_distance_guards_against_zero_baseline() {
        // A zero baseline would otherwise divide (latest_close - 0.0) / 0.0
        // into inf/NaN, producing a spurious Bearish direction and a NaN
        // confidence that pollutes downstream confluence weights.
        let (direction, confidence) = classify_by_distance(5.0, 0.0);

        assert_eq!(direction, Direction::Neutral);
        assert_eq!(confidence, 0.0);
        assert!(!confidence.is_nan());
    }

    #[test]
    fn relative_magnitude_guards_against_zero_baseline() {
        let magnitude = relative_magnitude(5.0, 0.0);

        assert_eq!(magnitude, 0.0);
        assert!(!magnitude.is_nan());
    }
}
