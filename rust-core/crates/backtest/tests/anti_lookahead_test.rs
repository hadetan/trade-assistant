use algo_core::{Algorithm, AlgoOutput, Direction, Horizon, MarketContext, Timeframe};
use backtest::frontier::context_at;
use chrono::DateTime;
use std::sync::{Arc, Mutex};
use storage::Candle;

fn series(closes: &[f64]) -> Vec<Candle> {
    let base = 1_700_000_000;
    closes
        .iter()
        .enumerate()
        .map(|(i, &c)| Candle { ts: base + i as i64 * 86_400, open: c, high: c, low: c, close: c, volume: 0 })
        .collect()
}

#[test]
fn context_at_reveals_only_up_to_the_frontier() {
    let s = series(&[10.0, 11.0, 12.0, 13.0, 14.0]);
    let ctx = context_at(&s, 2, "NSE:TEST", Timeframe::Day, Horizon::Positional);

    assert_eq!(ctx.closes, vec![10.0, 11.0, 12.0]); // never 13.0/14.0
    assert_eq!(ctx.as_of, DateTime::from_timestamp(s[2].ts, 0).unwrap());
    assert_eq!(ctx.symbol, "NSE:TEST");
}

/// A spy algorithm asserting the anti-lookahead invariant across a full manual
/// walk: it must never observe a future bar. If windowing ever leaked bar i+1
/// (or the whole series) into an earlier decision, the poison value would appear
/// and this test would FAIL.
struct Spy {
    max_len: Arc<Mutex<usize>>,
    saw_poison: Arc<Mutex<bool>>,
}
impl Algorithm for Spy {
    fn id(&self) -> &'static str { "spy" }
    fn required_lookback(&self) -> usize { 1 }
    fn applicable_horizons(&self) -> &'static [Horizon] { &[Horizon::Positional] }
    fn compute(&self, ctx: &MarketContext) -> AlgoOutput {
        let mut m = self.max_len.lock().unwrap();
        *m = (*m).max(ctx.closes.len());
        if ctx.closes.contains(&999_999.0) {
            *self.saw_poison.lock().unwrap() = true;
        }
        AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction: Direction::Neutral,
            magnitude: 0.0,
            confidence: 0.0,
            evidence: vec![],
            computed_at: ctx.as_of,
        }
    }
}

#[test]
fn frontier_walk_never_leaks_a_future_bar_into_compute() {
    // Last bar is a poison spike; horizon 1 means the last decision frontier is
    // index len-2, so the poison bar (index len-1) is never visible to compute().
    let s = series(&[10.0, 11.0, 12.0, 13.0, 14.0, 999_999.0]);
    let horizon_bars = 1;
    let spy = Spy { max_len: Arc::new(Mutex::new(0)), saw_poison: Arc::new(Mutex::new(false)) };

    for i in 0..s.len() {
        if i + horizon_bars >= s.len() {
            break;
        }
        let ctx = context_at(&s, i, "NSE:TEST", Timeframe::Day, Horizon::Positional);
        let _ = spy.compute(&ctx);
    }

    assert!(!*spy.saw_poison.lock().unwrap(), "future poison bar leaked into a decision");
    assert_eq!(*spy.max_len.lock().unwrap(), 5, "max visible window is [0..=4], never the poison bar");
}
