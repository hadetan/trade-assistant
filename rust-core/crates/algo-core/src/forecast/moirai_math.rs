//! Pure numeric helpers for the Moirai-2.0-R-small ONNX forecaster: context
//! input assembly, `[1,4,9,16]` quantile-output extraction, and the
//! `recent_vol` input the shared `conviction_from_quantile_spread` needs.
//!
//! Unlike `kronos_math`, there is no scaler to replicate here:
//! `PackedStdScaler` normalize/denormalize runs entirely inside the traced
//! ONNX graph (confirmed empirically against the model's own internals --
//! see docs/superpowers/spikes/2026-07-20-moirai-onnx-feasibility.md section
//! 6). The graph's only input is the raw, unnormalized close-price window,
//! and its quantile output is already denormalized to raw-price units.

/// The graph's fixed context width (`max_seq_len`, 512/16 = 32 patches).
pub const CONTEXT_LEN: usize = 512;
/// `num_predict_token`: direct-regression future patches per forward pass.
pub const NUM_PREDICT_TOKEN: usize = 4;
/// Fixed quantile levels `[0.1, 0.2, ..., 0.9]`.
pub const NUM_QUANTILES: usize = 9;
/// Raw bars per predicted patch.
pub const PATCH_SIZE: usize = 16;
/// `NUM_PREDICT_TOKEN * PATCH_SIZE`: total raw future steps one forward pass
/// covers.
pub const RAW_STEPS: usize = NUM_PREDICT_TOKEN * PATCH_SIZE;

pub const Q10_IDX: usize = 0;
/// `quantile_levels[4] == 0.5` -- the median, in the spike's fixed
/// `[0.1..0.9]` layout.
pub const Q50_IDX: usize = 4;
pub const Q90_IDX: usize = 8;

/// One-step-ahead (`raw_step` 0): the nearest, least-stale directional call
/// this single forward pass supports, and the exact step the spike's own
/// worked example (section 6) and this crate's fixture test are anchored
/// to.
pub const TARGET_RAW_STEP: usize = 0;

/// Builds the graph's `closes` input: the most recent `CONTEXT_LEN` raw
/// close prices, oldest-first (matching `MarketContext.closes`'s own
/// convention, most-recent-last). `None` when there isn't enough history --
/// the caller's no-op guard.
pub fn build_context_input(closes: &[f64]) -> Option<Vec<f32>> {
    if closes.len() < CONTEXT_LEN {
        return None;
    }
    let start = closes.len() - CONTEXT_LEN;
    Some(closes[start..].iter().map(|&c| c as f32).collect())
}

/// Reads one quantile level's value at `raw_step` out of the graph's
/// flattened `[1, NUM_PREDICT_TOKEN, NUM_QUANTILES, PATCH_SIZE]` output
/// (row-major: predict_token, quantile, patch_offset -- see spike section
/// 6).
pub fn quantile_at(output: &[f32], raw_step: usize, quantile_idx: usize) -> f64 {
    assert!(raw_step < RAW_STEPS, "moirai: raw_step {raw_step} out of range");
    assert!(quantile_idx < NUM_QUANTILES, "moirai: quantile_idx {quantile_idx} out of range");
    let predict_token_idx = raw_step / PATCH_SIZE;
    let patch_offset = raw_step % PATCH_SIZE;
    let idx = predict_token_idx * (NUM_QUANTILES * PATCH_SIZE) + quantile_idx * PATCH_SIZE + patch_offset;
    output[idx] as f64
}

/// The three quantile levels `conviction_from_quantile_spread` and the
/// direction/magnitude mapping need, all read at the same `raw_step`.
pub struct TargetQuantiles {
    pub q10: f64,
    pub q50: f64,
    pub q90: f64,
}

pub fn target_quantiles(output: &[f32], raw_step: usize) -> TargetQuantiles {
    TargetQuantiles {
        q10: quantile_at(output, raw_step, Q10_IDX),
        q50: quantile_at(output, raw_step, Q50_IDX),
        q90: quantile_at(output, raw_step, Q90_IDX),
    }
}

