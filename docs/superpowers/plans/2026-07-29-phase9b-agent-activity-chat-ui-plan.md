# Phase 9-B — Agent Activity Chat UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the temporary `onNarrative` compatibility adapter and build the styled, collapsible Agent Activity chat UI — subscribing `ChatView` directly to `onTrace`, rendering a per-turn `AgentActivityPanel` (one lane per `TraceSource`, with auto-expand/collapse `TraceStepRow`s), and adding a dedicated, theme-aware CSS layer (`theme.css` + per-component stylesheets + `ChatView.css`) — consuming the already-existing, read-only `analysis:trace` event stream that Phase 9-A shipped.

**Architecture:** A pure `buildLanes(trace)` tree builder (no I/O, no React) turns a flat `TraceEvent[]` into an ordered `LaneNode[]`; a recursive `TraceStepRow` renders each lane/child with live auto-expand/auto-collapse/stay-expanded-on-error behavior gated by a `live: boolean` provenance flag; `AgentActivityPanel` is the collapsible card wrapping those rows; `ChatView` accumulates each turn's trace into `AssistantMessage.trace`/`live` and renders the panel between the user's message and the assistant's reply. A `.chat-view`-scoped dark/light theme (CSS custom properties + a persisted `useChatTheme` hook) styles the whole subtree.

**Tech Stack:** Electron + TypeScript + React (existing), Vitest + Testing Library (existing), no new npm dependency.

## Global Constraints

