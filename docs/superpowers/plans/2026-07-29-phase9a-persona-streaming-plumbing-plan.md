# Phase 9-A — Persona Streaming & Progress Plumbing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deliberate-model, per-step timeout, uniform six-persona streaming with tool capture, a Rust sidecar progress protocol, a single unified `analysis:trace` IPC channel, and full-trace persistence — all backend/plumbing, verifiable from the devtools console with zero renderer changes.

**Architecture:** Producers (persona runner, narrative streamer, sidecar-progress listener) emit *unstamped* `TraceEventInput`s into a single per-request `emit` boundary in `runAiAssistedRequest` that stamps `requestId` + `at`, accumulates them for persistence, and pushes each live to the renderer over one channel `analysis:trace`. The Rust pure-compute crate (`algo-core`) stays I/O-free by exposing a progress *callback*; the sidecar binary (`main.rs`) does the actual stdout writes. A temporary `onNarrative` adapter in `rendererApi.ts` reshapes `source:"narrative"` trace events back into the legacy `NarrativeEvent` so `ChatView.tsx` is byte-unchanged.

**Tech Stack:** Electron + TypeScript main process (`electron-app/`, Vitest), Rust workspace (`rust-core/`, cargo test), `better-sqlite3`, `node:events`, the installed `claude` CLI (`stream-json` transport), serde.

## Global Constraints

Every task's requirements implicitly include this section. Copy these verbatim.

- **PERMANENT SAFETY INVARIANT (re-verify per task):** the app never places, modifies, cancels, or automates any order on Zerodha Kite — ever. This phase adds telemetry only. **No task may add, remove, or widen any Kite tool allowlist/denylist entry.** `buildClaudeArgs` keeps `--allowedTools = KITE_READ_TOOL_ALLOWLIST` (+ web tools only where already granted), `--disallowedTools = KITE_WRITE_TOOL_DENYLIST`, and `--strict-mcp-config` **byte-for-byte**; the *only* argv addition in this phase is `--model` (Task 2). `test/main/services/kite/kiteClient.test.ts`'s exact-eleven-read-method allowlist test ("exposes exactly the eleven read-tool methods and no others") must keep passing **unmodified** throughout — do not edit it.
- **CLAUDE.md — Comments:** default to NO comments. Add one only when the *why* isn't obvious (a non-obvious invariant, a workaround for an upstream bug, a formula's source). Never restate what the next line does. Never write numbered "1. do X, 2. do Y" comment blocks.
- **CLAUDE.md — Naming:** Rust `snake_case` fns/vars, `PascalCase` types, one clear responsibility per file. TypeScript `camelCase` fns/vars, `PascalCase` types/classes, no Hungarian notation, no non-standard abbreviations (`oi`/`pcr`/`ltp` are fine). File names describe responsibility, not file kind.
- **CLAUDE.md — Structure:** small, focused files. Pure logic (`algo-core`) stays separate from I/O (`sidecar`/`storage`). Task 5's Rust design is a direct application: the progress callback lets `algo-core` stay pure while the sidecar binary does the stdout I/O. Every task touching `registry.rs`/`handlers.rs`/`main.rs` must preserve that separation exactly.
- **No renderer file is touched.** `electron-app/src/renderer/*` stays byte-unchanged. The `onNarrative` compat adapter (Task 1) is what makes this possible. UI is Phase 9-B — do not drift into it.
- **No new npm or crate dependency.** Use only existing `better-sqlite3`, `node:events`, serde, and the installed `claude` CLI.
- **Exact numeric values (verbatim):**
  - Model string: `claude-haiku-4-5-20251001`
  - Per-persona timeouts (`PERSONA_TIMEOUTS_MS`, ms): `sidecar` 20000, `intake` 20000, `options_greeks` 45000, `technical_quant` 45000, `position_risk` 45000, `synthesis` 25000, `narrative` 60000.
  - Envelope bounds: `KITE_FETCH_TIMEOUT_MS = 15000`; compute bound = `PERSONA_TIMEOUTS_MS.sidecar = 20000`. Messages: `"kite fetch timed out after 15000ms"`, `"sidecar compute timed out after 20000ms"`.
  - `TRACE_DETAIL_MAX = 200` (caps the *variable* portion of a `toolCall`/`toolResult` detail; tool-name prefix is added outside the cap).
  - New nullable `messages.trace TEXT` column, same JSON-blob pattern as `structured_payload`, added via `CREATE TABLE` (fresh installs) **and** an idempotent `ensureColumn` `ALTER TABLE ... ADD COLUMN` guard (existing installs).
- **Commands run from `electron-app/`** for TS (`npx vitest run <path>`, `npx tsc --noEmit`) and from `rust-core/` for Rust (`cargo test -p <crate>`). All paths in this plan are repo-relative under `electron-app/` unless prefixed `rust-core/`.
- **Commit style:** plain `git commit`, no `--author`, no `Co-Authored-By`, no `--no-verify`. Configured git user `hadetan` is correct.

---

## Task Dependency Order

1. Trace types + unified `analysis:trace` channel + `onNarrative` compat adapter (foundational).
2. Explicit uniform `--model` flag (independent).
3. Per-persona timeouts (`timeoutMs` + `PERSONA_TIMEOUTS_MS`; needs Task 1's `TraceSource`).
4. Rust sidecar progress protocol (independent subsystem).
5. TypeScript sidecar progress plumbing (`SidecarProgressWire`, `dispatch` discrimination, `onRequestId`).
6. Envelope-assembly timeouts (needs Tasks 1, 3, 5).
7. Shared stream-json consumer + `summarizeForTrace` (independent pure primitives).
8. Structured runner rewrite + trace emission (needs Tasks 1, 3, 7).
9. Narrative streamer rewrite (needs Tasks 1, 3, 7).
10. Thread `onTrace`/`timeoutMs` through provider/pipeline/intake/scan (needs Tasks 8, 9).
11. Persistence + migration (needs Task 1).
12. End-to-end wiring: concrete emitter, accumulation, sidecar correlation, error semantics (LAST; needs 1,3,5,6,8,9,10,11).

---

### Task 1: Unified `analysis:trace` channel, trace types, and `onNarrative` compat adapter

**Files:**
- Modify: `src/main/ipc/rendererApi.ts` (add trace types + `onTrace`; rewrite `onNarrative` as an adapter)
- Create: `src/main/ipc/traceBridge.ts` (renamed from `narrativeBridge.ts`)
- Delete: `src/main/ipc/narrativeBridge.ts`
- Modify: `src/main/bootstrap.ts` (import `makeTraceSender`; pass `sendTrace`)
- Modify: `src/main/ipc/analysisBridge.ts` (rename `sendNarrative` dep/param → `sendTrace: (event: TraceEvent) => void`; add a local `emit` boundary; emit narrative `token`/`done`/`error` as `TraceEvent`s)
- Create: `test/main/ipc/traceBridge.test.ts`
- Delete: `test/main/ipc/narrativeBridge.test.ts`
- Modify: `test/main/ipc/rendererApi.test.ts`, `test/main/ipc/analysisBridge.test.ts`, `test/main/ipc/aiAssisted.integration.test.ts`

**Interfaces:**
- Consumes: existing `NarrativeEvent`, `sendToRenderer(channel, payload)`.
- Produces (relied on by Tasks 3,4,5,6,8,9,10,11,12):
  ```typescript
  export type TraceSource =
    | "sidecar" | "intake" | "options_greeks" | "technical_quant"
    | "position_risk" | "synthesis" | "narrative";
  export type TraceKind = "started" | "toolCall" | "toolResult" | "token" | "done" | "error";
  export interface TraceEvent { requestId: string; source: TraceSource; kind: TraceKind; detail?: string; at: string; }
  export type TraceEventInput = Pick<TraceEvent, "source" | "kind"> & { detail?: string };
  export type TraceEmitter = (event: TraceEventInput) => void;
  // rendererApi.ts: RendererApi.onTrace(handler: (event: TraceEvent) => void): void
  // traceBridge.ts:
  export const TRACE_CHANNEL = "analysis:trace";
  export function makeTraceSender(sendToRenderer: (channel: string, payload: unknown) => void): (event: TraceEvent) => void;
  // analysisBridge.ts: runAiAssistedRequest(deps, params, sendTrace: (event: TraceEvent) => void)
  // AiAssistedRequestDeps.sendTrace is passed positionally (3rd arg), unchanged shape from today's sendNarrative slot.
  ```

- [ ] **Step 1: Write the failing test for `traceBridge`**

Create `test/main/ipc/traceBridge.test.ts`:
```typescript
import { describe, expect, it, vi } from "vitest";
import { TRACE_CHANNEL, makeTraceSender } from "../../../src/main/ipc/traceBridge";
import type { TraceEvent } from "../../../src/main/ipc/rendererApi";

describe("makeTraceSender", () => {
  it("publishes every TraceEvent on the analysis:trace channel", () => {
    const sendToRenderer = vi.fn();
    const send = makeTraceSender(sendToRenderer);
    const event: TraceEvent = { requestId: "r1", source: "intake", kind: "started", at: "2026-07-29T00:00:00.000Z" };
    send(event);
    expect(TRACE_CHANNEL).toBe("analysis:trace");
    expect(sendToRenderer).toHaveBeenCalledWith("analysis:trace", event);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/main/ipc/traceBridge.test.ts`
Expected: FAIL — cannot resolve `../../../src/main/ipc/traceBridge`.

- [ ] **Step 3: Add the trace types to `rendererApi.ts`**

In `src/main/ipc/rendererApi.ts`, replace the `NarrativeEvent` interface (lines 70-75) region by adding the trace types above it and keeping `NarrativeEvent`:
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
  at: string; // ISO 8601, stamped at emission time
}

// Main-process-only helper types (never sent over IPC): producers emit
// unstamped inputs; the concrete emitter adds requestId + at.
export type TraceEventInput = Pick<TraceEvent, "source" | "kind"> & { detail?: string };
export type TraceEmitter = (event: TraceEventInput) => void;

export interface NarrativeEvent {
  requestId: string;
  chunk?: string;
  done?: boolean;
  error?: string;
}
```
Add `onTrace(handler: (event: TraceEvent) => void): void;` to the `RendererApi` interface (after `onNarrative`). In `buildRendererApi`, add `onTrace` and rewrite `onNarrative` as the adapter (both subscribe to `"analysis:trace"`):
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

- [ ] **Step 4: Create `traceBridge.ts`, delete `narrativeBridge.ts`**

Create `src/main/ipc/traceBridge.ts`:
```typescript
import type { TraceEvent } from "./rendererApi";

export const TRACE_CHANNEL = "analysis:trace";

