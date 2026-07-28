# Phase 9-A — Persona Streaming & Progress Plumbing

Status: approved by user 2026-07-28 (brainstorming dialogue), pending implementation planning.
Author: design produced via `superpowers:brainstorming`, a post-roadmap addition to `docs/superpowers/specs/2026-07-18-trade-assistant-design.md` (the original 7-phase roadmap). Section references: "§N" → master design; "P9A§N" → this document. The house structure/tone mirrors `docs/superpowers/specs/2026-07-28-phase8-kite-mcp-only-auth-design.md`.

This phase is backend/plumbing only. A separate later phase — **Phase 9-B** — will build the styled, collapsible subagent UI that *consumes* the event stream this phase produces. All UI/CSS work is out of scope here (P9A§15).

## P9A§1 Purpose

By this point the app is a packaged desktop trading *assistant*: Electron + TypeScript + React shell, a Rust compute core (`rust-core/`) spawned as a sidecar subprocess, and Claude reached via the `claude` CLI subprocess as the AI-reasoning layer. Its `ai_assisted` analysis mode runs a six-persona pipeline, one `claude` CLI spawn each: **intake**, then **options_greeks / technical_quant / position_risk** in parallel, then **synthesis**, then **narrative**. Rust does pure candle-data compute; Claude does AI reasoning; the human makes every decision.

**Permanent, non-negotiable safety property (re-stated because every spec re-states it):** the app never places, modifies, cancels, or automates any order on Zerodha Kite — ever. It is an assistant, not a trader. This phase adds only progress/telemetry plumbing and does not touch order surface of any kind; P9A§3 shows why the guarantee holds by construction.

**The bug that motivates this phase.** A live failure just occurred:

```
Error invoking remote method 'analysis:run': Error: persona intake timed out after 120000ms
```

Root-cause investigation (all facts verified against the tree in P9A§4) exposed three structural weaknesses:

1. **No deliberate model choice.** `buildClaudeArgs` (`electron-app/src/main/services/claude/claudeProvider.ts:41-61`) never passes a `--model` flag — grep for `haiku`/`sonnet`/`opus`/`model` across `electron-app/src/main/services/claude/**` returns zero hits. Every one of the six persona spawns runs on the CLI's own default model, not a deliberately chosen fast model. A slow default model is the direct cause of the 120 s intake timeout.
2. **One coarse, shared timeout.** A single `DEFAULT_PERSONA_TIMEOUT_MS = 120000` (`claudeCliProvider.ts:35`) is shared across all five non-narrative personas, so a slow persona is indistinguishable from any other and the envelope-assembly steps have *no timeout at all*.
3. **Almost no visibility.** Only the final `narrative` step streams; the other five run blocking. There are zero progress events before narrative, so a 6-spawn pipeline appears frozen from the user's side until the narrative tokens begin.

Phase 9-A fixes all three: a deliberate uniform model, per-step timeouts (including net-new bounds on Kite fetch and Rust compute), uniform streaming across all six personas with tool-call/tool-result capture, a Rust sidecar progress protocol, a single unified IPC trace channel, and persistence of the full trace alongside each assistant turn. After this phase ships, the new events are verifiable via the devtools console / logs **with zero UI changes** — the UI that renders them is Phase 9-B.

## P9A§2 Scope

**In scope (the seven approved decisions, each specified precisely in its own section):**

1. Explicit uniform `--model` flag on all six persona spawns (P9A§5).
2. Per-persona timeouts replacing the single shared constant (P9A§6).
3. Net-new envelope-assembly timeouts on Kite fetch and Rust compute (P9A§7).
4. Uniform persona streaming with a generalized `onEvent`/`onTrace` callback capturing tokens **and** tool-call / tool-result events (P9A§8).
5. A Rust sidecar `progress` stdout line type, interleaved on the same stream, surfaced as a new `SidecarSupervisor` `"progress"` event (P9A§9).
6. A single unified IPC channel `analysis:trace` carrying a discriminated `TraceEvent` union; `analysis:narrative` is retired (P9A§10).
7. Persistence of the accumulated `TraceEvent[]` in a new nullable `messages.trace` column, with an idempotent `ALTER TABLE` migration for already-installed databases (P9A§11).

**Not in scope (P9A§15 has the full list):**

- Any change to the no-order-placement safety invariant (§2, §4) — unaffected (P9A§3).
- All UI/CSS/renderer visual work — the styled collapsible subagent panels that consume the trace stream — reserved for **Phase 9-B**. No renderer file is touched in Phase 9-A; a temporary `onNarrative` compatibility adapter in `rendererApi.ts` keeps the existing narrative display working unchanged (P9A§10.1, §15).
- Any change to `engine_only` mode's persona behavior (it invokes none) — P9A§15.

**Locked decisions written up verbatim (from the completed brainstorming session; none re-litigated here):**

1. **Uniform Haiku 4.5 on all six personas.** `--model claude-haiku-4-5-20251001` on every spawn. The user explicitly chose this over a mixed-tier (Haiku-for-cheap-personas, Sonnet-for-synthesis) strategy after both were presented. Not re-opened.
2. **Per-persona `timeoutMs` on each `PersonaRunSpec`** replacing the shared constant. Proposed defaults (concrete numbers, not yet finally locked): intake 20000, options_greeks / technical_quant / position_risk 45000 each, synthesis 25000, narrative 60000 (down from 180000, justified by the Haiku switch).
3. **Separate envelope-assembly bounds:** Kite fetch ≈ 15000 ms, Rust compute ≈ 20000 ms — two bounds because one is network I/O and the other local compute. Clear labeled timeout messages, mirroring the existing `persona ${name} timed out after ${ms}ms` pattern.
4. **All six personas on the same streaming transport** (`stream-json` + `--include-partial-messages`) narrative already uses; the runner generalizes to a richer `onEvent` capturing tool calls (name + args) and tool results (summarized), not just tokens.
5. **Same-stream, type-discriminated Rust progress protocol.** The user explicitly rejected a separate pipe/fd. Progress lines interleave with the response line on the one stdout stream; the TS side distinguishes them and routes progress to a new `SidecarSupervisor` `"progress"` event.
6. **One unified IPC channel `analysis:trace`** carrying a `TraceEvent` discriminated union; narrative becomes just another `source`, not special-cased. `banner:push` stays separate and unchanged (session-level status, a different concern).
7. **New nullable `messages.trace TEXT` column**, same JSON-blob pattern as `structured_payload`; the assistant-turn append persists the full `TraceEvent[]` of the run.

## P9A§3 The permanent no-order-placement safety invariant is unaffected (load-bearing)

**Placed early and deliberately: this is why a telemetry phase is low-risk.**

The §2/§4 guarantee — *the app never places, modifies, cancels, or automates any order, ever* — is enforced by the shape of `KiteClient` and the `claude` CLI tool allowlist/denylist, neither of which this phase touches:

