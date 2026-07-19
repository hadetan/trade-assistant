use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

fn ctx_with_closes_and_volumes(closes: Vec<f64>, volumes: Vec<f64>, as_of: DateTime<Utc>) -> MarketContext {
    let mut ctx = MarketContext::from_closes("NSE:TEST", Timeframe::Day, Horizon::Positional, closes, as_of);
    ctx.volumes = volumes;
    ctx
}

#[test]
fn obv_is_registered() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"obv"));
}

#[test]
fn obv_matches_brief_reference_value() {
    // closes=[10,11,10,12], volumes=[100,200,150,300]
    // OBV path: 0 -> +200 -> 200-150=50 -> 50+300=350
    // last step +300 -> Bullish
    let algos = registry::all();
    let algo = algos.iter().find(|a| a.id() == "obv").expect("obv registered");

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = ctx_with_closes_and_volumes(
        vec![10.0, 11.0, 10.0, 12.0],
        vec![100.0, 200.0, 150.0, 300.0],
        as_of,
    );

    let output = algo.compute(&ctx);

    assert!((output.magnitude - 300.0).abs() < 1e-9);
    assert_eq!(output.direction, Direction::Bullish);
    assert_eq!(output.computed_at, as_of);
}

#[test]
fn obv_no_op_guards_on_insufficient_volumes() {
    let algos = registry::all();
    let algo = algos.iter().find(|a| a.id() == "obv").expect("obv registered");

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = ctx_with_closes_and_volumes(vec![10.0, 11.0, 10.0, 12.0], vec![100.0], as_of);

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.evidence, vec!["insufficient OHLCV".to_string()]);
}
