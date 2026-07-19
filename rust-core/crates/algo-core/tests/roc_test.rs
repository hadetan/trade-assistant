use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

#[test]
fn registry_contains_roc() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();

    assert!(ids.contains(&"roc"));
}

#[test]
fn roc_matches_reference_value_for_brief_test_input() {
    // The brief's exact test input (closes=[10,11,12,13,14], period 2) targets
    // the period-2 instance used in roc.rs's own unit test; the id="roc"
    // instance obtainable from the registry is the period-12 registered
    // default, whose required_lookback is 13. To exercise the registered
    // instance through the public registry (algo structs stay private) we
    // reproduce the brief's exact ratio (previous=12, current=14, 12 bars
    // apart) rather than its literal 5-close vector, so the expected value
    // (16.6667, Bullish) is unchanged from the brief.
    let algos = registry::all();
    let algo = algos
        .into_iter()
        .find(|a| a.id() == "roc")
        .expect("roc algorithm must be registered");

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let mut closes = vec![12.0; algo.required_lookback()];
    let last = closes.len() - 1;
    closes[last] = 14.0;
    let ctx = MarketContext::from_closes("TEST", Timeframe::Day, Horizon::Positional, closes, as_of);

    assert!(algo.required_lookback() <= ctx.closes.len());

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Bullish);
    assert!((output.magnitude - 16.666666666666664).abs() < 1e-4);
    assert!(output.magnitude > 0.0);
    assert_eq!(output.computed_at, as_of);
}
