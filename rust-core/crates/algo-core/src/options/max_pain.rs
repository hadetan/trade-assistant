use crate::{Algorithm, Direction, Horizon, MarketContext};

pub struct MaxPainAlgorithm;

impl MaxPainAlgorithm {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MaxPainAlgorithm {
    fn default() -> Self {
        Self::new()
    }
}

impl Algorithm for MaxPainAlgorithm {
    fn id(&self) -> &'static str {
        "max_pain"
    }

    fn required_lookback(&self) -> usize {
        0
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        let chain = match &ctx.chain {
            Some(chain) => chain,
            None => {
                return crate::AlgoOutput {
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
            }
        };

        let max_pain_strike = chain
            .strikes
            .iter()
            .map(|candidate| {
                let pain: f64 = chain
                    .strikes
                    .iter()
                    .map(|row| {
                        row.call_oi * (candidate.strike - row.strike).max(0.0)
                            + row.put_oi * (row.strike - candidate.strike).max(0.0)
                    })
                    .sum();
                (candidate.strike, pain)
            })
            .min_by(|(_, a), (_, b)| a.total_cmp(b))
            .map(|(strike, _)| strike)
            .unwrap_or(0.0);

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction: Direction::Neutral,
            magnitude: 0.0,
            confidence: 0.0,
            evidence: vec![format!(
                "max_pain={:.0} (meaningful only near expiry)",
                max_pain_strike
            )],
            computed_at: ctx.as_of,
        }
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(MaxPainAlgorithm::new()))
}
