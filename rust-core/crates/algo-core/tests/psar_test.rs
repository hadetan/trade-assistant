use algo_core::registry;
use algo_core::{Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

/// Independent re-derivation of Wilder's long-side recursion for the ramp
/// input below (never reverses), used to pin the brief's exact anchors
/// (SAR0==8.0, SAR1==8.04) and the final-bar reference value.
fn expected_long_psar(highs: &[f64], lows: &[f64]) -> Vec<f64> {
    let mut sar = vec![lows[0]];
    let mut ep = highs[0];
    let mut af = 0.02_f64;
    for i in 1..highs.len() {
        let prev = sar[i - 1];
        let raw = prev + af * (ep - prev);
        sar.push(raw.min(lows[i]));
        if highs[i] > ep {
            ep = highs[i];
            af = (af + 0.02).min(0.2);
        }
    }
    sar
}

#[test]
fn psar_is_registered() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"psar"));
}

#[test]
fn psar_matches_wilder_init_anchor_and_stays_bullish() {
    // 15-bar uptrend ramp: high_i = 10+i, low_i = 8+i (initial long).
    let highs: Vec<f64> = (0..15).map(|i| 10.0 + i as f64).collect();
    let lows: Vec<f64> = (0..15).map(|i| 8.0 + i as f64).collect();
    let closes: Vec<f64> = highs
        .iter()
        .zip(lows.iter())
        .map(|(h, l)| (h + l) / 2.0)
        .collect();

    let expected = expected_long_psar(&highs, &lows);
    // Wilder init anchor: seed SAR0 = low[0] = 8.0, EP = high[0] = 10.0,
    // AF = 0.02 => SAR1 = SAR0 + AF*(EP-SAR0) = 8 + 0.02*(10-8) = 8.04.
    assert_eq!(expected[0], 8.0);
    assert!((expected[1] - 8.04).abs() < 1e-12);

    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = MarketContext {
        symbol: "NSE:TEST".to_string(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        closes: closes.clone(),
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
    };

    let algos = registry::all();
    let psar = algos
        .iter()
        .find(|a| a.id() == "psar")
        .expect("psar must be registered");

    let output = psar.compute(&ctx);

    let final_expected = *expected.last().unwrap();
    assert!((output.magnitude - final_expected).abs() < 1e-9);
    assert_eq!(output.direction, Direction::Bullish);

    // secondary: sar < last close
    assert!(output.magnitude < *closes.last().unwrap());
    assert_eq!(output.computed_at, as_of);
}