export function makeTraceSender(
  sendToRenderer: (channel: string, payload: unknown) => void,
): (event: TraceEvent) => void {
  return (event) => sendToRenderer(TRACE_CHANNEL, event);
}
```
Delete `src/main/ipc/narrativeBridge.ts` and `test/main/ipc/narrativeBridge.test.ts`.

- [ ] **Step 5: Update `bootstrap.ts` and `analysisBridge.ts`**

In `bootstrap.ts`: change the import on line 19 to `import { makeTraceSender } from "./ipc/traceBridge";` and in `registerAnalysisBridge({...})` replace `sendNarrative: makeNarrativeSender(sendToRenderer),` with `sendTrace: makeTraceSender(sendToRenderer),`.

In `analysisBridge.ts`: change the import of `NarrativeEvent` to `TraceEvent, TraceEventInput`; rename the `AnalysisBridgeDeps.sendNarrative` field and the `runAiAssistedRequest` 3rd param to `sendTrace: (event: TraceEvent) => void`; introduce a local `emit` boundary and use it for narrative `token`/`done`/`error`:
```typescript
export async function runAiAssistedRequest(
  deps: AiAssistedRequestDeps,
  params: Extract<AnalysisRunParams, { mode: "ai_assisted" }>,
  sendTrace: (event: TraceEvent) => void,
): Promise<AnalysisResult> {
  const now = deps.now?.() ?? new Date();
  const emit = (input: TraceEventInput): void => {
    sendTrace({ requestId: params.requestId, at: (deps.now?.() ?? new Date()).toISOString(), ...input });
  };
  try {
    // ... unchanged user append + intake + assembleEnvelope + session id ...
    const { verdict, narrative } = await deps.provider.completeAiAssisted(envelope, {
      researchNotes: intake.researchNotes,
      onNarrativeToken: (chunk) => emit({ source: "narrative", kind: "token", detail: chunk }),
      claudeSessionId,
      resumeSession: existingClaudeSessionId !== null,
    });
    if (existingClaudeSessionId === null) deps.history.setClaudeSessionId(params.sessionId, claudeSessionId);
    emit({ source: "narrative", kind: "done" });
    // ... unchanged result build + assistant append ...
    return result;
  } catch (error) {
    emit({ source: "narrative", kind: "error", detail: (error as Error).message });
    throw error;
  }
}
```
Update `registerAnalysisBridge` to pass `deps.sendTrace` where it passed `deps.sendNarrative`. (This narrative-only emission is interim; Task 12 generalizes `emit`, adds accumulation/correlation, and deletes the run-level `done`/`error` pushes.)

- [ ] **Step 6: Update the three affected TS tests**

`test/main/ipc/rendererApi.test.ts`: change the "twelve bridge methods" assertion to thirteen (insert `"onTrace"` into the sorted list); replace the "subscribes onNarrative to the analysis:narrative push channel" test with one asserting `onNarrative` subscribes to `"analysis:trace"` and reshapes a `source:"narrative"` `token` event into `{ requestId, chunk }`; add a test that `onTrace` subscribes to `"analysis:trace"`:
```typescript
it("subscribes onTrace and the onNarrative adapter to analysis:trace", () => {
  const subscribe = vi.fn();
  const api = buildRendererApi(vi.fn(), subscribe);
  api.onTrace(vi.fn());
  expect(subscribe).toHaveBeenLastCalledWith("analysis:trace", expect.any(Function));
  const narrHandler = vi.fn();
  api.onNarrative(narrHandler);
  const adapter = subscribe.mock.calls.at(-1)![1] as (p: unknown) => void;
  adapter({ requestId: "r1", source: "narrative", kind: "token", detail: "hi", at: "t" });
  adapter({ requestId: "r1", source: "intake", kind: "started", at: "t" }); // ignored
  expect(narrHandler).toHaveBeenCalledTimes(1);
  expect(narrHandler).toHaveBeenCalledWith({ requestId: "r1", chunk: "hi" });
});
```
`test/main/ipc/analysisBridge.test.ts`: rename the harness `sendNarrative: vi.fn()` to `sendTrace: vi.fn()`; the `runAiAssistedRequest` callers pass a `sendTrace` spy; change the `sends` assertions to trace-shaped events (each carries `source:"narrative"`, `at: expect.any(String)`):
```typescript
expect(sends).toEqual([
  { requestId: "r7", source: "narrative", kind: "token", detail: "Infy ", at: expect.any(String) },
  { requestId: "r7", source: "narrative", kind: "token", detail: "is constructive.", at: expect.any(String) },
  { requestId: "r7", source: "narrative", kind: "done", at: expect.any(String) },
]);
```
and the failure test's `expect(sends).toContainEqual(...)` becomes:
```typescript
expect(sends).toContainEqual({ requestId: "r7", source: "narrative", kind: "error", detail: "claude down", at: expect.any(String) });
```
`test/main/ipc/aiAssisted.integration.test.ts`: change the `events` assertion to filter narrative-source events into the legacy shape (stays green through all later tasks):
```typescript
const narrative = events
  .map((e) => e as { source: string; kind: string; detail?: string })
  .filter((e) => e.source === "narrative");
expect(narrative).toEqual([
  { source: "narrative", kind: "token", detail: "Infy ", requestId: "rZ", at: expect.any(String) },
  { source: "narrative", kind: "token", detail: "is constructive.", requestId: "rZ", at: expect.any(String) },
  { source: "narrative", kind: "done", requestId: "rZ", at: expect.any(String) },
]);
```
(`test/main/ipc/sessionContinuity.integration.test.ts` passes `() => {}` as the 3rd arg and needs no change.)

- [ ] **Step 7: Run the suite + typecheck**

Run: `npx vitest run test/main/ipc/traceBridge.test.ts test/main/ipc/rendererApi.test.ts test/main/ipc/analysisBridge.test.ts test/main/ipc/aiAssisted.integration.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors. Re-verify `kiteClient.test.ts` untouched.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(phase9a): unified analysis:trace channel with onNarrative compat adapter"
```

---

### Task 2: Explicit uniform `--model` flag

**Files:**
- Modify: `src/main/services/claude/claudeProvider.ts`
- Modify: `test/main/services/claude/claudeProvider.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (relied on by all persona spawns): `export const PERSONA_MODEL = "claude-haiku-4-5-20251001";` and `ClaudeArgOptions.model?: string` (test-override only; defaults to `PERSONA_MODEL`). `buildClaudeArgs` emits `--model <opts.model ?? PERSONA_MODEL>` immediately after `--strict-mcp-config`.

- [ ] **Step 1: Write the failing tests**

In `test/main/services/claude/claudeProvider.test.ts`, add:
```typescript
import { PERSONA_MODEL } from "../../../../src/main/services/claude/claudeProvider";

describe("uniform model flag", () => {
  it("defaults --model to Haiku 4.5 right after the three safety flags", () => {
    expect(PERSONA_MODEL).toBe("claude-haiku-4-5-20251001");
    const args = buildClaudeArgs("analyze INFY");
    expect(args.slice(0, 6)).toEqual([
      "--allowedTools", KITE_READ_TOOL_ALLOWLIST,
      "--disallowedTools", KITE_WRITE_TOOL_DENYLIST,
      "--strict-mcp-config",
      "--model",
    ]);
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-4-5-20251001");
    expect(args.slice(-2)).toEqual(["--print", "analyze INFY"]);
  });

  it("honours a test-only model override without touching the tool flags", () => {
    const args = buildClaudeArgs("p", { model: "some-other-model" });
    expect(args[args.indexOf("--model") + 1]).toBe("some-other-model");
    expect(args[0]).toBe("--allowedTools");
    expect(args[2]).toBe("--disallowedTools");
    expect(args[3]).toBe(KITE_WRITE_TOOL_DENYLIST);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/main/services/claude/claudeProvider.test.ts -t "uniform model flag"`
Expected: FAIL — `PERSONA_MODEL` not exported / argv has no `--model`.

- [ ] **Step 3: Implement the model flag**

In `claudeProvider.ts`, add the constant and option and emit the flag:
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
```
and inside `buildClaudeArgs`, extend the fixed base array:
```typescript
  const args = [
    "--allowedTools",
    allowedTools,
    "--disallowedTools",
    KITE_WRITE_TOOL_DENYLIST,
    "--strict-mcp-config",
    "--model",
    opts.model ?? PERSONA_MODEL,
  ];
```

- [ ] **Step 4: Update the existing byte-exact argv assertions**

Two existing tests assert argv is byte-identical to "today". Update both to include the two new `--model`/value elements after `--strict-mcp-config`. In "builds exactly the fixed safety flags plus the prompt, nothing else" and in "returns byte-identical argv to today when allowWebTools is falsy":
```typescript
expect(buildClaudeArgs("analyze INFY")).toEqual([
  "--allowedTools", KITE_READ_TOOL_ALLOWLIST,
  "--disallowedTools", KITE_WRITE_TOOL_DENYLIST,
  "--strict-mcp-config",
  "--model", "claude-haiku-4-5-20251001",
  "--print", "analyze INFY",
]);
```
The "keeps the three safety flags first" / "appends persona flags after the three safety flags" tests use `args.slice(0, 5)` for the safety prefix and `args.slice(-2)` for `--print`; both remain correct (safety flags stay at indices 0-4, `--print` stays last), so leave them unchanged. Do **not** touch `kiteClient.test.ts`.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run test/main/services/claude/claudeProvider.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(phase9a): pass uniform --model claude-haiku-4-5-20251001 on every persona spawn"
```

---

### Task 3: Per-persona timeouts

**Files:**
- Modify: `src/main/services/claude/claudeCliProvider.ts` (`PersonaRunSpec.timeoutMs`, `name: TraceSource`, `PERSONA_TIMEOUTS_MS`; drop `DEFAULT_PERSONA_TIMEOUT_MS`, `ClaudeRunnerOptions.personaTimeoutMs`, `ClaudeCliProviderOptions.personaTimeoutMs`/`narrativeTimeoutMs`)
- Modify: `src/main/services/claude/streamingNarrative.ts` (`NarrativeStreamSpec.timeoutMs` required; drop `DEFAULT_NARRATIVE_TIMEOUT_MS` and `NarrativeStreamerOptions.timeoutMs`)
- Modify: `src/main/services/claude/intake.ts` (intake spec `timeoutMs`)
- Modify: `src/main/services/claude/personaPipeline.ts` (analytical + synthesis specs `timeoutMs`)
- Modify: `test/main/services/claude/claudeCliProvider.test.ts`, `test/main/services/claude/streamingNarrative.test.ts`

**Interfaces:**
- Consumes: `TraceSource` (Task 1).
- Produces:
  ```typescript
  export interface PersonaRunSpec<T> {
    name: TraceSource;      // narrowed from string
    systemPrompt: string;
    jsonSchema: object;
    schema: ZodType<T>;
    prompt: string;
    timeoutMs: number;      // NEW — required
    signal?: AbortSignal;
    allowWebTools?: boolean;
  }
  export const PERSONA_TIMEOUTS_MS: Record<TraceSource, number>;
  // NarrativeStreamSpec.timeoutMs: number (required)
  ```
  (`PersonaRunSpec.onTrace?: TraceEmitter` is added later in Task 8.)

- [ ] **Step 1: Write the failing tests**

In `claudeCliProvider.test.ts`, add `timeoutMs` to `baseSpec()` and rewrite the timeout test to source the value from the spec (not a runner option):
```typescript
function baseSpec() {
  return { name: "technical_quant" as const, systemPrompt: "sys", jsonSchema: personaFindingJsonSchema, schema: personaFindingSchema, prompt: "user prompt", timeoutMs: 120000 };
}
```
```typescript
it("trips each spec's own timeoutMs and names the persona", async () => {
  const spawnFn = () => { const c = new FakeChild(); return c as never; }; // never emits
  const run = makeClaudeRunner({ spawnFn });
  await expect(run({ ...baseSpec(), timeoutMs: 15 })).rejects.toThrow(/persona technical_quant timed out after 15ms/);
});

it("exposes the P9A§6 default timeout table", async () => {
  const { PERSONA_TIMEOUTS_MS } = await import("../../../../src/main/services/claude/claudeCliProvider");
  expect(PERSONA_TIMEOUTS_MS).toEqual({
    sidecar: 20000, intake: 20000, options_greeks: 45000, technical_quant: 45000,
    position_risk: 45000, synthesis: 25000, narrative: 60000,
  });
});
```
In `streamingNarrative.test.ts`, add `timeoutMs` to `baseSpec` and route the timeout test through the spec:
```typescript
const baseSpec = (onToken: (t: string) => void) => ({ systemPrompt: "sys", prompt: "explain", onToken, timeoutMs: 180000 });
```
```typescript
it("rejects and kills the child on its spec timeoutMs", async () => {
  const child = new FakeChild();
  const pending = makeNarrativeStreamer({ spawnFn: () => child as never })({ ...baseSpec(() => {}), timeoutMs: 15 });
  await expect(pending).rejects.toThrow(/timed out after 15ms/);
  expect(child.killed).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/main/services/claude/claudeCliProvider.test.ts test/main/services/claude/streamingNarrative.test.ts`
Expected: FAIL — `PERSONA_TIMEOUTS_MS` missing; `personaTimeoutMs` option gone; type error on missing `timeoutMs`.

- [ ] **Step 3: Implement per-spec timeouts in the runner**

In `claudeCliProvider.ts`: import `TraceSource` from `../../ipc/rendererApi`; narrow `PersonaRunSpec.name` to `TraceSource`; add `timeoutMs: number`; delete `DEFAULT_PERSONA_TIMEOUT_MS` and `ClaudeRunnerOptions.personaTimeoutMs`. In `makeClaudeRunner`, drop the `personaTimeoutMs` local; inside `attempt`, use `spec.timeoutMs` in both the `setTimeout` and the guard message:
```typescript
timer = setTimeout(() => {
  reject(new Error(`persona ${spec.name} timed out after ${spec.timeoutMs}ms`));
  child.kill();
}, spec.timeoutMs);
```
Add the table:
```typescript
export const PERSONA_TIMEOUTS_MS: Record<TraceSource, number> = {
  sidecar: 20000, // used by P9A§7's compute bound, kept here for co-location
  intake: 20000,
  options_greeks: 45000,
  technical_quant: 45000,
  position_risk: 45000,
  synthesis: 25000,
  narrative: 60000,
};
```
Remove `personaTimeoutMs`/`narrativeTimeoutMs` from `ClaudeCliProviderOptions`; construct the runner as `makeClaudeRunner({ spawnFn: options.spawnFn })` and the streamer as `makeNarrativeStreamer({ spawnFn: options.spawnFn })`; pass `timeoutMs: PERSONA_TIMEOUTS_MS.narrative` in the `streamNarrative` spec inside `completeAiAssisted`.

