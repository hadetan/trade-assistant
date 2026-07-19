use crate::{Algorithm, Direction, Horizon, MarketContext};

pub struct WilliamsRAlgorithm {
    period: usize,
}

impl WilliamsRAlgorithm {
    pub fn new(period: usize) -> Self {
        Self { period }
    }
}

impl Algorithm for WilliamsRAlgorithm {
    fn id(&self) -> &'static str {
        "williams_r"
    }

    fn required_lookback(&self) -> usize {
        self.period
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

        let high_window = &ctx.highs[ctx.highs.len() - self.period..];
        let low_window = &ctx.lows[ctx.lows.len() - self.period..];
        let latest_close = *ctx.closes.last().unwrap();

        let williams_r = rust_ti::momentum_indicators::single::williams_percent_r(
            high_window,
            low_window,
            latest_close,
        );
        let direction = classify_williams_r(williams_r);
        let magnitude = (williams_r + 50.0).abs();
        let confidence = (magnitude / 50.0).min(1.0);

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude,
            confidence,
            evidence: vec![format!("Williams %R({}) = {:.2}", self.period, williams_r)],
            computed_at: ctx.as_of,
        }
    }
}

fn classify_williams_r(williams_r: f64) -> Direction {
    if williams_r > -20.0 {
        Direction::Bearish
    } else if williams_r < -80.0 {
        Direction::Bullish
    } else {
        Direction::Neutral
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Timeframe;
    use chrono::{DateTime, Utc};

    #[test]
    fn williams_r_matches_hand_computed_value() {
        // high=[12,13,14], low=[10,11,9], close=13, period=3
        // HH=14, LL=9 -> %R = (14-13)/(14-9) * -100 = -20.0
        let algo = WilliamsRAlgorithm::new(3);
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = MarketContext {
            symbol: "TEST".to_string(),
            timeframe: Timeframe::Day,
            horizon: Horizon::Positional,
            closes: vec![13.0],
            opens: Vec::new(),
            highs: vec![12.0, 13.0, 14.0],
            lows: vec![10.0, 11.0, 9.0],
            volumes: Vec::new(),
            timestamps: Vec::new(),
            options: None,
            chain: None,
            peer: None,
            higher_tf: None,
            as_of,
        };

        let output = algo.compute(&ctx);

        assert!(output.evidence[0].contains("-20.00"));
        // -20.0 is exactly the boundary (not > -20), so it lands in the
        // neutral band, not the overbought/Bearish one.
        assert_eq!(output.direction, Direction::Neutral);
        assert_eq!(output.computed_at, as_of);
    }

    #[test]
    fn williams_r_classifies_overbought_and_oversold() {
        assert_eq!(classify_williams_r(-10.0), Direction::Bearish);
        assert_eq!(classify_williams_r(-90.0), Direction::Bullish);
        assert_eq!(classify_williams_r(-50.0), Direction::Neutral);
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(WilliamsRAlgorithm::new(14)))
}
