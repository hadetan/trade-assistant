//! Kronos (`NeoQuasar/Kronos-small` + `Kronos-Tokenizer-base`), a decoder-only
//! foundation model for OHLCV candlesticks, run entirely through four
//! fixed-shape ONNX graphs exported offline (see
//! `docs/superpowers/spikes/2026-07-19-kronos-onnx-feasibility.md`) and
//! loaded once here via `ort`.
//!
//! ## Why fixed-shape + padding mask, not `dynamic_axes`
//! The spike measured naive `dynamic_axes` export producing large numeric
//! drift (and one outright argmax flip) at sequence lengths other than the
//! trace length -- an unsafe silent-corruption risk, not a hard failure.
//! This implementation instead exports/runs `decode_s1`/`decode_s2` at ONE
//! fixed shape, `kronos_math::MAX_CONTEXT` (512, Kronos-small's own
//! `max_context`), with the real token/calendar history right-aligned to
//! the last position and a boolean `padding_mask` (`true` = attend) marking
//! the left-padded prefix. This exact design -- right-alignment + a
//! `true`-means-attend boolean mask, combined with the model's causal
//! self-attention -- was empirically validated (not just reasoned about)
//! against the un-padded reference computation before export: max abs logit
//! diff 1.34e-5 across all 8 greedy decode steps, identical argmax at every
//! step, and a final reconstructed forecast within 9.0e-7 max relative error
//! of the upstream checkpoint's own committed regression fixture
//! (`tests/data/regression_output_256.csv`, context_len=256, pred_len=8,
//! greedy top_k=1/top_p=1.0 -- the exact decoding mode used here). See
//! `.superpowers/sdd/task-32-report.md` for the full validation script and
//! numbers.
//!
//! One upstream-export wrinkle: `torch.onnx.export`'s legacy
//! `scaled_dot_product_attention` symbolic refuses `is_causal=True` combined
//! with an explicit `attn_mask` (`AssertionError: is_causal and attn_mask
//! cannot be set at the same time`), even though eager PyTorch runs that
//! combination fine. The export-time fix (in this task's patched local copy
//! of `model/module.py`, not vendored into this repo) folds the causal
//! triangle into the same boolean mask and passes `is_causal=False` instead
//! -- verified bit-identical to the original `is_causal=True` + mask call in
//! eager mode before re-exporting.
//!
//! `KronosTokenizer.encode`/`decode` need none of this: their internal
//! Transformer blocks never accept a padding mask at all upstream (no
//! `key_padding_mask` plumbed through `KronosTokenizer.encode`/`decode` in
//! `model/kronos.py`), so they're exported at ONE single fixed shape each --
//! `kronos_math::CTX_LEN` (256) for `encode`, `CTX_LEN + PRED_LEN` (264) for
//! `decode` -- and this algorithm always feeds them exactly that many real
//! bars/tokens (truncating any longer history), sidestepping the
//! dynamic-shape question for the tokenizer entirely rather than needing an
//! unsupported mask path.
//!
//! ## "amount" (turnover)
//! Kronos's tokenizer wants 6 channels (open, high, low, close, volume,
//! amount/turnover); `MarketContext` only carries 5. `amount` is derived via
//! `KronosPredictor.predict()`'s own no-turnover fallback (`volume *
//! mean(OHLC)`, see `kronos_math::derive_amount`) -- the committed
//! regression fixture's reference forecast was regenerated against this
//! same derived value (not reused verbatim from upstream's CSV, which has
//! real turnover ~100x this estimate for that fixture's lot-based volume
//! convention) so the test asserts against what this Algorithm actually
//! computes.

use std::sync::{Arc, Mutex, OnceLock};

use chrono::DateTime;
use ort::session::Session;
use ort::value::TensorRef;

use crate::forecast::assets::assets_base_dir;
use crate::forecast::kronos_math::{
    calendar_features, denormalize, derive_amount, greedy_argmax, padding_mask, right_align,
    timeframe_step, zscore_normalize, CLIP, CTX_LEN, D_MODEL, FEATURES, MAX_CONTEXT, PRED_LEN,
};
use crate::{AlgoOutput, Algorithm, Direction, Horizon, MarketContext};

