use crate::{Algorithm, AlgoOutput, Direction, Horizon, MarketContext};

/// Yang-Zhang (2000) OHLC volatility estimator: the design's preferred
/// default (design §6.2) because it sums an overnight (close-to-open) term
/// with intraday open-close and Rogers-Satchell terms, so it captures both
/// NSE's daily gap-up/gap-down sessions and intraday drift that range-only
/// estimators (Parkinson, Garman-Klass) miss.
pub struct YangZhangAlgorithm;

impl YangZhangAlgorithm {
    pub fn new() -> Self {
        Self
    }
}

impl Default for YangZhangAlgorithm {
    fn default() -> Self {
        Self::new()
    }
}

impl Algorithm for YangZhangAlgorithm {
    fn id(&self) -> &'static str {
        "yang_zhang"
    }

    fn required_lookback(&self) -> usize {
        3
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> AlgoOutput {
        let rl = self.required_lookback();
        if ctx.opens.len() < rl
            || ctx.highs.len() < rl
            || ctx.lows.len() < rl
            || ctx.closes.len() < rl
        {
            return AlgoOutput {
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

        let sigma = yang_zhang_sigma(&ctx.opens, &ctx.highs, &ctx.lows, &ctx.closes);

        AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction: Direction::Neutral,
            magnitude: sigma,
            confidence: 0.0,
            evidence: vec![format!("Yang-Zhang sigma = {sigma:.6}")],
            computed_at: ctx.as_of,
        }
    }
}

/// Bar 0 anchors only the first overnight return (its own open/high/low are
/// unused); `n = closes.len() - 1` periods feed the three variance terms,
/// matching Yang & Zhang's original parameterization of `k` by `n`.
fn yang_zhang_sigma(opens: &[f64], highs: &[f64], lows: &[f64], closes: &[f64]) -> f64 {
    let total = closes.len();
    let n = (total - 1) as f64;

    let mut overnight = Vec::with_capacity(total - 1);
    let mut open_close = Vec::with_capacity(total - 1);
    let mut rs_sum = 0.0;

    for i in 1..total {
        let (o, h, l, c) = (opens[i], highs[i], lows[i], closes[i]);
        let prev_close = closes[i - 1];

        overnight.push((o / prev_close).ln());
        open_close.push((c / o).ln());
        rs_sum += rogers_satchell_term(h, l, o, c);
    }

    let overnight_var = sample_variance(&overnight, n);
    let open_close_var = sample_variance(&open_close, n);
    let rs_var = rs_sum / n;

    let k = 0.34 / (1.34 + (n + 1.0) / (n - 1.0));
    let yz_var = overnight_var + k * open_close_var + (1.0 - k) * rs_var;

    yz_var.sqrt()
}

fn rogers_satchell_term(h: f64, l: f64, o: f64, c: f64) -> f64 {
    (h / c).ln() * (h / o).ln() + (l / c).ln() * (l / o).ln()
}

fn sample_variance(values: &[f64], n: f64) -> f64 {
    let mean = values.iter().sum::<f64>() / n;
    values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (n - 1.0)
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(YangZhangAlgorithm::new()))
}
