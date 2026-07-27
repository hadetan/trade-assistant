use crate::confluence::ScorecardSummary;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateDecision {
    NoChange,
    WorthLook,
    WorthAiCall,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GateThresholds {
    pub worth_look_delta: f64,
    pub worth_ai_call_delta: f64,
}

impl Default for GateThresholds {
    // 0.10 ~= a couple of algorithms' net directional change under today's
    // equal-weight scheme (one flip moves weighted_vote ~2/34 ~= 0.06); 0.25
    // ~= four-plus algorithms' worth. Documented starting points, not tied
    // permanently to "34" -- see the phase 5d design doc P5d§4.1.
    fn default() -> Self {
        Self { worth_look_delta: 0.10, worth_ai_call_delta: 0.25 }
    }
}

// Guards the inclusive `>=` threshold comparisons below against IEEE-754
// subtraction error: e.g. 0.35_f64 - 0.10_f64 == 0.24999999999999997, not
// 0.25, which would otherwise misclassify an exact-threshold delta one tier
// too low.
const THRESHOLD_EPSILON: f64 = 1e-9;

fn net_count_ratio(summary: &ScorecardSummary) -> f64 {
    let total = (summary.bullish_count + summary.bearish_count + summary.neutral_count) as f64;
    if total == 0.0 {
        return 0.0;
    }
    (summary.bullish_count as f64 - summary.bearish_count as f64) / total
}

pub fn evaluate_scan_gate(
    prev: Option<&ScorecardSummary>,
    curr: &ScorecardSummary,
    thresholds: &GateThresholds,
) -> GateDecision {
    let curr_total = curr.bullish_count + curr.bearish_count + curr.neutral_count;
    if curr_total == 0 {
        // No algorithm produced an opinion this tick (e.g. insufficient
        // history) -- nothing real to compare or show, so this never counts as
        // a change regardless of what `prev` was. Without this guard a data gap
        // (weighted_vote defaults to 0.0) would look like "everything flipped".
        return GateDecision::NoChange;
    }

    let Some(prev) = prev else {
        // First-ever scan of this symbol: no baseline to diff, but the user
        // wants at least one read rather than a permanent silent swallow.
        return GateDecision::WorthLook;
    };

    let vote_delta = (curr.weighted_vote - prev.weighted_vote).abs();
    let net_delta = (net_count_ratio(curr) - net_count_ratio(prev)).abs();
    let gate_delta = vote_delta.max(net_delta);

    if gate_delta >= thresholds.worth_ai_call_delta - THRESHOLD_EPSILON {
        GateDecision::WorthAiCall
    } else if gate_delta >= thresholds.worth_look_delta - THRESHOLD_EPSILON {
        GateDecision::WorthLook
    } else {
        GateDecision::NoChange
    }
}