- [ ] **Step 4: Implement per-spec timeout in the narrative streamer**

In `streamingNarrative.ts`: add `timeoutMs: number` to `NarrativeStreamSpec`; delete `DEFAULT_NARRATIVE_TIMEOUT_MS` and `NarrativeStreamerOptions.timeoutMs`; use `spec.timeoutMs` in the `setTimeout` and keep the message `` `narrative timed out after ${spec.timeoutMs}ms` ``.

- [ ] **Step 5: Set `timeoutMs` at each spec construction**

`intake.ts`: import `PERSONA_TIMEOUTS_MS`; add `timeoutMs: PERSONA_TIMEOUTS_MS.intake` to the `runPersona` spec.
`personaPipeline.ts`: import `PERSONA_TIMEOUTS_MS`; add `timeoutMs: PERSONA_TIMEOUTS_MS[persona.name]` to each analytical spec and `timeoutMs: PERSONA_TIMEOUTS_MS.synthesis` to the synthesis spec.

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run test/main/services/claude && npx tsc --noEmit`
Expected: PASS. (The `intake.test.ts` / `personaPipeline.test.ts` mock `runPersona`, so they need no changes; confirm they still pass.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(phase9a): per-persona timeouts via PersonaRunSpec.timeoutMs and PERSONA_TIMEOUTS_MS"
```

---

### Task 4: Rust sidecar progress protocol

**Files:**
- Modify: `rust-core/crates/algo-core/src/registry.rs` (`run_applicable_with_progress`; `run_applicable` becomes a thin wrapper)
- Modify: `rust-core/crates/sidecar/src/handlers.rs` (`handle_request_with_progress`; `handle_request` thin wrapper)
- Modify: `rust-core/crates/sidecar/src/protocol.rs` (`ProgressLine` + `encode_progress`)
- Modify: `rust-core/crates/sidecar/src/main.rs` (`request_id`/`request_step` helpers; request-level bracket; `Compute` arm threads a per-algorithm closure)
- Test: add `rust-core/crates/algo-core/tests/registry_progress_test.rs`; add a `#[test]` to `sidecar/src/protocol.rs`'s `mod tests` and a progress-ordering test in `sidecar/src/handlers.rs`'s `mod tests`.

