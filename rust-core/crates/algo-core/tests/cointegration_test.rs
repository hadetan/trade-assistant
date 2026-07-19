use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, PeerSeries, Timeframe};
use chrono::{DateTime, Utc};

#[test]
fn cointegration_is_registered() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();

    assert!(ids.contains(&"cointegration"));
}

#[test]
fn perfect_cointegration_recovers_hedge_ratio_and_near_zero_residual_variance() {
    let algos = registry::all();
    let algo = algos
        .into_iter()
        .find(|a| a.id() == "cointegration")
        .expect("cointegration algorithm must be registered");

    let as_of: DateTime<Utc> = "2020-01-01T00:00:00Z".parse().unwrap();
    let ctx = MarketContext {
        symbol: "NSE:X".to_string(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        closes: vec![1.0, 2.0, 3.0, 4.0, 5.0],
        opens: Vec::new(),
        highs: Vec::new(),
        lows: Vec::new(),
        volumes: Vec::new(),
        timestamps: Vec::new(),
        options: None,
        chain: None,
        peer: Some(PeerSeries {
            symbol: "NSE:Y".to_string(),
            closes: vec![2.0, 4.0, 6.0, 8.0, 10.0],
        }),
        higher_tf: None,
        as_of,
    };

    let output = algo.compute(&ctx);

    // y = 2x exactly => OLS hedge ratio beta = 2.0, intercept alpha ~= 0,
    // residual spread e = y - (beta*x + alpha) ~= 0 at every point.
    assert!((output.magnitude - 2.0).abs() < 1e-6, "beta was {}", output.magnitude);
    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.computed_at, as_of);

    let residual_variance: f64 = output
        .evidence
        .iter()
        .find_map(|line| line.strip_prefix("residual_variance="))
        .expect("evidence must carry residual_variance")
        .parse()
        .expect("residual_variance must be a valid float");
    assert!(residual_variance < 1e-9, "residual variance was {}", residual_variance);

    let cointegrated = output
        .evidence
        .iter()
        .any(|line| line == "cointegrated=true");
    assert!(cointegrated, "evidence was {:?}", output.evidence);
}

#[test]
fn missing_peer_context_is_a_neutral_no_op() {
    let algos = registry::all();
    let algo = algos
        .into_iter()
        .find(|a| a.id() == "cointegration")
        .expect("cointegration algorithm must be registered");

    let as_of: DateTime<Utc> = "2020-01-01T00:00:00Z".parse().unwrap();
    let ctx = MarketContext::from_closes(
        "NSE:X",
        Timeframe::Day,
        Horizon::Positional,
        vec![1.0, 2.0, 3.0, 4.0, 5.0],
        as_of,
    );

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
}
