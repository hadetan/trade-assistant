use crate::{classify_by_distance, relative_magnitude, Algorithm, Direction, Horizon, MarketContext};
use rust_ti::candle_indicators::single::donchian_channels;

pub struct DonchianAlgorithm {
    period: usize,
}

impl DonchianAlgorithm {
    pub fn new(period: usize) -> Self {
        Self { period }
    }
}

impl Algorithm for DonchianAlgorithm {
    fn id(&self) -> &'static str {
        "donchian"
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

        let highs = &ctx.highs[ctx.highs.len() - self.period..];
        let lows = &ctx.lows[ctx.lows.len() - self.period..];
        let (lower, mid, upper) = donchian_channels(highs, lows);
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
                "close {:.2} vs Donchian({}) mid {:.2} [lower {:.2}, upper {:.2}]",
                latest_close, self.period, mid, lower, upper
            )],
            computed_at: ctx.as_of,
        }
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(DonchianAlgorithm::new(3)))
}
