use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, OptionsContext, Timeframe};
use chrono::{DateTime, Utc};

fn ctx_with_option(market_price: f64) -> MarketContext {
    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
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
        options: Some(OptionsContext {
            spot: 100.0,
            strike: 100.0,
            rate: 0.05,
            time_to_expiry_years: 1.0,
            is_call: true,
            iv: 0.0,
            oi: 0.0,
            prev_oi: 0.0,
            oi_day_high: 0.0,
            oi_day_low: 0.0,
            market_price,
        }),
        chain: None,
        peer: None,
        higher_tf: None,
        as_of,
    }
}

#[test]
fn implied_vol_is_registered() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"implied_vol"));
}

#[test]
fn implied_vol_recovers_known_volatility_from_round_trip_price() {
    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "implied_vol")
        .expect("implied_vol must be registered");

    // S=100, K=100, r=0.05, sigma=0.20, T=1 -> BSM call price 10.450584
    // (reference value from the task brief). Feeding that price back in
    // must recover sigma ~= 0.20.
    let ctx = ctx_with_option(10.450584);
    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert!(
        (output.magnitude - 0.20).abs() < 1e-4,
        "expected iv ~= 0.20, got {}",
        output.magnitude
    );
    assert!(output.magnitude > 0.0);
    assert!(output.evidence[0].contains("0.2000"));
}
