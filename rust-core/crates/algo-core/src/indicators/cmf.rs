use crate::{AlgoOutput, Algorithm, Direction, Horizon, MarketContext};

pub struct CmfAlgorithm {
    period: usize,
}

impl CmfAlgorithm {
    pub fn new(period: usize) -> Self {
        Self { period }
    }

    fn no_op(&self, ctx: &MarketContext) -> AlgoOutput {
        AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction: Direction::Neutral,
            magnitude: 0.0,
            confidence: 0.0,
            evidence: vec!["insufficient OHLCV".into()],
            computed_at: ctx.as_of,
        }
    }
}

impl Algorithm for CmfAlgorithm {
    fn id(&self) -> &'static str {
        "cmf"
    }

    fn required_lookback(&self) -> usize {
        self.period
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> AlgoOutput {
        let lookback = self.required_lookback();
        if ctx.highs.len() < lookback || ctx.lows.len() < lookback || ctx.volumes.len() < lookback
        {
            return self.no_op(ctx);
        }

        let highs = &ctx.highs[ctx.highs.len() - self.period..];
        let lows = &ctx.lows[ctx.lows.len() - self.period..];
        let closes = &ctx.closes[ctx.closes.len() - self.period..];
        let volumes = &ctx.volumes[ctx.volumes.len() - self.period..];

        let mut mfv_sum = 0.0;
        let mut vol_sum = 0.0;
        for i in 0..self.period {
            let range = highs[i] - lows[i];
            // A zero-range bar (H == L) has no close-location information;
            // treat its money flow multiplier as 0 rather than dividing by 0.
            let mfm = if range.abs() < 1e-12 {
                0.0
            } else {
                ((closes[i] - lows[i]) - (highs[i] - closes[i])) / range
            };
            mfv_sum += mfm * volumes[i];
            vol_sum += volumes[i];
        }

        let cmf = if vol_sum.abs() < 1e-12 {
            0.0
        } else {
            mfv_sum / vol_sum
        };

        let direction = if cmf > 0.0 {
            Direction::Bullish
        } else if cmf < 0.0 {
            Direction::Bearish
        } else {
            Direction::Neutral
        };

        AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude: cmf,
            confidence: cmf.abs().min(1.0),
            evidence: vec![format!("CMF({}) = {:.6}", self.period, cmf)],
            computed_at: ctx.as_of,
        }
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(CmfAlgorithm::new(2)))
}
