use crate::{Algorithm, Direction, Horizon, MarketContext};

pub struct RocAlgorithm {
    period: usize,
}

impl RocAlgorithm {
    pub fn new(period: usize) -> Self {
        Self { period }
    }
}

impl Algorithm for RocAlgorithm {
    fn id(&self) -> &'static str {
        "roc"
    }

    fn required_lookback(&self) -> usize {
        self.period + 1
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        let current_price = *ctx.closes.last().unwrap();
        let previous_price = ctx.closes[ctx.closes.len() - 1 - self.period];
        let roc = rust_ti::momentum_indicators::single::rate_of_change(current_price, previous_price);

        let direction = if roc > 0.0 {
            Direction::Bullish
        } else if roc < 0.0 {
            Direction::Bearish
        } else {
            Direction::Neutral
        };
        let confidence = (roc.abs() / 100.0).min(1.0);

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude: roc.abs(),
            confidence,
            evidence: vec![format!("ROC({}) = {:.4}%", self.period, roc)],
            computed_at: ctx.as_of,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Timeframe;
    use chrono::{DateTime, Utc};

    #[test]
    fn roc_matches_hand_computed_rate_of_change() {
        // closes = [10, 11, 12, 13, 14], period = 2
        // ROC = (14 - 12) / 12 * 100 = 16.6667
        let algo = RocAlgorithm::new(2);
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = MarketContext::from_closes(
            "TEST",
            Timeframe::Day,
            Horizon::Positional,
            vec![10.0, 11.0, 12.0, 13.0, 14.0],
            as_of,
        );

        let output = algo.compute(&ctx);

        assert!((output.magnitude - 16.666666666666664).abs() < 1e-9);
        assert_eq!(output.direction, Direction::Bullish);
        assert_eq!(output.computed_at, as_of);
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(RocAlgorithm::new(12)))
}
