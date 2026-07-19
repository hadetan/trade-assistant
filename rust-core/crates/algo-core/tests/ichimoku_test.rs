use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};
use rust_ti::candle_indicators::single::ichimoku_cloud;

fn uptrend_ramp_ctx() -> MarketContext {
    let highs: Vec<f64> = (0..60).map(|i| 10.0 + i as f64).collect();
    let lows: Vec<f64> = (0..60).map(|i| 8.0 + i as f64).collect();
    let closes: Vec<f64> = (0..60).map(|i| 9.0 + i as f64).collect();
    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();

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
fn ichimoku_is_registered() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"ichimoku"));
}

#[test]
fn ichimoku_matches_externally_verifiable_anchors_and_classifies_bullish() {
    let ctx = uptrend_ramp_ctx();

    // Crate-independent anchors from the brief: Tenkan = (max(high[51..60]) +
    // min(low[51..60]))/2 = (69+59)/2; Kijun = (max(high[34..60]) +
    // min(low[34..60]))/2 = (69+42)/2.
    let (_, _, kijun, tenkan, _) = ichimoku_cloud(&ctx.highs, &ctx.lows, &ctx.closes, 9, 26, 52);
    assert!((tenkan - 64.0).abs() < 1e-9);
    assert!((kijun - 55.5).abs() < 1e-9);
    assert!(tenkan > kijun);

    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "ichimoku")
        .expect("ichimoku not found in registry::all()");

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Bullish);
    assert!(output.magnitude > 0.0);
    assert_eq!(output.computed_at, ctx.as_of);
}
