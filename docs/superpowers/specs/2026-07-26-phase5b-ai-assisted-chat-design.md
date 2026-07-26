# Phase 5b — AI-Assisted Chat: Streaming, Web Research, Mermaid, Intent Lens, Mode Picker

Status: approved by user 2026-07-26 (brainstorming dialogue), pending implementation planning.
Author: design produced via superpowers:brainstorming, elaborating §7, §8.2, §8.3, §9 of `docs/superpowers/specs/2026-07-18-trade-assistant-design.md` and continuing the Phase 5 decomposition begun in `docs/superpowers/specs/2026-07-25-phase5a-live-wiring-design.md`.

Phase 5 ("response modes / chat UI / history") was decomposed into four sub-phases (5a→5b→5c→5d). 5a (merged to main) wired the Engine-Only deterministic path end-to-end live. This spec covers **only 5b**: wiring the AI-Assisted mode on top of Phase 4's already-built, headless-tested `Provider`/`ClaudeCliProvider`/persona pipeline. Section references: "§N" → master design; "P4§N" → `docs/superpowers/specs/2026-07-24-phase4-claude-integration-design.md`; "P5a§N" → `docs/superpowers/specs/2026-07-25-phase5a-live-wiring-design.md`; "P5b§N" → this document. Where a decision here narrows, defers, or diverges from a prior doc, it is called out in P5b§12 rather than left to silently drift.

## P5b§1 Purpose

Phase 5b makes the **AI-Assisted** response mode real and reachable from the UI: free-text natural-language intake, live web/news research, a Claude persona pipeline that produces a schema-validated `Verdict`, and a token-by-token streamed prose narrative rendered as sanitized markdown (with tables and Mermaid diagrams) in a chat UI. It also introduces the mandatory per-session **mode picker** (§8.3/§9), promotes the placeholder `intent_lens` (hardcoded `"buying"` since 5a) into a real user control threaded into persona prompts, and adds the DOMPurify markdown-sanitization path §8.2 mandates for **both** modes.

Everything obeys the master hard constraints (§2, §4): **the app never places, modifies, cancels, or automates an order.** 5b adds no Kite write path and adds a new capability — Claude's own read-only web tools — behind the same closed, explicit `--allowedTools` allowlist mechanism Phase 3/4 established, with the wording constraint (P4§8) carried into every new persona and an explicit prompt-injection defense for untrusted fetched content (P5b§5).

## P5b§2 Scope

**In scope (the six new capability areas):**

1. A NEW "intake" Claude call: free-text query → structured `{ instrument, horizon, researchNotes? }`, with live Kite `search_instruments` and web-tool access (P5b§4).
2. Streaming synthesis split: the existing schema-validated `Verdict` call (buffered JSON, unchanged from Phase 4) **plus** a NEW streamed "narrative" prose call using `--output-format stream-json` (P5b§3).
3. Web/news research tool access for the intake and the three analytical personas, granted by an **additive** extension of `claudeProvider.ts`'s allowlist mechanism, plus a shared prompt-injection-defense fragment (P5b§5).
4. Mermaid rendering, CSP-safe, as output of the AI-Assisted narrative only (P5b§6).
5. The real `intent_lens` control, shared by both modes and threaded into persona prompts (P5b§7).
6. The mandatory per-session mode picker, the chat UI, and markdown+DOMPurify sanitization applied in **both** modes (P5b§8, P5b§9).

**Not in scope (later sub-phases — interfaces left open, nothing built):**

