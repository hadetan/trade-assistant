use algo_core::{AlgoOutput, Algorithm, Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

struct AlwaysBullish;

impl Algorithm for AlwaysBullish {
    fn id(&self) -> &'static str {
        "always_bullish"
    }

    fn required_lookback(&self) -> usize {
        1
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> AlgoOutput {
        AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction: Direction::Bullish,
            magnitude: 1.0,
            confidence: 1.0,
            evidence: vec!["always bullish, by construction".to_string()],
            computed_at: ctx.as_of,
        }
    }
}

#[test]
fn algorithm_trait_is_object_safe_and_computable() {
    let algo = AlwaysBullish;
    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = MarketContext {
        symbol: "NSE:INFY".to_string(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        closes: vec![100.0, 101.0, 102.0],
        as_of,
    };

    let output = algo.compute(&ctx);

    assert_eq!(output.algo_id, "always_bullish");
    assert_eq!(output.symbol, "NSE:INFY");
    assert_eq!(output.direction, Direction::Bullish);
    assert_eq!(output.computed_at, as_of);
}
