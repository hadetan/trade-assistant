//! Chronos-Bolt-small ONNX forecaster regression test. Gated entirely behind
//! `--features chronos` (the `#![cfg(feature = "chronos")]` below makes this
//! whole file a no-op under the default build).
//!
//! `chronos.rs`/`chronos_math.rs` are private modules (not re-exported from
//! `lib.rs`, unlike `kronos.rs`), so this integration test can only reach
//! the adapter through `registry::all()` + the public `Algorithm` trait --
//! there is no `ChronosAlgorithm`/`ChronosForecast` type to import directly.
//! The regression check below therefore recovers the model's raw q10/q50/q90
//! values by parsing them back out of `compute()`'s own `"model opinion:"`
//! evidence line (the adapter formats them at `{:.6}` precision, i.e. far
//! finer than the `1e-3` relative-error bar this test enforces), rather than
//! bypassing the public surface.
#![cfg(feature = "chronos")]

use algo_core::{registry, Algorithm, Direction, Horizon, MarketContext, Timeframe};
use chrono::{DateTime, Utc};

const CONTEXT_CSV: &str = include_str!("fixtures/chronos_context.csv");
const EXPECTED_QUANTILES_CSV: &str = include_str!("fixtures/chronos_expected_quantiles.csv");

const MAX_REL_ERR: f64 = 1e-3;

fn load_context_closes() -> Vec<f64> {
    CONTEXT_CSV
        .lines()
        .skip(1)
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let (_, close) = line.split_once(',').unwrap_or_else(|| panic!("bad context row: {line}"));
            close.parse().unwrap_or_else(|e| panic!("bad close value in {line}: {e}"))
        })
        .collect()
}

/// `(q10_row, q50_row, q90_row)`, each 64 `f64`s indexed by horizon step --
/// the committed fixture's quantile rows are ascending (`0.1..0.9`), so data
/// rows 0/4/8 are exactly q10/q50/q90, matching `chronos_math::{Q10_IDX,
/// Q50_IDX, Q90_IDX}`.
fn load_expected_quantile_rows() -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let rows: Vec<Vec<f64>> = EXPECTED_QUANTILES_CSV
        .lines()
        .skip(1)
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let mut cols = line.split(',');
            cols.next();
            cols.map(|v| v.parse().unwrap_or_else(|e| panic!("bad quantile value in {line}: {e}"))).collect()
        })
        .collect();
    assert_eq!(rows.len(), 9, "expected 9 quantile rows (q10..q90)");
    (rows[0].clone(), rows[4].clone(), rows[8].clone())
}

fn fixture_market_context(horizon: Horizon) -> (MarketContext, f64) {
    let closes = load_context_closes();
    assert_eq!(closes.len(), 2048, "fixture must carry a full un-padded context window");
    let last_close = *closes.last().unwrap();
    let as_of = "2024-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = MarketContext::from_closes("NSE:CHRONOS_FIXTURE", Timeframe::Day, horizon, closes, as_of);
    (ctx, last_close)
}

fn chronos_algo() -> Box<dyn Algorithm> {
    registry::all().into_iter().find(|a| a.id() == "chronos").expect("chronos must be registered")
}

/// Pulls a `key=value` float out of an evidence line, delimited by
/// whitespace or end-of-string.
fn parse_evidence_value(evidence: &str, key: &str) -> f64 {
    let needle = format!("{key}=");
    let start =
        evidence.find(&needle).unwrap_or_else(|| panic!("{key} not found in evidence: {evidence}")) + needle.len();
    let rest = &evidence[start..];
    let end = rest.find(' ').unwrap_or(rest.len());
    rest[..end].parse().unwrap_or_else(|e| panic!("bad {key} value in evidence {evidence}: {e}"))
}

fn rel_err(got: f64, want: f64) -> f64 {
    (got - want).abs() / (want.abs() + 1e-9)
}

