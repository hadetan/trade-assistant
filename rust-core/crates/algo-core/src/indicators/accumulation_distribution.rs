use crate::{Algorithm, Direction, Horizon, MarketContext};

pub struct AccumulationDistributionAlgorithm;

impl AccumulationDistributionAlgorithm {
    pub fn new() -> Self {
        Self
    }
}

impl Default for AccumulationDistributionAlgorithm {
    fn default() -> Self {
        Self::new()
    }
}

impl Algorithm for AccumulationDistributionAlgorithm {
    fn id(&self) -> &'static str {
        "accumulation_distribution"
    }

    fn required_lookback(&self) -> usize {
        2
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        let lookback = self.required_lookback();
        if ctx.highs.len() < lookback
            || ctx.lows.len() < lookback
            || ctx.closes.len() < lookback
            || ctx.volumes.len() < lookback
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

        let mut adl = 0.0;
        let mut prev_adl = 0.0;
        for i in 0..ctx.closes.len() {
            let high = ctx.highs[i];
            let low = ctx.lows[i];
            prev_adl = adl;
            adl = if (high - low).abs() < 1e-12 {
                // A zero-range bar makes the money-flow multiplier 0/0
                // (undefined), so it contributes nothing rather than NaN.
                adl
            } else {
                rust_ti::strength_indicators::single::accumulation_distribution(
                    high,
                    low,
                    ctx.closes[i],
                    ctx.volumes[i],
                    adl,
                )
            };
        }

        let delta = adl - prev_adl;
        let direction = if delta > 0.0 {
            Direction::Bullish
        } else if delta < 0.0 {
            Direction::Bearish
        } else {
            Direction::Neutral
        };

        let last_high = *ctx.highs.last().unwrap();
        let last_low = *ctx.lows.last().unwrap();
        let last_close = *ctx.closes.last().unwrap();
        let confidence = if (last_high - last_low).abs() < 1e-12 {
            0.0
        } else {
            (((last_close - last_low) - (last_high - last_close)) / (last_high - last_low))
                .abs()
                .min(1.0)
        };

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude: adl,
            confidence,
            evidence: vec![format!("ADL = {:.2} (delta {:+.2})", adl, delta)],
            computed_at: ctx.as_of,
        }
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(AccumulationDistributionAlgorithm::new()))
}
