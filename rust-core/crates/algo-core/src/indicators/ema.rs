use crate::{classify_by_distance, Algorithm, Horizon, MarketContext};

pub struct EmaAlgorithm {
    period: usize,
}

impl EmaAlgorithm {
    pub fn new(period: usize) -> Self {
        Self { period }
    }
}

impl Algorithm for EmaAlgorithm {
    fn id(&self) -> &'static str {
        "ema"
    }

    fn required_lookback(&self) -> usize {
        self.period
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        let ema = ema_series(&ctx.closes, self.period);
        let latest_close = *ctx.closes.last().unwrap();

        let (direction, confidence) = classify_by_distance(latest_close, ema);
        let magnitude = ((latest_close - ema) / ema).abs();

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude,
            confidence,
            evidence: vec![format!(
                "close {:.2} vs EMA({}) {:.2}",
                latest_close, self.period, ema
            )],
            computed_at: ctx.as_of,
        }
    }
}

/// Standard EMA: seed with the SMA of the first `period` values, then
/// apply the standard multiplier `2 / (period + 1)` to every value after.
fn ema_series(closes: &[f64], period: usize) -> f64 {
    let k = 2.0 / (period as f64 + 1.0);
    let mut ema = closes[..period].iter().sum::<f64>() / period as f64;

    for close in &closes[period..] {
        ema = (close - ema) * k + ema;
    }

    ema
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Direction, Timeframe};
    use chrono::{DateTime, Utc};

    #[test]
    fn ema_matches_hand_computed_series() {
        // closes = [10, 11, 12, 13, 14], period = 3, multiplier k = 2/(3+1) = 0.5
        // seed EMA = SMA of first 3 closes (10, 11, 12) = 11.0
        // EMA at close=13: (13 - 11.0) * 0.5 + 11.0 = 12.0
        // EMA at close=14: (14 - 12.0) * 0.5 + 12.0 = 13.0  <- final expected value
        let algo = EmaAlgorithm::new(3);
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = MarketContext {
            symbol: "TEST".to_string(),
            timeframe: Timeframe::Day,
            horizon: Horizon::Positional,
            closes: vec![10.0, 11.0, 12.0, 13.0, 14.0],
            as_of,
        };

        let output = algo.compute(&ctx);

        // latest close (14.0) is above the EMA (13.0) -> Bullish
        assert_eq!(output.direction, Direction::Bullish);
        assert!(output.evidence[0].contains("13.00"));
        assert_eq!(output.computed_at, as_of);
    }
}
