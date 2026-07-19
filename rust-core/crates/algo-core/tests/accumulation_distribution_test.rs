use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

#[test]
fn registry_contains_accumulation_distribution() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();

    assert!(ids.contains(&"accumulation_distribution"));
}

#[test]
fn accumulation_distribution_matches_hand_computed_adl() {
    // bar1 H=10,L=8,C=9.5,V=100 -> MFM=((9.5-8)-(10-9.5))/(10-8)=0.5 -> MFV=50 -> ADL=50
    // bar2 H=11,L=9,C=9.5,V=200 -> MFM=((9.5-9)-(11-9.5))/(11-9)=-0.5 -> MFV=-100 -> ADL=-50
    let as_of: DateTime<Utc> = "2020-01-01T00:00:00Z".parse().unwrap();
    let ctx = MarketContext {
        symbol: "NSE:TEST".to_string(),
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

    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "accumulation_distribution")
        .expect("accumulation_distribution not registered");

    let output = algo.compute(&ctx);

    assert!((output.magnitude - (-50.0)).abs() < 1e-9);
    assert_eq!(output.direction, Direction::Bearish);
    assert_eq!(output.computed_at, as_of);
}

#[test]
fn accumulation_distribution_no_op_guard_returns_neutral_without_ohlcv() {
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
        .find(|a| a.id() == "accumulation_distribution")
        .expect("accumulation_distribution not registered");

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.evidence, vec!["insufficient OHLCV".to_string()]);
}
