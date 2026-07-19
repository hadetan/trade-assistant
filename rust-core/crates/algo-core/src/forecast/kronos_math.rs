use chrono::{DateTime, Datelike, Duration, Timelike, Utc};

use crate::Timeframe;

/// The tokenizer's operating context length. Fixed (not the model's 512
/// `max_context`) because `KronosTokenizer.encode`/`decode`'s Transformer
/// blocks never accept a padding mask upstream (`model/kronos.py`) -- see
/// kronos.rs's module doc for the full export-design rationale. `compute()`
/// always feeds exactly this many of the most recent bars, truncating any
/// longer history the same way `KronosPredictor` does for over-length input.
pub const CTX_LEN: usize = 256;
/// Forecast horizon, matching the checkpoint's own committed regression
/// fixture (`tests/data/regression_output_256.csv` upstream) so the
/// committed Rust fixture can be checked against a pipeline validated
/// end-to-end against that fixture.
pub const PRED_LEN: usize = 8;
/// Kronos-small's `max_context` (README/config): the fixed width every
/// `decode_s1`/`decode_s2` call uses, real tokens right-aligned and the
/// unfilled prefix left-padded + masked.
pub const MAX_CONTEXT: usize = 512;
/// Kronos-small's `d_model` (config.json), i.e. width of the `context`
/// tensor `decode_s1` hands to `decode_s2`.
pub const D_MODEL: usize = 512;
/// open, high, low, close, volume, amount (turnover) -- `KronosTokenizer`'s
/// `d_in`.
pub const FEATURES: usize = 6;
/// `KronosPredictor`'s own clip bound, applied both to the z-scored input
/// and (via `auto_regressive_inference`) the raw window before tokenizing.
pub const CLIP: f64 = 5.0;

// decode_s1/decode_s2's fixed 512-wide buffer must always have room for the
// real window (256) plus every generated step (8) without ever hitting the
// "buffer full, roll" branch `auto_regressive_inference` needs for a
// *variable* context length -- so this driver never implements that branch.
// If either constant above changes such that this stops holding, this must
// fail loudly at compile time rather than silently truncating history.
const _: () = assert!(CTX_LEN + PRED_LEN <= MAX_CONTEXT);

/// Kronos's own `KronosPredictor.predict()` fallback for callers with no
/// turnover data: `volume * mean(open, high, low, close)` (kronos.py). This
/// product's `MarketContext` has no turnover/"amount" field at all, so the
/// shipped algorithm always takes this path -- see kronos.rs's module doc
/// for why the committed regression fixture's reference forecast was
/// regenerated against this same approximation rather than reused verbatim
/// from upstream's own CSV (computed from real turnover, which runs ~100x
/// this estimate for that fixture's lot-based volume convention).
pub fn derive_amount(open: f64, high: f64, low: f64, close: f64, volume: f64) -> f64 {
    volume * (open + high + low + close) / 4.0
}

/// `[minute, hour, weekday, day, month]`, the exact column order and
/// encoding `model.module.TemporalEmbedding.forward` (Kronos) expects --
/// see upstream `calc_time_stamps` in `model/kronos.py`. `weekday` is
/// Mon=0..Sun=6 (pandas' `dt.weekday`, which is what the model was trained
/// against).
pub fn calendar_features(ts: DateTime<Utc>) -> [f32; 5] {
    [
        ts.minute() as f32,
        ts.hour() as f32,
        ts.weekday().num_days_from_monday() as f32,
        ts.day() as f32,
        ts.month() as f32,
    ]
}

/// The bar interval implied by a timeframe, used to synthesize the future
/// calendar stamps `decode_s1` expects for the bars being forecast (Kronos
/// conditions on the *target* bar's calendar features, not just the
/// context's -- see `full_stamp` in upstream `auto_regressive_inference`).
pub fn timeframe_step(tf: Timeframe) -> Duration {
    match tf {
        Timeframe::Minute => Duration::minutes(1),
        Timeframe::FiveMinute => Duration::minutes(5),
        Timeframe::FifteenMinute => Duration::minutes(15),
        Timeframe::Day => Duration::days(1),
    }
}

/// Per-channel population mean/std (ddof=0, matching `numpy.std`'s default)
/// over the context window, then z-score normalize and clip to +/-`clip` --
/// `KronosPredictor.predict`'s exact normalization (kronos.py).
pub fn zscore_normalize(
    rows: &[[f64; FEATURES]],
    clip: f64,
) -> (Vec<[f32; FEATURES]>, [f64; FEATURES], [f64; FEATURES]) {
    let n = rows.len() as f64;
    let mut mean = [0.0; FEATURES];
    for row in rows {
        for c in 0..FEATURES {
            mean[c] += row[c];
        }
    }
    for m in &mut mean {
        *m /= n;
    }

    let mut var = [0.0; FEATURES];
    for row in rows {
        for c in 0..FEATURES {
            let d = row[c] - mean[c];
            var[c] += d * d;
        }
    }
    let mut std = [0.0; FEATURES];
    for c in 0..FEATURES {
        std[c] = (var[c] / n).sqrt();
    }

    let normalized = rows
        .iter()
        .map(|row| {
            let mut out = [0.0f32; FEATURES];
            for (c, slot) in out.iter_mut().enumerate() {
                let v = (row[c] - mean[c]) / (std[c] + 1e-5);
                *slot = v.clamp(-clip, clip) as f32;
            }
            out
        })
        .collect();

    (normalized, mean, std)
}

