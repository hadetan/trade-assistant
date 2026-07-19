use crate::{Algorithm, Direction, Horizon, MarketContext};

const REQUIRED_LOOKBACK: usize = 30;
const MAX_ITER: usize = 500;

pub struct GarchAlgorithm;

impl GarchAlgorithm {
    pub fn new() -> Self {
        Self
    }
}

impl Default for GarchAlgorithm {
    fn default() -> Self {
        Self::new()
    }
}

impl Algorithm for GarchAlgorithm {
    fn id(&self) -> &'static str {
        "garch"
    }

    fn required_lookback(&self) -> usize {
        REQUIRED_LOOKBACK
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        let returns = log_returns(&ctx.closes);
        let (omega, alpha, beta) = fit_garch(&returns);
        let variances = conditional_variances(&returns, omega, alpha, beta);
        let sigma_forecast = variances.last().unwrap().sqrt();
        let long_run_sigma = long_run_variance(omega, alpha, beta).sqrt();

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction: Direction::Neutral,
            magnitude: sigma_forecast,
            confidence: 0.0,
            evidence: vec![format!(
                "GARCH(1,1) sigma_forecast={:.6}, long-run sigma={:.6} (omega={:.3e}, alpha={:.4}, beta={:.4})",
                sigma_forecast, long_run_sigma, omega, alpha, beta
            )],
            computed_at: ctx.as_of,
        }
    }
}

fn log_returns(closes: &[f64]) -> Vec<f64> {
    closes.windows(2).map(|w| (w[1] / w[0]).ln()).collect()
}

fn long_run_variance(omega: f64, alpha: f64, beta: f64) -> f64 {
    // Clamped below 1.0 rather than left unguarded: a fit that drifts to
    // alpha+beta ~= 1 (integrated GARCH) would otherwise blow this division
    // up to +inf and poison the evidence string, even though the recursion
    // forecast itself stays well-defined.
    let persistence = (alpha + beta).min(0.999);
    omega / (1.0 - persistence)
}

fn forecast_variance(omega: f64, alpha: f64, beta: f64, r_prev: f64, sigma2_prev: f64) -> f64 {
    omega + alpha * r_prev * r_prev + beta * sigma2_prev
}

/// `variances[i]` is the conditional variance for `returns[i]` (seeded at
/// the long-run/unconditional variance for `i == 0`); the trailing extra
/// element is the one-step-ahead forecast for the period after the series.
fn conditional_variances(returns: &[f64], omega: f64, alpha: f64, beta: f64) -> Vec<f64> {
    let mut variances = Vec::with_capacity(returns.len() + 1);
    variances.push(long_run_variance(omega, alpha, beta));
    for &r in returns {
        let prev = *variances.last().unwrap();
        variances.push(forecast_variance(omega, alpha, beta, r, prev));
    }
    variances
}

fn negative_log_likelihood(returns: &[f64], omega: f64, alpha: f64, beta: f64) -> f64 {
    if omega <= 1e-12 || alpha < 0.0 || beta < 0.0 || alpha + beta >= 0.999 {
        return f64::INFINITY;
    }
    let variances = conditional_variances(returns, omega, alpha, beta);
    returns
        .iter()
        .zip(variances.iter())
        .map(|(r, h)| 0.5 * ((2.0 * std::f64::consts::PI * h).ln() + r * r / h))
        .sum()
}

/// Bounded Nelder-Mead over (omega, alpha, beta), maximizing the GARCH(1,1)
/// log-likelihood. Hand-rolled per the algorithm-catalog plan (Task 30, R2):
/// argmin was rejected to avoid a shared Cargo.toml edit across parallel
/// worktrees, so bounds are enforced as an infinite penalty inside
/// `negative_log_likelihood` rather than a constrained-solver API.
fn fit_garch(returns: &[f64]) -> (f64, f64, f64) {
    let sample_variance = returns.iter().map(|r| r * r).sum::<f64>() / returns.len() as f64;
    let initial = [(sample_variance * 0.05).max(1e-8), 0.10, 0.80];
    let step = [(initial[0] * 0.5).max(1e-8), 0.05, 0.05];

    let objective = |p: [f64; 3]| negative_log_likelihood(returns, p[0], p[1], p[2]);

    let mut simplex: Vec<[f64; 3]> = vec![initial];
    for (i, s) in step.iter().enumerate() {
        let mut vertex = initial;
        vertex[i] += s;
        simplex.push(vertex);
    }
    let mut values: Vec<f64> = simplex.iter().copied().map(objective).collect();

    let dims = initial.len();
    for _ in 0..MAX_ITER {
        let mut order: Vec<usize> = (0..=dims).collect();
        order.sort_by(|&a, &b| values[a].partial_cmp(&values[b]).unwrap());
        simplex = order.iter().map(|&i| simplex[i]).collect();
        values = order.iter().map(|&i| values[i]).collect();

        if (values[dims] - values[0]).abs() < 1e-10 {
            break;
        }

        let mut centroid = [0.0; 3];
        for vertex in &simplex[..dims] {
            for d in 0..dims {
                centroid[d] += vertex[d] / dims as f64;
            }
        }

        let worst = simplex[dims];
        let mut reflected = [0.0; 3];
        for d in 0..dims {
            reflected[d] = centroid[d] + (centroid[d] - worst[d]);
        }
        let reflected_value = objective(reflected);

        if reflected_value < values[0] {
            let mut expanded = [0.0; 3];
            for d in 0..dims {
                expanded[d] = centroid[d] + 2.0 * (reflected[d] - centroid[d]);
            }
            let expanded_value = objective(expanded);
            if expanded_value < reflected_value {
                simplex[dims] = expanded;
                values[dims] = expanded_value;
            } else {
                simplex[dims] = reflected;
                values[dims] = reflected_value;
            }
        } else if reflected_value < values[dims - 1] {
            simplex[dims] = reflected;
            values[dims] = reflected_value;
        } else {
            let mut contracted = [0.0; 3];
            for d in 0..dims {
                contracted[d] = centroid[d] + 0.5 * (worst[d] - centroid[d]);
            }
            let contracted_value = objective(contracted);
            if contracted_value < values[dims] {
                simplex[dims] = contracted;
                values[dims] = contracted_value;
            } else {
                let best = simplex[0];
                for i in 1..=dims {
                    for d in 0..dims {
                        simplex[i][d] = best[d] + 0.5 * (simplex[i][d] - best[d]);
                    }
                    values[i] = objective(simplex[i]);
                }
            }
        }
    }

    let best = (0..=dims).min_by(|&a, &b| values[a].partial_cmp(&values[b]).unwrap()).unwrap();
    let fitted = simplex[best];
    (fitted[0].max(1e-12), fitted[1].max(0.0), fitted[2].max(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn garch_long_run_variance_matches_closed_form() {
        // omega/(1-alpha-beta) = 1e-5/0.05 = 0.0002 -> long-run sigma = 0.01414213562...
        let variance = long_run_variance(1e-5, 0.10, 0.85);

        assert!((variance - 0.0002).abs() < 1e-9);
        assert!((variance.sqrt() - 0.0141421356).abs() < 1e-6);
    }

    #[test]
    fn garch_recursion_step_matches_formula() {
        // sigma2_t = omega + alpha*r^2 + beta*sigma2_prev
        //          = 1e-5 + 0.10*0.02^2 + 0.85*0.0003 = 0.000305
        let sigma2 = forecast_variance(1e-5, 0.10, 0.85, 0.02, 0.0003);

        assert!((sigma2 - 0.000305).abs() < 1e-9);
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(GarchAlgorithm::new()))
}
