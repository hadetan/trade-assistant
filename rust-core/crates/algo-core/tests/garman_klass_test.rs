use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};
use std::f64::consts::E;

#[test]
fn garman_klass_is_registered() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"garman_klass"));
}

#[test]
fn garman_klass_matches_hand_derived_variance_on_single_bar() {
    let as_of: DateTime<Utc> = "2020-01-01T00:00:00Z".parse().unwrap();
    let ctx = MarketContext {
        symbol: "NSE:TEST".to_string(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        closes: vec![1.0],
        opens: vec![1.0],
        highs: vec![E],
        lows: vec![1.0],
        volumes: Vec::new(),
        timestamps: Vec::new(),
        options: None,
        chain: None,
        peer: None,
        higher_tf: None,
        as_of,
    };

    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "garman_klass")
        .expect("garman_klass must be registered");

    let output = algo.compute(&ctx);

    // ln(H/L) = ln(e) = 1, ln(C/O) = ln(1) = 0
    // sigma^2 = 0.5*1^2 - (2ln2-1)*0^2 = 0.5
    let expected_variance = 0.5_f64;
    let expected_sigma = expected_variance.sqrt();

    assert!((expected_variance - 0.5).abs() < 1e-6);
    assert!((output.magnitude - expected_sigma).abs() < 1e-6);
    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.computed_at, as_of);
}

#[test]
fn garman_klass_no_ops_on_insufficient_ohlcv() {
    let as_of: DateTime<Utc> = "2020-01-01T00:00:00Z".parse().unwrap();
    let ctx = MarketContext::from_closes(
        "NSE:TEST",
        Timeframe::Day,
        Horizon::Positional,
        vec![100.0, 101.0],
        as_of,
    );

    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "garman_klass")
        .expect("garman_klass must be registered");

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.evidence, vec!["insufficient OHLCV".to_string()]);
    assert_eq!(output.computed_at, as_of);
}
