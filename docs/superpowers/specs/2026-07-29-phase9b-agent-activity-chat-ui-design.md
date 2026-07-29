# Phase 9-B — Agent Activity Chat UI

Status: approved by user 2026-07-29 (brainstorming dialogue), pending implementation planning.
Author: design produced via `superpowers:brainstorming`. Section references: "P9B§N" → this document; "P9A§N" → the immediately-prior phase, `docs/superpowers/specs/2026-07-28-phase9a-persona-streaming-plumbing-design.md`; "§N" → the master roadmap `docs/superpowers/specs/2026-07-18-trade-assistant-design.md`. The house structure/tone mirrors P9A.

This phase is **pure UI/display work**. Phase 9-A built the entire `analysis:trace` event stream — per-persona `started`/`toolCall`/`toolResult`/`token`/`done`/`error` events plus per-algorithm sidecar progress — and explicitly deferred every pixel of the UI that renders it to this phase (P9A§15). Phase 9-B builds that UI: a styled, collapsible, IDE-chat-style Agent Activity panel and a dedicated CSS layer, consuming the already-existing read-only telemetry stream and nothing else.

## P9B§1 Purpose

The app is a packaged desktop trading *assistant*: Electron + TypeScript + React shell, a Rust compute core (`rust-core/`) run as a sidecar subprocess, and Claude reached via the `claude` CLI. Its `ai_assisted` mode runs a six-persona pipeline — **intake**, then **options_greeks / technical_quant / position_risk** in parallel, then **synthesis**, then **narrative** — with Rust doing pure candle-data compute in between. Rust computes; Claude reasons; **the human makes every buy/sell decision.**

**Permanent, non-negotiable safety property (re-stated because every spec re-states it):** the app never places, modifies, cancels, or automates any order on Zerodha Kite — ever. It is an assistant, not a trader. P9B§3 shows why this phase cannot touch that guarantee: it renders an existing read-only stream and adds no new IPC, no new Kite/broker call, and no main-process behavior of any kind.

**The gap this phase closes.** After Phase 9-A shipped (merged to `main`), the six-persona pipeline and the Rust sidecar emit a rich `TraceEvent[]` stream over the unified `analysis:trace` channel, and each assistant turn's full trace is persisted alongside it. But **nothing displays any of it.** `ChatView.tsx` still shows only user/assistant bubbles, fed by a temporary `onNarrative` compatibility adapter that P9A deliberately left in place so the renderer stayed byte-unchanged (P9A§10.1, §15). The user's original three-part ask (from the session that produced Phase 9-A) was:

1. **Show everything** — all subagent/persona activity and Rust progress — on the chat UI, IDE-chat-style (Claude Code / GitHub Copilot chat), with some rows collapsed by default and some not.
2. **Properly style the chat UI** with dedicated CSS files, sub-components getting their own CSS files.
3. **Fix the timeout/model issue** — *already delivered by Phase 9-A* (uniform Haiku 4.5, per-persona timeouts). Not this phase's concern.

Phase 9-B delivers (1) and (2): it retires the `onNarrative` adapter, subscribes `ChatView` directly to `onTrace`, and renders the trace as a collapsible per-persona / per-algorithm activity panel between each user message and the assistant's reply, with a themed, dedicated CSS layer. It changes no main-process code.

## P9B§2 Scope

**In scope (each specified precisely in its own section):**

1. Retire the `onNarrative` / `NarrativeEvent` compatibility adapter and subscribe `ChatView` directly to `onTrace` (P9B§5).
2. Accumulate trace events per assistant turn into a new `AssistantMessage.trace` field, appended live as events arrive for the matching `requestId`; narrative `token` events still drive the assistant bubble text (P9B§6).
3. `AgentActivityPanel` — the collapsible per-turn activity card that builds one lane per `TraceSource` in fixed pipeline order and splits sidecar events into a request-level bracket plus per-algorithm children (P9B§7).
4. `TraceStepRow` — the recursive status-row primitive: status icon, label, caret, auto-expand-on-start / auto-collapse-on-done / stay-expanded-on-error, manual-toggle override, and history-replay (`live={false}`) behavior (P9B§8).
5. `ThemeToggle` + `theme.css` — a `.chat-view`-scoped dark/light theme with a persisted toggle (P9B§9).
6. `ChatView.css` and the global-vs-dedicated CSS split (P9B§10).
7. `historyToChatMessages` maps persisted `HistoryMessage.trace` onto the reconstructed `AssistantMessage.trace` so replay renders the same panel with `live={false}` (P9B§11).

**Not in scope (P9B§16 has the full list):**

- Any change to the no-order-placement safety invariant — unaffected by construction (P9B§3). Permanent.
- Any change to main-process trace emission — Phase 9-A built and shipped all of it; no `src/main/**` file except the removal of the retired `onNarrative` adapter in `rendererApi.ts` is touched (P9B§5, §16).
- Any change to `engine_only` mode — it invokes no personas, carries no trace, and renders no panel (P9B§7, §16).
- Any new IPC channel, preload change, or Kite/broker call of any kind (P9B§3).
- Any change to `historyStore.ts` — `HistoryMessage.trace` already exists from Phase 9-A; a **verified no-op** (P9B§12).

**Locked decisions written up verbatim (from the completed brainstorming session; none re-litigated here):**

1. **Show everything, IDE-chat-style.** All six personas' activity plus Rust per-algorithm progress render inline between the user bubble and the assistant reply. Collapsed-by-default vs expanded is governed by a precise auto-behavior (P9B§8), not ad-hoc.
2. **A lane appears only once it has started.** No placeholder/"queued" rows for a `TraceSource` that has emitted no event yet. This was an explicit, deliberate user requirement, not an incidental rendering choice.
3. **Failures are never silently hidden.** An `error` terminal state is the one status that does *not* auto-collapse; an errored row stays expanded.
4. **Dedicated CSS files, sub-components get their own.** `AgentActivityPanel.css`, `TraceStepRow.css`, `ThemeToggle.css`, `ChatView.css`, and a shared `theme.css` of CSS custom properties; every new file consumes the theme variables rather than hardcoding colors.
5. **Theme is scoped to `.chat-view`, not app-wide.** `ChatView` mounts once inside the main window (P9B§4), so the theme flips a `data-theme` attribute on the `.chat-view` root subtree only; the choice persists in `localStorage`, defaulting to dark.
6. **The `onNarrative` adapter is retired here.** P9A§15 states verbatim that "Phase 9-B deletes the `onNarrative` adapter when it builds the real trace-consuming UI on `onTrace`." This phase does exactly that.