/// The model's own reconstructed OHLCV forecast + greedy token trace, ahead
/// of this Algorithm's `AlgoOutput` summarization. Exposed beyond the
/// `Algorithm` trait (see `KronosAlgorithm::forecast`) so the regression
/// test can assert against the checkpoint's own per-bar forecast numbers
/// and exact greedy token ids, not just the single direction/magnitude/
/// confidence summary `compute()` derives from them.
pub struct KronosForecast {
    /// `PRED_LEN` rows of `[open, high, low, close, volume, amount]`.
    pub bars: Vec<[f64; FEATURES]>,
    pub s1_tokens: Vec<i64>,
    pub s2_tokens: Vec<i64>,
    /// Mean of the greedy token's own softmax probability across every
    /// decode step (s1 and s2 both) -- this algorithm's deterministic
    /// stand-in for sampling confidence, since greedy decoding has no
    /// distribution to report otherwise.
    pub conviction: f64,
    /// The last real close in the context window, i.e. the anchor
    /// `compute()` measures the forecast return against.
    pub latest_close: f64,
}

struct KronosSessions {
    tokenizer_encode: Mutex<Session>,
    tokenizer_decode: Mutex<Session>,
    decode_s1: Mutex<Session>,
    decode_s2: Mutex<Session>,
}

impl KronosSessions {
    /// Loads all four ONNX graphs from `assets/kronos/` on disk. Panics on
    /// failure: a missing or corrupt asset is a packaging/deployment bug
    /// (assets are checked in via Git LFS), not a runtime condition any
    /// caller could recover from.
    fn load() -> Self {
        let base = assets_base_dir().join("kronos");
        let load = |file: &str| {
            let path = base.join(file);
            Session::builder()
                .and_then(|mut b| b.commit_from_file(&path))
                .unwrap_or_else(|e| {
                    panic!(
                        "kronos: failed to load asset {file} from {}: {e} \
                         (ensure the ONNX assets exist -- try `git lfs pull`, or set \
                         ALGO_CORE_ASSETS_DIR to a directory that has them)",
                        path.display()
                    )
                })
        };
        Self {
            tokenizer_encode: Mutex::new(load("tokenizer_encode.onnx")),
            tokenizer_decode: Mutex::new(load("tokenizer_decode.onnx")),
            decode_s1: Mutex::new(load("decode_s1.onnx")),
            decode_s2: Mutex::new(load("decode_s2.onnx")),
        }
    }
}

// `registry::all()` re-invokes every `AlgorithmFactory` closure -- including
// `KronosAlgorithm::new` -- on every call, but the ~114MB across these four
// sessions must be parsed AT MOST ONCE per process. `ort::Session` isn't
// `Clone`, so the loaded bundle is parked behind a process-wide singleton and
// shared via `Arc` rather than reloaded or cloned.
static SESSIONS: OnceLock<Arc<KronosSessions>> = OnceLock::new();

fn shared_sessions() -> Arc<KronosSessions> {
    SESSIONS.get_or_init(|| Arc::new(KronosSessions::load())).clone()
}

pub struct KronosAlgorithm {
    sessions: Arc<KronosSessions>,
}

impl KronosAlgorithm {
    /// Cheap: an `Arc` clone of the process-wide singleton, loading the four
    /// on-disk ONNX graphs only on the very first call across the process.
    pub fn new() -> Self {
        Self { sessions: shared_sessions() }
    }

