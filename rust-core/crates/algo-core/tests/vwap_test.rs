use algo_core::registry;
use algo_core::{Algorithm, Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

fn find_vwap() -> Box<dyn Algorithm> {
    registry::all()
        .into_iter()
        .find(|algo| algo.id() == "vwap")
        .expect("vwap algorithm registered in the catalog")
}

#[test]
fn vwap_is_registered_in_the_catalog() {
    let ids: Vec<&str> = registry::all().iter().map(|algo| algo.id()).collect();
    assert!(ids.contains(&"vwap"));
}

#[test]
fn vwap_accumulates_from_the_session_open() {
    let algo = find_vwap();
    let as_of: DateTime<Utc> = "2023-11-15T04:00:00Z".parse().unwrap();

    // Both bars fall in the same IST calendar day (ts0 is 2023-11-15 03:43:20
    // IST; ts0+300s is five minutes later, same day): TP=[10,11], V=[100,100]
    // -> VWAP = (10*100 + 11*100) / 200 = 10.5.
    let ctx = MarketContext {
        symbol: "NSE:TEST".to_string(),
        timeframe: Timeframe::Minute,
        horizon: Horizon::Intraday,
        closes: vec![10.0, 11.0],
        opens: Vec::new(),
        highs: vec![10.0, 11.0],
        lows: vec![10.0, 11.0],
        volumes: vec![100.0, 100.0],
        timestamps: vec![1_700_000_000, 1_700_000_300],
        options: None,
        chain: None,
        peer: None,
        higher_tf: None,
        as_of,
    };

    let output = algo.compute(&ctx);

    assert!(output.evidence[0].contains("10.50"));
    // last close (11.0) is above the session VWAP (10.5) -> Bullish
    assert_eq!(output.direction, Direction::Bullish);
    assert_eq!(output.computed_at, as_of);
}

#[test]
fn vwap_resets_on_a_new_ist_session() {
    let algo = find_vwap();
    let as_of: DateTime<Utc> = "2023-11-16T04:00:00Z".parse().unwrap();

    // Third bar lands exactly one day later (ts0 + 86_400s), which always
    // rolls the IST calendar date over regardless of time-of-day, since the
    // UTC->IST offset is fixed. If accumulation wrongly pooled all three
    // bars, VWAP would be (10*100+11*100+20*100)/300 = 13.67, not 20.00.
    let ctx = MarketContext {
        symbol: "NSE:TEST".to_string(),
        timeframe: Timeframe::Minute,
        horizon: Horizon::Intraday,
        closes: vec![10.0, 11.0, 20.0],
        opens: Vec::new(),
        highs: vec![10.0, 11.0, 20.0],
        lows: vec![10.0, 11.0, 20.0],
        volumes: vec![100.0, 100.0, 100.0],
        timestamps: vec![1_700_000_000, 1_700_000_300, 1_700_000_000 + 86_400],
        options: None,
        chain: None,
        peer: None,
        higher_tf: None,
        as_of,
    };

    let output = algo.compute(&ctx);

    // New session's VWAP equals the reset bar's own TP (20.00): the close
    // (20.0) coincides with it, so distance is zero -> Neutral.
    assert!(output.evidence[0].contains("20.00"));
    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.computed_at, as_of);
}

#[test]
fn vwap_no_ops_when_session_volume_is_zero() {
    let algo = find_vwap();
    let as_of: DateTime<Utc> = "2023-11-15T04:00:00Z".parse().unwrap();

    // All-zero volume (illiquid strike / halted symbol / synthetic pre-market)
    // would make pv_sum/v_sum a 0.0/0.0 NaN that classify_by_distance's
    // zero-baseline guard can't catch, fabricating a maximally-confident
    // Bearish signal instead of no-opting.
    let ctx = MarketContext {
        symbol: "NSE:TEST".to_string(),
        timeframe: Timeframe::Minute,
        horizon: Horizon::Intraday,
        closes: vec![10.0, 11.0],
        opens: Vec::new(),
        highs: vec![10.0, 11.0],
        lows: vec![10.0, 11.0],
        volumes: vec![0.0, 0.0],
        timestamps: vec![1_700_000_000, 1_700_000_300],
        options: None,
        chain: None,
        peer: None,
        higher_tf: None,
        as_of,
    };

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert!(!output.magnitude.is_nan());
    assert_eq!(output.magnitude, 0.0);
    assert_ne!(output.confidence, 1.0);
    assert_eq!(output.confidence, 0.0);
    assert_eq!(output.evidence, vec!["zero session volume".to_string()]);
    assert_eq!(output.computed_at, as_of);
}

#[test]
fn vwap_no_ops_when_series_are_shorter_than_required_lookback() {
    let algo = find_vwap();
    let as_of: DateTime<Utc> = "2023-11-15T04:00:00Z".parse().unwrap();

    let ctx = MarketContext::from_closes(
        "NSE:TEST",
        Timeframe::Minute,
        Horizon::Intraday,
        vec![10.0],
        as_of,
    );

    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.evidence, vec!["insufficient OHLCV".to_string()]);
    assert_eq!(output.computed_at, as_of);
}
