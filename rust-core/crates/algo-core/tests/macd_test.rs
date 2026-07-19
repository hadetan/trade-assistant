use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

fn as_of() -> DateTime<Utc> {
    "2020-01-01T00:00:00Z".parse().unwrap()
}

#[test]
fn registry_contains_macd() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();

    assert!(ids.contains(&"macd"));
}

#[test]
fn macd_flat_series_is_neutral_with_zero_histogram() {
    let algos = registry::all();
    let algo = algos.iter().find(|a| a.id() == "macd").expect("macd is registered");
    let ctx = MarketContext::from_closes(
        "TEST",
        Timeframe::Day,
        Horizon::Positional,
        vec![5.0; 40],
        as_of(),
    );

    let output = algo.compute(&ctx);

    // constant series -> fast EMA == slow EMA == signal == 5.0 everywhere,
    // so MACD line = signal = histogram = 0.0 exactly.
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.computed_at, as_of());
}

#[test]
fn macd_rising_ramp_has_positive_line_and_is_bullish() {
    let algos = registry::all();
    let algo = algos.iter().find(|a| a.id() == "macd").expect("macd is registered");
    let closes: Vec<f64> = (1..=40).map(|i| i as f64).collect();
    let ctx = MarketContext::from_closes("TEST", Timeframe::Day, Horizon::Positional, closes, as_of());

    let output = algo.compute(&ctx);

    // fast EMA leads a rising series -> MACD line > 0 -> Bullish.
    assert_eq!(output.direction, Direction::Bullish);
    assert!(output.magnitude > 0.0);
}
