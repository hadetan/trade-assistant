use sidecar::handlers::{handle_persist, handle_request};
use sidecar::protocol::{
    empty_response, encode_response, parse_request, PersistCandlesResponse, SidecarRequest, SidecarResponse,
};
use std::io::{self, BufRead, Write};
use std::panic::{self, AssertUnwindSafe};
use std::path::PathBuf;
use storage::CandleStore;

fn lake_root_from_args() -> Option<PathBuf> {
    let mut args = std::env::args();
    while let Some(arg) = args.next() {
        if arg == "--lake-root" {
            return args.next().map(PathBuf::from);
        }
    }
    None
}

/// This process is a long-lived sidecar: Electron spawns one instance and
/// drives it for a whole session. A single malformed-but-well-typed request
/// (e.g. a compute algorithm panicking on an edge case we didn't anticipate)
/// must never take the whole loop down with it -- so every per-request call
/// is isolated with `catch_unwind`.
fn main() {
    let store = lake_root_from_args()
        .and_then(|root| CandleStore::open(&root).ok());

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
        };

        writeln!(stdout, "{}", encode_response(&response)).expect("stdout must be writable");
        stdout.flush().expect("stdout must flush");
    }
}
