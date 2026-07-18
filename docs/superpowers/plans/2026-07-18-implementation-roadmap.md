# Trade Assistant — Implementation Roadmap

This project (spec: `docs/superpowers/specs/2026-07-18-trade-assistant-design.md`) covers multiple independent subsystems — a Rust compute core, an Electron shell, a Kite integration with a safety-critical enforcement layer, an AI reasoning layer, two full response-mode UX paths, and a benchmarking UI. Per `superpowers:writing-plans`' own scope-check guidance, a spec this size gets broken into one plan per subsystem rather than a single mega-plan — each phase below produces working, testable software on its own before the next phase starts.

**Phase 1 has its own complete, bite-sized, TDD-ready plan:** `docs/superpowers/plans/2026-07-18-rust-sidecar-core-plan.md`. Phases 2-7 are scoped here at the level needed to sequence and staff them; each gets its own full plan doc (same format as Phase 1's) written immediately before it starts, once the previous phase's actual interfaces exist to plan against precisely.

## Why this order

Phase 1 has no dependencies and unblocks everything else — nothing downstream can be tested without a working algorithm/storage core. Phase 2 stays entirely inside Rust (extending Phase 1's storage/algorithm layer with data ingestion and the backtest engine) before any Electron/TypeScript code exists at all, so the highest-risk, most novel technical bet in the whole design — Kite MCP's actual behavior, the Electron/Rust process boundary, the safety allowlist — gets its own dedicated phase (3) once there's something real to integrate. AI (4) and the two response modes/chat UI (5) both depend on Phase 3's Kite integration existing. Benchmark UI (6) depends on Phase 2's replay harness and Phase 5's chart-rendering/UI conventions. Platform/build (7) comes last because it packages what already exists rather than shaping it.

---

## Phase 2: Public Data Ingestion + Backtest/Replay Engine

**Scope:** extends the Phase 1 Rust workspace — no new processes, no Electron, no network access to Kite yet.

- NSE/BSE daily bhavcopy ingestion (design doc §10.1): fetch, parse, write into the Phase 1 `CandleStore`'s Parquet lake, tagged as `source: "bhavcopy"` so it's distinguishable from live-Kite-sourced candles later.
- Community intraday archive ingestion (§10.2): a one-time importer for the Kaggle CC0 dataset (preferred, clean license) and, as a lower-confidence supplement, the `aeron7` GitHub archive — same tagging convention (`source: "kaggle"` / `source: "github_archive"`).
- The backtest/historical-replay engine (§6.4, §10.3): frontier-gated walk-forward replay over the candle lake, reusing Phase 1's `registry::all()` and `compute_confluence()` unchanged. Produces per-algorithm hit-rate/expectancy, which becomes the real weights `compute_confluence()` takes instead of Phase 1's equal-weight placeholder.
- Anti-lookahead as its own explicitly tested concern (§6.4): a bar is never visible to `compute()` before its own `EndTime` has passed, exchange-local session time, not UTC/OS locale.
- **Full algorithm catalog buildout (§6.2), as an ongoing workstream inside this phase and beyond, not a one-time task:** Phase 1 proved the `Algorithm` trait/registry/test pattern with three hand-rolled indicators (SMA/EMA/RSI). Every remaining item in §6.2's catalog — the rest of the TA indicators via the `rust_ti` crate (MACD, ADX, Supertrend, Ichimoku, Parabolic SAR, Stochastic, CCI, Williams %R, ROC, Bollinger, ATR, Keltner, Donchian, OBV, VWAP, MFI, CMF, Accumulation/Distribution, Volume Profile), the statistical/quant methods (cointegration, volatility regime, multi-timeframe confluence), the options/F&O analytics (Black-Scholes Greeks via `blackscholes`/`implied-vol`, OI buildup, PCR, Max Pain), and the Kronos forecaster (via `ort`, pending its own ONNX-export spike, see the open items below) — gets added incrementally, each one following Phase 1's exact pattern: implement, register via `inventory::submit!`, unit-test against a hand-computed or cross-checked reference value before it's trusted. This phase's replay engine is what turns each new algorithm's raw output into a real backtested hit-rate, so building out the catalog and building the replay engine happen hand-in-hand rather than in a strict before/after order.

**Key new files:** `rust-core/crates/ingestion/` (bhavcopy + community-archive importers), `rust-core/crates/backtest/` (frontier-gated replay engine, hit-rate/expectancy computation), continued growth of `rust-core/crates/algo-core/src/indicators/` and new `.../options/`, `.../quant/`, `.../kronos/` modules as the catalog above gets built out.

**Definition of done:** a CLI-invokable command runs a walk-forward replay over real bhavcopy-sourced history for a real NSE symbol and produces a hit-rate report per algorithm — provable end-to-end with zero Electron/Kite/Claude involvement, same as Phase 1.

## Phase 3: Electron Shell + Kite MCP Integration + Safety Layer

**Scope:** the first Electron/TypeScript code in the project. This is the highest-stakes phase — it's where §4's safety model becomes real code, not just a design principle.

- Electron main-process skeleton: `contextIsolation`/`sandbox`/no `nodeIntegration` from the very first window (§8.2) — security posture is not bolted on later.
- Rust sidecar process supervision from TS: spawn the Phase 1/2 binary, auto-restart on crash, request/response over the JSON stdio protocol (§3).
- Kite MCP client wrapper (§4, layer 1): a typed class exposing only the read-tool methods named in §5.1 — no method for any of the six write/GTT-write tools exists anywhere in this code. This is the task that most needs an explicit test asserting the exposed method set matches exactly, per §13's testing strategy.
- `claude` CLI subprocess invocation scaffolding with `--disallowedTools`/`--strict-mcp-config` (§4, layer 2) — even before the full persona pipeline (Phase 4) exists, this phase proves the denylist flags are actually passed on every invocation.
- `tools/list` drift-detection audit (§4, layer 3) — runnable and testable before Kite login/account setup is even complete, since `tools/list` doesn't require an authenticated session (§4's implementation-sequencing note).
- Kite OAuth login flow: loopback HTTP server + system browser (§8.3's resolved design) — first real point where the app touches the actual Kite account, once the user's Kite Connect signup is in place.
- Daily-session-expiry detection + banner (§5.1).
- **Every candle fetched from live Kite data is also written into Phase 1's `CandleStore` (Parquet lake), permanently — this is core v1 behavior, not deferred** (§10.2). This is the task that starts building the first-party owned archive from day one of live use, so reliance on Phase 2's community-archive datasets shrinks over time on its own.

**Key new files:** `electron-app/src/main/kiteClient.ts`, `electron-app/src/main/sidecarSupervisor.ts`, `electron-app/src/main/claudeProvider.ts` (scaffolding only — full persona pipeline is Phase 4), `electron-app/src/main/mcpDriftMonitor.ts`, `electron-app/src/main/kiteOAuth.ts`.

**Definition of done:** the app can log into Kite, fetch real quotes/historical candles through the safety-wrapped MCP client, hand them to the Phase 1/2 sidecar over stdio, and get back algorithm results/confluence — all provable with a minimal (even non-chat) UI or test harness, plus a passing allowlist test that fails loudly if a write-tool method is ever added by accident.

## Phase 4: Claude AI Integration

**Scope:** builds on Phase 3's `claude` CLI scaffolding.

- `Provider` interface + `ClaudeCliProvider` implementation (§7.1).
- `AnalysisEnvelope`/`Verdict` types (§7.3), assembled from Phase 2/3's algorithm results + confluence + Kite-sourced overlays.
- Persona pipeline orchestration (§7.2): options/Greeks persona, technical/quant persona, risk/position persona, final synthesis persona.
- System prompt authored via the `prompt-engineer` skill, built on the `anthropics/financial-services` reference patterns named in §7.4 (evidence citation, no-execution-by-tool-absence, untrusted-content handling, conviction taxonomy, dual concise/full mode).
- Structured-output failure handling: `structured_output`-absent responses treated as a real failure mode, not assumed away (§7.1).

**Key new files:** `electron-app/src/main/providers/provider.ts`, `electron-app/src/main/providers/claudeCliProvider.ts`, `electron-app/src/main/personaPipeline.ts`, `electron-app/src/main/systemPrompts/` (one file per persona).

**Definition of done:** given a real `AnalysisEnvelope` built from live Kite data and Phase 1/2's algorithm output, the persona pipeline produces a `Verdict` that cites specific `algo_id`s — testable via a scripted envelope fixture without needing the chat UI to exist yet.

## Phase 5: Response Modes + Chat UI + Settings + History

**Scope:** the first user-facing surface. Depends on Phase 3 (data) and Phase 4 (AI) both existing.

- Mandatory per-session AI-Assisted/Engine-Only prompt (§9) — the first thing the user sees, every session.
- `DeterministicResponseGenerator` (§9.2): templated prose over the same `AlgoOutput[]`/confluence scorecard AI-Assisted mode uses — zero Claude calls, zero token cost.
- Structured Q&A wizard for Engine-Only intake (§9.2): buying/selling lens, instrument search (via Phase 3's `search_instruments` wrapper), horizon.
- Chat UI (§8.3): markdown + tables + inline Mermaid, streamed responses in AI-Assisted mode, DOMPurify sanitization on every rendered message in both modes (§8.2 — non-negotiable, tested against the DeepChat CVE payload shape).
- Settings window (§8.4): proactive-scanning toggle (off by default), watchlist membership, account status display.
- Proactive scan scheduler (§8.1): opt-in, tray-resident, the same deterministic pre-response gate (confluence delta/IV spike/OI-buildup flip) deciding whether a tick spends a Claude call or just re-renders deterministically.
- Chat/session history persistence (§8.5): Electron main's own SQLite store (`sessions`/`messages` tables), separate from the Rust sidecar's SQLite — survives app restart, browsable/reopenable, identical treatment for both response modes.

**Key new files:** `electron-app/src/renderer/` (chat UI components), `electron-app/src/main/sessionStore.ts`, `electron-app/src/main/deterministicResponseGenerator.ts`, `electron-app/src/main/scanScheduler.ts`, `electron-app/src/renderer/EngineOnlyWizard.tsx`, `electron-app/src/renderer/SettingsWindow.tsx`.

**Definition of done:** a real end-to-end session in either mode — free text or wizard — produces a rendered, sanitized answer that persists and reopens correctly after an app restart (§13's history-persistence test), and a proactive scan tick (once enabled in Settings) correctly gates whether it spends a Claude call.

## Phase 6: Benchmark UI

**Scope:** depends on Phase 2's replay harness and Phase 5's chart/UI conventions.

- Benchmark screen (§10.4): instrument + date-range + response-mode setup, separate from chat/session history.
- Decision-point sampling (§10.4): session-close cadence for positional, live-equivalent gating (reusing Phase 5's scan-gate logic) for intraday, manual override for debugging.
- `lightweight-charts` candlestick rendering with `createSeriesMarkers` overlays (correct/incorrect/neutral), a single summary strip, and click/hover detail popovers — deliberately uncluttered per the design doc's explicit requirement.
- Copy-raw-result button: serializes the full structured run to clipboard via the standard contextBridge pattern (§8.2), no raw Node/clipboard access from the renderer.

**Key new files:** `electron-app/src/renderer/BenchmarkUI.tsx`, `electron-app/src/renderer/benchmarkChart.ts`.

**Definition of done:** running a benchmark over real bhavcopy/community-archive history renders a real candlestick chart with correct/incorrect markers and a working copy-to-clipboard button producing valid, complete JSON (§13's Benchmark-UI test).

## Phase 7: Platform, Build, Packaging

**Scope:** packages what already exists; shapes nothing new architecturally.

- GitHub Actions CI matrix (`macos-latest` + `windows-latest`), each building the Rust sidecar natively on its own OS runner (§11) — no cross-compilation from a single machine.
- `rustls` confirmed (not `native-tls`/`openssl`) across every networking dependency introduced in Phases 3-4.
- electron-builder config for unsigned personal-use builds on both platforms (§8.3/§11 packaging notes) — no code signing/notarization.
- Manual verification pass on real Windows hardware/VM (the user has direct access) alongside the CI-built artifact.

**Definition of done:** a CI run produces installable (unsigned) builds for both macOS and Windows from the same commit, and the Windows build has been manually run at least once on real Windows hardware, not just built by CI.

---

## Open items carried from the design doc that any phase's plan should re-check before finalizing

- Kronos → ONNX export feasibility (design doc §14, item 1) — this is its own spike, most naturally scheduled as an early Phase 2 task once real candle data exists to feed it, with the Python/ONNX-sidecar fallback ready if the export doesn't pan out.
- Kite's exact per-interval historical-data lookback caps (§14, item 2) — validate empirically during Phase 3's Kite client work, not hardcoded from the community-sourced numbers in §5.1.
