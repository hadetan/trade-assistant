use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

fn base_ctx(highs: Vec<f64>, lows: Vec<f64>, closes: Vec<f64>, as_of: DateTime<Utc>) -> MarketContext {
    MarketContext {
        symbol: "NSE:TEST".to_string(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        closes,
        opens: Vec::new(),
        highs,
        lows,
        volumes: Vec::new(),
        timestamps: Vec::new(),
        options: None,
        chain: None,
        peer: None,
        higher_tf: None,
        as_of,
    }
}

#[test]
fn williams_r_is_registered() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"williams_r"));
}

#[test]
fn williams_r_matches_brief_reference_value() {
    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "williams_r")
        .expect("williams_r must be registered");
    assert_eq!(algo.required_lookback(), 14);

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();

    // The brief's exact test input is high=[12,13,14], low=[10,11,9], close=13
    // (a period-3 example) -> HH=14, LL=9 -> %R=(14-13)/(14-9)*-100 = -20.0.
    // The registered instance's required_lookback is 14, so the brief's
    // triple is placed as the trailing 3 bars of a 14-bar window; the
    // padding bars (12.0 / 10.0) sit strictly inside [LL, HH] so they don't
    // move the window's max/min and the reference value is reproduced
    // exactly.
    let mut highs = vec![12.0; 11];
    highs.extend_from_slice(&[12.0, 13.0, 14.0]);
    let mut lows = vec![10.0; 11];
    lows.extend_from_slice(&[10.0, 11.0, 9.0]);
    let mut closes = vec![12.0; 13];
    closes.push(13.0);

    let ctx = base_ctx(highs, lows, closes, as_of);
    let output = algo.compute(&ctx);

    assert!(output.evidence[0].contains("-20.00"));
    assert!((output.magnitude - 30.0).abs() < 1e-9);
    // -20.0 sits exactly on the boundary (not > -20), so it's neutral, not
    // the overbought/Bearish bucket.
    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.computed_at, as_of);
}

#[test]
fn williams_r_classifies_overbought_and_oversold() {
    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "williams_r")
        .expect("williams_r must be registered");
    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();

    // %R = -10: HH=100, LL=90, C=99 -> (100-99)/(100-90)*-100 = -10 -> Bearish
    let bearish_ctx = base_ctx(vec![100.0; 14], vec![90.0; 14], vec![99.0; 14], as_of);
    assert_eq!(algo.compute(&bearish_ctx).direction, Direction::Bearish);

    // %R = -90: HH=100, LL=0, C=10 -> (100-10)/(100-0)*-100 = -90 -> Bullish
    let bullish_ctx = base_ctx(vec![100.0; 14], vec![0.0; 14], vec![10.0; 14], as_of);
    assert_eq!(algo.compute(&bullish_ctx).direction, Direction::Bullish);

    // %R = -50: HH=100, LL=0, C=50 -> (100-50)/(100-0)*-100 = -50 -> Neutral
    let neutral_ctx = base_ctx(vec![100.0; 14], vec![0.0; 14], vec![50.0; 14], as_of);
    assert_eq!(algo.compute(&neutral_ctx).direction, Direction::Neutral);
}

#[test]
fn williams_r_no_op_guard_on_insufficient_highs_lows() {
    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "williams_r")
        .expect("williams_r must be registered");
    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();

    let ctx = base_ctx(vec![12.0, 13.0, 14.0], vec![10.0, 11.0, 9.0], vec![13.0], as_of);
    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.evidence, vec!["insufficient OHLCV".to_string()]);
}
