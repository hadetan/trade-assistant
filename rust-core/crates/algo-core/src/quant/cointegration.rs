use crate::{Algorithm, AlgoOutput, Direction, Horizon, MarketContext};
use nalgebra::{DMatrix, DVector};

/// Engle-Granger (OLS hedge ratio + ADF on the residual spread) is the
/// tested path here. Johansen is provided separately below as a documented,
/// not-yet-validated approximation (R3 in the catalog plan) — see
/// `johansen_eigenvalues_approx`.
pub struct CointegrationAlgorithm {
    min_lookback: usize,
}

impl CointegrationAlgorithm {
    pub fn new(min_lookback: usize) -> Self {
        Self { min_lookback }
    }
}

impl Algorithm for CointegrationAlgorithm {
    fn id(&self) -> &'static str {
        "cointegration"
    }

    fn required_lookback(&self) -> usize {
        self.min_lookback
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> AlgoOutput {
        let Some(peer) = ctx.peer.as_ref() else {
            return no_op(ctx);
        };
        if ctx.closes.len() < self.required_lookback() || peer.closes.len() < self.required_lookback() {
            return no_op(ctx);
        }

        let n = ctx.closes.len().min(peer.closes.len());
        let xs = &ctx.closes[..n];
        let ys = &peer.closes[..n];

        let (beta, alpha) = ols_hedge_ratio(xs, ys);
        let residuals: Vec<f64> = xs
            .iter()
            .zip(ys.iter())
            .map(|(&x, &y)| y - (beta * x + alpha))
            .collect();

        let df = (n.saturating_sub(2)).max(1) as f64;
        let residual_variance = residuals.iter().map(|r| r * r).sum::<f64>() / df;

        let adf_stat = adf_test_statistic(&residuals);
        // MacKinnon Engle-Granger 2-var 5% critical value -- the EG residual
        // ADF null is not a standard Normal/Dickey-Fuller distribution, it's
        // shifted well more negative because the cointegrating regression's
        // own residuals are being tested (Phillips & Ouliaris 1990).
        let critical_value = -3.34;
        let cointegrated = adf_stat < critical_value;

        AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction: Direction::Neutral,
            magnitude: beta,
            confidence: if cointegrated { 1.0 } else { 0.0 },
            evidence: vec![
                format!("beta={:.6}", beta),
                format!("alpha={:.6}", alpha),
                format!("residual_variance={:e}", residual_variance),
                format!("adf_stat={:.6}", adf_stat),
                format!("cointegrated={}", cointegrated),
            ],
            computed_at: ctx.as_of,
        }
    }
}

