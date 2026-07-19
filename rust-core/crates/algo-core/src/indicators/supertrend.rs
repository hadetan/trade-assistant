use crate::{classify_by_distance, relative_magnitude, Algorithm, Direction, Horizon, MarketContext};

pub struct SupertrendAlgorithm {
    atr_period: usize,
    multiplier: f64,
}

impl SupertrendAlgorithm {
    pub fn new(atr_period: usize, multiplier: f64) -> Self {
        Self { atr_period, multiplier }
    }
}

impl Algorithm for SupertrendAlgorithm {
    fn id(&self) -> &'static str {
        "supertrend"
    }

    fn required_lookback(&self) -> usize {
        // One extra bar beyond the ATR period: the first true-range value
        // needs a previous close, so `atr_period` Wilder-seed TRs require
        // `atr_period + 1` bars.
        self.atr_period + 1
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        let lookback = self.required_lookback();
        if ctx.highs.len() < lookback || ctx.lows.len() < lookback || ctx.closes.len() < lookback {
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

        let bands = compute_bands(&ctx.highs, &ctx.lows, &ctx.closes, self.atr_period, self.multiplier);
        let latest_close = *ctx.closes.last().unwrap();

        let (direction, confidence) = classify_by_distance(latest_close, bands.line);
        let magnitude = relative_magnitude(latest_close, bands.line);

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude,
            confidence,
            evidence: vec![format!(
                "ATR({})={:.4}, basicUpper={:.4}, basicLower={:.4}, line={:.4} vs close={:.4}",
                self.atr_period, bands.atr, bands.basic_upper, bands.basic_lower, bands.line, latest_close
            )],
            computed_at: ctx.as_of,
        }
    }
}

struct Bands {
    atr: f64,
    basic_upper: f64,
    basic_lower: f64,
    line: f64,
}

fn true_ranges(highs: &[f64], lows: &[f64], closes: &[f64]) -> Vec<f64> {
    let mut tr = Vec::with_capacity(closes.len());
    tr.push(highs[0] - lows[0]);
    for i in 1..closes.len() {
        let range = (highs[i] - lows[i])
            .max((highs[i] - closes[i - 1]).abs())
            .max((lows[i] - closes[i - 1]).abs());
        tr.push(range);
    }
    tr
}

/// Classic Supertrend: ATR is Wilder-smoothed, seeded as a plain average of
/// the first `atr_period` true ranges (bar 0's TR is skipped -- it has no
/// previous close). The final upper/lower bands then carry forward bar to
/// bar and only move toward price, flipping the active line only when close
/// crosses the opposite band -- see the Task 3 brief's ATR/basic-band anchor.
fn compute_bands(highs: &[f64], lows: &[f64], closes: &[f64], atr_period: usize, multiplier: f64) -> Bands {
    let n = closes.len();
    let tr = true_ranges(highs, lows, closes);

    let seed_end = atr_period;
    let mut atr = vec![0.0; n];
    atr[seed_end] = tr[1..=seed_end].iter().sum::<f64>() / atr_period as f64;
    for i in (seed_end + 1)..n {
        atr[i] = (atr[i - 1] * (atr_period as f64 - 1.0) + tr[i]) / atr_period as f64;
    }

    let mut final_upper = vec![0.0; n];
    let mut final_lower = vec![0.0; n];
    let mut line = vec![0.0; n];
    let mut in_uptrend = true;
    let mut basic_upper_last = 0.0;
    let mut basic_lower_last = 0.0;

    for i in seed_end..n {
        let mid = (highs[i] + lows[i]) / 2.0;
        let basic_upper = mid + multiplier * atr[i];
        let basic_lower = mid - multiplier * atr[i];
        basic_upper_last = basic_upper;
        basic_lower_last = basic_lower;

        final_upper[i] = if i == seed_end
            || basic_upper < final_upper[i - 1]
            || closes[i - 1] > final_upper[i - 1]
        {
            basic_upper
        } else {
            final_upper[i - 1]
        };

        final_lower[i] = if i == seed_end
            || basic_lower > final_lower[i - 1]
            || closes[i - 1] < final_lower[i - 1]
        {
            basic_lower
        } else {
            final_lower[i - 1]
        };

        if closes[i] > final_upper[i] {
            in_uptrend = true;
        } else if closes[i] < final_lower[i] {
            in_uptrend = false;
        }
        line[i] = if in_uptrend { final_lower[i] } else { final_upper[i] };
    }

    Bands {
        atr: atr[n - 1],
        basic_upper: basic_upper_last,
        basic_lower: basic_lower_last,
        line: line[n - 1],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Timeframe;
    use chrono::{DateTime, Utc};

    #[test]
    fn flat_series_atr_and_basic_bands_match_hand_derivation() {
        // H=11, L=10, C=10.5 for every one of 11 bars.
        // TR = max(H-L, |H-Cprev|, |L-Cprev|) = max(1, 0.5, 0.5) = 1 for every
        // bar after the first -> ATR(10) = 1.0 (all ten seed TRs equal 1).
        // basicUpper/Lower = (H+L)/2 +- mult*ATR = 10.5 +- 3*1.0 = 13.5 / 7.5.
        let highs = vec![11.0; 11];
        let lows = vec![10.0; 11];
        let closes = vec![10.5; 11];

        let bands = compute_bands(&highs, &lows, &closes, 10, 3.0);

        assert!((bands.atr - 1.0).abs() < 1e-9);
        assert!((bands.basic_upper - 13.5).abs() < 1e-9);
        assert!((bands.basic_lower - 7.5).abs() < 1e-9);
    }

    #[test]
    fn uptrend_ramp_keeps_line_below_close() {
        let n = 20;
        let closes: Vec<f64> = (0..n).map(|i| 100.0 + i as f64).collect();
        let highs: Vec<f64> = closes.iter().map(|c| c + 1.0).collect();
        let lows: Vec<f64> = closes.iter().map(|c| c - 1.0).collect();

        let bands = compute_bands(&highs, &lows, &closes, 10, 3.0);
        let latest_close = *closes.last().unwrap();

        assert!(bands.line < latest_close);
    }

    #[test]
    fn insufficient_history_is_a_neutral_no_op() {
        let algo = SupertrendAlgorithm::new(10, 3.0);
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = MarketContext::from_closes(
            "TEST",
            Timeframe::Day,
            Horizon::Positional,
            vec![100.0, 101.0],
            as_of,
        );

        let output = algo.compute(&ctx);

        assert_eq!(output.direction, Direction::Neutral);
        assert_eq!(output.magnitude, 0.0);
        assert_eq!(output.evidence, vec!["insufficient OHLCV".to_string()]);
        assert_eq!(output.computed_at, as_of);
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(SupertrendAlgorithm::new(10, 3.0)))
}
