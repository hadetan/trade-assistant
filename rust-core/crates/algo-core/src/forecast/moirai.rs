//! Moirai-2.0-R-small (`Salesforce/moirai-2.0-R-small`), a decoder-only
//! quantile-forecasting foundation model, run through ONE fixed-shape ONNX
//! graph exported offline (see
//! docs/superpowers/spikes/2026-07-20-moirai-onnx-feasibility.md) and loaded
//! once here via `ort`.
//!
//! Unlike Kronos, there is no scaler to replicate in Rust: `PackedStdScaler`
//! normalize/denormalize runs entirely inside the traced graph (confirmed
//! empirically against the model's own internals -- spike section 6), so
//! `forecast()` feeds the raw, unnormalized 512-close context window
//! straight through and reads the `[1,4,9,16]` quantile output directly in
//! raw-price units -- no pre/post-processing scaler math lives in this
//! crate at all for this model.
//!
//! Only the one-forward-pass path is used: `num_predict_token(4) *
//! patch_size(16) = 64` raw future steps come out of a single call, because
//! Moirai 2.0's multi-token prediction head regresses all four future
//! patches directly (not autoregressively) -- the recursive multi-quantile
//! decode loop upstream's GluonTS-facing wrapper needs for longer horizons
//! is out of scope here (spike sections 3e/9).
//!
//! Model weights are CC-BY-NC-4.0 (the `uni2ts` code itself is Apache-2.0);
//! accepted for personal/non-commercial use per this project's decision,
//! restated in the spike doc.

use std::sync::{Arc, OnceLock};

use ort::value::TensorRef;

use crate::forecast::assets::assets_base_dir;
use crate::forecast::framework::{
    conviction_from_quantile_spread, ForecastSummary, ForecasterAdapter, ForecasterSessions,
};
use crate::forecast::moirai_math::{
    build_context_input, recent_volatility, target_quantiles, CONTEXT_LEN, TARGET_RAW_STEP,
};
use crate::{Horizon, MarketContext};

const SESSION_NAME: &str = "moirai";

/// The model's own reconstructed `[1, NUM_PREDICT_TOKEN, NUM_QUANTILES,
/// PATCH_SIZE]` quantile forecast (flattened, row-major), ahead of this
/// adapter's `ForecastSummary` summarization. Exposed beyond
/// `ForecasterAdapter::forecast` (which only returns the single
/// direction/magnitude/conviction summary) so this module's own regression
/// test can assert against the checkpoint's full per-quantile forecast
/// numbers.
pub struct MoiraiForecast {
    pub quantile_forecast: Vec<f32>,
    /// The last real close in the context window -- the anchor
    /// `forecast_return` is measured against.
    pub latest_close: f64,
}

// `registry::all()` re-invokes every `AlgorithmFactory` closure -- including
// `MoiraiAdapter::new` -- on every call, but the ~44MB graph must be parsed
// AT MOST ONCE per process. `ort::Session` isn't `Clone`, so the loaded
// bundle is parked behind a process-wide singleton and shared via `Arc`,
// mirroring `KronosSessions`/`kronos.rs`'s own pattern (a separate singleton
// per model, no cross-model sharing).
static SESSIONS: OnceLock<Arc<ForecasterSessions>> = OnceLock::new();

fn shared_sessions() -> Arc<ForecasterSessions> {
    SESSIONS
        .get_or_init(|| {
            let path = assets_base_dir().join("moirai").join("moirai_2_small.onnx");
            Arc::new(ForecasterSessions::load_from_files(&[(SESSION_NAME, path)]))
        })
        .clone()
}

pub struct MoiraiAdapter {
    sessions: Arc<ForecasterSessions>,
}

impl MoiraiAdapter {
    /// Cheap: an `Arc` clone of the process-wide singleton, loading the
    /// on-disk ONNX graph only on the very first call across the process.
    pub fn new() -> Self {
        Self { sessions: shared_sessions() }
    }

    /// Runs the single forward pass against `ctx`'s most recent
    /// `CONTEXT_LEN` closes. `None` when there isn't enough history --
    /// the no-op guard `forecast()` also relies on.
    pub fn raw_forecast(&self, ctx: &MarketContext) -> Option<MoiraiForecast> {
        let input = build_context_input(&ctx.closes)?;
        let latest_close = *ctx.closes.last()?;

        let input_tensor = TensorRef::from_array_view(([1i64, CONTEXT_LEN as i64], input.as_slice()))
            .expect("moirai: building closes input");

        let mut guard = self.sessions.get(SESSION_NAME).lock().unwrap();
        let outputs =
            guard.run(ort::inputs!["closes" => input_tensor]).expect("moirai: inference failed");
        let (_, quantile_forecast) = outputs["quantile_forecast"]
            .try_extract_tensor::<f32>()
            .expect("moirai: extracting quantile_forecast");

        Some(MoiraiForecast { quantile_forecast: quantile_forecast.to_vec(), latest_close })
    }
}

