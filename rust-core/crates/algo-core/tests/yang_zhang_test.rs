use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

#[test]
fn yang_zhang_is_registered() {
    let ids: Vec<&str> = registry::all().iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"yang_zhang"));
}

#[test]
fn rogers_satchell_term_on_the_clean_bar_is_one() {
    // Load-bearing anchor from the brief: H=e, L=1, O=C=1 ->
    // ln(H/C)ln(H/O) + ln(L/C)ln(L/O) = ln(e)*ln(e) + ln(1)*ln(1) = 1*1 + 0*0 = 1.0
    let h = std::f64::consts::E;
    let (l, o, c) = (1.0_f64, 1.0_f64, 1.0_f64);
    let rs = (h / c).ln() * (h / o).ln() + (l / c).ln() * (l / o).ln();
    assert!((rs - 1.0).abs() < 1e-9);
}

#[test]
fn yang_zhang_matches_hand_derived_variance() {
    // 3-bar synthetic. Bar 0 supplies only its close as the anchor for bar
    // 1's overnight return (its own O/H/L are unused by the estimator, so
    // they're set flat/degenerate here). Bars 1-2 are the n=2 periods that
    // feed the three variance terms, with e = std::f64::consts::E:
    //
    //   bar0: O=H=L=C = 1/e
    //   bar1: O=1, H=e, L=1, C=e      (bar1 == the Rogers-Satchell anchor's
    //                                   mirror: a wick-free bullish candle)
    //   bar2: O=1, H=e, L=1, C=1      (the brief's "clean bar": H=e,L=1,O=C=1)
    //
    // Overnight returns o_i = ln(open_i / close_{i-1}):
    //   o_1 = ln(1 / (1/e)) = ln(e) = 1
    //   o_2 = ln(1 / e)     = -1
    //   mean = 0; sum sq dev = 1^2 + (-1)^2 = 2; n-1 = 1 -> var_overnight = 2.0
    //
    // Open-close returns c_i = ln(close_i / open_i):
    //   c_1 = ln(e / 1) = 1
    //   c_2 = ln(1 / 1) = 0
    //   mean = 0.5; sum sq dev = 0.25 + 0.25 = 0.5; n-1 = 1 -> var_open_close = 0.5
    //
    // Rogers-Satchell per bar, rs_i = ln(H/C)ln(H/O) + ln(L/C)ln(L/O):
    //   rs_1 (H=e,L=1,O=1,C=e): ln(e/e)*ln(e/1) + ln(1/e)*ln(1/1) = 0*1 + (-1)*0 = 0
    //   rs_2 (H=e,L=1,O=1,C=1): ln(e/1)*ln(e/1) + ln(1/1)*ln(1/1) = 1*1 + 0*0 = 1  <- anchor
    //   var_rs = (0 + 1) / n = 0.5
    //
    // k = 0.34 / (1.34 + (n+1)/(n-1)) with n=2: 0.34 / (1.34 + 3) = 0.34/4.34
    //
    // var_yz = var_overnight + k*var_open_close + (1-k)*var_rs
    //        = 2.0 + k*0.5 + (1-k)*0.5
    //        = 2.0 + 0.5*(k + 1 - k)
    //        = 2.0 + 0.5
    //        = 2.5   <- independent of k, since var_open_close == var_rs == 0.5
    //
    // sigma = sqrt(2.5) = 1.5811388300841898...
    let e = std::f64::consts::E;
    let e_inv = 1.0 / e;

    let opens = vec![e_inv, 1.0, 1.0];
    let highs = vec![e_inv, e, e];
    let lows = vec![e_inv, 1.0, 1.0];
    let closes = vec![e_inv, e, 1.0];

    let as_of: DateTime<Utc> = "2020-01-01T00:00:00Z".parse().unwrap();
    let ctx = MarketContext {
        symbol: "NSE:TEST".to_string(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        closes,
        opens,
        highs,
        lows,
        volumes: Vec::new(),
        timestamps: Vec::new(),
        options: None,
        chain: None,
        peer: None,
        higher_tf: None,
        as_of,
    };

    let algos = registry::all();
    let algo = algos
        .iter()
        .find(|a| a.id() == "yang_zhang")
        .expect("yang_zhang must be registered");

    let output = algo.compute(&ctx);

    let expected_variance = 2.5_f64;
    let expected_sigma = expected_variance.sqrt();

    assert_eq!(output.direction, Direction::Neutral);
    assert!((output.magnitude - expected_sigma).abs() < 1e-6);
    assert!((output.magnitude.powi(2) - expected_variance).abs() < 1e-6);
    assert_eq!(output.computed_at, as_of);
}
