use sidecar::handlers::handle_request;
use sidecar::protocol::{empty_response, encode_response, parse_request};
use std::io::{self, BufRead, Write};
use std::panic::{self, AssertUnwindSafe};

/// This process is a long-lived sidecar: Electron spawns one instance and
/// drives it for a whole session. A single malformed-but-well-typed request
/// (e.g. a compute algorithm panicking on an edge case we didn't anticipate)
/// must never take the whole loop down with it -- so every per-request call
/// is isolated with `catch_unwind`. Layer 1 of the fix (handlers::handle_request
/// skipping algorithms without enough lookback) should mean this never fires
/// in practice; this is defense-in-depth for future algorithm bugs.
fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = line.expect("stdin must be readable");
        if line.trim().is_empty() {
            continue;
        }

        let request = match parse_request(&line) {
            Ok(request) => request,
            Err(_) => continue,
        };

        let request_id = request.id;
        let result = panic::catch_unwind(AssertUnwindSafe(|| handle_request(request)));

        let response = match result {
            Ok(response) => response,
            Err(_) => {
                eprintln!(
                    "sidecar: request {request_id} panicked during compute; answering it with an empty result and continuing"
                );
                empty_response(request_id)
            }
        };

        writeln!(stdout, "{}", encode_response(&response)).expect("stdout must be writable");
        stdout.flush().expect("stdout must flush");
    }
}