    fn no_op(&self, ctx: &MarketContext) -> AlgoOutput {
        AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction: Direction::Neutral,
            magnitude: 0.0,
            confidence: 0.0,
            evidence: vec!["model opinion: insufficient OHLCV history for Kronos".into()],
            computed_at: ctx.as_of,
        }
    }

    /// Runs the full tokenize -> greedy-autoregressive-decode -> reconstruct
    /// pipeline against `ctx`'s most recent `CTX_LEN` bars. `None` when
    /// there isn't enough aligned OHLCV history (the no-op guard other
    /// OHLCV-dependent algorithms in this crate use, e.g. `cmf`/`parkinson`).
    pub fn forecast(&self, ctx: &MarketContext) -> Option<KronosForecast> {
        let n = ctx.closes.len();
        if ctx.opens.len() < CTX_LEN
            || ctx.highs.len() < CTX_LEN
            || ctx.lows.len() < CTX_LEN
            || ctx.volumes.len() < CTX_LEN
            || ctx.timestamps.len() < CTX_LEN
            || n < CTX_LEN
        {
            return None;
        }

        // Use only the most recent CTX_LEN bars, matching KronosPredictor's
        // own truncate-longer-context behavior.
        let start = n - CTX_LEN;
        let opens = &ctx.opens[start..];
        let highs = &ctx.highs[start..];
        let lows = &ctx.lows[start..];
        let closes = &ctx.closes[start..];
        let volumes = &ctx.volumes[start..];
        let timestamps = &ctx.timestamps[start..];

        let rows: Vec<[f64; FEATURES]> = (0..CTX_LEN)
            .map(|i| {
                let amount = derive_amount(opens[i], highs[i], lows[i], closes[i], volumes[i]);
                [opens[i], highs[i], lows[i], closes[i], volumes[i], amount]
            })
            .collect();
        let (normalized, mean, std) = zscore_normalize(&rows, CLIP);

        let x_flat: Vec<f32> = normalized.iter().flatten().copied().collect();
        let (mut s1_ids, mut s2_ids): (Vec<i64>, Vec<i64>) = {
            let x_tensor =
                TensorRef::from_array_view(([1i64, CTX_LEN as i64, FEATURES as i64], x_flat.as_slice()))
                    .expect("kronos: building tokenizer_encode input");
            let mut guard = self.sessions.tokenizer_encode.lock().unwrap();
            let outputs = guard
                .run(ort::inputs!["x" => x_tensor])
                .expect("kronos: tokenizer_encode inference failed");
            let (_, s1) = outputs["s1_ids"]
                .try_extract_tensor::<i64>()
                .expect("kronos: extracting s1_ids");
            let (_, s2) = outputs["s2_ids"]
                .try_extract_tensor::<i64>()
                .expect("kronos: extracting s2_ids");
            (s1.to_vec(), s2.to_vec())
        };

        let mut stamps: Vec<[f32; 5]> = timestamps
            .iter()
            .map(|&epoch| {
                let ts = DateTime::from_timestamp(epoch, 0).expect("kronos: invalid bar timestamp");
                calendar_features(ts)
            })
            .collect();

        let last_ts =
            DateTime::from_timestamp(timestamps[CTX_LEN - 1], 0).expect("kronos: invalid bar timestamp");
        let step = timeframe_step(ctx.timeframe);
        let future_stamps: Vec<[f32; 5]> =
            (1..=PRED_LEN as i32).map(|i| calendar_features(last_ts + step * i)).collect();

        // Greedy (top_k=1) autoregressive decode over the fixed-max-context
        // + padding-mask buffers -- buffer bookkeeping and argmax only, no
        // RNG. The roll-when-full branch upstream's `auto_regressive_
        // inference` needs for a *variable* context length never triggers
        // here: kronos_math asserts CTX_LEN + PRED_LEN <= MAX_CONTEXT at
        // compile time, so the real-token history never reaches
        // MAX_CONTEXT within this loop.
        let mut conviction_sum = 0.0f32;
        for &future_stamp in future_stamps.iter().take(PRED_LEN) {
            let real_len = s1_ids.len();
            let pre_buf = right_align(&s1_ids, MAX_CONTEXT);
            let post_buf = right_align(&s2_ids, MAX_CONTEXT);
            let stamp_buf: Vec<[f32; 5]> = right_align(&stamps, MAX_CONTEXT);
            let stamp_flat: Vec<f32> = stamp_buf.iter().flatten().copied().collect();
            let mask = padding_mask(real_len, MAX_CONTEXT);

            let (s1_token, prob1, context_vec): (i64, f32, Vec<f32>) = {
                let pre_tensor = TensorRef::from_array_view(([1i64, MAX_CONTEXT as i64], pre_buf.as_slice()))
                    .expect("kronos: building decode_s1 s1_ids");
                let post_tensor = TensorRef::from_array_view(([1i64, MAX_CONTEXT as i64], post_buf.as_slice()))
                    .expect("kronos: building decode_s1 s2_ids");
                let stamp_tensor = TensorRef::from_array_view((
                    [1i64, MAX_CONTEXT as i64, 5i64],
                    stamp_flat.as_slice(),
                ))
                .expect("kronos: building decode_s1 stamp");
                let mask_tensor = TensorRef::from_array_view(([1i64, MAX_CONTEXT as i64], mask.as_slice()))
                    .expect("kronos: building decode_s1 padding_mask");

                let mut guard = self.sessions.decode_s1.lock().unwrap();
                let outputs = guard
                    .run(ort::inputs![
                        "s1_ids" => pre_tensor,
                        "s2_ids" => post_tensor,
                        "stamp" => stamp_tensor,
                        "padding_mask" => mask_tensor,
                    ])
                    .expect("kronos: decode_s1 inference failed");
                let (_, logits) = outputs["s1_logits_last"]
                    .try_extract_tensor::<f32>()
                    .expect("kronos: extracting s1_logits_last");
                let (token, prob) = greedy_argmax(logits);
                let (_, context) = outputs["context"]
                    .try_extract_tensor::<f32>()
                    .expect("kronos: extracting context");
                (token, prob, context.to_vec())
            };

            let (s2_token, prob2) = {
                let context_tensor = TensorRef::from_array_view((
                    [1i64, MAX_CONTEXT as i64, D_MODEL as i64],
                    context_vec.as_slice(),
                ))
                .expect("kronos: building decode_s2 context");
                let s1_query = [s1_token];
                let s1_query_tensor = TensorRef::from_array_view(([1i64, 1i64], s1_query.as_slice()))
                    .expect("kronos: building decode_s2 s1_ids");
                let mask_tensor = TensorRef::from_array_view(([1i64, MAX_CONTEXT as i64], mask.as_slice()))
                    .expect("kronos: building decode_s2 padding_mask");

                let mut guard = self.sessions.decode_s2.lock().unwrap();
                let outputs = guard
                    .run(ort::inputs![
                        "context" => context_tensor,
                        "s1_ids" => s1_query_tensor,
                        "padding_mask" => mask_tensor,
                    ])
                    .expect("kronos: decode_s2 inference failed");
                let (_, logits) = outputs["s2_logits_last"]
                    .try_extract_tensor::<f32>()
                    .expect("kronos: extracting s2_logits_last");
                greedy_argmax(logits)
            };

            conviction_sum += (prob1 + prob2) / 2.0;
            s1_ids.push(s1_token);
            s2_ids.push(s2_token);
            stamps.push(future_stamp);
        }

        let total_len = CTX_LEN + PRED_LEN;
        let z: Vec<f32> = {
            let full_pre_tensor = TensorRef::from_array_view(([1i64, total_len as i64], s1_ids.as_slice()))
                .expect("kronos: building tokenizer_decode s1_ids");
            let full_post_tensor = TensorRef::from_array_view(([1i64, total_len as i64], s2_ids.as_slice()))
                .expect("kronos: building tokenizer_decode s2_ids");
            let mut guard = self.sessions.tokenizer_decode.lock().unwrap();
            let outputs = guard
                .run(ort::inputs!["s1_ids" => full_pre_tensor, "s2_ids" => full_post_tensor])
                .expect("kronos: tokenizer_decode inference failed");
            let (_, z) = outputs["z"].try_extract_tensor::<f32>().expect("kronos: extracting z");
            z.to_vec()
        };

        let bars: Vec<[f64; FEATURES]> = (0..PRED_LEN)
            .map(|i| {
                let row_start = (CTX_LEN + i) * FEATURES;
                let mut row = [0.0f32; FEATURES];
                row.copy_from_slice(&z[row_start..row_start + FEATURES]);
                denormalize(&row, &mean, &std)
            })
            .collect();

        Some(KronosForecast {
            bars,
            s1_tokens: s1_ids[CTX_LEN..].to_vec(),
            s2_tokens: s2_ids[CTX_LEN..].to_vec(),
            conviction: (conviction_sum / PRED_LEN as f32).clamp(0.0, 1.0) as f64,
            latest_close: closes[CTX_LEN - 1],
        })
    }
}