## P9B§3 The permanent no-order-placement safety invariant is unaffected (load-bearing)

**Placed early and deliberately: this is why a pure-display phase is the lowest-risk kind of change in this codebase.**

The §2/§4 guarantee — *the app never places, modifies, cancels, or automates any order, ever* — is enforced entirely in the main process: the shape of `KiteClient`, the `claude` CLI `--allowedTools`/`--disallowedTools`/`--strict-mcp-config` argv, and the sidecar's I/O-free compute surface. **Phase 9-B touches none of that machinery**, and it touches it in the strongest possible way — by construction:

- **No new IPC surface.** This phase adds no channel, no `ipcMain.handle`, no preload change. It consumes the pre-existing `analysis:trace` channel Phase 9-A already built, purely as a subscriber. The only IPC-adjacent edit is the *removal* of the retired `onNarrative` adapter from `rendererApi.ts` — deleting a read-only subscription, never adding one (P9B§5).
- **No new Kite/broker call.** No renderer code in this phase calls `runAnalysis`'s underlying Kite path differently, adds a Kite request, or reaches any broker API. It renders an array of already-emitted `TraceEvent`s. The renderer has no order surface to begin with, and this phase adds none.
- **Read-only telemetry, rendered.** A `TraceEvent` is a description of something that already happened (a persona started, a read-tool returned, an algorithm finished). Rendering it cannot cause a tool to run, an order to place, or any side effect — it is text and status icons drawn from a persisted/streamed array. A `toolResult` row can only ever describe a *read* tool result, because P9A§3 established that no write tool is reachable, and this phase changes nothing about that allowlist.
- **No main-process behavior change.** Zero `src/main/**` logic changes except deleting the `onNarrative`/`NarrativeEvent` compat shim in `rendererApi.ts` (a type-and-adapter removal, not a behavior change: the main process already emits only `TraceEvent`s, never `NarrativeEvent`s — P9A§10.1).

Restated for completeness, as in every phase: **nothing here touches order placement; this phase adds no order-related surface of any kind.** The existing `kiteClient.test.ts` exact-read-method allowlist test requires zero changes and continues to pass unmodified.

## P9B§4 Current state (verified against the tree)

All line references below were read directly from the working tree on the `phase-3-electron-kite-mcp` branch.

### P9B§4.1 The trace types and the retired adapter (`src/main/ipc/rendererApi.ts`)

Phase 9-A's public trace types exist verbatim and are consumed unchanged by this phase:

```typescript
// rendererApi.ts:69-91
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
```

The **retired** compatibility surface (all deleted by this phase, P9B§5):

- `NarrativeEvent` interface — `rendererApi.ts:93-98`: `{ requestId: string; chunk?: string; done?: boolean; error?: string }`.
- `RendererApi.onNarrative(handler: (event: NarrativeEvent) => void): void` — declared `rendererApi.ts:105`.
- `RendererApi.onTrace(handler: (event: TraceEvent) => void): void` — declared `rendererApi.ts:106` (kept).
- In `buildRendererApi` (`rendererApi.ts:118-144`): `onTrace` subscribes `"analysis:trace"` (line 125, kept); the `onNarrative` adapter (lines 126-133) subscribes the *same* `"analysis:trace"` channel, filters `source === "narrative"`, and reshapes `token`/`done`/`error` back into the legacy `NarrativeEvent` (deleted).

Verified by grep: the only references to `onNarrative` / `NarrativeEvent` anywhere in `src/` are `rendererApi.ts` (lines 93, 105, 126) and `ChatView.tsx` (lines 4, 47). The main process emits **no** `NarrativeEvent` — Phase 9-A's `analysis:narrative` channel is already fully gone (zero grep hits for `analysis:narrative` / `NARRATIVE_CHANNEL` / `sendNarrative` / `narrativeBridge` in `src/`). Additional references live only in the test tree (P9B§4.6).

### P9B§4.2 The chat view (`src/renderer/ChatView.tsx`, 123 lines)

- Imports `NarrativeEvent` (among others) from `rendererApi` — line 4.
- `AssistantMessage` interface — lines 12-17: `{ role: "assistant"; requestId: string; text: string; verdict?: Verdict }`.
- `UserMessage` interface — lines 19-22: `{ role: "user"; text: string }`.
- `ChatMessage = UserMessage | AssistantMessage` — line 24.
- `newRequestId()` — lines 26-28.
- `historyToChatMessages(messages)` — lines 30-37: maps `HistoryMessage[]` → `ChatMessage[]`; for assistant rows reads `verdict` from `structured_payload` and returns `{ role: "assistant", requestId: newRequestId(), text: message.rendered_text, verdict }` (no `trace` today).
- `ChatView(...)` — line 39; local state lines 40-44: `messages`, `input`, `busy`, `error`, and `activeRequestId = useRef<string | null>(null)`.
- The `onNarrative` subscription — `useEffect` lines 46-60: filters `event.requestId !== activeRequestId.current`, appends `event.chunk` to the matching assistant message's `text`, and `setError(event.error)` on error.
- `onSend()` — lines 62-87: allocates a `requestId`, sets `activeRequestId.current`, appends `{ role: "user", text: query }` and `{ role: "assistant", requestId, text: "" }`, awaits `bridge().runAnalysis({ mode: "ai_assisted", … })`, and on `ai_assisted` success replaces the assistant message's `text`/`verdict`; the `catch` sets `error` from the rejected promise (lines 82-83) — the authoritative run-failure path.
- Render — lines 89-122: `<section className="chat-view">` (90) → `<ul className="messages">` (91) → `<li className={\`message message-${message.role}\`}>` (93); assistant branch renders `<div className="verdict">` (96-100) then `<MessageMarkdown text={message.text} />` (101); `{error && <div className="error">…}` (109); `<div className="chat-input">` (110-120).