- `buildClaudeArgs` (`claudeProvider.ts`) keeps `--allowedTools` = the closed `KITE_READ_TOOL_ALLOWLIST` (+ web tools where already granted), `--disallowedTools` = `KITE_WRITE_TOOL_DENYLIST`, and `--strict-mcp-config`, **byte-for-byte**. The only argv change in this phase is the *addition* of a `--model` flag (P9A§5); no tool flag is added, removed, or widened.
- The new tool-call / tool-result **capture** (P9A§8) is read-only observation of the stream the CLI already emits. It reports what tools ran; it cannot cause a tool to run, and it operates strictly downstream of the unchanged allowlist/denylist. A `toolResult` TraceEvent can only ever describe a *read* tool result, because no write tool is reachable.
- The Rust `progress` lines (P9A§9) are additive stdout telemetry from pure-compute handlers; the sidecar has no order surface at all.
- `SidecarSupervisor`, `HistoryStore`, and the IPC bridges gain telemetry plumbing only.

Restated for completeness, as in every phase: nothing here touches order placement; this phase adds no order-related surface of any kind. The existing `kiteClient.test.ts` exact-eleven-read-method allowlist test requires zero changes and must continue to pass unmodified (P9A§14).

## P9A§4 Current state (verified against the tree)

The full call graph for one `analysis:run` in `ai_assisted` mode, as it stands today:

1. Renderer → `ipcMain.handle("analysis:run")` (`analysisBridge.ts:179-195`) → `runAiAssistedRequest` (`analysisBridge.ts:81-143`).
2. `runAiAssistedRequest` appends the **user** message (`analysisBridge.ts:88-93`), then:
   - **(a)** `provider.intake(query)` (`analysisBridge.ts:94`) — one blocking persona spawn.
   - **(b)** `assembleEnvelope(...)` (`analysisBridge.ts:96-107`; impl `services/analysis/analysisEnvelope.ts:28-59`): `fetchAndArchive` (Kite, blocking, **no timeout today**, `analysisEnvelope.ts:32-41`) then `sidecar.compute` (blocking, **no timeout today**, `analysisEnvelope.ts:43`).
   - **(c)** `provider.completeAiAssisted(envelope, opts)` (`analysisBridge.ts:110-115`; impl `claudeCliProvider.ts:151-166`): `runPersonaPipeline` runs the three analytical personas in parallel then `synthesis` (all blocking, `personaPipeline.ts:75-122`), then `streamNarrative` — the **only** streaming step, token-by-token.
3. On success: `sendNarrative({ requestId, done: true })` (`analysisBridge.ts:121`), build `AnalysisResult`, append the **assistant** message (`analysisBridge.ts:132-137`), resolve. On any error: `sendNarrative({ requestId, error })` (`analysisBridge.ts:140`) then rethrow — the IPC promise rejects.

Verified facts the design depends on:

- **Model:** `buildClaudeArgs` (`claudeProvider.ts:41-61`) emits no `--model`. Zero grep hits for a model in `services/claude/**`. Confirmed.
- **Persona timeout:** `DEFAULT_PERSONA_TIMEOUT_MS = 120000` (`claudeCliProvider.ts:35`), used for all runner spawns. The runner (`makeClaudeRunner`, `claudeCliProvider.ts:61-117`) races `readResult(child)` (accumulate full stdout, `JSON.parse`, read `.structured_output`) against a timeout `guard` that rejects with `` `persona ${spec.name} timed out after ${personaTimeoutMs}ms` `` (line 87) then kills the child. It does up to two attempts (first + one corrective retry on schema-validation failure); a **timeout throws immediately and is not retried** (the `await Promise.race` throw escapes `attempt`, which only returns `{ok:false}` on a zod parse failure). Confirmed.
- **Narrative timeout / streaming:** `DEFAULT_NARRATIVE_TIMEOUT_MS = 180000` (`streamingNarrative.ts:21`). Narrative is the sole streaming persona — `outputFormat: "stream-json"`, `includePartialMessages: true` (`streamingNarrative.ts:43-44`). It parses `stream_event` → `content_block_delta` → `text_delta` for tokens (lines 92-104) and a terminal `type:"result"`, `subtype:"success"`, `.result` string for the final text (lines 105-108). Confirmed.
- **No progress before narrative.** Confirmed — no code emits any per-persona/per-step event.
- **IPC plumbing today:** `sendToRenderer(channel, payload)` = `mainWindow?.webContents.send(...)` (`bootstrap.ts:145-147`). `makeNarrativeSender` publishes on `NARRATIVE_CHANNEL = "analysis:narrative"` (`narrativeBridge.ts:3-9`); banners publish on `"banner:push"` (`appBridge.ts:13`). Event shapes: `NarrativeEvent { requestId; chunk?; done?; error? }` (`rendererApi.ts:70-75`), `BannerEvent { kind; message }` (`rendererApi.ts:25-28`). The preload (`preload.ts`) forwards *any* channel via a generic `subscribe`; the channel string lives only in `rendererApi.ts:101`'s `subscribe("analysis:narrative", …)`. Confirmed.
- **Two existing main-process EventEmitters:** `SidecarSupervisor` (emits `"statusChange"`, `sidecarSupervisor.ts:199-201`) and `KiteSessionState` (`"banner"`/`"change"`). Neither carries per-step progress. Confirmed.
- **Rust sidecar:** pure one-shot request/response, one JSON line in → one JSON line out per request `id`, matched in `SidecarSupervisor` via `pending: Map<number, Pending{resolve,reject,timer}>` (`sidecarSupervisor.ts:35-39,127-178`). `dispatch(line)` (`sidecarSupervisor.ts:165-178`) assumes **every** line is a `SidecarResponseWire` and resolves the matching pending. The Rust `eprintln!` sites (`main.rs:70,83,107,123,139,155,171,187,203,215`) fire only on panics, go to **stderr**, which `sidecarSupervisor.ts` never reads. The compute handler runs `run_applicable(&algos, &ctx)` in one shot (`handlers.rs:88-121`). Confirmed. No incremental progress exists.
- **History storage:** `HistoryStore` (`historyStore.ts`), SQLite via `better-sqlite3`. Schema is created in the **constructor** with `CREATE TABLE IF NOT EXISTS messages (id, session_id, role, rendered_text, structured_payload, created_at)` (lines 78-85) plus indices. `structured_payload` is a nullable `TEXT` holding `JSON.stringify`'d data (write path `historyStore.ts:107`; read/parse `historyStore.ts:172`) — the exact precedent this phase copies. `AppendMessageParams` at `historyStore.ts:29-34`; `HistoryMessage` at `historyStore.ts:16-21`; write via `appendMessage`/`appendMessageTxn` (`historyStore.ts:96-111,178-181`). **Critical:** `CREATE TABLE IF NOT EXISTS` is a whole-statement no-op when the table already exists, so on an already-installed DB (real user history exists on disk) adding a column to that `CREATE` alone does **not** add it to the existing table. An explicit migration is required (P9A§11). Confirmed by reading the file.