fn assert_quantiles_match_fixture(output: &algo_core::AlgoOutput, want_q10: f64, want_q50: f64, want_q90: f64) {
    let evidence = output.evidence.join(" ");
    assert!(evidence.starts_with("model opinion:"), "evidence must never read as a headline verdict: {evidence}");

    let got_q10 = parse_evidence_value(&evidence, "q10");
    let got_q50 = parse_evidence_value(&evidence, "q50");
    let got_q90 = parse_evidence_value(&evidence, "q90");

    let max_rel_err =
        [rel_err(got_q10, want_q10), rel_err(got_q50, want_q50), rel_err(got_q90, want_q90)].into_iter().fold(0.0, f64::max);

    assert!(
        max_rel_err < MAX_REL_ERR,
        "reconstructed quantiles vs fixture: rel_err {max_rel_err:.3e} (limit {MAX_REL_ERR:e}) \
         got (q10={got_q10}, q50={got_q50}, q90={got_q90}) want (q10={want_q10}, q50={want_q50}, q90={want_q90})"
    );
}

#[test]
fn chronos_is_registered() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"chronos"), "chronos must appear in registry::all(): {ids:?}");
}

#[test]
fn chronos_reconstructed_quantiles_match_fixture_at_next_bar_step() {
    let (ctx, last_close) = fixture_market_context(Horizon::Intraday);
    let (q10_row, q50_row, q90_row) = load_expected_quantile_rows();
    let algo = chronos_algo();

    let output = algo.compute(&ctx);

    assert_eq!(output.algo_id, "chronos");
    assert_eq!(output.computed_at, ctx.as_of);
    assert_quantiles_match_fixture(&output, q10_row[0], q50_row[0], q90_row[0]);

    let want_forecast_return = (q50_row[0] - last_close) / last_close;
    assert!(rel_err(output.magnitude, want_forecast_return.abs()) < MAX_REL_ERR);
    assert_eq!(
        output.direction,
        if want_forecast_return > 0.0 { Direction::Bullish } else { Direction::Bearish }
    );
}

#[test]
fn chronos_reconstructed_quantiles_match_fixture_at_five_bar_step() {
    let (ctx, last_close) = fixture_market_context(Horizon::Positional);
    let (q10_row, q50_row, q90_row) = load_expected_quantile_rows();
    let algo = chronos_algo();

    let output = algo.compute(&ctx);

    assert_quantiles_match_fixture(&output, q10_row[4], q50_row[4], q90_row[4]);

    let want_forecast_return = (q50_row[4] - last_close) / last_close;
    assert!(rel_err(output.magnitude, want_forecast_return.abs()) < MAX_REL_ERR);
}

#[test]
fn chronos_direction_is_bullish_on_a_monotone_up_synthetic_window() {
    // A short, recent uptrend (left-padded with NaN out to CONTEXT_LENGTH by
    // `chronos_math::build_context`, exactly like a live symbol with less
    // than 2048 bars of history) -- not a full 2048-bar noiseless straight
    // line, which this checkpoint instead reads as due for a pullback
    // (verified empirically: a 2048-bar ramp forecasts slightly Bearish,
    // while shorter recent windows in the 40-256 range all forecast
    // Bullish at both horizons). A perfectly linear multi-year ramp is
    // itself an out-of-distribution input no real instrument produces.
    let as_of = "2024-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let n = 256;
    let closes: Vec<f64> = (0..n).map(|i| 1000.0 + i as f64 * 2.0).collect();

    for horizon in [Horizon::Intraday, Horizon::Positional] {
        let ctx = MarketContext::from_closes("NSE:MONOTONE_UP", Timeframe::Day, horizon, closes.clone(), as_of);
        let algo = chronos_algo();
        let output = algo.compute(&ctx);

        assert_eq!(output.direction, Direction::Bullish, "horizon {horizon:?}: {:?}", output.evidence);
        assert!(output.magnitude > 0.0);
        for line in &output.evidence {
            assert!(line.starts_with("model opinion:"));
        }
    }
}

#[test]
fn chronos_no_ops_on_empty_close_history() {
    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = MarketContext::from_closes("NSE:TEST", Timeframe::Day, Horizon::Positional, vec![], as_of);

    let algo = chronos_algo();
    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.confidence, 0.0);
    assert_eq!(output.evidence, vec!["model opinion: insufficient history for chronos".to_string()]);
    assert_eq!(output.computed_at, as_of);
}
