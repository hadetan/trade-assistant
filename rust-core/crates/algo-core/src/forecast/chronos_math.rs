//! Pure Chronos-Bolt-small helpers: input-window assembly, quantile
//! extraction, and the forecast-return/volatility inputs `chronos.rs` feeds
//! into `framework::conviction_from_quantile_spread`.
//!
//! **No RevIN/normalize-denormalize math lives here.** The feasibility spike
//! (`docs/superpowers/spikes/2026-07-20-chronos-onnx-feasibility.md`, §5)
//! found the whole `model.forward()` -- including instance-norm and its
//! inverse -- exported into the ONNX graph itself, so `context` goes in as
//! raw closes and `quantile_preds` comes out already in real-price units.
//! That is a deliberate deviation from the original plan's "replicate the
//! scaler in Rust" assumption (see `docs/superpowers/plans/
//! 2026-07-20-forecaster-models-plan.md`), not an oversight.

use crate::Horizon;

/// `chronos_config.context_length` -- the graph's fixed input width, traced
/// at export time (spike §6/§3). Any other length would not run at all.
pub const CONTEXT_LENGTH: usize = 2048;
/// `chronos_config.quantiles` count -- 9 levels, `[0.1..0.9]` step 0.1.
pub const NUM_QUANTILES: usize = 9;
/// `chronos_config.prediction_length`, baked into the exported graph's
/// output-head weight shape (spike §6) -- not a runtime parameter.
pub const PREDICTION_LENGTH: usize = 64;

/// Axis-1 index of the q10 level in `quantile_preds` (spike §6: ascending
/// `[0.1..0.9]`, so q10 is first).
pub const Q10_IDX: usize = 0;
/// Axis-1 index of the median (q50).
pub const Q50_IDX: usize = 4;
/// Axis-1 index of the q90 level (last of the ascending 9).
pub const Q90_IDX: usize = 8;

/// Trailing-bar window `recent_log_return_volatility` draws from -- the
/// spike's §7 illustration uses "std of context log-returns over the
/// trailing 64 bars".
pub const VOLATILITY_WINDOW: usize = 64;

/// Builds the exact `[1, CONTEXT_LENGTH]` input the exported graph expects:
/// the most recent `CONTEXT_LENGTH` closes, most-recent-last. Fewer than
/// `CONTEXT_LENGTH` real bars are left-padded with `NaN` -- not zero, not the
/// earliest real value -- reproducing the model's own "insufficient
/// history" handling the spike validated (§4, §6), rather than rejecting
/// short windows outright.
pub fn build_context(closes: &[f64]) -> Vec<f32> {
    let n = closes.len();
    if n >= CONTEXT_LENGTH {
        closes[n - CONTEXT_LENGTH..].iter().map(|&c| c as f32).collect()
    } else {
        let mut buf = vec![f32::NAN; CONTEXT_LENGTH];
        for (slot, &c) in buf[CONTEXT_LENGTH - n..].iter_mut().zip(closes.iter()) {
            *slot = c as f32;
        }
        buf
    }
}

/// Which horizon-axis step this product's two `Horizon` buckets read from
/// the single 64-step forward pass (spike §6's "near-horizon (1/5) use"):
/// `Intraday` -> next bar (step 0), `Positional` -> 5 bars ahead (step 4,
/// since step 0 is already 1 bar ahead).
pub fn target_step(horizon: Horizon) -> usize {
    match horizon {
        Horizon::Intraday => 0,
        Horizon::Positional => 4,
    }
}

/// Reads `(q10, q50, q90)` at horizon `step` out of the flattened
/// `[NUM_QUANTILES, PREDICTION_LENGTH]` `quantile_preds` output (batch
/// dimension already squeezed by the caller).
pub fn read_quantiles(raw: &[f32], step: usize) -> (f64, f64, f64) {
    assert_eq!(
        raw.len(),
        NUM_QUANTILES * PREDICTION_LENGTH,
        "chronos: quantile_preds length must be {} x {}",
        NUM_QUANTILES,
        PREDICTION_LENGTH
    );
    assert!(step < PREDICTION_LENGTH, "chronos: step {step} out of range");

    let at = |q: usize| raw[q * PREDICTION_LENGTH + step] as f64;
    (at(Q10_IDX), at(Q50_IDX), at(Q90_IDX))
}

/// `(q50 - last_close) / last_close`, guarded the same way
/// `relative_magnitude`/`classify_by_distance` guard a zero baseline
/// elsewhere in this crate.
pub fn forecast_return(q50: f64, last_close: f64) -> f64 {
    if last_close.abs() < 1e-12 {
        0.0
    } else {
        (q50 - last_close) / last_close
    }
}

/// Population (ddof=0) standard deviation of log returns over the trailing
/// `VOLATILITY_WINDOW` closes (fewer if unavailable) -- the `recent_vol`
/// input the spike's §7 conviction illustration measures against. `0.0` on
/// fewer than two closes (no return is computable) or an all-non-positive
/// window (no `ln` is computable).
pub fn recent_log_return_volatility(closes: &[f64]) -> f64 {
    if closes.len() < 2 {
        return 0.0;
    }
    let start = closes.len().saturating_sub(VOLATILITY_WINDOW + 1);
    let window = &closes[start..];

    let returns: Vec<f64> = window
        .windows(2)
        .filter_map(|pair| {
            let (prev, curr) = (pair[0], pair[1]);
            if prev > 0.0 && curr > 0.0 {
                Some((curr / prev).ln())
            } else {
                None
            }
        })
        .collect();

    if returns.is_empty() {
        return 0.0;
    }

    let n = returns.len() as f64;
    let mean = returns.iter().sum::<f64>() / n;
    let var = returns.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / n;
    var.sqrt()
}

