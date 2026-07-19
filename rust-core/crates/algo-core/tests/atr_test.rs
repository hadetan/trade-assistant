use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

#[test]
fn registry_contains_atr() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"atr"));
}

#[test]
fn atr_matches_hand_computed_wilder_smoothing() {
    // seed close 10; bars (H,L,C) = (12,10,11),(13,11,12),(15,11,14),(16,14,15)
    // TRs = 2, 2, 4, 2 (period 3) -> seed = (2+2+4)/3 = 8/3
    // Wilder step = (8/3 * 2 + 2) / 3 = 22/9 ~= 2.444444
    let algos = registry::all();
    let algo = algos
        .into_iter()
        .find(|a| a.id() == "atr")
        .expect("atr algorithm must be registered");

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = MarketContext {
        symbol: "TEST".into(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        closes: vec![10.0, 11.0, 12.0, 14.0, 15.0],
        opens: Vec::new(),
        highs: vec![10.0, 12.0, 13.0, 15.0, 16.0],
        lows: vec![10.0, 10.0, 11.0, 11.0, 14.0],
        volumes: Vec::new(),
        timestamps: Vec::new(),
        options: None,
        chain: None,
        peer: None,
        higher_tf: None,
        as_of,
    };

    let output = algo.compute(&ctx);

    assert!((output.magnitude - 22.0 / 9.0).abs() < 1e-6);
    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.computed_at, as_of);
}

#[test]
fn atr_no_op_guard_on_short_highs_lows() {
    let algos = registry::all();
    let algo = algos
        .into_iter()
        .find(|a| a.id() == "atr")
        .expect("atr algorithm must be registered");

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = MarketContext::from_closes(
        "TEST",
        Timeframe::Day,
        Horizon::Positional,
        vec![10.0, 11.0, 12.0, 14.0, 15.0],
        as_of,
    );

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.evidence, vec!["insufficient OHLCV".to_string()]);
}
