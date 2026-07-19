use crate::{AlgoOutput, Algorithm, MarketContext};

pub struct AlgorithmFactory(pub fn() -> Box<dyn Algorithm>);

inventory::collect!(AlgorithmFactory);

pub fn all() -> Vec<Box<dyn Algorithm>> {
    inventory::iter::<AlgorithmFactory>()
        .map(|factory| (factory.0)())
        .collect()
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
