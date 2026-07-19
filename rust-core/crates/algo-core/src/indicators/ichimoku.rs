use crate::{relative_magnitude, Algorithm, Direction, Horizon, MarketContext};
use rust_ti::candle_indicators::single::ichimoku_cloud;

const TENKAN_PERIOD: usize = 9;
const KIJUN_PERIOD: usize = 26;
const SENKOU_B_PERIOD: usize = 52;

pub struct IchimokuAlgorithm;

impl IchimokuAlgorithm {
    pub fn new() -> Self {
        Self
    }
}

impl Default for IchimokuAlgorithm {
    fn default() -> Self {
        Self::new()
    }
}

impl Algorithm for IchimokuAlgorithm {
    fn id(&self) -> &'static str {
        "ichimoku"
    }

    fn required_lookback(&self) -> usize {
        SENKOU_B_PERIOD
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        if ctx.highs.len() < self.required_lookback()
            || ctx.lows.len() < self.required_lookback()
            || ctx.closes.len() < self.required_lookback()
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

        let (senkou_a, senkou_b, kijun, tenkan, _) = ichimoku_cloud(
            &ctx.highs,
            &ctx.lows,
            &ctx.closes,
            TENKAN_PERIOD,
            KIJUN_PERIOD,
            SENKOU_B_PERIOD,
        );
        let cloud_top = senkou_a.max(senkou_b);
        let cloud_bottom = senkou_a.min(senkou_b);
        let latest_close = *ctx.closes.last().unwrap();

        let direction = if latest_close > cloud_top && tenkan > kijun {
            Direction::Bullish
        } else if latest_close < cloud_bottom && tenkan < kijun {
            Direction::Bearish
        } else {
            Direction::Neutral
        };

        let magnitude = relative_magnitude(tenkan, kijun);
        let confidence = magnitude.min(1.0);

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude,
            confidence,
            evidence: vec![format!(
                "close {:.2} vs cloud [{:.2}, {:.2}], tenkan {:.2} vs kijun {:.2}",
                latest_close, cloud_bottom, cloud_top, tenkan, kijun
            )],
            computed_at: ctx.as_of,
        }
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(IchimokuAlgorithm::new()))
}