/// Inverse of `zscore_normalize`'s scaling (not its clip, which is lossy by
/// construction): `raw = z * (std + 1e-5) + mean`.
pub fn denormalize(row: &[f32; FEATURES], mean: &[f64; FEATURES], std: &[f64; FEATURES]) -> [f64; FEATURES] {
    let mut out = [0.0; FEATURES];
    for c in 0..FEATURES {
        out[c] = row[c] as f64 * (std[c] + 1e-5) + mean[c];
    }
    out
}

/// The whole of Kronos's greedy (`top_k=1`) decoding step: deterministic
/// argmax, no RNG. Returns `(token id, softmax probability of that token)`
/// -- the probability is a cheap byproduct (one extra pass summing
/// `exp(logit - max)`) used as this algorithm's "conviction" signal, not a
/// second decoding pass.
pub fn greedy_argmax(logits: &[f32]) -> (i64, f32) {
    let (idx, &max_logit) = logits
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Less))
        .expect("kronos: logits must be non-empty");

    let sum_exp: f32 = logits.iter().map(|&l| (l - max_logit).exp()).sum();
    let prob = if sum_exp > 0.0 { 1.0 / sum_exp } else { 1.0 };
    (idx as i64, prob)
}

/// Right-aligns `real` (length <= `max_len`) into a `max_len`-wide buffer,
/// left-padded with `T::default()`. This -- not left-aligned padding -- is
/// what the fixed-max-context decode graphs were exported and validated
/// against: the newest real token always sits at the last buffer position,
/// matching how `decode_s1`/`decode_s2` read `[:, -1, :]`.
pub fn right_align<T: Copy + Default>(real: &[T], max_len: usize) -> Vec<T> {
    assert!(real.len() <= max_len, "kronos: real content exceeds max_context");
    let mut buf = vec![T::default(); max_len];
    buf[max_len - real.len()..].copy_from_slice(real);
    buf
}

/// `true` at real (attend) positions, `false` at the left-padded prefix --
/// this boolean convention (True = attend), not its inverse and not a float
/// additive mask, is the one empirically confirmed (see kronos.rs's module
/// doc) to reproduce the un-padded reference computation bit-for-bit.
pub fn padding_mask(real_len: usize, max_len: usize) -> Vec<bool> {
    let mut mask = vec![false; max_len];
    mask[max_len - real_len..].fill(true);
    mask
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_amount_matches_kronos_predictor_fallback() {
        // volume * mean(open, high, low, close) -- KronosPredictor.predict()'s
        // own no-turnover fallback formula.
        let amount = derive_amount(10.0, 12.0, 9.0, 11.0, 100.0);
        assert!((amount - 100.0 * 10.5).abs() < 1e-9);
    }

    #[test]
    fn calendar_features_matches_pandas_weekday_convention() {
        // 2024-06-18 is a Tuesday -> pandas dt.weekday == 1 (Mon=0).
        let ts = DateTime::from_timestamp(1718709300, 0).unwrap(); // 2024-06-18T11:15:00Z
        let f = calendar_features(ts);
        assert_eq!(f, [15.0, 11.0, 1.0, 18.0, 6.0]);
    }

    #[test]
    fn zscore_normalize_round_trips_through_denormalize() {
        let rows = vec![[1.0, 2.0, 3.0, 4.0, 5.0, 6.0], [2.0, 3.0, 4.0, 5.0, 6.0, 7.0]];
        let (normalized, mean, std) = zscore_normalize(&rows, CLIP);
        let recovered = denormalize(&normalized[0], &mean, &std);
        for c in 0..FEATURES {
            assert!((recovered[c] - rows[0][c]).abs() < 1e-3);
        }
    }

    #[test]
    fn greedy_argmax_picks_the_highest_logit_deterministically() {
        let logits = [0.1, 5.0, -2.0, 4.9];
        let (idx, prob) = greedy_argmax(&logits);
        assert_eq!(idx, 1);
        assert!(prob > 0.0 && prob <= 1.0);
    }

    #[test]
    fn right_align_pads_the_prefix_and_keeps_real_content_at_the_tail() {
        let real = [1i64, 2, 3];
        let buf = right_align(&real, 5);
        assert_eq!(buf, vec![0, 0, 1, 2, 3]);
    }

    #[test]
    fn padding_mask_marks_only_the_real_suffix_as_attend() {
        let mask = padding_mask(3, 5);
        assert_eq!(mask, vec![false, false, true, true, true]);
    }
}
