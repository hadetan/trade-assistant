use crate::frontier::context_at;
use algo_core::{registry::run_applicable, Algorithm, Direction, Horizon, Timeframe};
use std::collections::{BTreeMap, HashMap};
use storage::Candle;

#[derive(Debug, Clone)]
pub struct AlgoStats {
    pub algo_id: String,
    pub directional_calls: usize,
    pub hits: usize,
    pub sum_signed_return: f64,
}

impl AlgoStats {
    pub fn hit_rate(&self) -> f64 {
        if self.directional_calls == 0 { 0.0 } else { self.hits as f64 / self.directional_calls as f64 }
    }
    pub fn expectancy(&self) -> f64 {
        if self.directional_calls == 0 { 0.0 } else { self.sum_signed_return / self.directional_calls as f64 }
    }
}

#[derive(Debug, Clone)]
pub struct ReplayReport {
    pub per_algo: Vec<AlgoStats>,
}

impl ReplayReport {
    pub fn stat(&self, algo_id: &str) -> Option<&AlgoStats> {
        self.per_algo.iter().find(|s| s.algo_id == algo_id)
    }

    /// Per-algorithm hit-rate as the weight map `compute_confluence` accepts. In
    /// the catalog phase these replace the sidecar handler's equal-weight
    /// placeholder (design §6.3); here they prove the type-level bridge.
    pub fn hit_rate_weights(&self) -> HashMap<String, f64> {
        self.per_algo.iter().map(|s| (s.algo_id.clone(), s.hit_rate())).collect()
    }
}

/// Walk `series` forward one bar at a time. At each frontier i (that has a future
/// bar at i + horizon_bars), reveal only series[0..=i] to compute() via the shared
/// run_applicable gate, then score each directional output against the realized
/// move to series[i + horizon_bars]. Reuses registry algorithms unchanged.
pub fn run_replay(
    series: &[Candle],
    algos: &[Box<dyn Algorithm>],
    horizon_bars: usize,
    symbol: &str,
    timeframe: Timeframe,
) -> ReplayReport {
    let mut stats: BTreeMap<String, AlgoStats> = BTreeMap::new();

    for i in 0..series.len() {
        if i + horizon_bars >= series.len() {
            break;
        }
        let ctx = context_at(series, i, symbol, timeframe, Horizon::Positional);
        let outputs = run_applicable(algos, &ctx);

        let current = series[i].close;
        let future = series[i + horizon_bars].close;
        for output in outputs {
            let sign = match output.direction {
                Direction::Bullish => 1.0,
                Direction::Bearish => -1.0,
                Direction::Neutral => continue,
            };
            let signed_return = sign * (future - current) / current;
            let entry = stats.entry(output.algo_id.to_string()).or_insert_with(|| AlgoStats {
                algo_id: output.algo_id.to_string(),
                directional_calls: 0,
                hits: 0,
                sum_signed_return: 0.0,
            });
            entry.directional_calls += 1;
            if signed_return > 0.0 {
                entry.hits += 1;
            }
            entry.sum_signed_return += signed_return;
        }
    }

    ReplayReport { per_algo: stats.into_values().collect() }
}
