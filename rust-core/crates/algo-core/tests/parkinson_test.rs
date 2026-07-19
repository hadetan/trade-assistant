use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

#[test]
fn registry_contains_parkinson() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"parkinson"));
}

#[test]
fn parkinson_matches_hand_computed_single_bar() {
    // H = e (2.718281828), L = 1 -> ln(H/L) = 1
    // sigma^2 = 1 / (4 * ln2) = 0.360674, sigma = 0.600561
    let algos = registry::all();
    let algo = algos
        .into_iter()
        .find(|a| a.id() == "parkinson")
        .expect("parkinson algorithm must be registered");

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = MarketContext {
        symbol: "TEST".into(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        closes: vec![1.5],
        opens: Vec::new(),
        highs: vec![std::f64::consts::E],
        lows: vec![1.0],
        volumes: Vec::new(),
        timestamps: Vec::new(),
        options: None,
        chain: None,
        peer: None,
        higher_tf: None,
        as_of,
    };

    let output = algo.compute(&ctx);

    assert!((output.magnitude.powi(2) - 0.360674).abs() < 1e-6);
    assert!((output.magnitude - 0.600561).abs() < 1e-5);
    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.computed_at, as_of);
}

#[test]
fn parkinson_no_op_guard_on_short_highs_lows() {
    let algos = registry::all();
    let algo = algos
        .into_iter()
        .find(|a| a.id() == "parkinson")
        .expect("parkinson algorithm must be registered");

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = MarketContext::from_closes(
        "TEST",
        Timeframe::Day,
        Horizon::Positional,
        vec![100.0],
        as_of,
    );

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.evidence, vec!["insufficient OHLCV".to_string()]);
}