/// Scales `recent_vol` by `sqrt(steps_ahead)` before it feeds
/// `framework::conviction_from_quantile_spread` as the `recent_vol`
/// argument -- a random walk's variance grows linearly with the number of
/// steps, so its standard deviation (and hence the "typical" band width a
/// well-calibrated forecast should show) grows with `sqrt(steps_ahead)`.
/// `step` is the axis-2 index (0 = next bar = 1 step ahead), hence `step +
/// 1`. See spike §7's `horizon_vol = recent_vol * sqrt(step_k + 1)`.
pub fn horizon_scaled_volatility(recent_vol: f64, step: usize) -> f64 {
    recent_vol * ((step + 1) as f64).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_context_left_pads_short_windows_with_nan() {
        let closes = vec![1.0, 2.0, 3.0];
        let ctx = build_context(&closes);

        assert_eq!(ctx.len(), CONTEXT_LENGTH);
        assert!(ctx[..CONTEXT_LENGTH - 3].iter().all(|v| v.is_nan()));
        assert_eq!(&ctx[CONTEXT_LENGTH - 3..], &[1.0f32, 2.0, 3.0]);
    }

    #[test]
    fn build_context_keeps_the_most_recent_context_length_closes_when_longer() {
        let closes: Vec<f64> = (0..(CONTEXT_LENGTH + 5)).map(|i| i as f64).collect();
        let ctx = build_context(&closes);

        assert_eq!(ctx.len(), CONTEXT_LENGTH);
        assert_eq!(ctx[0], 5.0);
        assert_eq!(*ctx.last().unwrap(), (CONTEXT_LENGTH + 4) as f32);
    }

    #[test]
    fn build_context_is_unchanged_at_exactly_context_length() {
        let closes: Vec<f64> = (0..CONTEXT_LENGTH).map(|i| i as f64).collect();
        let ctx = build_context(&closes);

        assert_eq!(ctx.len(), CONTEXT_LENGTH);
        assert_eq!(ctx[0], 0.0);
        assert_eq!(*ctx.last().unwrap(), (CONTEXT_LENGTH - 1) as f32);
    }

    #[test]
    fn target_step_maps_intraday_to_next_bar_and_positional_to_five_bars_ahead() {
        assert_eq!(target_step(Horizon::Intraday), 0);
        assert_eq!(target_step(Horizon::Positional), 4);
    }

    #[test]
    fn read_quantiles_indexes_q10_q50_q90_at_the_requested_step() {
        // raw[q * PREDICTION_LENGTH + step] = q * 100 + step, a hand-built
        // pattern so each quantile row is trivially distinguishable.
        let mut raw = vec![0.0f32; NUM_QUANTILES * PREDICTION_LENGTH];
        for q in 0..NUM_QUANTILES {
            for step in 0..PREDICTION_LENGTH {
                raw[q * PREDICTION_LENGTH + step] = (q * 100 + step) as f32;
            }
        }

        let (q10, q50, q90) = read_quantiles(&raw, 5);

        assert_eq!(q10, 5.0);
        assert_eq!(q50, 405.0);
        assert_eq!(q90, 805.0);
    }

    #[test]
    #[should_panic(expected = "quantile_preds length")]
    fn read_quantiles_rejects_the_wrong_length() {
        let raw = vec![0.0f32; 10];
        read_quantiles(&raw, 0);
    }

    #[test]
    fn forecast_return_matches_hand_computed_relative_change() {
        assert!((forecast_return(105.0, 100.0) - 0.05).abs() < 1e-12);
        assert!((forecast_return(95.0, 100.0) - (-0.05)).abs() < 1e-12);
    }

    #[test]
    fn forecast_return_guards_a_near_zero_last_close() {
        let ret = forecast_return(1.0, 0.0);
        assert_eq!(ret, 0.0);
        assert!(!ret.is_nan());
    }

    #[test]
    fn recent_log_return_volatility_matches_hand_computed_std_of_log_returns() {
        // Closes 100 -> 110 -> 100: log returns ln(1.1), ln(100/110).
        let closes = vec![100.0, 110.0, 100.0];
        let r0 = (110.0f64 / 100.0).ln();
        let r1 = (100.0f64 / 110.0).ln();
        let mean = (r0 + r1) / 2.0;
        let expected_std = (((r0 - mean).powi(2) + (r1 - mean).powi(2)) / 2.0).sqrt();

        let got = recent_log_return_volatility(&closes);

        assert!((got - expected_std).abs() < 1e-12);
    }

    #[test]
    fn recent_log_return_volatility_is_zero_on_fewer_than_two_closes() {
        assert_eq!(recent_log_return_volatility(&[]), 0.0);
        assert_eq!(recent_log_return_volatility(&[100.0]), 0.0);
    }

    #[test]
    fn recent_log_return_volatility_only_uses_the_trailing_window() {
        let mut closes = vec![100.0; VOLATILITY_WINDOW + 50];
        // Perturb only the earliest (out-of-window) bars; the trailing
        // window stays perfectly flat, so volatility must read exactly 0.
        for (i, c) in closes.iter_mut().take(10).enumerate() {
            *c = 100.0 + i as f64;
        }
        assert_eq!(recent_log_return_volatility(&closes), 0.0);
    }

    #[test]
    fn horizon_scaled_volatility_grows_with_sqrt_of_steps_ahead() {
        let recent_vol = 0.02;
        assert!((horizon_scaled_volatility(recent_vol, 0) - 0.02).abs() < 1e-12);
        assert!((horizon_scaled_volatility(recent_vol, 3) - 0.02 * 4.0f64.sqrt()).abs() < 1e-12);
    }
}
