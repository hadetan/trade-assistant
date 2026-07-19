use crate::{Algorithm, Direction, Horizon, MarketContext};

pub struct OuHalfLifeAlgorithm {
    min_lookback: usize,
}

impl OuHalfLifeAlgorithm {
    pub fn new(min_lookback: usize) -> Self {
        Self { min_lookback }
    }
}

impl Algorithm for OuHalfLifeAlgorithm {
    fn id(&self) -> &'static str {
        "ou_half_life"
    }

    fn required_lookback(&self) -> usize {
        self.min_lookback
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        // The registry gate only checks ctx.closes.len() against
        // required_lookback() -- it knows nothing about ctx.peer, so a
        // recently-listed or short-history peer leg can reach here with an
        // overlap too small (even zero) for fit_ar1's series[..len-1] slice,
        // which underflows on an empty series.
        if let Some(peer) = &ctx.peer {
            let overlap = ctx.closes.len().min(peer.closes.len());
            if overlap < self.required_lookback().max(2) {
                return no_op(ctx);
            }
        }

        let series = spread_series(ctx);
        let (_a, b) = fit_ar1(&series);
        let half_life = half_life_from_b(b);

        let (mean, std) = population_mean_std(&series);
        let last = *series.last().unwrap();
        let z = if std.abs() < 1e-12 {
            0.0
        } else {
            (last - mean) / std
        };

        let direction = if z < -1.0 {
            Direction::Bullish
        } else if z > 1.0 {
            Direction::Bearish
        } else {
            Direction::Neutral
        };

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude: z.abs(),
            confidence: z.abs().min(1.0),
            evidence: vec![format!(
                "half-life={:.6} bars, z-score={:.6}",
                half_life, z
            )],
            computed_at: ctx.as_of,
        }
    }
}

fn no_op(ctx: &MarketContext) -> crate::AlgoOutput {
    crate::AlgoOutput {
        algo_id: "ou_half_life",
        symbol: ctx.symbol.clone(),
        timeframe: ctx.timeframe,
        horizon: ctx.horizon,
        direction: Direction::Neutral,
        magnitude: 0.0,
        confidence: 0.0,
        evidence: vec!["insufficient peer overlap".into()],
        computed_at: ctx.as_of,
    }
}

/// The spread being tested for mean reversion: `closes - peer.closes` when a
/// peer leg is supplied (pairs trade), or `closes` itself treated as the
/// series (single-instrument reversion) when it isn't.
fn spread_series(ctx: &MarketContext) -> Vec<f64> {
    match &ctx.peer {
        Some(peer) => {
            let n = ctx.closes.len().min(peer.closes.len());
            ctx.closes[..n]
                .iter()
                .zip(peer.closes[..n].iter())
                .map(|(c, p)| c - p)
                .collect()
        }
        None => ctx.closes.clone(),
    }
}

/// OLS fit of `sₜ = a + b·sₜ₋₁` over consecutive pairs in `series`. Returns
/// `b = 0.0` (no slope) for a degenerate one-pair-or-fewer input instead of
/// dividing by a zero `var_x`.
fn fit_ar1(series: &[f64]) -> (f64, f64) {
    let x = &series[..series.len() - 1];
    let y = &series[1..];
    let n = x.len() as f64;
    let mean_x = x.iter().sum::<f64>() / n;
    let mean_y = y.iter().sum::<f64>() / n;

    let mut cov = 0.0;
    let mut var_x = 0.0;
    for (&xi, &yi) in x.iter().zip(y.iter()) {
        cov += (xi - mean_x) * (yi - mean_y);
        var_x += (xi - mean_x) * (xi - mean_x);
    }

    let b = if var_x.abs() < 1e-12 { 0.0 } else { cov / var_x };
    let a = mean_y - b * mean_x;
    (a, b)
}

/// `half_life = ln(2)/λ = -ln(2)/ln(b)`. Only defined for a genuinely
/// mean-reverting fit (0 < b < 1, i.e. λ > 0); outside that range the AR(1)
/// isn't decaying back to its mean, so there is no half-life to report.
fn half_life_from_b(b: f64) -> f64 {
    if b > 0.0 && b < 1.0 {
        -std::f64::consts::LN_2 / b.ln()
    } else {
        f64::INFINITY
    }
}

/// Population (n-divisor) mean/std, matching the other Wave-C estimators'
/// convention (e.g. bollinger's σ) rather than the sample (n-1) variant.
fn population_mean_std(series: &[f64]) -> (f64, f64) {
    let n = series.len() as f64;
    let mean = series.iter().sum::<f64>() / n;
    let variance = series.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n;
    (mean, variance.sqrt())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PeerSeries, Timeframe};
    use chrono::{DateTime, Utc};

    #[test]
    fn fit_ar1_recovers_exact_halving_slope() {
        // Each term is half the previous one, so b == 0.5, a == 0.0 exactly.
        let (a, b) = fit_ar1(&[4.0, 2.0, 1.0, 0.5, 0.25]);

        assert!((b - 0.5).abs() < 1e-9);
        assert!(a.abs() < 1e-9);
    }

    #[test]
    fn half_life_matches_hand_derivation_for_b_one_half() {
        let half_life = half_life_from_b(0.5);

        assert!((half_life - 1.0).abs() < 1e-6);
    }

    #[test]
    fn compute_reports_expected_half_life_on_brief_series() {
        let algo = OuHalfLifeAlgorithm::new(3);
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = MarketContext::from_closes(
            "TEST",
            Timeframe::Day,
            Horizon::Positional,
            vec![4.0, 2.0, 1.0, 0.5, 0.25],
            as_of,
        );

        let output = algo.compute(&ctx);

        assert!(output.evidence[0].contains("half-life=1.000000"));
        assert_eq!(output.computed_at, as_of);
    }

    #[test]
    fn compute_does_not_panic_on_empty_peer_overlap() {
        let algo = OuHalfLifeAlgorithm::new(3);
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let mut ctx = MarketContext::from_closes(
            "TEST",
            Timeframe::Day,
            Horizon::Positional,
            vec![1.0, 2.0, 3.0, 4.0, 5.0],
            as_of,
        );
        ctx.peer = Some(PeerSeries {
            symbol: "X".into(),
            closes: vec![],
        });

        let output = algo.compute(&ctx);

        assert_eq!(output.direction, Direction::Neutral);
        assert_eq!(output.magnitude, 0.0);
        assert_eq!(output.confidence, 0.0);
        assert_eq!(output.evidence, vec!["insufficient peer overlap".to_string()]);
        assert_eq!(output.computed_at, as_of);
    }

    #[test]
    fn z_score_classifies_bullish_bearish_neutral() {
        assert_eq!(classify_z(-1.5), Direction::Bullish);
        assert_eq!(classify_z(1.5), Direction::Bearish);
        assert_eq!(classify_z(0.0), Direction::Neutral);
    }

    fn classify_z(z: f64) -> Direction {
        if z < -1.0 {
            Direction::Bullish
        } else if z > 1.0 {
            Direction::Bearish
        } else {
            Direction::Neutral
        }
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(OuHalfLifeAlgorithm::new(3)))
}
