use crate::{AlgoOutput, Algorithm, Direction, Horizon, MarketContext};

/// Higher-TF trend gets 2x the base-TF's weight: a trend that has survived a
/// longer aggregation window carries more structural weight in a confluence
/// vote than the (noisier) base-TF trend alone. Bespoke weighting -- design
/// §6.2 notes no standard formula for MTF confluence.
const BASE_TF_WEIGHT: f64 = 1.0;
const HIGHER_TF_WEIGHT: f64 = 2.0;

#[derive(Default)]
pub struct ConfluenceMtfAlgorithm;

impl ConfluenceMtfAlgorithm {
    pub fn new() -> Self {
        Self
    }
}

impl Algorithm for ConfluenceMtfAlgorithm {
    fn id(&self) -> &'static str {
        "confluence_mtf"
    }

    fn required_lookback(&self) -> usize {
        2
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> AlgoOutput {
        // Most callers don't supply a higher-TF series (algorithm-catalog
        // plan R4): no-op rather than panic on the missing context, the
        // same convention as the peer-absent case for cointegration/OU.
        let higher = match ctx.higher_tf.as_ref() {
            Some(h) if !h.closes.is_empty() => h,
            _ => {
                return AlgoOutput {
                    algo_id: self.id(),
                    symbol: ctx.symbol.clone(),
                    timeframe: ctx.timeframe,
                    horizon: ctx.horizon,
                    direction: Direction::Neutral,
                    magnitude: 0.0,
                    confidence: 0.0,
                    evidence: vec!["no higher-timeframe context available".into()],
                    computed_at: ctx.as_of,
                };
            }
        };

        let base_vote = trend_vote(&ctx.closes);
        let higher_vote = trend_vote(&higher.closes);

        let weighted_sum = BASE_TF_WEIGHT * base_vote + HIGHER_TF_WEIGHT * higher_vote;
        let total_weight = BASE_TF_WEIGHT + HIGHER_TF_WEIGHT;
        let normalized = weighted_sum / total_weight;

        let direction = if normalized > 1e-9 {
            Direction::Bullish
        } else if normalized < -1e-9 {
            Direction::Bearish
        } else {
            Direction::Neutral
        };

        AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude: normalized.abs(),
            confidence: normalized.abs(),
            evidence: vec![
                format!("base TF vote {:+.0} (weight {:.1})", base_vote, BASE_TF_WEIGHT),
                format!(
                    "higher TF vote {:+.0} (weight {:.1})",
                    higher_vote, HIGHER_TF_WEIGHT
                ),
                format!(
                    "weighted sum {:+.4}/{:.1} = {:+.4}",
                    weighted_sum, total_weight, normalized
                ),
            ],
            computed_at: ctx.as_of,
        }
    }
}

fn trend_vote(closes: &[f64]) -> f64 {
    let sma = closes.iter().sum::<f64>() / closes.len() as f64;
    let latest = *closes.last().unwrap();
    if latest > sma {
        1.0
    } else if latest < sma {
        -1.0
    } else {
        0.0
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(ConfluenceMtfAlgorithm::new()))
}
