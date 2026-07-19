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
    let ctx = MarketContext::from_closes(
        "NSE:INFY",
        Timeframe::Day,
        Horizon::Positional,
        vec![100.0, 101.0, 102.0],
        as_of,
    );

    let output = algo.compute(&ctx);

    assert_eq!(output.algo_id, "always_bullish");
    assert_eq!(output.symbol, "NSE:INFY");
    assert_eq!(output.direction, Direction::Bullish);
    assert_eq!(output.computed_at, as_of);
}

#[test]
fn registry_contains_the_phase_one_baseline_algorithms() {
    // Exact catalog membership (all 34 ids) is registry_count_test.rs's job;
    // this just guards against the Phase-1 baseline disappearing.
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();

    assert!(ids.contains(&"sma"));
    assert!(ids.contains(&"ema"));
    assert!(ids.contains(&"rsi"));
}

fn ctx_with_closes(n: usize) -> MarketContext {
    let closes = (0..n).map(|i| 100.0 + i as f64).collect();
    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    MarketContext::from_closes("NSE:TEST", Timeframe::Day, Horizon::Positional, closes, as_of)
}

/// A test double with a fixed `required_lookback`, used instead of the real
/// catalog so these tests exercise `run_applicable`'s filtering logic without
/// being coupled to how many algorithms happen to be registered.
struct NeedsLookback(&'static str, usize);

impl Algorithm for NeedsLookback {
    fn id(&self) -> &'static str {
        self.0
    }

    fn required_lookback(&self) -> usize {
        self.1
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
            direction: Direction::Neutral,
            magnitude: 0.0,
            confidence: 0.0,
            evidence: vec![],
            computed_at: ctx.as_of,
        }
    }
}

fn short_and_long_lookback_algos() -> Vec<Box<dyn Algorithm>> {
    vec![Box::new(NeedsLookback("short", 14)), Box::new(NeedsLookback("long", 20))]
}

#[test]
fn run_applicable_skips_algorithms_without_enough_lookback() {
    // 15 closes: "short" (14) needs 15 and runs; "long" (20) is skipped.
    let algos = short_and_long_lookback_algos();
    let outputs = run_applicable(&algos, &ctx_with_closes(15));
    let ids: Vec<&str> = outputs.iter().map(|o| o.algo_id).collect();
    assert_eq!(ids, vec!["short"]);
}

#[test]
fn run_applicable_runs_all_when_history_is_sufficient() {
    let algos = short_and_long_lookback_algos();
    let outputs = run_applicable(&algos, &ctx_with_closes(21));
    assert_eq!(outputs.len(), 2);
}

#[test]
fn run_applicable_returns_empty_for_no_history_instead_of_panicking() {
    let algos = short_and_long_lookback_algos();
    let outputs = run_applicable(&algos, &ctx_with_closes(0));
    assert!(outputs.is_empty());
}
