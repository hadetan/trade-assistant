use crate::{
    classify_by_distance, relative_magnitude, AlgoOutput, Algorithm, Direction, Horizon,
    MarketContext,
};
use rust_ti::trend_indicators::single::{
    long_parabolic_time_price_system, short_parabolic_time_price_system,
};

const AF_START: f64 = 0.02;
const AF_STEP: f64 = 0.02;
const AF_MAX: f64 = 0.2;

pub struct PsarAlgorithm {
    lookback: usize,
}

impl PsarAlgorithm {
    pub fn new(lookback: usize) -> Self {
        Self { lookback }
    }
}

impl Algorithm for PsarAlgorithm {
    fn id(&self) -> &'static str {
        "psar"
    }

    fn required_lookback(&self) -> usize {
        self.lookback
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> AlgoOutput {
        if ctx.highs.len() < self.lookback || ctx.lows.len() < self.lookback {
            return AlgoOutput {
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

        let sar = psar_series(&ctx.highs, &ctx.lows);
        let current_sar = *sar.last().unwrap();
        let latest_close = *ctx.closes.last().unwrap();

        let (direction, confidence) = classify_by_distance(latest_close, current_sar);
        let magnitude = relative_magnitude(latest_close, current_sar);

        AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude,
            confidence,
            evidence: vec![format!(
                "SAR {:.4} vs close {:.4}",
                current_sar, latest_close
            )],
            computed_at: ctx.as_of,
        }
    }
}

/// Wilder's Parabolic SAR. `rust_ti`'s own `bulk::parabolic_time_price_system`
/// updates EP/AF for a bar *before* using them to compute that same bar's SAR
/// (rather than carrying them over to the next bar), which does not match
/// Wilder's original ordering -- so the outer EP/AF/reversal state machine is
/// hand-rolled here around `rust_ti`'s per-step formula+clamp primitives.
fn psar_series(highs: &[f64], lows: &[f64]) -> Vec<f64> {
    let len = highs.len();
    let mut sar = Vec::with_capacity(len);
    let mut is_long = true;
    let mut af = AF_START;
    let mut ep = highs[0];
    sar.push(lows[0]);

    for i in 1..len {
        let prev_sar = sar[i - 1];
        let mut next_sar = if is_long {
            long_parabolic_time_price_system(prev_sar, ep, af, lows[i])
        } else {
            short_parabolic_time_price_system(prev_sar, ep, af, highs[i])
        };

        if is_long && lows[i] < next_sar {
            is_long = false;
            next_sar = ep;
            ep = lows[i];
            af = AF_START;
        } else if !is_long && highs[i] > next_sar {
            is_long = true;
            next_sar = ep;
            ep = highs[i];
            af = AF_START;
        } else if is_long && highs[i] > ep {
            ep = highs[i];
            af = (af + AF_STEP).min(AF_MAX);
        } else if !is_long && lows[i] < ep {
            ep = lows[i];
            af = (af + AF_STEP).min(AF_MAX);
        }

        sar.push(next_sar);
    }

    sar
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Timeframe;
    use chrono::{DateTime, Utc};

    #[test]
    fn psar_seed_and_first_step_match_wilder_init() {
        // Wilder init anchor: SAR0 = low[0] = 8.0, EP = high[0] = 10.0,
        // AF = 0.02 => SAR1 = 8 + 0.02*(10-8) = 8.04.
        let highs: Vec<f64> = (0..5).map(|i| 10.0 + i as f64).collect();
        let lows: Vec<f64> = (0..5).map(|i| 8.0 + i as f64).collect();

        let sar = psar_series(&highs, &lows);

        assert_eq!(sar[0], 8.0);
        assert!((sar[1] - 8.04).abs() < 1e-12);
    }

    #[test]
    fn psar_uptrend_ramp_stays_bullish() {
        let highs: Vec<f64> = (0..15).map(|i| 10.0 + i as f64).collect();
        let lows: Vec<f64> = (0..15).map(|i| 8.0 + i as f64).collect();
        let closes: Vec<f64> = highs
            .iter()
            .zip(lows.iter())
            .map(|(h, l)| (h + l) / 2.0)
            .collect();
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = MarketContext {
            symbol: "TEST".into(),
            timeframe: Timeframe::Day,
            horizon: Horizon::Positional,
            closes,
            opens: Vec::new(),
            highs,
            lows,
            volumes: Vec::new(),
            timestamps: Vec::new(),
            options: None,
            chain: None,
            peer: None,
            higher_tf: None,
            as_of,
        };

        let algo = PsarAlgorithm::new(5);
        let output = algo.compute(&ctx);

        assert_eq!(output.direction, Direction::Bullish);
        let sar = psar_series(&ctx.highs, &ctx.lows);
        let expected_magnitude = relative_magnitude(*ctx.closes.last().unwrap(), *sar.last().unwrap());
        assert!((output.magnitude - expected_magnitude).abs() < 1e-9);
    }

    #[test]
    fn short_history_is_a_neutral_no_op() {
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = MarketContext {
            symbol: "TEST".into(),
            timeframe: Timeframe::Day,
            horizon: Horizon::Positional,
            closes: vec![10.5, 11.5],
            opens: Vec::new(),
            highs: vec![11.0, 12.0],
            lows: vec![10.0, 11.0],
            volumes: Vec::new(),
            timestamps: Vec::new(),
            options: None,
            chain: None,
            peer: None,
            higher_tf: None,
            as_of,
        };

        let algo = PsarAlgorithm::new(5);
        let output = algo.compute(&ctx);

        assert_eq!(output.direction, Direction::Neutral);
        assert_eq!(output.magnitude, 0.0);
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(PsarAlgorithm::new(5)))
}
