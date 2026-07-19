use crate::{classify_by_distance, AlgoOutput, Algorithm, Direction, Horizon, MarketContext};
use std::collections::BTreeMap;

pub struct VolumeProfileAlgorithm {
    bin_width: f64,
}

impl VolumeProfileAlgorithm {
    pub fn new(bin_width: f64) -> Self {
        Self { bin_width }
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
            evidence: vec!["insufficient OHLCV".into()],
            computed_at: ctx.as_of,
        }
    }
}

impl Algorithm for VolumeProfileAlgorithm {
    fn id(&self) -> &'static str {
        "volume_profile"
    }

    fn required_lookback(&self) -> usize {
        1
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> AlgoOutput {
        let lookback = self.required_lookback();
        if ctx.highs.len() < lookback || ctx.lows.len() < lookback || ctx.volumes.len() < lookback
        {
            return self.no_op(ctx);
        }

        let n = ctx.highs.len().min(ctx.lows.len()).min(ctx.volumes.len());
        let mut bins: BTreeMap<i64, f64> = BTreeMap::new();

        for i in 0..n {
            let low = ctx.lows[i];
            let high = ctx.highs[i];
            let volume = ctx.volumes[i];
            if volume <= 0.0 {
                continue;
            }
            let range = high - low;
            if range <= 0.0 {
                let bin = (low / self.bin_width).floor() as i64;
                *bins.entry(bin).or_insert(0.0) += volume;
                continue;
            }

            // Distribute the bar's volume by overlap-fraction of [low,high) with
            // each touched bin, not an equal split per touched bin (design §6.2:
            // an equal split misprices a bar that barely clips a bin).
            let start_bin = (low / self.bin_width).floor() as i64;
            let end_bin = (high / self.bin_width).ceil() as i64 - 1;
            for bin in start_bin..=end_bin {
                let bin_low = bin as f64 * self.bin_width;
                let bin_high = bin_low + self.bin_width;
                let overlap = (high.min(bin_high) - low.max(bin_low)).max(0.0);
                if overlap <= 0.0 {
                    continue;
                }
                *bins.entry(bin).or_insert(0.0) += volume * (overlap / range);
            }
        }

        let (poc_bin, poc_volume) = bins
            .iter()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .map(|(bin, vol)| (*bin, *vol))
            .unwrap_or((0, 0.0));
        let poc_low = poc_bin as f64 * self.bin_width;
        let poc_high = poc_low + self.bin_width;
        let poc_mid = poc_low + self.bin_width / 2.0;

        let latest_close = *ctx.closes.last().unwrap();
        let (direction, confidence) = classify_by_distance(latest_close, poc_mid);

        AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude: poc_volume,
            confidence,
            evidence: vec![format!(
                "POC bin [{:.2},{:.2}) mid {:.2} volume {:.2}",
                poc_low, poc_high, poc_mid, poc_volume
            )],
            computed_at: ctx.as_of,
        }
    }
}

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(VolumeProfileAlgorithm::new(1.0)))
}
