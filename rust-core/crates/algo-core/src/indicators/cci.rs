use crate::{Algorithm, Direction, Horizon, MarketContext};
use rust_ti::momentum_indicators::single::commodity_channel_index;
use rust_ti::{ConstantModelType, DeviationModel};

pub struct CciAlgorithm {
    period: usize,
}

impl CciAlgorithm {
    pub fn new(period: usize) -> Self {
        Self { period }
    }
}

impl Algorithm for CciAlgorithm {
    fn id(&self) -> &'static str {
        "cci"
    }

    fn required_lookback(&self) -> usize {
        self.period
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

        let n = ctx.highs.len();
        let tp: Vec<f64> = (n - self.period..n)
            .map(|i| (ctx.highs[i] + ctx.lows[i] + ctx.closes[i]) / 3.0)
            .collect();

        let cci = commodity_channel_index(
            &tp,
            ConstantModelType::SimpleMovingAverage,
            DeviationModel::MeanAbsoluteDeviation,
            0.015,
        );
        let direction = classify_cci(cci);
        let confidence = (cci.abs() / 100.0).min(1.0);

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude: cci.abs(),
            confidence,
            evidence: vec![format!("CCI({}) = {:.2}", self.period, cci)],
            computed_at: ctx.as_of,
        }
    }
}

fn classify_cci(cci: f64) -> Direction {
    if cci > 100.0 {
        Direction::Bullish
    } else if cci < -100.0 {
        Direction::Bearish
    } else {
        Direction::Neutral
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_cci_flags_overbought_and_oversold() {
        assert_eq!(classify_cci(150.0), Direction::Bullish);
        assert_eq!(classify_cci(-150.0), Direction::Bearish);
        assert_eq!(classify_cci(50.0), Direction::Neutral);
    }

    #[test]
    fn cci_matches_hand_computed_reference() {
        // TP = [23, 24, 25] from high=[24,25,26], low=[22,23,24], close=[23,24,25]
        // SMA = 24, MeanDev = (1+0+1)/3 = 2/3
        // CCI = (25 - 24) / (0.015 * 2/3) = 100.0 exactly (mathematically;
        // rust_ti's f64 pipeline lands ~1.4e-14 off that, which is why this
        // asserts the value with tolerance rather than the boundary
        // direction -- see classify_cci_flags_overbought_and_oversold for
        // the (non-boundary) classification checks).
        let tp = vec![23.0, 24.0, 25.0];

        let cci = commodity_channel_index(
            &tp,
            ConstantModelType::SimpleMovingAverage,
            DeviationModel::MeanAbsoluteDeviation,
            0.015,
        );

        assert!((cci - 100.0).abs() < 1e-9);
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(CciAlgorithm::new(20)))
}
