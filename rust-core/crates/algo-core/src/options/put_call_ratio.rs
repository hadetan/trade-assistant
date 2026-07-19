use crate::options::context::OptionChainSnapshot;
use crate::{Algorithm, Direction, Horizon, MarketContext};

#[derive(Default)]
pub struct PutCallRatioAlgorithm;

impl PutCallRatioAlgorithm {
    pub fn new() -> Self {
        Self
    }

    fn no_op(&self, ctx: &MarketContext, reason: &str) -> crate::AlgoOutput {
        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction: Direction::Neutral,
            magnitude: 0.0,
            confidence: 0.0,
            evidence: vec![reason.into()],
            computed_at: ctx.as_of,
        }
    }
}

impl Algorithm for PutCallRatioAlgorithm {
    fn id(&self) -> &'static str {
        "put_call_ratio"
    }

    fn required_lookback(&self) -> usize {
        0
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        let Some(chain) = &ctx.chain else {
            return self.no_op(ctx, "no options context");
        };

        let (put_oi, call_oi) = sum_oi(chain);

        if call_oi == 0.0 {
            return self.no_op(ctx, "undefined pcr (zero call OI)");
        }

        let pcr = put_oi / call_oi;

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction: Direction::Neutral,
            magnitude: pcr,
            confidence: 0.0,
            evidence: vec![format!("pcr={:.2}", pcr)],
            computed_at: ctx.as_of,
        }
    }
}

fn sum_oi(chain: &OptionChainSnapshot) -> (f64, f64) {
    chain
        .strikes
        .iter()
        .fold((0.0, 0.0), |(put, call), row| {
            (put + row.put_oi, call + row.call_oi)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::options::context::StrikeRow;
    use crate::Timeframe;
    use chrono::{DateTime, Utc};

    fn ctx_with_chain(chain: Option<OptionChainSnapshot>) -> MarketContext {
        let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let mut ctx = MarketContext::from_closes(
            "TEST",
            Timeframe::Day,
            Horizon::Positional,
            vec![],
            as_of,
        );
        ctx.chain = chain;
        ctx
    }

    #[test]
    fn pcr_matches_hand_computed_ratio() {
        // Sigma put_oi = 1500, Sigma call_oi = 1000 -> PCR = 1.5
        let chain = OptionChainSnapshot {
            spot: 100.0,
            strikes: vec![
                StrikeRow { strike: 90.0, call_oi: 400.0, put_oi: 600.0 },
                StrikeRow { strike: 100.0, call_oi: 600.0, put_oi: 900.0 },
            ],
        };
        let ctx = ctx_with_chain(Some(chain));
        let algo = PutCallRatioAlgorithm::new();

        let output = algo.compute(&ctx);

        assert!((output.magnitude - 1.5).abs() < 1e-9);
        assert_eq!(output.direction, Direction::Neutral);
        assert!(output.evidence[0].contains("1.50"));
    }

    #[test]
    fn pcr_guards_zero_call_oi() {
        let chain = OptionChainSnapshot {
            spot: 100.0,
            strikes: vec![StrikeRow { strike: 100.0, call_oi: 0.0, put_oi: 500.0 }],
        };
        let ctx = ctx_with_chain(Some(chain));
        let algo = PutCallRatioAlgorithm::new();

        let output = algo.compute(&ctx);

        assert_eq!(output.magnitude, 0.0);
        assert_eq!(output.direction, Direction::Neutral);
        assert_eq!(output.evidence[0], "undefined pcr (zero call OI)");
    }

    #[test]
    fn pcr_no_ops_without_chain() {
        let ctx = ctx_with_chain(None);
        let algo = PutCallRatioAlgorithm::new();

        let output = algo.compute(&ctx);

        assert_eq!(output.magnitude, 0.0);
        assert_eq!(output.direction, Direction::Neutral);
        assert_eq!(output.evidence[0], "no options context");
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(PutCallRatioAlgorithm::new()))
}
