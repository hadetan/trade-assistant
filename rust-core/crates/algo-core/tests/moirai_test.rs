//! Moirai-2.0-R-small ONNX forecaster regression test. Gated entirely
//! behind `--features moirai` (the `#![cfg(feature = "moirai")]` below makes
//! this whole file a no-op under the default build).
//!
//! Unlike `kronos_test.rs`, this file only exercises the crate's public
//! `Algorithm`/`AlgoOutput`/`registry` surface -- `forecast::moirai` is a
//! plain (non-`pub(crate)`) module (see `forecast/mod.rs`, out of this
//! task's scope to change), so `MoiraiAdapter` itself is not reachable from
//! an external integration test. The full `[1,4,9,16]` quantile-tensor
//! rel-err check against the fixture lives as a unit test inside
//! `src/forecast/moirai.rs` instead, where it has access to the adapter's
//! raw output; this file re-derives the same fixture's expected
//! `forecast_return`/direction from the committed CSVs and checks them
//! against `compute()`'s public `AlgoOutput`.
#![cfg(feature = "moirai")]

use algo_core::{registry, Algorithm, Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

const CONTEXT_CSV: &str = include_str!("fixtures/moirai_context_512.csv");
const EXPECTED_QUANTILES_CSV: &str = include_str!("fixtures/moirai_expected_quantiles.csv");

const MAX_REL_ERR: f64 = 1e-3;

fn load_context_closes() -> Vec<f64> {
    CONTEXT_CSV
        .lines()
        .skip(1)
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.trim().parse().unwrap())
        .collect()
}

/// `q50` at `raw_step == 0` (predict_token 0, patch_offset 0) -- the
/// one-step-ahead median the adapter's `forecast_return` is built from
/// (`moirai_math::TARGET_RAW_STEP`).
fn expected_q50_at_raw_step_zero() -> f64 {
    EXPECTED_QUANTILES_CSV
        .lines()
        .skip(1)
        .filter(|l| !l.trim().is_empty())
        .find_map(|line| {
            let cols: Vec<&str> = line.split(',').collect();
            let raw_step: usize = cols[3].parse().unwrap();
            let quantile_level: f64 = cols[1].parse().unwrap();
            if raw_step == 0 && (quantile_level - 0.5).abs() < 1e-9 {
                Some(cols[4].parse().unwrap())
            } else {
                None
            }
        })
        .expect("fixture must contain a q0.5 row at raw_step 0")
}

fn fixture_market_context() -> MarketContext {
    let closes = load_context_closes();
    assert_eq!(closes.len(), 512, "fixture context must be exactly the 512-close window");
    let as_of: DateTime<Utc> = "2024-01-01T00:00:00Z".parse().unwrap();
    MarketContext::from_closes("NSE:MOIRAI_FIXTURE", Timeframe::FiveMinute, Horizon::Intraday, closes, as_of)
}

fn find_moirai(algos: &[Box<dyn Algorithm>]) -> &dyn Algorithm {
    algos
        .iter()
        .find(|a| a.id() == "moirai")
        .unwrap_or_else(|| panic!("moirai must be registered in registry::all()"))
        .as_ref()
}

#[test]
fn moirai_is_registered() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"moirai"), "expected \"moirai\" in registered ids, got {ids:?}");
}

#[test]
fn moirai_reconstructed_forecast_matches_committed_regression_fixture() {
    let ctx = fixture_market_context();
    let algos = registry::all();
    let algo = find_moirai(&algos);

    assert!(ctx.closes.len() >= algo.required_lookback());

    let last_close = *ctx.closes.last().unwrap();
    let expected_q50 = expected_q50_at_raw_step_zero();
    let expected_return = (expected_q50 - last_close) / last_close;

    let output = algo.compute(&ctx);

    assert_eq!(output.algo_id, "moirai");
    assert_eq!(
        output.direction,
        if expected_return < 0.0 { Direction::Bearish } else { Direction::Bullish },
        "direction must match sign(q50 - last_close) on the fixture"
    );

    let rel_err = (output.magnitude - expected_return.abs()).abs() / (expected_return.abs() + 1e-9);
    assert!(
        rel_err < MAX_REL_ERR,
        "reconstructed forecast magnitude {} vs expected {} rel_err {rel_err:.3e} (limit {MAX_REL_ERR:e})",
        output.magnitude,
        expected_return.abs()
    );

    assert!(output.confidence > 0.0 && output.confidence <= 1.0);
    assert_eq!(output.computed_at, ctx.as_of);
    assert!(!output.evidence.is_empty());
    for line in &output.evidence {
        assert!(line.starts_with("model opinion:"), "evidence must never read as a headline verdict: {line}");
    }
}

#[test]
fn moirai_direction_is_bullish_on_a_monotone_up_synthetic_window() {
    let as_of: DateTime<Utc> = "2024-01-01T00:00:00Z".parse().unwrap();
    let closes: Vec<f64> = (0..512).map(|i| 100.0 + i as f64 * 0.5).collect();
    let ctx = MarketContext::from_closes("NSE:MONOTONE_UP", Timeframe::FiveMinute, Horizon::Intraday, closes, as_of);

    let algos = registry::all();
    let algo = find_moirai(&algos);
    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Bullish);
    for line in &output.evidence {
        assert!(line.starts_with("model opinion:"));
    }
}

#[test]
fn moirai_no_ops_on_insufficient_history() {
    let as_of: DateTime<Utc> = "2020-01-01T00:00:00Z".parse().unwrap();
    let ctx = MarketContext::from_closes("NSE:TEST", Timeframe::Day, Horizon::Positional, vec![100.0; 10], as_of);

    let algos = registry::all();
    let algo = find_moirai(&algos);
    assert!(ctx.closes.len() < algo.required_lookback());

    // `forecast()`'s own length guard (`build_context_input` returning
    // `None`) makes calling `compute()` directly with short history safe --
    // same graceful-degradation contract `kronos.rs`'s `compute()` gives its
    // own no-op test, not the general trait-doc panic precondition that
    // applies to algorithms with no internal guard.
    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.confidence, 0.0);
    assert_eq!(output.evidence, vec!["model opinion: insufficient history for moirai".to_string()]);
}