**Interfaces:**
- Consumes: `Algorithm::id() -> &'static str`, `Algorithm::required_lookback() -> usize` (existing).
- Produces (relied on by Task 5's wire contract + Task 12 correlation): stdout `progress` lines shaped `{"type":"progress","id":<u64>,"step":"<step>","status":"running"|"done"}` where `step` is a request-type name (`"compute"`, `"persist_candles"`, …) at the request-level bracket, or an algorithm id (`"rsi"`, …) nested inside a `compute`.

- [ ] **Step 1: Write the failing `algo-core` progress test**

Create `rust-core/crates/algo-core/tests/registry_progress_test.rs`:
```rust
use algo_core::registry::{all_for_binary, run_applicable, run_applicable_with_progress};
use algo_core::MarketContext;
use chrono::Utc;

fn ctx(n: usize) -> MarketContext {
    let closes: Vec<f64> = (0..n).map(|i| 100.0 + i as f64).collect();
    MarketContext::from_closes("NSE:INFY".into(), algo_core::Timeframe::Day, algo_core::Horizon::Positional, closes, Utc::now())
}

#[test]
fn invokes_callback_running_then_done_per_algorithm_in_registry_order_and_matches_run_applicable() {
    let algos = all_for_binary();
    let ctx = ctx(60);
    let mut events: Vec<(String, bool)> = Vec::new();
    let with = run_applicable_with_progress(&algos, &ctx, &mut |id, done| events.push((id.to_string(), done)));
    let plain = run_applicable(&algos, &ctx);

    // identical outputs
    assert_eq!(with.len(), plain.len());
    // exactly one (id,false) immediately before each (id,true), same order as outputs
    let expected: Vec<(String, bool)> = with
        .iter()
        .flat_map(|o| vec![(o.algo_id.to_string(), false), (o.algo_id.to_string(), true)])
        .collect();
    assert_eq!(events, expected);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd rust-core && cargo test -p algo-core --test registry_progress_test`
Expected: FAIL — `run_applicable_with_progress` not found.

- [ ] **Step 3: Implement `run_applicable_with_progress`**

In `registry.rs`, replace `run_applicable`'s body with a delegation and add the progress sibling (moving the single lookback filter into it):
```rust
pub fn run_applicable(algos: &[Box<dyn Algorithm>], ctx: &MarketContext) -> Vec<AlgoOutput> {
    run_applicable_with_progress(algos, ctx, &mut |_, _| {})
}

// The callback lets algo-core surface live per-algorithm progress without
// itself doing any I/O: this crate is pure compute (CLAUDE.md's pure-logic-
// vs-I/O rule), so it only *invokes* a caller-supplied closure at each
// algorithm boundary. The actual stdout write happens in the sidecar binary's
// I/O layer (main.rs), never here.
pub fn run_applicable_with_progress(
    algos: &[Box<dyn Algorithm>],
    ctx: &MarketContext,
    on_progress: &mut dyn FnMut(&str, bool), // (algo_id, is_done)
) -> Vec<AlgoOutput> {
    algos
        .iter()
        .filter(|algo| algo.required_lookback() <= ctx.closes.len())
        .map(|algo| {
            on_progress(algo.id(), false);
            let output = algo.compute(ctx);
            on_progress(algo.id(), true);
            output
        })
        .collect()
}
```
Keep the existing doc comment on the "single enforcement point" but move it to `run_applicable_with_progress` (that is now where the filter lives).

- [ ] **Step 4: Run the `algo-core` tests**

Run: `cd rust-core && cargo test -p algo-core`
Expected: PASS — the new test plus the three existing non-progress callers (`registry_test.rs`) unchanged.

- [ ] **Step 5: Write the failing `protocol.rs` progress test**

In `sidecar/src/protocol.rs`'s `mod tests`, add:
```rust
#[test]
fn encode_progress_emits_a_single_line_progress_object() {
    let line = encode_progress(7, "compute", "running");
    assert!(line.contains("\"type\":\"progress\""));
    assert!(line.contains("\"id\":7"));
    assert!(line.contains("\"step\":\"compute\""));
    assert!(line.contains("\"status\":\"running\""));
    assert!(!line.contains('\n'));
    // per-algorithm step is just another string in the same field
    assert!(encode_progress(7, "rsi", "done").contains("\"step\":\"rsi\""));
}
```

- [ ] **Step 6: Run to verify failure**

Run: `cd rust-core && cargo test -p sidecar --lib protocol`
Expected: FAIL — `encode_progress` not found.

- [ ] **Step 7: Implement `ProgressLine` + `encode_progress`**

In `protocol.rs`, add:
```rust
#[derive(Debug, Serialize)]
pub struct ProgressLine {
    pub r#type: &'static str,
    pub id: u64,
    pub step: String,
    pub status: String,
}

pub fn encode_progress(id: u64, step: &str, status: &str) -> String {
    serde_json::to_string(&ProgressLine {
        r#type: "progress",
        id,
        step: step.to_string(),
        status: status.to_string(),
    })
    .expect("ProgressLine always serializes")
}
```
(`step` is `&str` so it accepts both the request-type names and the algorithm ids arriving through the per-algorithm callback.)

- [ ] **Step 8: Implement `handle_request_with_progress`**

In `handlers.rs`, import `run_applicable_with_progress`; wrap the current body:
```rust
pub fn handle_request(request: ComputeRequest) -> ComputeResponse {
    handle_request_with_progress(request, &mut |_, _| {})
}

pub fn handle_request_with_progress(
    request: ComputeRequest,
    on_progress: &mut dyn FnMut(&str, bool),
) -> ComputeResponse {
    // ... exact current body of handle_request, except:
    let outputs = run_applicable_with_progress(&algos, &ctx, on_progress);
    // ... rest unchanged ...
}
```
The callback carries only `(algo_id, is_done)` — not the request id (the id is written by `main.rs`, which has it in scope). `handle_request`'s five existing call sites (four in the test module, one in `main.rs`) are untouched.

- [ ] **Step 9: Write the failing sidecar progress-ordering test**

In `handlers.rs`'s `mod tests`, add a test that drives `handle_request_with_progress` and records the callback order:
```rust
#[test]
fn handle_request_with_progress_brackets_each_algorithm_running_then_done_in_registry_order() {
    let mut events: Vec<(String, bool)> = Vec::new();
    let response = handle_request_with_progress(request(1, closes_seq(21)), &mut |id, done| {
        events.push((id.to_string(), done))
    });
    // one running/done pair per produced algo_result, in the same order
    let expected: Vec<(String, bool)> = response
        .algo_results
        .iter()
        .flat_map(|r| vec![(r.algo_id.clone(), false), (r.algo_id.clone(), true)])
        .collect();
    assert_eq!(events, expected);
}
```

- [ ] **Step 10: Run to verify it passes (impl already present from Step 8)**

Run: `cd rust-core && cargo test -p sidecar`
Expected: PASS.

- [ ] **Step 11: Wire the request-level bracket + per-algorithm closure into `main.rs`**

Add two helpers matching on a `&SidecarRequest` (before the `match` moves it):
```rust
fn request_id(request: &SidecarRequest) -> u64 {
    match request {
        SidecarRequest::Compute(r) => r.id,
        SidecarRequest::PersistCandles(r) => r.id,
        SidecarRequest::AddWatchlistSymbol(r) => r.id,
        SidecarRequest::RemoveWatchlistSymbol(r) => r.id,
        SidecarRequest::ListWatchlist(r) => r.id,
        SidecarRequest::EvaluateScanGate(r) => r.id,
        SidecarRequest::ListLakeSymbols(r) => r.id,
        SidecarRequest::ReadLakeCandles(r) => r.id,
        SidecarRequest::BenchmarkCompute(r) => r.id,
        SidecarRequest::EvaluateScanGateStateless(r) => r.id,
    }
}

fn request_step(request: &SidecarRequest) -> &'static str {
    match request {
        SidecarRequest::Compute(_) => "compute",
        SidecarRequest::PersistCandles(_) => "persist_candles",
        SidecarRequest::AddWatchlistSymbol(_) => "add_watchlist_symbol",
        SidecarRequest::RemoveWatchlistSymbol(_) => "remove_watchlist_symbol",
        SidecarRequest::ListWatchlist(_) => "list_watchlist",
        SidecarRequest::EvaluateScanGate(_) => "evaluate_scan_gate",
        SidecarRequest::ListLakeSymbols(_) => "list_lake_symbols",
        SidecarRequest::ReadLakeCandles(_) => "read_lake_candles",
        SidecarRequest::BenchmarkCompute(_) => "benchmark_compute",
        SidecarRequest::EvaluateScanGateStateless(_) => "evaluate_scan_gate_stateless",
    }
}
```
Import `encode_progress` and `handle_request_with_progress`. Bracket the whole `match` (all request types) and thread the per-algorithm closure into the `Compute` arm only:
```rust
let step = request_step(&request);
let id = request_id(&request);
writeln!(stdout, "{}", encode_progress(id, step, "running")).expect("stdout must be writable");
stdout.flush().expect("stdout must flush");

let response = match request {
    SidecarRequest::Compute(compute) => {
        let result = panic::catch_unwind(AssertUnwindSafe(|| {
            handle_request_with_progress(compute, &mut |algo_id, done| {
                let status = if done { "done" } else { "running" };
                writeln!(stdout, "{}", encode_progress(id, algo_id, status)).expect("stdout must be writable");
                stdout.flush().expect("stdout must flush");
            })
        }));
        match result {
            Ok(response) => SidecarResponse::Compute(response),
            Err(_) => {
                eprintln!("sidecar: compute request {id} panicked; returning an empty response");
                SidecarResponse::Compute(empty_response(id))
            }
        }
    }
    /* every other arm unchanged */
};

writeln!(stdout, "{}", encode_progress(id, step, "done")).expect("stdout must be writable");
stdout.flush().expect("stdout must flush");
writeln!(stdout, "{}", encode_response(&response)).expect("stdout must be writable");
stdout.flush().expect("stdout must flush");
```
Remove the now-duplicated per-arm `let id = ...;` from the `Compute` arm (the `id` is bound before the match); keep other arms' `let id = ...` as-is.

**Verification item (report on this, do not skip):** the per-algorithm closure captures `&mut stdout` inside `AssertUnwindSafe`/`catch_unwind`, between the outer bracket's own `stdout` writes. NLL *should* accept it (pre-match, in-arm, and post-match borrows are sequential and non-overlapping). Confirm it borrow-checks. If the checker disagrees, route the per-algorithm write through a small local helper or a scoped borrow (no observable output changes). Note the resolution in your task report.

- [ ] **Step 12: Build + full Rust test run**

Run: `cd rust-core && cargo build -p sidecar && cargo test -p sidecar && cargo test -p algo-core && cargo test -p backtest`
Expected: PASS across all three crates (backtest and benchmark still call the unchanged `run_applicable`).

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat(phase9a): rust sidecar per-algorithm progress protocol on stdout"
```

---

### Task 5: TypeScript sidecar progress plumbing

**Files:**
- Modify: `src/main/services/sidecar/sidecarProtocol.ts` (`SidecarProgressWire`)
- Modify: `src/main/services/sidecar/sidecarSupervisor.ts` (`dispatch` discrimination; `"progress"` event; `send`/`compute` `onRequestId`)
- Modify: `test/main/services/sidecar/sidecarProtocol.test.ts`, `test/main/services/sidecar/sidecarSupervisor.test.ts`

**Interfaces:**
- Consumes: Task 4's wire shape (verified via fake stdout here).
- Produces (relied on by Task 6 threading + Task 12 correlation):
  ```typescript
  export interface SidecarProgressWire { type: "progress"; id: number; step: string; status: "running" | "done"; }
  // SidecarSupervisor:
  //   emits "progress" (payload: SidecarProgressWire) on the same emitter as "statusChange"
  //   compute(symbol, timeframe, closes, onRequestId?: (id: number) => void): Promise<ComputeResponseWire>
  //   send(request, onRequestId?) fires onRequestId synchronously right after id allocation, before stdin write
  ```

- [ ] **Step 1: Write the failing protocol test**

In `sidecarProtocol.test.ts`, add:
```typescript
import type { SidecarProgressWire } from "../../../../src/main/services/sidecar/sidecarProtocol";

describe("SidecarProgressWire", () => {
  it("decodes a progress line carrying a request-step or an algorithm id in the same step field", () => {
    const req = JSON.parse('{"type":"progress","id":3,"step":"compute","status":"running"}') as SidecarProgressWire;
    expect(req.type).toBe("progress");
    expect(req.step).toBe("compute");
    expect(req.status).toBe("running");
    const algo = JSON.parse('{"type":"progress","id":3,"step":"rsi","status":"done"}') as SidecarProgressWire;
    expect(algo.step).toBe("rsi");
  });
});
```

- [ ] **Step 2: Write the failing supervisor tests**

In `sidecarSupervisor.test.ts`, add:
```typescript
it("routes a progress line to the \"progress\" event and still resolves the response pending for the same id", async () => {
  const { supervisor, children } = makeSupervisor();
  const progress: unknown[] = [];
  supervisor.on("progress", (p) => progress.push(p));
  const pending = supervisor.compute("NSE:INFY", "day", [1, 2, 3]);
  children[0].stdout.write(`${JSON.stringify({ type: "progress", id: 1, step: "compute", status: "running" })}\n`);
  children[0].stdout.write(`${JSON.stringify({ type: "progress", id: 1, step: "rsi", status: "running" })}\n`);
  children[0].stdout.write(`${JSON.stringify({ type: "progress", id: 1, step: "rsi", status: "done" })}\n`);
  children[0].stdout.write(`${JSON.stringify({ type: "progress", id: 1, step: "compute", status: "done" })}\n`);
  children[0].stdout.write(`${JSON.stringify({ type: "compute", id: 1, algo_results: [], confluence: { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 } })}\n`);
  const response = await pending;
  expect(response.id).toBe(1);
  expect(progress).toEqual([
    { type: "progress", id: 1, step: "compute", status: "running" },
    { type: "progress", id: 1, step: "rsi", status: "running" },
    { type: "progress", id: 1, step: "rsi", status: "done" },
    { type: "progress", id: 1, step: "compute", status: "done" },
  ]);
});

it("fires onRequestId synchronously with the allocated id before any progress can arrive", () => {
  const { supervisor } = makeSupervisor();
  let seen: number | undefined;
  supervisor.compute("NSE:INFY", "day", [1, 2, 3], (id) => { seen = id; });
  expect(seen).toBe(1);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/main/services/sidecar/sidecarProtocol.test.ts test/main/services/sidecar/sidecarSupervisor.test.ts`
Expected: FAIL — `SidecarProgressWire` missing; no `"progress"` event; `compute` has no 4th param.

- [ ] **Step 4: Implement `SidecarProgressWire`**

In `sidecarProtocol.ts`, add:
```typescript
export interface SidecarProgressWire {
  type: "progress";
  id: number;
  step: string; // request-type name ("compute", …) or algorithm id ("rsi", …)
  status: "running" | "done";
}
```

- [ ] **Step 5: Implement dispatch discrimination + `onRequestId`**

In `sidecarSupervisor.ts`: import `SidecarProgressWire`; rewrite `dispatch`:
```typescript
private dispatch(line: string): void {
  let parsed: SidecarProgressWire | SidecarResponseWire;
  try {
    parsed = JSON.parse(line) as SidecarProgressWire | SidecarResponseWire;
  } catch (error) {
    console.error(`sidecar: failed to parse response line: ${(error as Error).message}`, line);
    return;
  }
  if (parsed.type === "progress") {
    this.emit("progress", parsed);
    return;
  }
  const waiting = this.pending.get(parsed.id);
  if (!waiting) return;
  this.pending.delete(parsed.id);
  clearTimeout(waiting.timer);
  waiting.resolve(parsed);
}
```
Thread `onRequestId` through `send` and `compute`:
```typescript
compute(symbol: string, timeframe: string, closes: number[], onRequestId?: (id: number) => void): Promise<ComputeResponseWire> {
  return this.send({ type: "compute", id: this.nextId, symbol, timeframe, closes }, onRequestId) as Promise<ComputeResponseWire>;
}

private send(request: SidecarRequestWire, onRequestId?: (id: number) => void): Promise<SidecarResponseWire> {
  const id = this.nextId++;
  onRequestId?.(id);
  request.id = id;
  return new Promise<SidecarResponseWire>((resolve, reject) => {
    // ... unchanged body ...
  });
}
```
(Other public methods keep calling `this.send(request)` with no second arg.)

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run test/main/services/sidecar && npx tsc --noEmit`
Expected: PASS (existing supervisor tests still green — progress is additive).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(phase9a): SidecarSupervisor progress event + compute onRequestId threading"
```

---

### Task 6: Envelope-assembly timeouts

**Files:**
- Modify: `src/main/services/analysis/analysisEnvelope.ts` (`withTimeout`; Kite/compute bounds; `onComputeId`/`onTrace` params; sidecar-error emission)
- Modify: `test/main/services/analysis/analysisEnvelope.test.ts`

**Interfaces:**
- Consumes: `TraceEmitter` (Task 1), `PERSONA_TIMEOUTS_MS` (Task 3), `compute(..., onRequestId?)` (Task 5).
- Produces (relied on by Task 12):
  ```typescript
  export const KITE_FETCH_TIMEOUT_MS = 15000;
  export interface AssembleEnvelopeParams {
    // ... existing fields ...
    onComputeId?: (id: number) => void; // forwarded to compute's onRequestId
    onTrace?: TraceEmitter;             // sidecar-compute-timeout error emission only
  }
  ```

- [ ] **Step 1: Write the failing tests**

In `analysisEnvelope.test.ts`, add (use fake timers for determinism):
```typescript
import { vi } from "vitest";
import { KITE_FETCH_TIMEOUT_MS } from "../../../../src/main/services/analysis/analysisEnvelope";

it("rejects a hanging Kite fetch at 15000ms with a labeled message and emits NO trace event", async () => {
  vi.useFakeTimers();
  const kite = new KiteClient({ callTool: vi.fn(() => new Promise(() => {})) }); // never resolves
  const traced: unknown[] = [];
  const pending = assembleEnvelope(
    { kite, sidecar: mockSidecar() as never },
    { trigger: "reactive", instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" }, timeframe: "day", horizon_requested: "positional", intent_lens: "buying", from: "a", to: "b", onTrace: (e) => traced.push(e) },
  );
  const assertion = expect(pending).rejects.toThrow(/kite fetch timed out after 15000ms/);
  await vi.advanceTimersByTimeAsync(KITE_FETCH_TIMEOUT_MS);
  await assertion;
  expect(traced).toEqual([]);
  vi.useRealTimers();
});

it("rejects a hanging compute at 20000ms and emits exactly one sidecar error trace event first", async () => {
  vi.useFakeTimers();
  const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
  const sidecar = { persistCandles: vi.fn(async (_s, _t, c: { length: number }) => ({ type: "persist_candles" as const, id: 1, written: c.length })), compute: vi.fn(() => new Promise(() => {})) };
  const traced: Array<{ source: string; kind: string; detail?: string }> = [];
  const pending = assembleEnvelope(
    { kite, sidecar: sidecar as never },
    { trigger: "reactive", instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" }, timeframe: "day", horizon_requested: "positional", intent_lens: "buying", from: "a", to: "b", onTrace: (e) => traced.push(e) },
  );
  const assertion = expect(pending).rejects.toThrow(/sidecar compute timed out after 20000ms/);
  await vi.advanceTimersByTimeAsync(20000);
  await assertion;
  expect(traced).toEqual([{ source: "sidecar", kind: "error", detail: "sidecar compute timed out after 20000ms" }]);
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/main/services/analysis/analysisEnvelope.test.ts`
Expected: FAIL — `KITE_FETCH_TIMEOUT_MS` missing; no timeout; no trace emission.

- [ ] **Step 3: Implement `withTimeout` + bounds + hooks**

In `analysisEnvelope.ts`: import `PERSONA_TIMEOUTS_MS` from `../claude/claudeCliProvider` and `TraceEmitter` from `../../ipc/rendererApi`. Add the constant and helper:
```typescript
export const KITE_FETCH_TIMEOUT_MS = 15000;

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, guard]).finally(() => clearTimeout(timer));
}
```
Add `onComputeId?` and `onTrace?` to `AssembleEnvelopeParams`. Rework the body:
```typescript
  const { closes } = await withTimeout(
    fetchAndArchive(
      { kite: deps.kite, sidecar: deps.sidecar },
      { symbol: params.instrument.symbol, instrumentToken: params.instrument.instrumentToken, timeframe: params.timeframe, from: params.from, to: params.to },
    ),
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
Import `ComputeResponseWire` from `../sidecar/sidecarProtocol` for the `compute` type. Widen `AssembleEnvelopeDeps.sidecar` to `Pick<SidecarSupervisor, "compute" | "persistCandles">` (unchanged) — `compute` now accepts the optional 4th arg (Task 5).

- [ ] **Step 4: Fix the existing `compute` call-count assertions**

The existing "assembles the widened algo_results" test asserts `sidecar.compute).toHaveBeenCalledWith("NSE:INFY", "day", [104, 107])`. Update it to allow the forwarded (here `undefined`) 4th arg:
```typescript
expect(sidecar.compute).toHaveBeenCalledWith("NSE:INFY", "day", [104, 107], undefined);
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run test/main/services/analysis/analysisEnvelope.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(phase9a): bound Kite fetch and sidecar compute in assembleEnvelope with labeled timeouts"
```

---

### Task 7: Shared stream-json consumer + trace-detail summarizer

**Files:**
- Create: `src/main/services/claude/streamJsonConsumer.ts`
- Create: `src/main/services/claude/traceDetail.ts`
- Create: `test/main/services/claude/streamJsonConsumer.test.ts`
- Create: `test/main/services/claude/traceDetail.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (pure primitives).
- Produces (relied on by Tasks 8, 9):
  ```typescript
  // traceDetail.ts
  export const TRACE_DETAIL_MAX = 200;
  export function summarizeForTrace(text: string, max?: number): string;
  // streamJsonConsumer.ts
  export interface StreamCallbacks {
    onToken?: (text: string) => void;
    onToolCall?: (name: string, input: unknown) => void;
    onToolResult?: (name: string, resultText: string) => void;
    onResult: (finalText: string) => void;
    onFailure: (error: Error) => void;
  }
  export function consumeStreamJson(child: { stdout: NodeJS.ReadableStream | null; on(event: string, cb: (...a: never[]) => void): unknown }, callbacks: StreamCallbacks): void;
  ```

- [ ] **Step 1: Write the failing `traceDetail` test**

Create `test/main/services/claude/traceDetail.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { TRACE_DETAIL_MAX, summarizeForTrace } from "../../../../src/main/services/claude/traceDetail";

describe("summarizeForTrace", () => {
  it("caps at 200 chars by default", () => { expect(TRACE_DETAIL_MAX).toBe(200); });
  it("collapses whitespace runs to a single space and trims", () => {
    expect(summarizeForTrace("  a\n\t  b   c  ")).toBe("a b c");
  });
  it("returns short text unchanged", () => { expect(summarizeForTrace("hello")).toBe("hello"); });
  it("truncates with an explicit suffix naming the full length", () => {
    const raw = "x".repeat(250);
    expect(summarizeForTrace(raw)).toBe(`${"x".repeat(200)}… (truncated, 250 chars)`);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/main/services/claude/traceDetail.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `traceDetail.ts`**

```typescript
export const TRACE_DETAIL_MAX = 200;

export function summarizeForTrace(text: string, max = TRACE_DETAIL_MAX): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max)}… (truncated, ${collapsed.length} chars)`;
}
```
(The whitespace collapse happens before the length check, so the reported length is the collapsed length — matching the test's 250.)

- [ ] **Step 4: Write the failing consumer test**

Create `test/main/services/claude/streamJsonConsumer.test.ts`:
```typescript
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { consumeStreamJson, type StreamCallbacks } from "../../../../src/main/services/claude/streamJsonConsumer";

class FakeChild extends EventEmitter { stdout = new PassThrough(); }

function collect() {
  const calls: string[] = [];
  const cbs: StreamCallbacks = {
    onToken: (t) => calls.push(`token:${t}`),
    onToolCall: (n, i) => calls.push(`toolCall:${n}:${JSON.stringify(i)}`),
    onToolResult: (n, r) => calls.push(`toolResult:${n}:${r}`),
    onResult: (f) => calls.push(`result:${f}`),
    onFailure: (e) => calls.push(`failure:${e.message}`),
  };
  return { calls, cbs };
}

describe("consumeStreamJson", () => {
  it("emits token, tool_use, tool_result (correlated by id), then the terminal result in order", async () => {
    const child = new FakeChild();
    const { calls, cbs } = collect();
    consumeStreamJson(child as never, cbs);
    child.stdout.write(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi " } } })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "search_instruments", input: { query: "infy" } }] } })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "NSE:INFY 408065" }] } } ] } })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "done text" })}\n`);
    child.emit("exit", 0, null);
    expect(calls).toEqual([
      "token:hi ",
      'toolCall:search_instruments:{"query":"infy"}',
      "toolResult:search_instruments:NSE:INFY 408065",
      "result:done text",
    ]);
  });

  it("falls back to tool_use_id when no correlating name was seen", () => {
    const child = new FakeChild();
    const { calls, cbs } = collect();
    consumeStreamJson(child as never, cbs);
    child.stdout.write(`${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_9", content: "raw" }] } })}\n`);
    expect(calls).toContain("toolResult:tu_9:raw");
  });

  it("fails on a non-success terminal result and on a non-zero exit", () => {
    const child = new FakeChild();
    const { calls, cbs } = collect();
    consumeStreamJson(child as never, cbs);
    child.stdout.write(`${JSON.stringify({ type: "result", subtype: "error_max_turns" })}\n`);
    expect(calls.some((c) => c.startsWith("failure:"))).toBe(true);
  });
});
```
(Note: the tool_result JSON in the first test has a deliberately nested content array; ensure valid JSON when transcribing.)

- [ ] **Step 5: Run to verify failure**

Run: `npx vitest run test/main/services/claude/streamJsonConsumer.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 6: Implement `streamJsonConsumer.ts`**

Generalize the existing `streamingNarrative.ts:82-132` line handling; add tool_use / tool_result parsing and an id→name correlation map:
```typescript
interface ContentBlock { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; text?: string; }
interface StreamLine {
  type: string;
  subtype?: string;
  result?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  message?: { content?: ContentBlock[] };
}

export interface StreamCallbacks {
  onToken?: (text: string) => void;
  onToolCall?: (name: string, input: unknown) => void;
  onToolResult?: (name: string, resultText: string) => void;
  onResult: (finalText: string) => void;
  onFailure: (error: Error) => void;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === "object" && typeof (b as ContentBlock).text === "string" ? (b as ContentBlock).text : "")).join("");
  }
  return JSON.stringify(content ?? "");
}

export function consumeStreamJson(
  child: { stdout: NodeJS.ReadableStream | null; on(event: "error" | "exit", cb: (...args: never[]) => void): unknown },
  callbacks: StreamCallbacks,
): void {
  let buffer = "";
  let finalText: string | undefined;
  const toolNamesById = new Map<string, string>();

  const handleLine = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    let line: StreamLine;
    try { line = JSON.parse(trimmed) as StreamLine; }
    catch (error) { console.error(`stream-json: failed to parse line: ${(error as Error).message}`, trimmed); return; }

    if (line.type === "stream_event" && line.event?.type === "content_block_delta" && line.event.delta?.type === "text_delta" && typeof line.event.delta.text === "string") {
      try { callbacks.onToken?.(line.event.delta.text); } catch (error) { console.error(`stream-json: onToken threw: ${(error as Error).message}`); }
      return;
    }
    if (line.type === "assistant" && Array.isArray(line.message?.content)) {
      for (const block of line.message!.content!) {
        if (block.type === "tool_use" && typeof block.name === "string") {
          if (typeof block.id === "string") toolNamesById.set(block.id, block.name);
          try { callbacks.onToolCall?.(block.name, block.input); } catch (error) { console.error(`stream-json: onToolCall threw: ${(error as Error).message}`); }
        }
      }
      return;
    }
    if (line.type === "user" && Array.isArray(line.message?.content)) {
      for (const block of line.message!.content!) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const name = toolNamesById.get(block.tool_use_id) ?? block.tool_use_id;
          try { callbacks.onToolResult?.(name, toolResultText(block.content)); } catch (error) { console.error(`stream-json: onToolResult threw: ${(error as Error).message}`); }
        }
      }
      return;
    }
    if (line.type === "result") {
      if (line.subtype === "success" && typeof line.result === "string") finalText = line.result;
      else callbacks.onFailure(new Error(`result was not successful: ${line.subtype ?? "unknown"}`));
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline !== -1) { handleLine(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\n"); }
  });
  child.on("error", ((error: Error) => callbacks.onFailure(error)) as never);
  child.on("exit", ((code: number | null) => {
    if (buffer.trim().length > 0) handleLine(buffer);
    if (code !== 0 && code !== null) { callbacks.onFailure(new Error(`claude exited with code ${code}`)); return; }
    if (finalText === undefined) { callbacks.onFailure(new Error("stream ended without a terminal result")); return; }
    callbacks.onResult(finalText);
  }) as never);
}
```

- [ ] **Step 7: Run both tests + typecheck**

Run: `npx vitest run test/main/services/claude/streamJsonConsumer.test.ts test/main/services/claude/traceDetail.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(phase9a): shared stream-json consumer and trace-detail summarizer"
```

---

### Task 8: Structured runner rewrite + trace emission

**Files:**
- Modify: `src/main/services/claude/claudeCliProvider.ts` (`PersonaRunSpec.onTrace?`; rewrite `makeClaudeRunner` to drive the shared consumer over `stream-json`; emit `started`/`toolCall`/`toolResult`/`done`/`error`)
- Modify: `test/main/services/claude/claudeCliProvider.test.ts`
- Modify: `test/main/ipc/aiAssisted.integration.test.ts`, `test/main/ipc/sessionContinuity.integration.test.ts` (scripted spawns now emit stream-json for structured personas)

**Interfaces:**
- Consumes: `consumeStreamJson`/`StreamCallbacks` (Task 7), `summarizeForTrace`/`TRACE_DETAIL_MAX` (Task 7), `TraceEmitter` (Task 1), `spec.timeoutMs` (Task 3).
- Produces (relied on by Task 10):
  ```typescript
  export interface PersonaRunSpec<T> { /* ...Task 3 fields... */ onTrace?: TraceEmitter; }
  ```
  Runner emits per call: exactly one `{ source: spec.name, kind: "started" }` (at first spawn, not on retry); `{ kind: "toolCall", detail: `${name} ${summarizeForTrace(JSON.stringify(input ?? {}))}` }` per tool call; `{ kind: "toolResult", detail: `${name} → ${summarizeForTrace(resultText)}` }` per tool result; exactly one terminal `{ kind: "done" }` XOR `{ kind: "error", detail: message }` (error emitted before reject; structured personas emit no `token`).

- [ ] **Step 1: Write the failing runner trace tests**

In `claudeCliProvider.test.ts`, update `emitResult` to a stream-json emitter and add trace-emission tests. Replace the buffered `emitResult` with:
```typescript
function emitStructured(child: FakeChild, structuredOutput: unknown, exitCode = 0) {
  queueMicrotask(() => {
    child.stdout.write(`${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "search_instruments", input: { q: "infy" } }] } })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "NSE:INFY" }] } })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: JSON.stringify(structuredOutput) })}\n`);
    child.emit("exit", exitCode, null);
  });
}
```
Point the existing `makeClaudeRunner` tests at `emitStructured` instead of `emitResult`. Add:
```typescript
it("emits exactly one started, the tool events, and one done for a first-try success (no token)", async () => {
  const events: Array<{ source: string; kind: string; detail?: string }> = [];
  const spawnFn = () => { const c = new FakeChild(); emitStructured(c, validFinding); return c as never; };
  await makeClaudeRunner({ spawnFn })({ ...baseSpec(), onTrace: (e) => events.push(e) });
  expect(events.map((e) => e.kind)).toEqual(["started", "toolCall", "toolResult", "done"]);
  expect(events[1].detail).toBe(`search_instruments ${JSON.stringify({ q: "infy" })}`);
  expect(events[2].detail).toBe("search_instruments → NSE:INFY");
  expect(events.every((e) => e.source === "technical_quant")).toBe(true);
  expect(events.some((e) => e.kind === "token")).toBe(false);
});

it("emits a single started across a corrective retry and one done", async () => {
  const events: string[] = [];
  let n = 0;
  const spawnFn = () => { const c = new FakeChild(); emitStructured(c, ++n === 1 ? { direction: "buy" } : validFinding); return c as never; };
  await makeClaudeRunner({ spawnFn })({ ...baseSpec(), onTrace: (e) => events.push(e.kind) });
  expect(events.filter((k) => k === "started")).toHaveLength(1);
  expect(events.filter((k) => k === "done")).toHaveLength(1);
});

it("emits started then error (no done) on timeout, with the same message it rejects with", async () => {
  const events: Array<{ kind: string; detail?: string }> = [];
  const spawnFn = () => new FakeChild() as never; // never emits
  const run = makeClaudeRunner({ spawnFn });
  await expect(run({ ...baseSpec(), timeoutMs: 15, onTrace: (e) => events.push(e) }))
    .rejects.toThrow(/persona technical_quant timed out after 15ms/);
  expect(events.map((e) => e.kind)).toEqual(["started", "error"]);
  expect(events[1].detail).toBe("persona technical_quant timed out after 15ms");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/main/services/claude/claudeCliProvider.test.ts`