impl Default for KronosAlgorithm {
    fn default() -> Self {
        Self::new()
    }
}

impl Algorithm for KronosAlgorithm {
    fn id(&self) -> &'static str {
        "kronos"
    }

    fn required_lookback(&self) -> usize {
        CTX_LEN
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> AlgoOutput {
        let Some(f) = self.forecast(ctx) else {
            return self.no_op(ctx);
        };

        let forecast_close = f.bars[PRED_LEN - 1][3];
        let forecast_return = if f.latest_close.abs() < 1e-12 {
            0.0
        } else {
            (forecast_close - f.latest_close) / f.latest_close
        };

        let direction = if forecast_return.abs() < 1e-6 {
            Direction::Neutral
        } else if forecast_return > 0.0 {
            Direction::Bullish
        } else {
            Direction::Bearish
        };

        AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude: forecast_return.abs(),
            confidence: f.conviction,
            evidence: vec![
                format!(
                    "model opinion: Kronos-small greedy forecast, close {:.4} -> {:.4} over {} bars ({:+.3}%)",
                    f.latest_close,
                    forecast_close,
                    PRED_LEN,
                    forecast_return * 100.0
                ),
                format!("model opinion: greedy decode conviction {:.3}", f.conviction),
            ],
            computed_at: ctx.as_of,
        }
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(KronosAlgorithm::new()))
}
