use algo_core::registry;
use algo_core::{Algorithm, Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

fn as_of() -> DateTime<Utc> {
    "2020-01-01T00:00:00Z".parse().unwrap()
}

fn ctx_from_ohlc(highs: Vec<f64>, lows: Vec<f64>, closes: Vec<f64>) -> MarketContext {
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

fn find_cci(algos: &[Box<dyn Algorithm>]) -> &dyn Algorithm {
    algos
        .iter()
        .find(|a| a.id() == "cci")
        .expect("cci algorithm must be registered")
        .as_ref()
}

#[test]
fn cci_id_is_registered() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"cci"));
}

#[test]
fn cci_matches_hand_computed_reference_value() {
    // Brief's exact 3-bar cycle: TP = [23, 24, 25] from
    // high=[24,25,26], low=[22,23,24], close=[23,24,25]
    // ⇒ SMA=24, MeanDev=(1+0+1)/3=2/3 ⇒ CCI=(25-24)/(0.015*2/3)=100.0 exactly.
    // The registered algo's window is 21 bars (see cci.rs), so this repeats
    // that exact cycle 7 times -- repetition preserves the cycle's mean and
    // mean-deviation exactly, and the window still ends on the same last
    // bar (high=26, low=24, close=25, TP=25), so the reference value carries
    // over unchanged. This sits exactly on the classifier's +100 boundary,
    // where an f64 pipeline's ~1e-14 rounding can legitimately land on
    // either side, so direction isn't asserted here -- see the unambiguous
    // overbought/oversold cases below for that.
    let highs: Vec<f64> = [24.0, 25.0, 26.0].iter().cycle().take(21).copied().collect();
    let lows: Vec<f64> = [22.0, 23.0, 24.0].iter().cycle().take(21).copied().collect();
    let closes: Vec<f64> = [23.0, 24.0, 25.0].iter().cycle().take(21).copied().collect();
    let ctx = ctx_from_ohlc(highs, lows, closes);

    let algos = registry::all();
    let algo = find_cci(&algos);

    let output = algo.compute(&ctx);

    assert!((output.magnitude - 100.0).abs() < 1e-9);
    assert_eq!(output.computed_at, as_of());
}

#[test]
fn cci_classifies_overbought_as_bullish() {
    // 20 flat bars then a sharp last-bar spike pushes CCI far past +100.
    let mut highs = vec![10.0; 20];
    let mut lows = vec![10.0; 20];
    let mut closes = vec![10.0; 20];
    highs.push(50.0);
    lows.push(50.0);
    closes.push(50.0);

    let ctx = ctx_from_ohlc(highs, lows, closes);
    let algos = registry::all();
    let algo = find_cci(&algos);

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Bullish);
    assert!(output.magnitude > 100.0);
}

#[test]
fn cci_classifies_oversold_as_bearish() {
    let mut highs = vec![10.0; 20];
    let mut lows = vec![10.0; 20];
    let mut closes = vec![10.0; 20];
    highs.push(-30.0);
    lows.push(-30.0);
    closes.push(-30.0);

    let ctx = ctx_from_ohlc(highs, lows, closes);
    let algos = registry::all();
    let algo = find_cci(&algos);

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Bearish);
    assert!(output.magnitude > 100.0);
}

#[test]
fn cci_is_a_noop_when_history_is_too_short() {
    let ctx = MarketContext::from_closes(
        "NSE:TEST",
        Timeframe::Day,
        Horizon::Positional,
        vec![100.0],
        as_of(),
    );

    let algos = registry::all();
    let algo = find_cci(&algos);
    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.evidence, vec!["insufficient OHLCV".to_string()]);
}
