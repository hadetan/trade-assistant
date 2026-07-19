use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, OptionsContext, Timeframe};
use chrono::{DateTime, Utc};

fn ctx_with_options(options: Option<OptionsContext>, as_of: DateTime<Utc>) -> MarketContext {
    MarketContext {
        symbol: "NSE:TEST".into(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        closes: Vec::new(),
        opens: Vec::new(),
        highs: Vec::new(),
        lows: Vec::new(),
        volumes: Vec::new(),
        timestamps: Vec::new(),
        options,
        chain: None,
        peer: None,
        higher_tf: None,
        as_of,
    }
}

fn parse_evidence_field(evidence: &str, key: &str) -> f64 {
    evidence
        .split_whitespace()
        .find_map(|token| token.strip_prefix(key))
        .unwrap_or_else(|| panic!("evidence missing field {key}: {evidence}"))
        .parse()
        .unwrap()
}

#[test]
fn registry_contains_bsm_greeks() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"bsm_greeks"));
}

#[test]
fn bsm_greeks_matches_textbook_reference_values() {
    // S=100, K=100, r=0.05, sigma=0.20, T=1, call -> d1=0.35
    // call Delta = N(0.35) = 0.636831, Gamma = phi(0.35) / (100 * 0.20) = 0.0187620
    let algos = registry::all();
    let algo = algos
        .into_iter()
        .find(|a| a.id() == "bsm_greeks")
        .expect("bsm_greeks must be registered");

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = ctx_with_options(
        Some(OptionsContext {
            spot: 100.0,
            strike: 100.0,
            rate: 0.05,
            time_to_expiry_years: 1.0,
            is_call: true,
            iv: 0.20,
            oi: 0.0,
            prev_oi: 0.0,
            oi_day_high: 0.0,
            oi_day_low: 0.0,
            market_price: 0.0,
        }),
        as_of,
    );

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert!((output.magnitude - 0.636831).abs() < 1e-3);

    let evidence = &output.evidence[0];
    let delta = parse_evidence_field(evidence, "delta=");
    let gamma = parse_evidence_field(evidence, "gamma=");
    assert!((delta - 0.636831).abs() < 1e-3);
    assert!((gamma - 0.018762).abs() < 1e-3);
    assert_eq!(output.computed_at, as_of);
}

#[test]
fn bsm_greeks_no_ops_neutral_when_options_context_absent() {
    let algos = registry::all();
    let algo = algos
        .into_iter()
        .find(|a| a.id() == "bsm_greeks")
        .expect("bsm_greeks must be registered");

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = ctx_with_options(None, as_of);

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.evidence, vec!["no options context".to_string()]);
}
