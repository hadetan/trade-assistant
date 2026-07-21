use crate::protocol::{
    AlgoResultWire, ComputeRequest, ComputeResponse, ConfluenceWire, PersistCandlesRequest, PersistCandlesResponse,
};
use algo_core::{confluence::compute_confluence, registry::{self, run_applicable}, Horizon, MarketContext, Timeframe};
use chrono::Utc;
use std::collections::HashMap;
use storage::{Candle, CandleStore};

pub fn handle_request(request: ComputeRequest) -> ComputeResponse {
    let timeframe = match request.timeframe.as_str() {
        "minute" => Timeframe::Minute,
        "5minute" => Timeframe::FiveMinute,
        "15minute" => Timeframe::FifteenMinute,
        _ => Timeframe::Day,
    };

    // Backtest-only per design Q2: the live sidecar path has no OHLCV/options
    // feed yet, so every extra field stays empty/None via from_closes.
    let ctx = MarketContext::from_closes(request.symbol.clone(), timeframe, Horizon::Positional, request.closes, Utc::now());

    // Route every compute() call through the one shared lookback gate
    // (algo_core::registry::run_applicable) so the sidecar and the backtest
    // engine cannot drift on the insufficient-history contract.
    //
    // registry::all_for_binary() is the release-safe algo list (see its doc
    // comment in registry.rs); the sidecar must not use registry::all() alone.
    let algos = registry::all_for_binary();
    let outputs = run_applicable(&algos, &ctx);

    // Phase 1 uses equal weights for every algorithm; a later phase's
    // backtest engine supplies real rolling-hit-rate weights here instead.
    let weights: HashMap<&str, f64> = HashMap::new();
    let confluence = compute_confluence(&outputs, &weights);

    let algo_results = outputs
        .iter()
        .map(|output| AlgoResultWire {
            algo_id: output.algo_id.to_string(),
            direction: format!("{:?}", output.direction),
            confidence: output.confidence,
            evidence: output.evidence.clone(),
        })
        .collect();

    ComputeResponse {
        id: request.id,
        algo_results,
        confluence: ConfluenceWire {
            bullish_count: confluence.bullish_count,
            bearish_count: confluence.bearish_count,
            neutral_count: confluence.neutral_count,
            weighted_vote: confluence.weighted_vote,
        },
    }
}

pub fn handle_persist(store: &CandleStore, request: PersistCandlesRequest) -> PersistCandlesResponse {
    let candles: Vec<Candle> = request
        .candles
        .iter()
        .map(|c| Candle {
            ts: c.ts,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
        })
        .collect();

    match store.write_sourced_candles(&request.symbol, &request.timeframe, &request.source, &candles) {
        Ok(()) => PersistCandlesResponse { id: request.id, written: candles.len(), error: None },
        Err(e) => PersistCandlesResponse { id: request.id, written: 0, error: Some(e.to_string()) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn closes_seq(n: usize) -> Vec<f64> {
        (0..n).map(|i| 100.0 + i as f64).collect()
    }

    fn request(id: u64, closes: Vec<f64>) -> ComputeRequest {
        ComputeRequest {
            id,
            symbol: "NSE:NEWLISTING".to_string(),
            timeframe: "day".to_string(),
            closes,
        }
    }

    #[test]
    fn skips_algorithms_without_enough_lookback_instead_of_panicking() {
        // 15 closes: enough for every algorithm with required_lookback <= 15
        // (rsi included) out of the full 34-algorithm default catalog, but
        // short of e.g. sma/ema's required_lookback of 20. Before the fix,
        // calling sma/ema here underflowed `closes.len() - period` and
        // panicked the whole process.
        let response = handle_request(request(42, closes_seq(15)));

        assert_eq!(response.id, 42);
        assert_eq!(response.algo_results.len(), 24);
        assert!(response.algo_results.iter().any(|r| r.algo_id == "rsi"));
    }

    #[test]
    fn empty_closes_yields_well_formed_zeroed_response() {
        // Zero closes still satisfies the options/OI overlays' lookback of 0
        // (bsm_greeks, implied_vol, max_pain, oi_buildup, put_call_ratio),
        // which no-op to Neutral internally on the missing options context
        // rather than being filtered out by run_applicable. Every
        // closes-based algorithm is filtered out, so handle_request must
        // still return a well-formed response, not panic.
        let response = handle_request(request(7, vec![]));

        assert_eq!(response.id, 7);
        assert_eq!(response.algo_results.len(), 5);
        assert!(response.algo_results.iter().all(|r| r.direction == "Neutral"));
        assert_eq!(response.confluence.bullish_count, 0);
        assert_eq!(response.confluence.bearish_count, 0);
        assert_eq!(response.confluence.neutral_count, 5);
        assert!(!response.confluence.weighted_vote.is_nan());
    }

    #[test]
    fn sufficient_closes_runs_every_algorithm_applicable_at_that_lookback() {
        // 21 closes clears the 3 Phase-1 algorithms (rsi/sma/ema, lookback
        // <= 20) plus every catalog algorithm requiring <= 21 bars; adx (28),
        // garch (30), macd (35), and ichimoku (52) are the only default-
        // catalog algorithms still excluded at this length.
        let response = handle_request(request(1, closes_seq(21)));

        assert_eq!(response.algo_results.len(), 30);
    }

    #[test]
    fn handle_persist_writes_candles_that_read_back_from_the_kite_source() {
        use storage::CandleStore;
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        let store = CandleStore::open(dir.path()).unwrap();

        let request = crate::protocol::PersistCandlesRequest {
            id: 11,
            symbol: "NSE:INFY".to_string(),
            timeframe: "day".to_string(),
            source: "kite".to_string(),
            candles: vec![crate::protocol::CandleWire {
                ts: 1_710_000_000,
                open: 1.0,
                high: 2.0,
                low: 0.5,
                close: 1.5,
                volume: 100,
            }],
        };

        let response = handle_persist(&store, request);

        assert_eq!(response.id, 11);
        assert_eq!(response.written, 1);
        assert!(response.error.is_none());

        let stored = store.read_sourced_candles("NSE:INFY", "day", "kite").unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].close, 1.5);
    }
}
