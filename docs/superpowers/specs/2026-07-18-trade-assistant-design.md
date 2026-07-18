# Trade Assistant — System Architecture Design

Status: approved by user 2026-07-18, pending implementation planning.
Author: design produced via superpowers:brainstorming + a 56-agent research/verify workflow (Kite Connect/MCP internals, freqtrade/Hummingbot/LEAN/Kronos reference architectures, TA/quant/options-Greeks catalog, backtesting methodology, Claude headless integration, Electron+Rust bridging, storage, public data sources, SEBI regulatory posture).

**Revision 2 (2026-07-18):** added the AI-Assisted/Engine-Only response-mode toggle (§9), made proactive scanning opt-in via a Settings window instead of default-on (§8.1, §8.4), and added a public-data backtesting harness for development/testing without a Kite subscription (§10). Sections renumbered accordingly from §9 onward.

## 1. Purpose

A personal, single-user desktop application that helps its one user (the builder) decide whether to buy, sell, or hold a position on Zerodha Kite, by running a large catalog of independent, deterministic algorithms over real market data and having Claude synthesize their output into a plain-language, evidence-cited recommendation. The user is the only human who ever sees the app or acts on its output. It is never shipped, published, or used by anyone else.

The app answers two kinds of questions:
- **Reactive**: "should I sell/add to this position?" / "what does the data say about X right now?"
- **Proactive**: scanning a configured watchlist/portfolio on a schedule and surfacing names worth a look.

Both intraday and positional/swing horizons are in scope, decided per query rather than as a fixed mode. Instrument scope is anything searchable on Kite — individual equities, indices (Bank Nifty, Nifty 50), and their F&O (options/futures) — generalized via Kite's instrument search rather than hardcoded to specific symbols.

This design supersedes, and is a superset of, an earlier personal prototype (`ws/trade/`) that used Claude Code skills to do Bank-Nifty/Nifty-50-only intraday probability analysis via the same Kite MCP endpoint. That prototype's hard rule was "never say buy/sell/hold" — probability output only. This app intentionally relaxes that: Claude is allowed to state an actual directional lean (sell / hold / add), because the user — not the app — is always the one who acts on it. What both designs share, and what carries forward unchanged, is: Kite MCP as the sole live data source, and an absolute prohibition on the app itself ever executing a trade.

## 2. Non-Goals / Hard Constraints

These are permanent, not v1-only:

- **The app never places, modifies, cancels, or automates any order, ever.** No feature, button, or "human-confirmed send" flow of any kind exists anywhere in the codebase for this. See §4 for how this is enforced.
- No automation/cron-triggered trading logic. Proactive scanning only ever produces information for the user to read; it never acts, and it is off by default (§8.4).
- Single user, single machine, no accounts, no multi-tenant anything, no server component reachable from outside `127.0.0.1` (if any local service is ever used at all — see §8.1).
- Claude is the only AI provider in v1. Other providers (Copilot, Codex, etc.) are a future possibility, so the AI layer sits behind a provider interface (§7.1), but only one implementation exists now. Using AI at all is itself optional per session — see §9.
- TTS/STT are out of scope entirely for v1 (see `docs/TTS_STT.md` for the reference pattern if revisited later) — the design leaves an obvious extension point (the chat layer already round-trips plain text) but nothing is built for it now.
- Not legal advice: §12's regulatory notes are research findings, not a compliance sign-off. The user has already been told this.

## 3. High-Level Architecture

Three cooperating processes, all on one machine:

```mermaid
flowchart TB
    subgraph Electron["Electron app (TypeScript)"]
        Main["Main process<br/>Kite MCP client (kiteconnectjs)<br/>Claude persona pipeline (claude CLI subprocess)<br/>scan scheduler (opt-in), IPC hub"]
        Renderer["Renderer (chat UI)<br/>contextIsolation + sandbox"]
        Main <-->|contextBridge / ipcMain.handle| Renderer
    end

    subgraph RustSidecar["Rust sidecar (separate supervised binary)"]
        Algo["Algorithm registry<br/>(trait-based, compile-time registered)"]
        Kronos["Kronos forecaster<br/>(ort / ONNX Runtime)"]
        Backtest["Backtest / historical-replay engine<br/>(frontier-gated replay)"]
        Store["DuckDB + Parquet candle lake<br/>SQLite (watchlists, alerts, session cache)"]
        Algo --- Store
        Kronos --- Store
        Backtest --- Store
    end

    KiteMCP["Kite MCP<br/>https://mcp.kite.trade/mcp<br/>(Zerodha, remote HTTP)"]
    PublicData["Public no-auth data<br/>NSE/BSE bhavcopy + community archives<br/>(development/testing only — §10)"]

    Main <-->|JSON over stdio, request/response by id| RustSidecar
    Main <-->|MCP protocol, read-tool calls only| KiteMCP
    RustSidecar -.->|backfill, dev/test only| PublicData
```

**Why a sidecar, not a native Rust addon (napi-rs) or a persistent OS-level daemon:** verified research (adversarial fact-check, not just first-pass claims) found that cross-compiling a native Node addon to Windows-MSVC from a macOS host currently hits real, open toolchain bugs in exactly the dependencies a compute core needs (TLS/crypto crates, clang-cl mismatches) — see §11. A native addon also means every Rust panic crossing the FFI boundary is undefined behavior unless every one of the "many algorithms" plugin entry points wraps `catch_unwind`, and every Rust change requires a full Electron restart (no hot-reload). None of that buys anything here, because the actual workload — score a watchlist every few minutes, run an analysis on request, occasionally backtest — is periodic/batch, not latency-sensitive. A persistent OS-level daemon's one real advantage (scanning survives the app being fully closed) is achievable more cheaply by keeping Electron tray-resident with an in-process scheduler when the user opts into scanning at all (§8.4), without standing up service-lifecycle/install/uninstall machinery for a single user on a single machine.

The sidecar is spawned and supervised (auto-restart on crash) by Electron's main process. It is a plain compiled Rust binary — no Node ABI coupling, no ASAR packaging concerns — communicating over newline-delimited JSON on stdio, request/response correlated by an id (the same shape as a `oneshot`-channel request/response pattern, kept deliberately simple: no connection pooling or multi-client fan-out, since there is exactly one caller).

| Concern | Owner | Never owned by |
|---|---|---|
| Kite MCP connection (session, auth, all tool calls) | Electron main (TS) | Rust — Rust never touches the network for Kite |
| Claude subprocess invocation, persona pipeline | Electron main (TS) | Rust |
| Algorithm computation, Kronos inference, backtesting/replay | Rust sidecar | Electron/TS — TS never re-implements indicator math |
| Candle/indicator storage | Rust sidecar (DuckDB/Parquet + SQLite) | — |
| Chat/session history persistence | Electron main (TS), its own SQLite store | Rust — kept separate from the candle/algorithm store in §5.3, see §8.5 |
| Chat UI rendering | Electron renderer | Main process (renderer has no Node/Kite access) |