### P9B§4.3 The current stylesheet (`src/renderer/style.css`, 74 lines) and CSS bundling

`style.css` is imported by **both** renderer entries — `main.tsx:3` (renders `App`) and `settingsMain.tsx:3` (renders `SettingsWindow`). It contains: `body` (1-5), `.app h1` (7-9), `.status` (11-14), `.banners` (16-20), `.error` (22-25), `.analysis-form`/`.analysis-result` (27-30), `.results` (32-35), `.message-markdown` and its table rules (37-49), and `.mermaid` rules (51-73).

**Verified:** `style.css` today contains **no** `.chat-view`, `.messages`, `.message`, `.message-user`, `.message-assistant`, `.chat-input`, or `.verdict` rule. The chat surface is entirely unstyled. So this phase's `ChatView.css` introduces those rules *net-new* — it does **not** move existing chat rules out of `style.css`, because none exist (P9B§10 states the precise consequence).

`electron.vite.config.ts` builds the renderer with two Rollup inputs — `index.html` (the main window) and `settings.html` (the settings window). CSS imported from a `.tsx` module is bundled into whichever entry's graph imports it, so importing the new chat CSS from the chat components lands it only in the `index` entry — the settings window never imports `ChatView` and stays unaffected (P9B§10).

### P9B§4.4 Mount point and other verified facts

- **`ChatView` mounts once, inside the main window** — `App.tsx:175-179`, in the branch `activeSession !== null && authenticated && activeSession.mode !== "engine_only"` (App.tsx:164-181). `App` is the `index.html` entry's root (`main.tsx`); the settings window is a separate entry (`settingsMain.tsx` → `SettingsWindow`) that never renders `ChatView`. So scoping the theme to `.chat-view`'s own subtree (P9B§9) is correct and cannot leak into the settings window or the app chrome.
- **`bridge()`** returns `window.tradeAssistant as RendererApi` — `bridge.ts:3-5`; it already exposes `onTrace` (P9B§4.1).
- **`Verdict`** — `contracts.ts:19-25`: `{ direction; conviction; reasoning; cited_algo_ids; verify_before_acting }`, re-exported from `rendererApi`.
- **`MessageMarkdown`** — `MessageMarkdown.tsx:9-33`, renders `.message-markdown`; shared by the chat and `engine_only` `AnalysisResult` views, so its `.message-markdown` rule is global (P9B§10).

### P9B§4.5 Persistence is already complete (`src/main/services/history/historyStore.ts`)

Phase 9-A already shipped the full `trace` persistence path — **no change is needed here** (P9B§12):

- `HistoryMessage.trace: TraceEvent[] | null` — `historyStore.ts:20`.
- `AppendMessageParams.trace?: TraceEvent[]` — `historyStore.ts:35`.
- `trace TEXT` column in the `CREATE TABLE messages` — `historyStore.ts:86`; the idempotent `ensureColumn("messages", "trace", "TEXT")` migration — call at line 98, definition lines 119-124.
- Insert binding `params.trace === undefined ? null : JSON.stringify(params.trace)` — `historyStore.ts:112`.
- `getSession` SELECT includes `trace` (line 169) and parses it `row.trace === null ? null : JSON.parse(row.trace) as TraceEvent[]` (line 186).

So a replayed assistant turn already arrives at the renderer with `HistoryMessage.trace` populated (or `null` for `engine_only` / pre-column rows). All this phase must do is consume it (P9B§11).

### P9B§4.6 Test surface that references the retired adapter

Removing `onNarrative`/`NarrativeEvent` (P9B§5) will not compile against the current tests, which mock the retired API. These files must be updated in lockstep (P9B§15, §16):

- `test/renderer/testBridge.ts:8` — `onNarrative: vi.fn()` in the mock bridge.
- `test/renderer/App.test.tsx:174` — `onNarrative: vi.fn()`.
- `test/renderer/ChatView.test.tsx` — imports `NarrativeEvent` (line 6), captures a `narrativeHandler` (lines 12-15), and installs `onNarrative` mocks (lines 54, 71). This suite is rewritten to drive `onTrace`.
- `test/main/ipc/rendererApi.test.ts:16,67,73` — asserts `onNarrative` is on the API and that the adapter subscribes `analysis:trace`. The `onNarrative`-specific assertions are removed; the `onTrace` assertions stay.

## P9B§5 Decision 1 — retire `onNarrative`, subscribe `ChatView` to `onTrace`

### P9B§5.1 Remove the compat adapter from `rendererApi.ts`

Delete three things, leaving `onTrace` as the sole trace subscription:

- The `NarrativeEvent` interface (`rendererApi.ts:93-98`).
- `onNarrative` from the `RendererApi` interface (`rendererApi.ts:105`).
- The `onNarrative` adapter in `buildRendererApi` (`rendererApi.ts:126-133`).

After removal, `buildRendererApi`'s trace wiring is exactly the one retained line:

```typescript
onTrace: (handler) => subscribe("analysis:trace", handler as (p: unknown) => void),
```

Nothing else in `rendererApi.ts` changes — `TraceEvent`/`TraceSource`/`TraceKind`/`TraceEventInput`/`TraceEmitter` stay verbatim. The main process is untouched: it already emits only `TraceEvent`s on `analysis:trace` (P9A§10.3), so deleting the renderer-side legacy reshape removes dead compatibility, not live behavior.

### P9B§5.2 Point `ChatView` at `onTrace`

`ChatView.tsx` line 4 drops `NarrativeEvent` from its import and adds `TraceEvent`:

```typescript
import type { AnalysisResult, HistoryMessage, IntentLens, TraceEvent, Verdict } from "../main/ipc/rendererApi";
```

