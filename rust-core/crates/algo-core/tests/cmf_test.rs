use algo_core::{registry, Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

#[test]
fn cmf_registered_and_matches_reference_value() {
    let algos = registry::all();
    assert!(algos.iter().any(|a| a.id() == "cmf"), "cmf not registered");

    let algo = algos
        .iter()
        .find(|a| a.id() == "cmf")
        .expect("cmf algorithm not found in registry");

    let as_of: DateTime<Utc> = "2020-01-01T00:00:00Z".parse().unwrap();
    let ctx = MarketContext {
        symbol: "TEST".to_string(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        closes: vec![9.5, 9.5],
        opens: Vec::new(),
        highs: vec![10.0, 11.0],
        lows: vec![8.0, 9.0],
        volumes: vec![100.0, 200.0],
        timestamps: Vec::new(),
        options: None,
        chain: None,
        peer: None,
        higher_tf: None,
        as_of,
    };

    let output = algo.compute(&ctx);

    // bar1: MFM=((9.5-8)-(10-9.5))/2=0.5, MFV=50
    // bar2: MFM=((9.5-9)-(11-9.5))/2=-0.5, MFV=-100
    // CMF = (50 - 100) / (100 + 200) = -0.166667
    assert!(
        (output.magnitude - (-0.166667)).abs() < 1e-5,
        "expected CMF ~= -0.166667, got {}",
        output.magnitude
    );
    assert_eq!(output.direction, Direction::Bearish);
    assert!(output.magnitude < 0.0);
    assert_eq!(output.computed_at, as_of);
}

#[test]
fn cmf_no_op_guard_returns_neutral_on_insufficient_ohlcv() {
    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "cmf")
        .expect("cmf algorithm not found in registry");

    let as_of: DateTime<Utc> = "2020-01-01T00:00:00Z".parse().unwrap();
    let ctx = MarketContext::from_closes(
        "TEST",
        Timeframe::Day,
        Horizon::Positional,
        vec![9.5, 9.5],
        as_of,
    );

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.evidence, vec!["insufficient OHLCV".to_string()]);
    assert_eq!(output.computed_at, as_of);
}