/// Sample stdev (Bessel-corrected, `ddof=1`) of simple bar-over-bar returns
/// across `closes` -- the `recent_vol` scale term
/// `conviction_from_quantile_spread` needs to turn an absolute quantile
/// spread into a dimensionless ratio. Zero-price steps are skipped (a
/// non-issue for real market data) rather than propagating a division
/// blow-up into the sample; fewer than two valid returns yields `0.0`
/// (no volatility signal), same guard convention as
/// `classify_by_distance`'s zero-baseline case in `algorithm.rs`.
pub fn recent_volatility(closes: &[f64]) -> f64 {
    let returns: Vec<f64> =
        closes.windows(2).filter(|w| w[0].abs() > 1e-12).map(|w| (w[1] - w[0]) / w[0]).collect();
    if returns.len() < 2 {
        return 0.0;
    }
    let n = returns.len() as f64;
    let mean = returns.iter().sum::<f64>() / n;
    let var = returns.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / (n - 1.0);
    var.sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_context_input_returns_none_below_context_len() {
        let closes = vec![1.0; CONTEXT_LEN - 1];
        assert!(build_context_input(&closes).is_none());
    }

    #[test]
    fn build_context_input_keeps_full_window_at_exact_len() {
        let closes: Vec<f64> = (0..CONTEXT_LEN).map(|i| i as f64).collect();
        let input = build_context_input(&closes).unwrap();
        assert_eq!(input.len(), CONTEXT_LEN);
        assert_eq!(input[0], 0.0);
        assert_eq!(input[CONTEXT_LEN - 1], (CONTEXT_LEN - 1) as f32);
    }

    #[test]
    fn build_context_input_takes_the_most_recent_window_when_longer() {
        let closes: Vec<f64> = (0..CONTEXT_LEN + 10).map(|i| i as f64).collect();
        let input = build_context_input(&closes).unwrap();
        assert_eq!(input.len(), CONTEXT_LEN);
        // Oldest 10 closes must be dropped -- the window is right-aligned to
        // the most recent CONTEXT_LEN bars, not the first CONTEXT_LEN.
        assert_eq!(input[0], 10.0);
        assert_eq!(input[CONTEXT_LEN - 1], (CONTEXT_LEN + 9) as f32);
    }

    fn synthetic_output() -> Vec<f32> {
        (0..(NUM_PREDICT_TOKEN * NUM_QUANTILES * PATCH_SIZE) as u32).map(|i| i as f32).collect()
    }

    #[test]
    fn quantile_at_reads_the_first_predict_token_first_patch_offset() {
        let output = synthetic_output();
        // predict_token 0, quantile_idx 0, patch_offset 0 -> flat index 0.
        assert_eq!(quantile_at(&output, 0, 0), 0.0);
    }

    #[test]
    fn quantile_at_crosses_predict_token_boundary_at_raw_step_16() {
        let output = synthetic_output();
        // raw_step 16 == predict_token 1, patch_offset 0 -> flat index
        // 1 * (9*16) + 0*16 + 0 == 144.
        assert_eq!(quantile_at(&output, 16, 0), 144.0);
    }

    #[test]
    fn quantile_at_reads_the_last_raw_step_and_last_quantile() {
        let output = synthetic_output();
        // raw_step 63 == predict_token 3, patch_offset 15; quantile_idx 8 ->
        // flat index 3*(9*16) + 8*16 + 15 == 432 + 128 + 15 == 575 (the last
        // element of a 576-long buffer).
        assert_eq!(quantile_at(&output, 63, 8), 575.0);
    }

    #[test]
    fn target_quantiles_bundles_q10_q50_q90_at_the_same_raw_step() {
        let output = synthetic_output();
        let q = target_quantiles(&output, 0);
        assert_eq!(q.q10, quantile_at(&output, 0, Q10_IDX));
        assert_eq!(q.q50, quantile_at(&output, 0, Q50_IDX));
        assert_eq!(q.q90, quantile_at(&output, 0, Q90_IDX));
        // Q50_IDX == 4 is quantile_levels[4] == 0.5 in the spike's fixed
        // [0.1..0.9] layout -- the median, not an arbitrary midpoint.
        assert_eq!(Q50_IDX, 4);
    }

    #[test]
    fn recent_volatility_matches_hand_derived_sample_stdev_of_returns() {
        let closes = vec![100.0, 101.0, 99.0, 100.5];
        let vol = recent_volatility(&closes);
        assert!((vol - 0.018869918606207677).abs() < 1e-9);
    }

    #[test]
    fn recent_volatility_is_zero_with_fewer_than_two_returns() {
        assert_eq!(recent_volatility(&[]), 0.0);
        assert_eq!(recent_volatility(&[100.0]), 0.0);
        assert_eq!(recent_volatility(&[100.0, 101.0]), 0.0);
    }
}