The `onNarrative` `useEffect` (lines 46-60) is replaced by an `onTrace` subscription (the accumulation logic is P9B§6). No other renderer file references `onNarrative`, so no further renderer edits are required for the retirement itself.

## P9B§6 Decision 2 — per-turn trace accumulation + narrative token handling

### P9B§6.1 `AssistantMessage` gains `trace` and `live`

```typescript
interface AssistantMessage {
  role: "assistant";
  requestId: string;
  text: string;
  verdict?: Verdict;
  trace: TraceEvent[]; // NEW — accumulated live from onTrace, or reconstructed from history
  live: boolean;       // NEW — renderer-only: true for turns streamed in this mount, false for replayed turns
}
```

`trace` holds every non-token trace event for this turn (P9B§6.3). `live` is a **renderer-only** provenance flag — never persisted, never part of `HistoryMessage` — that the panel needs to choose between streaming behavior (auto-expand/collapse) and static history behavior (collapsed-by-default). It is the only clean way to keep a just-completed turn's errored lanes expanded while replayed turns render collapsed (P9B§8.4 explains why `busy` cannot substitute). It is set `true` for turns created in `onSend` and `false` for turns reconstructed by `historyToChatMessages` (P9B§11).

### P9B§6.2 The `onTrace` subscription replaces the `onNarrative` one

```tsx
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
```

Key points, all mirroring the existing `activeRequestId.current` filtering:

- **`requestId` filtering is unchanged** — events for any other (or a stale) request are ignored, identical to the old adapter's guard.
- **Narrative `token` → bubble text.** A `source === "narrative"` `kind === "token"` event appends its `detail` (the literal chunk, per P9A§10.2) to `message.text`, replacing the old `event.chunk` handling. These token events are **not** pushed into `message.trace`, so they never reach the panel.
- **Every other event → `message.trace`.** `started`/`toolCall`/`toolResult`/`done`/`error` for every lane (personas *and* sidecar) accumulate in arrival order.
- **No `setError` from trace.** The old adapter set the top-level error banner from `event.error`. That is dropped: per-step failures now render as error rows in the panel (P9B§8.3), and the single authoritative run-level error remains the rejected `runAnalysis` promise handled by `onSend`'s existing `catch` (`ChatView.tsx:82-83`). Because every trace `error` is always followed by the promise rejection (P9A§12), no failure is lost by not reading trace errors here (P9B§13).

### P9B§6.3 Token filtering is centralized in the panel too

The persisted trace array (read back on replay, P9B§4.5) **does** contain narrative `token` events — Phase 9-A accumulates every emitted event for persistence (P9A§11.3, §13). To keep live and replay identical, the panel's tree builder (P9B§7.2) filters `kind === "token"` unconditionally. So even though the live `onTrace` handler already avoids storing tokens, the builder still drops any it sees, and a replayed turn (whose stored array includes tokens) renders exactly like the live turn: tokens in the bubble, never in the panel. This one filtering rule is the single source of truth for "tokens are bubble-only."

### P9B§6.4 `onSend` and the render tree

`onSend` creates the assistant placeholder with the two new fields:

```tsx
setMessages((prev) => [
  ...prev,
  { role: "user", text: query },
  { role: "assistant", requestId, text: "", trace: [], live: true },
]);
```

On `ai_assisted` success it still replaces `text`/`verdict` (the authoritative final narrative and verdict) and leaves `trace`/`live` as accumulated — by success time every lane's `done` has already arrived via `onTrace`.

The assistant `<li>` renders the panel above the verdict and markdown, so it sits visually between the user's message and the assistant's reply:

```tsx
{message.role === "assistant" ? (
  <>
    {message.trace.length > 0 && (
      <AgentActivityPanel trace={message.trace} live={message.live} />
    )}
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
```

`AgentActivityPanel` itself returns `null` for an empty/token-only trace (P9B§7.3), so the `message.trace.length > 0` guard is belt-and-suspenders; `engine_only` turns never reach `ChatView` anyway (they render through `AnalysisResultView`, App.tsx:171).

## P9B§7 Decision 3 — `AgentActivityPanel` and trace-tree construction

New files: `src/renderer/AgentActivityPanel.tsx` + `src/renderer/AgentActivityPanel.css`.

### P9B§7.1 Fixed pipeline lane order

The panel renders one lane per `TraceSource`, in a **fixed pipeline order that reflects execution, not the union's declaration order**:

```typescript
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
```

Note `intake` precedes `sidecar` here, whereas the `TraceSource` union (rendererApi.ts:69-76) lists `sidecar` first. That is deliberate: `intake` runs before envelope assembly (Rust compute), so the panel orders lanes the way the pipeline actually executes (P9A§1: intake → envelope/sidecar → three analytical personas → synthesis → narrative).

**A lane is rendered only once at least one event for its source has arrived** (locked decision 2, P9B§2): `LANE_ORDER` fixes the *order* of whatever lanes exist, but a source with zero events produces no lane — no placeholder, no "queued" row. This is an explicit, deliberate user requirement, not an incidental omission.

### P9B§7.2 The pure tree builder

Tree construction is a pure function (no I/O, no React) — following CLAUDE.md's pure-logic-vs-side-effect split, it lives beside the component and is unit-tested directly (P9B§15):

