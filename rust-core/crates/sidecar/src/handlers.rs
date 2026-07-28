use crate::protocol::{
    benchmark_empty_response, AddWatchlistSymbolRequest, AlgoResultWire, BenchmarkComputeRequest,
    BenchmarkComputeResponse, CandleWire, ComputeRequest, ComputeResponse, ConfluenceWire,
    EvaluateScanGateRequest, EvaluateScanGateStatelessRequest, LakeCandlesResponse, LakeSymbolWire,
    LakeSymbolsResponse, ListLakeSymbolsRequest, ListWatchlistRequest, PersistCandlesRequest,
    PersistCandlesResponse, ReadLakeCandlesRequest, RemoveWatchlistSymbolRequest, ScanGateResponse,
    WatchlistResponse,
};
use algo_core::confluence::{compute_confluence, ScorecardSummary};
use algo_core::scan_gate::{evaluate_scan_gate, GateThresholds};
use algo_core::{registry::{self, run_applicable}, AlgoOutput, Horizon, MarketContext, Timeframe};
use backtest::frontier::context_at;
use chrono::Utc;
use std::collections::HashMap;
use storage::{Candle, CandleStore, ConfluenceSnapshot, LakeSymbolEntry, StateStore};

fn timeframe_to_wire(timeframe: Timeframe) -> &'static str {
    match timeframe {
        Timeframe::Minute => "minute",
        Timeframe::FiveMinute => "5minute",
        Timeframe::FifteenMinute => "15minute",
        Timeframe::Day => "day",
    }
}

fn horizon_to_wire(horizon: Horizon) -> &'static str {
    match horizon {
        Horizon::Intraday => "intraday",
        Horizon::Positional => "positional",
    }
}

fn algo_output_to_wire(output: &AlgoOutput) -> AlgoResultWire {
    AlgoResultWire {
        algo_id: output.algo_id.to_string(),
        symbol: output.symbol.clone(),
        timeframe: timeframe_to_wire(output.timeframe).to_string(),
        horizon: horizon_to_wire(output.horizon).to_string(),
        direction: format!("{:?}", output.direction),
        magnitude: output.magnitude,
        confidence: output.confidence,
        evidence: output.evidence.clone(),
        computed_at: output.computed_at.to_rfc3339(),
    }
}

fn confluence_to_wire(summary: &ScorecardSummary) -> ConfluenceWire {
    ConfluenceWire {
        bullish_count: summary.bullish_count,
        bearish_count: summary.bearish_count,
        neutral_count: summary.neutral_count,
        weighted_vote: summary.weighted_vote,
    }
}

fn candle_to_wire(c: &Candle) -> CandleWire {
    CandleWire { ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }
}

fn lake_entry_to_wire(e: &LakeSymbolEntry) -> LakeSymbolWire {
    LakeSymbolWire {
        symbol: e.symbol.clone(),
        timeframe: e.timeframe.clone(),
        source: e.source.clone(),
        from_ts: e.from_ts,
        to_ts: e.to_ts,
        candle_count: e.candle_count,
    }
}

fn parse_timeframe(s: &str) -> Timeframe {
    match s {
        "minute" => Timeframe::Minute,
        "5minute" => Timeframe::FiveMinute,
        "15minute" => Timeframe::FifteenMinute,
        _ => Timeframe::Day,
    }
}

