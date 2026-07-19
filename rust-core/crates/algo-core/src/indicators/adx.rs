use crate::{Algorithm, Direction, Horizon, MarketContext};

pub struct AdxAlgorithm {
    period: usize,
}

impl AdxAlgorithm {
    pub fn new(period: usize) -> Self {
        Self { period }
    }
}

impl Algorithm for AdxAlgorithm {
    fn id(&self) -> &'static str {
        "adx"
    }

    fn required_lookback(&self) -> usize {
        2 * self.period
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

        let (plus_di, minus_di, adx) =
            wilder_dmi(&ctx.highs, &ctx.lows, &ctx.closes, self.period);

        let direction = if plus_di > minus_di && adx > 20.0 {
            Direction::Bullish
        } else if minus_di > plus_di && adx > 20.0 {
            Direction::Bearish
        } else {
            Direction::Neutral
        };
        let confidence = (adx / 100.0).clamp(0.0, 1.0);

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude: adx,
            confidence,
            evidence: vec![format!(
                "+DI({0}) {1:.2} / -DI({0}) {2:.2} / ADX({0}) {3:.2}",
                self.period, plus_di, minus_di, adx
            )],
            computed_at: ctx.as_of,
        }
    }
}

/// Wilder's original DMI/ADX recursion: seed +DM14/-DM14/TR14 from the sum
/// of the first `period` bar-to-bar values, then smooth every value after
/// with Wilder's running formula (`avg - avg/period + new`) -- not a plain
/// rolling-window sum. `rust_ti`'s own `directional_movement_system` takes
/// the rolling-sum route and demands 3x the period in bars, which the
/// brief's 2x-period lookback and 30-bar test can't satisfy, so this is
/// hand-rolled per the brief's exact formula instead. ADX itself is then
/// seeded from the average of the first `period` DX values and
/// Wilder-smoothed the same way. Returns (+DI, -DI, ADX) as of the last bar.
fn wilder_dmi(highs: &[f64], lows: &[f64], closes: &[f64], period: usize) -> (f64, f64, f64) {
    let n = highs.len();
    let mut trs = Vec::with_capacity(n - 1);
    let mut plus_dms = Vec::with_capacity(n - 1);
    let mut minus_dms = Vec::with_capacity(n - 1);

    for i in 1..n {
        let up_move = highs[i] - highs[i - 1];
        let down_move = lows[i - 1] - lows[i];

        plus_dms.push(if up_move > down_move && up_move > 0.0 {
            up_move
        } else {
            0.0
        });
        minus_dms.push(if down_move > up_move && down_move > 0.0 {
            down_move
        } else {
            0.0
        });
        trs.push(
            (highs[i] - lows[i])
                .max((highs[i] - closes[i - 1]).abs())
                .max((lows[i] - closes[i - 1]).abs()),
        );
    }

    let mut tr14 = trs[..period].iter().sum::<f64>();
    let mut plus_dm14 = plus_dms[..period].iter().sum::<f64>();
    let mut minus_dm14 = minus_dms[..period].iter().sum::<f64>();

    let mut plus_dis = vec![100.0 * plus_dm14 / tr14];
    let mut minus_dis = vec![100.0 * minus_dm14 / tr14];

    for i in period..trs.len() {
        tr14 = tr14 - tr14 / period as f64 + trs[i];
        plus_dm14 = plus_dm14 - plus_dm14 / period as f64 + plus_dms[i];
        minus_dm14 = minus_dm14 - minus_dm14 / period as f64 + minus_dms[i];

        plus_dis.push(100.0 * plus_dm14 / tr14);
        minus_dis.push(100.0 * minus_dm14 / tr14);
    }

    let dxs: Vec<f64> = plus_dis
        .iter()
        .zip(&minus_dis)
        .map(|(&p, &m)| {
            let sum = p + m;
            if sum.abs() < 1e-12 {
                0.0
            } else {
                100.0 * (p - m).abs() / sum
            }
        })
        .collect();

    let mut adx = dxs[..period].iter().sum::<f64>() / period as f64;
    for &dx in &dxs[period..] {
        adx = (adx * (period as f64 - 1.0) + dx) / period as f64;
    }

    (*plus_dis.last().unwrap(), *minus_dis.last().unwrap(), adx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Timeframe;
    use chrono::{DateTime, Utc};

    fn uptrend_ctx(n: usize) -> MarketContext {
        let highs: Vec<f64> = (0..n).map(|i| 100.0 + 2.0 * i as f64).collect();
        let lows: Vec<f64> = (0..n).map(|i| 99.0 + 2.0 * i as f64).collect();
        let closes: Vec<f64> = (0..n).map(|i| 99.5 + 2.0 * i as f64).collect();
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();

        MarketContext {
            symbol: "TEST".to_string(),
            timeframe: Timeframe::Day,
            horizon: Horizon::Positional,
            closes,
            opens: Vec::new(),
            highs,
            lows,
            volumes: Vec::new(),
            timestamps: Vec::new(),
            options: None,
            chain: None,
            peer: None,
            higher_tf: None,
            as_of,
        }
    }

    #[test]
    fn wilder_dmi_matches_hand_computed_first_step() {
        // 30-bar clean uptrend: TR/+DM/-DM are constant from bar 1 on, so
        // Wilder's recursion sits at a fixed point (steady state) throughout
        // -- +DI=80, -DI=0, ADX=100 exactly, not just asymptotically.
        let ctx = uptrend_ctx(30);
        let (plus_di, minus_di, adx) = wilder_dmi(&ctx.highs, &ctx.lows, &ctx.closes, 14);

        assert!((plus_di - 80.0).abs() < 1e-9);
        assert!((minus_di - 0.0).abs() < 1e-9);
        assert!((adx - 100.0).abs() < 1e-9);
    }

    #[test]
    fn adx_classifies_bullish_on_uptrend() {
        let algo = AdxAlgorithm::new(14);
        let ctx = uptrend_ctx(30);

        let output = algo.compute(&ctx);

        assert_eq!(output.direction, Direction::Bullish);
        assert!(output.magnitude > 20.0);
    }

    #[test]
    fn adx_no_ops_when_highs_shorter_than_lookback() {
        let algo = AdxAlgorithm::new(14);
        let ctx = uptrend_ctx(10);

        let output = algo.compute(&ctx);

        assert_eq!(output.direction, Direction::Neutral);
        assert_eq!(output.magnitude, 0.0);
        assert_eq!(output.evidence, vec!["insufficient OHLCV".to_string()]);
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(AdxAlgorithm::new(14)))
}
