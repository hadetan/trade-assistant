//! Kronos ONNX forecaster regression test. Gated entirely behind
//! `--features kronos` (the `#![cfg(feature = "kronos")]` below makes this
//! whole file a no-op file under the default build -- `cargo test -p
//! algo-core` compiles and runs zero of it, and touches no `ort`/ONNX code).
#![cfg(feature = "kronos")]

use algo_core::{registry, Algorithm, Direction, Horizon, KronosAlgorithm, MarketContext, Timeframe};
use chrono::{DateTime, NaiveDateTime, Utc};

const CONTEXT_CSV: &str = include_str!("fixtures/kronos_regression_context_256.csv");
const EXPECTED_FORECAST_CSV: &str = include_str!("fixtures/kronos_regression_expected_forecast_8.csv");

// Greedy (top_k=1) token ids this exact checkpoint/pipeline produces for the
// fixture below -- see .superpowers/sdd/task-32-report.md for the
// onnxruntime-validated derivation.
const EXPECTED_S1_TOKENS: [i64; 8] = [941, 941, 941, 941, 941, 941, 941, 941];
const EXPECTED_S2_TOKENS: [i64; 8] = [29, 29, 29, 29, 29, 29, 29, 29];

const PRED_LEN: usize = 8;
const MAX_REL_ERR: f64 = 1e-3;

struct ContextFixture {
    opens: Vec<f64>,
    highs: Vec<f64>,
    lows: Vec<f64>,
    closes: Vec<f64>,
    volumes: Vec<f64>,
    timestamps: Vec<i64>,
}

fn parse_epoch(naive_iso: &str) -> i64 {
    // The fixture's timestamps are naive wall-clock strings (no offset);
    // interpreted as UTC so the derived calendar features (minute/hour/
    // weekday/day/month) exactly match the upstream fixture's pandas-naive
    // values -- see kronos.rs's module doc.
    NaiveDateTime::parse_from_str(naive_iso, "%Y-%m-%dT%H:%M:%S")
        .unwrap_or_else(|e| panic!("bad fixture timestamp {naive_iso}: {e}"))
        .and_utc()
        .timestamp()
}

fn load_context() -> ContextFixture {
    let mut opens = Vec::new();
    let mut highs = Vec::new();
    let mut lows = Vec::new();
    let mut closes = Vec::new();
    let mut volumes = Vec::new();
    let mut timestamps = Vec::new();

    for line in CONTEXT_CSV.lines().skip(1) {
        if line.trim().is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split(',').collect();
        timestamps.push(parse_epoch(cols[0]));
        opens.push(cols[1].parse().unwrap());
        highs.push(cols[2].parse().unwrap());
        lows.push(cols[3].parse().unwrap());
        closes.push(cols[4].parse().unwrap());
        volumes.push(cols[5].parse().unwrap());
    }

    ContextFixture { opens, highs, lows, closes, volumes, timestamps }
}

fn load_expected_forecast() -> Vec<[f64; 6]> {
    EXPECTED_FORECAST_CSV
        .lines()
        .skip(1)
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let cols: Vec<&str> = line.split(',').collect();
            let mut row = [0.0; 6];
            for (c, slot) in row.iter_mut().enumerate() {
                *slot = cols[c].parse().unwrap();
            }
            row
        })
        .collect()
}

fn fixture_market_context() -> MarketContext {
    let fx = load_context();
    let as_of = DateTime::from_timestamp(*fx.timestamps.last().unwrap(), 0).unwrap();
    MarketContext {
        symbol: "NSE:KRONOS_FIXTURE".to_string(),
        timeframe: Timeframe::FiveMinute,
        horizon: Horizon::Intraday,
        closes: fx.closes,
        opens: fx.opens,
        highs: fx.highs,
        lows: fx.lows,
        volumes: fx.volumes,
        timestamps: fx.timestamps,
        options: None,
        chain: None,
        peer: None,
        higher_tf: None,
        as_of,
    }
}

#[test]
fn kronos_is_registered() {
    let algos = registry::all();
    let ids: Vec<&str> = algos.iter().map(|a| a.id()).collect();
    assert!(ids.contains(&"kronos"));
}

