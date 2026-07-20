//! Granite-TTM r2 ONNX forecaster regression test. Gated entirely behind
//! `--features ttm` (the `#![cfg(feature = "ttm")]` below makes this whole
//! file a no-op under the default build -- `cargo test -p algo-core`
//! compiles and runs zero of it, and touches no `ort`/ONNX code).
//!
//! `TtmAdapter` and `ttm_math` are crate-private (only `forecast::framework`
//! is `pub(crate)`; `ttm`/`ttm_math` themselves are plain `mod`), so this
//! integration test only sees the public `Algorithm`/`AlgoOutput`/
//! `registry` surface -- exact-per-checkpoint fixture reconstruction lives
//! in `src/forecast/ttm.rs`'s own `#[cfg(test)]` unit tests, which run
//! inside the crate and can call `TtmAdapter::run_session` directly.
#![cfg(feature = "ttm")]

use algo_core::{registry, Algorithm, Direction, Horizon, MarketContext, Timeframe};
use chrono::DateTime;

const CONTEXT_CSV: &str = include_str!("fixtures/ttm_context.csv");
const EXPECTED_512_CSV: &str = include_str!("fixtures/ttm_expected_512.csv");
const EXPECTED_1024_CSV: &str = include_str!("fixtures/ttm_expected_1024.csv");
const EXPECTED_1536_CSV: &str = include_str!("fixtures/ttm_expected_1536.csv");

const MAX_REL_ERR: f64 = 1e-3;

fn parse_second_column(csv: &str) -> Vec<f64> {
    csv.lines()
        .skip(1)
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.split(',').nth(1).unwrap().parse().unwrap())
        .collect()
}

fn ttm_algo() -> Box<dyn Algorithm> {
    registry::all()
        .into_iter()
        .find(|a| a.id() == "ttm")
        .expect("ttm must be registered via inventory::submit!")
}

fn fixture_market_context() -> MarketContext {
    let closes = parse_second_column(CONTEXT_CSV);
    let as_of = "2024-01-06T17:10:00Z".parse::<DateTime<chrono::Utc>>().unwrap();
    MarketContext::from_closes("NSE:TTM_FIXTURE", Timeframe::FiveMinute, Horizon::Intraday, closes, as_of)
}

#[test]
fn ttm_is_registered_in_registry() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"ttm"));
}

#[test]
fn ttm_reconstructed_forecast_matches_fixture_within_rel_err() {
    let ctx = fixture_market_context();
    let last_close = *ctx.closes.last().unwrap();

    // Expected ensemble stats, derived directly from the spike's committed
    // Python-`onnxruntime` fixture output (docs/superpowers/spikes/2026-07
    // -20-ttm-onnx-feasibility.md §7-8) rather than from this crate's
    // internal `ttm_math`/`TtmAdapter` (crate-private, unreachable from an
    // integration test) -- this independently re-derives the same
    // direction-agreement ensemble the adapter computes, from numbers this
    // test file owns outright.
    let expected_last_steps = [
        *parse_second_column(EXPECTED_512_CSV).last().unwrap(),
        *parse_second_column(EXPECTED_1024_CSV).last().unwrap(),
        *parse_second_column(EXPECTED_1536_CSV).last().unwrap(),
    ];
    let expected_returns: Vec<f64> = expected_last_steps.iter().map(|&f| (f - last_close) / last_close).collect();
    let expected_mean_return = expected_returns.iter().sum::<f64>() / expected_returns.len() as f64;
    assert!(expected_returns.iter().all(|&r| r < 0.0), "spike doc §8: fixture is a unanimous-down ensemble");

    let algo = ttm_algo();
    let output = algo.compute(&ctx);

    assert_eq!(output.algo_id, "ttm");
    assert_eq!(output.direction, Direction::Bearish);
    assert_eq!(output.confidence, 1.0, "spike doc §8: 3/3 checkpoints agree on direction -> conviction 1.00");

    let rel_err = (output.magnitude - expected_mean_return.abs()).abs() / expected_mean_return.abs();
    assert!(
        rel_err < MAX_REL_ERR,
        "got magnitude {} want {} rel_err {rel_err:.3e} (limit {MAX_REL_ERR:e})",
        output.magnitude,
        expected_mean_return.abs()
    );

    assert_eq!(output.computed_at, ctx.as_of);
    assert!(!output.evidence.is_empty());
    for line in &output.evidence {
        assert!(line.starts_with("model opinion:"), "evidence must never read as a headline verdict: {line}");
    }
}

#[test]
fn ttm_direction_is_bullish_on_a_monotone_up_synthetic_window() {
    let as_of = "2024-01-01T00:00:00Z".parse::<DateTime<chrono::Utc>>().unwrap();
    let n = 512;
    // Flat for the first 400 bars then rising for the trailing 112 (still
    // monotone non-decreasing everywhere). A constant-slope ramp across the
    // *entire* 512-bar window was tried first and empirically forecasts
    // Bearish (mean-reversion) from this checkpoint -- a full-window
    // straight-line trend essentially never occurs in the real series TTM
    // was trained on, so it reads as anomalous rather than as momentum. A
    // trailing breakout stays in-distribution and forecasts Bullish
    // robustly across a flat-length x slope grid (380-420 bars flat,
    // slope 0.8-1.5), not just this one point.
    let flat_len = 400;
    let slope = 1.0;
    let closes: Vec<f64> = (0..n)
        .map(|i| if i < flat_len { 100.0 } else { 100.0 + (i - flat_len) as f64 * slope })
        .collect();

    let ctx = MarketContext::from_closes("NSE:MONOTONE_UP", Timeframe::FiveMinute, Horizon::Intraday, closes, as_of);

    let algo = ttm_algo();
    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Bullish);
}

#[test]
fn ttm_no_ops_on_insufficient_history() {
    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<chrono::Utc>>().unwrap();
    let ctx = MarketContext::from_closes("NSE:TEST", Timeframe::Day, Horizon::Positional, vec![100.0; 10], as_of);

    let algo = ttm_algo();
    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.confidence, 0.0);
    assert_eq!(output.evidence, vec!["model opinion: insufficient history for ttm".to_string()]);
    assert_eq!(output.computed_at, ctx.as_of);
}