## P9A§5 Decision 1 — explicit uniform model flag

Add a single module-level constant and emit it unconditionally in `buildClaudeArgs`, so it covers both persona transports (the structured runner via `spawnClaude`, and the narrative streamer via `spawnClaude`) — i.e. all six personas.

`claudeProvider.ts`:

```typescript
export const PERSONA_MODEL = "claude-haiku-4-5-20251001";

export interface ClaudeArgOptions {
  systemPrompt?: string;
  jsonSchema?: string;
  outputFormat?: "json" | "text" | "stream-json";
  allowWebTools?: boolean;
  includePartialMessages?: boolean;
  claudeSessionId?: string;
  resumeSession?: boolean;
  model?: string; // test-override only; defaults to PERSONA_MODEL
}

export function buildClaudeArgs(prompt: string, opts: ClaudeArgOptions = {}): string[] {
  // ... unchanged allowlist/denylist/strict-mcp-config base ...
  const args = [
    "--allowedTools", allowedTools,
    "--disallowedTools", KITE_WRITE_TOOL_DENYLIST,
    "--strict-mcp-config",
    "--model", opts.model ?? PERSONA_MODEL,
  ];
  // ... unchanged remainder ...
}
```

Rationale for a named constant + optional override: single source of truth (one string, not six call sites); the `model?` option exists solely so a test can assert the flag is present and can pin a different value without shelling out to a real model. The uniform-Haiku choice is locked (P9A§2 decision 1) and not re-opened. The value `claude-haiku-4-5-20251001` is used verbatim as the user specified.

## P9A§6 Decision 2 — per-persona timeouts

Move the timeout from a single provider-level constant to a per-call field on `PersonaRunSpec`, and give narrative its own value too (it already had a separate constant; this unifies the mechanism).

`claudeCliProvider.ts` — `PersonaRunSpec<T>` gains `timeoutMs: number` (required, no default-on-the-runner fallback, so every call site is forced to be explicit):

```typescript
export interface PersonaRunSpec<T> {
  name: TraceSource;          // narrowed from string; every call site already passes a TraceSource literal
  systemPrompt: string;
  jsonSchema: object;
  schema: ZodType<T>;
  prompt: string;
  timeoutMs: number;          // NEW — replaces the shared DEFAULT_PERSONA_TIMEOUT_MS
  onTrace?: TraceEmitter;     // NEW — see P9A§8
  signal?: AbortSignal;
  allowWebTools?: boolean;
}
```

The runner's guard message stays exactly `` `persona ${spec.name} timed out after ${spec.timeoutMs}ms` `` (unchanged wording, now per-spec ms). `DEFAULT_PERSONA_TIMEOUT_MS` and `ClaudeRunnerOptions.personaTimeoutMs` / `ClaudeCliProviderOptions.personaTimeoutMs` are removed; timeouts flow from the specs instead.

Concrete default values (P9A§2 decision 2 — proposed, still tunable):

| Persona | `timeoutMs` | Set at |
| --- | --- | --- |
| intake | 20000 | `intake.ts` `runIntake` spec |
| options_greeks | 45000 | `personaPipeline.ts` analytical spec |
| technical_quant | 45000 | `personaPipeline.ts` analytical spec |
| position_risk | 45000 | `personaPipeline.ts` analytical spec |
| synthesis | 25000 | `personaPipeline.ts` synthesis spec |
| narrative | 60000 | `streamingNarrative.ts` / `NarrativeStreamSpec.timeoutMs` (down from 180000) |

To keep these values discoverable and in one place rather than scattered as literals, define a `PERSONA_TIMEOUTS_MS` record in `claudeCliProvider.ts` keyed by `TraceSource` and read it at each spec construction:

```typescript
export const PERSONA_TIMEOUTS_MS: Record<TraceSource, number> = {
  sidecar: 20000,          // used by P9A§7's compute bound, kept here for co-location
  intake: 20000,
  options_greeks: 45000,
  technical_quant: 45000,
  position_risk: 45000,
  synthesis: 25000,
  narrative: 60000,
};
```

`NarrativeStreamSpec` gains `timeoutMs: number` (required) and `makeNarrativeStreamer` drops `DEFAULT_NARRATIVE_TIMEOUT_MS`; the caller passes `PERSONA_TIMEOUTS_MS.narrative`.

## P9A§7 Decision 3 — envelope-assembly timeouts (net-new)

`assembleEnvelope` (`analysisEnvelope.ts:28-59`) today awaits `fetchAndArchive` and `sidecar.compute` with no bound. Wrap each in its own timeout with a labeled message mirroring the persona pattern.

A small local helper (co-located in `analysisEnvelope.ts`; not exported unless a second caller appears):

```typescript
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, guard]).finally(() => clearTimeout(timer));
}
```

Bounds (P9A§2 decision 3): Kite fetch `KITE_FETCH_TIMEOUT_MS = 15000`, compute `PERSONA_TIMEOUTS_MS.sidecar = 20000`. Messages: `"kite fetch timed out after 15000ms"` and `"sidecar compute timed out after 20000ms"`.

`AssembleEnvelopeParams` gains two optional, trace-only hooks so the pure-ish assembler stays usable without the trace system (engine_only passes neither):

```typescript
export interface AssembleEnvelopeParams {
  // ... existing fields ...
  onComputeId?: (id: number) => void; // NEW — P9A§9 correlation
  onTrace?: TraceEmitter;             // NEW — sidecar-compute-timeout error emission only
}
```

Reworked body:

```typescript
const { closes } = await withTimeout(
  fetchAndArchive({ kite: deps.kite, sidecar: deps.sidecar }, { /* unchanged */ }),
  KITE_FETCH_TIMEOUT_MS,
  "kite fetch",
);

let compute: ComputeResponseWire;
try {
  compute = await withTimeout(
    deps.sidecar.compute(params.instrument.symbol, params.timeframe, closes, params.onComputeId),
    PERSONA_TIMEOUTS_MS.sidecar,
    "sidecar compute",
  );
} catch (error) {
  params.onTrace?.({ source: "sidecar", kind: "error", detail: (error as Error).message });
  throw error;
}
```

Notes:

