use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

#[test]
fn registry_contains_volume_profile() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"volume_profile"));
}

#[test]
fn poc_bin_matches_overlap_fraction_accumulation() {
    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "volume_profile")
        .expect("volume_profile registered");

    let as_of: DateTime<Utc> = "2020-01-01T00:00:00Z".parse().unwrap();
    let ctx = MarketContext {
        symbol: "NSE:TEST".to_string(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        closes: vec![11.0, 12.5],
        opens: vec![10.5, 11.5],
        highs: vec![12.0, 13.0],
        lows: vec![10.0, 11.0],
        volumes: vec![100.0, 100.0],
        timestamps: vec![1_700_000_000, 1_700_086_400],
        options: None,
        chain: None,
        peer: None,
        higher_tf: None,
        as_of,
    };

    let output = algo.compute(&ctx);

    // bins: [10,11)=50, [11,12)=100, [12,13)=50 -> POC bin [11,12), mid 11.5, volume 100.0
    assert!((output.magnitude - 100.0).abs() < 1e-9);
    assert!(output.evidence[0].contains("mid 11.50"));
    assert!(output.evidence[0].contains("volume 100.00"));

    // latest close (12.5) is above the POC mid (11.5) -> Bullish
    assert_eq!(output.direction, Direction::Bullish);
    assert_eq!(output.computed_at, as_of);
}

#[test]
fn no_op_guard_returns_neutral_when_ohlcv_missing() {
    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "volume_profile")
        .expect("volume_profile registered");

    let as_of: DateTime<Utc> = "2020-01-01T00:00:00Z".parse().unwrap();
    let ctx = MarketContext::from_closes(
        "NSE:TEST",
        Timeframe::Day,
        Horizon::Positional,
        vec![100.0, 101.0],
        as_of,
    );

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.evidence, vec!["insufficient OHLCV".to_string()]);
    assert_eq!(output.computed_at, as_of);
}
