use algo_core::{Algorithm, AlgoOutput, Direction, Horizon, MarketContext, Timeframe};
use backtest::engine::run_replay;
use storage::Candle;

/// Bullish if the last close rose vs the prior close, Bearish if it fell.
/// required_lookback = 2 so it is skipped at frontier 0 (only 1 close visible).
struct LastDiffProbe;
impl Algorithm for LastDiffProbe {
    fn id(&self) -> &'static str { "last_diff_probe" }
    fn required_lookback(&self) -> usize { 2 }
    fn applicable_horizons(&self) -> &'static [Horizon] { &[Horizon::Positional] }
    fn compute(&self, ctx: &MarketContext) -> AlgoOutput {
        let n = ctx.closes.len();
        let direction = if ctx.closes[n - 1] > ctx.closes[n - 2] { Direction::Bullish } else { Direction::Bearish };
        AlgoOutput {
            algo_id: self.id(),
            symbol: ctx.symbol.clone(),
            timeframe: ctx.timeframe,
            horizon: ctx.horizon,
            direction,
            magnitude: 0.0,
            confidence: 0.0,
            evidence: vec![],
            computed_at: ctx.as_of,
        }
    }
}

fn series(closes: &[f64]) -> Vec<Candle> {
    let base = 1_700_000_000;
    closes
        .iter()
        .enumerate()
        .map(|(i, &c)| Candle { ts: base + i as i64 * 86_400, open: c, high: c, low: c, close: c, volume: 0 })
        .collect()
}

#[test]
fn probe_hit_rate_and_expectancy_match_hand_derivation() {
    // closes:   c0=10 c1=11 c2=10 c3=12 c4=13 c5=11, horizon_bars=1.
    // Decision frontiers (need >=2 closes AND a bar at i+1): i = 1,2,3,4.
    //   i=1 diff c1-c0=+1 -> Bullish; future c2=10 vs c1=11 -> down  -> MISS; ret=+1*(10-11)/11 = -1/11
    //   i=2 diff c2-c1=-1 -> Bearish; future c3=12 vs c2=10 -> up    -> MISS; ret=-1*(12-10)/10 = -1/5
    //   i=3 diff c3-c2=+2 -> Bullish; future c4=13 vs c3=12 -> up    -> HIT ; ret=+1*(13-12)/12 = +1/12
    //   i=4 diff c4-c3=+1 -> Bullish; future c5=11 vs c4=13 -> down  -> MISS; ret=+1*(11-13)/13 = -2/13
    // hits=1, directional_calls=4 -> hit_rate = 0.25
    // sum = -1/11 - 1/5 + 1/12 - 2/13 = -3101/8580 ; expectancy = sum/4 = -3101/34320 = -0.0903555...
    let s = series(&[10.0, 11.0, 10.0, 12.0, 13.0, 11.0]);
    let algos: Vec<Box<dyn Algorithm>> = vec![Box::new(LastDiffProbe)];

    let report = run_replay(&s, &algos, 1, "NSE:TEST", Timeframe::Day);
    let stat = report.stat("last_diff_probe").unwrap();

    assert_eq!(stat.directional_calls, 4);
    assert_eq!(stat.hits, 1);
    assert!((stat.hit_rate() - 0.25).abs() < 1e-12);
    assert!((stat.expectancy() - (-0.090_355_5)).abs() < 1e-5);
}

#[test]
fn zero_close_bar_is_skipped_and_never_poisons_sum_signed_return_with_nan() {
    // closes: c0=10 c1=11 c2=0 c3=0 c4=13, horizon_bars=1.
    // i=1: diff c1-c0=+1 -> Bullish; current=11 (nonzero) -> counted normally.
    // i=2: diff c2-c1=-11 -> Bearish; current=0 -> must be skipped, else
    //      signed_return = -1*(future(0)-current(0))/current(0) = -1*(0/0) = NaN.
    // i=3: diff c3-c2=0 -> Bearish (tie); current=0 -> skipped for the same reason.
    let s = series(&[10.0, 11.0, 0.0, 0.0, 13.0]);
    let algos: Vec<Box<dyn Algorithm>> = vec![Box::new(LastDiffProbe)];

    let report = run_replay(&s, &algos, 1, "NSE:TEST", Timeframe::Day);
    let stat = report.stat("last_diff_probe").unwrap();

    assert_eq!(stat.directional_calls, 1, "only the i=1 bar has a nonzero current close");
    assert!(!stat.sum_signed_return.is_nan(), "a zero-close bar must never poison sum_signed_return with NaN");
    assert!(!stat.expectancy().is_nan());
}

#[test]
#[should_panic(expected = "ascending")]
fn run_replay_asserts_series_is_ascending_by_ts() {
    let mut s = series(&[10.0, 11.0, 12.0]);
    // Corrupt the timestamps so bar 1 precedes bar 0 -- anti-lookahead windowing
    // assumes strictly-non-decreasing ts; this must fail loudly, not silently
    // window the wrong bars.
    s.swap(0, 1);
    let algos: Vec<Box<dyn Algorithm>> = vec![Box::new(LastDiffProbe)];

    run_replay(&s, &algos, 1, "NSE:TEST", Timeframe::Day);
}
