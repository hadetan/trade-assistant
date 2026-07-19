use crate::{Algorithm, Direction, Horizon, MarketContext};
use implied_vol::{DefaultSpecialFn, ImpliedBlackVolatility};

pub struct ImpliedVolAlgorithm;

impl ImpliedVolAlgorithm {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ImpliedVolAlgorithm {
    fn default() -> Self {
        Self::new()
    }
}

impl Algorithm for ImpliedVolAlgorithm {
    fn id(&self) -> &'static str {
        "implied_vol"
    }

    fn required_lookback(&self) -> usize {
        0
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        let Some(opts) = &ctx.options else {
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
        };

        // `implied-vol` solves against undiscounted forward prices (Black-76
        // convention); ctx.options carries spot + a discounted market price,
        // so both are scaled by e^{rT} before solving. The discount factor
        // cancels exactly, leaving the same sigma the spot-based BSM price
        // implies.
        let growth = (opts.rate * opts.time_to_expiry_years).exp();
        let forward = opts.spot * growth;
        let undiscounted_price = opts.market_price * growth;

        // Jäckel's "Let's Be Rational" rational-cubic iteration -- robust
        // near-zero-vega (deep ITM/OTM), unlike naive Newton-Raphson.
        let iv = ImpliedBlackVolatility::builder()
            .option_price(undiscounted_price)
            .forward(forward)
            .strike(opts.strike)
            .expiry(opts.time_to_expiry_years)
            .is_call(opts.is_call)
            .build()
            .and_then(|b| b.calculate::<DefaultSpecialFn>());

        let (magnitude, confidence, evidence) = match iv {
            Some(sigma) => (sigma, 1.0, format!("iv={:.4}", sigma)),
            None => (0.0, 0.0, "iv=unsolved".to_string()),
        };

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction: Direction::Neutral,
            magnitude,
            confidence,
            evidence: vec![evidence],
            computed_at: ctx.as_of,
        }
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(ImpliedVolAlgorithm::new()))
}