#[test]
fn kronos_reconstructed_forecast_matches_committed_regression_fixture() {
    let ctx = fixture_market_context();
    let algo = KronosAlgorithm::new();

    let forecast = algo.forecast(&ctx).expect("256-bar fixture must clear the OHLCV guard");

    assert_eq!(forecast.s1_tokens, EXPECTED_S1_TOKENS, "greedy s1 argmax must match exactly");
    assert_eq!(forecast.s2_tokens, EXPECTED_S2_TOKENS, "greedy s2 argmax must match exactly");

    let expected = load_expected_forecast();
    assert_eq!(expected.len(), PRED_LEN);

    let mut max_rel_err = 0.0f64;
    for (i, (got, want)) in forecast.bars.iter().zip(expected.iter()).enumerate() {
        for c in 0..6 {
            let rel_err = (got[c] - want[c]).abs() / (want[c].abs() + 1e-9);
            max_rel_err = max_rel_err.max(rel_err);
            assert!(
                rel_err < MAX_REL_ERR,
                "bar {i} channel {c}: got {} want {} rel_err {rel_err:.3e} (limit {MAX_REL_ERR:e})",
                got[c],
                want[c]
            );
        }
    }
    assert!(max_rel_err < MAX_REL_ERR);

    assert!(forecast.conviction > 0.0 && forecast.conviction <= 1.0);

    // Full-pipeline sanity via the public Algorithm trait too: the fixture's
    // forecast close (bar 8) sits above the fixture's latest actual close,
    // so compute()'s summarized opinion must agree.
    let output = algo.compute(&ctx);
    assert_eq!(output.algo_id, "kronos");
    assert_eq!(output.direction, Direction::Bullish);
    assert!(output.magnitude > 0.0);
    assert!(output.confidence > 0.0 && output.confidence <= 1.0);
    assert_eq!(output.computed_at, ctx.as_of);
    for line in &output.evidence {
        assert!(line.starts_with("model opinion:"), "evidence must never read as a headline verdict: {line}");
    }
}

#[test]
fn kronos_no_ops_on_insufficient_ohlcv_history() {
    let as_of = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let ctx = MarketContext::from_closes(
        "NSE:TEST",
        Timeframe::Day,
        Horizon::Positional,
        vec![100.0; 10],
        as_of,
    );
    let algo = KronosAlgorithm::new();

    assert!(algo.forecast(&ctx).is_none());

    let output = algo.compute(&ctx);
    assert_eq!(output.direction, Direction::Neutral);
    assert_eq!(output.magnitude, 0.0);
    assert_eq!(output.confidence, 0.0);
    assert_eq!(output.evidence, vec!["model opinion: insufficient OHLCV history for Kronos".to_string()]);
}

#[test]
fn kronos_direction_is_bullish_on_a_monotone_up_synthetic_window() {
    let as_of = "2024-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
    let n = 256;
    let mut opens = Vec::with_capacity(n);
    let mut highs = Vec::with_capacity(n);
    let mut lows = Vec::with_capacity(n);
    let mut closes = Vec::with_capacity(n);
    let mut volumes = Vec::with_capacity(n);
    let mut timestamps = Vec::with_capacity(n);

    let start_epoch = 1_700_000_000i64;
    for i in 0..n {
        let base = 100.0 + i as f64 * 0.5;
        opens.push(base);
        highs.push(base + 0.3);
        lows.push(base - 0.3);
        closes.push(base + 0.1);
        volumes.push(1_000.0);
        timestamps.push(start_epoch + i as i64 * 300);
    }

    let ctx = MarketContext {
        symbol: "NSE:MONOTONE_UP".to_string(),
        timeframe: Timeframe::FiveMinute,
        horizon: Horizon::Intraday,
        closes,
        opens,
        highs,
        lows,
        volumes,
        timestamps,
        options: None,
        chain: None,
        peer: None,
        higher_tf: None,
        as_of,
    };

    let algo = KronosAlgorithm::new();
    let output = algo.compute(&ctx);

    assert_eq!(output.direction, Direction::Bullish);
}
