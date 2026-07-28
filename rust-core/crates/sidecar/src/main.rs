use sidecar::handlers::{
    handle_add_watchlist_symbol, handle_benchmark_compute, handle_evaluate_scan_gate,
    handle_evaluate_scan_gate_stateless, handle_list_lake_symbols, handle_list_watchlist,
    handle_persist, handle_read_lake_candles, handle_remove_watchlist_symbol, handle_request,
};
use sidecar::protocol::{
    benchmark_empty_response, empty_response, encode_response, parse_request,
    LakeCandlesResponse, LakeSymbolsResponse, PersistCandlesResponse, ScanGateResponse,
    SidecarRequest, SidecarResponse, WatchlistResponse,
};
use std::io::{self, BufRead, Write};
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use storage::{CandleStore, StateStore};

fn lake_root_from_args() -> Option<PathBuf> {
    let mut args = std::env::args();
    while let Some(arg) = args.next() {
        if arg == "--lake-root" {
            return args.next().map(PathBuf::from);
        }
    }
    None
}

fn state_db_path(lake_root: &Path) -> PathBuf {
    lake_root.join("state.sqlite3")
}

/// This process is a long-lived sidecar: Electron spawns one instance and
/// drives it for a whole session. A single malformed-but-well-typed request
/// (e.g. a compute algorithm panicking on an edge case we didn't anticipate)
/// must never take the whole loop down with it -- so every per-request call
/// is isolated with `catch_unwind`.
fn main() {
    let lake_root = lake_root_from_args();
    // StateStore::open (unlike CandleStore::open) does not create its parent
    // dir, so ensure the lake root exists before opening either store rather
    // than relying on CandleStore's own create_dir_all running first.
    if let Some(root) = &lake_root {
        let _ = std::fs::create_dir_all(root);
    }
    let store = lake_root.as_ref().and_then(|root| CandleStore::open(root).ok());
    let state_store = lake_root.as_ref().and_then(|root| StateStore::open(&state_db_path(root)).ok());

    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = line.expect("stdin must be readable");
        if line.trim().is_empty() {
            continue;
        }

        let request = match parse_request(&line) {
            Ok(request) => request,
            Err(e) => {
                eprintln!("sidecar: failed to parse request line ({e}): {line:?}");
                continue;
            }
        };

        let response = match request {
            SidecarRequest::Compute(compute) => {
                let id = compute.id;
                let result = panic::catch_unwind(AssertUnwindSafe(|| handle_request(compute)));
                match result {
                    Ok(response) => SidecarResponse::Compute(response),
                    Err(_) => {
                        eprintln!("sidecar: compute request {id} panicked; returning an empty response");
                        SidecarResponse::Compute(empty_response(id))
                    }
                }
            }
            SidecarRequest::PersistCandles(persist) => {
                let id = persist.id;
                match store.as_ref() {
                    Some(store) => {
                        let result = panic::catch_unwind(AssertUnwindSafe(|| handle_persist(store, persist)));
                        match result {
                            Ok(response) => SidecarResponse::PersistCandles(response),
                            Err(_) => {
                                eprintln!("sidecar: persist request {id} panicked");
                                SidecarResponse::PersistCandles(PersistCandlesResponse {
                                    id,
                                    written: 0,
                                    error: Some("persist panicked".to_string()),
                                })
                            }
                        }
                    }
                    None => SidecarResponse::PersistCandles(PersistCandlesResponse {
                        id,
                        written: 0,
                        error: Some("no --lake-root configured".to_string()),
                    }),
                }
            }
            SidecarRequest::AddWatchlistSymbol(request) => {
                let id = request.id;
                match state_store.as_ref() {
                    Some(store) => {
                        let result = panic::catch_unwind(AssertUnwindSafe(|| handle_add_watchlist_symbol(store, request)));
                        match result {
                            Ok(response) => SidecarResponse::Watchlist(response),
                            Err(_) => {
                                eprintln!("sidecar: add_watchlist_symbol request {id} panicked");
                                SidecarResponse::Watchlist(WatchlistResponse { id, symbols: Vec::new(), error: Some("add_watchlist_symbol panicked".to_string()) })
                            }
                        }
                    }
                    None => SidecarResponse::Watchlist(WatchlistResponse { id, symbols: Vec::new(), error: Some("no --lake-root configured".to_string()) }),
                }
            }
            SidecarRequest::RemoveWatchlistSymbol(request) => {
                let id = request.id;
                match state_store.as_ref() {
                    Some(store) => {
                        let result = panic::catch_unwind(AssertUnwindSafe(|| handle_remove_watchlist_symbol(store, request)));
                        match result {
                            Ok(response) => SidecarResponse::Watchlist(response),
                            Err(_) => {
                                eprintln!("sidecar: remove_watchlist_symbol request {id} panicked");
                                SidecarResponse::Watchlist(WatchlistResponse { id, symbols: Vec::new(), error: Some("remove_watchlist_symbol panicked".to_string()) })
                            }
                        }
                    }
                    None => SidecarResponse::Watchlist(WatchlistResponse { id, symbols: Vec::new(), error: Some("no --lake-root configured".to_string()) }),
                }
            }
            SidecarRequest::ListWatchlist(request) => {
                let id = request.id;
                match state_store.as_ref() {
                    Some(store) => {
                        let result = panic::catch_unwind(AssertUnwindSafe(|| handle_list_watchlist(store, request)));
                        match result {
                            Ok(response) => SidecarResponse::Watchlist(response),
                            Err(_) => {
                                eprintln!("sidecar: list_watchlist request {id} panicked");
                                SidecarResponse::Watchlist(WatchlistResponse { id, symbols: Vec::new(), error: Some("list_watchlist panicked".to_string()) })
                            }
                        }
                    }
                    None => SidecarResponse::Watchlist(WatchlistResponse { id, symbols: Vec::new(), error: Some("no --lake-root configured".to_string()) }),
                }
            }
            SidecarRequest::EvaluateScanGate(request) => {
                let id = request.id;
                match state_store.as_ref() {
                    Some(store) => {
                        let result = panic::catch_unwind(AssertUnwindSafe(|| handle_evaluate_scan_gate(store, request)));
                        match result {
                            Ok(response) => SidecarResponse::ScanGate(response),
                            Err(_) => {
                                eprintln!("sidecar: evaluate_scan_gate request {id} panicked");
                                SidecarResponse::ScanGate(ScanGateResponse { id, decision: "NoChange".to_string(), error: Some("evaluate_scan_gate panicked".to_string()) })
                            }
                        }
                    }
                    None => SidecarResponse::ScanGate(ScanGateResponse { id, decision: "NoChange".to_string(), error: Some("no --lake-root configured".to_string()) }),
                }
            }
            SidecarRequest::ListLakeSymbols(request) => {
                let id = request.id;
                match store.as_ref() {
                    Some(store) => {
                        let result = panic::catch_unwind(AssertUnwindSafe(|| handle_list_lake_symbols(store, request)));
                        match result {
                            Ok(response) => SidecarResponse::LakeSymbols(response),
                            Err(_) => {
                                eprintln!("sidecar: list_lake_symbols request {id} panicked");
                                SidecarResponse::LakeSymbols(LakeSymbolsResponse { id, entries: Vec::new(), error: Some("list_lake_symbols panicked".to_string()) })
                            }
                        }
                    }
                    None => SidecarResponse::LakeSymbols(LakeSymbolsResponse { id, entries: Vec::new(), error: Some("no --lake-root configured".to_string()) }),
                }
            }
            SidecarRequest::ReadLakeCandles(request) => {
                let id = request.id;
                match store.as_ref() {
                    Some(store) => {
                        let result = panic::catch_unwind(AssertUnwindSafe(|| handle_read_lake_candles(store, request)));
                        match result {
                            Ok(response) => SidecarResponse::LakeCandles(response),
                            Err(_) => {
                                eprintln!("sidecar: read_lake_candles request {id} panicked");
                                SidecarResponse::LakeCandles(LakeCandlesResponse { id, candles: Vec::new(), error: Some("read_lake_candles panicked".to_string()) })
                            }
                        }
                    }
                    None => SidecarResponse::LakeCandles(LakeCandlesResponse { id, candles: Vec::new(), error: Some("no --lake-root configured".to_string()) }),
                }
            }
            SidecarRequest::BenchmarkCompute(request) => {
                // Needs no store: it always answers, computing purely from the
                // request's candles. A panic falls back to a zeroed response.
                let id = request.id;
                let result = panic::catch_unwind(AssertUnwindSafe(|| handle_benchmark_compute(request)));
                match result {
                    Ok(response) => SidecarResponse::BenchmarkCompute(response),
                    Err(_) => {
                        eprintln!("sidecar: benchmark_compute request {id} panicked; returning a zeroed response");
                        SidecarResponse::BenchmarkCompute(benchmark_empty_response(id))
                    }
                }
            }
            SidecarRequest::EvaluateScanGateStateless(request) => {
                // Needs no store (pure): it always answers.
                let id = request.id;
                let result = panic::catch_unwind(AssertUnwindSafe(|| handle_evaluate_scan_gate_stateless(request)));
                match result {
                    Ok(response) => SidecarResponse::ScanGate(response),
                    Err(_) => {
                        eprintln!("sidecar: evaluate_scan_gate_stateless request {id} panicked");
                        SidecarResponse::ScanGate(ScanGateResponse { id, decision: "NoChange".to_string(), error: Some("evaluate_scan_gate_stateless panicked".to_string()) })
                    }
                }
            }
        };

        writeln!(stdout, "{}", encode_response(&response)).expect("stdout must be writable");
        stdout.flush().expect("stdout must flush");
    }
}
