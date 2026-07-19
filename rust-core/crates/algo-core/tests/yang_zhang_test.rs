use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

#[test]
fn yang_zhang_is_registered() {
    let ids: Vec<&str> = registry::all().iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"yang_zhang"));
}

#[test]
fn yang_zhang_matches_hand_derived_variance() {
    // 3-bar synthetic driven through the registered algo's compute(), with
    // e = std::f64::consts::E. Bars 1-2 each have O, H, L, C all distinct so
    // BOTH Rogers-Satchell product terms are non-zero on every bar (unlike a
    // fixture where L==O, which would zero the low-side term and let a
    // '+' -> '-' flip between the two terms go undetected):
    //
    //   bar0: O=H=L=C = 1/e            (anchors only bar1's overnight return)
    //   bar1: O=1, H=e^2, L=1/e, C=e
    //   bar2: O=e, H=e^3, L=1/e, C=1
    //
    // Overnight returns o_i = ln(open_i / close_{i-1}):
    //   o_1 = ln(1 / (1/e)) = ln(e) = 1
    //   o_2 = ln(e / e)     = 0
    //   mean = 0.5; sum sq dev = 0.25 + 0.25 = 0.5; n-1 = 1 -> var_overnight = 0.5
    //
    // Open-close returns c_i = ln(close_i / open_i):
    //   c_1 = ln(e / 1) = 1
    //   c_2 = ln(1 / e) = -1
    //   mean = 0; sum sq dev = 1 + 1 = 2; n-1 = 1 -> var_open_close = 2.0
    //
    // Rogers-Satchell per bar, rs_i = ln(H/C)ln(H/O) + ln(L/C)ln(L/O):
    //   rs_1 (H=e^2,L=1/e,O=1,C=e): ln(e)*ln(e^2) + ln(e^-2)*ln(e^-1)
    //                             =   1 *   2     +   -2   *   -1     = 2 + 2 = 4
    //   rs_2 (H=e^3,L=1/e,O=e,C=1): ln(e^3)*ln(e^2) + ln(e^-1)*ln(e^-2)
    //                             =   3   *   2     +   -1   *   -2     = 6 + 2 = 8
    //   var_rs = (4 + 8) / n = 6.0
    //   (a '+' -> '-' flip in rogers_satchell_term gives rs_1=0, rs_2=4,
    //    var_rs=2.0 instead of 6.0 — see below for the effect on sigma)
    //
    // k = 0.34 / (1.34 + (n+1)/(n-1)) with n=2: 0.34 / 4.34 = 0.0783410138248848
    //
    // var_yz = var_overnight + k*var_open_close + (1-k)*var_rs
    //        = 0.5 + k*2.0 + (1-k)*6.0
    //        = 6.186635944700461
    // sigma  = sqrt(var_yz) = 2.4872949050525675
    //
    // (with the flipped-sign bug: var_yz = 0.5 + k*2.0 + (1-k)*2.0 = 2.5,
    //  sigma = 1.5811388300841898 — far outside this test's 1e-6 tolerance)
    let e = std::f64::consts::E;

    let opens = vec![1.0 / e, 1.0, e];
    let highs = vec![1.0 / e, e.powi(2), e.powi(3)];
    let lows = vec![1.0 / e, 1.0 / e, 1.0 / e];
    let closes = vec![1.0 / e, e, 1.0];

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

    let expected_variance = 6.186635944700461_f64;
    let expected_sigma = 2.4872949050525675_f64;

    assert_eq!(output.direction, Direction::Neutral);
    assert!((output.magnitude - expected_sigma).abs() < 1e-6);
    assert!((output.magnitude.powi(2) - expected_variance).abs() < 1e-6);
    assert_eq!(output.computed_at, as_of);
}
