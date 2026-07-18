use sidecar::handlers::handle_request;
use sidecar::protocol::{encode_response, parse_request};
use std::io::{self, BufRead, Write};

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

        let response = handle_request(request);
        writeln!(stdout, "{}", encode_response(&response)).expect("stdout must be writable");
        stdout.flush().expect("stdout must flush");
    }
}
