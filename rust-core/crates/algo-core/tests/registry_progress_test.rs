use algo_core::registry::{all_for_binary, run_applicable, run_applicable_with_progress};
use algo_core::MarketContext;
use chrono::Utc;

fn ctx(n: usize) -> MarketContext {
    let closes: Vec<f64> = (0..n).map(|i| 100.0 + i as f64).collect();
    MarketContext::from_closes("NSE:INFY", algo_core::Timeframe::Day, algo_core::Horizon::Positional, closes, Utc::now())
}

#[test]
fn invokes_callback_running_then_done_per_algorithm_in_registry_order_and_matches_run_applicable() {
    let algos = all_for_binary();
    let ctx = ctx(60);
    let mut events: Vec<(String, bool)> = Vec::new();
    let with = run_applicable_with_progress(&algos, &ctx, &mut |id, done| events.push((id.to_string(), done)));
    let plain = run_applicable(&algos, &ctx);

    // identical outputs
    assert_eq!(with.len(), plain.len());
    // exactly one (id,false) immediately before each (id,true), same order as outputs
    let expected: Vec<(String, bool)> = with
        .iter()
        .flat_map(|o| vec![(o.algo_id.to_string(), false), (o.algo_id.to_string(), true)])
        .collect();
    assert_eq!(events, expected);
}