Expected: FAIL — runner still buffered `json`; no trace emission; `onTrace` not on spec type.

- [ ] **Step 3: Rewrite `makeClaudeRunner`**

Add `onTrace?: TraceEmitter` to `PersonaRunSpec`. Import `consumeStreamJson`, `summarizeForTrace`, and `TraceEmitter`. Replace `readResult`-based `attempt` with a stream-json consumer that resolves the parsed structured object, and wrap the two-attempt logic with a single `started` at the top and terminal `done`/`error`:
```typescript
export function makeClaudeRunner(options: ClaudeRunnerOptions = {}): PersonaRunner {
  const spawnFn = options.spawnFn ?? ((command, args) => spawn(command, args));

  return async <T>(spec: PersonaRunSpec<T>): Promise<T> => {
    const emit = spec.onTrace;
    const attempt = async (prompt: string): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
      if (spec.signal?.aborted) throw new Error(`persona ${spec.name} aborted`);
      const child = spawnClaude(prompt, {
        systemPrompt: spec.systemPrompt,
        jsonSchema: JSON.stringify(spec.jsonSchema),
        outputFormat: "stream-json",
        includePartialMessages: true,
        allowWebTools: spec.allowWebTools,
      }, spawnFn);

      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      const raw = await new Promise<string>((resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`persona ${spec.name} timed out after ${spec.timeoutMs}ms`)); child.kill(); }, spec.timeoutMs);
        onAbort = () => { reject(new Error(`persona ${spec.name} aborted`)); child.kill(); };
        spec.signal?.addEventListener("abort", onAbort);
        consumeStreamJson(child, {
          onToolCall: (name, input) => emit?.({ source: spec.name, kind: "toolCall", detail: `${name} ${summarizeForTrace(JSON.stringify(input ?? {}))}` }),
          onToolResult: (name, resultText) => emit?.({ source: spec.name, kind: "toolResult", detail: `${name} → ${summarizeForTrace(resultText)}` }),
          onResult: (finalText) => resolve(finalText),
          onFailure: (error) => reject(error),
        });
      }).finally(() => {
        if (timer) clearTimeout(timer);
        if (onAbort) spec.signal?.removeEventListener("abort", onAbort);
      });

      let parsedJson: unknown;
      try { parsedJson = JSON.parse(raw); } catch { parsedJson = undefined; }
      const parsed = spec.schema.safeParse(parsedJson);
      if (parsed.success) return { ok: true, value: parsed.data };
      return { ok: false, error: parsed.error.message };
    };

    emit?.({ source: spec.name, kind: "started" });
    try {
      const first = await attempt(spec.prompt);
      if (first.ok) { emit?.({ source: spec.name, kind: "done" }); return first.value; }
      const corrective = `${spec.prompt}\n\nYour previous reply did not match the required JSON schema (${first.error}). Reply with only a JSON object conforming to it.`;
      const second = await attempt(corrective);
      if (second.ok) { emit?.({ source: spec.name, kind: "done" }); return second.value; }
      throw new Error(`persona ${spec.name} failed to produce valid structured output after retry`);
    } catch (error) {
      emit?.({ source: spec.name, kind: "error", detail: (error as Error).message });
      throw error;
    }
  };
}
```
Behavior preserved: two attempts (first + one corrective retry on schema failure); timeout/abort throws immediately (the guard rejects, escaping the attempt loop into the `catch`, which emits `error` once and rethrows). No `token` for structured personas.