- **Permanent, non-negotiable safety invariant:** the app never places, modifies, cancels, or automates any order on Zerodha Kite — ever. This phase is pure UI/display work: it touches zero order surface, adds no new IPC channel, no new `ipcMain.handle`, no preload change, and no new Kite/broker call of any kind. The only `src/main/**` edit in this entire plan is deleting the retired `onNarrative`/`NarrativeEvent` compatibility shim from `rendererApi.ts` (a type/adapter removal, not a behavior change — the main process already emits only `TraceEvent`s). Every task in this plan inherits this constraint; none of them is permitted to add an IPC channel, a Kite call, or any main-process behavior change beyond that one deletion.
- All commands in this plan run from `electron-app/` (the working directory).
- No new npm dependency. All work uses React, the existing `bridge()`/`RendererApi`, `localStorage`, and Vite's built-in CSS handling.
- `npx tsc --noEmit` only type-checks `src/**` (see `electron-app/tsconfig.json`: `include: ["src/**/*"]`, `exclude` covers `**/*.test.ts(x)`); test files are executed by Vitest with types stripped, not type-checked. Keep this in mind when a task's test fixture doesn't need every optional field.
- Coding conventions (`CLAUDE.md`): no comments except for non-obvious *why* (a workaround, an invariant, a formula's source — never a restatement of the next line); TypeScript `camelCase` functions/variables, `PascalCase` types/classes/components; file names describe responsibility, not file kind; small, focused files; pure logic (no I/O) lives separately from side-effecting code — `buildLanes` is pure and unit-tested on its own, independent of any React render.
- Commit scope convention (already established on this branch, not reopened here): every commit in this plan is scoped `(electron-app)` — e.g. `feat(electron-app): ...`, `test(electron-app): ...`, `refactor(electron-app): ...`. Never a phase-number scope like `(phase9b)`. Plain `git commit -m "..."` — no `--author`, no `--no-verify`, no `Co-Authored-By` trailer (the repo's configured git user is already correct).
- Reference names used throughout: "P9B§N" → `docs/superpowers/specs/2026-07-29-phase9b-agent-activity-chat-ui-design.md`; "P9A§N" → `docs/superpowers/specs/2026-07-28-phase9a-persona-streaming-plumbing-design.md`.

## File touch-point summary

| File | Change | Task |
| --- | --- | --- |
| `electron-app/src/main/ipc/rendererApi.ts` | Delete `NarrativeEvent`, `onNarrative` (interface + adapter); keep `onTrace`/`TraceEvent`/`TraceSource`/`TraceKind` verbatim | 1 |
| `electron-app/test/main/ipc/rendererApi.test.ts` | Drop `onNarrative` assertions; twelve-method list; simplified trace-wiring test | 1 |
| `electron-app/test/renderer/testBridge.ts` | `onNarrative: vi.fn()` → `onTrace: vi.fn()` | 2 |
| `electron-app/test/renderer/App.test.tsx` | Drop the one `onNarrative: vi.fn()` override | 2 |
| `electron-app/src/renderer/ChatView.tsx` | `AssistantMessage` gains `trace`/`live`; `onNarrative` effect replaced by `onTrace` accumulator; `onSend` seeds `trace: [], live: true`; `historyToChatMessages` maps `trace`/`live: false` | 2 |
| `electron-app/test/renderer/ChatView.test.tsx` | Rewritten to drive `onTrace`; new tests for stale-requestId/non-token filtering and `historyToChatMessages` trace mapping | 2 |
| `electron-app/src/renderer/AgentActivityPanel.tsx` | **New** — `LANE_ORDER`/`LANE_LABEL`, pure `buildLanes` builder (Task 3), then the `AgentActivityPanel` component (Task 5) | 3, 5 |
| `electron-app/test/renderer/AgentActivityPanel.buildLanes.test.ts` | **New** — pure builder unit tests | 3 |
| `electron-app/src/renderer/TraceStepRow.tsx` | **New** — recursive `TraceStepRow` + hookless `ToolLeafRow` | 4 |
| `electron-app/src/renderer/TraceStepRow.css` | **New** | 4 |
| `electron-app/test/renderer/TraceStepRow.test.tsx` | **New** | 4 |
| `electron-app/src/renderer/AgentActivityPanel.css` | **New** | 5 |
| `electron-app/test/renderer/AgentActivityPanel.test.tsx` | **New** — component-level tests | 5 |
| `electron-app/src/renderer/ThemeToggle.tsx` | **New** — `useChatTheme` hook + `ThemeToggle` button | 6 |
| `electron-app/src/renderer/ThemeToggle.css` | **New** | 6 |
| `electron-app/src/renderer/theme.css` | **New** — `.chat-view[data-theme]` custom properties | 6 |
| `electron-app/test/renderer/ThemeToggle.test.tsx` | **New** | 6 |
| `electron-app/src/renderer/ChatView.css` | **New** — net-new `.chat-view`/`.messages`/`.message-*`/`.chat-input`/`.verdict` rules | 7 |
| `electron-app/test/renderer/styleCssSplit.test.ts` | **New** — CSS split sanity | 7 |
| `electron-app/src/renderer/style.css` | **Unchanged** — verified, not just assumed | 7, 8 |
| `electron-app/src/main/services/history/historyStore.ts` | **Unchanged** — verified no-op (P9B§12) | 8 |
| `electron-app/src/renderer/App.tsx` | **Unchanged** — `ChatView`'s public props (`intentLens`, `sessionId`, `initialMessages`) and `historyToChatMessages`'s signature are untouched, so `App.tsx:175-179` needs no edit | 7, 8 |

---

### Task 1: Retire `onNarrative`/`NarrativeEvent` from `rendererApi.ts`

**Files:**
- Modify: `electron-app/src/main/ipc/rendererApi.ts:93-98,105,126-133`
- Test: `electron-app/test/main/ipc/rendererApi.test.ts`

**Interfaces:**
- Consumes: nothing new — `TraceEvent`/`TraceSource`/`TraceKind`/`TraceEventInput`/`TraceEmitter` already exist verbatim (`rendererApi.ts:69-91`), untouched by this task.
- Produces: `RendererApi` with `onTrace(handler: (event: TraceEvent) => void): void` as the sole trace subscription (no more `onNarrative`). Task 2 depends on this — `ChatView.tsx` will call `bridge().onTrace(...)`.

- [ ] **Step 1: Write the failing test**

Replace the whole contents of `electron-app/test/main/ipc/rendererApi.test.ts` with:

```typescript
import { describe, expect, it, vi } from "vitest";
import { buildRendererApi } from "../../../src/main/ipc/rendererApi";

describe("buildRendererApi", () => {
  it("exposes exactly the twelve bridge methods and never leaks the raw transport", () => {
    const api = buildRendererApi(vi.fn().mockResolvedValue({}), vi.fn());
    expect(Object.keys(api).sort()).toEqual([
      "copyBenchmarkResult",
      "createSession",
      "getSession",
      "getStatus",
      "listLakeSymbols",
      "listSessions",
      "login",
      "onBanner",
      "onTrace",
      "runAnalysis",
      "runBenchmark",
      "searchInstruments",
    ]);
    expect((api as Record<string, unknown>).ipcRenderer).toBeUndefined();
    expect((api as Record<string, unknown>).invoke).toBeUndefined();
  });

  it("routes getStatus through status:get", async () => {
    const invoke = vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null });
    const status = await buildRendererApi(invoke, vi.fn()).getStatus();
    expect(invoke).toHaveBeenCalledWith("status:get");
    expect(status.sidecar).toBe("up");
  });

  it("registers onBanner against the banner:push channel", () => {
    const subscribe = vi.fn();
    const handler = vi.fn();
    buildRendererApi(vi.fn(), subscribe).onBanner(handler);
    expect(subscribe).toHaveBeenCalledWith("banner:push", handler);
  });

  it("routes login through kite:login", async () => {
    const invoke = vi.fn().mockResolvedValue({ status: "authenticated" });
    expect(await buildRendererApi(invoke, vi.fn()).login()).toEqual({ status: "authenticated" });
    expect(invoke).toHaveBeenCalledWith("kite:login");
  });

  it("routes searchInstruments through kite:searchInstruments with a query payload", async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    await buildRendererApi(invoke, vi.fn()).searchInstruments("infy");
    expect(invoke).toHaveBeenCalledWith("kite:searchInstruments", { query: "infy" });
  });

  it("routes runAnalysis through analysis:run with the params payload", async () => {
    const invoke = vi.fn().mockResolvedValue({ mode: "engine_only" });
    const params = {
      mode: "engine_only" as const,
      sessionId: "s1",
      instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
      horizon: "positional" as const,
      intent_lens: "buying" as const,
    };
    await buildRendererApi(invoke, vi.fn()).runAnalysis(params);
    expect(invoke).toHaveBeenCalledWith("analysis:run", params);
  });
});

describe("buildRendererApi trace wiring", () => {
  it("subscribes onTrace to analysis:trace", () => {
    const subscribe = vi.fn();
    const handler = vi.fn();
    buildRendererApi(vi.fn(), subscribe).onTrace(handler);
    expect(subscribe).toHaveBeenCalledWith("analysis:trace", handler);
  });

  it("routes an ai_assisted run through analysis:run", async () => {
    const invoke = vi.fn().mockResolvedValue({ mode: "ai_assisted" });
    const api = buildRendererApi(invoke, vi.fn());
    await api.runAnalysis({ mode: "ai_assisted", sessionId: "s1", query: "infy", intent_lens: "buying", requestId: "r1" });
    expect(invoke).toHaveBeenCalledWith("analysis:run", { mode: "ai_assisted", sessionId: "s1", query: "infy", intent_lens: "buying", requestId: "r1" });
  });
});

describe("buildRendererApi history wiring", () => {
  it("routes createSession through history:createSession with a mode payload", async () => {
    const invoke = vi.fn().mockResolvedValue({ id: "s1" });
    await buildRendererApi(invoke, vi.fn()).createSession("engine_only");
    expect(invoke).toHaveBeenCalledWith("history:createSession", { mode: "engine_only" });
  });

  it("routes listSessions through history:listSessions with no args", async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    await buildRendererApi(invoke, vi.fn()).listSessions();
    expect(invoke).toHaveBeenCalledWith("history:listSessions");
  });

  it("routes getSession through history:getSession with an id payload", async () => {
    const invoke = vi.fn().mockResolvedValue({ id: "s1", response_mode: "ai_assisted", messages: [] });
    await buildRendererApi(invoke, vi.fn()).getSession("s1");
    expect(invoke).toHaveBeenCalledWith("history:getSession", { id: "s1" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/main/ipc/rendererApi.test.ts`
Expected: FAIL — the "twelve bridge methods" assertion fails because `buildRendererApi` still returns thirteen keys (including `onNarrative`), and the "subscribes onTrace to analysis:trace" assertion fails because `onTrace`'s current implementation casts the handler through `subscribe("analysis:trace", handler as (p: unknown) => void)`, which — since it's a type cast, not a wrapper — actually already passes the identical `handler` reference, so that specific assertion may already pass; the twelve-vs-thirteen-key assertion is what fails until Step 3.

- [ ] **Step 3: Remove the retired adapter from `rendererApi.ts`**

In `electron-app/src/main/ipc/rendererApi.ts`, delete the `NarrativeEvent` interface:

```typescript
export interface NarrativeEvent {
  requestId: string;
  chunk?: string;
  done?: boolean;
  error?: string;
}
```

Remove `onNarrative(handler: (event: NarrativeEvent) => void): void;` from the `RendererApi` interface, leaving:

```typescript
export interface RendererApi {
  getStatus(): Promise<AppStatus>;
  onBanner(handler: (banner: BannerEvent) => void): void;
  onTrace(handler: (event: TraceEvent) => void): void;
  login(): Promise<LoginResult>;
  searchInstruments(query: string): Promise<unknown>;
  runAnalysis(params: AnalysisRunParams): Promise<AnalysisResult>;
  createSession(mode: AnalysisMode): Promise<SessionSummary>;
  listSessions(): Promise<SessionSummary[]>;
  getSession(id: string): Promise<SessionDetail>;
  listLakeSymbols(): Promise<LakeSymbolEntry[]>;
  runBenchmark(params: BenchmarkRunParams): Promise<BenchmarkResult>;
  copyBenchmarkResult(text: string): Promise<void>;
}
```

Remove the `onNarrative` adapter from `buildRendererApi`, leaving the trace wiring as exactly one line:

```typescript
    onTrace: (handler) => subscribe("analysis:trace", handler as (p: unknown) => void),
    login: () => invoke("kite:login") as Promise<LoginResult>,
```

Nothing else in the file changes: `TraceEvent`/`TraceSource`/`TraceKind`/`TraceEventInput`/`TraceEmitter` stay verbatim.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/main/ipc/rendererApi.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Confirm the main-process safety suite is unaffected**

Run: `npx vitest run test/main/services/kite/kiteClient.test.ts`
Expected: PASS, unchanged — this task's only edit is inside `rendererApi.ts`'s renderer-facing type/adapter surface; it does not touch `KiteClient`, the `claude` CLI argv, or any allowlist/denylist.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/rendererApi.ts test/main/ipc/rendererApi.test.ts
git commit -m "refactor(electron-app): retire the onNarrative/NarrativeEvent compat adapter"
```

---

### Task 2: `ChatView.tsx` — per-turn trace accumulation, narrative-token bubble streaming, and history replay mapping

**Files:**
- Modify: `electron-app/src/renderer/ChatView.tsx`
- Modify: `electron-app/test/renderer/testBridge.ts`
- Modify: `electron-app/test/renderer/App.test.tsx:174`
- Modify: `electron-app/test/renderer/ChatView.test.tsx` (rewritten)

**Interfaces:**
- Consumes: `RendererApi.onTrace` (Task 1), `TraceEvent`/`TraceSource`/`TraceKind` from `../main/ipc/rendererApi` (unchanged).
- Produces: `AssistantMessage { role: "assistant"; requestId: string; text: string; verdict?: Verdict; trace: TraceEvent[]; live: boolean }`; `historyToChatMessages(messages: HistoryMessage[]): ChatMessage[]`. Tasks 5 and 7 depend on this exact `AssistantMessage` shape (`message.trace`, `message.live`) to render `<AgentActivityPanel trace={message.trace} live={message.live} />`.

This task does **not** yet render `AgentActivityPanel` or `ThemeToggle` — those components don't exist until Tasks 5/6. It only changes the accumulation/state logic so it stays independently testable; Task 7 wires the render tree once the components exist.

- [ ] **Step 1: Update the test bridge fixture**

In `electron-app/test/renderer/testBridge.ts`, replace `onNarrative: vi.fn(),` with `onTrace: vi.fn(),` (same position in the object literal). Full file after the change:

```typescript
import { vi } from "vitest";
import type { RendererApi } from "../../src/main/ipc/rendererApi";

export function installBridge(overrides: Partial<RendererApi> = {}): RendererApi {
  const bridge: RendererApi = {
    getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "needsLogin", driftWarning: null }),
    onBanner: vi.fn(),
    onTrace: vi.fn(),
    login: vi.fn().mockResolvedValue({ status: "authenticated" }),
    searchInstruments: vi.fn().mockResolvedValue({ data: [] }),
    runAnalysis: vi.fn(),
    createSession: vi.fn().mockResolvedValue({
      id: "session-1",
      response_mode: "engine_only",
      created_at: "2026-07-27T00:00:00.000Z",
      last_active_at: "2026-07-27T00:00:00.000Z",
      preview: "(no messages yet)",
    }),
    listSessions: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockResolvedValue({ id: "session-1", response_mode: "engine_only", messages: [] }),
    listLakeSymbols: vi.fn().mockResolvedValue([]),
    runBenchmark: vi.fn().mockResolvedValue({
      params: {
        symbol: "NSE:INFY",
        timeframe: "day",
        source: "bhavcopy",
        horizon: "positional",
        cadence: { mode: "session_close" },
        lookaheadBars: 5,
        fromTs: 0,
        toTs: 0,
      },
      candles: [],
      decisionPoints: [],
    }),
    copyBenchmarkResult: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  (window as unknown as { tradeAssistant: RendererApi }).tradeAssistant = bridge;
  return bridge;
}
```

This is load-bearing before any other test in this task: without `onTrace: vi.fn()` here, every test calling `bridge().onTrace(...)` (which `ChatView` will do once Step 5 lands) would throw `bridge().onTrace is not a function`.

- [ ] **Step 2: Remove the stale `onNarrative` override in `App.test.tsx`**

In `electron-app/test/renderer/App.test.tsx`, in the `"continues a reopened ai_assisted session with the same session id"` test, delete the line:

```typescript
      onNarrative: vi.fn(),
```

from its `installBridge({...})` call (it referenced a method that no longer exists on `RendererApi`).

- [ ] **Step 3: Write the failing `ChatView.test.tsx`**

Replace the whole contents of `electron-app/test/renderer/ChatView.test.tsx` with:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView, historyToChatMessages } from "../../src/renderer/ChatView";
import { installBridge } from "./testBridge";
import type { HistoryMessage, TraceEvent } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

describe("ChatView", () => {
  it("submits an ai_assisted run with the session id, lens and a requestId, then streams narrative tokens", async () => {
    let traceHandler: ((event: TraceEvent) => void) | undefined;
    const bridge = installBridge({
      onTrace: vi.fn((handler) => {
        traceHandler = handler as (event: TraceEvent) => void;
      }),
      runAnalysis: vi.fn(async (params) => {
        if (params.mode !== "ai_assisted") throw new Error("mode");
        traceHandler?.({ requestId: params.requestId, source: "narrative", kind: "token", detail: "Infy ", at: "t" });
        traceHandler?.({ requestId: params.requestId, source: "narrative", kind: "token", detail: "constructive.", at: "t" });
        traceHandler?.({ requestId: params.requestId, source: "narrative", kind: "done", at: "t" });
        return {
          mode: "ai_assisted",
          instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
          horizon: "positional",
          intent_lens: "buying",
          verdict: { direction: "bullish", conviction: "high", reasoning: "rsi", cited_algo_ids: ["rsi"], verify_before_acting: "check LTP" },
          narrative: "Infy constructive.",
          algo_results: [],
          confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
        };
      }),
    });

    render(<ChatView intentLens="buying" sessionId="sess-9" />);
    fireEvent.change(screen.getByLabelText(/ask about an instrument/i), { target: { value: "how is infy" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(bridge.runAnalysis).toHaveBeenCalledTimes(1));
    const params = (bridge.runAnalysis as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      mode: string;
      sessionId: string;
      query: string;
      intent_lens: string;
      requestId: string;
    };
    expect(params).toMatchObject({ mode: "ai_assisted", sessionId: "sess-9", query: "how is infy", intent_lens: "buying" });
    expect(typeof params.requestId).toBe("string");
    expect(await screen.findByText(/Infy constructive\./)).toBeTruthy();
    expect(await screen.findByText(/bullish/i)).toBeTruthy();
  });

  it("ignores trace events for a stale requestId and never folds non-token events into the bubble text", async () => {
    let traceHandler: ((event: TraceEvent) => void) | undefined;
    installBridge({
      onTrace: vi.fn((handler) => {
        traceHandler = handler as (event: TraceEvent) => void;
      }),
      runAnalysis: vi.fn(async (params) => {
        if (params.mode !== "ai_assisted") throw new Error("mode");
        traceHandler?.({ requestId: "stale-request", source: "narrative", kind: "token", detail: "SHOULD NOT APPEAR", at: "t" });
        traceHandler?.({ requestId: params.requestId, source: "intake", kind: "started", at: "t" });
        traceHandler?.({ requestId: params.requestId, source: "narrative", kind: "token", detail: "real text", at: "t" });
        // Never resolves: this test only inspects the bubble text streamed before completion.
        return new Promise(() => {});
      }),
    });

    render(<ChatView intentLens="buying" sessionId="sess-9" />);
    fireEvent.change(screen.getByLabelText(/ask about an instrument/i), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByText("real text")).toBeTruthy();
    expect(screen.queryByText(/SHOULD NOT APPEAR/)).toBeNull();
  });

  it("seeds its transcript from initialMessages so a reopened session shows prior turns", () => {
    installBridge();
    const history: HistoryMessage[] = [
      { role: "user", rendered_text: "earlier ask", structured_payload: null, trace: null, created_at: "t0" },
      {
        role: "assistant",
        rendered_text: "earlier reply",
        structured_payload: { mode: "ai_assisted", verdict: { direction: "bearish", conviction: "low", reasoning: "x", cited_algo_ids: ["rsi"], verify_before_acting: "y" } },
        trace: null,
        created_at: "t1",
      },
    ];
    render(<ChatView intentLens="selling" sessionId="sess-9" initialMessages={historyToChatMessages(history)} />);
    expect(screen.getByText(/earlier ask/)).toBeTruthy();
    expect(screen.getByText(/earlier reply/)).toBeTruthy();
    expect(screen.getByText(/bearish/i)).toBeTruthy();
  });

  it("shows an error when the run rejects", async () => {
    installBridge({ runAnalysis: vi.fn().mockRejectedValue(new Error("claude down")) });
    render(<ChatView intentLens="selling" sessionId="sess-9" />);
    fireEvent.change(screen.getByLabelText(/ask about an instrument/i), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByText(/claude down/)).toBeTruthy();
  });
});

describe("historyToChatMessages", () => {
  it("maps a null trace to an empty array and marks replayed assistant turns live: false", () => {
    const history: HistoryMessage[] = [
      { role: "assistant", rendered_text: "reply", structured_payload: null, trace: null, created_at: "t0" },
    ];
    const [message] = historyToChatMessages(history);
    expect(message).toMatchObject({ role: "assistant", trace: [], live: false });
  });

  it("carries a persisted trace array through onto the reconstructed assistant message", () => {
    const trace: TraceEvent[] = [{ requestId: "r0", source: "intake", kind: "started", at: "t0" }];
    const history: HistoryMessage[] = [
      { role: "assistant", rendered_text: "reply", structured_payload: null, trace, created_at: "t0" },
    ];
    const [message] = historyToChatMessages(history);
    expect(message).toMatchObject({ trace, live: false });
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run test/renderer/ChatView.test.tsx`
Expected: FAIL — `ChatView.tsx` still subscribes `onNarrative` (which no longer exists on `RendererApi` after Task 1), so the streaming test times out waiting for "Infy constructive."; the `historyToChatMessages` tests fail because the current implementation returns objects with no `trace`/`live` fields at all.

- [ ] **Step 5: Implement — replace `ChatView.tsx`**

Replace the whole contents of `electron-app/src/renderer/ChatView.tsx` with:

```tsx
import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { MessageMarkdown } from "./MessageMarkdown";
import type { AnalysisResult, HistoryMessage, IntentLens, TraceEvent, Verdict } from "../main/ipc/rendererApi";

export interface ChatViewProps {
  intentLens: IntentLens;
  sessionId: string;
  initialMessages?: ChatMessage[];
}

interface AssistantMessage {
  role: "assistant";
  requestId: string;
  text: string;
  verdict?: Verdict;
  trace: TraceEvent[];
  live: boolean;
}

interface UserMessage {
  role: "user";
  text: string;
}

type ChatMessage = UserMessage | AssistantMessage;

function newRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function historyToChatMessages(messages: HistoryMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role === "user") return { role: "user", text: message.rendered_text };
    const payload = message.structured_payload as AnalysisResult | null;
    const verdict = payload && payload.mode === "ai_assisted" ? payload.verdict : undefined;
    return {
      role: "assistant",
      requestId: newRequestId(),
      text: message.rendered_text,
      verdict,
      trace: message.trace ?? [],
      live: false,
    };
  });
}

export function ChatView({ intentLens, sessionId, initialMessages }: ChatViewProps): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages ?? []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRequestId = useRef<string | null>(null);

  useEffect(() => {
    bridge().onTrace((event: TraceEvent) => {
      if (event.requestId !== activeRequestId.current) return;
      const isNarrativeToken = event.source === "narrative" && event.kind === "token";
      setMessages((prev) =>
        prev.map((message) =>
          message.role === "assistant" && message.requestId === event.requestId
            ? {
                ...message,
                // narrative tokens stream into the bubble text, exactly as onNarrative did;
                // every other event is trace fuel for the panel and never appended to text.
                text: isNarrativeToken ? message.text + (event.detail ?? "") : message.text,
                trace: isNarrativeToken ? message.trace : [...message.trace, event],
              }
            : message,
        ),
      );
    });
  }, []);

  const onSend = async (): Promise<void> => {
    const query = input.trim();
    if (query.length === 0 || busy) return;
    const requestId = newRequestId();
    activeRequestId.current = requestId;
    setError(null);
    setBusy(true);
    setInput("");
    setMessages((prev) => [
      ...prev,
      { role: "user", text: query },
      { role: "assistant", requestId, text: "", trace: [], live: true },
    ]);
    try {
      const result = await bridge().runAnalysis({ mode: "ai_assisted", sessionId, query, intent_lens: intentLens, requestId });
      if (result.mode === "ai_assisted") {
        setMessages((prev) =>
          prev.map((message) =>
            message.role === "assistant" && message.requestId === requestId
              ? { ...message, text: result.narrative, verdict: result.verdict }
              : message,
          ),
        );
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="chat-view">
      <ul className="messages">
        {messages.map((message, index) => (
          <li key={index} className={`message message-${message.role}`}>
            {message.role === "assistant" ? (
              <>
                {message.verdict && (
                  <div className="verdict">
                    {message.verdict.direction} · {message.verdict.conviction} conviction
                  </div>
                )}
                <MessageMarkdown text={message.text} />
              </>
            ) : (
              <p>{message.text}</p>
            )}
          </li>
        ))}
      </ul>
      {error && <div className="error">{error}</div>}
      <div className="chat-input">
        <input
          aria-label="ask about an instrument"
          placeholder="Ask about an instrument…"
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <button type="button" onClick={onSend} disabled={busy}>
          {busy ? "Analyzing…" : "Send"}
        </button>
      </div>
    </section>
  );
}
```

Note what is deliberately **not** here: no `setError` from trace events. The old `onNarrative` handler set the top-level error banner from `event.error`; that behavior is dropped with no loss, because every trace `error` event is always accompanied by the rejected `runAnalysis` promise (P9A§12), which the existing `catch` block already turns into the `.error` banner. Per-step failures become error rows in the panel starting in Task 4 — new information the old path could never show, not a regression of the old one.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/renderer/ChatView.test.tsx test/renderer/App.test.tsx`
Expected: PASS (all cases green).

- [ ] **Step 7: Full renderer regression check**

Run: `npx vitest run test/renderer`
Expected: PASS — confirms no other renderer test (e.g. `HistorySidebar`, `BenchmarkView`) broke from the `RendererApi` shape change.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/ChatView.tsx test/renderer/testBridge.ts test/renderer/App.test.tsx test/renderer/ChatView.test.tsx
git commit -m "feat(electron-app): stream trace events into per-turn AssistantMessage state"
```

---

### Task 3: The pure `buildLanes` trace-tree builder

**Files:**
- Create: `electron-app/src/renderer/AgentActivityPanel.tsx` (this task adds only types + the pure builder; Task 5 appends the React component to this same file)
- Test: `electron-app/test/renderer/AgentActivityPanel.buildLanes.test.ts`

**Interfaces:**
- Consumes: `TraceEvent`/`TraceSource` from `../main/ipc/rendererApi` (unchanged).
- Produces: `LANE_ORDER: TraceSource[]`; `NodeStatus = "running" | "done" | "error"`; `ChildNode = { kind: "algo"; label: string; status: NodeStatus } | { kind: "tool"; variant: "toolCall" | "toolResult"; detail: string }`; `LaneNode = { kind: "lane"; source: TraceSource; label: string; status: NodeStatus; children: ChildNode[] }`; `buildLanes(trace: TraceEvent[]): LaneNode[]`. Task 4 (`TraceStepRow`) type-imports `NodeStatus`/`ChildNode`/`LaneNode` from this file; Task 5 (the component) imports `buildLanes`, `LANE_ORDER` is exported for direct test assertions (label lookup stays internal).

This is a pure-logic file — no React, no I/O — deliberately unit-tested on its own before any component exists, per CLAUDE.md's pure-logic-vs-I/O split.

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/renderer/AgentActivityPanel.buildLanes.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { LANE_ORDER, buildLanes } from "../../src/renderer/AgentActivityPanel";
import type { TraceEvent } from "../../src/main/ipc/rendererApi";

function ev(partial: Partial<TraceEvent> & Pick<TraceEvent, "source" | "kind">): TraceEvent {
  return { requestId: "r1", at: "2026-07-29T00:00:00.000Z", ...partial };
}

describe("buildLanes", () => {
  it("orders lanes per LANE_ORDER regardless of arrival order", () => {
    const trace: TraceEvent[] = [
      ev({ source: "narrative", kind: "started" }),
      ev({ source: "intake", kind: "started" }),
      ev({ source: "synthesis", kind: "started" }),
    ];
    const lanes = buildLanes(trace);
    expect(lanes.map((l) => l.source)).toEqual(
      LANE_ORDER.filter((s) => ["intake", "synthesis", "narrative"].includes(s)),
    );
  });

  it("produces no lane for a source with zero events", () => {
    const trace: TraceEvent[] = [ev({ source: "intake", kind: "started" }), ev({ source: "intake", kind: "done" })];
    const lanes = buildLanes(trace);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].source).toBe("intake");
  });

  it("splits sidecar events into the compute bracket plus per-algorithm children in first-arrival order", () => {
    const trace: TraceEvent[] = [
      ev({ source: "sidecar", kind: "started", detail: "compute" }),
      ev({ source: "sidecar", kind: "started", detail: "rsi" }),
      ev({ source: "sidecar", kind: "started", detail: "macd" }),
      ev({ source: "sidecar", kind: "done", detail: "rsi" }),
      ev({ source: "sidecar", kind: "done", detail: "macd" }),
      ev({ source: "sidecar", kind: "done", detail: "compute" }),
    ];
    const lane = buildLanes(trace)[0];
    expect(lane.source).toBe("sidecar");
    expect(lane.status).toBe("done");
    expect(lane.children).toEqual([
      { kind: "algo", label: "rsi", status: "done" },
      { kind: "algo", label: "macd", status: "done" },
    ]);
  });

  it("classifies a lone sidecar error as the request-level bracket, not an algorithm", () => {
    const trace: TraceEvent[] = [
      ev({ source: "sidecar", kind: "started", detail: "compute" }),
      ev({ source: "sidecar", kind: "started", detail: "rsi" }),
      ev({ source: "sidecar", kind: "error", detail: "sidecar compute timed out after 20000ms" }),
    ];
    const lane = buildLanes(trace)[0];
    expect(lane.status).toBe("error");
    expect(lane.children).toEqual([{ kind: "algo", label: "rsi", status: "running" }]);
  });

  it("turns persona toolCall/toolResult events into tool leaves with detail verbatim", () => {
    const trace: TraceEvent[] = [
      ev({ source: "intake", kind: "started" }),
      ev({ source: "intake", kind: "toolCall", detail: 'Read {"file":"a.ts"}' }),
      ev({ source: "intake", kind: "toolResult", detail: "Read → contents" }),
      ev({ source: "intake", kind: "done" }),
    ];
    const lane = buildLanes(trace)[0];
    expect(lane.children).toEqual([
      { kind: "tool", variant: "toolCall", detail: 'Read {"file":"a.ts"}' },
      { kind: "tool", variant: "toolResult", detail: "Read → contents" },
    ]);
  });

  it("resolves status precedence as error > done > running", () => {
    const running = buildLanes([ev({ source: "intake", kind: "started" })])[0];
    const done = buildLanes([ev({ source: "intake", kind: "started" }), ev({ source: "intake", kind: "done" })])[0];
    const errored = buildLanes([
      ev({ source: "intake", kind: "started" }),
      ev({ source: "intake", kind: "done" }),
      ev({ source: "intake", kind: "error", detail: "boom" }),
    ])[0];
    expect(running.status).toBe("running");
    expect(done.status).toBe("done");
    expect(errored.status).toBe("error");
  });

  it("filters out narrative token events so they never become panel rows", () => {
    const trace: TraceEvent[] = [
      ev({ source: "narrative", kind: "started" }),
      ev({ source: "narrative", kind: "token", detail: "hello " }),
      ev({ source: "narrative", kind: "toolCall", detail: "WebFetch {}" }),
      ev({ source: "narrative", kind: "token", detail: "world" }),
      ev({ source: "narrative", kind: "done" }),
    ];
    const lane = buildLanes(trace)[0];
    expect(lane.children).toEqual([{ kind: "tool", variant: "toolCall", detail: "WebFetch {}" }]);
  });

  it("returns an empty array for an empty trace", () => {
    expect(buildLanes([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/renderer/AgentActivityPanel.buildLanes.test.ts`
Expected: FAIL with a module-resolution error — `src/renderer/AgentActivityPanel.tsx` does not exist yet.

- [ ] **Step 3: Implement — create `AgentActivityPanel.tsx` (builder only)**

Create `electron-app/src/renderer/AgentActivityPanel.tsx`:

```typescript
import type { TraceEvent, TraceSource } from "../main/ipc/rendererApi";

export const LANE_ORDER: TraceSource[] = [
  "intake",
  "sidecar",
  "options_greeks",
  "technical_quant",
  "position_risk",
  "synthesis",
  "narrative",
];

const LANE_LABEL: Record<TraceSource, string> = {
  intake: "Intake",
  sidecar: "Rust compute",
  options_greeks: "Options & Greeks",
  technical_quant: "Technical & Quant",
  position_risk: "Position & Risk",
  synthesis: "Synthesis",
  narrative: "Narrative",
};

export type NodeStatus = "running" | "done" | "error";

export type ChildNode =
  | { kind: "algo"; label: string; status: NodeStatus }
  | { kind: "tool"; variant: "toolCall" | "toolResult"; detail: string };

export interface LaneNode {
  kind: "lane";
  source: TraceSource;
  label: string;
  status: NodeStatus;
  children: ChildNode[];
}

function statusFrom(events: Pick<TraceEvent, "kind">[]): NodeStatus {
  if (events.some((e) => e.kind === "error")) return "error";
  if (events.some((e) => e.kind === "done")) return "done";
  return "running";
}

// A sidecar event is a per-algorithm child iff it is a non-error progress line whose
// detail is an algorithm id: "compute" is the reserved request-step name for the
// bracket, and Rust never emits a per-algorithm error (P9A§9.3), so the one sidecar
// error event is always the compute bracket failing.
function isAlgoEvent(e: TraceEvent): boolean {
  return e.kind !== "error" && e.detail !== undefined && e.detail !== "compute";
}

export function buildLanes(trace: TraceEvent[]): LaneNode[] {
  const bySource = new Map<TraceSource, TraceEvent[]>();
  for (const e of trace) {
    if (e.kind === "token") continue; // narrative tokens live in the bubble only (P9B§6.3)
    const list = bySource.get(e.source);
    if (list) list.push(e);
    else bySource.set(e.source, [e]);
  }

  const lanes: LaneNode[] = [];
  for (const source of LANE_ORDER) {
    const events = bySource.get(source);
    if (!events) continue; // lane appears only once it has started

    if (source === "sidecar") {
      const bracket = events.filter((e) => !isAlgoEvent(e));
      const algos = new Map<string, TraceEvent[]>();
      for (const e of events) {
        if (!isAlgoEvent(e)) continue;
        const id = e.detail as string;
        const g = algos.get(id);
        if (g) g.push(e);
        else algos.set(id, [e]);
      }
      lanes.push({
        kind: "lane",
        source,
        label: LANE_LABEL[source],
        status: statusFrom(bracket),
        children: [...algos.entries()].map(([id, es]) => ({ kind: "algo", label: id, status: statusFrom(es) })),
      });
    } else {
      lanes.push({
        kind: "lane",
        source,
        label: LANE_LABEL[source],
        status: statusFrom(events),
        children: events
          .filter((e) => e.kind === "toolCall" || e.kind === "toolResult")
          .map((e) => ({ kind: "tool", variant: e.kind as "toolCall" | "toolResult", detail: e.detail ?? "" })),
      });
    }
  }
  return lanes;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/renderer/AgentActivityPanel.buildLanes.test.ts`
Expected: PASS (all seven cases green).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors — `AgentActivityPanel.tsx` is a self-contained module at this point (no unresolved imports, since `TraceStepRow` doesn't exist yet and isn't referenced).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/AgentActivityPanel.tsx test/renderer/AgentActivityPanel.buildLanes.test.ts
git commit -m "feat(electron-app): add the pure buildLanes trace-tree builder"
```

---

### Task 4: `TraceStepRow` — the recursive status-row primitive

**Files:**
- Create: `electron-app/src/renderer/TraceStepRow.tsx`
- Create: `electron-app/src/renderer/TraceStepRow.css`
- Test: `electron-app/test/renderer/TraceStepRow.test.tsx`

**Interfaces:**
- Consumes (type-only, from Task 3's `AgentActivityPanel.tsx`): `NodeStatus`, `ChildNode`, `LaneNode`.
- Produces: `TraceStepRow({ node, live }: { node: LaneNode | Extract<ChildNode, { kind: "algo" }>; live: boolean }): JSX.Element`. Task 5 (`AgentActivityPanel` component) renders one `TraceStepRow` per lane.

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/renderer/TraceStepRow.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TraceStepRow } from "../../src/renderer/TraceStepRow";
import type { LaneNode } from "../../src/renderer/AgentActivityPanel";

afterEach(cleanup);

function lane(status: LaneNode["status"], children: LaneNode["children"] = []): LaneNode {
  return { kind: "lane", source: "intake", label: "Intake", status, children };
}

describe("TraceStepRow", () => {
  it("auto-expands a running row and shows its children while live", () => {
    const node = lane("running", [{ kind: "tool", variant: "toolCall", detail: "Read {}" }]);
    render(<TraceStepRow node={node} live={true} />);
    expect(screen.getByText("⟳")).toBeTruthy();
    expect(screen.getByText("Read {}")).toBeTruthy();
    expect(screen.getByText("▾")).toBeTruthy();
  });

  it("auto-collapses a done row while live", () => {
    const node = lane("done", [{ kind: "tool", variant: "toolCall", detail: "Read {}" }]);
    render(<TraceStepRow node={node} live={true} />);
    expect(screen.getByText("✓")).toBeTruthy();
    expect(screen.queryByText("Read {}")).toBeNull();
    expect(screen.getByText("▸")).toBeTruthy();
  });

  it("stays expanded on error while live", () => {
    const node = lane("error", [{ kind: "tool", variant: "toolResult", detail: "boom" }]);
    render(<TraceStepRow node={node} live={true} />);
    expect(screen.getByText("✗")).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();
    expect(screen.getByText("▾")).toBeTruthy();
  });

  it("lets a manual expand override auto-collapse on a done row, and the override persists across a same-status re-render", () => {
    const node = lane("done", [{ kind: "tool", variant: "toolCall", detail: "Read {}" }]);
    const { rerender } = render(<TraceStepRow node={node} live={true} />);
    expect(screen.queryByText("Read {}")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Read {}")).toBeTruthy();
    rerender(<TraceStepRow node={node} live={true} />);
    expect(screen.getByText("Read {}")).toBeTruthy();
  });

  it("reverts a manual collapse back to auto-expand when a running row transitions to error", () => {
    const runningNode = lane("running", [{ kind: "tool", variant: "toolCall", detail: "Read {}" }]);
    const { rerender } = render(<TraceStepRow node={runningNode} live={true} />);
    expect(screen.getByText("Read {}")).toBeTruthy();

    fireEvent.click(screen.getByRole("button")); // manual collapse while running
    expect(screen.queryByText("Read {}")).toBeNull();

    const erroredNode = lane("error", [{ kind: "tool", variant: "toolResult", detail: "boom" }]);
    rerender(<TraceStepRow node={erroredNode} live={true} />);
    expect(screen.getByText("boom")).toBeTruthy(); // status transitioned; auto takes back over and re-expands
  });

  it("renders every row collapsed by default in history replay (live=false), even an errored one, until manually toggled", () => {
    const node = lane("error", [{ kind: "tool", variant: "toolResult", detail: "boom" }]);
    render(<TraceStepRow node={node} live={false} />);
    expect(screen.queryByText("boom")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("disables the toggle button and shows no caret for a childless algo leaf", () => {
    const node = { kind: "algo" as const, label: "rsi", status: "done" as const };
    render(<TraceStepRow node={node} live={false} />);
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.queryByText("▾")).toBeNull();
    expect(screen.queryByText("▸")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/renderer/TraceStepRow.test.tsx`
Expected: FAIL with a module-resolution error — `src/renderer/TraceStepRow.tsx` does not exist yet.

- [ ] **Step 3: Implement — create `TraceStepRow.tsx`**

Create `electron-app/src/renderer/TraceStepRow.tsx`:

```tsx
import { useEffect, useState } from "react";
import "./TraceStepRow.css";
import type { ChildNode, LaneNode, NodeStatus } from "./AgentActivityPanel";

const STATUS_ICON: Record<NodeStatus, string> = { running: "⟳", done: "✓", error: "✗" };

type BracketNode = LaneNode | Extract<ChildNode, { kind: "algo" }>;

export interface TraceStepRowProps {
  node: BracketNode;
  live: boolean;
}

export function TraceStepRow({ node, live }: TraceStepRowProps): JSX.Element {
  const [override, setOverride] = useState<boolean | null>(null);
  // A manual toggle owns the row until its status next transitions; on any status
  // change (running → done/error) auto-behavior takes back over. In practice a row's
  // status never transitions after a terminal event, so a manual toggle on a
  // done/error row persists for the rest of that row's life.
  useEffect(() => setOverride(null), [node.status]);

  const hasChildren = node.kind === "lane" && node.children.length > 0;
  const auto = live && (node.status === "running" || node.status === "error");
  const expanded = override ?? auto;

  return (
    <div className={`trace-step trace-step-${node.status}`}>
      <button
        type="button"
        className="trace-step-head"
        onClick={() => hasChildren && setOverride(!expanded)}
        disabled={!hasChildren}
      >
        <span className="trace-step-icon">{STATUS_ICON[node.status]}</span>
        {hasChildren && <span className="trace-step-caret">{expanded ? "▾" : "▸"}</span>}
        <span className="trace-step-label">{node.label}</span>
      </button>
      {node.kind === "lane" && expanded && node.children.length > 0 && (
        <div className="trace-step-children">
          {node.children.map((child, i) =>
            child.kind === "tool" ? (
              <ToolLeafRow key={i} variant={child.variant} detail={child.detail} />
            ) : (
              <TraceStepRow key={i} node={child} live={live} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function ToolLeafRow({ variant, detail }: { variant: "toolCall" | "toolResult"; detail: string }): JSX.Element {
  return (
    <div className={`trace-tool trace-tool-${variant}`}>
      <code className="trace-tool-detail">{detail}</code>
    </div>
  );
}
```

Create `electron-app/src/renderer/TraceStepRow.css`:

```css
.trace-step {
  font-size: 0.85rem;
  color: var(--fg);
}

.trace-step-head {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  width: 100%;
  padding: 0.25rem 0.5rem;
  background: none;
  border: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.trace-step-head:disabled {
  cursor: default;
}

.trace-step-icon {
  width: 1rem;
  text-align: center;
}

.trace-step-running .trace-step-icon {
  color: var(--status-running);
}

.trace-step-done .trace-step-icon {
  color: var(--status-done);
}

.trace-step-error .trace-step-icon {
  color: var(--status-error);
}

.trace-step-caret {
  width: 0.75rem;
  text-align: center;
  opacity: 0.7;
}

.trace-step-label {
  flex: 1;
}

.trace-step-children {
  margin-left: 1.25rem;
  border-left: 1px solid var(--border);
  padding-left: 0.5rem;
}

.trace-tool {
  padding: 0.125rem 0.5rem;
}

.trace-tool-detail {
  display: block;
  background: var(--code-bg);
  color: var(--fg);
  border-radius: 4px;
  padding: 0.25rem 0.375rem;
  font-family: ui-monospace, monospace;
  font-size: 0.75rem;
  white-space: pre-wrap;
  word-break: break-word;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/renderer/TraceStepRow.test.tsx`
Expected: PASS (all seven cases green).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/TraceStepRow.tsx src/renderer/TraceStepRow.css test/renderer/TraceStepRow.test.tsx
git commit -m "feat(electron-app): add the recursive TraceStepRow status-row component"
```

---

### Task 5: `AgentActivityPanel` — the collapsible card component

**Files:**
- Modify: `electron-app/src/renderer/AgentActivityPanel.tsx` (append the component to the file Task 3 created)
- Create: `electron-app/src/renderer/AgentActivityPanel.css`
- Test: `electron-app/test/renderer/AgentActivityPanel.test.tsx`

**Interfaces:**
- Consumes: `buildLanes` (this file, Task 3), `TraceStepRow` (Task 4).
- Produces: `AgentActivityPanel({ trace, live }: { trace: TraceEvent[]; live: boolean }): JSX.Element | null`. Task 7 renders `<AgentActivityPanel trace={message.trace} live={message.live} />` inside `ChatView.tsx`.

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/renderer/AgentActivityPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentActivityPanel } from "../../src/renderer/AgentActivityPanel";
import type { TraceEvent } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);

describe("AgentActivityPanel", () => {
  it("renders nothing for an empty trace (engine_only turns carry none)", () => {
    const { container } = render(<AgentActivityPanel trace={[]} live={true} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for a trace containing only narrative tokens", () => {
    const trace: TraceEvent[] = [{ requestId: "r1", source: "narrative", kind: "token", detail: "hi", at: "t" }];
    const { container } = render(<AgentActivityPanel trace={trace} live={true} />);
    expect(container.firstChild).toBeNull();
  });

  it("opens by default while live and renders one lane per started source", () => {
    const trace: TraceEvent[] = [
      { requestId: "r1", source: "intake", kind: "started", at: "t" },
      { requestId: "r1", source: "intake", kind: "done", at: "t" },
    ];
    render(<AgentActivityPanel trace={trace} live={true} />);
    expect(screen.getByText("Agent activity")).toBeTruthy();
    expect(screen.getByText("Intake")).toBeTruthy();
    expect(screen.getByText("▾")).toBeTruthy();
  });

  it("collapses by default on history replay (live=false) and expands on click", () => {
    const trace: TraceEvent[] = [
      { requestId: "r1", source: "intake", kind: "started", at: "t" },
      { requestId: "r1", source: "intake", kind: "done", at: "t" },
    ];
    render(<AgentActivityPanel trace={trace} live={false} />);
    expect(screen.queryByText("Intake")).toBeNull();
    fireEvent.click(screen.getByText("Agent activity"));
    expect(screen.getByText("Intake")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/renderer/AgentActivityPanel.test.tsx`
Expected: FAIL — `AgentActivityPanel` (the component export) does not exist yet in `src/renderer/AgentActivityPanel.tsx` (only the builder from Task 3 is there).

- [ ] **Step 3: Implement — append the component to `AgentActivityPanel.tsx`**

At the top of `electron-app/src/renderer/AgentActivityPanel.tsx`, change the import line to add `useState`, the CSS import, and the `TraceStepRow` import:

```typescript
import { useState } from "react";
import "./AgentActivityPanel.css";
import { TraceStepRow } from "./TraceStepRow";
import type { TraceEvent, TraceSource } from "../main/ipc/rendererApi";
```

Then append this to the end of the file (after `buildLanes`):

```tsx
export interface AgentActivityPanelProps {
  trace: TraceEvent[];
  live: boolean;
}

export function AgentActivityPanel({ trace, live }: AgentActivityPanelProps): JSX.Element | null {
  const [open, setOpen] = useState(live); // card open while streaming, collapsed on replay
  const lanes = buildLanes(trace);
  if (lanes.length === 0) return null; // engine_only / token-only turns show no panel

  return (
    <div className="agent-activity">
      <button type="button" className="agent-activity-head" onClick={() => setOpen((v) => !v)}>
        <span className="agent-activity-caret">{open ? "▾" : "▸"}</span>
        Agent activity
      </button>
      {open && (
        <div className="agent-activity-lanes">
          {lanes.map((lane) => (
            <TraceStepRow key={lane.source} node={lane} live={live} />
          ))}
        </div>
      )}
    </div>
  );
}
```

`useState(live)` is called unconditionally before the `lanes.length === 0` early return, honoring React's rules of hooks.

Create `electron-app/src/renderer/AgentActivityPanel.css`:

```css
.agent-activity {
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 0.5rem;
  background: var(--code-bg);
}

.agent-activity-head {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  width: 100%;
  padding: 0.375rem 0.625rem;
  background: none;
  border: none;
  color: var(--fg);
  font-size: 0.85rem;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.agent-activity-caret {
  width: 0.75rem;
  text-align: center;
  opacity: 0.7;
}

.agent-activity-lanes {
  border-top: 1px solid var(--border);
  padding: 0.25rem 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/renderer/AgentActivityPanel.test.tsx`
Expected: PASS (all four cases green).

- [ ] **Step 5: Full builder + component regression for this file**

Run: `npx vitest run test/renderer/AgentActivityPanel.buildLanes.test.ts test/renderer/AgentActivityPanel.test.tsx test/renderer/TraceStepRow.test.tsx`
Expected: PASS — confirms Task 3's builder tests still pass unchanged after this task's edits to the same source file.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/AgentActivityPanel.tsx src/renderer/AgentActivityPanel.css test/renderer/AgentActivityPanel.test.tsx
git commit -m "feat(electron-app): add the collapsible AgentActivityPanel component"
```

---

### Task 6: `ThemeToggle` + `theme.css` — persisted `.chat-view` dark/light theme

**Files:**
- Create: `electron-app/src/renderer/ThemeToggle.tsx`
- Create: `electron-app/src/renderer/ThemeToggle.css`
- Create: `electron-app/src/renderer/theme.css`
- Test: `electron-app/test/renderer/ThemeToggle.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `useChatTheme(): [ChatTheme, () => void]` where `ChatTheme = "dark" | "light"`; `ThemeToggle({ theme, onToggle }: { theme: ChatTheme; onToggle: () => void }): JSX.Element`. Task 7 calls `const [theme, toggleTheme] = useChatTheme();` in `ChatView.tsx` and renders `<ThemeToggle theme={theme} onToggle={toggleTheme} />` inside `<section className="chat-view" data-theme={theme}>`.

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/renderer/ThemeToggle.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeToggle, useChatTheme } from "../../src/renderer/ThemeToggle";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

describe("useChatTheme", () => {
  it("defaults to dark when localStorage has no saved theme", () => {
    const { result } = renderHook(() => useChatTheme());
    expect(result.current[0]).toBe("dark");
  });

  it("defaults to dark when the saved value is neither dark nor light", () => {
    localStorage.setItem("chatTheme", "purple");
    const { result } = renderHook(() => useChatTheme());
    expect(result.current[0]).toBe("dark");
  });

  it("reads a previously persisted theme on mount", () => {
    localStorage.setItem("chatTheme", "light");
    const { result } = renderHook(() => useChatTheme());
    expect(result.current[0]).toBe("light");
  });

  it("toggling flips the theme and persists it to localStorage", () => {
    const { result } = renderHook(() => useChatTheme());
    act(() => result.current[1]());
    expect(result.current[0]).toBe("light");
    expect(localStorage.getItem("chatTheme")).toBe("light");
  });

  it("rehydrates the persisted value on a fresh mount", () => {
    const first = renderHook(() => useChatTheme());
    act(() => first.result.current[1]());
    first.unmount();

    const second = renderHook(() => useChatTheme());
    expect(second.result.current[0]).toBe("light");
  });
});

describe("ThemeToggle", () => {
  it("shows a sun icon and offers to switch to light when the theme is dark", () => {
    render(<ThemeToggle theme="dark" onToggle={() => {}} />);
    expect(screen.getByRole("button", { name: /switch to light theme/i })).toBeTruthy();
  });

  it("shows a moon icon and offers to switch to dark when the theme is light", () => {
    render(<ThemeToggle theme="light" onToggle={() => {}} />);
    expect(screen.getByRole("button", { name: /switch to dark theme/i })).toBeTruthy();
  });

  it("calls onToggle when clicked", () => {
    let calls = 0;
    render(<ThemeToggle theme="light" onToggle={() => calls++} />);
    fireEvent.click(screen.getByRole("button"));
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/renderer/ThemeToggle.test.tsx`
Expected: FAIL with a module-resolution error — `src/renderer/ThemeToggle.tsx` does not exist yet.

- [ ] **Step 3: Implement**

Create `electron-app/src/renderer/theme.css`:

```css
.chat-view[data-theme="dark"] {
  --bg: #0f1115;
  --fg: #e6e6e6;
  --border: #2a2f3a;
  --accent: #6366f1;
  --code-bg: #1a1d24;
  --status-running: #d97706;
  --status-done: #16a34a;
  --status-error: #dc2626;
}

.chat-view[data-theme="light"] {
  --bg: #ffffff;
  --fg: #111827;
  --border: #d1d5db;
  --accent: #4f46e5;
  --code-bg: #f3f4f6;
  --status-running: #b45309;
  --status-done: #15803d;
  --status-error: #b91c1c;
}
```

Create `electron-app/src/renderer/ThemeToggle.tsx`:

```tsx
import { useState } from "react";
import "./ThemeToggle.css";

const THEME_KEY = "chatTheme";
export type ChatTheme = "dark" | "light";

export function useChatTheme(): [ChatTheme, () => void] {
  const [theme, setTheme] = useState<ChatTheme>(() => {
    const saved = globalThis.localStorage?.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : "dark";
  });
  const toggle = (): void =>
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      globalThis.localStorage?.setItem(THEME_KEY, next);
      return next;
    });
  return [theme, toggle];
}

export function ThemeToggle({ theme, onToggle }: { theme: ChatTheme; onToggle: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      aria-label={`switch to ${theme === "dark" ? "light" : "dark"} theme`}
    >
      {theme === "dark" ? "☀" : "☾"}
    </button>
  );
}
```

Create `electron-app/src/renderer/ThemeToggle.css`:

```css
.theme-toggle {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--code-bg);
  color: var(--fg);
  cursor: pointer;
  font-size: 0.9rem;
  line-height: 1;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/renderer/ThemeToggle.test.tsx`
Expected: PASS (all eight cases green).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/ThemeToggle.tsx src/renderer/ThemeToggle.css src/renderer/theme.css test/renderer/ThemeToggle.test.tsx
git commit -m "feat(electron-app): add the ThemeToggle component and chat theme variables"
```

---

### Task 7: `ChatView.css` and wiring `AgentActivityPanel` + `ThemeToggle` into `ChatView.tsx`

**Files:**
- Create: `electron-app/src/renderer/ChatView.css`
- Modify: `electron-app/src/renderer/ChatView.tsx`
- Test: `electron-app/test/renderer/ChatView.test.tsx` (append new tests)
- Test: `electron-app/test/renderer/styleCssSplit.test.ts` (new)

**Interfaces:**
- Consumes: `AgentActivityPanel` (Task 5), `ThemeToggle`/`useChatTheme` (Task 6).
- Produces: the finished `ChatView` render tree. No public prop/signature change — `App.tsx:175-179` (`<ChatView intentLens=... sessionId=... initialMessages=.../>`) needs no edit, confirmed by re-reading `App.tsx` against this task's `ChatView.tsx` — its props interface is unchanged from Task 2.

- [ ] **Step 1: Write the failing tests**

First, create `electron-app/test/renderer/styleCssSplit.test.ts`:

```typescript
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styleCss = readFileSync("src/renderer/style.css", "utf8");
const chatViewCss = readFileSync("src/renderer/ChatView.css", "utf8");

describe("style.css / ChatView.css split", () => {
  it("keeps shared rules in style.css", () => {
    expect(styleCss).toMatch(/\.error\s*{/);
    expect(styleCss).toMatch(/\.message-markdown/);
    expect(styleCss).toMatch(/\.mermaid/);
  });

  it("does not add chat-specific rules to style.css", () => {
    expect(styleCss).not.toMatch(/\.chat-view/);
    expect(styleCss).not.toMatch(/\.messages\s*{/);
    expect(styleCss).not.toMatch(/\.chat-input/);
    expect(styleCss).not.toMatch(/\.verdict/);
  });

  it("puts the new chat rules in ChatView.css instead", () => {
    expect(chatViewCss).toMatch(/\.chat-view\s*{/);
    expect(chatViewCss).toMatch(/\.messages\s*{/);
    expect(chatViewCss).toMatch(/\.chat-input/);
    expect(chatViewCss).toMatch(/\.verdict/);
  });
});
```

Then, in `electron-app/test/renderer/ChatView.test.tsx`, add these two tests inside the existing `describe("ChatView", ...)` block (after the "shows an error when the run rejects" test):

```tsx
  it("renders an Agent Activity panel once trace events arrive, live and open by default", async () => {
    let traceHandler: ((event: TraceEvent) => void) | undefined;
    installBridge({
      onTrace: vi.fn((handler) => {
        traceHandler = handler as (event: TraceEvent) => void;
      }),
      runAnalysis: vi.fn(async (params) => {
        if (params.mode !== "ai_assisted") throw new Error("mode");
        traceHandler?.({ requestId: params.requestId, source: "intake", kind: "started", at: "t" });
        // Never resolves: only the live trace panel is under test here.
        return new Promise(() => {});
      }),
    });
    render(<ChatView intentLens="buying" sessionId="sess-9" />);
    fireEvent.change(screen.getByLabelText(/ask about an instrument/i), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByText("Agent activity")).toBeTruthy();
    expect(await screen.findByText("Intake")).toBeTruthy();
  });

  it("wires the theme toggle onto the chat-view root and flips data-theme on click", () => {
    installBridge();
    render(<ChatView intentLens="buying" sessionId="sess-9" />);
    const section = document.querySelector(".chat-view") as HTMLElement;
    expect(section.getAttribute("data-theme")).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: /switch to light theme/i }));
    expect(section.getAttribute("data-theme")).toBe("light");
  });
```

(The `beforeEach(() => localStorage.clear())` already added in Task 2 keeps these two tests isolated from each other and from `ThemeToggle.test.tsx`'s own suite, since Vitest gives each test file its own jsdom instance.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/renderer/styleCssSplit.test.ts test/renderer/ChatView.test.tsx`
Expected: FAIL — `styleCssSplit.test.ts` fails because `src/renderer/ChatView.css` does not exist yet; the two new `ChatView.test.tsx` cases fail because `ChatView.tsx` does not yet render `AgentActivityPanel`/`ThemeToggle` or set `data-theme`.

- [ ] **Step 3: Implement — create `ChatView.css`**

Create `electron-app/src/renderer/ChatView.css`:

```css
.chat-view {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  background: var(--bg);
  color: var(--fg);
  border-radius: 8px;
  padding: 1rem;
}

.messages {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.message {
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
}

.message-user {
  align-self: flex-end;
  background: var(--accent);
  color: #fff;
  max-width: 80%;
}

.message-assistant {
  align-self: flex-start;
  background: var(--code-bg);
  border: 1px solid var(--border);
  max-width: 90%;
}

.verdict {
  font-weight: 600;
  margin-bottom: 0.375rem;
}

.chat-input {
  display: flex;
  gap: 0.5rem;
}

.chat-input input {
  flex: 1;
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
}

.chat-input button {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}

.chat-input button:disabled {
  opacity: 0.6;
  cursor: default;
}
```

- [ ] **Step 4: Implement — wire the render tree in `ChatView.tsx`**

In `electron-app/src/renderer/ChatView.tsx`, change the import block at the top to:

```tsx
import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { MessageMarkdown } from "./MessageMarkdown";
import { AgentActivityPanel } from "./AgentActivityPanel";
import { ThemeToggle, useChatTheme } from "./ThemeToggle";
import "./theme.css";
import "./ChatView.css";
import type { AnalysisResult, HistoryMessage, IntentLens, TraceEvent, Verdict } from "../main/ipc/rendererApi";
```

Add the theme hook inside the `ChatView` function body, alongside the other `useState` calls:

```tsx
  const [theme, toggleTheme] = useChatTheme();
```

Replace the `return (...)` block with:

```tsx
  return (
    <section className="chat-view" data-theme={theme}>
      <ThemeToggle theme={theme} onToggle={toggleTheme} />
      <ul className="messages">
        {messages.map((message, index) => (
          <li key={index} className={`message message-${message.role}`}>
            {message.role === "assistant" ? (
              <>
                {message.trace.length > 0 && <AgentActivityPanel trace={message.trace} live={message.live} />}
                {message.verdict && (
                  <div className="verdict">
                    {message.verdict.direction} · {message.verdict.conviction} conviction
                  </div>
                )}
                <MessageMarkdown text={message.text} />
              </>
            ) : (
              <p>{message.text}</p>
            )}
          </li>
        ))}
      </ul>
      {error && <div className="error">{error}</div>}
      <div className="chat-input">
        <input
          aria-label="ask about an instrument"
          placeholder="Ask about an instrument…"
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <button type="button" onClick={onSend} disabled={busy}>
          {busy ? "Analyzing…" : "Send"}
        </button>
      </div>
    </section>
  );
```

The `message.trace.length > 0` guard is belt-and-suspenders — `AgentActivityPanel` already returns `null` for an empty/token-only trace (Task 5) — but it avoids mounting the component (and its `useState`) for the common case of a brand-new assistant placeholder with no trace yet.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/renderer/styleCssSplit.test.ts test/renderer/ChatView.test.tsx`
Expected: PASS (all cases green, including the two new ones).

- [ ] **Step 6: Full renderer + App regression**

Run: `npx vitest run test/renderer`
Expected: PASS — in particular `App.test.tsx` still passes, confirming `App.tsx` needed no edit for this task (it renders `<ChatView intentLens=... sessionId=... initialMessages=.../>` exactly as before; the new `data-theme`/`AgentActivityPanel`/`ThemeToggle` are entirely internal to `ChatView`'s own subtree, matching P9B§4.4's confirmation that `ChatView` mounts once inside the main window and the settings window never renders it).

- [ ] **Step 7: Confirm the settings entry doesn't pick up any new chat file**

Run: `grep -n "ChatView\|AgentActivityPanel\|TraceStepRow\|ThemeToggle\|theme.css\|ChatView.css" src/renderer/settingsMain.tsx src/renderer/SettingsWindow.tsx`
Expected: no output — `settingsMain.tsx` only imports `SettingsWindow` and `style.css`; neither settings file references any chat component, so Vite's per-entry module graph keeps all of this phase's new CSS out of the `settings` Rollup entry.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/ChatView.tsx src/renderer/ChatView.css test/renderer/ChatView.test.tsx test/renderer/styleCssSplit.test.ts
git commit -m "feat(electron-app): wire AgentActivityPanel and ThemeToggle into ChatView"
```

---

### Task 8: Final integration and safety-regression gate

**Files:** none created or modified by default — this task is a verification gate. If any check below fails, fix the specific file it points to and commit that fix on its own (e.g. `fix(electron-app): ...`) before re-running the gate; do not fold an unrelated fix into this task's (absent) commit.

**Interfaces:** none — this task consumes the finished state of Tasks 1–7 and asserts on the whole tree.

- [ ] **Step 1: Grep-confirm the `onNarrative`/`NarrativeEvent` retirement is complete**

Run: `grep -rn "onNarrative\|NarrativeEvent" src/ test/`
Expected: no output (grep exits with status 1, meaning zero matches) — confirms Task 1 removed the adapter from `rendererApi.ts` and Task 2 removed every test reference (`testBridge.ts`, `App.test.tsx`, `ChatView.test.tsx`), per P9B§15 item 2.

- [ ] **Step 2: Confirm `historyStore.ts` is untouched (verified no-op, P9B§12)**

Run: `git diff --stat main -- src/main/services/history/historyStore.ts`
Expected: no output — this plan's Task 2 only reads `HistoryMessage.trace` (already shipped by Phase 9-A); it never edits `historyStore.ts`.

- [ ] **Step 3: Confirm the safety-critical main-process suite is unaffected**

Run: `npx vitest run test/main/services/kite/kiteClient.test.ts`
Expected: PASS, unchanged — the only `src/main/**` edit in this whole plan is Task 1's deletion inside `rendererApi.ts`'s renderer-facing type/adapter surface, which shares no code path with `KiteClient`, the `claude` CLI argv builder, or any allowlist/denylist.

Run: `npx vitest run test/main`
Expected: PASS — the full main-process suite (IPC bridges, history store, sidecar, etc.) is unaffected by a renderer-only phase.

- [ ] **Step 4: Full typecheck**

Run: `npx tsc --noEmit`
Expected: no errors across `src/**`.

- [ ] **Step 5: Full test suite**

Run: `npx vitest run`
Expected: PASS — every test file in `electron-app/test/**` (main and renderer) is green.

- [ ] **Step 6: Report**

No commit for this task if all six steps above pass clean (nothing changed). If a fix was required at any step, it was already committed on its own in that step per this task's file note above.

---

## Self-review notes (fixed inline before finalizing)

- **P9B§15 item 1 (safety regression, "first")** is satisfied both early (Task 1 Step 5 runs `kiteClient.test.ts` immediately after the `rendererApi.ts` edit) and comprehensively at the end (Task 8 Steps 2–3), rather than only at the very end — matches the spirit of "first" as a priority, not a literal ordering constraint, consistent with how P9A itself phrased its own equivalent item.
- **The `AgentActivityPanel` ⇄ `TraceStepRow` mutual dependency** (the card needs to render `TraceStepRow`; `TraceStepRow` needs `LaneNode`/`ChildNode`/`NodeStatus` from the card's file) is resolved by splitting `AgentActivityPanel.tsx` into two tasks: Task 3 creates the file with only the pure types + `buildLanes` (no component, so `TraceStepRow.tsx` in Task 4 can safely type-import from it), and Task 5 appends the component (which value-imports `TraceStepRow`, already built in Task 4). No task ever requires a file that doesn't exist yet.
- **P9B§15 item 4 (token exclusion)** is split across three tasks by design, not by oversight: Task 3's `buildLanes` tests prove tokens never become panel rows; Task 2's `ChatView` test proves tokens (and only tokens) reach the bubble text; Task 5's panel test proves a token-only trace renders no panel at all. Together they cover the full claim.
- **P9B§15 item 11 (CSS split sanity)** initially risked being "vibes-only" — added a concrete `styleCssSplit.test.ts` (Task 7) that regex-asserts `style.css` gained no chat rules and `ChatView.css` has them, rather than relying on manual inspection.
- **`App.tsx`** was confirmed unchanged both by direct comparison of `ChatView`'s prop signature across every task (`ChatViewProps` never changes) and by Task 7 Step 6 explicitly re-running `App.test.tsx` after the render-tree wiring lands.
- **No Rust-side task** exists in this plan — confirmed against P9B§1/§16: this phase is pure UI/display work with zero `rust-core/` changes, unlike P9A.
