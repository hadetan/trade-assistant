use algo_core::{
    HigherTfSeries, Horizon, MarketContext, OptionChainSnapshot, OptionsContext, PeerSeries,
    StrikeRow, Timeframe,
};
use chrono::{DateTime, Utc};

#[test]
fn market_context_round_trips_ohlcv_and_options_extras() {
    let as_of: DateTime<Utc> = "2020-01-01T00:00:00Z".parse().unwrap();
    let ctx = MarketContext {
        symbol: "NSE:INFY".to_string(),
        timeframe: Timeframe::Day,
        horizon: Horizon::Positional,
        closes: vec![100.0, 101.0, 102.0],
        opens: vec![99.0, 100.0, 101.0],
        highs: vec![101.0, 102.0, 103.0],
        lows: vec![98.0, 99.0, 100.0],
        volumes: vec![1000.0, 1100.0, 1200.0],
        timestamps: vec![1_700_000_000, 1_700_086_400, 1_700_172_800],
        options: Some(OptionsContext {
            spot: 100.0,
            strike: 100.0,
            rate: 0.07,
            time_to_expiry_years: 0.0833,
            is_call: true,
            iv: 0.2,
            oi: 1000.0,
            prev_oi: 900.0,
            oi_day_high: 1100.0,
            oi_day_low: 850.0,
            market_price: 5.0,
        }),
        chain: Some(OptionChainSnapshot {
            spot: 100.0,
            strikes: vec![StrikeRow { strike: 95.0, call_oi: 500.0, put_oi: 300.0 }],
        }),
        peer: Some(PeerSeries { symbol: "NSE:TCS".to_string(), closes: vec![3000.0, 3010.0] }),
        higher_tf: Some(HigherTfSeries { timeframe: Timeframe::Day, closes: vec![100.0, 105.0] }),
        as_of,
    };

    assert_eq!(ctx.opens.len(), 3);
    assert_eq!(ctx.highs.len(), 3);
    assert_eq!(ctx.lows.len(), 3);
    assert_eq!(ctx.volumes.len(), 3);
    assert_eq!(ctx.timestamps.len(), 3);
    assert!((ctx.options.as_ref().unwrap().spot - 100.0).abs() < 1e-12);
    assert_eq!(ctx.chain.as_ref().unwrap().strikes.len(), 1);
    assert_eq!(ctx.peer.as_ref().unwrap().symbol, "NSE:TCS");
    assert_eq!(ctx.higher_tf.as_ref().unwrap().closes.len(), 2);
    assert_eq!(ctx.as_of, as_of);
}

#[test]
fn from_closes_preserves_the_phase_one_shape() {
    let as_of: DateTime<Utc> = "2020-01-01T00:00:00Z".parse().unwrap();
    let ctx =
        MarketContext::from_closes("NSE:INFY", Timeframe::Day, Horizon::Positional, vec![100.0, 101.0], as_of);

    assert!(ctx.opens.is_empty());
    assert!(ctx.highs.is_empty());
    assert!(ctx.lows.is_empty());
    assert!(ctx.volumes.is_empty());
    assert!(ctx.timestamps.is_empty());
    assert!(ctx.options.is_none());
    assert!(ctx.chain.is_none());
    assert!(ctx.peer.is_none());
    assert!(ctx.higher_tf.is_none());
    assert_eq!(ctx.closes, vec![100.0, 101.0]);
    assert_eq!(ctx.as_of, as_of);
}

#[test]
fn registry_contains_exactly_the_pre_catalog_baseline() {
    let algos = algo_core::registry::all();
    let mut ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    ids.sort();

    assert_eq!(ids, vec!["ema", "rsi", "sma"]);
    assert_eq!(algos.len(), 3);
}
