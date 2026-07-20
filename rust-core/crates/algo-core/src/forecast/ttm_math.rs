//! Pure math for the TTM ensemble: input-window assembly, forecast-return
//! extraction from a session's raw output, and ensemble directional-
//! agreement conviction across whichever of the {512,1024,1536} checkpoints
//! fit available history.
//!
//! Normalization is NOT replicated here. The spike doc confirms
//! `TinyTimeMixerStdScaler` is baked into the exported ONNX graph (in-graph
//! elementwise RevIN, applied once and reversed once inside the traced
//! computation -- see
//! docs/superpowers/spikes/2026-07-20-ttm-onnx-feasibility.md §5), so `ort`
//! feeds raw closes in (`past_values`) and reads raw, already-denormalized
//! closes out (`forecast`) -- there is no scaler math for Rust to reproduce.

/// All three checkpoints share this prediction length (`ttm-r2`'s
/// `96`-step head), which is what makes ensembling across differing context
/// lengths an apples-to-apples comparison at the same horizon.
pub const PRED_LEN: usize = 96;

/// Ascending so `available_checkpoints` naturally yields ascending order.
pub const CONTEXT_LENGTHS: [usize; 3] = [512, 1024, 1536];

/// The smallest checkpoint's context length -- the minimum history the
/// ensemble needs to produce any opinion at all (Q3 decision, task brief).
pub const REQUIRED_LOOKBACK: usize = CONTEXT_LENGTHS[0];

/// Which of the three fixed context lengths this much history can run,
/// ascending. Degrade-gracefully policy from the spike doc §8: drop
/// checkpoints whose `context_length` exceeds available history rather than
/// padding/faking it, shrinking the ensemble (and its conviction
/// denominator) instead.
pub fn available_checkpoints(history_len: usize) -> Vec<usize> {
    CONTEXT_LENGTHS.iter().copied().filter(|&ctx| ctx <= history_len).collect()
}

/// The trailing `context_len` closes, cast to the `f32` the ONNX graph's
/// `past_values` input expects (shape `[1, context_len, 1]`), matching
/// `KronosPredictor`'s own truncate-to-context-length convention.
pub fn assemble_input(closes: &[f64], context_len: usize) -> Vec<f32> {
    let start = closes.len() - context_len;
    closes[start..].iter().map(|&c| c as f32).collect()
}

/// Casts a session's flat `forecast` output (`[1, PRED_LEN, 1]`, already
/// denormalized in-graph) to `f64`. Panics on a length mismatch: every
/// checkpoint's graph is a fixed shape, so a wrong length here is a
/// packaging/wiring bug, not a runtime condition a caller could recover
/// from.
pub fn extract_forecast(raw_output: &[f32]) -> Vec<f64> {
    assert_eq!(
        raw_output.len(),
        PRED_LEN,
        "ttm_math: expected {PRED_LEN} forecast steps, got {}",
        raw_output.len()
    );
    raw_output.iter().map(|&v| v as f64).collect()
}

