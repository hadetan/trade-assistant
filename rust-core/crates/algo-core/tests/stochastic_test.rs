use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

fn as_of() -> DateTime<Utc> {
    "2020-01-01T00:00:00Z".parse().unwrap()
}

fn ctx_with_hh_ll_close(hh: f64, ll: f64, last_close: f64) -> MarketContext {
    let highs = vec![hh; 16];
    let lows = vec![ll; 16];
    let mut closes = vec![(hh + ll) / 2.0; 15];
    closes.push(last_close);

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

#[test]
fn stochastic_id_is_registered() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"stochastic"));
}

#[test]
fn stochastic_matches_hand_computed_k_and_classifies_neutral() {
    // last 3 bars: high=[12,13,14], low=[10,11,9], close=13
    // HH=14, LL=9 over the last 14-bar window -> %K = (13-9)/(14-9)*100 = 80.0
    let mut highs = vec![12.0; 13];
    highs.extend([12.0, 13.0, 14.0]);
    let mut lows = vec![10.0; 13];
    lows.extend([10.0, 11.0, 9.0]);
    let mut closes = vec![12.0; 15];
    closes.push(13.0);

    let ctx = MarketContext {
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
    };

    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "stochastic")
        .expect("stochastic algorithm must be registered");

    let output = algo.compute(&ctx);

    assert!(output.evidence[0].contains("80.00"));
    assert!((output.magnitude - 30.0).abs() < 1e-9);
    // %K == 80.0 exactly is not > 80, so it lands in the neutral band, not
    // overbought.
    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.computed_at, as_of());
}

#[test]
fn stochastic_classifies_overbought_as_bearish() {
    let ctx = ctx_with_hh_ll_close(100.0, 0.0, 85.0);

    let algos = registry::all();
    let algo = algos.iter().find(|a| a.id() == "stochastic").unwrap();
    let output = algo.compute(&ctx);

    assert!(output.evidence[0].contains("85.00"));
    assert_eq!(output.direction, Direction::Bearish);
}

#[test]
fn stochastic_classifies_oversold_as_bullish() {
    let ctx = ctx_with_hh_ll_close(100.0, 0.0, 15.0);

    let algos = registry::all();
    let algo = algos.iter().find(|a| a.id() == "stochastic").unwrap();
    let output = algo.compute(&ctx);

    assert!(output.evidence[0].contains("15.00"));
    assert_eq!(output.direction, Direction::Bullish);
}

#[test]
fn stochastic_classifies_midpoint_as_neutral() {
    let ctx = ctx_with_hh_ll_close(100.0, 0.0, 50.0);

    let algos = registry::all();
    let algo = algos.iter().find(|a| a.id() == "stochastic").unwrap();
    let output = algo.compute(&ctx);

    assert!(output.evidence[0].contains("50.00"));
    assert_eq!(output.direction, Direction::Neutral);
}

#[test]
fn stochastic_is_a_noop_when_history_is_too_short() {
    let ctx = MarketContext::from_closes(
        "NSE:TEST",
        Timeframe::Day,
        Horizon::Positional,
        vec![100.0; 5],
        as_of(),
    );

    let algos = registry::all();
    let algo = algos.iter().find(|a| a.id() == "stochastic").unwrap();
    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
}