fn no_op(ctx: &MarketContext) -> AlgoOutput {
    AlgoOutput {
        algo_id: "cointegration",
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

fn ols_hedge_ratio(xs: &[f64], ys: &[f64]) -> (f64, f64) {
    let n = xs.len();
    let design = DMatrix::from_fn(n, 2, |row, col| if col == 0 { xs[row] } else { 1.0 });
    let target = DVector::from_row_slice(ys);
    let design_t = design.transpose();
    let xtx = &design_t * &design;
    let xty = &design_t * &target;

    match xtx.try_inverse() {
        Some(inv) => {
            let theta = &inv * &xty;
            (theta[0], theta[1])
        }
        None => (0.0, 0.0),
    }
}

/// ADF test statistic for `Δe_t = ρ·e_(t-1) + ε_t`, no intercept: `e` is
/// already the OLS residual of the cointegrating regression, and OLS
/// residuals from a regression that included an intercept always sum to
/// exactly zero, so a second intercept here would be estimating a
/// known-zero constant.
fn adf_test_statistic(residuals: &[f64]) -> f64 {
    let pairs = residuals.len().saturating_sub(1);
    if pairs < 2 {
        return 0.0;
    }
    let lag = &residuals[..pairs];
    let delta: Vec<f64> = residuals.windows(2).map(|w| w[1] - w[0]).collect();

    let lag_ss: f64 = lag.iter().map(|v| v * v).sum();
    // A (near-)perfectly cointegrated pair leaves residuals that are all
    // ~0, so the lagged-level regressor has ~0 variance and rho is
    // undefined by division. That degeneracy IS maximal evidence of a
    // stationary spread, not a computation failure, so report it as such
    // instead of propagating a NaN/inf t-stat.
    if lag_ss < 1e-20 {
        return f64::NEG_INFINITY;
    }

    let cross: f64 = lag.iter().zip(delta.iter()).map(|(&l, &d)| l * d).sum();
    let rho = cross / lag_ss;

    let resid_ss: f64 = lag
        .iter()
        .zip(delta.iter())
        .map(|(&l, &d)| (d - rho * l).powi(2))
        .sum();
    let df = ((pairs - 1).max(1)) as f64;
    let se_rho = (resid_ss / df / lag_ss).sqrt();

    if se_rho < 1e-20 {
        return f64::NEG_INFINITY;
    }

    rho / se_rho
}

/// Johansen cointegration rank test, for a two-variable system, as a
/// generalized-eigenvalue approximation.
///
/// R3 (docs/superpowers/plans/2026-07-19-algorithm-catalog-plan.md): this is
/// a documented approximation, **not yet validated** against a reference
/// implementation (e.g. R's `urca`), and is NOT wired into
/// `CointegrationAlgorithm::compute` -- Engle-Granger above is the tested
/// path. Do not route production decisions through this function without
/// first validating it.
///
/// Simplification vs. textbook Johansen: this skips the lagged-difference
/// pre-whitening step (i.e. treats the system as VAR(1)), so `S00`/`S11`/`S01`
/// are the raw moment matrices of `ΔY_t` and `Y_(t-1)` rather than residuals
/// from an auxiliary regression. The eigenvalues of interest solve the
/// generalized problem `det(λ·S11 - S10·S00⁻¹·S01) = 0`; since `nalgebra`
/// (without the `nalgebra-lapack` LAPACK bindings) has no dedicated
/// generalized eigensolver, this reduces it to the standard eigenvalue
/// problem for `S11⁻¹·S10·S00⁻¹·S01` (valid whenever `S11` is invertible)
/// and reads off eigenvalues via `nalgebra`'s Schur-decomposition-backed
/// `complex_eigenvalues`.
///
/// Deliberately unreachable outside `#[cfg(test)]` for now (see above) --
/// `#[allow(dead_code)]` rather than deleting it, since the brief requires
/// this approximation to exist as reviewable, not-yet-wired code.
#[allow(dead_code)]
pub fn johansen_eigenvalues_approx(xs: &[f64], ys: &[f64]) -> Option<Vec<f64>> {
    let n = xs.len().min(ys.len());
    if n < 4 {
        return None;
    }

    let levels = DMatrix::from_fn(n, 2, |row, col| if col == 0 { xs[row] } else { ys[row] });
    let t = n - 1;
    let delta = DMatrix::from_fn(t, 2, |row, col| levels[(row + 1, col)] - levels[(row, col)]);
    let lagged = levels.rows(0, t).into_owned();

    let t_f = t as f64;
    let s00 = delta.transpose() * &delta / t_f;
    let s11 = lagged.transpose() * &lagged / t_f;
    let s01 = delta.transpose() * &lagged / t_f;
    let s10 = s01.transpose();

    let s00_inv = s00.try_inverse()?;
    let s11_inv = s11.try_inverse()?;

    let m = s11_inv * s10 * s00_inv * s01;
    let eigenvalues = m.complex_eigenvalues();
    Some(eigenvalues.iter().map(|c| c.re).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PeerSeries, Timeframe};
    use chrono::{DateTime, Utc};

    fn ctx_with_peer(closes: Vec<f64>, peer_closes: Vec<f64>) -> MarketContext {
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let mut ctx = MarketContext::from_closes("TEST", Timeframe::Day, Horizon::Positional, closes, as_of);
        ctx.peer = Some(PeerSeries {
            symbol: "PEER".to_string(),
            closes: peer_closes,
        });
        ctx
    }

    #[test]
    fn perfectly_cointegrated_pair_recovers_exact_hedge_ratio() {
        let algo = CointegrationAlgorithm::new(3);
        let ctx = ctx_with_peer(vec![1.0, 2.0, 3.0, 4.0, 5.0], vec![2.0, 4.0, 6.0, 8.0, 10.0]);

        let output = algo.compute(&ctx);

        assert!((output.magnitude - 2.0).abs() < 1e-6);
        assert_eq!(output.direction, Direction::Neutral);
    }

    #[test]
    fn independent_non_cointegrated_walks_are_not_flagged_cointegrated() {
        // Two integer walks built from the digits of pi and e (deterministic,
        // not rng): their spread's ADF stat lands around -2.3, which is
        // classic spurious-regression territory -- more negative than the
        // Normal(0,1) 5% quantile (~-1.6449) but well short of the true
        // MacKinnon EG 2-var 5% critical value (-3.34). This is exactly the
        // gap the wrong-critical-value bug lived in: it must assert false.
        let algo = CointegrationAlgorithm::new(3);
        let xs = vec![
            1.0, 0.0, 1.0, 2.0, 3.0, 2.0, 1.0, 2.0, 3.0, 4.0, 3.0, 4.0, 5.0, 6.0, 7.0, 6.0, 7.0,
            6.0, 5.0, 4.0, 3.0, 2.0, 1.0, 2.0, 3.0, 2.0, 3.0, 2.0, 3.0, 4.0, 5.0, 4.0, 3.0, 2.0,
            1.0, 0.0, 1.0, 2.0, 3.0, 4.0,
        ];
        let ys = vec![
            1.0, 2.0, 1.0, 0.0, -1.0, 0.0, -1.0, -2.0, -3.0, -4.0, -3.0, -2.0, -3.0, -4.0, -3.0,
            -4.0, -3.0, -2.0, -1.0, -2.0, -3.0, -4.0, -5.0, -4.0, -5.0, -4.0, -3.0, -2.0, -1.0,
            -2.0, -3.0, -4.0, -5.0, -6.0, -5.0, -4.0, -3.0, -2.0, -1.0, -2.0,
        ];
        let ctx = ctx_with_peer(xs, ys);

        let output = algo.compute(&ctx);

        assert!(
            output.evidence.iter().any(|line| line == "cointegrated=false"),
            "evidence was {:?}",
            output.evidence
        );
        assert_eq!(output.confidence, 0.0);
    }

    #[test]
    fn johansen_eigenvalues_approx_runs_on_a_well_conditioned_pair() {
        // R3, not-yet-validated (see doc comment on the function): this only
        // exercises the reduction-to-standard-eigenproblem path end to end
        // (keeps it reachable, confirms it doesn't panic/return None on
        // ordinary input) -- it is NOT a correctness check of the Johansen
        // statistic itself.
        let xs = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];
        let ys = vec![2.0, 3.0, 5.0, 4.0, 6.0, 5.0, 7.0, 6.0, 8.0, 9.0];

        let eigenvalues = johansen_eigenvalues_approx(&xs, &ys);

        assert!(eigenvalues.is_some());
        assert_eq!(eigenvalues.unwrap().len(), 2);
    }

    #[test]
    fn missing_peer_context_is_a_neutral_no_op() {
        let algo = CointegrationAlgorithm::new(3);
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = MarketContext::from_closes(
            "TEST",
            Timeframe::Day,
            Horizon::Positional,
            vec![1.0, 2.0, 3.0, 4.0, 5.0],
            as_of,
        );

        let output = algo.compute(&ctx);

        assert_eq!(output.direction, Direction::Neutral);
        assert_eq!(output.magnitude, 0.0);
        assert_eq!(output.evidence, vec!["insufficient OHLCV".to_string()]);
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(CointegrationAlgorithm::new(3)))
}
