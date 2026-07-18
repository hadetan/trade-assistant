use crate::{Algorithm, Direction, Horizon, MarketContext};

pub struct RsiAlgorithm {
    period: usize,
}

impl RsiAlgorithm {
    pub fn new(period: usize) -> Self {
        Self { period }
    }
}

impl Algorithm for RsiAlgorithm {
    fn id(&self) -> &'static str {
        "rsi"
    }

    fn required_lookback(&self) -> usize {
        self.period + 1
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        let rsi = rsi_value(&ctx.closes, self.period);
        let direction = classify_rsi(rsi);

        // distance from the neutral midpoint (50), scaled to roughly [0, 1]
        let confidence = ((rsi - 50.0).abs() / 50.0).min(1.0);

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude: (rsi - 50.0).abs(),
            confidence,
            evidence: vec![format!("RSI({}) = {:.2}", self.period, rsi)],
            computed_at: ctx.as_of,
        }
    }
}

fn classify_rsi(rsi: f64) -> Direction {
    if rsi > 70.0 {
        Direction::Bearish
    } else if rsi < 30.0 {
        Direction::Bullish
    } else {
        Direction::Neutral
    }
}

/// Wilder's original RSI smoothing: seed avg gain/loss from the first
/// `period` changes, then smooth every subsequent change with weight
/// `(period - 1) / period` on the running average.
fn rsi_value(closes: &[f64], period: usize) -> f64 {
    let changes: Vec<f64> = closes.windows(2).map(|w| w[1] - w[0]).collect();

    let mut avg_gain = changes[..period]
        .iter()
        .map(|c| c.max(0.0))
        .sum::<f64>()
        / period as f64;
    let mut avg_loss = changes[..period]
        .iter()
        .map(|c| (-c).max(0.0))
        .sum::<f64>()
        / period as f64;

    for change in &changes[period..] {
        let gain = change.max(0.0);
        let loss = (-change).max(0.0);
        avg_gain = (avg_gain * (period as f64 - 1.0) + gain) / period as f64;
        avg_loss = (avg_loss * (period as f64 - 1.0) + loss) / period as f64;
    }

    if avg_loss == 0.0 {
        return 100.0;
    }
    let rs = avg_gain / avg_loss;
    100.0 - 100.0 / (1.0 + rs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, Utc};
    use crate::Timeframe;

    #[test]
    fn rsi_matches_hand_computed_wilder_smoothing() {
        // closes = [100, 102, 101, 105, 103], period = 2
        // changes: +2, -1, +4, -2
        // avgGain1/avgLoss1 (first `period`=2 changes: +2,-1) = 1.0 / 0.5
        // avgGain2/avgLoss2 (Wilder step, change +4/loss 0) = 2.5 / 0.25
        // avgGain3/avgLoss3 (Wilder step, change -2/gain 0) = 1.25 / 1.125
        // RS3 = 1.25 / 1.125 = 10/9; RSI3 = 100 - 100/(1 + 10/9) = 100 - 900/19
        //     = 52.6316 (final expected RSI)
        let algo = RsiAlgorithm::new(2);
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = MarketContext {
            symbol: "TEST".to_string(),
            timeframe: Timeframe::Day,
            horizon: Horizon::Positional,
            closes: vec![100.0, 102.0, 101.0, 105.0, 103.0],
            as_of,
        };

        let output = algo.compute(&ctx);

        assert!(output.evidence[0].contains("52.63"));
        // RSI 52.63 sits inside the neutral 30-70 band -> Neutral
        assert_eq!(output.direction, Direction::Neutral);
        assert_eq!(output.computed_at, as_of);
    }

    #[test]
    fn rsi_classifies_overbought_and_oversold() {
        assert_eq!(classify_rsi(75.0), Direction::Bearish);
        assert_eq!(classify_rsi(20.0), Direction::Bullish);
        assert_eq!(classify_rsi(50.0), Direction::Neutral);
    }
}
