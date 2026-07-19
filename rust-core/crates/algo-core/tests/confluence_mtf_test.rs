use algo_core::registry;
use algo_core::{Direction, HigherTfSeries, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

fn ctx_with(base: Vec<f64>, higher: Vec<f64>) -> MarketContext {
    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    MarketContext {
        symbol: "NSE:TEST".to_string(),
        timeframe: Timeframe::FifteenMinute,
        horizon: Horizon::Intraday,
        closes: base,
        opens: Vec::new(),
        highs: Vec::new(),
        lows: Vec::new(),
        volumes: Vec::new(),
        timestamps: Vec::new(),
        options: None,
        chain: None,
        peer: None,
        higher_tf: Some(HigherTfSeries {
            timeframe: Timeframe::Day,
            closes: higher,
        }),
        as_of,
    }
}

#[test]
fn confluence_mtf_is_registered() {
    let ids: Vec<&str> = registry::all().iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"confluence_mtf"));
}

#[test]
fn confluence_mtf_bullish_base_and_higher_tf_agree() {
    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "confluence_mtf")
        .expect("confluence_mtf must be registered");

    // base ramp 10..18 (Bullish, weight 1.0) + higher_tf ramp 10..18 (Bullish, weight 2.0)
    // base vote +1, higher vote +1 -> weighted sum = (1*1 + 1*2)/3 = 3/3 = +1.0
    let ctx = ctx_with(
        vec![10.0, 12.0, 14.0, 16.0, 18.0],
        vec![10.0, 12.0, 14.0, 16.0, 18.0],
    );

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Bullish);
    assert!((output.magnitude - 1.0).abs() < 1e-9);
    assert_eq!(output.computed_at, ctx.as_of);
}

#[test]
fn confluence_mtf_bearish_higher_tf_outweighs_bullish_base() {
    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "confluence_mtf")
        .expect("confluence_mtf must be registered");

    // base ramp 10..18 (Bullish, weight 1.0) + higher_tf ramp 18..10 (Bearish, weight 2.0)
    // base vote +1, higher vote -1 -> weighted sum = (1*1 + (-1)*2)/3 = -1/3
    let ctx = ctx_with(
        vec![10.0, 12.0, 14.0, 16.0, 18.0],
        vec![18.0, 16.0, 14.0, 12.0, 10.0],
    );

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Bearish);
    assert!((output.magnitude - (1.0 / 3.0)).abs() < 1e-9);
}
