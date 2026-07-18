# Coding Conventions — Trade Assistant

## Comments
Default to no comments. Only add one when the *why* isn't obvious from the
code itself: a non-obvious invariant, a workaround for a specific upstream
bug, a formula's source. Never write a comment that just restates what the
next line does, and never write a numbered "1. do X, 2. do Y" comment block
above a function — the function body already says that.

Bad: `// increment counter by one` above `count += 1;`
Good: `// Wilder smoothing, not a simple moving average — see RSI task in
       // docs/superpowers/plans/2026-07-18-rust-sidecar-core-plan.md`
above a smoothing formula that would otherwise look like a bug.

## Naming
- Rust: `snake_case` functions/variables, `PascalCase` types, one clear
  responsibility per file (mirrors the file structure in each plan doc).
- TypeScript (later phases): `camelCase` functions/variables, `PascalCase`
  types/classes, no Hungarian notation, no abbreviations that aren't
  already standard in this codebase's domain (`oi`, `pcr`, `ltp` are fine —
  they're Kite/options-market terms used throughout the design doc).
- File names describe what the file is responsible for, not what kind of
  file it is (`confluence.rs`, not `utils.rs` or `helpers.rs`).

## Structure
- Small, focused files over large ones. If a file starts doing two
  unrelated things, split it.
- Pure logic (no I/O) lives separately from I/O/side-effecting code —
  see `algo-core` (pure) vs `storage`/`sidecar` (I/O) in `rust-core/`.
