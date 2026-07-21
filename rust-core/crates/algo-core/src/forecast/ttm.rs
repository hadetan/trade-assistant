//! Granite-TTM r2 (`ibm-granite/granite-timeseries-ttm-r2`), a lightweight
//! close-only foundation forecaster, run through three fixed-shape ONNX
//! graphs exported offline (see
//! `docs/superpowers/spikes/2026-07-20-ttm-onnx-feasibility.md`) and loaded
//! once here via `ort`, on top of the shared `forecast::framework`
//! scaffolding.
//!
//! ## Why three graphs, not one
//! IBM ships `ttm-r2` as separate checkpoints per `(context_length,
//! prediction_length)` pair -- `512-96`, `1024-96`, `1536-96` -- each
//! naturally fixed-shape (no `dynamic_axes` question, unlike Kronos's
//! autoregressive loop). All three share `prediction_length=96`, so running
//! the same trailing close history through whichever checkpoints fit
//! compares forecasts at the same horizon despite differing context, which
//! is what makes an ensemble meaningful here (spike doc §8).
//!
//! ## Normalization is in-graph
//! `TinyTimeMixerStdScaler` (population-variance RevIN, `1e-5` epsilon
//! inside the sqrt) is baked into each exported graph -- applied once at the
//! start of the traced forward pass, reversed once at the end (spike doc
//! §5). `ort` feeds raw closes in (`past_values`) and reads raw,
//! already-denormalized closes out (`forecast`); `ttm_math` has no scaler
//! math to replicate.
//!
//! ## Degrade-gracefully with less history
//! The exported graphs have no in-graph padding/truncation for a shorter
//! context (spike doc §8), so each checkpoint must be fed exactly its own
//! `context_length` bars. `ttm_math::available_checkpoints` drops whichever
//! checkpoints exceed available history rather than padding/faking it,
//! shrinking the ensemble's conviction denominator accordingly -- e.g. only
//! 512+1024 bars available means "2/2 agree", not "2/3 with the missing
//! checkpoint silently treated as absent".

use std::sync::{Arc, OnceLock};

use ort::value::TensorRef;

use crate::forecast::assets::assets_base_dir;
use crate::forecast::framework::{ForecastSummary, ForecasterAdapter, ForecasterSessions};
use crate::forecast::ttm_math::{
    assemble_input, available_checkpoints, ensemble_summary, extract_forecast, forecast_return, CheckpointResult,
    PRED_LEN, REQUIRED_LOOKBACK,
};
use crate::{Horizon, MarketContext};

fn session_name(context_len: usize) -> &'static str {
    match context_len {
        512 => "ttm_512",
        1024 => "ttm_1024",
        1536 => "ttm_1536",
        other => panic!("ttm: no session for context length {other}"),
    }
}

// `registry::all()` re-invokes every `AlgorithmFactory` closure -- including
// `TtmAdapter::new` -- on every call, but the three on-disk graphs must be
// parsed AT MOST ONCE per process. `ort::Session` isn't `Clone`, so the
// loaded sessions are parked behind a process-wide singleton and shared via
// `Arc` rather than reloaded or cloned -- same pattern as `KronosSessions`.
static SESSIONS: OnceLock<Arc<ForecasterSessions>> = OnceLock::new();

fn shared_sessions() -> Arc<ForecasterSessions> {
    SESSIONS
        .get_or_init(|| {
            let base = assets_base_dir().join("ttm");
            Arc::new(ForecasterSessions::load_from_files(&[
                (session_name(512), base.join("ttm_512.onnx")),
                (session_name(1024), base.join("ttm_1024.onnx")),
                (session_name(1536), base.join("ttm_1536.onnx")),
            ]))
        })
        .clone()
}

pub struct TtmAdapter {
    sessions: Arc<ForecasterSessions>,
}

impl TtmAdapter {
    /// Cheap: an `Arc` clone of the process-wide singleton, loading the
    /// three on-disk ONNX graphs only on the very first call across the
    /// process.
    pub fn new() -> Self {
        Self { sessions: shared_sessions() }
    }

    /// Runs one checkpoint's session on `closes`' trailing `context_len`
    /// bars, returning the full `PRED_LEN`-step forecast (raw close units,
    /// already denormalized in-graph). Split out from `run_checkpoint` so
    /// the fixture regression test below can assert the full reconstructed
    /// forecast, not just the single return `run_checkpoint` derives from
    /// it.
    fn run_session(&self, closes: &[f64], context_len: usize) -> Vec<f64> {
        let input = assemble_input(closes, context_len);

        let input_tensor = TensorRef::from_array_view(([1i64, context_len as i64, 1i64], input.as_slice()))
            .unwrap_or_else(|e| panic!("ttm: building past_values input for context {context_len}: {e}"));

        let mut guard = self.sessions.get(session_name(context_len)).lock().unwrap();
        let outputs = guard
            .run(ort::inputs!["past_values" => input_tensor])
            .unwrap_or_else(|e| panic!("ttm: inference failed for context {context_len}: {e}"));
        let (_, raw) = outputs["forecast"]
            .try_extract_tensor::<f32>()
            .unwrap_or_else(|e| panic!("ttm: extracting forecast for context {context_len}: {e}"));

        extract_forecast(raw)
    }

