//! Generic scaffolding every ONNX foundation-model forecaster (TTM, Chronos,
//! Moirai) plugs into. Generalizes the load-once-session, forecast ->
//! direction/magnitude/conviction mapping, and "model opinion:"-prefixed
//! no-op conventions `forecast/kronos.rs` established for Kronos -- Kronos
//! itself is not refactored onto this, it stays as its own four-graph
//! pipeline.
//!
//! `ttm.rs`, `chronos.rs`, and `moirai.rs` now all consume this scaffolding
//! (`ForecasterSessions`, `ForecasterAdapter`, `ForecastAlgorithm`,
//! `summary_to_output`/`no_op` via `compute()`), so no blanket `dead_code`
//! allow is needed here anymore -- see individual items below for the few
//! that are only reachable under a subset of the three features.

use std::path::PathBuf;
use std::sync::Mutex;

use ort::session::Session;

use crate::{AlgoOutput, Algorithm, Direction, Horizon, MarketContext};

/// N fixed-shape ONNX graphs loaded once per model, keyed by name. Each
/// model owns its own `static SESSIONS: OnceLock<Arc<ForecasterSessions>>` +
/// `shared_sessions()` singleton built from this (mirroring `KronosSessions`
/// in kronos.rs) -- this type itself holds no process-wide state, so
/// sessions are never shared across models.
pub struct ForecasterSessions {
    sessions: Vec<(&'static str, Mutex<Session>)>,
}

impl ForecasterSessions {
    /// Loads every `(name, path)` pair via `commit_from_file`, reading the
    /// `.onnx` bytes from disk instead of the previous `include_bytes!`
    /// embedding. Panics on failure: a missing/corrupt on-disk asset is a
    /// packaging/deployment bug, not a runtime condition a caller could
    /// recover from -- same fail-fast contract as the old
    /// `commit_from_memory`-based `load`, just with a path in the message
    /// plus an actionable hint (assets are checked in via Git LFS, so a
    /// shallow clone or missed `git lfs pull` is the likely cause).
    pub fn load_from_files(graphs: &[(&'static str, PathBuf)]) -> Self {
        let sessions = graphs
            .iter()
            .map(|(name, path)| {
                let session = Session::builder()
                    .and_then(|mut builder| builder.commit_from_file(path))
                    .unwrap_or_else(|e| {
                        panic!(
                            "forecaster: failed to load asset {name} from {}: {e} \
                             (ensure the ONNX assets exist -- try `git lfs pull`, or set \
                             ALGO_CORE_ASSETS_DIR to a directory that has them)",
                            path.display()
                        )
                    });
                (*name, Mutex::new(session))
            })
            .collect();
        Self { sessions }
    }

    /// Panics on an unknown name: every adapter requests its own fixed,
    /// known-at-compile-time set of graph names, so a miss here is a
    /// programming error, not a runtime condition.
    pub fn get(&self, name: &str) -> &Mutex<Session> {
        self.sessions
            .iter()
            .find(|(session_name, _)| *session_name == name)
            .map(|(_, session)| session)
            .unwrap_or_else(|| panic!("forecaster: no session named {name}"))
    }
}

/// What an adapter's forward pass produced, before the shared `AlgoOutput`
/// mapping. `evidence` lines are the adapter's own plain reasoning text --
/// `summary_to_output` is what wraps each with the "model opinion:" prefix,
/// so adapters never need to know about that convention themselves.
#[derive(Debug, Clone)]
pub struct ForecastSummary {
    pub forecast_return: f64,
    pub conviction: f64,
    pub evidence: Vec<String>,
}

/// Per-model plug-in shape: input series, context length, normalization,
/// output kind (point vs quantile), and conviction derivation all live in
/// the implementation.
pub trait ForecasterAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn required_lookback(&self) -> usize;
    fn applicable_horizons(&self) -> &'static [Horizon];
    /// Builds the normalized input in Rust (replicating the model's scaler
    /// exactly -- like `kronos_math`), runs the once-loaded sessions,
    /// denormalizes, and summarizes. `None` = Neutral no-op (insufficient
    /// history / missing series).
    fn forecast(&self, ctx: &MarketContext) -> Option<ForecastSummary>;
}

fn model_opinion_line(reason: &str) -> String {
    format!("model opinion: {reason}")
}

/// Tight quantile band relative to a recent-volatility-scaled price level
/// implies a confident forecast; a wide one doesn't. `scale` approximates
/// the "typical" bar range in the same units as `q10`/`q90`/`median`
/// (price-like level * fractional volatility), so `spread / scale` is a
/// dimensionless ratio: 0 at a perfectly tight band, growing without bound
/// as the band widens. `1 / (1 + ratio)` is 1.0 at ratio 0 and strictly
/// decreasing as the ratio grows, landing in `(0, 1]` by construction; the
/// explicit clamp is a defensive backstop for `f64` edge cases (e.g. NaN
/// inputs), not load-bearing for the normal range.
///
/// Consumed by `chronos.rs` and `moirai.rs`; `ttm.rs` derives its own
/// ensemble-agreement conviction instead (`ttm_math::ensemble_summary`), so
/// under `--features ttm` alone (no `chronos`/`moirai`) this has no
/// non-test caller in the crate -- hence the targeted allow rather than
/// leaving it for the removed blanket one.
#[allow(dead_code)]
pub fn conviction_from_quantile_spread(q10: f64, q90: f64, median: f64, recent_vol: f64) -> f64 {
    let spread = (q90 - q10).abs();
    let scale = (median.abs() * recent_vol.abs()).max(1e-12);
    (1.0 / (1.0 + spread / scale)).clamp(0.0, 1.0)
}

/// Shared forecast-sign dead-band -> `Direction` + full `AlgoOutput`. Same
/// 1e-6 dead-band and `magnitude = |forecast_return|` convention (regardless
/// of direction, including Neutral) as `kronos.rs`'s `compute()`.
pub fn summary_to_output(id: &'static str, ctx: &MarketContext, s: ForecastSummary) -> AlgoOutput {
    let direction = if s.forecast_return.abs() < 1e-6 {
        Direction::Neutral
    } else if s.forecast_return > 0.0 {
        Direction::Bullish
    } else {
        Direction::Bearish
    };

    let evidence = s.evidence.into_iter().map(|line| model_opinion_line(&line)).collect();

    AlgoOutput {
        algo_id: id,
        symbol: ctx.symbol.clone(),
        timeframe: ctx.timeframe,
        horizon: ctx.horizon,
        direction,
        magnitude: s.forecast_return.abs(),
        confidence: s.conviction,
        evidence,
        computed_at: ctx.as_of,
    }
}

/// Neutral, magnitude 0. Its single evidence line is wrapped with the
/// shared "model opinion:" prefix -> `"model opinion: <reason>"`, exactly
/// like `kronos.rs`'s no-op, so the "every forecaster evidence line is
/// 'model opinion:'-prefixed" invariant holds on the guard path too.
pub fn no_op(id: &'static str, ctx: &MarketContext, reason: &str) -> AlgoOutput {
    AlgoOutput {
        algo_id: id,
        symbol: ctx.symbol.clone(),
        timeframe: ctx.timeframe,
        horizon: ctx.horizon,
        direction: Direction::Neutral,
        magnitude: 0.0,
        confidence: 0.0,
        evidence: vec![model_opinion_line(reason)],
        computed_at: ctx.as_of,
    }
}

/// Any adapter becomes an `Algorithm`. Models register
/// `ForecastAlgorithm<XAdapter>` via `inventory::submit!` in their own file.
pub struct ForecastAlgorithm<A: ForecasterAdapter> {
    adapter: A,
}

impl<A: ForecasterAdapter> ForecastAlgorithm<A> {
    pub fn new(adapter: A) -> Self {
        Self { adapter }
    }
}

impl<A: ForecasterAdapter> Algorithm for ForecastAlgorithm<A> {
    fn id(&self) -> &'static str {
        self.adapter.id()
    }

