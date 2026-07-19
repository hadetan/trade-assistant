use blackscholes::{Greeks as _, Inputs, OptionType};

use crate::{Algorithm, AlgoOutput, Direction, Horizon, MarketContext};

pub struct BsmGreeksAlgorithm;

impl BsmGreeksAlgorithm {
    pub fn new() -> Self {
        Self
    }
}

impl Algorithm for BsmGreeksAlgorithm {
    fn id(&self) -> &'static str {
        "bsm_greeks"
    }

    fn required_lookback(&self) -> usize {
        0
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> AlgoOutput {
        let Some(opts) = &ctx.options else {
            return AlgoOutput {
                algo_id: self.id(),
                symbol: ctx.symbol.clone(),
                timeframe: ctx.timeframe,
                horizon: ctx.horizon,
                direction: Direction::Neutral,
                magnitude: 0.0,
                confidence: 0.0,
                evidence: vec!["no options context".into()],
                computed_at: ctx.as_of,
            };
        };

        let option_type = if opts.is_call {
            OptionType::Call
        } else {
            OptionType::Put
        };

        let inputs = Inputs::new(
            option_type,
            opts.spot as f32,
            opts.strike as f32,
            None,
            opts.rate as f32,
            0.0,
            opts.time_to_expiry_years as f32,
            Some(opts.iv as f32),
        );

        let delta = inputs.calc_delta().expect("sigma always Some") as f64;
        let gamma = inputs.calc_gamma().expect("sigma always Some") as f64;
        let theta = inputs.calc_theta().expect("sigma always Some") as f64;
        let vega = inputs.calc_vega().expect("sigma always Some") as f64;
        let rho = inputs.calc_rho().expect("sigma always Some") as f64;

        AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction: Direction::Neutral,
            magnitude: delta.abs(),
            confidence: 0.0,
            evidence: vec![format!(
                "delta={:.4} gamma={:.4} theta={:.4} vega={:.4} rho={:.4}",
                delta, gamma, theta, vega, rho
            )],
            computed_at: ctx.as_of,
        }
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(BsmGreeksAlgorithm::new()))
}
