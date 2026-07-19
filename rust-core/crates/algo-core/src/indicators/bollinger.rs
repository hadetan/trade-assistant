use crate::{classify_by_distance, relative_magnitude, Algorithm, Horizon, MarketContext};

pub struct BollingerAlgorithm {
    period: usize,
}

impl BollingerAlgorithm {
    pub fn new(period: usize) -> Self {
        Self { period }
    }
}

impl Algorithm for BollingerAlgorithm {
    fn id(&self) -> &'static str {
        "bollinger"
    }

    fn required_lookback(&self) -> usize {
        self.period
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        let window = &ctx.closes[ctx.closes.len() - self.period..];
        // StockCharts' Bollinger Bands use population (n-divisor) standard
        // deviation, which is what rust_ti's single::bollinger_bands (SMA
        // mid + 2x StandardDeviation) computes under the hood.
        let (lower, mid, upper) = rust_ti::standard_indicators::single::bollinger_bands(window);
        let latest_close = *ctx.closes.last().unwrap();

        let (direction, confidence) = classify_by_distance(latest_close, mid);
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
                "close {:.2} vs Bollinger({}) mid {:.4} upper {:.4} lower {:.4}",
                latest_close, self.period, mid, upper, lower
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
    fn bollinger_matches_hand_computed_bands() {
        // closes = 1..=20, period = 20
        // mid = mean(1..=20) = 210/20 = 10.5
        // population variance = ((20^2 - 1) / 12) = 33.25 -> sigma ~= 5.766281
        // upper = 10.5 + 2*5.766281 ~= 22.032563, lower ~= -1.032563
        let algo = BollingerAlgorithm::new(20);
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let closes: Vec<f64> = (1..=20).map(|i| i as f64).collect();
        let ctx = MarketContext::from_closes(
            "TEST",
            Timeframe::Day,
            Horizon::Positional,
            closes,
            as_of,
        );

        let output = algo.compute(&ctx);

        // latest close (20.0) is above the mid band (10.5) -> Bullish
        assert_eq!(output.direction, Direction::Bullish);
        assert!(output.evidence[0].contains("22.0326"));
        assert!(output.evidence[0].contains("-1.0326"));
        assert_eq!(output.computed_at, as_of);
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(BollingerAlgorithm::new(20)))
}
