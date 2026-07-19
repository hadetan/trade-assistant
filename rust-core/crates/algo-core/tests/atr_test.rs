use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

#[test]
fn registry_contains_atr() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"atr"));
}

fn flat_ohlc_context(bars: usize, price: f64, as_of: DateTime<Utc>) -> MarketContext {
    MarketContext {
        symbol: "TEST".into(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        closes: vec![price; bars],
        opens: Vec::new(),
        highs: vec![price; bars],
        lows: vec![price; bars],
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
fn atr_registered_instance_is_wilder_14_on_flat_series() {
    // Registered period must be 14 (ATR (Wilder, 14) per the task brief). A
    // flat OHLC series makes every true range 0, giving real ATR(14) an
    // exact, unambiguous anchor (0.0) with no smoothing-formula guesswork,
    // and the evidence string pins the period so a regression to period 3
    // (still period-agnostic 0.0 on this fixture) is still caught.
    let algos = registry::all();
    let algo = algos
        .into_iter()
        .find(|a| a.id() == "atr")
        .expect("atr algorithm must be registered");

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = flat_ohlc_context(15, 100.0, as_of);

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert!((output.magnitude - 0.0).abs() < 1e-9);
    assert_eq!(output.evidence, vec!["ATR(14) = 0.000000".to_string()]);
    assert_eq!(output.computed_at, as_of);
}

#[test]
fn atr_registered_lookback_guards_at_fourteen_bars() {
    // required_lookback is period + 1, so with the correct period-14
    // registration, 14 highs/lows must still trip the no-op guard. If the
    // registration regresses to period 3 (required_lookback 4), 14 bars
    // would instead fall through to a real (wrong) computation.
    let algos = registry::all();
    let algo = algos
        .into_iter()
        .find(|a| a.id() == "atr")
        .expect("atr algorithm must be registered");

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = flat_ohlc_context(14, 100.0, as_of);

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.evidence, vec!["insufficient OHLCV".to_string()]);
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