fn parse_horizon(s: &str) -> Horizon {
    if s == "intraday" {
        Horizon::Intraday
    } else {
        Horizon::Positional
    }
}

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

    let algo_results = outputs.iter().map(algo_output_to_wire).collect();

    ComputeResponse {
        id: request.id,
        algo_results,
        confluence: confluence_to_wire(&confluence),
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

fn wire_to_scorecard(wire: &ConfluenceWire) -> ScorecardSummary {
    ScorecardSummary {
        bullish_count: wire.bullish_count,
        bearish_count: wire.bearish_count,
        neutral_count: wire.neutral_count,
        weighted_vote: wire.weighted_vote,
    }
}

fn scorecard_to_snapshot(summary: &ScorecardSummary) -> ConfluenceSnapshot {
    ConfluenceSnapshot {
        bullish_count: summary.bullish_count,
        bearish_count: summary.bearish_count,
        neutral_count: summary.neutral_count,
        weighted_vote: summary.weighted_vote,
    }
}

fn snapshot_to_scorecard(snapshot: &ConfluenceSnapshot) -> ScorecardSummary {
    ScorecardSummary {
        bullish_count: snapshot.bullish_count,
        bearish_count: snapshot.bearish_count,
        neutral_count: snapshot.neutral_count,
        weighted_vote: snapshot.weighted_vote,
    }
}

pub fn handle_add_watchlist_symbol(store: &StateStore, request: AddWatchlistSymbolRequest) -> WatchlistResponse {
    match store.add_watchlist_symbol(&request.symbol).and_then(|_| store.watchlist()) {
        Ok(symbols) => WatchlistResponse { id: request.id, symbols, error: None },
        Err(e) => WatchlistResponse { id: request.id, symbols: Vec::new(), error: Some(e.to_string()) },
    }
}

pub fn handle_remove_watchlist_symbol(store: &StateStore, request: RemoveWatchlistSymbolRequest) -> WatchlistResponse {
    match store.remove_watchlist_symbol(&request.symbol).and_then(|_| store.watchlist()) {
        Ok(symbols) => WatchlistResponse { id: request.id, symbols, error: None },
        Err(e) => WatchlistResponse { id: request.id, symbols: Vec::new(), error: Some(e.to_string()) },
    }
}

pub fn handle_list_watchlist(store: &StateStore, request: ListWatchlistRequest) -> WatchlistResponse {
    match store.watchlist() {
        Ok(symbols) => WatchlistResponse { id: request.id, symbols, error: None },
        Err(e) => WatchlistResponse { id: request.id, symbols: Vec::new(), error: Some(e.to_string()) },
    }
}

pub fn handle_evaluate_scan_gate(store: &StateStore, request: EvaluateScanGateRequest) -> ScanGateResponse {
    let curr = wire_to_scorecard(&request.confluence);
    let prev_snapshot = match store.get_last_snapshot(&request.symbol) {
        Ok(snapshot) => snapshot,
        Err(e) => return ScanGateResponse { id: request.id, decision: "NoChange".to_string(), error: Some(e.to_string()) },
    };
    let prev_scorecard = prev_snapshot.as_ref().map(snapshot_to_scorecard);
    let decision = evaluate_scan_gate(prev_scorecard.as_ref(), &curr, &GateThresholds::default());
    // Always store the current tick (even on NoChange): comparing tick-to-tick,
    // not tick-to-last-meaningful-change, lets slow drift eventually register.
    match store.set_last_snapshot(&request.symbol, &scorecard_to_snapshot(&curr)) {
        Ok(()) => ScanGateResponse { id: request.id, decision: format!("{decision:?}"), error: None },
        Err(e) => ScanGateResponse { id: request.id, decision: format!("{decision:?}"), error: Some(e.to_string()) },
    }
}

pub fn handle_benchmark_compute(request: BenchmarkComputeRequest) -> BenchmarkComputeResponse {
    let candles: Vec<Candle> = request.candles.iter().map(|c| Candle {
        ts: c.ts,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
    }).collect();
    if candles.is_empty() {
        return benchmark_empty_response(request.id);
    }
    let timeframe = parse_timeframe(&request.timeframe);
    let horizon = parse_horizon(&request.horizon);
    // Full OHLCV context at the last visible bar -- richer than the live
    // Compute handler's closes-only from_closes path (which is left unchanged).
    // Anti-lookahead holds: context_at's as_of is the frontier bar's own ts, and
    // only series[0..=frontier] is in the window.
    let ctx = context_at(&candles, candles.len() - 1, &request.symbol, timeframe, horizon);
    let algos = registry::all_for_binary();
    let outputs = run_applicable(&algos, &ctx);
    let weights: HashMap<&str, f64> = HashMap::new();
    let confluence = compute_confluence(&outputs, &weights);
    BenchmarkComputeResponse {
        id: request.id,
        algo_results: outputs.iter().map(algo_output_to_wire).collect(),
        confluence: confluence_to_wire(&confluence),
    }
}

pub fn handle_read_lake_candles(store: &CandleStore, request: ReadLakeCandlesRequest) -> LakeCandlesResponse {
    // Wraps read_sourced_candles (not read_candles): all lake data lives in
    // sourced partitions, so a source-less read would return an empty
    // non-sourced partition. The request carries `source` so the renderer
    // round-trips the exact partition list_symbols reported.
    match store.read_sourced_candles(&request.symbol, &request.timeframe, &request.source) {
        Ok(candles) => LakeCandlesResponse { id: request.id, candles: candles.iter().map(candle_to_wire).collect(), error: None },
        Err(e) => LakeCandlesResponse { id: request.id, candles: Vec::new(), error: Some(e.to_string()) },
    }
}

pub fn handle_list_lake_symbols(store: &CandleStore, request: ListLakeSymbolsRequest) -> LakeSymbolsResponse {
    match store.list_symbols() {
        Ok(entries) => LakeSymbolsResponse { id: request.id, entries: entries.iter().map(lake_entry_to_wire).collect(), error: None },
        Err(e) => LakeSymbolsResponse { id: request.id, entries: Vec::new(), error: Some(e.to_string()) },
    }
}

pub fn handle_evaluate_scan_gate_stateless(request: EvaluateScanGateStatelessRequest) -> ScanGateResponse {
    let curr = wire_to_scorecard(&request.curr);
    let prev = request.prev.as_ref().map(wire_to_scorecard);
    // ZERO StateStore I/O: a pure wrapper over evaluate_scan_gate. Takes no
    // store, so it can never touch scan_snapshots -- a benchmark run can never
    // corrupt the live proactive scanner's per-symbol gate memory.
    let decision = evaluate_scan_gate(prev.as_ref(), &curr, &GateThresholds::default());
    ScanGateResponse { id: request.id, decision: format!("{decision:?}"), error: None }
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
    fn widened_algo_result_carries_symbol_timeframe_horizon_and_rfc3339_timestamp() {
        let response = handle_request(request(3, closes_seq(21)));
        let first = response
            .algo_results
            .first()
            .expect("21 closes runs several algorithms");

        assert_eq!(first.symbol, "NSE:NEWLISTING");
        assert_eq!(first.timeframe, "day");
        // handle_request pins Horizon::Positional for the whole request today.
        assert_eq!(first.horizon, "positional");
        assert!(first.computed_at.contains('T'));
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

    fn state_store() -> (tempfile::TempDir, StateStore) {
        use tempfile::tempdir;
        let dir = tempdir().unwrap();
        let store = StateStore::open(&dir.path().join("state.sqlite3")).unwrap();
        (dir, store)
    }

    fn confluence_wire(bullish: usize, bearish: usize, neutral: usize, weighted_vote: f64) -> ConfluenceWire {
        ConfluenceWire { bullish_count: bullish, bearish_count: bearish, neutral_count: neutral, weighted_vote }
    }

    #[test]
    fn handle_add_watchlist_symbol_returns_the_updated_list() {
        let (_dir, store) = state_store();
        let response = handle_add_watchlist_symbol(
            &store,
            AddWatchlistSymbolRequest { id: 1, symbol: "NSE:INFY".to_string() },
        );
        assert_eq!(response.id, 1);
        assert_eq!(response.symbols, vec!["NSE:INFY".to_string()]);
        assert!(response.error.is_none());
    }

    #[test]
    fn handle_remove_watchlist_symbol_returns_the_updated_list() {
        let (_dir, store) = state_store();
        store.add_watchlist_symbol("NSE:INFY").unwrap();
        store.add_watchlist_symbol("NSE:TCS").unwrap();
        let response = handle_remove_watchlist_symbol(
            &store,
            RemoveWatchlistSymbolRequest { id: 2, symbol: "NSE:INFY".to_string() },
        );
        assert_eq!(response.symbols, vec!["NSE:TCS".to_string()]);
    }

    #[test]
    fn handle_list_watchlist_returns_the_current_list() {
        let (_dir, store) = state_store();
        store.add_watchlist_symbol("NSE:INFY").unwrap();
        let response = handle_list_watchlist(&store, ListWatchlistRequest { id: 3 });
        assert_eq!(response.id, 3);
        assert_eq!(response.symbols, vec!["NSE:INFY".to_string()]);
    }

    #[test]
    fn handle_evaluate_scan_gate_returns_worth_look_on_first_scan_and_persists_the_snapshot() {
        let (_dir, store) = state_store();
        let response = handle_evaluate_scan_gate(
            &store,
            EvaluateScanGateRequest { id: 4, symbol: "NSE:INFY".to_string(), confluence: confluence_wire(5, 2, 10, 0.12) },
        );
        assert_eq!(response.decision, "WorthLook");
        assert!(response.error.is_none());
        // The snapshot was persisted, so a second identical call can compare.
        assert!(store.get_last_snapshot("NSE:INFY").unwrap().is_some());
    }

    #[test]
    fn handle_evaluate_scan_gate_returns_no_change_on_an_identical_second_scan() {
        let (_dir, store) = state_store();
        let first = handle_evaluate_scan_gate(
            &store,
            EvaluateScanGateRequest { id: 5, symbol: "NSE:INFY".to_string(), confluence: confluence_wire(5, 2, 10, 0.12) },
        );
        assert_eq!(first.decision, "WorthLook");
        let second = handle_evaluate_scan_gate(
            &store,
            EvaluateScanGateRequest { id: 6, symbol: "NSE:INFY".to_string(), confluence: confluence_wire(5, 2, 10, 0.12) },
        );
        assert_eq!(second.decision, "NoChange");
    }

    fn candle_store() -> (tempfile::TempDir, CandleStore) {
        use tempfile::tempdir;
        let dir = tempdir().unwrap();
        let store = CandleStore::open(dir.path()).unwrap();
        (dir, store)
    }

    fn ohlcv_window(len: usize) -> Vec<CandleWire> {
        // Rising close AND rising volume: a full-OHLCV context lets volume-based
        // algorithms produce a directional signal; a closes-only from_closes
        // context (empty volumes) would no-op them all to Neutral.
        (0..len)
            .map(|i| {
                let base = 100.0 + i as f64;
                CandleWire {
                    ts: 1_700_000_000 + i as i64 * 86_400,
                    open: base,
                    high: base + 2.0,
                    low: base - 1.0,
                    close: base + 1.0,
                    volume: 1_000 + i as i64 * 100,
                }
            })
            .collect()
    }

    #[test]
    fn handle_benchmark_compute_reaches_run_applicable_with_full_ohlcv() {
        let response = handle_benchmark_compute(BenchmarkComputeRequest {
            id: 30,
            symbol: "NSE:INFY".to_string(),
            timeframe: "day".to_string(),
            horizon: "positional".to_string(),
            candles: ohlcv_window(60),
        });
        assert_eq!(response.id, 30);
        // At least one volume/OHLCV-reading algorithm must produce a directional
        // signal -- the proof that context_at's full OHLCV, not from_closes,
        // reached run_applicable.
        let volume_based = ["obv", "mfi", "cmf", "vwap", "accumulation_distribution", "volume_profile"];
        assert!(
            response.algo_results.iter().any(|r| volume_based.contains(&r.algo_id.as_str()) && r.direction != "Neutral"),
            "a volume/OHLCV-based algorithm must be directional under full OHLCV; got {:?}",
            response.algo_results.iter().map(|r| (r.algo_id.clone(), r.direction.clone())).collect::<Vec<_>>()
        );
    }

    #[test]
    fn handle_benchmark_compute_on_empty_candles_returns_a_zeroed_response() {
        let response = handle_benchmark_compute(BenchmarkComputeRequest {
            id: 31,
            symbol: "NSE:INFY".to_string(),
            timeframe: "day".to_string(),
            horizon: "positional".to_string(),
            candles: Vec::new(),
        });
        assert_eq!(response.id, 31);
        assert!(response.algo_results.is_empty());
        assert_eq!(response.confluence.neutral_count, 0);
    }

    #[test]
    fn handle_read_lake_candles_reads_back_a_written_sourced_partition() {
        let (_dir, store) = candle_store();
        store
            .write_sourced_candles("NSE:INFY", "day", "bhavcopy", &[Candle { ts: 100, open: 1.0, high: 2.0, low: 0.5, close: 1.5, volume: 10 }])
            .unwrap();
        let response = handle_read_lake_candles(
            &store,
            ReadLakeCandlesRequest { id: 32, symbol: "NSE:INFY".to_string(), timeframe: "day".to_string(), source: "bhavcopy".to_string() },
        );
        assert_eq!(response.candles.len(), 1);
        assert_eq!(response.candles[0].close, 1.5);
        assert!(response.error.is_none());
    }

    #[test]
    fn handle_list_lake_symbols_returns_one_entry_per_written_partition() {
        let (_dir, store) = candle_store();
        store.write_sourced_candles("NSE:INFY", "day", "bhavcopy", &[Candle { ts: 100, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1 }]).unwrap();
        store.write_sourced_candles("NSE:TCS", "day", "bhavcopy", &[Candle { ts: 100, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1 }]).unwrap();
        let response = handle_list_lake_symbols(&store, ListLakeSymbolsRequest { id: 33 });
        assert_eq!(response.id, 33);
        assert_eq!(response.entries.len(), 2);
    }

    #[test]
    fn handle_evaluate_scan_gate_stateless_matches_the_persistent_gate_and_writes_nothing() {
        // Identical first-ever input -> same decision as the persistent handler.
        let stateless = handle_evaluate_scan_gate_stateless(EvaluateScanGateStatelessRequest {
            id: 34,
            prev: None,
            curr: confluence_wire(5, 2, 10, 0.12),
        });
        assert_eq!(stateless.decision, "WorthLook");

        // Zero StateStore writes: run the stateless handler, then open a fresh
        // StateStore and confirm scan_snapshots never got a row (it can't -- the
        // handler holds no store reference).
        let (_dir, state) = state_store();
        let _ = handle_evaluate_scan_gate_stateless(EvaluateScanGateStatelessRequest {
            id: 35,
            prev: None,
            curr: confluence_wire(5, 2, 10, 0.12),
        });
        assert!(state.get_last_snapshot("NSE:INFY").unwrap().is_none());
    }
}
