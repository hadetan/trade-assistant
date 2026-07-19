use crate::{Algorithm, Direction, Horizon, MarketContext};

pub struct OiBuildupAlgorithm;

impl OiBuildupAlgorithm {
    pub fn new() -> Self {
        Self
    }
}

impl Default for OiBuildupAlgorithm {
    fn default() -> Self {
        Self::new()
    }
}

impl Algorithm for OiBuildupAlgorithm {
    fn id(&self) -> &'static str {
        "oi_buildup"
    }

    fn required_lookback(&self) -> usize {
        0
    }

    fn applicable_horizons(&self) -> &'static [Horizon] {
        &[Horizon::Intraday, Horizon::Positional]
    }

    fn compute(&self, ctx: &MarketContext) -> crate::AlgoOutput {
        let Some(options) = ctx.options.as_ref() else {
            return no_op(ctx);
        };
        if ctx.closes.len() < 2 {
            return no_op(ctx);
        }

        let prev_close = ctx.closes[ctx.closes.len() - 2];
        let close = ctx.closes[ctx.closes.len() - 1];
        let price_up = close > prev_close;
        let oi_up = options.oi > options.prev_oi;

        let label = match (price_up, oi_up) {
            (true, true) => "long buildup",
            (true, false) => "short covering",
            (false, true) => "short buildup",
            (false, false) => "long unwinding",
        };

        let magnitude = if options.prev_oi.abs() < 1e-12 {
            0.0
        } else {
            ((options.oi - options.prev_oi) / options.prev_oi).abs()
        };

        crate::AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction: Direction::Neutral,
            magnitude,
            confidence: 0.0,
            evidence: vec![format!(
                "{} (close {:.2} vs prev {:.2}, oi {:.0} vs prev {:.0})",
                label, close, prev_close, options.oi, options.prev_oi
            )],
            computed_at: ctx.as_of,
        }
    }
}

fn no_op(ctx: &MarketContext) -> crate::AlgoOutput {
    crate::AlgoOutput {
        algo_id: "oi_buildup",
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

inventory::submit! {
    crate::registry::AlgorithmFactory(|| Box::new(OiBuildupAlgorithm::new()))
}
