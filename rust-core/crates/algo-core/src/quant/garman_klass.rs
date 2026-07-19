use crate::{AlgoOutput, Algorithm, Direction, Horizon, MarketContext};

pub struct GarmanKlassAlgorithm;

impl GarmanKlassAlgorithm {
    pub fn new() -> Self {
        Self
    }
}

impl Algorithm for GarmanKlassAlgorithm {
    fn id(&self) -> &'static str {
        "garman_klass"
    }

    fn required_lookback(&self) -> usize {
        1
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> AlgoOutput {
        let lookback = self.required_lookback();
        if ctx.highs.len() < lookback
            || ctx.lows.len() < lookback
            || ctx.opens.len() < lookback
            || ctx.closes.len() < lookback
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

        let n = ctx.closes.len();
        // Rogers-Satchell/Garman-Klass drift-independence constant (2*ln(2) - 1),
        // subtracted per bar to correct the open-close term's upward bias.
        let bias = 2.0 * std::f64::consts::LN_2 - 1.0;
        let variance = (0..n)
            .map(|i| {
                let hl_term = 0.5 * (ctx.highs[i] / ctx.lows[i]).ln().powi(2);
                let co_term = bias * (ctx.closes[i] / ctx.opens[i]).ln().powi(2);
                hl_term - co_term
            })
            .sum::<f64>()
            / n as f64;
        let sigma = variance.sqrt();

        AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction: Direction::Neutral,
            magnitude: sigma,
            confidence: 0.0,
            evidence: vec![format!(
                "Garman-Klass variance {:.6} (sigma {:.6}) over {} bar(s)",
                variance, sigma, n
            )],
            computed_at: ctx.as_of,
        }
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(GarmanKlassAlgorithm::new()))
}