**Verification item (report on this):** whether the `--json-schema` structured output arrives as the terminal `result` *string* (parsed here via `JSON.parse(raw)`) or as a distinct field on the result line. This code assumes the result-string form. Probe the installed CLI during implementation (e.g. run one intake spawn with `--output-format stream-json --json-schema …` and inspect the terminal line). If it is a field, extend `StreamCallbacks.onResult` to receive the raw terminal line and prefer the field before falling back to parsing the string. Note the outcome in your task report.

- [ ] **Step 4: Update the integration scripted spawns**

`aiAssisted.integration.test.ts` and `sessionContinuity.integration.test.ts`: the structured-persona branch of `scriptedSpawn`/`makeScriptedSpawn` currently writes a buffered `{ result, structured_output }` blob. Change it to a stream-json terminal line whose `result` is the JSON string, e.g. replace the else-branch with:
```typescript
child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: JSON.stringify(structured) })}\n`);
child.emit("exit", 0, null);
```
In `sessionContinuity.integration.test.ts`, distinguishing narrative from structured personas can no longer key on `stream-json` (all six now stream). Key on the presence of `--json-schema` instead (structured personas pass it; narrative does not): push into `jsonArgvs` when `args.includes("--json-schema")`, else `streamArgvs`. Keep the existing `--session-id`/`--resume` assertions.

- [ ] **Step 5: Run the affected suites + typecheck**

Run: `npx vitest run test/main/services/claude/claudeCliProvider.test.ts test/main/ipc/aiAssisted.integration.test.ts test/main/ipc/sessionContinuity.integration.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(phase9a): stream-json structured runner emitting started/tool/done/error trace events"
```

---

### Task 9: Narrative streamer rewrite (consumer + `onTrace`)

**Files:**
- Modify: `src/main/services/claude/streamingNarrative.ts` (`onToken` → `onTrace`; drive the shared consumer; emit `started`/`token`/`toolCall`/`toolResult`/`done`/`error`)
- Modify: `test/main/services/claude/streamingNarrative.test.ts`

**Interfaces:**
- Consumes: `consumeStreamJson`/`StreamCallbacks` (Task 7), `summarizeForTrace` (Task 7), `TraceEmitter` (Task 1), `spec.timeoutMs` (Task 3).
- Produces (relied on by Task 10):
  ```typescript
  export interface NarrativeStreamSpec {
    systemPrompt: string;
    prompt: string;
    onTrace: TraceEmitter;   // replaces onToken
    timeoutMs: number;
    signal?: AbortSignal;
    claudeSessionId?: string;
    resumeSession?: boolean;
  }
  ```
  Still returns the concatenated final text. Emits `source:"narrative"`: one `started` (at spawn), one `token` per `text_delta` (detail = the literal chunk, uncapped), `toolCall`/`toolResult` (summarized), one terminal `done` (success) XOR `error` (failure, before reject).

- [ ] **Step 1: Write the failing tests**

Rewrite `streamingNarrative.test.ts`'s `baseSpec` to carry `onTrace` + `timeoutMs`:
```typescript
const baseSpec = (onTrace: (e: { source: string; kind: string; detail?: string }) => void) =>
  ({ systemPrompt: "sys", prompt: "explain", onTrace, timeoutMs: 180000 });
```
Add:
```typescript
it("emits started, a token per delta, and done on success, and returns the final text", async () => {
  const events: Array<{ kind: string; detail?: string }> = [];
  const child = new FakeChild();
  const run = makeNarrativeStreamer({ spawnFn: () => child as never });
  const pending = run(baseSpec((e) => events.push(e)));
  child.stdout.write(`${delta("Bank")}\n${delta(" Nifty")}\n`);
  child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "Bank Nifty" })}\n`);
  child.emit("exit", 0, null);
  await expect(pending).resolves.toBe("Bank Nifty");
  expect(events.map((e) => e.kind)).toEqual(["started", "token", "token", "done"]);
  expect(events.filter((e) => e.kind === "token").map((e) => e.detail)).toEqual(["Bank", " Nifty"]);
});

it("emits started then error (before reject) on a non-zero exit", async () => {
  const events: Array<{ kind: string; detail?: string }> = [];
  const child = new FakeChild();
  const pending = makeNarrativeStreamer({ spawnFn: () => child as never })(baseSpec((e) => events.push(e)));
  child.emit("exit", 1, null);
  await expect(pending).rejects.toThrow(/exited with code 1/);
  expect(events[0].kind).toBe("started");
  expect(events.at(-1)).toMatchObject({ kind: "error" });
});
```
Update the remaining existing narrative tests to read tokens from `onTrace` `token` events instead of `onToken`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/main/services/claude/streamingNarrative.test.ts`
Expected: FAIL — `onToken` gone / no trace emission.

- [ ] **Step 3: Rewrite `streamingNarrative.ts`**

Replace `onToken` with `onTrace: TraceEmitter`; import `consumeStreamJson`, `summarizeForTrace`, `TraceEmitter`; delete the inline `handleLine` and drive the consumer; emit `started` at spawn and map consumer callbacks to trace events; keep the reject-before-kill discipline and the `settled` guard:
```typescript
return (spec: NarrativeStreamSpec): Promise<string> => {
  if (spec.signal?.aborted) return Promise.reject(new Error("narrative aborted"));
  const child = spawnClaude(spec.prompt, {
    systemPrompt: spec.systemPrompt,
    outputFormat: "stream-json",
    includePartialMessages: true,
    claudeSessionId: spec.claudeSessionId,
    resumeSession: spec.resumeSession,
  }, spawnFn);

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const cleanup = (): void => { if (timer) clearTimeout(timer); if (onAbort) spec.signal?.removeEventListener("abort", onAbort); };
    const fail = (error: Error): void => {
      if (settled) return; settled = true; cleanup();
      spec.onTrace({ source: "narrative", kind: "error", detail: error.message });
      reject(error); child.kill();
    };
    const succeed = (text: string): void => {
      if (settled) return; settled = true; cleanup();
      spec.onTrace({ source: "narrative", kind: "done" });
      resolve(text);
    };

    spec.onTrace({ source: "narrative", kind: "started" });
    timer = setTimeout(() => fail(new Error(`narrative timed out after ${spec.timeoutMs}ms`)), spec.timeoutMs);
    onAbort = () => fail(new Error("narrative aborted"));
    spec.signal?.addEventListener("abort", onAbort);

    consumeStreamJson(child, {
      onToken: (text) => { if (!settled) spec.onTrace({ source: "narrative", kind: "token", detail: text }); },
      onToolCall: (name, input) => spec.onTrace({ source: "narrative", kind: "toolCall", detail: `${name} ${summarizeForTrace(JSON.stringify(input ?? {}))}` }),
      onToolResult: (name, resultText) => spec.onTrace({ source: "narrative", kind: "toolResult", detail: `${name} → ${summarizeForTrace(resultText)}` }),
      onResult: (finalText) => succeed(finalText),
      onFailure: (error) => fail(error),
    });
  });
};
```
(The `error` emission lives inside `fail`, so it fires exactly once before the reject regardless of the failure source — timeout, abort, non-zero exit, missing terminal, or parse-fatal.)

- [ ] **Step 4: Update `ClaudeCliProvider.completeAiAssisted`'s streamNarrative spec**

In `claudeCliProvider.ts`, the `this.streamNarrative({...})` call currently passes `onToken: opts.onNarrativeToken`. Leave a temporary `onTrace` shim here that will be finalized in Task 10; for now pass `onTrace: (e) => { if (e.kind === "token" && e.detail !== undefined) opts.onNarrativeToken(e.detail); }` and `timeoutMs: PERSONA_TIMEOUTS_MS.narrative`. (Task 10 replaces this with `onTrace: opts.onTrace`.)

- [ ] **Step 5: Run the affected suites + typecheck**

Run: `npx vitest run test/main/services/claude/streamingNarrative.test.ts test/main/services/claude/claudeCliProvider.test.ts test/main/ipc/aiAssisted.integration.test.ts && npx tsc --noEmit`
Expected: PASS (the narrative-token shim keeps `onNarrativeToken` working end-to-end).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(phase9a): narrative streamer drives shared consumer and emits onTrace events"
```

---

### Task 10: Thread `onTrace`/`timeoutMs` through provider, pipeline, intake, and scan

**Files:**
- Modify: `src/main/services/claude/provider.ts` (`CompleteAiAssistedOptions.onNarrativeToken` → `onTrace: TraceEmitter`; `intake(query, opts?)`)
- Modify: `src/main/services/claude/claudeCliProvider.ts` (`intake(query, opts)`; forward `onTrace` to pipeline + narrative)
- Modify: `src/main/services/claude/personaPipeline.ts` (`PipelineRunOptions.onTrace`; set `onTrace` on each analytical + synthesis spec)
- Modify: `src/main/services/claude/intake.ts` (`runIntake(deps, query, { onTrace? })`; set spec `onTrace`)
- Modify: `src/main/ipc/analysisBridge.ts` (pass `onTrace: emit` to `completeAiAssisted`; `intake(query, { onTrace: emit })`)
- Modify: `src/main/scanScheduler.ts` (`onNarrativeToken: () => {}` → `onTrace: () => {}`)
- Modify: `test/main/services/claude/claudeCliProvider.test.ts`, `intake.test.ts`, `personaPipeline.test.ts`, `test/main/ipc/analysisBridge.test.ts`, `aiAssisted.integration.test.ts`

**Interfaces:**
- Consumes: `TraceEmitter` (Task 1); runner `onTrace` (Task 8); narrative `onTrace` (Task 9).
- Produces (relied on by Task 12):
  ```typescript
  export interface CompleteAiAssistedOptions {
    researchNotes?: string;
    onTrace: TraceEmitter;     // replaces onNarrativeToken
    signal?: AbortSignal;
    claudeSessionId: string;
    resumeSession: boolean;
  }
  export interface AiAssistedProvider {
    intake(query: string, opts?: { onTrace?: TraceEmitter }): Promise<IntakeResult>;
    completeAiAssisted(envelope: AnalysisEnvelope, opts: CompleteAiAssistedOptions): Promise<AiAssistedResult>;
  }
  export interface PipelineRunOptions { researchNotes?: string; onTrace?: TraceEmitter; }
  export interface RunIntakeDeps { runPersona: PersonaRunner; }
  export function runIntake(deps: RunIntakeDeps, query: string, opts?: { onTrace?: TraceEmitter }): Promise<IntakeResult>;
  ```

- [ ] **Step 1: Write the failing provider-threading tests**