- **5c (session/history SQLite store):** nothing is persisted. The `AnalysisResult.mode` discriminator (5a's seam, extended here to `"ai_assisted"`) and the structured payload it carries stay 5c-ready, but no `sessions`/`messages` tables, no reopen/browse (§8.5).
- **5d (settings + scan scheduler):** no settings window, no proactive scanning, no tray-resident scheduler. The mode picker is explicitly **not** a setting and is never cached as a default (§8.4).
- **`auto` horizon** stays unoffered — the single-horizon compute path can't honor it yet; 5a's deferral (P5a§12 tension 3) continues (P5b§12 tension 5).
- **Populating the envelope's `news_context: CitedHeadline[]`** from an app-assembled feed — 5b's news reaches Claude through the model's own web-tool calls, not a pre-fetched array (P5b§12 tension 1).

## P5b§3 Streaming architecture — synthesis split into two calls

Phase 4's pipeline is: three analytical personas run in parallel (each emits a schema-validated `PersonaFinding`, internal, never shown to the user), then a fourth **synthesis** call produces the schema-validated `Verdict` (`personaPipeline.ts`, with the `cited_algo_ids ⊆ envelope` citation check). 5b keeps that shape **unchanged** and adds one call after it.

- **Verdict call — unchanged from Phase 4.** Still buffered `--output-format json` + `--json-schema` via `makeClaudeRunner`/`spawnClaude` exactly as `claudeCliProvider.ts`/`personaPipeline.ts` do today. The `Verdict` (`direction`, `conviction`, `reasoning`, `cited_algo_ids`, `verify_before_acting`) is fully validated and citation-checked **before** any prose is streamed. This is the safety-critical, enum-constrained output.
- **NEW narrative call (5th, streamed).** A "narrative" persona receives the already-validated `Verdict` plus the three `PersonaFinding`s and writes flowing human-readable prose explaining the verdict — **no JSON, no `--json-schema`, pure text** — invoked with `--output-format stream-json --include-partial-messages` so the chat UI renders it token-by-token. It carries the wording constraint (P4§8 `WORDING_CONSTRAINT`) — describing an already-safe, enum-constrained `Verdict`, so this is a voice/tone concern, not a new safety boundary — plus `INJECTION_DEFENSE` (P5b§5, because it receives untrusted `researchNotes`). It reuses `buildClaudeArgs`/`spawnClaude` (Kite read allowlist + write denylist + `--strict-mcp-config`) like every other call, with **no** web-tool grant (P5b§5 rationale). No new subprocess-spawning path is introduced.

Splitting verdict from narrative means the streamed prose can never change the machine-checked direction/conviction/citations — those are frozen before streaming starts. `Verdict.reasoning` remains the short machine-checkable cited summary; the narrative is the richer human-facing expansion (P5b§12 tension 2).

### P5b§3.1 The `--output-format stream-json` event shape (grounded, not guessed)

Verified against `docs/CLAUDE_USAGE_GUIDE.md` (CLI v2.1.209): `stream-json` emits **newline-delimited JSON objects**, one per line. Sub-message (token) granularity requires `--include-partial-messages`; without it, assistant turns arrive whole, not token-by-token. Each line has a top-level `type`:

- `{"type":"system","subtype":"init","session_id":"...","tools":[...],"model":"..."}` — once, at start.
- `{"type":"stream_event","event":{...},"session_id":"..."}` — present only with `--include-partial-messages`. `event` is a raw Anthropic streaming event; the token deltas are:
  `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Bank"}}}`
  (surrounded by `message_start` / `content_block_start` / `content_block_stop` / `message_delta` / `message_stop` events).
- `{"type":"assistant","message":{...full Anthropic message...},"session_id":"..."}` — the complete buffered turn.
- `{"type":"result","subtype":"success","is_error":false,"result":"<full text>","session_id":"...","total_cost_usd":...,"usage":{...}}` — terminal; `.result` is the complete narrative.

**Capture code shape** (`services/claude/streamingNarrative.ts`, new): read `child.stdout`, buffer, split on `\n`, `JSON.parse` each **complete** line (carry a partial trailing fragment across chunks). For each parsed line where `type === "stream_event" && event.type === "content_block_delta" && event.delta.type === "text_delta"`, invoke an `onToken(event.delta.text)` callback. On the `type === "result"` line, resolve with `line.result` (the authoritative full text). Treat non-`success` `result.subtype`, a missing terminal `result`, a non-zero exit, timeout, or abort as a failure — mirroring `makeClaudeRunner`'s existing timeout/abort/kill discipline in `claudeCliProvider.ts`. `spawnFn` stays injectable so tests feed scripted NDJSON with no real binary.

## P5b§4 Intake call + supplementary tool access during analysis

### P5b§4.1 The intake call

**Files:** `services/claude/systemPrompts/intake.ts` (persona prompt + JSON schema) and `services/claude/intake.ts` (runner glue), both new.

A lightweight schema-validated Claude call takes the user's free-text query and resolves it into the same structured inputs 5a's wizard collects, grounded against the existing `InstrumentSelection`/`Horizon` types (`analysisEnvelope.ts`/`rendererApi.ts`) — no new instrument shape invented:

```typescript
export type Horizon = "intraday" | "positional";        // rendererApi.ts, unchanged (auto still deferred)

export interface IntakeResult {
  instrument: InstrumentSelection;   // { symbol, exchange, segment, instrumentToken } — analysisEnvelope.ts
  horizon: Horizon;
  researchNotes?: string;            // short untrusted web-gathered framing context; optional
}
```

A `zod` validator (`intakeResultSchema`) and a matching `--json-schema` JSON object live beside `IntakeResult`, following `contracts.ts`'s existing "schema defined once, mirrored to the CLI" pattern (`personaFindingJsonSchema`/`verdictJsonSchema`). The intake call is granted **Kite read-tool access** (so it can call `mcp__kite__search_instruments` live to disambiguate a company name into a real `instrumentToken`) **and** web-tool access (P5b§5, for initial news/context). It runs through the same `makeClaudeRunner` retry-then-fail path as every schema-validated call. `intent_lens` is **not** an intake output — it is an explicit UI control in both modes (P5b§7), so the intake model never has to guess a stance that would frame the analysis.

### P5b§4.2 The deterministic compute path stays ours

Once intake resolves, **our IPC-bridge code** — not Claude — calls the EXISTING, UNCHANGED `assembleEnvelope()` (`analysisEnvelope.ts`: `fetchAndArchive` + sidecar `compute`), exactly as 5a's `runAnalysisRequest` does, deriving `(timeframe, from, to)` from `horizon` via the reused `horizonToFetchParams`. Claude never triggers the Rust sidecar compute; that deterministic path is exclusively this codebase's responsibility, invoked after intake resolves. This is the same architectural boundary §9/§6.1 draw ("nothing in §5/§6 is aware that response modes exist").

### P5b§4.3 Supplementary web access during analysis

The three analytical personas (`options_greeks`, `technical_quant`, `position_risk`) ALSO get web-tool access for supplementary news/sentiment research during their own calls, on top of reading the pre-fetched `algo_results`/`confluence`. The **narrative** persona does NOT get web access (P5b§5 scope decision). `researchNotes` from intake is threaded into the analytical persona prompts and the narrative prompt as clearly-marked untrusted framing context, subject to `INJECTION_DEFENSE`.

## P5b§5 Tool-allowlist extension + prompt-injection defense (safety-critical)

### P5b§5.1 The actual web-tool names

Claude Code / Claude CLI exposes its built-in web tools under the PascalCase tool names **`WebSearch`** and **`WebFetch`** (the same casing as `Bash`/`Read`/`Write`/`Edit`/`Grep`/`Glob` in `docs/CLAUDE_USAGE_GUIDE.md`'s built-in tool list; these are CLI tool names for `--allowedTools`, **not** the Messages-API server-tool type strings `web_search_20260209`/`web_fetch_20260209`). The allowlist grants exactly these two names — nothing else.

### P5b§5.2 Additive allowlist extension in `claudeProvider.ts`

Extend `buildClaudeArgs`/its allowlist mechanism so web tools are granted **additively**, never replacing the Kite-scoped list:

```typescript
export const WEB_TOOL_NAMES = ["WebSearch", "WebFetch"] as const;
export const WEB_TOOL_ALLOWLIST = WEB_TOOL_NAMES.join(",");   // "WebSearch,WebFetch"

export interface ClaudeArgOptions {
  systemPrompt?: string;
  jsonSchema?: string;
  outputFormat?: "json" | "text" | "stream-json";   // "stream-json" new (P5b§3)
  includePartialMessages?: boolean;                  // → --include-partial-messages (P5b§3)
  allowWebTools?: boolean;                           // additive web grant (this section)
}
```

`buildClaudeArgs` emits `--allowedTools` as `KITE_READ_TOOL_ALLOWLIST` when `allowWebTools` is falsy (byte-identical to today), or `` `${KITE_READ_TOOL_ALLOWLIST},${WEB_TOOL_ALLOWLIST}` `` when true. **`--disallowedTools KITE_WRITE_TOOL_DENYLIST` and `--strict-mcp-config` stay unchanged** (defense-in-depth, §4 layer 2). No other built-in tool (Bash, Write, Edit, Read-local-filesystem, Task/Agent, Glob, Grep) is ever named. Per-call grants:

| Call | `allowWebTools` | Output format |
|---|---|---|
| intake | **true** | json (`--json-schema`) |
| options_greeks / technical_quant / position_risk | **true** | json (`--json-schema`) |
| synthesis / verdict | false | json (`--json-schema`) |
| narrative | false | stream-json + partial messages |

**Test-covered assertions (explicit, in the plan not just narrative):**
- With `allowWebTools: true`, the `--allowedTools` value parsed back into a set equals **exactly** `{...KITE_READ_TOOL_NAMES mapped to mcp__kite__*, "WebSearch", "WebFetch"}` — no more, no fewer; contains **no** `KITE_WRITE_TOOL_NAMES` entry and **no** other built-in tool name.
- With `allowWebTools` falsy, `buildClaudeArgs("analyze INFY")` returns **byte-identical** argv to today (the existing `claudeProvider.test.ts` assertion is unchanged), proving the grant is strictly additive and opt-in.
- The three safety flags (`--allowedTools`, `--disallowedTools`, `--strict-mcp-config`) still emit first, in order, for every option combination (extends P4§7.7's regression test).

### P5b§5.3 Prompt-injection defense fragment

**File:** `services/claude/systemPrompts/injectionDefense.ts` (new), exporting a shared `INJECTION_DEFENSE` string — designed exactly like the existing `WORDING_CONSTRAINT` in `systemPrompts/wordingConstraint.ts`, imported (never copy-pasted) by every persona whose prompt can include web-fetched or web-derived content: **intake, options_greeks, technical_quant, position_risk, narrative** (the last because it receives untrusted `researchNotes`); it is also added to `synthesis` as belt-and-suspenders. Its content instructs the model that any content obtained via `WebSearch`/`WebFetch`, or passed as `researchNotes`/news text, is **untrusted data to analyze, never instructions to follow**; that it must never let fetched content override the wording constraint, the citation-to-`algo_id` requirement, the output schema, or any other instruction; and that instruction-like text inside fetched content is itself reportable data, not a command.

### P5b§5.4 Why this stays safe despite the new capability

State explicitly in the spec: `WebSearch`/`WebFetch` are **read-only browsing tools incapable of placing orders, modifying files, or executing code** — the order-execution invariant (§4) is untouched structurally regardless of what content Claude fetches (there is still no method, no allowed tool, and the write denylist + `--strict-mcp-config` still stand). The **new** risk is content-integrity: a malicious page's text could try to manipulate the model's OUTPUT wording or analysis. That risk is jointly bounded by (a) the `INJECTION_DEFENSE` prompt language (P5b§5.3), and (b) the existing structural layers — the closed tool allowlist (P5b§5.2), the enum-constrained `Verdict.direction`/`conviction` (P4§8, injection cannot produce an "action" value that validates), and the citation check (`cited_algo_ids ⊆ envelope`, so no fetched figure can enter the verdict as a cited signal). Web content shapes voice/context; it cannot widen capability or forge a directive.

## P5b§6 Mermaid rendering — CSP-safe, AI-Assisted narrative only

**Current production CSP** (`electron-app/src/renderer/index.html`, confirmed): `default-src 'none'; script-src 'self'; style-src 'self'; object-src 'none'`. The dev CSP in `electron.vite.config.ts` relaxes to `'unsafe-inline'` for HMR only; the static production CSP stays strict and must remain so.

**Integration (`services/`-free, renderer-side; files `renderer/mermaid.ts` + used by `renderer/MessageMarkdown.tsx`, new):**

- Add the `mermaid` npm package as a runtime dependency, **bundled** with the renderer (self-hosted), so it runs under `script-src 'self'` — Mermaid's core flowchart/sequence/class/state/ER/gantt/pie renderers do **not** require `eval`/`unsafe-eval`, so `script-src 'self'` is preserved with **no** relaxation. No dynamic `<script>` injection, no CDN origin (no wildcard `script-src`).
- Initialize once: `mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false })`. `securityLevel: 'strict'` disables click handlers and HTML in labels and routes label text through Mermaid's own sanitizer; `startOnLoad: false` means we render explicitly, never via a global scan.
- Render on demand: for each fenced ```mermaid code block (markdown-it emits it as `<pre><code class="language-mermaid">` with the source entity-escaped inside the code block — inert), extract the source text, call `await mermaid.render(uniqueId, source)` into a detached container, take the returned SVG string, run it through a **second** DOMPurify pass with the SVG profile (`{ USE_PROFILES: { svg: true, svgFilters: true } }`), then insert the sanitized SVG into the message's isolated `.mermaid` container via a React ref (never `dangerouslySetInnerHTML` on Mermaid's raw output; the sanitized string only).
- **CSP note on Mermaid's injected `<style>`:** Mermaid embeds a `<style>` block inside the rendered SVG for theming, which `style-src 'self'` would otherwise block. The strict-preserving resolution: keep `style-src 'self'` and follow a "no dynamic style injection" discipline — strip Mermaid's injected `<style>` in the SVG-profile sanitize pass and ship the diagram theme CSS as static rules scoped to `.mermaid svg` in the app's external `style.css` (which already satisfies `style-src 'self'`, per 5a's external-stylesheet approach P5a§8.3). This is a concrete implementation decision, not a hand-wave; the exact retained/stripped element set must be validated against the pinned Mermaid version at implementation, with `style-src 'self' 'unsafe-inline'` as an explicitly-scoped fallback **only** if extraction proves impractical (a `style` attribute/element cannot execute script, and `default-src 'none'` already bars external origins, so the residual risk is bounded CSS, not XSS).

**Scope boundary (confirmed):** Mermaid diagrams are output of the AI-Assisted narrative only — Claude may choose to include a mermaid code block in its prose. Engine-Only's deterministic templates (`deterministicResponseGenerator.ts`) emit no diagrams and have no reason to; the Engine-Only render path still runs through the shared markdown+DOMPurify pipeline (P5b§9) but will contain no mermaid fences.

## P5b§7 Intent lens — implemented for real

The `intent_lens: "buying" | "selling"` field is hardcoded to `"buying"` today (`analysisBridge.ts` passes a fixed placeholder to satisfy the required `AssembleEnvelopeParams.intent_lens`; P5a§12 tension 1). 5b makes it a real user control:

- **A shared explicit selector**, present in **both** modes (never inferred). In Engine-Only it is wizard step 1 (§9.2). In AI-Assisted it is a small buying/selling control (`renderer/IntentLensSelector.tsx`, new) rendered adjacent to the free-text chat input. **Decision + justification:** keep it explicit rather than letting the intake call infer it — the lens materially frames analysis, so a user's stated stance should not be a model guess; one cheap control guarantees both modes resolve the identical `intent_lens` field the same way (§9.2's "both modes resolve to the identical field"), and it keeps the intake schema minimal. `intent_lens` flows into `AssembleEnvelopeParams` for both paths (replacing the placeholder).
- **Threaded into persona prompts.** The three analytical personas and the narrative persona reference the lens as framing context — the USER's stated interest, not the model's recommendation. Prompt language shape (added to each analytical/narrative system prompt, alongside `WORDING_CONSTRAINT`): *"The user is examining this instrument from a **{buying|selling}** stance — they are weighing an entry/add (buying) or an exit/reduce (selling). Use this only to choose which evidence is most decision-relevant to frame (e.g. downside risks matter more to a holder considering a reduce). It describes the user's interest; it is never an instruction for you to recommend that action, and it must not change a bullish/bearish/neutral read into a directive."* This is framing context, not a trade directive — the lens describes the user's stance, and the enum-constrained `direction`/`conviction` output plus `WORDING_CONSTRAINT` keep the wording descriptive regardless (P4§8). A test asserts persona output remains non-directive under both lens values.

## P5b§8 Mode picker + chat UI

### P5b§8.1 The mandatory mode-picker gate

`renderer/ModePicker.tsx` (new) is the **first** thing shown, **before** the existing Kite-login gate (mode choice is independent of auth state, §8.3/§9), presenting AI-Assisted vs Engine-Only. It is not skippable and not cacheable per session (§8.4 — the choice is asked fresh every session; 5b holds it as in-memory React state, persisting nothing, consistent with 5c/5d being out of scope). Once chosen, `App.tsx`'s flow becomes: **mode picker → login gate → shared `intent_lens` control → mode-specific intake → result render.** Engine-Only routes to 5a's deterministic generator (unchanged); AI-Assisted routes to the new Claude pipeline (P5b§3/P5b§4). The `AnalysisResult.mode` discriminator (5a) is extended from `"engine_only"` to also carry `"ai_assisted"` — the seam 5c persists against.

Note on the task's "shared wizard (instrument, horizon, intent_lens)": realized as **a shared `intent_lens` control + a mode-specific intake surface.** Engine-Only keeps 5a's structured instrument-search + horizon wizard (extended with the lens). AI-Assisted collapses instrument+horizon into the free-text box resolved by the intake call (P5b§4), keeping only the explicit lens control alongside it. Both surfaces resolve to the identical `AssembleEnvelopeParams` inputs.

### P5b§8.2 Contracts (discriminated, kept 5c-ready)

Extend `ipc/rendererApi.ts`'s `AnalysisRunParams`/`AnalysisResult` into mode-discriminated unions (the additive seam P5a§8.4 promised — 5a's `analysis:run` object is not reshaped, only widened):

```typescript
export type IntentLens = "buying" | "selling";

export type AnalysisRunParams =
  | { mode: "engine_only"; instrument: InstrumentSelection; horizon: Horizon; intent_lens: IntentLens }
  | { mode: "ai_assisted"; query: string; intent_lens: IntentLens; requestId: string };

export type AnalysisResult =
  | { mode: "engine_only"; instrument: InstrumentRef; horizon: Horizon;
      response: DeterministicResponse; algo_results: AlgoResultWire[] }        // 5a shape, unchanged
  | { mode: "ai_assisted"; instrument: InstrumentRef; horizon: Horizon; intent_lens: IntentLens;
      verdict: Verdict; narrative: string;                                     // full streamed text (5c payload)
      algo_results: AlgoResultWire[]; confluence: ConfluenceWire };
```

The `ai_assisted` variant carries the `Verdict`, the complete `narrative` text, and the uncollapsed `algo_results`/`confluence` — precisely what §8.5 says 5c must persist (`Verdict`/templated-equivalent + `AlgoOutput[]` + scorecard). Internal `PersonaFinding`s are pipeline detail, never shown and not carried on the result (§7.2). Nothing here is persisted in 5b.

### P5b§8.3 Streaming IPC channel

Token streaming mirrors 5a's existing banner push pattern (`webContents.send` + a `subscribe` bridge method), not a bare request/response. A new push channel `analysis:narrative` carries `{ requestId, chunk?: string, done?: boolean, error?: string }`; `RendererApi` gains `onNarrative(handler)` (subscribed exactly like `onBanner`), and `preload.ts` exposes it via the same single `tradeAssistant` bridge object (no raw `ipcRenderer`, §8.2). The `analysis:run` handler for `mode: "ai_assisted"` runs the pipeline, emits `analysis:narrative` tokens correlated by `requestId` as the narrative call streams, and resolves the `invoke` with the final `AnalysisResult` (whose `narrative` equals the accumulated stream, taken from the terminal `result` line, P5b§3.1). A new `ipc/narrativeBridge.ts` registers the push wiring, keeping `analysisBridge.ts`/`appBridge.ts` focused (small-focused-files convention, mirroring P5a§6.3).

### P5b§8.4 Chat UI

`renderer/ChatView.tsx` (new, AI-Assisted) renders a message list + a streaming narrative display (appending `onNarrative` chunks into the in-progress assistant message until `done`), plus the free-text input and the `IntentLensSelector`. Setup/session state stays as banners, adding §8.3's Claude-auth banner ("claude auth login") shown only when AI-Assisted is in play (the Kite-login and MCP-drift banners already exist from 5a). Engine-Only keeps 5a's `InstrumentSearch` + `AnalysisResultView`, extended with the lens control.

## P5b§9 Markdown + DOMPurify sanitization (both modes)

§8.2 mandates DOMPurify on **every** rendered message in **both** modes, since Engine-Only's templated output also renders as markdown-ish text. 5b introduces the shared render pipeline (`renderer/markdown.ts` + `renderer/MessageMarkdown.tsx`, new) and routes both `AnalysisResultView` (Engine-Only) and `ChatView` (AI-Assisted) through it — this upgrades 5a's plain-text `<p>{text}</p>` Engine-Only rendering to the markdown pipeline, resolving the deferral P5a§12 tension 4 recorded (P5b§12 tension 3).

**Markdown library choice:** `markdown-it` (runtime dep). Justification: it is the de-facto CommonMark renderer, has a small stable HTML output surface that a strict DOMPurify allowlist can be pinned to exactly, emits fenced code blocks as `<pre><code class="language-*">` (the hook Mermaid detection needs), and does no HTML-passthrough by default (`html: false`), so raw HTML in model/template text is escaped, not injected — a second layer under DOMPurify.

**Pipeline:** model/template text → `markdown-it` (`html: false`, `linkify: true`, tables enabled) → DOMPurify sanitize (HTML pass) → insert via ref. Then `MessageMarkdown` post-processes `code.language-mermaid` nodes through the Mermaid path (P5b§6, its own SVG-profile sanitize pass). Two DOMPurify passes: HTML for prose/tables, SVG profile for Mermaid output.

**DOMPurify HTML config (grounded in markdown-it's actual output tags):**

```typescript
const ALLOWED_TAGS = [
  "p","br","hr","blockquote","pre","code","span",
  "h1","h2","h3","h4","h5","h6",
  "strong","em","del","s","b","i",
  "ul","ol","li",
  "a","img",
  "table","thead","tbody","tr","th","td",
];
const ALLOWED_ATTR = ["href","src","alt","title","class"];  // class carries language-* / mermaid marker; NO on* handlers
// http/https/mailto only — no javascript:, no data: (blocks data-URI XSS vectors)
const ALLOWED_URI_REGEXP = /^(?:https?:|mailto:)/i;
// belt-and-suspenders: FORBID_TAGS ["style","script","iframe","object","embed","form","input"], FORBID_ATTR ["style"]
```

`style`/`script`/`iframe`/`object`/`embed`/`form`/`input` and all `on*` event attributes are excluded from the allowlist (and explicitly forbidden); the URI regexp neutralizes `javascript:`/`data:` hrefs. `img` is allowed but any `onerror`/`onload` is stripped as a non-allowlisted attribute — the exact DeepChat-class vector.

**DeepChat CVE testing requirement:** §8.2 and §13 name the DeepChat CVE (Feb 2026) — architecturally identical to this app (Electron + AI chat + unsanitized markdown), where an `<img onerror=...>` payload reached an exposed `contextBridge` method and escalated renderer XSS into local action. The concrete payload shape is the `<img src=x onerror="...">`-class markdown-injected handler. A test (`test/renderer/markdown.test.ts`) feeds the render pipeline that payload **plus** known markdown-sanitizer bypass patterns — `<a href="javascript:...">`, mutation-XSS (mXSS) via malformed/nested tags, `<svg onload>`, `<img src=x onerror>` variants — and asserts the sanitized output contains no `on*` attribute, no `javascript:`/`data:` URI, and no `<script>`/`<iframe>`, exercised against **both** modes' render path. (If the specific DeepChat CVE ID is unavailable at implementation, this is the verify-against-known-mXSS-bypass-patterns requirement to satisfy §13.)

## P5b§10 Testing approach

Headless, DI-based, mocked — same bar as Phase 3/4/5a. **No real `claude`, no real Kite, no real network in automated tests.**

- **`claudeProvider.ts` (allowlist):** the P5b§5.2 assertions — additive web grant is exactly `{Kite reads} ∪ {WebSearch, WebFetch}` with no write tool and no other built-in; falsy grant is byte-identical to today; safety flags first for every option combination.
- **`streamingNarrative.ts`:** a fake `spawnFn` yields scripted NDJSON (`system` init → several `stream_event`/`content_block_delta` deltas → terminal `result`); assert `onToken` fires per delta in order, the resolved text equals the `result` line, a chunk split mid-line reassembles correctly, and a non-zero exit / missing terminal `result` / abort rejects (mirrors `claudeCliProvider.test.ts` timing tests).
- **`intake.ts`:** a fake runner returns a scripted `IntakeResult`; assert schema validation, retry-then-fail on a malformed reply, and that a resolved `InstrumentSelection` flows into `assembleEnvelope`. A mocked `search_instruments` path is not exercised live (that's manual verification).
- **AI-Assisted pipeline / `analysis:run` handler:** mocked `KiteClient` + mocked sidecar (as `analysisEnvelope.test.ts` does) drive intake → `assembleEnvelope` → `runPipeline` (verdict) → narrative stream; assert the assembled `ai_assisted` `AnalysisResult` carries the `Verdict`, the accumulated `narrative`, and uncollapsed `algo_results`/`confluence`; assert a null Kite session rejects; assert `intent_lens` reaches the envelope.
- **Persona prompts:** assert every web-touching persona's system prompt includes `INJECTION_DEFENSE` and `WORDING_CONSTRAINT`; assert output stays non-directive under both `intent_lens` values (extends P4§10 / P5a§7's wording guard).
- **Markdown + DOMPurify:** the P5b§9 DeepChat-CVE / mXSS payload test, plus table/link/mermaid-fence rendering, run against both modes' render path.
- **Mermaid:** a valid flowchart source renders to sanitized SVG with no `<script>`/`on*`; a malicious `securityLevel`-probing source is neutralized.
- **React components:** mode picker renders first and gates login; the `IntentLensSelector` value threads into `runAnalysis`; the AI-Assisted `ChatView` appends `onNarrative` chunks in order and finalizes on `done` — over a mocked `tradeAssistant` bridge, per P5a§9's `@testing-library/react` + jsdom pattern.

## P5b§11 Manual verification checklist

Mirrors P5a§11: an automatable golden path plus live-Kite/live-Claude follow-ups (only runnable with a paid Kite session and `claude` auth), never a blocker for calling 5b done.

**Automatable (mocked bridge + `npm start`):** mode picker shows first; choosing AI-Assisted then logging in reveals the chat input + lens control; a mocked narrative stream renders token-by-token; a mermaid fence renders a diagram; the DeepChat payload does not execute; Engine-Only still renders (now via the markdown pipeline).

**Live follow-ups:** a real free-text query resolves the right instrument via live `search_instruments`; the three analytical personas and intake actually invoke `WebSearch`/`WebFetch` (confirm via `claude` debug output that only those two built-ins plus the Kite reads are offered, and that no write tool or Bash/Write/Edit is); the narrative streams token-by-token from `mcp.kite.trade`-sourced live data; the strict production CSP raises no console violations while Mermaid renders.

## P5b§12 Relationship to the existing design (flagged tensions & resolutions)

Per the brainstorming self-review, the points below are where 5b narrows, defers, or diverges from the master doc, Phase 4, or 5a. Each is called out rather than silently resolved.

1. **`news_context` stays unpopulated — a real divergence from §7.3.** §7.3 types `news_context?: CitedHeadline[]` and §9.1 says AI-Assisted "can pull in live web/news research where useful," with the master model implying the **app** assembles a `CitedHeadline[]` into the envelope. 5b's agreed design instead has **Claude fetch news live via its own `WebSearch`/`WebFetch` calls** during intake and the analytical personas — so `news_context` remains unpopulated and news reaches the model through its own tool calls, not a pre-fetched array. **Resolution:** proceed with model-driven web research (it is strictly more current than a pre-fetched snapshot and needs no separate news-feed integration); the `news_context` field stays typed and empty, exactly as Phase 4 left it (P4§11.5), and 5c/later may still populate it without a reshape. Flagged because it changes *who* fetches news (Claude, not our code) versus the master doc's envelope-population model.

2. **Synthesis split into verdict + narrative — an elaboration of §7.2/Phase 4.** §7.2 described one final synthesis persona producing the verdict; Phase 4's `Verdict.reasoning` already carries cited prose. 5b splits this into a schema-validated `Verdict` call (unchanged) **plus** a separate streamed narrative call. **Resolution:** deliberate — it lets the human-facing prose stream token-by-token while keeping the enum-constrained, citation-checked output frozen before any prose is emitted. `Verdict.reasoning` remains the short machine-checkable cited summary; `narrative` is the richer streamed expansion. Some overlap between the two is accepted as the price of streaming safely.

3. **Engine-Only rendering changes — resolves P5a§12 tension 4, modifies 5a code.** 5a rendered Engine-Only's `text` as plain React-escaped `<p>` nodes with no markdown/DOMPurify (P5a§12 tension 4 deferred sanitization to 5b). 5b routes Engine-Only through the shared markdown+DOMPurify pipeline (§8.2 mandates DOMPurify in both modes). **Resolution:** this fulfills §8.2's cross-mode requirement and P5a's own deferral; it modifies `AnalysisResult.tsx`'s render but not the deterministic generator or the `AnalysisResult` engine-only shape. Not a contradiction — a scheduled follow-through.

4. **The first streaming Claude call in the codebase — new territory, grounded not guessed.** Every prior Claude invocation uses buffered `--output-format json` (P4§7.4). 5b's narrative call is the first `--output-format stream-json --include-partial-messages` use. **Resolution:** the event shape is grounded against `docs/CLAUDE_USAGE_GUIDE.md` (CLI v2.1.209) in P5b§3.1, not assumed; the capture code reuses `spawnClaude`/`buildClaudeArgs` and mirrors `makeClaudeRunner`'s timeout/abort discipline. Flagged as a genuine first, consistent with §8.3's "streamed token-by-token."

5. **`auto` horizon still not offered — 5a's deferral (P5a§12 tension 3) continues.** §9.2 lists `intraday | positional | auto`; the intake call resolves only `intraday | positional` and the AI-Assisted result carries the same two. **Resolution:** `auto` presupposes a multi-horizon compute path the sidecar does not yet run (P4§4.3); deferred to the phase that runs more than one horizon per request. A strict subset, not a contradiction.

6. **Web-tool grant is per-call, not session-wide — consistent with §4 and §8.4.** The grant is an opt-in `buildClaudeArgs` flag set only for intake and the three analytical personas, never for verdict or narrative, and never a persisted setting. **Resolution:** this keeps the allowlist a closed, explicit, per-invocation set (§4 layer 2) and keeps web access out of 5d's settings scope — it is a capability of specific calls, not a user preference.

## P5b§13 File layout summary

New / changed files:

- `electron-app/src/main/services/claude/claudeProvider.ts` — `WEB_TOOL_NAMES`/`WEB_TOOL_ALLOWLIST`; `buildClaudeArgs` gains `allowWebTools`, `stream-json` output format, `includePartialMessages` (changed, P5b§5.2/P5b§3).
- `electron-app/src/main/services/claude/streamingNarrative.ts` — stream-json spawn + NDJSON token parser (new, P5b§3.1).
- `electron-app/src/main/services/claude/intake.ts` — intake runner glue (new, P5b§4.1).
- `electron-app/src/main/services/claude/systemPrompts/intake.ts` — intake persona prompt + JSON schema (new).
- `electron-app/src/main/services/claude/systemPrompts/narrative.ts` — narrative persona prompt, no schema (new).
- `electron-app/src/main/services/claude/systemPrompts/injectionDefense.ts` — shared `INJECTION_DEFENSE` fragment (new, P5b§5.3).
- `electron-app/src/main/services/claude/systemPrompts/{optionsGreeks,technicalQuant,positionRisk,synthesis}.ts` — import `INJECTION_DEFENSE`; analytical + narrative add the `intent_lens` framing line (changed, P5b§5.3/P5b§7).
- `electron-app/src/main/services/claude/{personaPipeline,claudeCliProvider}.ts` — pass `allowWebTools: true` for the three analytical personas; run the intake + narrative calls; thread `intent_lens`/`researchNotes` (changed, P5b§3/P5b§4).
- `electron-app/src/main/services/analysis/contracts.ts` — `IntakeResult` + `intakeResultSchema` + `intakeResultJsonSchema`, `IntentLens` type; `Verdict`/`PersonaFinding` unchanged (changed, P5b§4.1).
- `electron-app/src/main/ipc/rendererApi.ts` — `AnalysisRunParams`/`AnalysisResult` mode-discriminated unions; `onNarrative` on `RendererApi` (changed, P5b§8.2/P5b§8.3).
- `electron-app/src/main/ipc/analysisBridge.ts` — route `analysis:run` by mode; thread real `intent_lens`; invoke AI-Assisted pipeline (changed, P5b§8.3).
- `electron-app/src/main/ipc/narrativeBridge.ts` — `analysis:narrative` push wiring (new, P5b§8.3).
- `electron-app/src/main/ipc/preload.ts` — expose `onNarrative` (changed).
- `electron-app/src/main/bootstrap.ts` — construct/hold the `ClaudeCliProvider` deps; wire narrative streaming send (changed).
- `electron-app/src/renderer/ModePicker.tsx`, `ChatView.tsx`, `MessageMarkdown.tsx`, `IntentLensSelector.tsx`, `markdown.ts`, `mermaid.ts` — mode picker, chat UI, shared render pipeline, Mermaid, lens control (new).
- `electron-app/src/renderer/App.tsx` — mode-picker → login → lens → mode-specific intake routing (changed, P5b§8.1).
- `electron-app/src/renderer/InstrumentSearch.tsx` — add `IntentLensSelector` to the Engine-Only wizard (changed, P5b§7).
- `electron-app/src/renderer/AnalysisResult.tsx` — render through the markdown+DOMPurify pipeline (changed, P5b§9).
- `electron-app/src/renderer/index.html` / `electron-app/src/renderer/style.css` — Mermaid `.mermaid svg` theme CSS in the external stylesheet; keep the strict production CSP (changed, P5b§6).
- `electron-app/package.json` — add `markdown-it`, `dompurify`, `mermaid` (+ `@types/markdown-it`/`@types/dompurify` if needed) (changed, P5b§6/P5b§9).
- Tests under `electron-app/test/main/services/claude/`, `electron-app/test/main/ipc/`, and `electron-app/test/renderer/` per P5b§10 (new).
