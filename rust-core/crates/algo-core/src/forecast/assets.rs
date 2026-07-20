//! Shared by every ONNX forecaster (kronos/ttm/chronos/moirai) -- lives in
//! its own module, rather than `framework.rs`, because `kronos.rs` doesn't
//! consume `framework.rs`'s `ForecasterAdapter` scaffolding (it stays its own
//! four-graph pipeline, see `framework.rs`'s module doc) but still needs to
//! resolve its `.onnx` paths the same way every other forecaster does.

use std::path::PathBuf;

/// Root directory every forecaster resolves its `.onnx` graph paths against.
/// Defaults to the crate's own committed `assets/` (works for local/dev/the
/// never-shipped app); `ALGO_CORE_ASSETS_DIR` overrides it for packaging,
/// where the assets live outside the source tree.
///
/// `env!("CARGO_MANIFEST_DIR")` bakes in only a path STRING at compile time
/// (a few bytes) -- not the model bytes themselves, which are read from disk
/// at load time instead of being embedded via `include_bytes!`.
pub(crate) fn assets_base_dir() -> PathBuf {
    std::env::var_os("ALGO_CORE_ASSETS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/assets")))
}
