use crate::{classify_by_distance, relative_magnitude, Algorithm, Direction, Horizon, MarketContext};
use chrono::{FixedOffset, NaiveDate, TimeZone};

pub struct VwapAlgorithm;

impl VwapAlgorithm {
    pub fn new() -> Self {
        Self
    }
}

impl Default for VwapAlgorithm {
    fn default() -> Self {
        Self::new()
    }
}

impl Algorithm for VwapAlgorithm {
    fn id(&self) -> &'static str {
        "vwap"
    }

    fn required_lookback(&self) -> usize {
        1
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        let lookback = self.required_lookback();
        if ctx.highs.len() < lookback
            || ctx.lows.len() < lookback
            || ctx.closes.len() < lookback
            || ctx.volumes.len() < lookback
            || ctx.timestamps.len() < lookback
        {
            return crate::AlgoOutput {
                algo_id: self.id(),
                symbol: ctx.symbol.clone(),
                timeframe: ctx.timeframe,
                horizon: ctx.horizon,
                direction: Direction::Neutral,
                magnitude: 0.0,
                confidence: 0.0,
                evidence: vec!["insufficient OHLCV".into()],
                computed_at: ctx.as_of,
            };
        }

        let vwap = match session_vwap(&ctx.highs, &ctx.lows, &ctx.closes, &ctx.volumes, &ctx.timestamps) {
            Some(vwap) => vwap,
            // Illiquid strike / halted symbol / synthetic pre-market bar: v_sum==0
            // would make pv_sum/v_sum a NaN that classify_by_distance's zero-baseline
            // guard can't catch (NaN.abs() < 1e-12 is false), fabricating a
            // maximally-confident Bearish signal into the confluence engine.
            None => {
                return crate::AlgoOutput {
                    algo_id: self.id(),
                    symbol: ctx.symbol.clone(),
                    timeframe: ctx.timeframe,
                    horizon: ctx.horizon,
                    direction: Direction::Neutral,
                    magnitude: 0.0,
                    confidence: 0.0,
                    evidence: vec!["zero session volume".into()],
                    computed_at: ctx.as_of,
                };
            }
        };
        let latest_close = *ctx.closes.last().unwrap();

        let (direction, confidence) = classify_by_distance(latest_close, vwap);
        let magnitude = relative_magnitude(latest_close, vwap);

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude,
            confidence,
            evidence: vec![format!(
                "close {:.2} vs session VWAP {:.2}",
                latest_close, vwap
            )],
            computed_at: ctx.as_of,
        }
    }
}

// IST carries no DST, so a fixed +05:30 offset is exact for every bar --
// bucketing by this calendar date is equivalent to anchoring at the 09:15
// IST session open, since the open is the first bar of each such bucket.
fn ist_session_date(ts: i64) -> NaiveDate {
    let ist = FixedOffset::east_opt(5 * 3600 + 30 * 60).unwrap();
    ist.timestamp_opt(ts, 0).unwrap().date_naive()
}

fn session_vwap(
    highs: &[f64],
    lows: &[f64],
    closes: &[f64],
    volumes: &[f64],
    timestamps: &[i64],
) -> Option<f64> {
    let n = closes.len();
    let current_session = ist_session_date(timestamps[n - 1]);

    let session_start = (0..n)
        .rev()
        .find(|&i| ist_session_date(timestamps[i]) != current_session)
        .map(|i| i + 1)
        .unwrap_or(0);

    let mut pv_sum = 0.0;
    let mut v_sum = 0.0;
    for i in session_start..n {
        let tp = (highs[i] + lows[i] + closes[i]) / 3.0;
        pv_sum += tp * volumes[i];
        v_sum += volumes[i];
    }

    if v_sum <= 0.0 {
        return None;
    }
    Some(pv_sum / v_sum)
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(VwapAlgorithm::new()))
}
