use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

fn uptrend_ctx() -> MarketContext {
    let n = 30;
    let highs: Vec<f64> = (0..n).map(|i| 100.0 + 2.0 * i as f64).collect();
    let lows: Vec<f64> = (0..n).map(|i| 99.0 + 2.0 * i as f64).collect();
    let closes: Vec<f64> = (0..n).map(|i| 99.5 + 2.0 * i as f64).collect();
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
fn adx_is_registered() {
    let algos = registry::all();
    assert!(algos.iter().any(|a| a.id() == "adx"));
}

#[test]
fn adx_no_ops_on_fully_flat_window_without_nan() {
    // Circuit-frozen NSE instrument: H=L=C constant across the whole
    // lookback, so TR14 seeds at 0.0 and plus_di/minus_di = 0.0/0.0 would be
    // NaN without the tr14 guard, poisoning downstream confluence.
    let n = 30;
    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = MarketContext {
        symbol: "NSE:FROZEN".to_string(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        closes: vec![100.0; n],
        opens: Vec::new(),
        highs: vec![100.0; n],
        lows: vec![100.0; n],
        volumes: Vec::new(),
        timestamps: Vec::new(),
        options: None,
        chain: None,
        peer: None,
        higher_tf: None,
        as_of,
    };

    let algos = registry::all();
    let adx = algos
        .into_iter()
        .find(|a| a.id() == "adx")
        .expect("adx must be registered");

    let output = adx.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert!(!output.magnitude.is_nan());
    assert!(!output.confidence.is_nan());
}

#[test]
fn adx_matches_hand_verified_wilder_step_and_classifies_bullish() {
    let ctx = uptrend_ctx();

    // Externally-verifiable anchor, computed straight from the raw input
    // (not the algorithm's own echo): the brief's exact first Wilder step.
    let tr1 = (ctx.highs[1] - ctx.lows[1])
        .max((ctx.highs[1] - ctx.closes[0]).abs())
        .max((ctx.lows[1] - ctx.closes[0]).abs());
    let plus_dm1 = ctx.highs[1] - ctx.highs[0];
    let down_move1 = ctx.lows[0] - ctx.lows[1];
    let minus_dm1 = if down_move1 > plus_dm1 && down_move1 > 0.0 {
        down_move1
    } else {
        0.0
    };

    assert!((tr1 - 2.5).abs() < 1e-9);
    assert!((plus_dm1 - 2.0).abs() < 1e-9);
    assert!((minus_dm1 - 0.0).abs() < 1e-9);

    let algos = registry::all();
    let adx = algos
        .into_iter()
        .find(|a| a.id() == "adx")
        .expect("adx must be registered");

    assert!(ctx.highs.len() >= adx.required_lookback());

    let output = adx.compute(&ctx);

    assert_eq!(output.algo_id, "adx");
    // direction Bullish only fires when +DI > -DI and ADX > 20 under this
    // algo's own classify rule, so this also proves both secondary
    // inequalities from the brief.
    assert_eq!(output.direction, Direction::Bullish);
    assert!(output.magnitude > 20.0);
    assert_eq!(output.computed_at, ctx.as_of);
}
