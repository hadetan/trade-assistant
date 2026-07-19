use crate::{Algorithm, Direction, Horizon, MarketContext};

pub struct MfiAlgorithm {
    period: usize,
}

impl MfiAlgorithm {
    pub fn new(period: usize) -> Self {
        Self { period }
    }
}

impl Algorithm for MfiAlgorithm {
    fn id(&self) -> &'static str {
        "mfi"
    }

    fn required_lookback(&self) -> usize {
        self.period + 1
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        let lookback = self.required_lookback();
        if ctx.highs.len() < lookback || ctx.lows.len() < lookback || ctx.volumes.len() < lookback
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

        let mfi = mfi_value(&ctx.highs, &ctx.lows, &ctx.closes, &ctx.volumes, self.period);
        let direction = classify_mfi(mfi);
        let confidence = ((mfi - 50.0).abs() / 50.0).min(1.0);

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude: (mfi - 50.0).abs(),
            confidence,
            evidence: vec![format!("MFI({}) = {:.2}", self.period, mfi)],
            computed_at: ctx.as_of,
        }
    }
}

fn classify_mfi(mfi: f64) -> Direction {
    if mfi > 80.0 {
        Direction::Bearish
    } else if mfi < 20.0 {
        Direction::Bullish
    } else {
        Direction::Neutral
    }
}

/// Classifies each bar's raw money flow (typical price * volume) as positive
/// or negative by comparing typical price to the prior bar's, per the
/// standard MFI definition -- not by comparing raw money flow itself (which
/// would fold volume into the trend signal and can flip the classification
/// on a volume spike even when price fell).
fn mfi_value(highs: &[f64], lows: &[f64], closes: &[f64], volumes: &[f64], period: usize) -> f64 {
    let n = closes.len();
    let start = n - (period + 1);
    let typical_prices: Vec<f64> = (start..n)
        .map(|i| (highs[i] + lows[i] + closes[i]) / 3.0)
        .collect();

    let mut positive_mf = 0.0;
    let mut negative_mf = 0.0;
    for i in 1..typical_prices.len() {
        let raw_mf = typical_prices[i] * volumes[start + i];
        if typical_prices[i] > typical_prices[i - 1] {
            positive_mf += raw_mf;
        } else if typical_prices[i] < typical_prices[i - 1] {
            negative_mf += raw_mf;
        }
    }

    if negative_mf == 0.0 {
        // Mirrors RSI's flat/pure-uptrend split: no negative flow at all is
        // only genuinely 100 if there was positive flow to report; a wholly
        // flat window (no trend either way) has no information, so neutral.
        return if positive_mf == 0.0 { 50.0 } else { 100.0 };
    }
    let money_ratio = positive_mf / negative_mf;
    100.0 - 100.0 / (1.0 + money_ratio)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Timeframe;
    use chrono::{DateTime, Utc};

    #[test]
    fn mfi_matches_hand_computed_value() {
        // TP = [10, 11, 9] (flat H=L=C bars), period = 2, volumes = [_, 100, 100]
        // posMF = 11*100 = 1100 (TP rose 10->11), negMF = 9*100 = 900 (TP fell 11->9)
        // MFR = 1100/900 = 11/9, MFI = 100 - 100/(1 + 11/9) = 100 - 45 = 55.0
        let algo = MfiAlgorithm::new(2);
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = MarketContext {
            symbol: "TEST".to_string(),
            timeframe: Timeframe::Day,
            horizon: Horizon::Positional,
            closes: vec![10.0, 11.0, 9.0],
            opens: vec![10.0, 11.0, 9.0],
            highs: vec![10.0, 11.0, 9.0],
            lows: vec![10.0, 11.0, 9.0],
            volumes: vec![100.0, 100.0, 100.0],
            timestamps: vec![],
            options: None,
            chain: None,
            peer: None,
            higher_tf: None,
            as_of,
        };

        let output = algo.compute(&ctx);

        assert!((mfi_value(&ctx.highs, &ctx.lows, &ctx.closes, &ctx.volumes, 2) - 55.0).abs() < 1e-9);
        assert_eq!(output.direction, Direction::Neutral);
        assert_eq!(output.computed_at, as_of);
    }

    #[test]
    fn mfi_no_op_guard_on_insufficient_ohlcv() {
        let algo = MfiAlgorithm::new(14);
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = MarketContext::from_closes(
            "TEST",
            Timeframe::Day,
            Horizon::Positional,
            vec![10.0, 11.0, 9.0],
            as_of,
        );

        let output = algo.compute(&ctx);

        assert_eq!(output.direction, Direction::Neutral);
        assert_eq!(output.magnitude, 0.0);
        assert_eq!(output.evidence, vec!["insufficient OHLCV".to_string()]);
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(MfiAlgorithm::new(2)))
}