```typescript
export type NodeStatus = "running" | "done" | "error";

export type ChildNode =
  | { kind: "algo"; label: string; status: NodeStatus }                     // sidecar per-algorithm leaf
  | { kind: "tool"; variant: "toolCall" | "toolResult"; detail: string };   // persona tool leaf

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
  return "running"; // a lane only exists once its first (always `started`) event arrived
}

// A sidecar event is a per-algorithm child iff it is a non-error progress line whose
// `detail` is an algorithm id — i.e. present and not the reserved request-step "compute"
// (the `detail === "compute"` rule, P9A§9.3). Errors are always the request-level bracket:
// Rust emits only running/done per algorithm, never an error, so the lone sidecar error
// (from assembleEnvelope, P9A§7/§12) can only be the compute bracket failing.
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
      const bracket = events.filter((e) => !isAlgoEvent(e)); // detail "compute" + any error
      const algos = new Map<string, TraceEvent[]>();
      for (const e of events) {
        if (!isAlgoEvent(e)) continue;
        const id = e.detail as string;
        const g = algos.get(id);
        if (g) g.push(e);
        else algos.set(id, [e]); // first-seen order = registry order (P9A§9.1)
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

The sidecar split is the one subtle rule and is stated exactly per P9A§9.3: `detail === "compute"` is the request-level bracket (the lane's own status); any other `detail` is one algorithm, grouped into a child in first-arrival (registry) order. A sidecar `error` never carries `"compute"` as its `detail` — its `detail` is the error message (P9A§10.2) — so `isAlgoEvent` classifies it as bracket, which is correct: there is exactly one sidecar error and it is always the compute bracket failing (P9A§12), never a per-algorithm error (Rust emits only `running`/`done` per algorithm, P9A§9.3).

### P9B§7.3 The component

```tsx
import "./AgentActivityPanel.css";

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

