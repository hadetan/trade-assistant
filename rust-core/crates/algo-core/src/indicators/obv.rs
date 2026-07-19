use crate::{Algorithm, Direction, Horizon, MarketContext};

pub struct ObvAlgorithm;

impl ObvAlgorithm {
    pub fn new() -> Self {
        Self
    }
}

impl Algorithm for ObvAlgorithm {
    fn id(&self) -> &'static str {
        "obv"
    }

    fn required_lookback(&self) -> usize {
        2
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        if ctx.volumes.len() < self.required_lookback() || ctx.closes.len() < self.required_lookback()
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

        let obv_series =
            rust_ti::momentum_indicators::bulk::on_balance_volume(&ctx.closes, &ctx.volumes, 0.0);
        let last_obv = *obv_series.last().unwrap();
        let previous_obv = if obv_series.len() >= 2 {
            obv_series[obv_series.len() - 2]
        } else {
            0.0
        };
        let delta = last_obv - previous_obv;

        let direction = if delta > 0.0 {
            Direction::Bullish
        } else if delta < 0.0 {
            Direction::Bearish
        } else {
            Direction::Neutral
        };
        let confidence = if direction == Direction::Neutral { 0.0 } else { 1.0 };

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude: delta.abs(),
            confidence,
            evidence: vec![format!("OBV {:.2} (delta {:.2})", last_obv, delta)],
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
    fn obv_matches_hand_computed_path() {
        // closes = [10, 11, 10, 12], volumes = [100, 200, 150, 300]
        // OBV path: 0 -> +200 -> 200-150=50 -> 50+300=350
        // last delta = 350 - 50 = +300 -> Bullish
        let algo = ObvAlgorithm::new();
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let mut ctx = MarketContext::from_closes(
            "TEST",
            Timeframe::Day,
            Horizon::Positional,
            vec![10.0, 11.0, 10.0, 12.0],
            as_of,
        );
        ctx.volumes = vec![100.0, 200.0, 150.0, 300.0];

        let output = algo.compute(&ctx);

        assert!((output.magnitude - 300.0).abs() < 1e-9);
        assert_eq!(output.direction, Direction::Bullish);
        assert_eq!(output.computed_at, as_of);
    }

    #[test]
    fn obv_guards_on_insufficient_volumes() {
        let algo = ObvAlgorithm::new();
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let mut ctx = MarketContext::from_closes(
            "TEST",
            Timeframe::Day,
            Horizon::Positional,
            vec![10.0, 11.0, 10.0, 12.0],
            as_of,
        );
        ctx.volumes = vec![100.0];

        let output = algo.compute(&ctx);

        assert_eq!(output.direction, Direction::Neutral);
        assert_eq!(output.magnitude, 0.0);
        assert_eq!(output.evidence, vec!["insufficient OHLCV".to_string()]);
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(ObvAlgorithm::new()))
}
