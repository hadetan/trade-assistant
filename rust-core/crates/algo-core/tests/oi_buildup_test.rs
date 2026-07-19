use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, OptionsContext, Timeframe};
use chrono::{DateTime, Utc};

fn options_ctx(oi: f64, prev_oi: f64) -> OptionsContext {
    OptionsContext {
        spot: 100.0,
        strike: 100.0,
        rate: 0.05,
        time_to_expiry_years: 1.0,
        is_call: true,
        iv: 0.20,
        oi,
        prev_oi,
        oi_day_high: oi.max(prev_oi),
        oi_day_low: oi.min(prev_oi),
        market_price: 10.0,
    }
}

fn ctx_with_options(closes: Vec<f64>, options: Option<OptionsContext>) -> MarketContext {
    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let mut ctx = MarketContext::from_closes(
        "NSE:TEST",
        Timeframe::Day,
        Horizon::Positional,
        closes,
        as_of,
    );
    ctx.options = options;
    ctx
}

#[test]
fn registry_contains_oi_buildup() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"oi_buildup"));
}

#[test]
fn price_up_and_oi_up_is_long_buildup() {
    let algos = registry::all();
    let algo = algos.iter().find(|a| a.id() == "oi_buildup").unwrap();

    let ctx = ctx_with_options(vec![100.0, 102.0], Some(options_ctx(1200.0, 1000.0)));
    let output = algo.compute(&ctx);

    assert!(output.evidence[0].contains("long buildup"));
    assert_eq!(output.direction, Direction::Neutral);
    assert!(output.magnitude > 0.0);
}

#[test]
fn price_down_and_oi_down_is_long_unwinding() {
    let algos = registry::all();
    let algo = algos.iter().find(|a| a.id() == "oi_buildup").unwrap();

    let ctx = ctx_with_options(vec![102.0, 100.0], Some(options_ctx(800.0, 1000.0)));
    let output = algo.compute(&ctx);

    assert!(output.evidence[0].contains("long unwinding"));
    assert_eq!(output.direction, Direction::Neutral);
}

#[test]
fn price_up_and_oi_down_is_short_covering() {
    let algos = registry::all();
    let algo = algos.iter().find(|a| a.id() == "oi_buildup").unwrap();

    let ctx = ctx_with_options(vec![100.0, 102.0], Some(options_ctx(800.0, 1000.0)));
    let output = algo.compute(&ctx);

    assert!(output.evidence[0].contains("short covering"));
    assert_eq!(output.direction, Direction::Neutral);
}

#[test]
fn price_down_and_oi_up_is_short_buildup() {
    let algos = registry::all();
    let algo = algos.iter().find(|a| a.id() == "oi_buildup").unwrap();

    let ctx = ctx_with_options(vec![102.0, 100.0], Some(options_ctx(1200.0, 1000.0)));
    let output = algo.compute(&ctx);

    assert!(output.evidence[0].contains("short buildup"));
    assert_eq!(output.direction, Direction::Neutral);
}

#[test]
fn no_op_guard_when_options_context_is_absent() {
    let algos = registry::all();
    let algo = algos.iter().find(|a| a.id() == "oi_buildup").unwrap();

    let ctx = ctx_with_options(vec![100.0, 102.0], None);
    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.evidence, vec!["insufficient OHLCV".to_string()]);
}

#[test]
fn no_op_guard_when_fewer_than_two_closes() {
    let algos = registry::all();
    let algo = algos.iter().find(|a| a.id() == "oi_buildup").unwrap();

    let ctx = ctx_with_options(vec![100.0], Some(options_ctx(1200.0, 1000.0)));
    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.evidence, vec!["insufficient OHLCV".to_string()]);
}
