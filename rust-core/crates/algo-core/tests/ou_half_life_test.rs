use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

fn parse_half_life(evidence: &str) -> f64 {
    let after = evidence
        .split("half-life=")
        .nth(1)
        .expect("evidence should contain half-life=");
    let number = after
        .split(' ')
        .next()
        .expect("half-life value should be followed by a space");
    number.parse::<f64>().expect("half-life value should be a float")
}

#[test]
fn ou_half_life_is_registered() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();

    assert!(ids.contains(&"ou_half_life"));
}

#[test]
fn ou_half_life_matches_brief_reference_value() {
    // spread [4, 2, 1, 0.5, 0.25]: each term halves the previous one, so the
    // AR(1) OLS fit is exact -- b = 0.5, a = 0.0 -- giving
    // half-life = -ln(2)/ln(0.5) = 1.0 bar exactly.
    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "ou_half_life")
        .expect("ou_half_life should be registered");

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = MarketContext::from_closes(
        "NSE:TEST",
        Timeframe::Day,
        Horizon::Positional,
        vec![4.0, 2.0, 1.0, 0.5, 0.25],
        as_of,
    );

    let output = algo.compute(&ctx);
    let half_life = parse_half_life(&output.evidence[0]);

    assert!(
        (half_life - 1.0).abs() < 1e-6,
        "expected half-life ~= 1.0, got {half_life}"
    );
    assert_eq!(output.computed_at, as_of);

    // Last value 0.25 sits below the series mean by less than 1 std here,
    // so the z-score classifier lands in the neutral band for this input --
    // the sign classification itself is asserted separately below on a
    // constructed series designed to cross the +-1 threshold.
    assert_eq!(output.direction, Direction::Neutral);
    assert!(output.magnitude >= 0.0);
}

#[test]
fn ou_half_life_classifies_bullish_when_z_score_drops_below_negative_one() {
    // series mean = 8, population std = 4; last value 0 -> z = (0-8)/4 = -2.0
    // -> below the -1 threshold -> Bullish (expect mean reversion back up).
    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "ou_half_life")
        .expect("ou_half_life should be registered");

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = MarketContext::from_closes(
        "NSE:TEST",
        Timeframe::Day,
        Horizon::Positional,
        vec![10.0, 10.0, 10.0, 10.0, 0.0],
        as_of,
    );

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Bullish);
    assert!(output.magnitude > 1.0);
}

#[test]
fn ou_half_life_classifies_bearish_when_z_score_rises_above_positive_one() {
    // series mean = 12, population std = 4; last value 20 -> z = (20-12)/4 = 2.0
    // -> above the +1 threshold -> Bearish (expect mean reversion back down).
    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "ou_half_life")
        .expect("ou_half_life should be registered");

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = MarketContext::from_closes(
        "NSE:TEST",
        Timeframe::Day,
        Horizon::Positional,
        vec![10.0, 10.0, 10.0, 10.0, 20.0],
        as_of,
    );

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Bearish);
    assert!(output.magnitude > 1.0);
}
