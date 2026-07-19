use algo_core::registry;
use algo_core::{Algorithm, Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

fn as_of() -> DateTime<Utc> {
    "2020-01-01T00:00:00Z".parse().unwrap()
}

fn ctx_from_ohlc(highs: Vec<f64>, lows: Vec<f64>, closes: Vec<f64>) -> MarketContext {
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

fn find_cci(algos: &[Box<dyn Algorithm>]) -> &dyn Algorithm {
    algos
        .iter()
        .find(|a| a.id() == "cci")
        .expect("cci algorithm must be registered")
        .as_ref()
}

#[test]
fn cci_id_is_registered() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"cci"));
}

#[test]
fn cci_matches_hand_computed_reference_value() {
    // 20-bar window (registered period, see cci.rs), TP rising by 1 each
    // bar: high=24..43, low=22..41, close=23..42 ⇒ TP=23..42.
    // mean(TP) = (23+42)/2 = 32.5
    // mean-dev = mean(|TP_i - 32.5|) = 5.0 (symmetric ramp around the mean)
    // CCI = (TP_last - mean) / (0.015 * mean-dev) = (42 - 32.5) / (0.015*5.0)
    //     = 9.5 / 0.075 = 126.66666666666667 (verified against rust_ti's
    //     pipeline in Python: sum/deviation computed independently).
    let highs: Vec<f64> = (0..20).map(|i| 24.0 + i as f64).collect();
    let lows: Vec<f64> = (0..20).map(|i| 22.0 + i as f64).collect();
    let closes: Vec<f64> = (0..20).map(|i| 23.0 + i as f64).collect();
    let ctx = ctx_from_ohlc(highs, lows, closes);

    let algos = registry::all();
    let algo = find_cci(&algos);

    let output = algo.compute(&ctx);

    assert!((output.magnitude - 126.66666666666667).abs() < 1e-6);
    assert_eq!(output.direction, Direction::Bullish);
    assert_eq!(output.computed_at, as_of());
}

#[test]
fn cci_classifies_overbought_as_bullish() {
    // 20 flat bars then a sharp last-bar spike pushes CCI far past +100.
    let mut highs = vec![10.0; 20];
    let mut lows = vec![10.0; 20];
    let mut closes = vec![10.0; 20];
    highs.push(50.0);
    lows.push(50.0);
    closes.push(50.0);

    let ctx = ctx_from_ohlc(highs, lows, closes);
    let algos = registry::all();
    let algo = find_cci(&algos);

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Bullish);
    assert!(output.magnitude > 100.0);
}

#[test]
fn cci_classifies_oversold_as_bearish() {
    let mut highs = vec![10.0; 20];
    let mut lows = vec![10.0; 20];
    let mut closes = vec![10.0; 20];
    highs.push(-30.0);
    lows.push(-30.0);
    closes.push(-30.0);

    let ctx = ctx_from_ohlc(highs, lows, closes);
    let algos = registry::all();
    let algo = find_cci(&algos);

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Bearish);
    assert!(output.magnitude > 100.0);
}

#[test]
fn cci_is_a_noop_when_history_is_too_short() {
    let ctx = MarketContext::from_closes(
        "NSE:TEST",
        Timeframe::Day,
        Horizon::Positional,
        vec![100.0],
        as_of(),
    );

    let algos = registry::all();
    let algo = find_cci(&algos);
    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.evidence, vec!["insufficient OHLCV".to_string()]);
}
