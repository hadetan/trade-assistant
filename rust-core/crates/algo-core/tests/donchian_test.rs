use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

#[test]
fn registry_contains_donchian() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"donchian"));
}

#[test]
fn donchian_matches_hand_computed_channels() {
    // period 3: high=[12,13,14], low=[10,9,11] -> Upper=14, Lower=9, Mid=11.5
    let algos = registry::all();
    let algo = algos
        .into_iter()
        .find(|a| a.id() == "donchian")
        .expect("donchian algorithm must be registered");

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = MarketContext {
        symbol: "TEST".to_string(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        closes: vec![11.0, 12.0, 13.0],
        opens: Vec::new(),
        highs: vec![12.0, 13.0, 14.0],
        lows: vec![10.0, 9.0, 11.0],
        volumes: Vec::new(),
        timestamps: Vec::new(),
        options: None,
        chain: None,
        peer: None,
        higher_tf: None,
        as_of,
    };

    let output = algo.compute(&ctx);

    let upper = highs_max(&ctx.highs);
    let lower = lows_min(&ctx.lows);
    let mid = (upper + lower) / 2.0;

    assert!((upper - 14.0).abs() < 1e-9);
    assert!((lower - 9.0).abs() < 1e-9);
    assert!((mid - 11.5).abs() < 1e-9);

    // last close (13.0) is above the mid (11.5) -> Bullish
    assert_eq!(output.direction, Direction::Bullish);
    let expected_magnitude: f64 = ((13.0 - 11.5) / 11.5f64).abs();
    assert!((output.magnitude - expected_magnitude).abs() < 1e-9);
    assert_eq!(output.computed_at, as_of);
}

fn highs_max(highs: &[f64]) -> f64 {
    highs.iter().cloned().fold(f64::MIN, f64::max)
}

fn lows_min(lows: &[f64]) -> f64 {
    lows.iter().cloned().fold(f64::MAX, f64::min)
}
