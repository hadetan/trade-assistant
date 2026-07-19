use algo_core::registry;
use algo_core::{Algorithm, Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

fn as_of() -> DateTime<Utc> {
    "2020-01-01T00:00:00Z".parse().unwrap()
}

fn ctx_ramp() -> MarketContext {
    let closes: Vec<f64> = (0..25).map(|i| 100.0 + i as f64).collect();
    let highs: Vec<f64> = closes.iter().map(|c| c + 1.0).collect();
    let lows: Vec<f64> = closes.iter().map(|c| c - 1.0).collect();
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
        as_of: as_of(),
    }
}

fn ctx_constant() -> MarketContext {
    MarketContext {
        symbol: "NSE:TEST".to_string(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        closes: vec![10.0; 25],
        opens: Vec::new(),
        highs: vec![11.0; 25],
        lows: vec![9.0; 25],
        volumes: Vec::new(),
        timestamps: Vec::new(),
        options: None,
        chain: None,
        peer: None,
        higher_tf: None,
        as_of: as_of(),
    }
}

fn find_keltner(algos: &[Box<dyn Algorithm>]) -> &dyn Algorithm {
    algos
        .iter()
        .find(|a| a.id() == "keltner")
        .expect("keltner not registered")
        .as_ref()
}

/// Evidence is formatted as "close {:.2} vs mid {:.2}, bands [{:.2}, {:.2}]".
/// Parsed here (independently of the algo's own EMA/ATR helpers) purely to
/// check band ordering / pin the anchor's exact mid.
fn parse_bands(evidence: &str) -> (f64, f64, f64) {
    let after_mid = evidence.split("mid ").nth(1).unwrap();
    let mid: f64 = after_mid.split(',').next().unwrap().trim().parse().unwrap();
    let inside_brackets = evidence
        .split('[')
        .nth(1)
        .unwrap()
        .trim_end_matches(']');
    let mut band_parts = inside_brackets.split(',');
    let lower: f64 = band_parts.next().unwrap().trim().parse().unwrap();
    let upper: f64 = band_parts.next().unwrap().trim().parse().unwrap();
    (lower, mid, upper)
}

#[test]
fn keltner_is_registered() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();

    assert!(ids.contains(&"keltner"));
}

#[test]
fn keltner_uptrend_ramp_is_bullish_with_ordered_bands() {
    let algos = registry::all();
    let algo = find_keltner(&algos);
    let ctx = ctx_ramp();

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Bullish);
    assert!(output.magnitude > 0.0);
    assert_eq!(output.computed_at, ctx.as_of);

    let (lower, mid, upper) = parse_bands(&output.evidence[0]);
    assert!(lower < mid);
    assert!(mid < upper);
    assert!(*ctx.closes.last().unwrap() > mid);
}

#[test]
fn keltner_mid_matches_hand_computed_ema_on_constant_series() {
    // closes/highs/lows constant at 10/11/9 -> EMA20(close) of a constant
    // series is that constant, so mid must be exactly 10.0 (the brief's
    // de-circularized anchor), independent of the algo's own EMA helper.
    let algos = registry::all();
    let algo = find_keltner(&algos);
    let ctx = ctx_constant();

    let output = algo.compute(&ctx);

    let (lower, mid, upper) = parse_bands(&output.evidence[0]);
    assert!((mid - 10.0).abs() < 1e-9);
    assert!((lower - 6.0).abs() < 1e-9);
    assert!((upper - 14.0).abs() < 1e-9);
    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.computed_at, ctx.as_of);
}

#[test]
fn keltner_no_op_guards_on_insufficient_highs_lows() {
    let algos = registry::all();
    let algo = find_keltner(&algos);
    let ctx = MarketContext::from_closes(
        "NSE:TEST",
        Timeframe::Day,
        Horizon::Positional,
        (0..25).map(|i| 100.0 + i as f64).collect(),
        as_of(),
    );

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.evidence, vec!["insufficient OHLCV".to_string()]);
    assert_eq!(output.computed_at, ctx.as_of);
}