    fn required_lookback(&self) -> usize {
        self.adapter.required_lookback()
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        self.adapter.applicable_horizons()
    }

    fn compute(&self, ctx: &MarketContext) -> AlgoOutput {
        match self.adapter.forecast(ctx) {
            Some(summary) => summary_to_output(self.adapter.id(), ctx, summary),
            None => no_op(
                self.adapter.id(),
                ctx,
                &format!("insufficient history for {}", self.adapter.id()),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, Utc};
    use crate::Timeframe;

    fn ctx_at(as_of: DateTime<Utc>) -> MarketContext {
        MarketContext::from_closes("NSE:TEST", Timeframe::Day, Horizon::Positional, vec![100.0, 101.0], as_of)
    }

    #[test]
    fn summary_to_output_maps_positive_return_to_bullish() {
        let as_of = "2024-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = ctx_at(as_of);
        let summary = ForecastSummary {
            forecast_return: 0.02,
            conviction: 0.75,
            evidence: vec!["close 100 -> 102 over 8 bars".to_string()],
        };

        let output = summary_to_output("stub", &ctx, summary);

        assert_eq!(output.direction, Direction::Bullish);
        assert!((output.magnitude - 0.02).abs() < 1e-12);
        assert_eq!(output.confidence, 0.75);
        assert_eq!(output.computed_at, as_of);
        assert!(!output.evidence.is_empty());
        for line in &output.evidence {
            assert!(line.starts_with("model opinion:"), "evidence must be model-opinion-prefixed: {line}");
        }
    }

    #[test]
    fn summary_to_output_maps_negative_return_to_bearish() {
        let as_of = "2024-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = ctx_at(as_of);
        let summary = ForecastSummary {
            forecast_return: -0.02,
            conviction: 0.4,
            evidence: vec!["close 100 -> 98 over 8 bars".to_string()],
        };

        let output = summary_to_output("stub", &ctx, summary);

        assert_eq!(output.direction, Direction::Bearish);
        assert!((output.magnitude - 0.02).abs() < 1e-12);
        for line in &output.evidence {
            assert!(line.starts_with("model opinion:"));
        }
    }

    #[test]
    fn summary_to_output_maps_sub_dead_band_return_to_neutral() {
        let as_of = "2024-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = ctx_at(as_of);
        let tiny_return = 5e-7;
        let summary = ForecastSummary {
            forecast_return: tiny_return,
            conviction: 0.5,
            evidence: vec!["flat forecast".to_string()],
        };

        let output = summary_to_output("stub", &ctx, summary);

        assert_eq!(output.direction, Direction::Neutral);
        // magnitude tracks |forecast_return| regardless of the direction
        // dead-band, same as kronos.rs's compute().
        assert!((output.magnitude - tiny_return.abs()).abs() < 1e-12);
    }

    #[test]
    fn no_op_is_neutral_zero_magnitude_with_prefixed_reason() {
        let as_of = "2024-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = ctx_at(as_of);

        let output = no_op("stub", &ctx, "insufficient history for stub");

        assert_eq!(output.direction, Direction::Neutral);
        assert_eq!(output.magnitude, 0.0);
        assert_eq!(output.confidence, 0.0);
        assert_eq!(output.evidence, vec!["model opinion: insufficient history for stub".to_string()]);
        assert_eq!(output.computed_at, as_of);
    }

    #[test]
    fn conviction_from_quantile_spread_is_one_at_zero_spread() {
        assert_eq!(conviction_from_quantile_spread(100.0, 100.0, 100.0, 0.02), 1.0);
        // Holds even at a degenerate zero median/recent_vol, since the
        // ratio is still 0/scale == 0 regardless of scale's magnitude.
        assert_eq!(conviction_from_quantile_spread(0.0, 0.0, 0.0, 0.0), 1.0);
    }

    #[test]
    fn conviction_from_quantile_spread_decreases_monotonically_as_spread_widens() {
        let median = 100.0;
        let recent_vol = 0.01;
        let spreads = [0.0, 0.5, 2.0, 10.0, 100.0];

        let convictions: Vec<f64> = spreads
            .iter()
            .map(|&half_spread| {
                conviction_from_quantile_spread(median - half_spread, median + half_spread, median, recent_vol)
            })
            .collect();

        for window in convictions.windows(2) {
            assert!(window[1] < window[0], "conviction must strictly decrease as spread widens: {convictions:?}");
        }
    }

    #[test]
    fn conviction_from_quantile_spread_is_clamped_to_unit_interval() {
        let wide = conviction_from_quantile_spread(0.0, 1_000_000.0, 100.0, 0.01);
        assert!((0.0..=1.0).contains(&wide));

        let reversed = conviction_from_quantile_spread(110.0, 90.0, 100.0, 0.01);
        assert!((0.0..=1.0).contains(&reversed));

        let zero_vol = conviction_from_quantile_spread(99.0, 101.0, 100.0, 0.0);
        assert!((0.0..=1.0).contains(&zero_vol));
    }

    struct StubAdapter {
        summary: Option<ForecastSummary>,
    }

    impl ForecasterAdapter for StubAdapter {
        fn id(&self) -> &'static str {
            "stub_adapter"
        }

        fn required_lookback(&self) -> usize {
            2
        }

        fn applicable_horizons(&self) -> &'static [Horizon] {
            &[Horizon::Intraday, Horizon::Positional]
        }

        fn forecast(&self, _ctx: &MarketContext) -> Option<ForecastSummary> {
            self.summary.clone()
        }
    }

