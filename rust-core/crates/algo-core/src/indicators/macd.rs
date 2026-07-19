use crate::{Algorithm, Direction, Horizon, MarketContext};
use yata::core::{Candle, IndicatorConfig};
use yata::helpers::MA;
use yata::indicators::MACD;

pub struct MacdAlgorithm {
    fast: u8,
    slow: u8,
    signal: u8,
}

impl MacdAlgorithm {
    pub fn new(fast: u8, slow: u8, signal: u8) -> Self {
        Self { fast, slow, signal }
    }
}

impl Algorithm for MacdAlgorithm {
    fn id(&self) -> &'static str {
        "macd"
    }

    fn required_lookback(&self) -> usize {
        self.slow as usize + self.signal as usize
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        let (macd_line, signal, histogram) =
            macd_values(&ctx.closes, self.fast, self.slow, self.signal);

        let direction = if histogram > 0.0 {
            Direction::Bullish
        } else if histogram < 0.0 {
            Direction::Bearish
        } else {
            Direction::Neutral
        };

        let latest_close = *ctx.closes.last().unwrap();
        // Histogram is in price units, not a ratio -- scale by the latest
        // close so confidence stays comparable across symbols at different
        // price levels, same zero-guard convention as classify_by_distance.
        let confidence = if latest_close.abs() < 1e-12 {
            0.0
        } else {
            (histogram.abs() / latest_close.abs()).min(1.0)
        };

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude: histogram.abs(),
            confidence,
            evidence: vec![format!(
                "MACD({},{},{}) line {:.4} vs signal {:.4} (hist {:.4})",
                self.fast, self.slow, self.signal, macd_line, signal, histogram
            )],
            computed_at: ctx.as_of,
        }
    }
}

/// yata's `EMA` seeds from the first data point and rolls forward per bar
/// (not an SMA-of-first-`period` seed) -- the standard MACD convention, and
/// the only one of the two candidate seedings (rust_ti's windowed EMA vs.
/// this) that produces a non-zero histogram on a perfectly linear ramp;
/// rust_ti's `standard_indicators::single::macd` also hard-requires exactly
/// 34 prices, incompatible with this algorithm's variable-length lookback.
fn macd_values(closes: &[f64], fast: u8, slow: u8, signal: u8) -> (f64, f64, f64) {
    let candles: Vec<Candle> = closes.iter().map(|&c| (c, c, c, c).into()).collect();
    let cfg = MACD {
        ma1: MA::EMA(fast),
        ma2: MA::EMA(slow),
        signal: MA::EMA(signal),
        ..MACD::default()
    };

    let results = cfg
        .over(&candles)
        .expect("fast < slow and both periods > 1, so MACD config is always valid");
    let last = results
        .last()
        .expect("closes is non-empty, guarded by required_lookback via run_applicable");

    let macd_line = last.value(0);
    let signal_line = last.value(1);
    (macd_line, signal_line, macd_line - signal_line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Timeframe;
    use chrono::{DateTime, Utc};

    #[test]
    fn macd_flat_series_is_neutral_zero() {
        let algo = MacdAlgorithm::new(12, 26, 9);
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = MarketContext::from_closes(
            "TEST",
            Timeframe::Day,
            Horizon::Positional,
            vec![5.0; 40],
            as_of,
        );

        let output = algo.compute(&ctx);

        assert_eq!(output.magnitude, 0.0);
        assert_eq!(output.direction, Direction::Neutral);
        assert_eq!(output.computed_at, as_of);
    }

    #[test]
    fn macd_rising_ramp_is_bullish() {
        let algo = MacdAlgorithm::new(12, 26, 9);
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let closes: Vec<f64> = (1..=40).map(|i| i as f64).collect();
        let ctx =
            MarketContext::from_closes("TEST", Timeframe::Day, Horizon::Positional, closes, as_of);

        let output = algo.compute(&ctx);

        assert_eq!(output.direction, Direction::Bullish);
        assert!(output.magnitude > 0.0);
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(MacdAlgorithm::new(12, 26, 9)))
}
