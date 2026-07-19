use algo_core::registry;
use algo_core::registry::run_applicable;
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

#[test]
fn registry_contains_all_three_phase_one_algorithms() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();

    assert!(ids.contains(&"sma"));
    assert!(ids.contains(&"ema"));
    assert!(ids.contains(&"rsi"));
    assert_eq!(ids.len(), 3);
}

fn ctx_with_closes(n: usize) -> MarketContext {
    let closes = (0..n).map(|i| 100.0 + i as f64).collect();
    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    MarketContext {
        symbol: "NSE:TEST".to_string(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        closes,
        as_of,
    }
}

#[test]
fn run_applicable_skips_algorithms_without_enough_lookback() {
    // 15 closes: rsi(14) needs 15 and runs; sma(20)/ema(20) need 20 and are skipped.
    let algos = registry::all();
    let outputs = run_applicable(&algos, &ctx_with_closes(15));
    let ids: Vec<&str> = outputs.iter().map(|o| o.algo_id).collect();
    assert_eq!(ids, vec!["rsi"]);
}

#[test]
fn run_applicable_runs_all_when_history_is_sufficient() {
    let algos = registry::all();
    let outputs = run_applicable(&algos, &ctx_with_closes(21));
    assert_eq!(outputs.len(), 3);
}

#[test]
fn run_applicable_returns_empty_for_no_history_instead_of_panicking() {
    let algos = registry::all();
    let outputs = run_applicable(&algos, &ctx_with_closes(0));
    assert!(outputs.is_empty());
}
