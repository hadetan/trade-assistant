use crate::{AlgoOutput, Algorithm, MarketContext};

pub struct AlgorithmFactory(pub fn() -> Box<dyn Algorithm>);

inventory::collect!(AlgorithmFactory);

pub fn all() -> Vec<Box<dyn Algorithm>> {
    inventory::iter::<AlgorithmFactory>()
        .map(|factory| (factory.0)())
        .collect()
}

/// `inventory::submit!` in each feature-gated forecaster module (kronos/ttm/
/// chronos/moirai) only stays linked into a binary if the linker sees that
/// module used from somewhere. A release build's dead-code-stripping pass
/// removes any such module (and its `inventory::submit!`) when nothing else
/// in the binary references it -- so `registry::all()` silently omits every
/// forecaster from `replay`/`sidecar` release binaries despite the crate
/// compiling fine and lib tests passing (tests build in dev profile, which
/// doesn't strip). Constructing each forecaster's `Algorithm` here directly
/// forces a real reference into each module, keeping it linked. Callers must
/// union this with `all()` (dedup by id) rather than use it alone, since
/// `all()` still owns every non-forecaster algorithm.
// Each push is `#[cfg]`-gated, so a `vec![]` literal can't express the
// conditional set -- Vec::new() + gated pushes is the correct shape here.
#[allow(clippy::vec_init_then_push)]
pub fn ensure_forecasters_linked() -> Vec<Box<dyn Algorithm>> {
    let mut v: Vec<Box<dyn Algorithm>> = Vec::new();
    #[cfg(feature = "kronos")]
    v.push(Box::new(crate::forecast::kronos::KronosAlgorithm::new()));
    #[cfg(feature = "ttm")]
    v.push(Box::new(crate::forecast::framework::ForecastAlgorithm::new(
        crate::forecast::ttm::TtmAdapter::new(),
    )));
    #[cfg(feature = "chronos")]
    v.push(Box::new(crate::forecast::framework::ForecastAlgorithm::new(
        crate::forecast::chronos::ChronosAdapter::new(),
    )));
    #[cfg(feature = "moirai")]
    v.push(Box::new(crate::forecast::framework::ForecastAlgorithm::new(
        crate::forecast::moirai::MoiraiAdapter::new(),
    )));
    v
}

/// The real algo list a release binary must run against: `all()` unioned
/// with `ensure_forecasters_linked()`, deduped by id. Every `compute()`
/// caller outside this crate's tests (the sidecar handler, the backtest
/// replay bin) needs this union rather than `all()` alone, per
/// `ensure_forecasters_linked`'s doc comment above -- so the union lives
/// here once instead of being re-derived at each call site.
pub fn all_for_binary() -> Vec<Box<dyn Algorithm>> {
    let mut algos = all();
    for extra in ensure_forecasters_linked() {
        if !algos.iter().any(|a| a.id() == extra.id()) {
            algos.push(extra);
        }
    }
    algos
}

/// The single enforcement point for `Algorithm::compute`'s history precondition.
/// An algorithm whose `required_lookback()` exceeds `ctx.closes.len()` has no
/// opinion to offer and would panic on its own slice arithmetic if called, so it
/// is skipped. Every `compute()` caller (the sidecar handler and the backtest
/// engine) MUST route through this function rather than calling `compute()`
/// directly, so the precondition is checked in exactly one place.
pub fn run_applicable(algos: &[Box<dyn Algorithm>], ctx: &MarketContext) -> Vec<AlgoOutput> {
    algos
        .iter()
        .filter(|algo| algo.required_lookback() <= ctx.closes.len())
        .map(|algo| algo.compute(ctx))
        .collect()
}
