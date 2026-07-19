use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

#[test]
fn bollinger_is_registered() {
    let ids: Vec<&str> = registry::all().iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"bollinger"));
}

#[test]
fn bollinger_matches_reference_bands_and_direction() {
    let closes: Vec<f64> = (1..=20).map(|i| i as f64).collect();

    // Reference values from the task brief: mid=SMA20, sigma=population SD
    // (n divisor, per StockCharts), upper=mid+2*sigma, lower=mid-2*sigma.
    let expected_mid = 10.5;
    let expected_sigma = ((20f64.powi(2) - 1.0) / 12.0).sqrt();
    let expected_upper = expected_mid + 2.0 * expected_sigma;
    let expected_lower = expected_mid - 2.0 * expected_sigma;

    assert!((expected_mid - 10.5).abs() < 1e-6);
    assert!((expected_sigma - 5.766281).abs() < 1e-6);
    assert!((expected_upper - 22.032563).abs() < 1e-6);
    assert!((expected_lower - (-1.032563)).abs() < 1e-6);

    let (rust_ti_lower, rust_ti_mid, rust_ti_upper) =
        rust_ti::standard_indicators::single::bollinger_bands(&closes);
    assert!((rust_ti_mid - expected_mid).abs() < 1e-6);
    assert!((rust_ti_upper - expected_upper).abs() < 1e-6);
    assert!((rust_ti_lower - expected_lower).abs() < 1e-6);

    let algos = registry::all();
    let bollinger = algos
        .iter()
        .find(|a| a.id() == "bollinger")
        .expect("bollinger algorithm must be registered");

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = MarketContext::from_closes(
        "NSE:TEST",
        Timeframe::Day,
        Horizon::Positional,
        closes,
        as_of,
    );

    let output = bollinger.compute(&ctx);

    // last close (20.0) > mid (10.5) -> Bullish
    assert_eq!(output.direction, Direction::Bullish);

    let expected_magnitude = (20.0 - expected_mid) / expected_mid;
    assert!((output.magnitude - expected_magnitude).abs() < 1e-6);
    assert_eq!(output.computed_at, as_of);
}
