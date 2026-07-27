use algo_core::confluence::ScorecardSummary;
use algo_core::scan_gate::{evaluate_scan_gate, GateDecision, GateThresholds};

fn summary(bullish: usize, bearish: usize, neutral: usize, weighted_vote: f64) -> ScorecardSummary {
    ScorecardSummary { bullish_count: bullish, bearish_count: bearish, neutral_count: neutral, weighted_vote }
}

#[test]
fn first_ever_scan_of_a_symbol_is_worth_a_look() {
    let curr = summary(5, 2, 10, 0.12);
    assert_eq!(evaluate_scan_gate(None, &curr, &GateThresholds::default()), GateDecision::WorthLook);
}

#[test]
fn first_ever_scan_with_zero_algorithm_outputs_is_no_change() {
    // Proves the zero-total guard runs before the prev.is_none() check.
    let curr = summary(0, 0, 0, 0.0);
    assert_eq!(evaluate_scan_gate(None, &curr, &GateThresholds::default()), GateDecision::NoChange);
}

#[test]
fn identical_scorecards_are_no_change() {
    let prev = summary(5, 2, 10, 0.12);
    let curr = summary(5, 2, 10, 0.12);
    assert_eq!(evaluate_scan_gate(Some(&prev), &curr, &GateThresholds::default()), GateDecision::NoChange);
}

#[test]
fn a_moderate_vote_swing_crosses_into_worth_look() {
    // vote_delta = 0.15, strictly between 0.10 and 0.25; counts unchanged.
    let prev = summary(3, 3, 4, 0.10);
    let curr = summary(3, 3, 4, 0.25);
    assert_eq!(evaluate_scan_gate(Some(&prev), &curr, &GateThresholds::default()), GateDecision::WorthLook);
}

#[test]
fn a_large_vote_swing_crosses_into_worth_ai_call() {
    // vote_delta = 0.30 >= 0.25; counts unchanged.
    let prev = summary(3, 3, 4, 0.10);
    let curr = summary(3, 3, 4, 0.40);
    assert_eq!(evaluate_scan_gate(Some(&prev), &curr, &GateThresholds::default()), GateDecision::WorthAiCall);
}

#[test]
fn exactly_the_worth_look_threshold_counts_as_worth_look() {
    // vote_delta = 0.10 exactly; proves the comparison is inclusive `>=`.
    let prev = summary(3, 3, 4, 0.10);
    let curr = summary(3, 3, 4, 0.20);
    assert_eq!(evaluate_scan_gate(Some(&prev), &curr, &GateThresholds::default()), GateDecision::WorthLook);
}

#[test]
fn exactly_the_worth_ai_call_threshold_counts_as_worth_ai_call() {
    // vote_delta = 0.25 exactly; proves the comparison is inclusive `>=`.
    let prev = summary(3, 3, 4, 0.10);
    let curr = summary(3, 3, 4, 0.35);
    assert_eq!(evaluate_scan_gate(Some(&prev), &curr, &GateThresholds::default()), GateDecision::WorthAiCall);
}

#[test]
fn a_quiet_vote_with_a_loud_count_flip_still_escalates() {
    // weighted_vote barely moves (0.50 -> 0.52, vote_delta 0.02, below even
    // worth_look_delta) but the net directional count swings hard: net ratio
    // 0.0 -> 0.8, net_delta 0.8. A vote-only formula would call this NoChange;
    // the max() combination makes it WorthAiCall.
    let prev = summary(5, 5, 0, 0.50);
    let curr = summary(9, 1, 0, 0.52);
    assert_eq!(evaluate_scan_gate(Some(&prev), &curr, &GateThresholds::default()), GateDecision::WorthAiCall);
}

#[test]
fn below_both_thresholds_is_no_change() {
    // vote_delta = 0.06 (one algorithm's worth), counts unchanged -> NoChange.
    let prev = summary(3, 3, 4, 0.10);
    let curr = summary(3, 3, 4, 0.16);
    assert_eq!(evaluate_scan_gate(Some(&prev), &curr, &GateThresholds::default()), GateDecision::NoChange);
}