- **No `kite` trace source.** The `TraceEvent` source union (P9A§10) deliberately has no `"kite"` member, so a Kite-fetch timeout emits **no** trace event; it rejects with the labeled message and is surfaced solely by the run-level IPC rejection (P9A§12). Only the compute step, which *does* have a `"sidecar"` source, emits a `kind:"error"` trace event.
- **Interaction with the supervisor's own timeout.** `SidecarSupervisor` already bounds each request at `DEFAULT_REQUEST_TIMEOUT_MS = 30000` (`sidecarSupervisor.ts:42`). The new 20000 ms envelope bound is intentionally tighter so the failure names the step (`sidecar compute timed out after 20000ms`) instead of the generic `sidecar request N timed out after 30000ms`. `withTimeout` does not cancel the underlying `compute` promise; the supervisor's own pending settles or times out independently and harmlessly.
- **`SidecarSupervisor.compute` gains a fourth optional param** `onRequestId?: (id: number) => void` (P9A§9), threaded from `params.onComputeId`. Existing callers (engine_only, benchmark, scan) pass nothing and are unaffected.

## P9A§8 Decision 4 — uniform persona streaming + tool capture

All six personas move to the stream-json transport narrative already uses. The runner is generalized from narrative's token-only callback to a richer `onTrace` that also emits tool-call and tool-result events.

### P9A§8.1 The trace-emission callback

Producers emit *unstamped* events; the concrete emitter (P9A§13) stamps `requestId` + `at`:

```typescript
export type TraceEventInput = Pick<TraceEvent, "source" | "kind"> & { detail?: string };
export type TraceEmitter = (event: TraceEventInput) => void;
```

`TraceEvent`, `TraceSource`, `TraceKind` are defined in `rendererApi.ts` (P9A§10). `TraceEventInput` / `TraceEmitter` are main-process-only helper types (may live in `rendererApi.ts` next to the public types, but are never sent over IPC).

### P9A§8.2 A shared stream-json consumer

Extract the stream-json line handling (currently inline in `streamingNarrative.ts:82-132`) into one reusable consumer used by both the structured runner and the narrative streamer, so the two paths cannot drift on how they parse the CLI's output. Conceptually:

```typescript
interface StreamCallbacks {
  onToken?: (text: string) => void;                       // text_delta
  onToolCall?: (name: string, input: unknown) => void;    // assistant tool_use block
  onToolResult?: (name: string, resultText: string) => void; // user tool_result block
  onResult: (finalText: string) => void;                  // terminal result / subtype:"success"
  onFailure: (error: Error) => void;                      // non-success terminal, exit code, parse-fatal
}
```

