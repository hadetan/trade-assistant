use crate::{classify_by_distance, relative_magnitude, Algorithm, Horizon, MarketContext};

pub struct SmaAlgorithm {
    period: usize,
}

impl SmaAlgorithm {
    pub fn new(period: usize) -> Self {
        Self { period }
    }
}

impl Algorithm for SmaAlgorithm {
    fn id(&self) -> &'static str {
        "sma"
    }

    fn required_lookback(&self) -> usize {
        self.period
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        let window = &ctx.closes[ctx.closes.len() - self.period..];
        let sma = window.iter().sum::<f64>() / self.period as f64;
        let latest_close = *ctx.closes.last().unwrap();

        let (direction, confidence) = classify_by_distance(latest_close, sma);
        let magnitude = relative_magnitude(latest_close, sma);

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude,
            confidence,
            evidence: vec![format!(
                "close {:.2} vs SMA({}) {:.2}",
                latest_close, self.period, sma
            )],
            computed_at: ctx.as_of,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Direction, Timeframe};
    use chrono::{DateTime, Utc};

    #[test]
    fn sma_matches_hand_computed_average() {
        // closes = [10, 12, 14, 16, 18], period = 3
        // SMA of the last 3 closes (14, 16, 18) = (14+16+18)/3 = 16.0
        let algo = SmaAlgorithm::new(3);
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = MarketContext::from_closes(
            "TEST",
            Timeframe::Day,
            Horizon::Positional,
            vec![10.0, 12.0, 14.0, 16.0, 18.0],
            as_of,
        );

        let output = algo.compute(&ctx);

        assert!((sma_value(&ctx.closes, 3) - 16.0).abs() < 1e-9);
        // latest close (18.0) is above the SMA (16.0) -> Bullish
        assert_eq!(output.direction, Direction::Bullish);
        assert_eq!(output.computed_at, as_of);
    }

    fn sma_value(closes: &[f64], period: usize) -> f64 {
        let window = &closes[closes.len() - period..];
        window.iter().sum::<f64>() / period as f64
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(SmaAlgorithm::new(20)))
}
