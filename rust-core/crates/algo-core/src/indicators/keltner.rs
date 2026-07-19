use crate::{classify_by_distance, relative_magnitude, Algorithm, Direction, Horizon, MarketContext};

pub struct KeltnerAlgorithm {
    ema_period: usize,
    atr_period: usize,
    multiplier: f64,
}

impl KeltnerAlgorithm {
    pub fn new(ema_period: usize, atr_period: usize, multiplier: f64) -> Self {
        Self {
            ema_period,
            atr_period,
            multiplier,
        }
    }
}

impl Algorithm for KeltnerAlgorithm {
    fn id(&self) -> &'static str {
        "keltner"
    }

    fn required_lookback(&self) -> usize {
        self.ema_period
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        if ctx.highs.len() < self.required_lookback() || ctx.lows.len() < self.required_lookback()
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

        let mid = ema_of_closes(&ctx.closes, self.ema_period);
        let atr = average_true_range(&ctx.closes, &ctx.highs, &ctx.lows, self.atr_period);
        let band = self.multiplier * atr;
        let upper = mid + band;
        let lower = mid - band;
        let latest_close = *ctx.closes.last().unwrap();

        let (direction, confidence) = if latest_close > upper {
            (Direction::Bullish, 1.0)
        } else if latest_close < lower {
            (Direction::Bearish, 1.0)
        } else {
            classify_by_distance(latest_close, mid)
        };
        let magnitude = relative_magnitude(latest_close, mid);

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude,
            confidence,
            evidence: vec![format!(
                "close {:.2} vs mid {:.2}, bands [{:.2}, {:.2}]",
                latest_close, mid, lower, upper
            )],
            computed_at: ctx.as_of,
        }
    }
}

/// Same seeded-SMA-then-recursive form as the `ema` indicator (mid is
/// EMA20(close), not the typical-price average rust_ti's own
/// `keltner_channel` bakes in), duplicated locally since algo structs and
/// their helpers stay private per module.
fn ema_of_closes(closes: &[f64], period: usize) -> f64 {
    let k = 2.0 / (period as f64 + 1.0);
    let mut ema = closes[..period].iter().sum::<f64>() / period as f64;

    for close in &closes[period..] {
        ema = (close - ema) * k + ema;
    }

    ema
}

/// Wilder's original ATR smoothing (the same recursive form the `rsi`
/// indicator uses): seed with the SMA of the first `period` true ranges,
/// then smooth every later true range with weight `(period - 1) / period`
/// on the running average. rust_ti's `average_true_range` expects the
/// `close` slice pre-shifted to "previous close" aligned with the current
/// bar's high/low; its own `keltner_channel` doesn't do that shift, so
/// feeding it matched-index arrays degenerates every true range to a bare
/// `high - low`, silently dropping overnight gaps -- hand-rolled here to
/// keep gaps in the calculation.
fn average_true_range(closes: &[f64], highs: &[f64], lows: &[f64], period: usize) -> f64 {
    let true_ranges: Vec<f64> = (1..closes.len())
        .map(|i| {
            let prev_close = closes[i - 1];
            let high_low = highs[i] - lows[i];
            let high_close = (highs[i] - prev_close).abs();
            let low_close = (lows[i] - prev_close).abs();
            high_low.max(high_close).max(low_close)
        })
        .collect();

    let mut atr = true_ranges[..period].iter().sum::<f64>() / period as f64;
    for tr in &true_ranges[period..] {
        atr = (atr * (period as f64 - 1.0) + tr) / period as f64;
    }

    atr
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(KeltnerAlgorithm::new(20, 10, 2.0)))
}