Lines watched (superset of today's narrative handling):

- `type:"stream_event"`, `event.type:"content_block_delta"`, `event.delta.type:"text_delta"` → `onToken(text)` (unchanged from `streamingNarrative.ts:92-104`).
- `type:"assistant"` whose `message.content[]` contains a `{ type:"tool_use", id, name, input }` block → `onToolCall(name, input)`. The consumer records `id → name` in a `Map` for correlation.
- `type:"user"` whose `message.content[]` contains a `{ type:"tool_result", tool_use_id, content }` block → `onToolResult(name, resultText)`, where `name` is looked up from the correlation map (falling back to `tool_use_id` if absent) and `resultText` is the block's textual content.
- `type:"result"`: `subtype:"success"` with string `.result` → `onResult(result)`; otherwise `onFailure(...)`.

Watching the **complete** `assistant`/`user` message lines (not reassembling `input_json_delta` partials) yields whole tool inputs and results with no delta bookkeeping; the only partial stream this phase consumes is `text_delta` for narrative tokens.

> Verification item (not a design hole): the exact stream-json envelope the installed `claude` CLI emits for a `--json-schema` structured persona must be confirmed during implementation — specifically whether the schema-conforming object arrives as a field on the terminal `result` line or as the `result` text to be `JSON.parse`d. The runner (P9A§8.3) must handle both: prefer a structured field if present, else parse the `result` string as JSON, then apply the unchanged zod validation. This is called out in the testing plan (P9A§14).

### P9A§8.3 The structured runner

`makeClaudeRunner` is rewritten to spawn with `outputFormat: "stream-json"`, `includePartialMessages: true` (and keep `--json-schema` for the five structured personas), driving the shared consumer instead of `readResult`. Behavior preserved: up to two attempts (first + one corrective retry on a zod parse failure); a **timeout/abort throws immediately and is not retried**.

Trace events emitted by the structured runner, per persona call:

- `{ source: spec.name, kind:"started" }` — once, at the first spawn. Retries do **not** emit a second `started`.
- `{ source: spec.name, kind:"toolCall", detail }` — per `onToolCall`, in whichever attempt it occurs.
- `{ source: spec.name, kind:"toolResult", detail }` — per `onToolResult`.
- `{ source: spec.name, kind:"done" }` — once, when a schema-valid result is produced (either attempt).
- `{ source: spec.name, kind:"error", detail: message }` — once, on terminal failure (timeout, abort, or retry-exhausted schema failure), emitted **before** the runner rejects, with the same message the rejection carries.

Structured personas do **not** emit `kind:"token"` — their output is JSON being assembled, not human-readable narrative, so streaming it as tokens would be noise. Only narrative emits tokens.

**Invariant (testable):** every persona emits exactly one `started` and exactly one terminal event — `done` XOR `error`.

### P9A§8.4 The narrative streamer

`streamingNarrative.ts` keeps returning the concatenated final text (needed for `renderedText` persistence) and additionally emits, via `onTrace`, `source:"narrative"`:

- `started` (once, at spawn), `token` (per `text_delta` — replacing today's `onToken` push), `toolCall`/`toolResult` (narrative can call read/web tools), `done` (on terminal success), `error` (on failure, before reject).

`NarrativeStreamSpec` replaces `onToken: (text) => void` with `onTrace: TraceEmitter` and adds `timeoutMs: number`. Live narrative display in the renderer is now driven by `source:"narrative"` `kind:"token"` events on the unified channel rather than the retired narrative channel.

### P9A§8.5 Tool-result summarization (concrete decision — a judgment call)

Tool results can be large (a Kite historical-data blob, a web-fetch page). Persisting them raw would bloat the `messages` table and every IPC payload, and full market data is already persisted structurally elsewhere (via `persistCandles` / `algo_results`). Decision:

- `TRACE_DETAIL_MAX = 200` characters caps the **variable** portion of a `toolCall`/`toolResult` detail (args or result preview). The short tool-name prefix is added outside the cap (tool names are bounded and small).
- A shared `summarizeForTrace(text: string, max = TRACE_DETAIL_MAX): string`:
  1. collapse all whitespace runs to a single space and trim;
  2. if length ≤ `max`, return as-is;
  3. else return `` `${text.slice(0, max)}… (truncated, ${text.length} chars)` ``.
- `toolResult` detail = `` `${toolName} → ${summarizeForTrace(resultText)}` ``.
- `toolCall` detail = `` `${toolName} ${summarizeForTrace(JSON.stringify(input ?? {}))}` ``.

Reasoning: a structured, name-prefixed, length-bounded string keeps every trace event small and JSON-safe while preserving enough to see *which* tool ran and roughly *what* it returned. The explicit `(truncated, N chars)` suffix makes truncation unambiguous (so a reader never mistakes a clipped preview for a short real result). 200 chars is enough to identify a result's shape (e.g. the first key/value of a quote object) without storing full data dumps.

## P9A§9 Decision 5 — Rust sidecar progress protocol

Add a new stdout **line type** interleaved with the existing response line on the same stream (the user rejected a separate fd). Shape:

```json
{"type":"progress","id":<request_id>,"step":"<step>","status":"running"|"done"}
```

### P9A§9.1 Rust side (`rust-core/crates/sidecar/`)

- `protocol.rs`: add a serde-serializable `ProgressLine { r#type: "progress" (const), id: u64, step: String, status: String }` and a helper `encode_progress(id, step, status) -> String`. `step` and `status` are `&'static str` at the call sites.
- `main.rs`: two helper fns matching on the request variant, called on a `&SidecarRequest` **before** the `match` moves it — `request_id(&request) -> u64` and `request_step(&request) -> &'static str` (`"compute"`, `"persist_candles"`, `"add_watchlist_symbol"`, …, the request-type discriminant). Then bracket the existing `let response = match request { … }`:

```rust
let step = request_step(&request);
let id = request_id(&request);
writeln!(stdout, "{}", encode_progress(id, step, "running")).expect("stdout must be writable");
stdout.flush().expect("stdout must flush");

let response = match request { /* unchanged arms */ };

writeln!(stdout, "{}", encode_progress(id, step, "done")).expect("stdout must be writable");
stdout.flush().expect("stdout must flush");
writeln!(stdout, "{}", encode_response(&response)).expect("stdout must be writable");
stdout.flush().expect("stdout must flush");
```

These are **new, non-panic stdout writes**, distinct from the existing panic `eprintln!` sites (`main.rs:70,83,…,215`) which remain on stderr unchanged. Emitting at the `main.rs` handler boundary — rather than per-algorithm inside `run_applicable` — is a deliberate choice: it keeps stdout I/O in the sidecar binary (the I/O layer) and out of the pure `algo-core` crate, respecting the repo's pure-logic-vs-I/O separation rule (CLAUDE.md). This resolves the brainstorm's loose `<algo_name>` phrasing to **the handler/step name** (`"compute"` for the analysis path). `"done"` fires even when a handler hits its `catch_unwind` panic-fallback, because the `match` still yields a response — matching the sidecar's always-answers invariant.

Progress is emitted uniformly for every request type (parity with the panic sites); only `compute` progress surfaces as a trace event in this phase (P9A§9.3), because only the compute request's id is registered by the analysis path.

### P9A§9.2 TypeScript side (`sidecarProtocol.ts`, `sidecarSupervisor.ts`)

`sidecarProtocol.ts` adds:

```typescript
export interface SidecarProgressWire {
  type: "progress";
  id: number;
  step: string;
  status: "running" | "done";
}
```

`sidecarSupervisor.ts`:

- `dispatch(line)` (`sidecarSupervisor.ts:165-178`) now discriminates on `type`. A `progress` line routes to the EventEmitter and returns **without** touching `pending`; any other line is handled exactly as today (resolve the matching pending):

```typescript
private dispatch(line: string): void {
  let parsed: SidecarProgressWire | SidecarResponseWire;
  try { parsed = JSON.parse(line); } catch (error) { /* unchanged error log */ return; }
  if (parsed.type === "progress") { this.emit("progress", parsed); return; }
  // ... unchanged response handling: pending.get(parsed.id) → resolve ...
}
```

- `send(request, onRequestId?)` invokes `onRequestId?.(id)` synchronously right after allocating `id = this.nextId++` and before the stdin write, so the caller learns its id before any progress line can return. `compute(symbol, timeframe, closes, onRequestId?)` threads it through. All other public methods are unchanged (they may add the param later; not required now).
- The `"progress"` event joins the existing `"statusChange"` event on the same emitter; no separate emitter.

### P9A§9.3 Correlating sidecar progress to a request

`SidecarSupervisor` is a long-lived singleton shared with the proactive scan scheduler, so its `"progress"` stream carries events from computes that are not part of any `analysis:run`. Correlation is therefore by the numeric sidecar `id`, not by "whatever fired while I was subscribed" (which would let a concurrent scan-tick compute bleed into an analysis trace). `runAiAssistedRequest` (P9A§13):

1. maintains `ownedSidecarIds = new Set<number>()`;
2. subscribes a `(p: SidecarProgressWire) => void` listener to the supervisor's `"progress"` for the duration of the request; the listener ignores any `p.id` not in `ownedSidecarIds`, and for owned ids emits `{ source:"sidecar", kind: p.status === "running" ? "started" : "done", detail: p.step }`;
3. passes `onComputeId: (id) => ownedSidecarIds.add(id)` into `assembleEnvelope`, which forwards it to `compute`'s `onRequestId` (fired synchronously, so the id is registered before any progress line arrives);
4. removes the listener and clears the set in a `finally` around `assembleEnvelope`, so a late `done` after a compute timeout (P9A§7) is dropped.

`AiAssistedRequestDeps.sidecar` widens from `Pick<SidecarSupervisor, "compute" | "persistCandles">` to also include `"on" | "off"` so the bridge can subscribe/unsubscribe.

## P9A§10 Decision 6 — unified IPC trace channel

Retire `analysis:narrative`; introduce one channel `analysis:trace` carrying a discriminated union. `banner:push` is untouched.

### P9A§10.1 Public types (`rendererApi.ts`)

```typescript
export type TraceSource =
  | "sidecar"
  | "intake"
  | "options_greeks"
  | "technical_quant"
  | "position_risk"
  | "synthesis"
  | "narrative";

export type TraceKind = "started" | "toolCall" | "toolResult" | "token" | "done" | "error";

export interface TraceEvent {
  requestId: string;
  source: TraceSource;
  kind: TraceKind;
  detail?: string;
  at: string; // ISO 8601, from new Date().toISOString() at emission time
}
```

`RendererApi` gains `onTrace(handler: (event: TraceEvent) => void)` subscribing to `"analysis:trace"`. To keep the renderer **byte-unchanged** (P9A§15), `NarrativeEvent` and `onNarrative` are **retained as a temporary backward-compatibility adapter over the unified channel** — `onNarrative` no longer subscribes to a narrative-specific channel; it subscribes to `"analysis:trace"`, filters `source:"narrative"`, and reshapes into the legacy `NarrativeEvent`:

```typescript
onTrace: (handler) => subscribe("analysis:trace", handler as (p: unknown) => void),
onNarrative: (handler) =>
  subscribe("analysis:trace", (payload) => {
    const e = payload as TraceEvent;
    if (e.source !== "narrative") return;
    if (e.kind === "token") handler({ requestId: e.requestId, chunk: e.detail });
    else if (e.kind === "done") handler({ requestId: e.requestId, done: true });
    else if (e.kind === "error") handler({ requestId: e.requestId, error: e.detail });
  }),
```

So `ChatView.tsx` (and every renderer consumer of `onNarrative`) is **not touched** and the app builds and renders identically. The main process no longer emits any `NarrativeEvent`; it emits only `TraceEvent`s, and the adapter reconstructs the legacy shape in the renderer. Phase 9-B deletes `onNarrative`/`NarrativeEvent` when it builds the real trace-consuming UI on `onTrace`.

### P9A§10.2 `detail` population, exhaustively (per source × kind)

| kind | detail | Emitted by |
| --- | --- | --- |
| `started` | `undefined` for persona sources; the sidecar `step` string (e.g. `"compute"`) for `source:"sidecar"` | persona runner / narrative streamer at spawn; sidecar listener on `status:"running"` |
| `toolCall` | `` `${toolName} ${summarizeForTrace(JSON.stringify(input ?? {}))}` `` | persona runner / narrative streamer |
| `toolResult` | `` `${toolName} → ${summarizeForTrace(resultText)}` `` | persona runner / narrative streamer |
| `token` | the literal text chunk, **verbatim and uncapped** (deltas are small) | narrative streamer only |
| `done` | `undefined` for persona sources; the sidecar `step` string for `source:"sidecar"` | persona runner / narrative streamer on success; sidecar listener on `status:"done"` |
| `error` | the error message, **verbatim** (e.g. `"persona intake timed out after 20000ms"`, `"sidecar compute timed out after 20000ms"`) | the failing producer, before its rejection propagates |

`at` is always `new Date().toISOString()` stamped by the concrete emitter (P9A§13). `requestId` is always the `analysis:run` request id, also stamped by the emitter.

### P9A§10.3 Channel/sender wiring

- `narrativeBridge.ts` → renamed `traceBridge.ts`: `TRACE_CHANNEL = "analysis:trace"`; `makeTraceSender(sendToRenderer): (event: TraceEvent) => void` = `(event) => sendToRenderer(TRACE_CHANNEL, event)`.
- `bootstrap.ts:19,238`: import `makeTraceSender`; `sendTrace: makeTraceSender(sendToRenderer)`.
- `analysisBridge.ts`: `AiAssistedRequestDeps` / `AnalysisBridgeDeps` field `sendNarrative` → `sendTrace: (event: TraceEvent) => void`; the run passes it into the concrete emitter (P9A§13). The `engine_only` path (`runAnalysisRequest`) takes no `sendTrace` and emits no trace — unchanged.
- `preload.ts` needs no change (it forwards any channel). The only channel strings that move are inside `rendererApi.ts`'s `buildRendererApi`, where both `onTrace` and the legacy `onNarrative` adapter now subscribe to `"analysis:trace"`.
- The renderer is **untouched**: `ChatView.tsx` keeps calling `onNarrative`, which the adapter feeds from the unified channel (P9A§10.1).

## P9A§11 Decision 7 — persistence + migration

### P9A§11.1 Schema and params

- `AppendMessageParams` (`historyStore.ts:29-34`) gains `trace?: TraceEvent[]`.
- `HistoryMessage` (`historyStore.ts:16-21`) gains `trace: TraceEvent[] | null`.
- The `messages` `CREATE TABLE IF NOT EXISTS` (lines 78-85) gains a `trace TEXT` column (covers **fresh** installs).
- The prepared `insertMessage` (lines 96-99) and `appendMessageTxn` (lines 101-111) add the `trace` column, binding `params.trace === undefined ? null : JSON.stringify(params.trace)` — the exact `structured_payload` pattern (line 107).
- `getSession`'s row mapping (lines 166-174) parses `trace` the same way `structured_payload` is parsed (line 172): `row.trace === null ? null : JSON.parse(row.trace)`; its SELECT (line 157) adds `trace`.

### P9A§11.2 Migration for already-installed databases (must be correct)

Confirmed by reading `historyStore.ts`: the schema is set up with `CREATE TABLE IF NOT EXISTS` in the constructor. On a DB that already has a `messages` table (the app ships to a real user with real session history on disk), that statement is a **whole-statement no-op**, so adding `trace TEXT` to the `CREATE` alone would **not** add the column to the existing table. An explicit, idempotent migration is required.

After the `db.exec(CREATE TABLE …)` block and before preparing statements, run a guarded column-add helper:

```typescript
private ensureColumn(table: string, column: string, type: string): void {
  const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
// in the constructor, after db.exec(...):
this.ensureColumn("messages", "trace", "TEXT");
```

This is idempotent across both paths:

- **Fresh install:** `CREATE TABLE` already includes `trace`; `PRAGMA table_info` shows it; the `ALTER` is skipped.
- **Existing install:** `CREATE TABLE` is a no-op; `PRAGMA table_info` lacks `trace`; the `ALTER` adds it. SQLite `ADD COLUMN` is a cheap metadata-only operation and back-fills existing rows with `NULL`, so it is safe on a populated `messages` table and old rows read back as `trace: null`.
- Constructing the store twice never throws (the guard makes the `ALTER` conditional).

`table`/`column`/`type` are internal string literals, never user input — no injection surface.

### P9A§11.3 Write path

The assistant-turn append in `runAiAssistedRequest` (`analysisBridge.ts:132-137`) passes `trace: traceEvents` — the array accumulated during the run (P9A§13). Persistence happens only on success (the append is on the success path; the error path appends nothing, leaving the user message orphaned exactly as today, `analysisBridge.ts:116-117,139-142`). So a failed run persists **no** trace; its per-step trace events were delivered live over `analysis:trace` and are observable in the devtools console but not stored. The proactive-scan assistant append (`scanScheduler.ts` `recordWorthAiCall`) omits `trace` (optional) — scan runs use a no-op emitter (P9A§13) and store no trace.

## P9A§12 Error / failure semantics

**Today.** Any error in `runAiAssistedRequest` is caught (`analysisBridge.ts:139-142`), pushed to the renderer as `sendNarrative({ requestId, error })`, then rethrown, so the `analysis:run` IPC promise rejects. The renderer both awaits that promise and listens on the narrative channel — the pushed error is belt-and-suspenders on top of the always-present promise rejection.

**After this phase.** The **`analysis:run` promise rejection remains the single authoritative run-failure signal, unchanged.** Trace `kind:"error"` events are *supplementary per-step attribution*: a step that has a `TraceSource` emits exactly one `error` event naming itself **before** its rejection propagates.

- **Persona timeout / final failure** (intake, options_greeks, technical_quant, position_risk, synthesis): the runner emits `{ source:<persona>, kind:"error", detail }` then rejects with the same message (`persona <name> timed out after <ms>ms`, or the retry-exhausted message). Exactly one error event; it names the persona.
- **Narrative timeout / failure:** the streamer emits `{ source:"narrative", kind:"error", detail }` then rejects.
- **Sidecar compute timeout:** `assembleEnvelope` emits `{ source:"sidecar", kind:"error", detail:"sidecar compute timed out after 20000ms" }` then rejects (P9A§7). A late Rust `done` afterward is dropped (listener removed in `finally`, P9A§9.3), so the invariant holds: sidecar emits one `started` and exactly one of `{done, error}`.
- **Kite fetch timeout:** no `"kite"` trace source exists, so **no** trace event is emitted; it rejects with `"kite fetch timed out after 15000ms"`, surfaced only via the IPC rejection.
- **Run-level catch in `runAiAssistedRequest`:** it no longer pushes a generic error event (there is no valid `TraceSource` for a generic run-level error, and every step that *has* a source already emitted its own attributed error). It simply rethrows so the IPC promise rejects, and persists nothing (P9A§11.3). The old `sendNarrative({ requestId, error })` line (`analysisBridge.ts:140`) is deleted.
- **Run-level done:** the explicit `sendNarrative({ requestId, done: true })` (`analysisBridge.ts:121`) is deleted; narrative's own `{ source:"narrative", kind:"done" }` is the terminal trace signal, and the resolved IPC promise (carrying `AnalysisResult`) is the authoritative "result ready" signal.

**Why deleting the two direct narrative pushes is not a renderer regression** (verified against `ChatView.tsx`): the renderer's `onSend` already wraps `bridge().runAnalysis(...)` in `try/catch` and sets the displayed error from the **rejected promise** (`ChatView.tsx:82-83`) — independent of any channel event. So every run-level failure still surfaces exactly as today. Narrative token/done and narrative errors still reach `ChatView`'s `onNarrative` handler, now via the compatibility adapter (P9A§10.1) that maps `source:"narrative"` `token`/`done`/`error` events back to the legacy shape. Non-narrative step errors (intake/synthesis/analytical/sidecar) are new information that the legacy `onNarrative` handler ignores by design and that the promise-rejection path already covers for display.

Direct answer to the design question "does a timeout emit an `error` TraceEvent before the rejection propagates?": **yes for any step with a `TraceSource`** (all personas and the sidecar compute) — exactly one, carrying the same message the rejection carries; **no for the Kite fetch** (no source), whose failure is visible only as the rejected `analysis:run` promise.

## P9A§13 End-to-end trace plumbing (how the pieces connect)

`runAiAssistedRequest` owns the per-request trace lifecycle:

```typescript
const traceEvents: TraceEvent[] = [];
const emit: TraceEmitter = (input) => {
  const event: TraceEvent = { requestId: params.requestId, at: (deps.now?.() ?? new Date()).toISOString(), ...input };
  traceEvents.push(event);   // for persistence (success path)
  deps.sendTrace(event);     // live to the renderer over analysis:trace
};
```

`emit` is the single stamping boundary (adds `requestId` + `at`). It is threaded to every producer:

- `deps.provider.intake(params.query, { onTrace: emit })` — intake gains an options arg `{ onTrace?: TraceEmitter }`.
- The sidecar `"progress"` listener + `ownedSidecarIds`, with `onComputeId`/`onTrace` passed into `assembleEnvelope` (P9A§9.3, P9A§7).
- `deps.provider.completeAiAssisted(envelope, { …, onTrace: emit })` — `CompleteAiAssistedOptions.onNarrativeToken` is replaced by `onTrace: TraceEmitter`. `completeAiAssisted` forwards `onTrace` to `runPersonaPipeline` (new `PipelineRunOptions.onTrace`, set on each analytical/synthesis `PersonaRunSpec.onTrace`) and to `streamNarrative` (`NarrativeStreamSpec.onTrace`).

Each persona spec's `name` becomes its `source`; the runner emits with `source: spec.name`. `PersonaName` values (`intake`, `options_greeks`, `technical_quant`, `position_risk`, `synthesis`) and `narrative` are all `TraceSource` literals — so no mapping table is needed.

Callers that don't want a trace pass a no-op:

- `scanScheduler.ts:156-160` (`recordWorthAiCall`): `onNarrativeToken: () => {}` → `onTrace: () => {}`. It calls no `intake` and persists no trace.
- Any future headless caller passes `() => {}`.

## P9A§14 Testing strategy (high level — becomes the implementation plan)

No test code here; this enumerates what must be verified.

1. **Safety regression (first).** The existing `kiteClient.test.ts` exact-eleven-read-method allowlist test passes unchanged; `buildClaudeArgs` still emits the unchanged `--allowedTools`/`--disallowedTools`/`--strict-mcp-config`, with `--model` as the only addition.
2. **Model flag.** `buildClaudeArgs` output contains `--model claude-haiku-4-5-20251001`; a `spawnFn` spy confirms all six persona spawns (five structured + narrative) carry it.
3. **Per-persona timeouts.** Each spec carries its P9A§6 value; a `spawnFn` whose child never emits a terminal result trips the timeout at exactly `timeoutMs` and rejects with `persona <name> timed out after <ms>ms`; narrative rejects at 60000.
4. **Envelope timeouts.** A hanging fake Kite fetch rejects at 15000 with `kite fetch timed out after 15000ms`; a hanging fake compute rejects at 20000 with `sidecar compute timed out after 20000ms`, and emits exactly one `{source:"sidecar", kind:"error"}` first; a hanging Kite fetch emits **no** trace event.
5. **Streaming + tool capture.** Feed a canned stream-json transcript (assistant `tool_use`, user `tool_result`, terminal `result`) through the shared consumer; assert the ordered events `started`, `toolCall` (detail = name + summarized args), `toolResult` (detail = `name → ` + summarized preview), `done`; assert truncation at 200 chars with the `… (truncated, N chars)` suffix and whitespace collapse; assert structured personas emit no `token` and narrative emits `token` verbatim. Confirm the `--json-schema` structured-output extraction (the P9A§8.2 verification item) against the installed CLI.
6. **Runner invariant.** Every persona emits exactly one `started` and exactly one of `{done, error}`; a schema failure retried once then succeeding emits a single `started` and a single `done`; a timeout emits `started` then `error` (no `done`), and the promise rejects with the same message the `error` detail carries.
7. **Sidecar progress.** A fake sidecar stdout interleaving `progress` and response lines: `dispatch` routes `progress` to the `"progress"` event and still resolves the response pending for the same id; the bridge listener maps an owned compute id to `sidecar` `started`/`done` and ignores unowned ids (e.g. a concurrent scan-tick compute); a late `done` after a compute timeout is dropped.
8. **Unified channel + detail table.** `makeTraceSender` publishes on `analysis:trace`; `detail` matches the P9A§10.2 table for every `(source, kind)`; `at` is a valid ISO string; `requestId` matches the run.
9. **Persistence + migration.** Against a DB whose `messages` table predates the column (simulated old install), the constructor's `ensureColumn` adds `trace` via `ALTER`; `appendMessage({ …, trace })` round-trips through `getSession` as a parsed `TraceEvent[]`; old rows read `trace: null`; a fresh DB gets `trace` via `CREATE`; constructing the store twice does not throw; a failed run persists no assistant row (hence no trace).
10. **Rust.** A unit/integration test on `main.rs`'s loop (or a thin harness): a `compute` request produces, in order on stdout, a `progress running` line, then a `progress done` line, then the `compute` response line, all for the same id; a handler that panic-falls-back still emits `done`; `request_step` returns the correct discriminant per variant.

## P9A§15 Non-goals

- **The permanent no-order-placement invariant** (§2, §4) is unaffected — this phase adds no order surface of any kind (P9A§3). Permanent.
- **All UI / CSS / renderer visual work** — the styled, collapsible subagent panels that consume `analysis:trace` — is **Phase 9-B**. This spec designs none of it, and touches **no renderer file**. The channel/type migration lands without any UI change because `rendererApi.ts` keeps a temporary backward-compatibility `onNarrative` adapter over the unified `analysis:trace` channel (P9A§10.1), so `ChatView.tsx` and every renderer consumer stay byte-unchanged and the app builds and renders identically. All new trace kinds and non-narrative sources are observable only via the devtools console / logs in this phase — nothing displays them. "Verifiable with zero UI changes" is literal: no renderer file is edited; Phase 9-B removes the `onNarrative` adapter when it builds the real trace-consuming UI on `onTrace`.
- **`engine_only` mode's persona behavior** is untouched — it invokes no personas, has no `requestId`, and emits no trace events; it takes no `sendTrace`. It *does* share `assembleEnvelope` and therefore inherits the new Kite-fetch/compute timeouts (P9A§7) — a bounded-failure improvement with no success-path behavior change and no trace emission (it passes neither `onTrace` nor `onComputeId`).
- **Model tiering** (a mixed Haiku/Sonnet strategy) is explicitly rejected in favor of uniform Haiku 4.5 (P9A§2 decision 1). Not revisited in this phase.
- **No change to the sidecar's response protocol** for existing request types; `progress` is purely additive and type-discriminated on the same stream (P9A§9). No separate pipe/fd.
- **No change to Claude session continuity** (`claudeSessionId` / `--resume` logic in `analysisBridge.ts:108-119` and `claudeCliProvider.ts`), to the single corrective-retry policy, or to any retry/backoff behavior beyond what P9A§6–§8 restate.
- **No new npm or crate dependency**; all changes use the existing `better-sqlite3`, `node:events`, serde, and the installed `claude` CLI.

## P9A§16 File touch-point summary

| File | Change |
| --- | --- |
| `electron-app/src/main/services/claude/claudeProvider.ts` | `PERSONA_MODEL` const; `--model` in `buildClaudeArgs`; `model?` option (P9A§5) |
| `electron-app/src/main/services/claude/claudeCliProvider.ts` | stream-json runner + shared consumer; `PersonaRunSpec.timeoutMs`/`onTrace`; `name: TraceSource`; `PERSONA_TIMEOUTS_MS`; `onTrace` threading; drop `DEFAULT_PERSONA_TIMEOUT_MS` (P9A§6, §8, §13) |
| `electron-app/src/main/services/claude/streamingNarrative.ts` | drive shared consumer; `onToken`→`onTrace`; `timeoutMs` required; token/tool/started/done/error emission; drop `DEFAULT_NARRATIVE_TIMEOUT_MS` (P9A§8.4) |
| `electron-app/src/main/services/claude/personaPipeline.ts` | `PipelineRunOptions.onTrace`; per-spec `timeoutMs` + `onTrace` on analytical/synthesis specs (P9A§6, §13) |
| `electron-app/src/main/services/claude/intake.ts` | `runIntake(deps, query, { onTrace? })`; intake spec `timeoutMs` + `onTrace` (P9A§6, §13) |
| `electron-app/src/main/services/claude/provider.ts` | `CompleteAiAssistedOptions`: `onNarrativeToken`→`onTrace`; `intake(query, opts?)` (P9A§13) |
| `electron-app/src/main/services/analysis/analysisEnvelope.ts` | `withTimeout`; Kite/compute bounds; `onComputeId`/`onTrace` params; sidecar-error emission (P9A§7) |
| `electron-app/src/main/services/sidecar/sidecarProtocol.ts` | `SidecarProgressWire` (P9A§9.2) |
| `electron-app/src/main/services/sidecar/sidecarSupervisor.ts` | `dispatch` discriminates `progress`; `"progress"` event; `send`/`compute` `onRequestId` (P9A§9) |
| `electron-app/src/main/services/history/historyStore.ts` | `trace` column in CREATE; `ensureColumn` migration; `AppendMessageParams.trace`; `HistoryMessage.trace`; insert/select mapping (P9A§11) |
| `electron-app/src/main/ipc/rendererApi.ts` | add `TraceSource`/`TraceKind`/`TraceEvent`/`TraceEventInput`/`TraceEmitter` + `onTrace` on `analysis:trace`; keep `NarrativeEvent`/`onNarrative` as a compat adapter over `analysis:trace` (P9A§8.1, §10.1) |
| `electron-app/src/main/ipc/narrativeBridge.ts` → `traceBridge.ts` | `TRACE_CHANNEL`; `makeTraceSender` (P9A§10.3) |
| `electron-app/src/main/ipc/analysisBridge.ts` | concrete emitter + accumulation; sidecar progress listener/correlation; `sendNarrative`→`sendTrace`; delete run-level `done`/`error` pushes; persist `trace`; widen `sidecar` Pick with `on`/`off` (P9A§7, §9.3, §11.3, §12, §13) |
| `electron-app/src/main/bootstrap.ts` | `makeTraceSender`; `sendTrace` dep (P9A§10.3) |
| `electron-app/src/main/scanScheduler.ts` | `onNarrativeToken: () => {}` → `onTrace: () => {}` (P9A§13) |
| `electron-app/src/renderer/*` | **untouched** — the `onNarrative` compat adapter keeps `ChatView.tsx` byte-unchanged (P9A§15) |
| `rust-core/crates/sidecar/src/protocol.rs` | `ProgressLine` + `encode_progress` (P9A§9.1) |
| `rust-core/crates/sidecar/src/main.rs` | `request_id`/`request_step` helpers; `progress running`/`done` stdout writes bracketing the match (P9A§9.1) |
```