    #[test]
    fn forecast_algorithm_delegates_to_no_op_when_adapter_returns_none() {
        let as_of = "2024-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = ctx_at(as_of);
        let algo = ForecastAlgorithm::new(StubAdapter { summary: None });

        assert_eq!(algo.id(), "stub_adapter");
        assert_eq!(algo.required_lookback(), 2);

        let output = algo.compute(&ctx);

        assert_eq!(output.direction, Direction::Neutral);
        assert_eq!(output.magnitude, 0.0);
        for line in &output.evidence {
            assert!(line.starts_with("model opinion:"));
        }
    }

    #[test]
    fn forecast_algorithm_delegates_to_summary_to_output_when_adapter_forecasts() {
        let as_of = "2024-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let ctx = ctx_at(as_of);
        let algo = ForecastAlgorithm::new(StubAdapter {
            summary: Some(ForecastSummary {
                forecast_return: 0.03,
                conviction: 0.6,
                evidence: vec!["synthetic forecast".to_string()],
            }),
        });

        let output = algo.compute(&ctx);

        assert_eq!(output.algo_id, "stub_adapter");
        assert_eq!(output.direction, Direction::Bullish);
        assert!((output.magnitude - 0.03).abs() < 1e-12);
        assert_eq!(output.confidence, 0.6);
    }

    #[test]
    fn forecaster_sessions_get_panics_on_unknown_name() {
        let sessions = ForecasterSessions::load_from_files(&[]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sessions.get("missing")));
        assert!(result.is_err());
    }
}
