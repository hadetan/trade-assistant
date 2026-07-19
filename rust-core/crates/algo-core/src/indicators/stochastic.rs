use yata::core::Method;
use yata::methods::{Highest, Lowest};

use crate::{Algorithm, Direction, Horizon, MarketContext};

pub struct StochasticAlgorithm {
    k_period: usize,
    d_period: usize,
}

impl StochasticAlgorithm {
    pub fn new(k_period: usize, d_period: usize) -> Self {
        Self { k_period, d_period }
    }
}

impl Algorithm for StochasticAlgorithm {
    fn id(&self) -> &'static str {
        "stochastic"
    }

    fn required_lookback(&self) -> usize {
        self.k_period + self.d_period - 1
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        if ctx.highs.len() < self.required_lookback()
            || ctx.lows.len() < self.required_lookback()
            || ctx.closes.len() < self.required_lookback()
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

        let (k, d) = fast_stochastic(
            &ctx.highs,
            &ctx.lows,
            &ctx.closes,
            self.k_period,
            self.d_period,
        );
        let direction = classify_stochastic(k);
        let confidence = ((k - 50.0).abs() / 50.0).min(1.0);

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude: (k - 50.0).abs(),
            confidence,
            evidence: vec![format!(
                "%K({}) = {:.2}, %D({}) = {:.2}",
                self.k_period, k, self.d_period, d
            )],
            computed_at: ctx.as_of,
        }
    }
}

fn classify_stochastic(k: f64) -> Direction {
    if k > 80.0 {
        Direction::Bearish
    } else if k < 20.0 {
        Direction::Bullish
    } else {
        Direction::Neutral
    }
}

/// rust_ti's `stochastic_oscillator` only takes one `prices` slice and derives
/// both the high and the low from that same series, so it can't express the
/// classic 3-series (high/low/close) Fast %K this brief calls for. yata's
/// `Highest`/`Lowest` methods give the correct rolling HH/LL windows instead
/// (its bundled `StochasticOscillator` indicator bakes in an extra smoothing
/// pass on %K that this brief's formula doesn't call for, so we drive the
/// building blocks directly rather than that indicator).
fn fast_stochastic(
    highs: &[f64],
    lows: &[f64],
    closes: &[f64],
    k_period: usize,
    d_period: usize,
) -> (f64, f64) {
    let mut highest = Highest::new(k_period as yata::core::PeriodType, &highs[0]).unwrap();
    let mut lowest = Lowest::new(k_period as yata::core::PeriodType, &lows[0]).unwrap();

    let hh: Vec<f64> = highs.iter().map(|h| highest.next(h)).collect();
    let ll: Vec<f64> = lows.iter().map(|l| lowest.next(l)).collect();

    let n = closes.len();
    let k_values: Vec<f64> = ((n - d_period)..n)
        .map(|i| {
            let (h, l, c) = (hh[i], ll[i], closes[i]);
            if (h - l).abs() < 1e-12 {
                50.0
            } else {
                (c - l) / (h - l) * 100.0
            }
        })
        .collect();

    let d = k_values.iter().sum::<f64>() / d_period as f64;
    (*k_values.last().unwrap(), d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_stochastic_flags_overbought_and_oversold() {
        assert_eq!(classify_stochastic(85.0), Direction::Bearish);
        assert_eq!(classify_stochastic(15.0), Direction::Bullish);
        assert_eq!(classify_stochastic(50.0), Direction::Neutral);
    }

    #[test]
    fn fast_stochastic_matches_hand_computed_k() {
        // last 3 bars: high=[12,13,14], low=[10,11,9], close=13
        // HH=14, LL=9 -> %K = (13-9)/(14-9)*100 = 80.0
        let mut highs = vec![12.0; 13];
        highs.extend([12.0, 13.0, 14.0]);
        let mut lows = vec![10.0; 13];
        lows.extend([10.0, 11.0, 9.0]);
        let mut closes = vec![12.0; 15];
        closes.push(13.0);

        let (k, _d) = fast_stochastic(&highs, &lows, &closes, 14, 3);

        assert!((k - 80.0).abs() < 1e-9);
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(StochasticAlgorithm::new(14, 3)))
}
