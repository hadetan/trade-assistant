//! Chronos-Bolt-small (`amazon/chronos-bolt-small`), a univariate T5
//! encoder-decoder forecaster, run through the single fixed-shape ONNX graph
//! exported offline (see
//! `docs/superpowers/spikes/2026-07-20-chronos-onnx-feasibility.md`) and
//! loaded once here via `ort`, plugged into the shared
//! `forecast::framework::ForecasterAdapter` scaffolding.
//!
//! ## Why no normalize/denormalize step
//! Unlike Kronos's separate tokenizer/decode graphs, this export traces the
//! *entire* `model.forward()` -- RevIN-style instance-norm, the T5
//! encoder/decoder, and the norm's inverse -- into one graph (spike §3, §5).
//! `context` goes in as raw closes; `quantile_preds` comes out already
//! de-normalized to real price units. So, unlike `kronos_math`, there is no
//! scaler to replicate in `chronos_math.rs`.
//!
//! ## Fixed shapes, not `dynamic_axes`
//! `context_length=2048` and `prediction_length=64` are baked into the
//! graph's traced weight shapes (spike §6) -- re-exporting is the only way
//! to change either. Context windows shorter than 2048 real bars are
//! left-padded with `NaN` (`chronos_math::build_context`), the model's own
//! designed "insufficient history" handling, numerically validated in the
//! spike's second cross-validation scenario (§4) rather than assumed.

use std::sync::{Arc, OnceLock};

use ort::value::TensorRef;

use crate::forecast::chronos_math::{
    build_context, forecast_return, horizon_scaled_volatility, read_quantiles,
    recent_log_return_volatility, target_step, CONTEXT_LENGTH, NUM_QUANTILES, PREDICTION_LENGTH,
};
use crate::forecast::framework::{
    conviction_from_quantile_spread, ForecastSummary, ForecasterAdapter, ForecasterSessions,
};
use crate::{Horizon, MarketContext};

const CHRONOS_ONNX: &[u8] = include_bytes!("../../assets/chronos/chronos_bolt_small.onnx");
const SESSION_NAME: &str = "chronos";

// `registry::all()` re-invokes every `AlgorithmFactory` closure -- including
// `ChronosAdapter::new` -- on every call, but the ~191MB graph must be
// parsed AT MOST ONCE per process. `ort::Session` isn't `Clone`, so the
// loaded bundle is parked behind a process-wide singleton and shared via
// `Arc`, mirroring `kronos.rs`'s `KronosSessions` convention.
static SESSIONS: OnceLock<Arc<ForecasterSessions>> = OnceLock::new();

fn shared_sessions() -> Arc<ForecasterSessions> {
    SESSIONS
        .get_or_init(|| Arc::new(ForecasterSessions::load(&[(SESSION_NAME, CHRONOS_ONNX)])))
        .clone()
}

/// A single real close is enough to run the graph (the rest of the 2048-wide
/// context window is NaN-padded, per `chronos_math::build_context`), but
/// zero closes leaves no `last_close` to anchor a forecast return against.
const MIN_LOOKBACK: usize = 1;

pub struct ChronosAdapter {
    sessions: Arc<ForecasterSessions>,
}

impl ChronosAdapter {
    /// Cheap: an `Arc` clone of the process-wide singleton, loading the
    /// bundled ONNX graph only on the very first call across the process.
    pub fn new() -> Self {
        Self { sessions: shared_sessions() }
    }
}

impl Default for ChronosAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ForecasterAdapter for ChronosAdapter {
    fn id(&self) -> &'static str {
        "chronos"
    }

    fn required_lookback(&self) -> usize {
        MIN_LOOKBACK
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn forecast(&self, ctx: &MarketContext) -> Option<ForecastSummary> {
        if ctx.closes.len() < MIN_LOOKBACK {
            return None;
        }
        let last_close = *ctx.closes.last().expect("chronos: guarded non-empty above");

        let context = build_context(&ctx.closes);
        let context_tensor = TensorRef::from_array_view(([1i64, CONTEXT_LENGTH as i64], context.as_slice()))
            .expect("chronos: building context tensor");

        let raw: Vec<f32> = {
            let mut guard = self.sessions.get(SESSION_NAME).lock().unwrap();
            let outputs = guard
                .run(ort::inputs!["context" => context_tensor])
                .expect("chronos: inference failed");
            let (_, quantile_preds) = outputs["quantile_preds"]
                .try_extract_tensor::<f32>()
                .expect("chronos: extracting quantile_preds");
            debug_assert_eq!(quantile_preds.len(), NUM_QUANTILES * PREDICTION_LENGTH);
            quantile_preds.to_vec()
        };

        let step = target_step(ctx.horizon);
        let (q10, q50, q90) = read_quantiles(&raw, step);

        let ret = forecast_return(q50, last_close);
        let recent_vol = recent_log_return_volatility(&ctx.closes);
        let horizon_vol = horizon_scaled_volatility(recent_vol, step);
        let conviction = conviction_from_quantile_spread(q10, q90, q50, horizon_vol);

        Some(ForecastSummary {
            forecast_return: ret,
            conviction,
            evidence: vec![format!(
                "chronos-bolt-small step {step} ({:?} horizon): q10={q10:.6} q50={q50:.6} q90={q90:.6} last_close={last_close:.6} forecast_return={:+.6}",
                ctx.horizon, ret
            )],
        })
    }
}

#[cfg(feature = "chronos")]
inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(crate::forecast::framework::ForecastAlgorithm::new(ChronosAdapter::new())))
}