    /// One checkpoint's `forecast_return` at the final (`t+PRED_LEN`) step
    /// relative to the window's last close -- the ensemble's per-checkpoint
    /// contribution.
    fn run_checkpoint(&self, closes: &[f64], context_len: usize) -> CheckpointResult {
        let last_close = *closes.last().expect("ttm: run_checkpoint called with empty closes");
        let forecast = self.run_session(closes, context_len);
        let ret = forecast_return(last_close, forecast[PRED_LEN - 1]);
        CheckpointResult { context_len, forecast_return: ret }
    }
}

impl Default for TtmAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ForecasterAdapter for TtmAdapter {
    fn id(&self) -> &'static str {
        "ttm"
    }

    fn required_lookback(&self) -> usize {
        REQUIRED_LOOKBACK
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn forecast(&self, ctx: &MarketContext) -> Option<ForecastSummary> {
        let checkpoints = available_checkpoints(ctx.closes.len());
        if checkpoints.is_empty() {
            return None;
        }

        let results: Vec<CheckpointResult> =
            checkpoints.iter().map(|&context_len| self.run_checkpoint(&ctx.closes, context_len)).collect();

        let summary = ensemble_summary(&results);

        let mut evidence: Vec<String> = results
            .iter()
            .map(|r| {
                format!(
                    "ttm_{} forecast over {} bars ({:+.3}%)",
                    r.context_len,
                    PRED_LEN,
                    r.forecast_return * 100.0
                )
            })
            .collect();
        evidence.push(format!(
            "TTM ensemble ({}/{} checkpoints): directional agreement {:.2}, mean return {:+.3}%, return dispersion {:.3}%",
            (summary.conviction * results.len() as f64).round() as usize,
            results.len(),
            summary.conviction,
            summary.mean_return * 100.0,
            summary.dispersion * 100.0,
        ));

        Some(ForecastSummary { forecast_return: summary.mean_return, conviction: summary.conviction, evidence })
    }
}

#[cfg(feature = "ttm")]
inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(crate::forecast::framework::ForecastAlgorithm::new(TtmAdapter::new())))
}

// Per-checkpoint fixture regression (unit tests, not `tests/ttm_test.rs`):
// `TtmAdapter::run_session` is crate-private, so exact-graph-output
// assertions live here rather than in the integration test, which only sees
// the public `Algorithm`/`AlgoOutput` surface.
#[cfg(test)]
mod tests {
    use super::*;

    const CONTEXT_CSV: &str = include_str!("../../tests/fixtures/ttm_context.csv");
    const EXPECTED_512_CSV: &str = include_str!("../../tests/fixtures/ttm_expected_512.csv");
    const EXPECTED_1024_CSV: &str = include_str!("../../tests/fixtures/ttm_expected_1024.csv");
    const EXPECTED_1536_CSV: &str = include_str!("../../tests/fixtures/ttm_expected_1536.csv");

    const MAX_REL_ERR: f64 = 1e-3;

    fn parse_second_column(csv: &str) -> Vec<f64> {
        csv.lines()
            .skip(1)
            .filter(|line| !line.trim().is_empty())
            .map(|line| line.split(',').nth(1).unwrap().parse().unwrap())
            .collect()
    }

    fn assert_matches_fixture(context_len: usize, expected_csv: &str) {
        let closes = parse_second_column(CONTEXT_CSV);
        let expected = parse_second_column(expected_csv);
        assert_eq!(expected.len(), PRED_LEN);

        let adapter = TtmAdapter::new();
        let got = adapter.run_session(&closes, context_len);
        assert_eq!(got.len(), PRED_LEN);

        let mut max_rel_err = 0.0f64;
        for (i, (&g, &w)) in got.iter().zip(expected.iter()).enumerate() {
            let rel_err = (g - w).abs() / (w.abs() + 1e-9);
            max_rel_err = max_rel_err.max(rel_err);
            assert!(
                rel_err < MAX_REL_ERR,
                "ttm_{context_len} step {i}: got {g} want {w} rel_err {rel_err:.3e} (limit {MAX_REL_ERR:e})"
            );
        }
        assert!(max_rel_err < MAX_REL_ERR, "ttm_{context_len}: max_rel_err {max_rel_err:.3e}");
    }

    #[test]
    fn ttm_512_reconstructed_forecast_matches_committed_fixture() {
        assert_matches_fixture(512, EXPECTED_512_CSV);
    }

    #[test]
    fn ttm_1024_reconstructed_forecast_matches_committed_fixture() {
        assert_matches_fixture(1024, EXPECTED_1024_CSV);
    }

    #[test]
    fn ttm_1536_reconstructed_forecast_matches_committed_fixture() {
        assert_matches_fixture(1536, EXPECTED_1536_CSV);
    }
}
