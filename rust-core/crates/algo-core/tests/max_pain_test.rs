use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, OptionChainSnapshot, StrikeRow, Timeframe};
use chrono::{DateTime, Utc};

fn ctx_with_chain(strikes: Vec<StrikeRow>, as_of: DateTime<Utc>) -> MarketContext {
    MarketContext {
        symbol: "NSE:TEST".to_string(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        closes: Vec::new(),
        opens: Vec::new(),
        highs: Vec::new(),
        lows: Vec::new(),
        volumes: Vec::new(),
        timestamps: Vec::new(),
        options: None,
        chain: Some(OptionChainSnapshot { spot: 110.0, strikes }),
        peer: None,
        higher_tf: None,
        as_of,
    }
}

#[test]
fn max_pain_is_registered() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"max_pain"));
}

#[test]
fn max_pain_matches_hand_computed_argmin() {
    // strikes [100,110,120], call_oi=[10,10,10], put_oi=[10,10,10]
    // pain(100)=300, pain(110)=200, pain(120)=300 -> Max Pain = 110
    let strikes = vec![
        StrikeRow { strike: 100.0, call_oi: 10.0, put_oi: 10.0 },
        StrikeRow { strike: 110.0, call_oi: 10.0, put_oi: 10.0 },
        StrikeRow { strike: 120.0, call_oi: 10.0, put_oi: 10.0 },
    ];
    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = ctx_with_chain(strikes, as_of);

    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "max_pain")
        .expect("max_pain algorithm must be registered");

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.computed_at, as_of);
    assert!(output.evidence.iter().any(|e| e.contains("max_pain=110")));
    assert!(output.evidence.iter().any(|e| e.contains("near expiry")));
}

#[test]
fn max_pain_no_ops_without_chain() {
    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = MarketContext::from_closes(
        "NSE:TEST",
        Timeframe::Day,
        Horizon::Positional,
        vec![100.0, 101.0],
        as_of,
    );

    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "max_pain")
        .expect("max_pain algorithm must be registered");

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
}