In `claudeCliProvider.test.ts`, update the `completeAiAssisted` tests to pass `onTrace` and assert forwarding. Replace `onNarrativeToken` usages with an `onTrace` spy and assert both a persona `started` and narrative `token` reach it:
```typescript
it("forwards onTrace to every persona and to the narrative streamer", async () => {
  const verdictOut = { direction: "bullish", conviction: "high", reasoning: "rsi", cited_algo_ids: ["rsi"], verify_before_acting: "check LTP" };
  const spawnFn = (_c: string, args: string[]) => {
    const child = new FakeChild();
    if (!args.includes("--json-schema")) { // narrative
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Infy " } } })}\n`);
        child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "Infy." })}\n`);
        child.emit("exit", 0, null);
      });
    } else {
      emitStructured(child, args.some((a) => a.includes("synthesis")) ? verdictOut : validFinding);
    }
    return child as never;
  };
  const events: Array<{ source: string; kind: string }> = [];
  await new ClaudeCliProvider({ spawnFn }).completeAiAssisted(aiEnvelope, {
    onTrace: (e) => events.push(e), claudeSessionId: "u", resumeSession: false,
  });
  expect(events.some((e) => e.source === "technical_quant" && e.kind === "started")).toBe(true);
  expect(events.some((e) => e.source === "synthesis" && e.kind === "done")).toBe(true);
  expect(events.some((e) => e.source === "narrative" && e.kind === "token")).toBe(true);
});
```
In `intake.test.ts`, add a test that `runIntake` passes `onTrace` onto the spec:
```typescript
it("threads onTrace onto the intake spec", async () => {
  let captured: PersonaRunSpec<unknown> | undefined;
  const runPersona: PersonaRunner = vi.fn(async (spec) => { captured = spec; return validIntake as never; });
  const onTrace = vi.fn();
  await runIntake({ runPersona }, "q", { onTrace });
  expect(captured?.onTrace).toBe(onTrace);
});
```
In `personaPipeline.test.ts`, add a test that `PipelineRunOptions.onTrace` lands on every analytical + synthesis spec:
```typescript
it("sets onTrace on all analytical specs and the synthesis spec", async () => {
  const seen: Record<string, unknown> = {};
  const onTrace = vi.fn();
  const runPersona: PersonaRunner = async (spec) => { seen[spec.name] = spec.onTrace; return (spec.name === "synthesis" ? verdict : finding(spec.name as PersonaFinding["persona"])) as never; };
  await runPersonaPipeline(envelope, { runPersona, prompts }, { onTrace });
  expect(seen.options_greeks).toBe(onTrace);
  expect(seen.technical_quant).toBe(onTrace);
  expect(seen.position_risk).toBe(onTrace);
  expect(seen.synthesis).toBe(onTrace);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/main/services/claude/claudeCliProvider.test.ts test/main/services/claude/intake.test.ts test/main/services/claude/personaPipeline.test.ts`
Expected: FAIL — `onTrace` not accepted / not threaded.

- [ ] **Step 3: Implement the threading**

`provider.ts`: replace `onNarrativeToken` with `onTrace: TraceEmitter` in `CompleteAiAssistedOptions` (import `TraceEmitter` from `../../ipc/rendererApi`); change `intake` signature to `intake(query: string, opts?: { onTrace?: TraceEmitter }): Promise<IntakeResult>`.
`personaPipeline.ts`: add `onTrace?: TraceEmitter` to `PipelineRunOptions`; set `onTrace: opts.onTrace` on each analytical spec and the synthesis spec.
`intake.ts`: add the optional `opts` param and set `onTrace: opts?.onTrace` on the spec.
`claudeCliProvider.ts`: `intake(query, opts)` forwards `{ onTrace: opts?.onTrace }` into `runIntake`; `completeAiAssisted` passes `{ ...prompts, onTrace: opts.onTrace }` into `runPersonaPipeline` and replaces the Task 9 narrative shim with `onTrace: opts.onTrace` on the `streamNarrative` spec.
`analysisBridge.ts`: change the `completeAiAssisted` call to `onTrace: emit` (drop the `onNarrativeToken` inline) and change `deps.provider.intake(params.query)` to `deps.provider.intake(params.query, { onTrace: emit })`.
`scanScheduler.ts`: change `onNarrativeToken: () => {}` to `onTrace: () => {}`.

- [ ] **Step 4: Update remaining affected tests**

`analysisBridge.test.ts`: the `fakeProvider` `completeAiAssisted` mock uses `opts.onNarrativeToken(...)` — change it to emit via `opts.onTrace`:
```typescript
completeAiAssisted: vi.fn(async (_env, opts) => {
  opts.onTrace({ source: "narrative", kind: "token", detail: "Infy " });
  opts.onTrace({ source: "narrative", kind: "token", detail: "is constructive." });
  return { verdict: { direction: "bullish", conviction: "high", reasoning: "rsi", cited_algo_ids: ["rsi"], verify_before_acting: "check LTP" }, narrative: "Infy is constructive." };
}),
```
(the `sends`/emit assertions from Task 1 still hold: emitter stamps `requestId` + `at`, plus the analysisBridge run-level `done`). `aiAssisted.integration.test.ts` needs no further change — its narrative-subset assertion (Task 1) remains valid.

- [ ] **Step 5: Run the claude + bridge + scan suites + typecheck**

Run: `npx vitest run test/main/services/claude test/main/ipc/analysisBridge.test.ts test/main/ipc/aiAssisted.integration.test.ts test/main/scanScheduler.test.ts test/main/scanScheduler.integration.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(phase9a): thread onTrace through provider, pipeline, intake, and scan scheduler"
```

---

### Task 11: Trace persistence + idempotent migration

**Files:**
- Modify: `src/main/services/history/historyStore.ts` (`trace` column in CREATE; `ensureColumn` migration; `AppendMessageParams.trace`; `HistoryMessage.trace`; insert/select mapping)
- Modify: `test/main/services/history/historyStore.test.ts`

**Interfaces:**
- Consumes: `TraceEvent` (Task 1).
- Produces (relied on by Task 12):
  ```typescript
  export interface AppendMessageParams { /* ... */ trace?: TraceEvent[]; }
  export interface HistoryMessage { /* ... */ trace: TraceEvent[] | null; }
  ```

- [ ] **Step 1: Write the failing persistence + migration tests**

In `historyStore.test.ts`, add:
```typescript
import Database from "better-sqlite3";
import type { TraceEvent } from "../../../../src/main/ipc/rendererApi";

const trace: TraceEvent[] = [
  { requestId: "r1", source: "intake", kind: "started", at: "2026-07-29T00:00:00.000Z" },
  { requestId: "r1", source: "narrative", kind: "done", at: "2026-07-29T00:00:01.000Z" },
];

it("round-trips a trace array and reads a trace-less message back as null", () => {
  const store = memoryStore();
  const session = store.createSession("ai_assisted");
  store.appendMessage({ sessionId: session.id, role: "user", renderedText: "q" });
  store.appendMessage({ sessionId: session.id, role: "assistant", renderedText: "a", trace });
  const msgs = store.getSession(session.id)!.messages;
  expect(msgs[0].trace).toBeNull();
  expect(msgs[1].trace).toEqual(trace);
  store.close();
});

it("adds the trace column via ALTER on a pre-existing messages table (old install)", () => {
  const dbPath = tempDbPath();
  // Simulate an old install: create the messages table WITHOUT a trace column.
  const legacy = new Database(dbPath);
  legacy.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, response_mode TEXT NOT NULL, claude_session_id TEXT, created_at TEXT NOT NULL, last_active_at TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL, rendered_text TEXT NOT NULL, structured_payload TEXT, created_at TEXT NOT NULL);`);
  legacy.prepare("INSERT INTO sessions (id, response_mode, created_at, last_active_at) VALUES (?, 'ai_assisted', 't', 't')").run("s-old");
  legacy.prepare("INSERT INTO messages (id, session_id, role, rendered_text, created_at) VALUES (?, 's-old', 'assistant', 'old', 't')").run("m-old");
  legacy.close();

  const store = new HistoryStore({ path: dbPath, now: monotonicNow() });
  const cols = (store as unknown as { db: Database.Database }).db ? null : null; // trace column presence proven via round-trip below
  expect(store.getSession("s-old")!.messages[0].trace).toBeNull(); // back-filled NULL, no throw
  store.appendMessage({ sessionId: "s-old", role: "assistant", renderedText: "new", trace });
  expect(store.getSession("s-old")!.messages[1].trace).toEqual(trace);
  store.close();

  // Constructing twice against the same file must not throw (idempotent guard).
  const again = new HistoryStore({ path: dbPath, now: monotonicNow() });
  expect(again.getSession("s-old")!.messages).toHaveLength(2);
  again.close();
});
```
(Delete the unused `cols` line if your linter objects; it is illustrative only — the round-trip is the real assertion.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/main/services/history/historyStore.test.ts`
Expected: FAIL — `trace` unknown on params/message; old-install ALTER missing.

- [ ] **Step 3: Implement the schema, migration, and mapping**

