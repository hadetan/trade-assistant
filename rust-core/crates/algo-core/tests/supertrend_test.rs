use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

#[test]
fn registry_contains_supertrend() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"supertrend"));
}

fn ctx_from_ohlc(highs: Vec<f64>, lows: Vec<f64>, closes: Vec<f64>, as_of: DateTime<Utc>) -> MarketContext {
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
fn flat_series_atr_and_basic_bands_match_brief_anchor() {
    // H=11, L=10, C=10.5 for every one of 11 bars (required_lookback = 11).
    // TR = max(H-L, |H-Cprev|, |L-Cprev|) = max(1, 0.5, 0.5) = 1 for every
    // bar after the first -> ATR(10) = 1.0.
    // basicUpper/Lower = (H+L)/2 +- mult*ATR = 10.5 +- 3*1.0 = 13.5 / 7.5.
    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "supertrend")
        .expect("supertrend algorithm registered");

    assert_eq!(algo.required_lookback(), 11);

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = ctx_from_ohlc(vec![11.0; 11], vec![10.0; 11], vec![10.5; 11], as_of);

    let output = algo.compute(&ctx);

    assert!(output.evidence[0].contains("ATR(10)=1.0000"));
    assert!(output.evidence[0].contains("basicUpper=13.5000"));
    assert!(output.evidence[0].contains("basicLower=7.5000"));
    assert_eq!(output.computed_at, as_of);
}

#[test]
fn uptrend_ramp_is_bullish_with_line_below_close() {
    let n = 20;
    let closes: Vec<f64> = (0..n).map(|i| 100.0 + i as f64).collect();
    let highs: Vec<f64> = closes.iter().map(|c| c + 1.0).collect();
    let lows: Vec<f64> = closes.iter().map(|c| c - 1.0).collect();
    let last_close = *closes.last().unwrap();

    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "supertrend")
        .expect("supertrend algorithm registered");

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = ctx_from_ohlc(highs, lows, closes, as_of);

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Bullish);

    let line_str = output.evidence[0]
        .split("line=")
        .nth(1)
        .and_then(|s| s.split(' ').next())
        .expect("evidence contains a line= value");
    let line: f64 = line_str.parse().expect("line value parses as f64");
    assert!(line < last_close);
}

#[test]
fn insufficient_ohlcv_is_a_neutral_no_op() {
    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "supertrend")
        .expect("supertrend algorithm registered");

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = ctx_from_ohlc(vec![11.0; 5], vec![10.0; 5], vec![10.5; 5], as_of);

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
}