/// Fractional return from `last_close` to a forecast value, guarded against
/// a zero/near-zero anchor the same way `relative_magnitude`/
/// `classify_by_distance` guard theirs in `algorithm.rs`.
pub fn forecast_return(last_close: f64, forecast_value: f64) -> f64 {
    if last_close.abs() < 1e-12 {
        return 0.0;
    }
    (forecast_value - last_close) / last_close
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sign {
    Up,
    Down,
    Flat,
}

pub fn sign_of(x: f64) -> Sign {
    if x > 0.0 {
        Sign::Up
    } else if x < 0.0 {
        Sign::Down
    } else {
        Sign::Flat
    }
}

/// One checkpoint's contribution to the ensemble, ahead of aggregation.
#[derive(Debug, Clone, Copy)]
pub struct CheckpointResult {
    pub context_len: usize,
    pub forecast_return: f64,
}

/// Ensemble directional agreement (spike doc §8): the fraction of
/// checkpoints sharing the majority `Sign`, the mean return across
/// checkpoints (this ensemble's headline `forecast_return`), and the
/// per-checkpoint return dispersion -- a secondary "how much do they agree
/// on magnitude" signal alongside the primary direction-agreement
/// conviction.
#[derive(Debug, Clone, Copy)]
pub struct EnsembleSummary {
    pub mean_return: f64,
    pub conviction: f64,
    pub dispersion: f64,
}

/// Panics on an empty slice: callers only invoke this after running at
/// least one checkpoint (an empty ensemble means the no-op guard should
/// have fired instead, same contract as `Kronos`'s history-length guard).
pub fn ensemble_summary(results: &[CheckpointResult]) -> EnsembleSummary {
    assert!(!results.is_empty(), "ttm_math: ensemble_summary requires at least one checkpoint result");

    let n = results.len();
    let (up, down, flat) = results.iter().fold((0, 0, 0), |(u, d, f), r| match sign_of(r.forecast_return) {
        Sign::Up => (u + 1, d, f),
        Sign::Down => (u, d + 1, f),
        Sign::Flat => (u, d, f + 1),
    });
    let majority = up.max(down).max(flat);
    let conviction = majority as f64 / n as f64;

    let mean_return = results.iter().map(|r| r.forecast_return).sum::<f64>() / n as f64;
    let variance = results.iter().map(|r| (r.forecast_return - mean_return).powi(2)).sum::<f64>() / n as f64;

    EnsembleSummary { mean_return, conviction, dispersion: variance.sqrt() }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Hand values below are the spike doc's own demonstrated ensemble run
    // (docs/superpowers/spikes/2026-07-20-ttm-onnx-feasibility.md §8) on its
    // committed synthetic fixture: last_close 2202.3250, forecast[t+96] per
    // checkpoint 2048.1194 (512) / 2122.7329 (1024) / 2181.9258 (1536).

    const LAST_CLOSE: f64 = 2202.324892;
    const FORECAST_512: f64 = 2048.119385;
    const FORECAST_1024: f64 = 2122.732910;
    const FORECAST_1536: f64 = 2181.925781;

    #[test]
    fn available_checkpoints_drops_context_lengths_exceeding_history() {
        assert_eq!(available_checkpoints(0), Vec::<usize>::new());
        assert_eq!(available_checkpoints(511), Vec::<usize>::new());
        assert_eq!(available_checkpoints(512), vec![512]);
        assert_eq!(available_checkpoints(1023), vec![512]);
        assert_eq!(available_checkpoints(1024), vec![512, 1024]);
        assert_eq!(available_checkpoints(1535), vec![512, 1024]);
        assert_eq!(available_checkpoints(1536), vec![512, 1024, 1536]);
        assert_eq!(available_checkpoints(5000), vec![512, 1024, 1536]);
    }

    #[test]
    fn assemble_input_takes_the_trailing_context_len_closes() {
        let closes: Vec<f64> = (0..10).map(|i| i as f64).collect();
        let input = assemble_input(&closes, 3);
        assert_eq!(input, vec![7.0f32, 8.0, 9.0]);
    }

    #[test]
    fn extract_forecast_casts_f32_output_to_f64() {
        let raw: Vec<f32> = vec![1.5; PRED_LEN];
        let forecast = extract_forecast(&raw);
        assert_eq!(forecast.len(), PRED_LEN);
        assert!((forecast[0] - 1.5).abs() < 1e-12);
    }

    #[test]
    #[should_panic(expected = "expected 96 forecast steps")]
    fn extract_forecast_panics_on_wrong_length() {
        extract_forecast(&[1.0, 2.0, 3.0]);
    }

    #[test]
    fn forecast_return_matches_spike_hand_values() {
        let r512 = forecast_return(LAST_CLOSE, FORECAST_512);
        let r1024 = forecast_return(LAST_CLOSE, FORECAST_1024);
        let r1536 = forecast_return(LAST_CLOSE, FORECAST_1536);

        assert!((r512 - (-0.07001941791611013)).abs() < 1e-9, "512 return: {r512}");
        assert!((r1024 - (-0.03613998202041841)).abs() < 1e-9, "1024 return: {r1024}");
        assert!((r1536 - (-0.009262534821315626)).abs() < 1e-9, "1536 return: {r1536}");
    }

    #[test]
    fn forecast_return_guards_zero_anchor() {
        assert_eq!(forecast_return(0.0, 100.0), 0.0);
    }

    #[test]
    fn sign_of_classifies_positive_negative_and_zero() {
        assert_eq!(sign_of(0.01), Sign::Up);
        assert_eq!(sign_of(-0.01), Sign::Down);
        assert_eq!(sign_of(0.0), Sign::Flat);
    }

    #[test]
    fn ensemble_summary_matches_spike_unanimous_down_example() {
        let results = vec![
            CheckpointResult { context_len: 512, forecast_return: forecast_return(LAST_CLOSE, FORECAST_512) },
            CheckpointResult { context_len: 1024, forecast_return: forecast_return(LAST_CLOSE, FORECAST_1024) },
            CheckpointResult { context_len: 1536, forecast_return: forecast_return(LAST_CLOSE, FORECAST_1536) },
        ];

        let summary = ensemble_summary(&results);

        assert_eq!(summary.conviction, 1.0, "spike doc: 3/3 agree on direction -> conviction 1.00");
        assert!((summary.mean_return - (-0.03847397825261472)).abs() < 1e-9, "mean: {}", summary.mean_return);
        // Spike doc §8: "Magnitude dispersion (std of the three returns): 2.49%".
        assert!((summary.dispersion - 0.024858739102611535).abs() < 1e-9, "dispersion: {}", summary.dispersion);
    }

    #[test]
    fn ensemble_summary_conviction_is_fraction_of_majority_sign() {
        let results = vec![
            CheckpointResult { context_len: 512, forecast_return: 0.02 },
            CheckpointResult { context_len: 1024, forecast_return: 0.01 },
            CheckpointResult { context_len: 1536, forecast_return: -0.05 },
        ];

        let summary = ensemble_summary(&results);

        assert!((summary.conviction - (2.0 / 3.0)).abs() < 1e-12);
    }

    #[test]
    fn ensemble_summary_handles_single_checkpoint() {
        let results = vec![CheckpointResult { context_len: 512, forecast_return: -0.07 }];

        let summary = ensemble_summary(&results);

        assert_eq!(summary.conviction, 1.0);
        assert_eq!(summary.dispersion, 0.0);
        assert!((summary.mean_return - (-0.07)).abs() < 1e-12);
    }

    #[test]
    #[should_panic(expected = "requires at least one checkpoint result")]
    fn ensemble_summary_panics_on_empty_results() {
        ensemble_summary(&[]);
    }
}