In `historyStore.ts`: import `TraceEvent` from `../../ipc/rendererApi`. Add `trace: TraceEvent[] | null` to `HistoryMessage` and `trace?: TraceEvent[]` to `AppendMessageParams`. Add `trace TEXT` to the `CREATE TABLE IF NOT EXISTS messages (...)` block (covers fresh installs). Add the guarded helper and call it in the constructor after the `db.exec(CREATE ...)` block, before preparing statements:
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
Extend `insertMessage` and `appendMessageTxn`:
```typescript
const insertMessage = this.db.prepare(
  `INSERT INTO messages (id, session_id, role, rendered_text, structured_payload, trace, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
// in the transaction:
insertMessage.run(
  randomUUID(), params.sessionId, params.role, params.renderedText,
  params.structuredPayload === undefined ? null : JSON.stringify(params.structuredPayload),
  params.trace === undefined ? null : JSON.stringify(params.trace),
  timestamp,
);
```
Extend `getSession`'s SELECT to include `trace` and map it like `structured_payload`:
```typescript
`SELECT role, rendered_text, structured_payload, trace, created_at FROM messages
 WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`
// row type gains: trace: string | null
// mapping:
trace: row.trace === null ? null : (JSON.parse(row.trace) as TraceEvent[]),
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run test/main/services/history/historyStore.test.ts && npx tsc --noEmit`
Expected: PASS — fresh install gets `trace` via CREATE; old install via ALTER; double-construct does not throw; trace-less rows read `null`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(phase9a): persist TraceEvent[] in messages.trace with idempotent migration"
```

---

### Task 12: End-to-end wiring — emitter, accumulation, sidecar correlation, error semantics

**Files:**
- Modify: `src/main/ipc/analysisBridge.ts` (finalize `emit` with accumulation; sidecar `"progress"` listener + `ownedSidecarIds`; pass `onComputeId`/`onTrace` into `assembleEnvelope`; persist `trace`; delete the run-level narrative `done`/`error` pushes; widen `sidecar` Pick with `on`/`off`)
- Modify: `test/main/ipc/analysisBridge.test.ts`, `test/main/ipc/aiAssisted.integration.test.ts`

**Interfaces:**
- Consumes: everything — `TraceEvent`/`TraceEventInput` (Task 1), `PERSONA_TIMEOUTS_MS` indirectly (Task 3), `SidecarProgressWire` + `"progress"` event + `compute` `onRequestId` (Task 5), `assembleEnvelope`'s `onComputeId`/`onTrace` (Task 6), runner + narrative `onTrace` emission (Tasks 8, 9), provider threading (Task 10), `HistoryStore.appendMessage({ trace })` (Task 11).
- Produces (final run-time behavior):
  ```typescript
  // AiAssistedRequestDeps.sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles" | "on" | "off">
  // AnalysisBridgeDeps.sidecar likewise.
  // runAiAssistedRequest owns: traceEvents[] accumulation + emit boundary + ownedSidecarIds correlation.
  ```

- [ ] **Step 1: Write the failing wiring tests**

In `analysisBridge.test.ts`, widen the fakes and add three tests. Extend `mockSidecar`-backed deps with an `EventEmitter` so `on`/`off`/`emit("progress")` work; drive an owned compute id and an unowned one:
```typescript
import { EventEmitter } from "node:events";

function sidecarWithProgress() {
  const bus = new EventEmitter();
  const compute = vi.fn(async (_s: string, _t: string, _c: number[], onRequestId?: (id: number) => void) => {
    onRequestId?.(42);
    return computeResponse();
  });
  return Object.assign(bus, { compute, persistCandles: vi.fn(async () => ({ type: "persist_candles" as const, id: 1, written: 0 })) });
}
```
```typescript
it("maps an owned compute id's progress to sidecar started/done and ignores unowned ids", async () => {
  const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
  const sidecar = sidecarWithProgress();
  const sends: Array<{ source: string; kind: string; detail?: string }> = [];
  // emit an unowned id BEFORE the owned compute registers 42, and owned ones after
  sidecar.compute.mockImplementationOnce(async (_s, _t, _c, onRequestId?: (id: number) => void) => {
    (sidecar as unknown as EventEmitter).emit("progress", { type: "progress", id: 999, step: "compute", status: "running" }); // unowned → ignored
    onRequestId?.(42);
    (sidecar as unknown as EventEmitter).emit("progress", { type: "progress", id: 42, step: "compute", status: "running" });
    (sidecar as unknown as EventEmitter).emit("progress", { type: "progress", id: 42, step: "rsi", status: "running" });
    (sidecar as unknown as EventEmitter).emit("progress", { type: "progress", id: 42, step: "rsi", status: "done" });
    (sidecar as unknown as EventEmitter).emit("progress", { type: "progress", id: 42, step: "compute", status: "done" });
    return computeResponse();
  });
  await runAiAssistedRequest({ kite, sidecar: sidecar as never, provider: fakeProvider(), history: fakeHistory() }, aiParams, (e) => sends.push(e as never));
  const sidecarEvents = sends.filter((e) => e.source === "sidecar");
  expect(sidecarEvents).toEqual([
    { source: "sidecar", kind: "started", detail: "compute", requestId: "r7", at: expect.any(String) },
    { source: "sidecar", kind: "started", detail: "rsi", requestId: "r7", at: expect.any(String) },
    { source: "sidecar", kind: "done", detail: "rsi", requestId: "r7", at: expect.any(String) },
    { source: "sidecar", kind: "done", detail: "compute", requestId: "r7", at: expect.any(String) },
  ]);
});

it("persists the accumulated trace on success and removes the progress listener afterwards", async () => {
  const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
  const sidecar = sidecarWithProgress();
  const history = fakeHistory();
  await runAiAssistedRequest({ kite, sidecar: sidecar as never, provider: fakeProvider(), history }, aiParams, () => {});
  const assistant = history.appendMessage.mock.calls.find((c) => c[0].role === "assistant")![0];
  expect(Array.isArray(assistant.trace)).toBe(true);
  expect((sidecar as unknown as EventEmitter).listenerCount("progress")).toBe(0);
});

it("does not push a generic run-level error event; each step attributes its own", async () => {
  const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
  const provider = fakeProvider({ completeAiAssisted: vi.fn().mockRejectedValue(new Error("boom")) });
  const sends: Array<{ source: string; kind: string }> = [];
  await expect(runAiAssistedRequest({ kite, sidecar: sidecarWithProgress() as never, provider, history: fakeHistory() }, aiParams, (e) => sends.push(e as never))).rejects.toThrow(/boom/);
  // No narrative done, and no generic run-level error stamped by the bridge itself.
  expect(sends.some((e) => e.source === "narrative" && e.kind === "done")).toBe(false);
});
```
Update the earlier Task 1/Task 10 `sends` assertion for the happy path: the run-level narrative `done` push is now **deleted**; the narrative `done` comes from the provider's narrative streamer (via `fakeProvider`, which should now emit a `{source:"narrative", kind:"done"}` itself). Adjust `fakeProvider.completeAiAssisted` to emit its own `done`:
```typescript
opts.onTrace({ source: "narrative", kind: "done" });
```
so the happy-path `sends` still ends with a narrative `done` — now sourced from the provider, not the bridge.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/main/ipc/analysisBridge.test.ts`
Expected: FAIL — no correlation listener; `trace` not persisted; `on`/`off` not on the `sidecar` Pick.

- [ ] **Step 3: Finalize `runAiAssistedRequest`**

Widen `AiAssistedRequestDeps.sidecar` and `AnalysisBridgeDeps.sidecar` to `Pick<SidecarSupervisor, "compute" | "persistCandles" | "on" | "off">`. Import `SidecarProgressWire`. Rework the body per P9A§13 + §9.3 + §12:
```typescript
const traceEvents: TraceEvent[] = [];
const emit: TraceEmitter = (input) => {
  const event: TraceEvent = { requestId: params.requestId, at: (deps.now?.() ?? new Date()).toISOString(), ...input };
  traceEvents.push(event);
  sendTrace(event);
};

const ownedSidecarIds = new Set<number>();
const onProgress = (p: SidecarProgressWire): void => {
  if (!ownedSidecarIds.has(p.id)) return;
  emit({ source: "sidecar", kind: p.status === "running" ? "started" : "done", detail: p.step });
};

try {
  deps.history.appendMessage({ sessionId: params.sessionId, role: "user", renderedText: params.query, structuredPayload: params });
  const intake = await deps.provider.intake(params.query, { onTrace: emit });
  const { timeframe, from, to } = horizonToFetchParams(intake.horizon, now);

  deps.sidecar.on("progress", onProgress);
  let envelope;
  try {
    envelope = await assembleEnvelope(
      { kite: deps.kite, sidecar: deps.sidecar },
      { trigger: "reactive", instrument: intake.instrument, timeframe, horizon_requested: intake.horizon, intent_lens: params.intent_lens, from, to,
        onComputeId: (id) => ownedSidecarIds.add(id), onTrace: emit },
    );
  } finally {
    deps.sidecar.off("progress", onProgress);
    ownedSidecarIds.clear();
  }

  const existingClaudeSessionId = deps.history.getClaudeSessionId(params.sessionId);
  const claudeSessionId = existingClaudeSessionId ?? randomUUID();
  const { verdict, narrative } = await deps.provider.completeAiAssisted(envelope, {
    researchNotes: intake.researchNotes, onTrace: emit, claudeSessionId, resumeSession: existingClaudeSessionId !== null,
  });
  if (existingClaudeSessionId === null) deps.history.setClaudeSessionId(params.sessionId, claudeSessionId);

  const result: AnalysisResult = { mode: "ai_assisted", instrument: envelope.instrument, horizon: intake.horizon, intent_lens: params.intent_lens, verdict, narrative, algo_results: envelope.algo_results, confluence: envelope.confluence };
  deps.history.appendMessage({ sessionId: params.sessionId, role: "assistant", renderedText: narrative, structuredPayload: result, trace: traceEvents });
  return result;
} catch (error) {
  throw error; // no generic run-level error push; each step with a TraceSource already emitted its own
}
```
Delete the interim narrative `done`/`error` pushes and the `onNarrativeToken` inline from Tasks 1/10. The `finally` around `assembleEnvelope` guarantees a late Rust `done` after a compute timeout is dropped (P9A§9.3). The `catch` now only rethrows (P9A§12): the Kite-fetch timeout rejects with no trace (no `"kite"` source); the sidecar-compute timeout emitted its own `error` in `assembleEnvelope` (Task 6); persona/narrative failures emitted their own `error` in the runner/streamer (Tasks 8, 9).

- [ ] **Step 4: Update the integration test to assert the full multi-source stream**

In `aiAssisted.integration.test.ts`, broaden beyond the narrative subset: assert the ordered presence of `intake` `started`, an analytical persona `started`, `synthesis` `done`, `narrative` `token`, and `narrative` `done`, and that `history.appendMessage` persisted a non-empty `trace`. Keep it order-tolerant across parallel personas by asserting membership, not strict array equality, for the analytical trio.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS across the whole `test/` tree. Confirm `kiteClient.test.ts` allowlist test is green and unmodified.

- [ ] **Step 6: Full Rust + TS gate**

Run: `cd rust-core && cargo test && cd ../electron-app && npx vitest run && npx tsc --noEmit`
Expected: PASS everywhere.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(phase9a): wire end-to-end trace emitter, sidecar correlation, and persistence"
```

---

## Self-Review

**1. Spec coverage** (every P9A§ decision maps to a task):

- P9A§3 safety invariant — Global Constraints + Task 2 (only `--model` added) + Task 1..12 never touch allowlist/denylist; `kiteClient.test.ts` left unmodified.
- P9A§5 model flag — Task 2.
- P9A§6 per-persona timeouts + `PERSONA_TIMEOUTS_MS` + narrative timeout — Task 3.
- P9A§7 envelope timeouts (`withTimeout`, Kite/compute bounds, `onComputeId`/`onTrace`, no `"kite"` source) — Task 6.
- P9A§8.1 `TraceEventInput`/`TraceEmitter` — Task 1. §8.2 shared consumer — Task 7. §8.3 structured runner + emission + invariant — Task 8. §8.4 narrative streamer — Task 9. §8.5 `summarizeForTrace`/`TRACE_DETAIL_MAX` — Task 7 (consumed in Tasks 8, 9).
- P9A§9.1 Rust (`run_applicable_with_progress`, `handle_request_with_progress`, `ProgressLine`/`encode_progress`, `main.rs` bracket + closure, borrow-check verification item) — Task 4. §9.2 TS (`SidecarProgressWire`, `dispatch`, `onRequestId`) — Task 5. §9.3 correlation (`ownedSidecarIds`, listener, `detail==="compute"` vs algo id, `finally` drop) — Task 12.
- P9A§10.1 public types + `onTrace` + `onNarrative` adapter — Task 1. §10.2 detail table — realized across Tasks 8 (persona `started`/`toolCall`/`toolResult`/`done`/`error`), 9 (narrative `token`), 12 (sidecar `started`/`done` detail = step), and tested in the corresponding tasks. §10.3 channel/sender wiring (`traceBridge`, `bootstrap`, `analysisBridge` `sendNarrative`→`sendTrace`, `preload` unchanged) — Tasks 1 (channel/bootstrap/dep-rename) + 12 (final emitter).
- P9A§11 persistence + migration — Task 11.
- P9A§12 error semantics (one `error` per failing step; deleted run-level pushes; Kite fetch no trace) — Tasks 6, 8, 9 (per-step errors) + Task 12 (deleted pushes, run-level catch only rethrows).
- P9A§13 end-to-end plumbing (emit boundary, threading, scan no-op) — Tasks 10 + 12.
- P9A§14 testing strategy — item 1 (safety) Global Constraints + every task's re-verify; item 2 (model) Task 2; item 3 (timeouts) Task 3; item 4 (envelope) Task 6; item 5 (streaming+tool capture+truncation) Task 7 + 8 + 9; item 6 (runner invariant) Task 8; item 7 (sidecar progress dispatch/correlation/late-done) Tasks 5 + 12; item 8 (unified channel + detail table) Tasks 1 + 8 + 9 + 12; item 9 (persistence + migration) Task 11; item 10 (Rust) Task 4.
- P9A§15 non-goals — respected: no renderer file touched; `engine_only` untouched (its `assembleEnvelope` inherits Task 6 timeouts, passes neither `onTrace` nor `onComputeId`); no model tiering; no sidecar response-protocol change; no new dependency.
- P9A§16 file touch-points — every row is assigned: `claudeProvider.ts`→T2; `claudeCliProvider.ts`→T3,T8,T10; `streamingNarrative.ts`→T3,T9; `personaPipeline.ts`→T3,T10; `intake.ts`→T3,T10; `provider.ts`→T10; `analysisEnvelope.ts`→T6; `sidecarProtocol.ts`→T5; `sidecarSupervisor.ts`→T5; `historyStore.ts`→T11; `rendererApi.ts`→T1; `narrativeBridge.ts`→`traceBridge.ts`→T1; `analysisBridge.ts`→T1,T12; `bootstrap.ts`→T1; `scanScheduler.ts`→T10; `renderer/*` untouched; the four Rust files→T4.

**2. Placeholder scan:** no "TBD"/"add error handling"/"similar to Task N"/"write tests for the above" — every code and test step carries real code. The two explicit *verification items* (Rust borrow-check in Task 4 Step 11; stream-json structured-output shape in Task 8 Step 3) are carried verbatim from the spec's own flagged unknowns, each with a concrete fallback and a "report on this" instruction — they are not placeholders but the spec's designated implementation-time probes.

**3. Type/signature consistency:** `TraceEmitter = (event: TraceEventInput) => void` and `TraceEvent { requestId; source; kind; detail?; at }` are defined once in Task 1 and referenced identically in Tasks 3, 4(wire only), 5(wire), 6, 8, 9, 10, 11, 12. `PersonaRunSpec` gains `timeoutMs` (T3) then `onTrace?` (T8); its `name` is `TraceSource` from T3 onward — every call site passes a `TraceSource` literal. `NarrativeStreamSpec` gains `timeoutMs` (T3) and swaps `onToken`→`onTrace` (T9). `compute(symbol, timeframe, closes, onRequestId?)` is defined in T5 and consumed with the 4th arg in T6. `assembleEnvelope`'s `onComputeId`/`onTrace` (T6) are supplied in T12. `AppendMessageParams.trace?`/`HistoryMessage.trace` (T11) are written in T12. Sidecar `step` is a plain `string` (`SidecarProgressWire.step`, `encode_progress(step: &str)`, `ProgressLine.step: String`) end-to-end, carrying request-type name or algo id uniformly.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-29-phase9a-persona-streaming-plumbing-plan.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

**Which approach?**

*If Subagent-Driven chosen:* REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (fresh subagent per task + two-stage review).
*If Inline Execution chosen:* REQUIRED SUB-SKILL: use superpowers:executing-plans (batch execution with checkpoints).
