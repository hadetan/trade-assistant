use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

#[test]
fn mfi_is_registered() {
    let ids: Vec<&str> = registry::all().iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"mfi"));
}

#[test]
fn mfi_matches_reference_value_from_brief() {
    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "mfi")
        .expect("mfi algorithm must be registered");

    let as_of: DateTime<Utc> = "2020-01-01T00:00:00Z".parse().unwrap();

    // TP = [10, 11, 9] (flat H=L=C bars), volumes = [_, 100, 100].
    // posMF = 11*100 = 1100 (TP rose 10->11), negMF = 9*100 = 900 (TP fell 11->9)
    // MFR = 1100/900 = 1.2222, MFI = 100 - 100/2.2222 = 55.0 (brief's reference value).
    let ctx = MarketContext {
        symbol: "NSE:TEST".to_string(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        closes: vec![10.0, 11.0, 9.0],
        opens: vec![10.0, 11.0, 9.0],
        highs: vec![10.0, 11.0, 9.0],
        lows: vec![10.0, 11.0, 9.0],
        volumes: vec![100.0, 100.0, 100.0],
        timestamps: vec![],
        options: None,
        chain: None,
        peer: None,
        higher_tf: None,
        as_of,
    };

    assert_eq!(algo.required_lookback(), 3);

    let output = algo.compute(&ctx);

    assert!((output.magnitude - 5.0).abs() < 1e-6);
    assert!(output.evidence[0].contains("55.00"));
    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.computed_at, as_of);
}