- **`useState(open)` is called before the empty-trace early return** so the hook is unconditional (React's rules of hooks).
- **Empty trace → `null`.** A turn with no lanes — `engine_only` (which never carries a trace, P9B§16) or a trace containing only tokens — renders nothing.
- **The card's own default follows `live`.** Open while the turn is streaming (so activity is visible as it arrives); collapsed on history replay (`live === false`) to keep replayed transcripts compact. This is the same philosophy as the per-row replay behavior (P9B§8.4); it is a presentational default, not a load-bearing requirement, and the user can always toggle the card header.

## P9B§8 Decision 4 — `TraceStepRow`, the recursive status-row primitive

New files: `src/renderer/TraceStepRow.tsx` + `src/renderer/TraceStepRow.css`.

`TraceStepRow` renders a `LaneNode` or an `algo` `ChildNode` — a status row with an icon, a label, a caret, and (for lanes) nested children. The `tool` `ChildNode` shape is a distinct, hookless leaf (`ToolLeafRow`) co-located in the same file, because a `tool` leaf has no status and no expansion. Keeping the two shapes in one file matches the "two child shapes" responsibility (locked decision 4, P9B§2) while respecting React's rules of hooks — `TraceStepRow` always calls its hooks; `ToolLeafRow` calls none.

### P9B§8.1 Status icons and the row

```tsx
import "./TraceStepRow.css";

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

- **Status icon derivation.** `NodeStatus` is derived once in the builder (`statusFrom`, P9B§7.2) from whether a `done`/`error` kind was seen versus only `started`. The row just maps it to `⟳` / `✓` / `✗`.
- **Two child shapes.** (a) sidecar per-algorithm children are `algo` `BracketNode`s rendered recursively as `TraceStepRow`s — status icon + label only, no caret (they have no children), no further nesting (sidecar events carry no `toolCall`/`toolResult`). (b) persona `toolCall`/`toolResult` leaves are `ToolLeafRow`s: a single line rendering the event's `detail` **verbatim** in a monospace `<code>` block. The `detail` is already summarized/truncated to 200 chars by the main process (P9A§8.5); this phase does **not** re-summarize, re-truncate, or expand it — there is no more detail available, so the row shows exactly what arrived.

### P9B§8.2 Auto-expand / auto-collapse (live turns)

For a `live` turn, `auto = status === "running" || status === "error"`:

- **Auto-expand on start.** When a row's `started` arrives, `statusFrom` yields `running`; with no manual override, `auto` is `true`, so the row is expanded the instant it starts — its children (tool calls, per-algorithm progress) stream visibly.
- **Auto-collapse on done.** When the row reaches `done`, the `useEffect` (keyed on `node.status`) clears any override to `null`, and `auto` becomes `false` — the row collapses, tucking the finished step away.
- **Stay-expanded on error.** `error` is the one terminal state where `auto` stays `true`, so a failed row remains expanded — **failures are never silently hidden** (locked decision 3, P9B§2).

### P9B§8.3 Manual toggle override

Clicking the caret sets `override` to `!expanded`. `expanded = override ?? auto`, so a manual toggle wins over auto-behavior. The `useEffect(() => setOverride(null), [node.status])` clears the override **only when the row's status transitions**. Since a row's status never changes again after reaching a terminal `done`/`error`, a manual toggle on a terminal row is honored for the rest of that row's life (e.g. re-collapsing a manually-reopened `done` row sticks; reopening an auto-collapsed `done` row sticks). While a row is still `running`, a manual collapse is honored until the running→terminal transition, at which point auto takes back over — a deliberate, minimal rule with no ambiguity because status transitions are monotonic and one-way.

### P9B§8.4 History replay (`live={false}`)

When `live` is `false`, `auto` is `false` for every status — including `error` — so **every row renders collapsed by default**, with no auto-expand-on-start and no auto-collapse-on-done transitions (nothing is "in progress" retroactively in a replayed transcript). The user can still manually expand/collapse any row (the caret and `override` work identically). This is why a provenance `live` flag is needed rather than deriving from `busy` (P9B§6.1): a turn that just streamed live and errored must keep its error lane expanded (`live` stays `true` after completion), while the same turn reloaded from history renders collapsed (`live` is `false`); a `busy`-derived flag would flip to `false` the moment the run finished and wrongly collapse the just-errored lane.

## P9B§9 Decision 5 — `ThemeToggle` and `theme.css`

New files: `src/renderer/ThemeToggle.tsx` + `src/renderer/ThemeToggle.css`, and `src/renderer/theme.css`.

### P9B§9.1 Theme variables (`theme.css`)

CSS custom properties scoped under the two `.chat-view[data-theme]` selectors; every other new CSS file in this phase consumes these variables rather than hardcoding colors, so the two themes stay consistent:

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

Because the variables are declared on `.chat-view[data-theme=…]`, they cascade to the whole `.chat-view` subtree (panel, rows, input, bubbles) and nowhere else. `theme.css` is imported once, from `ChatView.tsx` (the subtree root), so it is bundled into the `index` entry only.

### P9B§9.2 The toggle and its persisted state

The `data-theme` attribute must live on the element `ChatView` renders (`<section className="chat-view">`), so `ChatView` owns applying it. The persisted state + read-on-mount logic is owned by `ThemeToggle.tsx` via a small co-located `useChatTheme` hook, keeping the persistence responsibility with the toggle file while the attribute stays on the element its owner renders:

```tsx
import "./ThemeToggle.css";

const THEME_KEY = "chatTheme";
export type ChatTheme = "dark" | "light";

export function useChatTheme(): [ChatTheme, () => void] {
  const [theme, setTheme] = useState<ChatTheme>(() => {
    const saved = globalThis.localStorage?.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : "dark"; // default dark when unset
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

`ChatView` wires it into its own root and renders the button top-right inside `.chat-view` (not app-wide — `ChatView` mounts once in the main window, P9B§4.4):

```tsx
const [theme, toggleTheme] = useChatTheme();
return (
  <section className="chat-view" data-theme={theme}>
    <ThemeToggle theme={theme} onToggle={toggleTheme} />
    {/* messages, error, chat-input … */}
  </section>
);
```

- **Scoped, not app-wide.** `data-theme` sits on `.chat-view`, so the theme governs only the chat subtree; the app chrome (`App.tsx`'s `<main className="app">`) and the separate settings window are unaffected.
- **Persistence.** The choice is written to `localStorage["chatTheme"]` on every toggle and read on mount, defaulting to `"dark"` when unset (or when a stored value is neither `"light"` nor `"dark"`). `globalThis.localStorage?.` guards keep the hook safe in a non-DOM test environment.

## P9B§10 Decision 6 — `ChatView.css` and the global-vs-dedicated split

New file: `src/renderer/ChatView.css`, imported from `ChatView.tsx`.

### P9B§10.1 What is net-new vs what stays global

`style.css` today contains **no** chat-specific rules (P9B§4.3), so this phase does not *move* chat rules out of `style.css` — it introduces them net-new in `ChatView.css`. The precise split:

| Rule | Where it lives after this phase | Why |
| --- | --- | --- |
| `.chat-view`, `.messages`, `.message`, `.message-user`, `.message-assistant`, `.chat-input`, `.verdict` | **New in `ChatView.css`** | Chat-view-specific; do not exist in `style.css` today; consume the `theme.css` variables |
| `.error` (`style.css:22-25`) | **Stays global** in `style.css` | Shared with the `engine_only` / login views (`App.tsx:160,170`) — not chat-specific |
| `.message-markdown` + table rules (`style.css:37-49`) | **Stays global** in `style.css` | Rendered by the shared `MessageMarkdown` component, used by both the chat and `AnalysisResult` views |
| `.mermaid` rules (`style.css:51-73`) | **Stays global** in `style.css` | Shared markdown rendering, not chat-specific |
| `body`, `.app h1`, `.status`, `.banners`, `.analysis-form`, `.analysis-result`, `.results` (`style.css:1-35`) | **Stays global** in `style.css` | App-chrome / other-view rules |

Net effect on `style.css`: **nothing is deleted or moved** — every existing rule is either app-chrome or shared across views. `ChatView.css` is purely additive.

### P9B§10.2 CSS content and import strategy

`ChatView.css` styles the bubbles (user vs assistant visually distinguished via `.message-user` / `.message-assistant`), the message-list layout (`.messages`, `.message`), the input bar (`.chat-input`), and the `.verdict` badge — all in terms of `var(--bg)`, `var(--fg)`, `var(--border)`, `var(--accent)`, etc. from `theme.css`. `.chat-view` is `position: relative` so `.theme-toggle` (in `ThemeToggle.css`) can sit top-right absolutely.

Each component imports its own stylesheet, so Vite bundles them into the `index` entry only (the settings window never imports `ChatView`, P9B§4.3):

- `ChatView.tsx` → `import "./theme.css"; import "./ChatView.css";`
- `AgentActivityPanel.tsx` → `import "./AgentActivityPanel.css";`
- `TraceStepRow.tsx` → `import "./TraceStepRow.css";`
- `ThemeToggle.tsx` → `import "./ThemeToggle.css";`

`AgentActivityPanel.css` styles the collapsible card (`.agent-activity`, `.agent-activity-head`, `.agent-activity-caret`, `.agent-activity-lanes`). `TraceStepRow.css` styles the rows (`.trace-step`, `.trace-step-head`, `.trace-step-icon`, `.trace-step-caret`, `.trace-step-label`, `.trace-step-children`) and tool leaves (`.trace-tool`, `.trace-tool-detail` as a monospace code block over `var(--code-bg)`), color-coding the status icon via `.trace-step-running`/`-done`/`-error` against `var(--status-running)`/`-done`/`-error`. This keeps each file small and single-responsibility per CLAUDE.md's structure rule.

## P9B§11 History replay — `historyToChatMessages`

`historyToChatMessages` (`ChatView.tsx:30-37`) gains the two new `AssistantMessage` fields, mapping the already-persisted `HistoryMessage.trace` (P9B§4.5) onto `trace` (defaulting `null` → `[]`) and marking replayed turns `live: false`:

```tsx
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
```

A replayed assistant turn therefore renders the same `AgentActivityPanel` with `live={false}`: every lane and row is reconstructed from the persisted `TraceEvent[]` and rendered fully collapsed by default, with no auto-transitions (P9B§8.4). An `engine_only` turn (or any pre-column row) has `trace: null` → `[]`, so `buildLanes` returns no lanes and the panel renders nothing (P9B§7.3).

## P9B§12 `historyStore.ts` — verified no-op

**No change is required to `src/main/services/history/historyStore.ts`.** Phase 9-A already added `HistoryMessage.trace` (line 20), `AppendMessageParams.trace` (line 35), the `trace TEXT` column and its idempotent `ensureColumn` migration (lines 86, 98, 119-124), the insert binding (line 112), and the `getSession` parse (lines 169, 186). This item is called out explicitly as a **verified no-op** so the implementation plan does not spend a task re-verifying or re-touching a file that is already correct (P9B§4.5).

## P9B§13 Error / failure semantics

This phase changes no error *production* — Phase 9-A owns all of that (P9A§12). It only changes how failures are *displayed*, and does so additively:

- **Run-level failure → the top-level `.error` div, driven by the rejected promise.** `onSend`'s existing `try/catch` (`ChatView.tsx:82-83`) sets `error` from the rejected `runAnalysis` promise, unchanged. This remains the single authoritative run-failure signal, exactly as P9A§12 designed. The retired `onNarrative` handler's `setError(event.error)` is dropped (P9B§6.2) with no loss: every trace `error` is always accompanied by the promise rejection (P9A§12), so the top-level banner still fires on every failure.
- **Per-step failure → an error row in the panel.** A `kind === "error"` event (from any persona, or the single sidecar compute-bracket error) sets that lane's `NodeStatus` to `error` via `statusFrom`, drawing a `✗` icon and — on a live turn — keeping the lane expanded so the error `detail` (e.g. `"persona intake timed out after 20000ms"`, `"sidecar compute timed out after 20000ms"`) is visible in whatever child rows exist. This is new, per-step attribution that the old `onNarrative` path could not show.
- **No per-algorithm error exists.** Rust emits only `running`/`done` per algorithm (P9A§9.3), so an algorithm that fails mid-compute simply omits its `done` and its `algo` child stays `running` (`⟳`) while the request-level sidecar lane still reaches its terminal state. `isAlgoEvent` guarantees the one sidecar `error` is always classified as the request-level bracket (P9B§7.2).
- **Kite fetch timeout emits no trace event** (there is no `"kite"` `TraceSource`, P9A§7/§12), so it produces no lane and no row; it surfaces solely via the rejected promise → the `.error` div. This is correct and unchanged.

Because the panel is a pure function of the accumulated `TraceEvent[]`, a partially-complete turn (some lanes still `running` when the run rejects) renders faithfully: completed lanes show `✓`, the failed lane shows `✗` and stays expanded, and any lane that never started shows no row at all.

## P9B§14 End-to-end data flow

**Live turn:**

1. `onSend` allocates `requestId`, sets `activeRequestId.current`, appends `{ role: "assistant", requestId, text: "", trace: [], live: true }`, and awaits `runAnalysis` (P9B§6.4).
2. The main process runs the pipeline and emits `TraceEvent`s on `analysis:trace` (Phase 9-A, unchanged). The generic preload `subscribe` forwards them to `bridge().onTrace`.
3. `ChatView`'s `onTrace` handler filters by `activeRequestId.current`, appends every non-token event to the matching `AssistantMessage.trace`, and streams narrative `token` `detail` into `message.text` (P9B§6.2).
4. `AgentActivityPanel` calls `buildLanes(message.trace)` → ordered `LaneNode[]` with per-algorithm/tool children (P9B§7.2); `TraceStepRow` renders each lane with live auto-expand/collapse (P9B§8.2).
5. On resolve, `onSend` writes the final `text`/`verdict`; `trace`/`live` are already accurate. On reject, the `catch` sets the `.error` div (P9B§13).

**Replay turn:**

1. `App` opens a session → `getSession` returns `HistoryMessage[]` with `trace` populated from SQLite (P9B§4.5) → `historyToChatMessages` builds `AssistantMessage`s with `trace: message.trace ?? []`, `live: false` (P9B§11).
2. `AgentActivityPanel` builds the identical lane tree from the persisted array (tokens filtered by `buildLanes`, P9B§6.3) and renders every row collapsed-by-default with `live={false}` — no transitions (P9B§8.4).

Both paths converge on the same `buildLanes` → `TraceStepRow` rendering; the only difference is the `live` flag governing auto-behavior.

## P9B§15 Testing strategy (high level — becomes the implementation plan)

No test code here; this enumerates what must be verified, in the style of P9A§14.

1. **Safety regression (first).** No renderer change can affect order placement; confirm the existing `kiteClient.test.ts` and the main-process IPC/allowlist tests pass unchanged, since this phase adds no channel and no Kite call (P9B§3).
2. **Adapter removal, grep-confirmed.** After the edit, grep the whole `electron-app` tree for `onNarrative` and `NarrativeEvent`: zero hits in `src/` (renderer and main IPC surface) and zero hits in the updated tests. The `test/renderer/testBridge.ts`, `test/renderer/App.test.tsx`, `test/renderer/ChatView.test.tsx`, and `test/main/ipc/rendererApi.test.ts` references (P9B§4.6) are removed or rewritten to `onTrace`.
3. **Tree construction from a flat fixture (`buildLanes`).** Given a hand-built `TraceEvent[]`: (a) lanes appear in `LANE_ORDER`; (b) a source with no events produces **no** lane (lane-appears-only-once-started); (c) sidecar events split by the `detail === "compute"` rule — the `"compute"` bracket sets the lane status, algorithm-id events become per-algorithm children in first-arrival (registry) order; (d) a lone sidecar `error` (message `detail`) is classified as the request-level bracket, not an algorithm; (e) persona `toolCall`/`toolResult` become tool leaves with `detail` verbatim; (f) `statusFrom` yields `error` > `done` > `running`.
4. **Token exclusion.** A trace containing narrative `token` events produces no token rows in any lane (they are filtered by `buildLanes`); the same tokens appended to `AssistantMessage.text` render in the bubble via `MessageMarkdown`.
5. **Auto-expand / auto-collapse / stay-expanded (live).** With `live={true}`: a row is expanded on `started` (`running`); collapses when it reaches `done`; an `error` row stays expanded. Assert against the derived `NodeStatus` and the rendered caret/children.
6. **Manual-toggle override.** Clicking a live row's caret overrides auto until the row's status transitions; a manual toggle on a terminal (`done`/`error`) row persists (status never transitions again); a manual collapse of a `running` row is reverted to auto on the running→terminal transition.
7. **History replay (`live={false}`).** Every row renders collapsed by default with no auto-transitions; manual expand/collapse still works. `historyToChatMessages` maps `HistoryMessage.trace` (including `null` → `[]`) onto `AssistantMessage.trace` with `live: false`.
8. **Empty/`engine_only` trace.** An assistant turn with `trace: []` (or `null` from history) renders no `AgentActivityPanel` (returns `null`).
9. **Narrative token → bubble.** A `source: "narrative"`, `kind: "token"` event on the active `requestId` appends its `detail` to the assistant bubble text and does not appear in the panel; events for a non-active `requestId` are ignored.
10. **Theme toggle.** `useChatTheme` reads `localStorage["chatTheme"]` on mount, defaulting to `"dark"` when unset/invalid; toggling flips `data-theme` on the `.chat-view` element and writes the new value to `localStorage`; a remount rehydrates the persisted value; the attribute is scoped to `.chat-view` and does not appear on the app chrome or settings window.
11. **CSS split sanity.** `style.css` retains `.error`, `.message-markdown`, and `.mermaid` (shared) and gains no `.chat-view`/`.messages`/`.chat-input`/`.verdict` rules; those live in `ChatView.css`; each new component imports its own stylesheet so the settings entry bundle is unaffected.

## P9B§16 Non-goals

- **The permanent no-order-placement invariant** (§2, §4) is unaffected — this phase adds no order surface, no new IPC, and no Kite/broker call; it renders an existing read-only stream (P9B§3). Permanent.
- **All main-process trace emission** — the pipeline, the sidecar progress protocol, the `analysis:trace` channel, and trace persistence — was built and shipped by Phase 9-A and is **not touched**. The sole `src/main/**` edit is deleting the retired `onNarrative`/`NarrativeEvent` compat shim in `rendererApi.ts` (a type/adapter removal, not a behavior change).
- **`engine_only` mode** is untouched: it invokes no personas, carries no trace, renders through `AnalysisResultView` (not `ChatView`), and shows no `AgentActivityPanel` (P9B§7.3, §11).
- **No new IPC channel, preload change, or `ipcMain.handle`.** The renderer consumes the pre-existing `analysis:trace` subscription.
- **No `historyStore.ts` change** — a verified no-op; `HistoryMessage.trace` already exists (P9B§12).
- **No re-summarization or expansion of tool `detail`.** The 200-char cap and `… (truncated, N chars)` suffix are applied by the main process (P9A§8.5); the UI renders the string verbatim and offers no "show full" affordance, because no fuller text is available client-side.
- **No new npm dependency.** All work uses React, the existing bridge, `localStorage`, and Vite's built-in CSS handling.
- **No timeout/model work** — Phase 9-A already fixed the timeout/model issue (uniform Haiku 4.5, per-persona timeouts); not revisited here.

## P9B§17 File touch-point summary

| File | Change |
| --- | --- |
| `electron-app/src/main/ipc/rendererApi.ts` | **Delete** `NarrativeEvent` (93-98), `onNarrative` from `RendererApi` (105) and its `buildRendererApi` adapter (126-133); keep `onTrace`, `TraceEvent`/`TraceSource`/`TraceKind` verbatim (P9B§5.1) |
| `electron-app/src/renderer/ChatView.tsx` | Drop `NarrativeEvent` import, add `TraceEvent`; `AssistantMessage` gains `trace`/`live`; replace the `onNarrative` `useEffect` with an `onTrace` accumulator; `onSend` seeds `trace: []`, `live: true`; render `AgentActivityPanel` + `ThemeToggle`; `data-theme` on `.chat-view`; `historyToChatMessages` maps `trace`/`live: false`; import `theme.css` + `ChatView.css` (P9B§5.2, §6, §9.2, §11) |
| `electron-app/src/renderer/AgentActivityPanel.tsx` | **New** — `LANE_ORDER`/`LANE_LABEL`, pure `buildLanes` tree builder (sidecar `detail === "compute"` split), collapsible card; imports `AgentActivityPanel.css` (P9B§7) |
| `electron-app/src/renderer/AgentActivityPanel.css` | **New** — card/lane styling over `theme.css` variables (P9B§10.2) |
| `electron-app/src/renderer/TraceStepRow.tsx` | **New** — recursive `TraceStepRow` (status icon, caret, auto-expand/collapse, manual override, `live` gating) + hookless `ToolLeafRow` leaf; imports `TraceStepRow.css` (P9B§8) |
| `electron-app/src/renderer/TraceStepRow.css` | **New** — row + tool-leaf styling, status colors over `theme.css` variables (P9B§10.2) |
| `electron-app/src/renderer/ThemeToggle.tsx` | **New** — `useChatTheme` hook (`localStorage`, default dark) + `ThemeToggle` button; imports `ThemeToggle.css` (P9B§9.2) |
| `electron-app/src/renderer/ThemeToggle.css` | **New** — top-right toggle button styling (P9B§10.2) |
| `electron-app/src/renderer/theme.css` | **New** — `.chat-view[data-theme="dark"|"light"]` CSS custom properties consumed by every other new file (P9B§9.1) |
| `electron-app/src/renderer/ChatView.css` | **New** — net-new `.chat-view`/`.messages`/`.message-*`/`.chat-input`/`.verdict` rules over `theme.css` variables (P9B§10) |
| `electron-app/src/renderer/style.css` | **Unchanged** — `.error`/`.message-markdown`/`.mermaid`/chrome rules are shared/global; nothing moves out (P9B§10.1) |
| `electron-app/src/main/services/history/historyStore.ts` | **Unchanged** — `HistoryMessage.trace` already exists; verified no-op (P9B§12) |
| `electron-app/test/renderer/testBridge.ts`, `test/renderer/App.test.tsx`, `test/renderer/ChatView.test.tsx`, `test/main/ipc/rendererApi.test.ts` | Update mocks/assertions off `onNarrative` onto `onTrace`; add `AgentActivityPanel`/`TraceStepRow`/`buildLanes`/`ThemeToggle` tests (P9B§4.6, §15) |