Rationale for keeping Kite ownership in TS rather than Rust: the MCP TypeScript SDK has mature remote-HTTP/Streamable-HTTP client support; nothing equivalent exists ready-made in the Rust ecosystem (even the local `jcode` reference repo's own MCP client is stdio-only and hand-rolled — building an HTTP/SSE MCP client in Rust from scratch would be real, avoidable work). It also keeps every credential/session boundary in exactly one process, which matters for §4.

## 4. Safety Model: The App Never Places An Order

**This is the single most important section of this design, driven by a safety-critical research finding.**

Live protocol testing against the production Kite MCP endpoint (`https://mcp.kite.trade/mcp`, server self-reporting `v0.3.2`) on 2026-07-18 showed it exposes 24 tools, including `place_order`, `modify_order`, `cancel_order`, `place_gtt_order`, `modify_gtt_order`, `delete_gtt_order` — gated by the same generic login-session check as every read tool, with no "tool disabled" response. This directly contradicts Zerodha's own README (`github.com/zerodha/kite-mcp-server`) and support docs, which claim the hosted instance excludes destructive operations by default via a server-side `EXCLUDED_TOOLS` config flag. Two independent research/verify passes confirmed this by directly querying the live server, not by trusting its documentation.

**Consequence: the "never place an order" guarantee must be enforced entirely in this app's own code, and must never depend on Zerodha's current hosted configuration, tool annotations, or documentation, because those have already been shown to drift from reality.**

Enforcement, layered (each layer independently sufficient; together, defense-in-depth):

1. **Primary layer — no method exists.** The Kite MCP session is wrapped in a typed TypeScript class exposing only bound methods for the tools this app actually implements: `searchInstruments`, `getHistoricalData`, `getQuotes`, `getOHLC`, `getLTP`, `getMargins`, `getHoldings`, `getPositions`, `getProfile`, `getGtts` (read-only), `login`. There is no method anywhere in the codebase — and therefore no code path, including one a prompt-injected instruction from untrusted news/MCP content could ever reach — that could invoke `place_order`, `modify_order`, `cancel_order`, `place_gtt_order`, `modify_gtt_order`, or `delete_gtt_order`.
2. **Second layer — CLI-level denylist.** Every `claude` subprocess invocation (AI-Assisted mode only — see §9; Engine-Only mode never spawns `claude` at all) is launched with `--disallowedTools mcp__kite__place_order,mcp__kite__modify_order,mcp__kite__cancel_order,mcp__kite__place_gtt_order,mcp__kite__modify_gtt_order,mcp__kite__delete_gtt_order`, plus `--strict-mcp-config` so no other MCP config source can silently reintroduce capability.
3. **Third layer — drift detection.** At every app startup (and before each Kite session use), the app calls `tools/list` on the live MCP connection and diffs it against an expected/allowed tool-name set. Any unexpected tool appearing, or a previously-excluded write tool becoming newly reachable in some other way, surfaces as a visible warning banner — this is treated as monitoring a remote, operator-controlled surface that has already been observed to change without notice, not a one-time check.
4. If self-hosting `kite-mcp-server` is ever considered instead of the hosted `mcp.kite.trade` endpoint, the self-hosted instance's own `EXCLUDED_TOOLS` env var is set explicitly to cover all six write/GTT-write tool names — as a second-tier safeguard, never the primary one (layers 1–3 already make it irrelevant whether the server-side flag is set correctly).

This is also why the regulatory posture in §12 holds: SEBI's algo-trading rules attach specifically to code paths that place orders. As long as no such path exists — not merely "exists but is unused" — the app stays outside that regime by construction.

## 5. Data Layer

### 5.1 Kite Connect / Kite MCP facts this design relies on

- **Docs root:** `https://kite.trade/docs/connect/v3/`. Auth header for direct REST calls: `Authorization: token api_key:access_token`.
- **Pricing:** the free "Personal" plan has zero market data. The paid "Connect" plan (₹500/month per API key, since a Feb 2025 repricing that folded historical data into the base fee) is required for both historical candles and the WebSocket tick feed. This is a real recurring cost the user carries independent of the Claude subscription — see §10 for how development/testing avoids needing this until the app is ready for live use.
- **Auth flow:** browser login → short-lived `request_token` → `POST /session/token` with `checksum = SHA-256(api_key + request_token + api_secret)` → `access_token`. The access token is **force-invalidated daily at approximately 6 AM the next day**, regardless of issue time — there is no refresh token for ordinary apps, and Zerodha does not recommend automating the login. The app must detect an expired/absent session (a `TokenException`/HTTP 403, or the Kite MCP `login` tool's own auth-gate response) and show a clear "Kite needs login today" banner rather than silently failing or fabricating data — this directly matches the user's own stated requirement to detect and surface auth state.
- **Kite MCP tool inventory** (see §4): auth (`login`), market data (`get_quotes`, `get_ltp`, `get_ohlc`, `get_historical_data`, `search_instruments`), portfolio (`get_profile`, `get_margins`, `get_holdings`, `get_positions`, `get_mf_holdings`), order history read (`get_orders`, `get_trades`, `get_order_history`, `get_order_trades`, `get_gtts`) — all of these are safe to call. The write tools are never called (§4).
- **Historical candles:** `GET /instruments/historical/:instrument_token/:interval`, intervals `minute, 3minute, 5minute, 10minute, 15minute, 30minute, 60minute, day` — no native weekly/monthly, resampled client-side from daily. Community-reported per-request lookback caps (not on the current official docs page — validate empirically before hardcoding pagination): minute ≈60 days, 3/5/10-minute ≈100 days, 15/30-minute ≈200 days, 60-minute ≈400 days, day ≈2000 days.
- **Instrument identity:** key all persisted data on `exchange:tradingsymbol`, never on the numeric `instrument_token` — F&O tokens are recycled every expiry.
- **Rate limits** (per API key): quote endpoints 1 req/sec, historical 3 req/sec — backfills across many symbols must be throttled client-side to this.
- **Index instruments (NIFTY, BANKNIFTY) always report volume=0/OI=0** in historical candles — any volume-based algorithm must special-case indices or fall back to the corresponding futures contract.

### 5.2 Data quality — things Kite does not guarantee, that this app must own

- **Corporate-action adjustment is unreliable at intraday granularity.** Zerodha's own support account and its developer-forum staff give contradictory answers: daily candles are reliably adjusted for splits/bonuses; intraday candles are adjusted only for "recent" actions, with documented cases of stale intraday data showing a raw discontinuity (e.g. a 2015 bonus issue showing ~2× OHLC on old intraday candles). There is no corporate-actions-calendar API. **Design implication:** treat any large single-candle price jump as a "needs corporate-action review" flag rather than a real move, and periodically re-fetch/re-validate cached intraday history rather than treating it as a permanently-valid snapshot.
- **No holiday-calendar API** — the app maintains its own NSE/BSE trading-holiday list; a `from`/`to` window spanning only holidays returns an empty array, not an error, and must not be misread as "no data available."
- **No historical circuit-limit data** — circuit limits are live-quote-only, current-day snapshots; detecting a past circuit lock is a heuristic (flat OHLC + collapsing volume), never exchange-confirmed, and must be labeled as such.
- **Timestamps** are ISO-8601 with an explicit `+0530` offset — always parse offset-aware, never strip to naive (a documented real bug class mis-parses this into corrupted times).
- **A "live" candle is not guaranteed final** the instant it closes — values can still change on refetch shortly after, since the historical service writes asynchronously from ticks. Any live-scoring pass should treat the most recent 1-2 candles as provisional.

### 5.3 Storage

The candle/backtest workload is scan/aggregation-heavy (wide date-range reads, rolling-window math), not point-lookup-heavy — an OLAP shape, not OLTP. Plain SQLite benchmarks one to two orders of magnitude worse on this shape than a columnar engine.

- **Candle lake:** Parquet files, Hive-partitioned by symbol/timeframe/date, queried via embedded DuckDB (`duckdb-rs`) with SQL directly against the partitioned files (`read_parquet()` with predicate/projection pushdown) — one self-contained Rust binary, no server process. This same lake holds both live Kite-sourced candles and, distinctly partitioned/labeled, historical data imported from the public sources in §10 — the algorithm layer reads the same schema either way.
- **Mutable state:** a small SQLite database (`rusqlite`, bundled) for watchlists, alert rules, ingestion checkpoints, and the Kite session-token cache — low-volume, transactional, a poor fit for Parquet's batch-write model.
- Intraday ticks are buffered in memory/SQLite and batch-compacted into the day's Parquet partition at end-of-day, not written per-tick (Parquet is not suited to frequent single-row appends).
- **This SQLite instance belongs to the Rust sidecar and holds only algorithm/market-data state.** Chat/session transcripts are a separate concern, owned and persisted by Electron main in its own store — see §8.5. Neither process reaches into the other's database file.

## 6. Algorithm Layer (Rust sidecar)

### 6.1 Algorithm contract

Every algorithm — classical technical indicator, statistical/quant method, options analytic, or the Kronos forecaster — implements one trait:

```rust
trait Algorithm: Send + Sync {
    fn id(&self) -> &'static str;
    fn required_lookback(&self) -> usize;
    fn applicable_horizons(&self) -> &'static [Horizon]; // Intraday | Positional
    fn compute(&self, ctx: &MarketContext) -> AlgoOutput;
}

struct AlgoOutput {
    algo_id: &'static str,
    symbol: String,
    timeframe: Timeframe,
    horizon: Horizon,
    direction: Direction,      // Bullish | Bearish | Neutral
    magnitude: f64,
    confidence: f64,           // this run's self-reported confidence
    evidence: Vec<String>,     // short human-readable "why" strings
    computed_at: DateTime<Utc>,
}
```

Implementations are pure and deterministic given the same input candles (Kronos included — its forecast is a deterministic function of its frozen weights plus the input sequence, not a source of randomness). They are registered at compile time (static registration, e.g. via `inventory`/`linkme`) rather than dynamically loaded — the binary stays a single, auditable artifact, and "dozens of algorithms" stays maintainable instead of turning into an if-else tree. Execution is parallelized across the (instrument × timeframe × algorithm) cross-product with `rayon`.

This trait and everything built on it (§6.2, §6.3, §6.4) is completely unaware of response modes (§9) — it produces the same `AlgoOutput[]` whether the query came from a free-text AI-Assisted prompt or a structured Engine-Only wizard, and whether the candles came from live Kite data or the public historical-replay harness (§10).

### 6.2 Algorithm catalog (v1)

**Technical indicators** (formulas/parameters per standard references — Wilder, StockCharts ChartSchool, TA-Lib source):
- Trend: SMA, EMA, MACD (12/26/9), ADX/DMI, Supertrend, Ichimoku, Parabolic SAR.
- Momentum: RSI (Wilder, 14), Stochastic (14/3/3), CCI (20), Williams %R, ROC.
- Volatility: Bollinger Bands (20-SMA ±2σ), ATR (Wilder, 14), Keltner Channels, Donchian Channels.
- Volume: OBV, session-anchored VWAP (9:15 IST reset), MFI, CMF, Accumulation/Distribution.
- Pattern recognition: candlestick patterns (engulfing, doji — TA-Lib logic as the auditable reference), chart-pattern/support-resistance heuristics — these have no agreed-upon formal algorithm anywhere in the literature (confirmed by research), so they are explicitly labeled in the UI as heuristic overlays, never as deterministic signals, consistent with the human-in-the-loop mandate.
- Rust implementation: `rust_ti` as the primary crate (actively maintained, zero dependencies, ~70+ indicators), cross-checked against `yata` for anything `rust_ti` lacks (e.g. Heikin-Ashi/Renko). **`ta-rs` is explicitly excluded** — it has a known, unresolved RSI bug (wrong EMA alpha) since 2021.

**Statistical/quant methods:**
- Mean-reversion: Engle-Granger/Johansen cointegration tests, Ornstein-Uhlenbeck half-life estimation, z-score entry/exit bands.
- Volatility regime: range-based estimators computable directly from OHLC (Parkinson, Garman-Klass, Yang-Zhang — Yang-Zhang preferred as the default since it handles both overnight gaps and intraday jumps, matching NSE's daily-gap session pattern), plus GARCH(1,1) for realized-vol modeling.
- Multi-timeframe confluence: an explicitly hand-designed, labeled-as-such rule engine — the research found no academic/standardized formula for this; every real-world implementation is bespoke. Computes the same indicator set per timeframe, forward-fills higher-timeframe values down without lookahead, combines via weighted-sum/count-of-conditions-met.

**Options/F&O analytics** (in scope per the confirmed "any Kite instrument" scope):
- Black-Scholes-Merton Greeks (Delta, Gamma, Theta, Vega, Rho) and implied volatility, using `blackscholes` (github.com/hayden4r4/blackscholes-rust) and/or `implied-vol` (a Rust port of Peter Jäckel's "Let's Be Rational," which is the robust standard for IV solving — naive Newton-Raphson diverges near-zero-Vega, exactly the deep-OTM/near-expiry profile common in NSE weekly chains). NSE index options are European-style (plain BS is exact); individual stock options are American-style physically-settled (BS is an approximation there).
- OI buildup classification (long buildup / short buildup / short covering / long unwinding from the price×OI 2×2 matrix), Put-Call Ratio, Max Pain — all sourced directly from Kite's own OI fields (`oi`, `oi_day_high`, `oi_day_low`, and historical `oi=1`), no external scraping needed. These are presented as **descriptive overlays for human judgment, never as directional signals or confidence scores** — Max Pain in particular is only meaningful in the final days before expiry per the research.

**Kronos** (candlestick foundation model, confirmed real via adversarial verification — MIT-licensed, `github.com/shiyu-coder/Kronos`, arXiv:2508.02739, AAAI 2026): run via the small (mini/small/base, 4M–102M param) open-weight checkpoints through Rust's `ort` (ONNX Runtime) crate inside this same sidecar, registered as one more `Algorithm` implementation. **Open technical spike required before building the rest of the catalog around this assumption:** confirm Kronos's transformer core exports cleanly to ONNX, and reimplement its BSQ tokenizer's quantization step as plain Rust math. If the ONNX export path does not pan out, the fallback is a small local Python/FastAPI sidecar, supervised the same way as the Rust binary, speaking the same JSON-over-stdio-style protocol — same architecture shape, one more child process, not a redesign. Kronos's output is presented as one labeled "model opinion" (a forecast band + conviction) alongside the classical indicators — practitioner consensus found in research treats it as a promising research direction, not a demonstrated production trading edge, so it is never presented as a headline verdict on its own.

### 6.3 Aggregation — deliberately not a single collapsed number

QuantConnect's LEAN engine (a direct architectural reference for "many algorithms feed one decision") was found, on close reading, to default to a "last-writer-wins per symbol" collapse when multiple signal sources disagree — and QuantConnect's own founder cautioned against treating aggregated insights as a proxy for genuinely independent signals. This design deliberately avoids that failure mode: the aggregation step never discards or overwrites a disagreeing algorithm's output.

What reaches the response-generation layer (§7 or §9.2, depending on mode) is always two things:
1. The **full, uncollapsed array** of every algorithm's `AlgoOutput` for the instrument in question.
2. A separate, deterministic, non-AI **confluence scorecard**: counts of bullish/bearish/neutral by horizon, and a weighted-vote score where each algorithm's weight is its own **rolling historical hit-rate from the backtest engine** — kept explicitly distinct from that algorithm's live self-reported `confidence` field. Both numbers travel together; they are never collapsed into one.

Neither response mode ever sees a pre-filtered subset of the algorithm roster's opinions.

### 6.4 Backtesting

The backtest engine replays the exact same `compute()` functions used live, walked forward one candle at a time, with the same anti-lookahead discipline LEAN enforces internally: a bar is never visible to any algorithm before its own `EndTime` has genuinely passed, and all consolidation windows are anchored to exchange-local session time, not UTC or OS locale. Backtesting does **not** invoke Claude per-bar — it is a pure Rust quantitative loop; Claude is only invoked (in AI-Assisted mode) for live/human-facing synthesis, or, on request, to summarize a completed backtest run's report in plain language. Backtest output (per-algorithm hit-rate, expectancy) is what feeds the confluence scorecard's weights in §6.3 — this is the loop that lets "which algorithms have actually been right" inform "how much weight each gets," without ever touching Claude in the loop.

This same engine, fed by §10's public data sources instead of live Kite data, is also the historical-replay harness used to validate the app during development before a Kite Connect subscription is purchased.

## 7. AI Reasoning Layer

This section describes the **AI-Assisted** response mode. See §9 for how the app behaves when the user opts out of AI for a session (**Engine-Only** mode) — the algorithm/data layers (§5, §6) are identical either way; only query intake and final-response generation differ.

### 7.1 Provider abstraction

```typescript
interface Provider {
  complete(envelope: AnalysisEnvelope): Promise<Verdict>;
}
```

`ClaudeCliProvider` is the only implementation in v1, invoking the `claude` CLI as a subprocess per `docs/CLAUDE_USAGE_GUIDE.md` (custom `--system-prompt`, `--json-schema` for structured output, `--output-format json` for the concise-text-plus-structured-detail envelope, session continuity via `--resume`/`--session-id` where a query is a follow-up on a prior one). This interface is the placeholder for future providers (Copilot, Codex, etc.) — nothing else in the app depends on Claude specifically; everything upstream of this interface only knows about `AnalysisEnvelope` and `Verdict`.

Two known limitations of the CLI path to design around: `--json-schema` is best-effort-with-retries (wraps the schema as a synthetic tool call, validates, retries up to a cap), not the raw Messages API's constrained-decoding guarantee — the app must handle a `structured_output`-absent response as a real failure mode, not assume it never happens. Prompt caching (Anthropic's ephemeral 1-hour cache) should be relied on deliberately: the system prompt and tool definitions are large and reused across every query in a session, so structuring calls to maximize cache hits materially controls cost.

### 7.2 Persona pipeline

Rather than one monolithic prompt trying to reason about everything at once, synthesis is a short pipeline of Claude invocations, each with its own system-prompt persona, all still the single Claude subscription invoked multiple times per query (no extra accounts/keys):

- A persona focused on options/OI/Greeks reading.
- A persona focused on technical/quant confluence reading.
- A persona focused on position/risk framing (relevant when the query is reactive on a held position).
- A final **synthesis persona** that must cite specific evidence from the others (by `algo_id`, not vague paraphrase) before producing the verdict.

This is an internal pipeline detail, not visible to the user as separate "chats" — the chat UI presents one coherent answer per query.

### 7.3 Envelope contract

```typescript
interface AnalysisEnvelope {
  trigger: "reactive" | "proactive_scan";
  instrument: { symbol: string; exchange: string; segment: string; kite_token_asof: string };
  horizon_requested: "intraday" | "positional" | "auto";
  intent_lens: "buying" | "selling";     // see §9.2 — same field Engine-Only mode's wizard collects
  algo_results: AlgoOutput[];           // full, uncollapsed — see §6.3
  confluence: ScorecardSummary;
  overlays: { oi_buildup?: string; pcr?: number; max_pain?: number; greeks?: object; kronos_forecast?: object };
  position_context?: { qty: number; avg_price: number; pnl: number };
  news_context?: CitedHeadline[];        // AI-Assisted mode only — see §9.2
  session_id?: string;
}

interface Verdict {
  direction: "sell" | "hold" | "add" | "watch";
  conviction: "high" | "medium" | "low";
  reasoning: string;              // must cite specific algo_ids
  verify_before_acting: string;   // mandatory: what the human should check in Kite itself
}
```

### 7.4 System prompt principles

The system prompt is engineered (via the prompt-engineer skill, at implementation time) around patterns found directly in Anthropic's own public reference prompts for this exact domain (`anthropics/financial-services`):
- **Evidence citation is mandatory** — every claim traces to a specific `algo_id`/tool call; unsourced figures are marked as such rather than estimated.
- **No-execution is enforced by tool absence, not by instruction** — the persona pipeline is never given any tool that could place an order (see §4); the prompt does not need to "promise" not to trade, because it structurally cannot.
- **Untrusted external content** — any news/third-party text pulled via MCP or web search is treated as data to extract, never as instructions to follow (directly relevant since this app pulls live news/sentiment text into the same context Claude reasons in).
- **Conviction taxonomy** — High/Medium/Low conviction, kept separate from the factual citations backing it, matching Anthropic's "Calibrated" honesty framing (stated confidence should match actual evidence strength, never overstate or understate it).
- **Dual output mode** — a concise, decision-ready default (mirroring the old prototype's ~8-12 line concise mode) and a full structured report on request ("full"/"detailed"), using the `result` (text) + `structured_output` (schema-validated) split the CLI's JSON output format already provides natively. Engine-Only mode (§9.2) mirrors this same concise/full split with its own templates, so switching modes doesn't change the shape of what the user reads.
- **Voluntary AI-use disclosure** — Anthropic's own usage policy classifies "financial advice" as a high-risk use case warranting clear AI-use disclosure; adopted here even though this is a single-user tool, since it costs nothing and matches the spirit of the user's own requirements. This is moot in Engine-Only mode, which is inherently and visibly non-AI.

## 8. Electron Application

### 8.1 Process topology & scheduling

Proactive watchlist scanning is **opt-in, off by default** (§8.4) — most sessions run purely reactively, with the Rust sidecar and Kite MCP connection only active while a query is in flight. When the user turns scanning on, Electron main stays tray-resident so the scheduler can run on a timer without a chat window needing to be open — this is what makes "proactive scanning" work without standing up a separate OS-level daemon (§3). A deterministic pre-Claude gate (confluence delta exceeds a threshold, an IV spike, an OI-buildup flip) decides whether a given scan tick is worth spending an actual Claude call on (AI-Assisted mode) or just re-rendering a deterministic summary (Engine-Only mode, §9.2) — so the app isn't spending a synthesis call, or even meaningfully waking up, on every watchlist symbol every tick when nothing has changed. When scanning is off, none of this scheduler code runs at all.

### 8.2 Security architecture

- Every `BrowserWindow`: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. Capabilities exposed to the renderer only via `contextBridge.exposeInMainWorld`, backed by named `ipcRenderer.invoke`/`ipcMain.handle` wrappers — the raw `ipcRenderer` module is never exposed.
- All outbound Kite/Kite MCP calls are funneled through the main process; the renderer never has network access to Kite, even indirectly.
- **Any AI-generated markdown rendered in the chat UI is sanitized with DOMPurify using an explicit `ALLOWED_TAGS`/`ALLOWED_ATTR` allowlist, non-negotiably.** This is not a hardening nice-to-have: a real, recently-patched CVE (DeepChat, Feb 2026) is architecturally identical to this app — Electron + AI chat + unsanitized markdown rendering let an `<img onerror>` payload reach an exposed `contextBridge` method and escalate renderer XSS into local action. A real CSP (`default-src 'none'; script-src 'self'; object-src 'none'`, no `unsafe-inline` for scripts) is layered on top as defense-in-depth, not a substitute for sanitization. This applies equally to Engine-Only mode's templated output, since template fragments still get rendered as markdown.
- `setWindowOpenHandler` defaults to deny; any exposed "open external link" bridge method validates the protocol (`http:`/`https:`/`mailto:` only) before calling `shell.openExternal`.

### 8.3 Chat UI

A standard chat-app layout: message list (markdown + tables + inline Mermaid diagrams, streamed token-by-token in AI-Assisted mode) and a message input box. Diagrams/tables from algorithm output and backtest reports render inline rather than as attachments. Setup/session state surfaces as banners rather than blocking dialogs:
- Claude auth not detected → banner prompting `claude auth login` (or the app's own wrapper around it) — only relevant/shown when AI-Assisted mode is in play.
- Kite session expired/absent (today's daily re-login not done yet) → banner prompting the Kite login flow, matching the "first call each session may need a login popup" behavior the old prototype already surfaced correctly.
- Kite MCP tool-list drift detected (§4, layer 3) → visible warning banner, not a silent log line.

**Before any new session's chat begins, the UI presents a mandatory choice: use AI this session, or run the algorithm engine alone (§9).** This is the first thing the user sees, ahead of the message box — not a settings toggle, and not skippable via a remembered default (§8.4).

In Engine-Only mode, the message input box is replaced by the structured question wizard described in §9.2 for the initial query; once the wizard completes and a verdict is shown, follow-up refinement (e.g. "what about a different horizon for the same instrument") re-runs the wizard rather than accepting free text, since there is no AI in this mode to interpret it.

Kite's OAuth redirect handling for a desktop app is not officially documented for Electron specifically (forum-sourced suggestions only: a static registered `redirect_url` + manual token copy, a localhost listener, or capturing the redirect inside an in-app `BrowserWindow`) — this is an implementation-time decision to validate directly against current Kite Connect docs, not settled by this design.

### 8.4 Settings window

A dedicated Settings window (not buried in the chat UI) holds standing preferences, separate from the mandatory per-session AI/Engine-Only choice (§9). v1 scope:
- **Proactive watchlist scanning: on/off, default off.** Nothing scans in the background until the user explicitly opts in here; turning it on is what activates §8.1's scheduler and tray-resident behavior. Turning it off at any time stops the scheduler immediately.
- Watchlist/portfolio membership (which instruments the scanner covers, when enabled).
- Kite/Claude account status (read-only display — links out to the relevant login flow, doesn't itself hold credentials beyond what §5.1/§4 already manage).

This window deliberately does **not** include a way to skip or pre-answer the per-session AI/Engine-Only prompt (§9) — that choice is asked fresh every session by design, never cached as a settings default.

### 8.5 Chat / session history

Standard chat-app behavior applies here too: **every session's full transcript persists locally, browsable and reopenable later, regardless of which response mode produced it.** This was missing from the earlier revision of this design and is now an explicit requirement, not an implementation detail left to chance.

- **What's captured, for both modes identically:** every user turn (a free-text query in AI-Assisted mode, or the picked answers from the Engine-Only wizard, §9.2), every resulting answer (Claude's persona-pipeline narrative, or the deterministic template's rendered text), and the structured payload behind that answer (`AlgoOutput[]`, the confluence scorecard, the `Verdict`/templated-equivalent) so a past session can be inspected in full later, not just re-read as prose.
- **Storage:** a small SQLite database owned by Electron main (per §3's ownership table and separate from the Rust sidecar's own SQLite, §5.3) — a `sessions` table (id, started_at, ended_at, response_mode, instrument(s) touched) and a `messages` table (id, session_id, role, rendered_text, structured_payload, created_at). Local-only, single-user, no additional exposure beyond what already applies to the rest of this app's on-disk state (§5.3's candle/position data sits under the same posture).
- **UI:** a history list/sidebar (the same pattern as Claude Code's own `/resume` picker, or any ordinary chat app's conversation list) to browse and reopen past sessions — reopened sessions show the full past transcript.
- **Distinct from Claude's own multi-turn memory** (§7.1's `--resume`/`--session-id`, which is what keeps one *active* AI-Assisted conversation coherent turn-to-turn to Claude itself): this is the UI-level record of every session ever run, in either mode, kept whether or not that session is ever resumed conversationally. Engine-Only mode has nothing analogous to `--resume` (there's no model to resume a conversation with — a follow-up just re-runs the wizard, §8.3), but its transcripts persist and are browsable exactly the same as AI-Assisted ones.

## 9. Response Modes: AI-Assisted vs Engine-Only

Every new session starts with an explicit, mandatory choice presented in the UI before anything else happens (§8.3): **use AI this session, or run the algorithm engine alone.** This is asked every time, not cached as a settings default (§8.4) — the user may want a quick deterministic read one session and a fully-reasoned AI read the next, and the app should never assume which.

The two modes share the entire data layer (§5) and algorithm layer (§6) unchanged — every algorithm, every candle, every piece of storage, the confluence scorecard, the backtest engine, all run identically regardless of mode. **The only things that differ are how the app learns what the user is asking, and how the final answer gets written.** This is a deliberate architectural boundary: nothing in §5/§6 is aware that response modes exist at all.

### 9.1 AI-Assisted mode

Exactly as designed in §7: free-text query intake (Claude interprets instrument/horizon/intent from natural language, can pull in live web/news research where useful), full persona pipeline, Claude-authored narrative verdict with citations.

### 9.2 Engine-Only mode

No Claude call happens anywhere in this path — zero token cost, works with no Claude auth at all.

**Query intake — structured, not free-text.** Since there's no AI to parse open-ended language, the same inputs a free-text query would otherwise supply are instead collected through a deterministic, hardcoded question-and-answer wizard in the UI — modeled on the same one-step-at-a-time interactive-picker feel as Claude Code's own clarifying-question prompts, but with a fixed, pre-written question tree the app ships with, not anything generated on the fly:
1. **Buying or selling?** — the intent lens: are we evaluating an add/entry, or an exit/reduce on something already held. This is the same `intent_lens` field the AI-Assisted envelope carries (§7.3) — both modes resolve to the identical field, just via different input methods.
2. **Which instrument?** — a filtered/autocomplete picker backed directly by Kite's `search_instruments` (§5.1) — plain deterministic search-and-select, no language understanding required.
3. **Horizon** — intraday / positional / auto (auto lets the algorithm layer's own multi-timeframe confluence decide, same as the AI path's "auto").
4. If the lens is "selling" and the instrument is a held position, the position context (qty/avg price) is pulled automatically from `get_positions`/`get_holdings` (§5.1), not re-asked.

This produces the exact same `MarketContext`/query-parameter shape the AI path would have extracted from free text — the algorithm layer (§6) receives an identical input either way and cannot tell which mode produced it.

**Response generation — templated, not generated.** A `DeterministicResponseGenerator` renders the same `AlgoOutput[]` + confluence scorecard (§6.3) that AI-Assisted mode would hand to Claude, but through fixed, hand-written prose templates instead of a language model — direction comes from the scorecard's weighted vote, conviction from the vote's agreement ratio/strength (not a self-reported LLM confidence), the top contributing algorithms are cited by name as the "why," and the same "verify before acting in Kite yourself" boilerplate line every mode always shows. Output reads as a concise, humanly-written summary — the words are fixed template fragments, but which fragments get selected and what numbers fill them in is entirely driven by real computed data, never canned regardless of input. A "full" variant of the same template (mirroring §7.4's concise/full split) is available on request, walking through every algorithm's contribution instead of just the top few.

**No web/news research in this mode.** Judging news/sentiment text is inherently a language-reasoning task; the deterministic engine doesn't attempt it. Engine-Only overlays are limited to what's directly computable from Kite (or, in development, the public data harness's) candle/OI data (§6.2) — the same options analytics, TA, quant, and Kronos-forecast overlays as AI-Assisted mode, just without the `news_context` field of the envelope populated.

**Design intent:** this mode exists so the core algorithm engine's value can be validated and used entirely on its own — no AI dependency, no Claude token spend, fully deterministic and reproducible end to end. This is also exactly why §10's public-data backtesting harness deliberately exercises the algorithm layer standalone, so it can be validated in Engine-Only mode without needing Claude auth at all, and separately, optionally, in AI-Assisted mode when the synthesis layer itself needs checking.

## 10. Public No-Auth Historical Data for Development & Backtesting

The app's live/production data source is Kite (§5), which costs ₹500/month and requires a daily login. During development — building and validating the algorithm catalog, the confluence scorecard's weighting, and both response modes — that cost and friction isn't worth paying yet. This section covers what free, no-authentication historical data actually exists for that purpose, researched and fact-checked directly rather than assumed.

### 10.1 What's genuinely reliable: daily/EOD data

NSE and BSE both publish daily end-of-day bhavcopy files for free, with no authentication:
- NSE equity: `nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{YYYYMMDD}_F_0000.csv.zip`
- NSE all-indices daily close (Nifty 50, Bank Nifty, and ~160 others in one file): `nsearchives.nseindia.com/content/indices/ind_close_all_{DDMMYYYY}.csv`
- BSE equity: `bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_{YYYYMMDD}_F_0000.CSV` (same UDiFF schema as NSE)

Confirmed live: a plain HTTP client needs a `User-Agent` header (a bare request gets a connection reset) but otherwise needs no cookies, session, or auth — and this gives years to decades of daily OHLCV, officially published on an ongoing daily basis (unlike the community archives in §10.2, this doesn't stop being maintained).

**This is the backbone of the historical-replay harness for positional/swing-horizon algorithms** — deep, free, reliable, no-auth daily history that can be loaded into the same Parquet/DuckDB lake (§5.3) the live app uses, walked forward through the exact same backtest engine (§6.4).

**Caveat, carried over honestly rather than glossed over:** both NSE's and BSE's Terms of Use explicitly prohibit "systematic or automated data collection" — including for these static bhavcopy files — without written consent. Enforcement risk is low for personal, low-frequency (once-daily) pulls, and this is how a whole ecosystem of personal-use tools already operates, but it's a real ToS conflict, not a non-issue. It sits alongside §12's other documented-not-litigated regulatory notes.

### 10.2 What exists but is genuinely weaker: intraday/minute data

There is no equivalent official, reliable, ongoing free source for intraday (minute-level) candles. What's actually out there, checked directly rather than assumed:

- **Community archives** — a Kaggle dataset family (`debashis74017/...`, Nifty 50/100/500 + Bank Nifty, 1/5/15-minute, 2015→present, apparently updated regularly) and a static GitHub archive (`aeron7/nifty-banknifty-intraday-data`, 1-minute OHLCV across ~150 F&O stocks/futures/sector indices/VIX, 2007/2012 through Feb 2023, then frozen). Both are free and need no authentication. Neither has a clear license, an SLA, or a guaranteed-continuous maintainer, and neither has an independently-audited data-quality/corporate-action-adjustment story.
- **Every "live scraper" library** (jugaad-data, nsepython, nsepy) either doesn't support intraday granularity at all (confirmed by direct source inspection — they're daily/EOD/live-snapshot only), or is dead (nsepy), and all of them operate in direct, explicitly-named violation of NSE's Terms of Use ("scraping, data mining, data extraction and data harvesting" is banned in so many words).
- **yfinance** does return real intraday candles for NSE tickers (`.NS` suffix) with no India-specific penalty, but only within Yahoo's universal shallow window (~7 days at 1-minute, ~60 days at 2–90 minute, ~2 years at hourly) — never deep multi-year history — and Yahoo's own ToS similarly bans automated scraping.
- No mainstream "free tier" market-data API (Alpha Vantage, Twelve Data, EODHD) delivers years of free NSE intraday history either — they've dropped NSE coverage, cap the free tier to weeks/months, or gate real intraday history behind a paid plan.

**Practical use:** the Kaggle + `aeron7` GitHub combination is real, free, multi-year, sub-daily data — good enough to seed and validate the intraday side of the backtest/replay harness during development. It is explicitly **not** treated as a long-term or production data dependency: no continuity guarantee, unclear licensing, unaudited quality. Once the app is live on a real Kite Connect subscription, it should also start incrementally recording its own intraday history from that live feed into the same Parquet lake (§5.3) going forward — building a first-party archive over time rather than depending on community datasets indefinitely (see §16).

### 10.3 The historical-replay harness

This is the concrete mechanism for the "run it against real past data, one chunk at a time, then compare against what actually happened" validation the user described. It is not a new engine — it is §6.4's backtest engine, pointed at §10.1/§10.2's data instead of a live Kite feed, with its output compared against the realized future:

1. Historical candles (daily from bhavcopy, intraday from the community archives) are loaded into the same Parquet/DuckDB schema live data uses, tagged by source so it's always clear which candles are real-time-sourced versus historical-import-sourced.
2. The engine picks a point-in-time frontier `T` and reveals candles only up to `T` — the same frontier-gating discipline as live backtesting (§6.4) — then runs the **full** pipeline (algorithm layer + confluence scorecard, and, at the operator's choice, either response mode) exactly as if `T` were "now." This produces a verdict.
3. The frontier is then advanced to reveal the candles that actually came after `T` (already sitting in the historical dataset, just not yet shown to the pipeline), and the verdict's direction/conviction is compared against what actually happened next.
4. Repeating this across many historical points produces a hit-rate/expectancy report per algorithm — the same number that already feeds the confluence scorecard's live weighting (§6.3) — plus, distinctly, an end-to-end check of whatever response mode was exercised (does Engine-Only's templated verdict, or AI-Assisted's Claude-authored one, actually track what a human would consider "right" against the realized outcome).

This lets the entire core engine — and, when desired, the AI synthesis layer on top of it — be validated against years of real market behavior before ever paying for or authenticating against Kite, exactly matching the intent: Kite/live data for real-time production use, the public-data replay harness for development and benchmarking.

### 10.4 Benchmark UI

A dedicated **Benchmark** screen, reachable from the app's main navigation as its own mode — separate from a normal chat session (§8.3) and not logged into chat/session history (§8.5), since a benchmark run is a test of the engine, not a question the user is asking. It exists specifically to make §10.3's replay harness visual and inspectable, instead of a results-only text dump.

**Setup:** instrument picker (same deterministic search as §9.2's wizard), a date range, and which response mode to benchmark — Engine-Only for fast, free, repeatable iteration, or AI-Assisted to additionally exercise the Claude synthesis layer, clearly labeled as spending real Claude usage when picked. Available date range is whatever §10.1/§10.2's underlying source actually covers (deep history for daily/positional via bhavcopy, a bounded window for intraday via the community archives) — the UI shows the actual covered range up front rather than letting the user pick a date nothing exists for.

**Rendering — a real candlestick chart, not a table of numbers.** Uses `lightweight-charts` (TradingView, Apache-2.0, confirmed actively maintained into 2026, bundles fully offline with no remote calls — satisfies §8.2's CSP with no exception needed): the full price series for the chosen instrument/range as a candlestick series with a volume histogram underneath, and a marker placed directly on each decision-point candle from the replay run — shape/color encoding correct (e.g. green up/down arrow matching the realized move), wrong (red), or neutral/inconclusive (gray). This is the library's own purpose-built marker API (`createSeriesMarkers`), not a custom overlay bolted on.

**Kept deliberately uncluttered, per the explicit requirement.** The chart with its markers is the whole primary view. A single thin summary strip above it shows just the headline numbers — overall hit-rate %, and correct/incorrect/neutral counts — nothing else by default. Clicking or hovering a marker reveals that one decision point's detail (the verdict's direction/conviction/reasoning, which algorithms drove it, and what price actually did afterward) in a small popover/side panel — progressive disclosure, not every field shown at once for every marker.

**Copy raw result button.** Serializes the entire run — every decision point's frontier timestamp, full `AlgoOutput[]` + confluence scorecard, the `Verdict`/templated-equivalent, the realized subsequent price action, and its hit/miss/neutral classification — as one JSON blob to the clipboard. This is explicitly meant to be pasted to a coding agent (this same assistant, in a later session, or any other) to debug why a specific call was wrong — the structured data behind the chart, not a screenshot, so an agent can reason over it directly rather than guess from a picture.

**Nothing new is built to make this possible** — the chart visualizes exactly what §10.3's harness and §6.4's backtest engine already produce; this section is a UI layer on top, not a second benchmarking implementation. Clipboard write goes through the same contextBridge/`ipcMain.handle` pattern as every other renderer-to-main capability (§8.2) — the renderer never gets raw clipboard/Node access.

## 11. Platform & Build

Target platforms: macOS and Windows (per user's stated focus). Verified research found that cross-compiling a native Node addon to Windows-MSVC from a macOS host currently has real, open toolchain bugs concentrated exactly in networking/TLS crates — which is moot here anyway, since the sidecar design (§3) means the Rust binary is a plain executable, not a Node addon. The lowest-friction, most reliable build path (matching what the wider ecosystem's own tooling defaults to) is a GitHub Actions CI matrix building each target natively on its own OS runner (`macos-latest` + `windows-latest`, comfortably inside the free tier for infrequent personal builds) rather than cross-compiling from one machine. `reqwest`/networking crates use `rustls`, not `native-tls`/`openssl`, to avoid the OpenSSL cross-compile pain class entirely. The user has direct Windows access (physical PC or VM) for manual verification of packaging/installer behavior alongside CI builds — code signing/notarization are skipped entirely as unnecessary for a locally-built, never-distributed personal app (Gatekeeper/SmartScreen only trigger on files carrying quarantine/Mark-of-the-Web attributes, which locally-built binaries don't carry).

## 12. Regulatory Posture (SEBI) — documented awareness, not legal advice

Research (confirmed by both adversarial verify passes, against the primary SEBI circular text) found that SEBI's algorithmic-trading rules (SEBI/HO/MIRSD/MIRSD-PoD/P/CIR/2025/0000013) define "Algo" narrowly as "orders generated using automated execution logic" — every obligation (order-ID tagging, registration above a 10-orders/second threshold, static-IP whitelisting) attaches to code paths that place orders. A tool with no such code path at all (§4) generates no "algo order" and has nothing to register. SEBI's separate Research Analyst/Investment Adviser registration regime is scoped to advice given to another person for consideration — a tool used solely by its own builder, for no consideration, falls outside that regime on the same plain reading. Neither point is an explicit regulator-issued safe harbor in so many words (no SEBI document says "read-only personal tools are exempt" in those terms) — it is a definitional inference from the circular's own scope, Zerodha's Kite Connect terms, and NSE's own FAQ, consistently corroborated across sources but not litigated. The one thing that would definitely change this posture: adding any order-placement feature at all, ever — which is precisely why §2 treats that prohibition as permanent, not a v1 simplification. §10.1's bhavcopy ToS caveat is a separate, unrelated matter (NSE/BSE's own data-reuse terms, not SEBI's algo-trading rules).

## 13. Testing Strategy

- **Algorithm layer:** each indicator/statistical method is unit-tested against known reference values (hand-computed or cross-checked against a second implementation, e.g. `rust_ti` vs `yata` where both implement the same indicator) — given `ta-rs`'s own RSI bug was found in research, no indicator ships without an independent correctness check.
- **Anti-lookahead:** backtest engine tests specifically assert that no algorithm's `compute()` ever receives a candle whose `EndTime` is in the future relative to the simulated "current" instant — mirroring the two concrete gates LEAN uses internally. The same assertion applies to the historical-replay harness (§10.3): the frontier-gating logic is one shared implementation, tested once.
- **Historical-replay validation:** per §10.3, both response modes are run against the public-data harness across many historical points and checked for a sane hit-rate/expectancy distribution before ever being pointed at live Kite data — this is the primary pre-production confidence check for the whole pipeline, not just a nice-to-have.
- **Response-mode parity:** a test confirms both response modes, given the identical `AlgoOutput[]`/confluence scorecard input, produce a verdict referencing the same underlying facts (even though Engine-Only's is templated and AI-Assisted's is Claude-authored) — catching any accidental divergence in what data reaches each path.
- **History persistence:** a test confirms a completed session's transcript (messages + structured payloads) is written to Electron main's session store and reloads correctly after a full app restart, for both response modes — this is the concrete check behind §8.5's persistence requirement, not just a UI-level impression that it works.
- **Safety allowlist:** an integration test asserts that the Kite session wrapper class exposes exactly the read-tool method set from §4 and no others — this test should fail loudly if a future refactor ever adds a write-tool method by accident.
- **MCP drift detection:** a test/startup-check path exercises the `tools/list` diff logic against both an expected-shape response and a deliberately-mutated one (simulating a new tool appearing) to confirm the warning banner actually fires.
- **Electron security:** a test confirms `contextIsolation`/`sandbox` are on for every created `BrowserWindow`, and a DOMPurify test feeds a known XSS payload class (matching the DeepChat CVE shape) through the markdown-render path to confirm it's neutralized — exercised against both response modes' output.
- **UI:** manual verification in the running app (per the `verify` skill) for the chat flow, the mandatory AI/Engine-Only session prompt, both auth banners, the Engine-Only question wizard, a proactive-scan tick, and the Benchmark UI end-to-end (run a benchmark, confirm the chart and its correct/incorrect markers render sensibly, confirm the copy-raw-result button produces valid, complete JSON) — automated UI testing is not the priority for a single-user personal tool, but the golden path must be manually driven at least once per milestone.

## 14. Open Questions Carried Into Implementation Planning

These don't block writing the implementation plan, but should be resolved early in it:

1. Kronos → ONNX export feasibility (§6.2) — early spike, before building the rest of the algorithm catalog around the assumption it works.
2. Exact current per-interval historical-data lookback caps — validate empirically against the live API rather than trusting community-sourced numbers.
3. Whether `mcp.kite.trade` currently excludes GTT write tools specifically or only the three plain order tools — irrelevant to safety (§4 already assumes none of them are ever called) but relevant to understanding what "drift" looks like in the layer-3 monitor.
4. Kite's desktop OAuth redirect-capture mechanism (§8.3) — no official Zerodha guidance for Electron; pick one of the three forum-sourced approaches and validate it directly.
5. Whether true Volume Profile is computable from Kite's OHLCV-bar-only historical data or needs approximation — not conclusively resolved in research.
6. Re-run the Kite MCP live `tools/list` check as part of initial implementation to confirm the exact current tool set before writing the allowlist wrapper's method list.
7. Review the actual license terms on the Kaggle dataset family and the `aeron7` GitHub archive (§10.2) before relying on either beyond personal development/testing use — neither had a clearly confirmed license during research.
8. Decide the exact historical-replay harness UX (§10.3) at implementation time — resolved in part by §10.4's Benchmark UI, but the decision-point sampling frequency (every candle vs every N candles vs session boundaries) is still an implementation-time tuning choice.

## 15. Out of Scope (v1)

- Any order-placement, modification, cancellation, or GTT-write capability — permanently, not just for v1 (§2).
- TTS/STT (see `docs/TTS_STT.md` for the reference pattern if revisited).
- Any AI provider other than Claude (the provider interface exists; only one implementation does).
- Multi-user/shared/server-reachable-from-outside-localhost anything.
- Automated/cron-triggered trading logic of any kind. Proactive scanning (§8.4) is opt-in and only ever produces information, never actions.

## 16. Future Extension Points

- Additional `Provider` implementations behind the same interface (§7.1).
- Promoting the Rust sidecar to a persistent local service (Option C considered and deferred in §3) if a future need for app-closed scanning or a second frontend ever justifies the added operational complexity — the algorithm registry, storage layer, and backtest engine don't change at all if this happens; only the transport does.
- Recording the app's own live Kite-sourced intraday candles into the Parquet lake over time (§10.2), gradually reducing reliance on the community-archive datasets for anything beyond bootstrapping.
- Voice I/O per `docs/TTS_STT.md`'s existing macOS-only pattern, gated behind an OS check, layered on top of the same text-in/text-out chat pipeline.
