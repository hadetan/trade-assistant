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

/// 3 Phase-1 baseline algorithms + the 31 catalog algorithms (Tasks 1-31).
/// Kept as an explicit sorted literal (not derived) so a registration that
/// silently drops out of `inventory::submit!` fails this assertion instead
/// of just shrinking a count. Every forecaster (`kronos`/`ttm`/`chronos`/
/// `moirai`) is feature-gated on top of this base catalog -- see
/// `expected_ids_for_enabled_features` below.
const EXPECTED_DEFAULT_IDS: &[&str] = &[
    "accumulation_distribution",
    "adx",
    "atr",
    "bollinger",
    "bsm_greeks",
    "cci",
    "cmf",
    "cointegration",
    "confluence_mtf",
    "donchian",
    "ema",
    "garch",
    "garman_klass",
    "ichimoku",
    "implied_vol",
    "keltner",
    "macd",
    "max_pain",
    "mfi",
    "obv",
    "oi_buildup",
    "ou_half_life",
    "parkinson",
    "psar",
    "put_call_ratio",
    "roc",
    "rsi",
    "sma",
    "stochastic",
    "supertrend",
    "volume_profile",
    "vwap",
    "williams_r",
    "yang_zhang",
];

/// `cfg!(feature = ...)` (a runtime bool, not `#[cfg]`) so this one test
/// function covers every feature combination the `Cargo.toml` aggregates
/// (`forecasters`, `all-forecasters`, or any individual forecaster feature)
/// without needing a combinatorial explosion of `#[cfg]`-gated test fns.
fn expected_ids_for_enabled_features() -> Vec<&'static str> {
    let mut ids = EXPECTED_DEFAULT_IDS.to_vec();
    if cfg!(feature = "kronos") {
        ids.push("kronos");
    }
    if cfg!(feature = "ttm") {
        ids.push("ttm");
    }
    if cfg!(feature = "chronos") {
        ids.push("chronos");
    }
    if cfg!(feature = "moirai") {
        ids.push("moirai");
    }
    ids.sort();
    ids
}

#[test]
fn registry_contains_exactly_the_catalog_for_enabled_forecaster_features() {
    let algos = algo_core::registry::all();
    let mut ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    ids.sort();

    let expected_ids = expected_ids_for_enabled_features();
    assert_eq!(algos.len(), expected_ids.len());
    assert_eq!(ids, expected_ids);
}

/// `ensure_forecasters_linked()` exists to survive release dead-code-
/// stripping (see its doc comment in registry.rs); under the default build
/// (no forecaster feature enabled) it must construct nothing.
#[test]
fn ensure_forecasters_linked_is_empty_without_any_forecaster_feature() {
    if !cfg!(any(feature = "kronos", feature = "ttm", feature = "chronos", feature = "moirai")) {
        assert!(algo_core::registry::ensure_forecasters_linked().is_empty());
    }
}

/// Reproduces the exact union-and-dedup-by-id the `replay`/`sidecar` binaries
/// build their real algo list from, and asserts every forecaster enabled via
/// Cargo features actually reaches that list -- the mechanism the release
/// bins depend on, without loading the app itself.
#[test]
fn binary_algo_list_union_contains_every_enabled_forecaster() {
    let mut algos = algo_core::registry::all();
    for extra in algo_core::registry::ensure_forecasters_linked() {
        if !algos.iter().any(|a| a.id() == extra.id()) {
            algos.push(extra);
        }
    }
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();

    if cfg!(feature = "kronos") {
        assert!(ids.contains(&"kronos"));
    }
    if cfg!(feature = "ttm") {
        assert!(ids.contains(&"ttm"));
    }
    if cfg!(feature = "chronos") {
        assert!(ids.contains(&"chronos"));
    }
    if cfg!(feature = "moirai") {
        assert!(ids.contains(&"moirai"));
    }
}