impl Default for MoiraiAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ForecasterAdapter for MoiraiAdapter {
    fn id(&self) -> &'static str {
        "moirai"
    }

    fn required_lookback(&self) -> usize {
        CONTEXT_LEN
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn forecast(&self, ctx: &MarketContext) -> Option<ForecastSummary> {
        let raw = self.raw_forecast(ctx)?;
        let q = target_quantiles(&raw.quantile_forecast, TARGET_RAW_STEP);

        let forecast_return = if raw.latest_close.abs() < 1e-12 {
            0.0
        } else {
            (q.q50 - raw.latest_close) / raw.latest_close
        };

        let context_start = ctx.closes.len() - CONTEXT_LEN;
        let recent_vol = recent_volatility(&ctx.closes[context_start..]);
        let conviction = conviction_from_quantile_spread(q.q10, q.q90, q.q50, recent_vol);

        Some(ForecastSummary {
            forecast_return,
            conviction,
            evidence: vec![format!(
                "Moirai-2.0-R-small quantile forecast, close {:.6} -> q50 {:.6} ({:+.4}%) [q10 {:.6}, q90 {:.6}]",
                raw.latest_close,
                q.q50,
                forecast_return * 100.0,
                q.q10,
                q.q90
            )],
        })
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(crate::forecast::framework::ForecastAlgorithm::new(MoiraiAdapter::new())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, Utc};
    use crate::Timeframe;

    const CONTEXT_CSV: &str = include_str!("../../tests/fixtures/moirai_context_512.csv");
    const EXPECTED_QUANTILES_CSV: &str =
        include_str!("../../tests/fixtures/moirai_expected_quantiles.csv");

    const MAX_REL_ERR: f64 = 1e-3;

    fn load_context_closes() -> Vec<f64> {
        CONTEXT_CSV
            .lines()
            .skip(1)
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.trim().parse().unwrap())
            .collect()
    }

    /// The fixture's 576 `(predict_token, quantile_level, patch_offset,
    /// raw_step, value)` rows, already emitted in the same row-major
    /// (predict_token, quantile, patch_offset) order the ONNX graph's
    /// flattened output uses -- so `expected[i]` lines up directly with
    /// `quantile_forecast[i]`.
    fn load_expected_quantiles_flat() -> Vec<f64> {
        EXPECTED_QUANTILES_CSV
            .lines()
            .skip(1)
            .filter(|l| !l.trim().is_empty())
            .map(|line| line.split(',').next_back().unwrap().parse().unwrap())
            .collect()
    }

    #[test]
    fn raw_forecast_matches_the_committed_regression_fixture_across_the_full_quantile_tensor() {
        let closes = load_context_closes();
        assert_eq!(closes.len(), 512);
        let as_of: DateTime<Utc> = "2024-01-01T00:00:00Z".parse().unwrap();
        let ctx = MarketContext::from_closes("NSE:MOIRAI_FIXTURE", Timeframe::FiveMinute, Horizon::Intraday, closes, as_of);

        let adapter = MoiraiAdapter::new();
        let forecast = adapter.raw_forecast(&ctx).expect("512-bar fixture must clear the length guard");

        let expected = load_expected_quantiles_flat();
        assert_eq!(expected.len(), 4 * 9 * 16);
        assert_eq!(forecast.quantile_forecast.len(), expected.len());

        let mut max_rel_err = 0.0f64;
        for (i, (&got, &want)) in forecast.quantile_forecast.iter().zip(expected.iter()).enumerate() {
            let got = got as f64;
            let rel_err = (got - want).abs() / (want.abs() + 1e-9);
            max_rel_err = max_rel_err.max(rel_err);
            assert!(rel_err < MAX_REL_ERR, "quantile row {i}: got {got} want {want} rel_err {rel_err:.3e}");
        }
        assert!(max_rel_err < MAX_REL_ERR, "max_rel_err {max_rel_err:.3e} must clear {MAX_REL_ERR:e}");

        assert!((forecast.latest_close - 10.93).abs() < 1e-9);
    }

    #[test]
    fn forecast_direction_and_conviction_match_the_spike_doc_worked_example() {
        let closes = load_context_closes();
        let as_of: DateTime<Utc> = "2024-01-01T00:00:00Z".parse().unwrap();
        let ctx = MarketContext::from_closes("NSE:MOIRAI_FIXTURE", Timeframe::FiveMinute, Horizon::Intraday, closes, as_of);

        let adapter = MoiraiAdapter::new();
        let summary = adapter.forecast(&ctx).expect("512-bar fixture must clear the length guard");

        // Spike section 6: q10=10.9014, q50=10.9256, q90=10.9483,
        // last_close=10.93 -> down, magnitude ~0.041%.
        assert!(summary.forecast_return < 0.0);
        assert!((summary.forecast_return.abs() - 0.0004055236090461771).abs() < 1e-3 * 0.0004055236090461771 + 1e-9);
        assert!(summary.conviction > 0.0 && summary.conviction <= 1.0);
    }

    #[test]
    fn forecast_returns_none_below_the_required_context_length() {
        let as_of: DateTime<Utc> = "2020-01-01T00:00:00Z".parse().unwrap();
        let ctx = MarketContext::from_closes("NSE:TEST", Timeframe::Day, Horizon::Positional, vec![100.0; 10], as_of);

        let adapter = MoiraiAdapter::new();
        assert!(adapter.forecast(&ctx).is_none());
        assert!(adapter.raw_forecast(&ctx).is_none());
    }
}
