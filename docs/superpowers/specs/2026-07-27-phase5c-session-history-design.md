# Phase 5c — Session/History Store + Real Claude Continuity

Status: approved by user 2026-07-27 (brainstorming dialogue), pending implementation planning.
Author: design produced via superpowers:brainstorming, concretizing §8.5 of `docs/superpowers/specs/2026-07-18-trade-assistant-design.md` and continuing the Phase 5 decomposition begun in `docs/superpowers/specs/2026-07-25-phase5a-live-wiring-design.md` / `docs/superpowers/specs/2026-07-26-phase5b-ai-assisted-chat-design.md`.

Phase 5 ("response modes / chat UI / history") was decomposed into four sub-phases (5a→5b→5c→5d). 5a (merged to main) wired the Engine-Only deterministic path end-to-end live. 5b (merged to main) wired AI-Assisted mode: free-text intake, streaming narrative, web research, the mode picker, and the shared `intent_lens` control. This spec covers **only 5c**: a persisted, reopenable session/message history store, and real multi-turn Claude conversational continuity for the narrative-authoring call. Section references: "§N" → master design; "P5b§N" → the Phase 5b spec; "P5c§N" → this document. Where a decision here narrows, defers, or diverges from a prior doc, it is called out in P5c§11 rather than left to silently drift.

## P5c§1 Purpose

§8.5 of the master design sketched chat/session history as a requirement — "every session's full transcript persists locally, browsable and reopenable later" — with a rough `sessions`/`messages` SQLite schema and an explicit note that this is "distinct from Claude's own multi-turn memory (§7.1's `--resume`/`--session-id`)." §8.5 described that Claude-side mechanism only by way of contrast; it never decided whether this app would actually *use* it. That decision is new, made in this brainstorming session: **Phase 5c wires real Claude conversational continuity into the narrative-authoring call**, on top of building the persisted session/message store §8.5 called for. This is the one concrete way this document goes further than §8.5, and it is the reason this phase's name says "+ Real Claude Continuity" rather than just "History Store."

Phase 5c's place in the roadmap: it runs after 5b (which built the AI-Assisted pipeline and the mode picker this phase now persists against) and before 5d (settings window + proactive scan scheduler, which this phase does not touch). Everything 5a/5b built — `assembleEnvelope`, the algorithm/data layers (§5, §6), the persona pipeline (§7.2, P5b§3), the deterministic generator (§9.2) — is reused unchanged. 5c adds a new persistence layer beneath the existing IPC surface and a new, narrowly-scoped memory channel on top of one existing Claude call.

Everything obeys the master hard constraints (§2, §4): **the app never places, modifies, cancels, or automates an order.** This phase adds no Kite capability, no new Claude tool grant, and no new subprocess-spawning path — it adds persistence and a session-id argument to a call that was already being made. The no-order-placement invariant is restated here, as in every phase, precisely because it is unaffected.

## P5c§2 Scope

**In scope:**

1. A new local SQLite-backed history store (`historyStore.ts`), owned by Electron main, recording every session and message ever run in either response mode (P5c§3).
2. Session model semantics: a session is a user-visible conversation thread with no app-lifecycle binding, explicit "New Chat" creation, and reopen-to-continue semantics (P5c§4).
3. Real Claude conversational continuity for the **narrative-authoring call only** (`streamingNarrative.ts`'s `makeNarrativeStreamer`, invoked from `ClaudeCliProvider.completeAiAssisted`), via `--session-id`/`--resume` (P5c§5).
4. IPC additions: `createSession`, `listSessions`, `getSession` on `RendererApi`; a required `sessionId` on both `AnalysisRunParams` variants (P5c§6).
5. Backend capture wiring in `analysisBridge.ts`'s two request functions, which become the single chokepoint where every user turn and every answer is written to history (P5c§7).
6. A new Home screen (`HomeScreen.tsx` + `HistorySidebar.tsx`) shown before the mode picker, "New Chat" semantics, and reopen-and-continue behavior in both modes, including last-used `intent_lens` seeding (P5c§8).
7. A `better-sqlite3` native dependency and its Electron-ABI rebuild step, working on both macOS and Windows dev machines (P5c§3.3).

**Not in scope (later sub-phases / explicitly deferred):**

- **5d (settings window + scan scheduler):** no settings UI, no proactive scanning, no tray-resident scheduler. Nothing here anticipates 5d beyond leaving its interfaces alone.
- Session renaming, deletion, or export UI. A session, once created, exists forever in this phase; there is no "delete this chat" affordance.
- The `auto` horizon remains unoffered — 5a/5b's deferral (P5a§12 tension 3, P5b§12 tension 5) continues; nothing about history storage depends on it.
- Populating `AnalysisEnvelope.news_context` or `AnalysisEnvelope.session_id` — both remain unpopulated, exactly as Phase 4/5b left them (P5c§11 flags a naming collision between the latter and this phase's new `sessionId`, but no code changes it).
- Automatic recovery when a `--resume` target is no longer present in Claude's own on-disk session store (P5c§5.4) — treated as an ordinary narrative failure, not specially detected or retried.
- Any change to the hard no-order-placement safety invariant (§2, §4) — unaffected, restated for the record as every phase does.

## P5c§3 Storage

### P5c§3.1 Schema

One new SQLite database, owned entirely by Electron main, separate from the Rust sidecar's own SQLite (`rusqlite`, watchlists/alerts/ingestion state, §5.3) and from the DuckDB/Parquet candle lake — matching §3's ownership table ("Chat/session history persistence | Electron main (TS), its own SQLite store | Rust"). Exact schema, unchanged from the brainstorm's locked decision:

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  response_mode TEXT NOT NULL,      -- 'engine_only' | 'ai_assisted'
  claude_session_id TEXT,           -- NULL until the first AI-Assisted narrative call succeeds
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,               -- 'user' | 'assistant'
  rendered_text TEXT NOT NULL,
  structured_payload TEXT,          -- JSON-serialized AnalysisRunParams (user) / AnalysisResult (assistant)
  created_at TEXT NOT NULL
);
```

Two additions on top of the locked column list, worked out here rather than left implicit:

```sql
CREATE INDEX IF NOT EXISTS messages_session_id_idx ON messages(session_id);
CREATE INDEX IF NOT EXISTS sessions_last_active_at_idx ON sessions(last_active_at);
```

— supporting `getSession`'s per-session message lookup and `listSessions`'s ordering (P5c§3.5). Additionally, `PRAGMA foreign_keys = ON` is set on every connection open (SQLite does **not** enforce `REFERENCES` by default; without this pragma, `messages.session_id REFERENCES sessions(id)` is inert documentation, not an enforced constraint). Enabling it turns "a message written against a nonexistent session id" from a silent data-integrity bug into a thrown `SQLITE_CONSTRAINT_FOREIGNKEY` error at `appendMessage()` time — the right failure mode for a bug that should never happen via correct UI usage (every `sessionId` the renderer ever sends originates from a real `createSession`/`getSession` response).

`structured_payload` stays nullable, as given, even though this phase always populates it for both roles at write time (every user turn's `AnalysisRunParams` and every assistant turn's `AnalysisResult` are fully available before the corresponding write — see P5c§7). The nullability is a defensive schema-level allowance for a future message type that might carry no structured payload, not a case this phase ever produces.

`role` is typed as `export type MessageRole = "user" | "assistant";` in `historyStore.ts`, shared between `HistoryMessage.role` and the internal `AppendMessageParams.role`.

Timestamps (`created_at`, `last_active_at`) are `new Date().toISOString()` strings — fixed-width and lexically sortable, which is what the `ORDER BY last_active_at DESC` / `ORDER BY created_at ASC` queries below rely on. This is a separate, purely internal timestamping convention from §5.2's Kite `+0530`-offset candle timestamps; the two are unrelated and neither influences the other.

### P5c§3.2 File location and env override

**File:** `electron-app/src/main/services/history/historyStore.ts` (new).

DB file path: `path.join(app.getPath("userData"), "history.sqlite3")`, overridable via `TRADE_ASSISTANT_HISTORY_DB` — named to exactly mirror `bootstrap.ts`'s existing `TRADE_ASSISTANT_LAKE` convention:

```typescript
new HistoryStore({
  path: process.env.TRADE_ASSISTANT_HISTORY_DB ?? path.join(app.getPath("userData"), "history.sqlite3"),
})
```

Like `TRADE_ASSISTANT_LAKE`, `userData` already sits outside the repo by default, so no new `.gitignore` entry is needed; if a developer points the env var at a path inside the repo for local testing, that's on them, exactly as it already is for the candle lake.

### P5c§3.3 Native module: better-sqlite3 + Electron rebuild (cross-platform)

`better-sqlite3` is synchronous and native (a compiled `.node` addon), unlike everything else in `electron-app/package.json` today (`zod`, `dompurify`, `markdown-it`, `mermaid` are all pure JS). Two things follow:

1. **Electron-ABI rebuild is required.** Electron (pinned `^33.2.0`) bundles its own Node/V8 build with an ABI that does not match the system Node used for `npm install`. A `better-sqlite3` binary built against system Node's ABI will fail at `require()` time in the Electron main process with a `NODE_MODULE_VERSION` mismatch. The standard fix: add `@electron/rebuild` as a devDependency and a `postinstall` script that rebuilds `better-sqlite3` specifically against the installed Electron version:

   ```json
   "devDependencies": {
     "@electron/rebuild": "^3.7.0",
     "@types/better-sqlite3": "^7.6.11"
   },
   "dependencies": {
     "better-sqlite3": "^11.8.0"
   },
   "scripts": {
     "postinstall": "electron-rebuild -f -w better-sqlite3"
   }
   ```

   (`electron-rebuild` is the CLI binary name `@electron/rebuild` provides; exact version pins are an implementation-time detail, not locked here.) This runs automatically after `npm install` — on whichever OS `npm install` is run on. `@electron/rebuild` first tries a prebuilt binary for the target Electron ABI/platform; if none exists, it falls back to compiling from source via `node-gyp`, which requires the platform's native build toolchain (Xcode Command Line Tools on macOS; Visual Studio Build Tools + Python on Windows). Both must be run on their respective dev machine — this is a required one-time setup step on each of the user's macOS and Windows dev machines, not a CI-only concern, since 5c is dev/local work like everything else in this project.

2. **This does *not* reopen §11's cross-compilation problem, despite the surface similarity.** §3/§11 rejected a native Node addon for the *algorithm/compute layer* specifically because cross-compiling a Node addon to Windows-MSVC **from a macOS host** hit real, open toolchain bugs. `better-sqlite3`'s rebuild step is not cross-compilation: `@electron/rebuild` runs natively on each dev machine, building for that same machine's OS — exactly the same "build each target on its own OS" principle §11 already uses for the sidecar binary's CI matrix (`macos-latest` + `windows-latest`, no cross-compiling from one to the other). A future reader comparing this phase to §3's stated aversion to native Node addons should read this as "a native addon built locally, once, per dev machine" — a materially different and much lower-risk shape than "cross-compile a native addon from one OS to another," which is the specific thing §3/§11 found broken.

3. **Bundling.** `electron.vite.config.ts`'s `main` build already uses `externalizeDepsPlugin()`, which leaves everything in `package.json`'s `dependencies` as a real `require()` against `node_modules` at runtime instead of bundling it into the Rollup output. This is exactly what a native `.node` addon needs (bundlers cannot inline a compiled binary), and it requires **no change** to `electron.vite.config.ts` — `better-sqlite3` simply needs to be a `dependencies` entry (not `devDependencies`), which the block above already reflects. `HistoryStore` is main-process-only; the renderer never imports `better-sqlite3` directly (all access is via IPC), so there is no renderer-bundling concern either.

### P5c§3.4 Bootstrap / migration approach

No separate migration framework, and no schema-version table, for v1 — stated explicitly rather than left implicit, matching this being a personal single-user app. `HistoryStore`'s constructor runs the full DDL (both `CREATE TABLE IF NOT EXISTS` statements, both `CREATE INDEX IF NOT EXISTS` statements, plus `PRAGMA foreign_keys = ON`) synchronously, once, every time the store opens — every app startup. This is idempotent by construction (`IF NOT EXISTS` on every statement) and mirrors the Rust `StateStore::open`/`CandleStore::open` pattern already used in this codebase (`rust-core/crates/storage/src/state_store.rs`: `CREATE TABLE IF NOT EXISTS watchlist (...)` run unconditionally at `open()`, no separate migration runner) — the same "open-time idempotent DDL" philosophy carried into a different language/DB for a conceptually similar (small, local, single-writer) storage need.

If the schema ever needs to change post-v1: hand-edit the constructor's DDL (e.g. add an `ALTER TABLE ... ADD COLUMN`, guarded by checking `PRAGMA table_info(sessions)` for the column's absence before running it), or — since this is a personal, disposable, local file — simply delete `history.sqlite3` and let it recreate empty. No versioned migration files, no `migrations/` directory. This is a deliberate simplicity choice for a single-user local tool, not an oversight.

### P5c§3.5 `HistoryStore` public interface

```typescript
export type MessageRole = "user" | "assistant";

export interface SessionSummary {
  id: string;
  response_mode: AnalysisMode;
  created_at: string;
  last_active_at: string;
  preview: string;
}

export interface HistoryMessage {
  role: MessageRole;
  rendered_text: string;
  structured_payload: unknown;
  created_at: string;
}

export interface SessionDetail {
  id: string;
  response_mode: AnalysisMode;
  messages: HistoryMessage[];
}

export interface AppendMessageParams {
  sessionId: string;
  role: MessageRole;
  renderedText: string;
  structuredPayload?: unknown;
}

export interface HistoryStoreOptions {
  path: string;
  now?: () => Date;
}

export class HistoryStore {
  constructor(options: HistoryStoreOptions);
  createSession(mode: AnalysisMode): SessionSummary;
  listSessions(): SessionSummary[];
  getSession(id: string): SessionDetail | null;
  appendMessage(params: AppendMessageParams): void;
  getClaudeSessionId(sessionId: string): string | null;
  setClaudeSessionId(sessionId: string, claudeSessionId: string): void;
  close(): void;
}
```

`AnalysisMode` is imported from `"../../ipc/rendererApi"` — an already-established import direction in this codebase (`services/analysis/contracts.ts` already does `import type { Horizon } from "../../ipc/rendererApi";`), not a new layering exception. `SessionSummary`/`HistoryMessage`/`SessionDetail` are **owned by `historyStore.ts`**, not redeclared in `rendererApi.ts` — `rendererApi.ts` re-exports them with `export type { SessionSummary, HistoryMessage, SessionDetail } from "../services/history/historyStore";`, exactly the pattern it already uses for `InstrumentRef`/`Verdict`/`IntentLens` from `services/analysis/contracts.ts`. `AppendMessageParams` is main-process-internal and is not re-exported.

Representative method bodies (exact queries, not paraphrased):

```typescript
const PREVIEW_MAX_LENGTH = 120;

function summarizePreview(latestMessageText: string | null): string {
  if (latestMessageText === null) return "(no messages yet)";
  const collapsed = latestMessageText.replace(/\s+/g, " ").trim();
  return collapsed.length > PREVIEW_MAX_LENGTH ? `${collapsed.slice(0, PREVIEW_MAX_LENGTH)}…` : collapsed;
}
```

```typescript
listSessions(): SessionSummary[] {
  const rows = this.db
    .prepare(
      `SELECT s.id, s.response_mode, s.created_at, s.last_active_at,
              (SELECT m.rendered_text FROM messages m WHERE m.session_id = s.id
               ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS latest_message_text
       FROM sessions s
       ORDER BY s.last_active_at DESC`,
    )
    .all() as Array<{
      id: string; response_mode: AnalysisMode; created_at: string; last_active_at: string;
      latest_message_text: string | null;
    }>;
  return rows.map((row) => ({
    id: row.id,
    response_mode: row.response_mode,
    created_at: row.created_at,
    last_active_at: row.last_active_at,
    preview: summarizePreview(row.latest_message_text),
  }));
}
```

`preview` is defined as **the most recent message's `rendered_text`** (whitespace-collapsed, truncated to 120 chars with a trailing "…"), not a generated session title — deliberately: a generated title would need its own Claude call (scope creep this phase doesn't take on), and "what was last said" is at least as useful for a resume-oriented list as "what was first asked," especially since `listSessions()` is already ordered by `last_active_at DESC` (most recently active first, matching Claude Code's own `/resume` picker ordering). A session with zero messages (created via New Chat, never used) shows `"(no messages yet)"`.

The correlated subquery orders by `created_at DESC, rowid DESC` — SQLite's implicit `rowid` (present on every table without a declared `INTEGER PRIMARY KEY`) is used as a physical-insertion-order tiebreaker for same-millisecond timestamps, without adding a column to the locked schema. `getSession`'s message ordering uses the same tiebreak, ascending:

```typescript
getSession(id: string): SessionDetail | null {
  const session = this.db
    .prepare("SELECT id, response_mode FROM sessions WHERE id = ?")
    .get(id) as { id: string; response_mode: AnalysisMode } | undefined;
  if (!session) return null;
  const rows = this.db
    .prepare(
      `SELECT role, rendered_text, structured_payload, created_at FROM messages
       WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(id) as Array<{ role: MessageRole; rendered_text: string; structured_payload: string | null; created_at: string }>;
  return {
    id: session.id,
    response_mode: session.response_mode,
    messages: rows.map((row) => ({
      role: row.role,
      rendered_text: row.rendered_text,
      structured_payload: row.structured_payload === null ? null : JSON.parse(row.structured_payload),
      created_at: row.created_at,
    })),
  };
}
```

```typescript
createSession(mode: AnalysisMode): SessionSummary {
  const id = randomUUID();
  const timestamp = this.now().toISOString();
  this.db
    .prepare("INSERT INTO sessions (id, response_mode, claude_session_id, created_at, last_active_at) VALUES (?, ?, NULL, ?, ?)")
    .run(id, mode, timestamp, timestamp);
  return { id, response_mode: mode, created_at: timestamp, last_active_at: timestamp, preview: "(no messages yet)" };
}
```

`appendMessage` writes the message and bumps `last_active_at` in one transaction (both prepared statements and the `db.transaction(...)`-wrapped function are built once, in the constructor, after the DDL runs):

```typescript
appendMessage(params: AppendMessageParams): void {
  const timestamp = this.now().toISOString();
  this.appendMessageTxn(params, timestamp); // INSERT INTO messages ...; UPDATE sessions SET last_active_at = ? WHERE id = ?
}
```

```typescript
getClaudeSessionId(sessionId: string): string | null {
  const row = this.db.prepare("SELECT claude_session_id FROM sessions WHERE id = ?").get(sessionId) as
    | { claude_session_id: string | null }
    | undefined;
  if (!row) throw new Error(`unknown session ${sessionId}`);
  return row.claude_session_id;
}

setClaudeSessionId(sessionId: string, claudeSessionId: string): void {
  this.db.prepare("UPDATE sessions SET claude_session_id = ? WHERE id = ?").run(claudeSessionId, sessionId);
}

close(): void {
  this.db.close();
}
```

`this.now` defaults to `() => new Date()`, overridable via `HistoryStoreOptions.now` — mirroring the `now?: () => Date` convention `RunAnalysisDeps`/`AiAssistedRequestDeps` already use in `analysisBridge.ts`, so tests can assert exact timestamps deterministically.

## P5c§4 Session model semantics

A **session** is a user-visible conversation thread, not a bookkeeping record tied to the app's process lifetime — the same mental model as ChatGPT, Claude.ai, or Claude Code's own `/resume`. Concretely:

- **No app-lifecycle binding.** There is no "session start"/"session end" tied to the app opening or closing. A session has `created_at` (set once, at `createSession`) and `last_active_at` (bumped on every `appendMessage`, i.e. every user turn and every assistant reply) — no `ended_at` column exists (a deliberate divergence from §8.5's original sketch; see P5c§11). Closing the app and reopening it later does not "end" anything; the same session, if reopened, simply continues.
- **"New Chat" is the only explicit action that starts a fresh session row.** There is no implicit session creation anywhere else — not on app launch, not on first message. `createSession(mode)` is called exactly once per New Chat click, immediately after the user picks a response mode in `ModePicker` (P5c§8.3).
- **Reopening a session makes it active again, and it is not read-only.** There is no "archived" or "closed" state. Opening an old session from `HistorySidebar` restores it as the active session, and the user can keep adding messages to it exactly as if it had never been left — a new engine_only wizard run or a new ai_assisted chat turn appends to the same session id, bumping `last_active_at` again, and (for ai_assisted) resumes the same `claude_session_id` (P5c§5).
- **A session's `response_mode` is fixed at creation and never changes.** There is no UI to switch an existing session between Engine-Only and AI-Assisted mid-thread — that would require re-deciding continuity semantics (does an engine_only session suddenly gain a `claude_session_id`?) that this phase does not need to answer, since the mode picker only ever runs once, at New-Chat time, before a session exists.

## P5c§5 Claude continuity mechanism

This is the crux of the phase: **only the narrative-authoring call gets real multi-turn Claude memory.** Every other Claude call in the pipeline — the three parallel analytical personas and the serial synthesis call — stays exactly as it is today: stateless, given a fresh `AnalysisEnvelope` every turn, never resumed. A future reader must understand *why* those four calls were deliberately excluded, not just that they were.

### P5c§5.1 Mechanics: `--session-id` vs `--resume`

Per `docs/CLAUDE_USAGE_GUIDE.md`'s "Conversation continuity" section: `--session-id <uuid>` pins a specific id to a **new** conversation up front; `--resume <uuid>` continues a conversation the CLI has already persisted under that id. These are mutually exclusive per call — you pin on the first turn, you resume on every later turn; you never do both.

For a given session row:
- **First AI-Assisted turn** (`sessions.claude_session_id IS NULL`): the app generates a uuid itself, `crypto.randomUUID()` (Node's `node:crypto`, not the CLI) — never trusting the CLI to hand one back — and passes it to the narrative call as `--session-id <uuid>`. This is a pin, not a resume: it tells the CLI "this is a new conversation, and I am choosing its id."
- **Every later AI-Assisted turn in the same session**: the app reads the previously-persisted `claude_session_id` off the `sessions` row and passes it as `--resume <uuid>` instead.
- **Engine-Only mode**: no Claude call happens anywhere in this path (§9.2, unchanged) — no continuity mechanism applies, and `sessions.claude_session_id` stays `NULL` for the lifetime of an engine_only session. Its only "memory" of past turns is the `structured_payload` history itself (P5c§13, out of scope note).

### P5c§5.2 Which call gets it, which don't, and why

**Excluded: the three analytical personas (`options_greeks`, `technical_quant`, `position_risk`) and the synthesis call.** Two independent reasons, either of which alone would justify the exclusion:

1. **Freshness.** These four calls exist to answer "what does the data say, right now" from a fresh `AnalysisEnvelope` — fresh `algo_results`, fresh `confluence`, computed by the (session-unaware) algorithm layer for *this* turn only. If any of them resumed a Claude-side conversation, the model's own context would carry forward the *previous* turn's algo results, confluence numbers, and conclusions as prior conversation history — exactly the anchoring failure mode a market-data analysis tool must avoid. A five-minutes-ago RSI reading, or yesterday's conviction level, has no business influencing today's independent recompute. The system already achieves this discipline by resending the full envelope every call (§6.1); resuming a session would silently reopen a memory channel that undermines it.
2. **Parallel-write corruption (personas only).** The three analytical personas run concurrently via `Promise.all` in `runPersonaPipeline` (`personaPipeline.ts`) — this is deliberate and unchanged (§6.3's "never collapse disagreeing signals" philosophy, carried into 5b's pipeline shape). Claude's own session persistence assumes **one active resumer at a time** per session id (`docs/CLAUDE_USAGE_GUIDE.md`'s continuity model has no notion of concurrent resumers). If the three parallel persona calls all passed `--resume <same-uuid>`, three `claude` subprocesses would concurrently append to the same on-disk session transcript — a real corruption risk (interleaved or last-writer-wins-clobbered writes to that file), not merely a performance concern. Since parallelism is the property this design keeps (it is the entire point of running three independent perspectives instead of one merged prompt), and reason 1 already rules out giving any of the four calls continuity regardless of concurrency, there is no tension to resolve here — both properties point the same way.

Synthesis is serial (no concurrency risk), but reason 1 alone excludes it too: a resumed synthesis call would see prior turns' verdicts as conversation history, when the verdict must always be freshly derived from *this* turn's findings.

**Included: the narrative call only.** Its job is categorically different from the four calls above — it does not compute a judgment, it writes prose explaining a judgment that is **already finalized before the narrative call ever runs.** P5b§3 already split verdict-computation from narrative-writing specifically so the streamed prose "can never change the machine-checked direction/conviction/citations" — 5c's continuity design leans on that exact same split as its safety net. Because `direction`/`conviction`/`cited_algo_ids` are frozen by the (non-resumed, freshly-computed) verdict call before the narrative call starts, giving *only* the narrative call memory cannot let a stale prior verdict leak into this turn's actual verdict — at most, memory can influence phrasing and framing ("compared to what I told you this morning..."), which is exactly the conversational value the user chose real continuity for (decision 3 in the brainstorm: explicitly preferred over the cheaper UI-transcript-only option).

One accepted cost, stated plainly rather than hidden: because `narrativePrompt()` embeds the full `verdict`/`findings`/`intent_lens`/`researchNotes` payload as that turn's prompt text (unchanged from P5b§3), and the narrative call now also resumes, Claude's own conversational context for a long-running session accumulates every prior turn's full narrative prompt and reply. This grows token cost with session length — a scale/cost consideration, not a safety one, since the frozen-verdict boundary above still holds regardless of how much prior context is in view. A user who wants to reset this growth (or start a topically fresh conversation) always has "New Chat" available, which pins a brand-new `claude_session_id` with zero carried context — this is part of why New Chat exists as a first-class, cheap action (P5c§4), not an afterthought.

### P5c§5.3 Structural guarantee, not a promise

`claudeProvider.ts` already carries an explicit comment establishing its philosophy: no caller-supplied passthrough argv, because the CLI's flag surface has bypass flags this module can't fully enumerate — "when something does [need extra flags], add it as its own named parameter with its own explicit validation, not a passthrough array." The session-continuity fields follow that same discipline: `claudeSessionId`/`resumeSession` are two narrowly-typed, named `ClaudeArgOptions` fields, fed only ever a self-generated `crypto.randomUUID()` value or a value already round-tripped through `historyStore.getClaudeSessionId`, never anything else.

More importantly, the exclusion of the four analytical/synthesis calls is enforced **structurally, by type shape**, not by convention or a runtime check someone could forget:

- `PersonaRunSpec<T>` (in `claudeCliProvider.ts`) has no `claudeSessionId`/`resumeSession` field, and `makeClaudeRunner`'s `attempt()` builds its `ClaudeArgOptions` object as an explicit literal (`{ systemPrompt, jsonSchema, outputFormat: "json", allowWebTools }`) — not a spread of `spec` — so there is no field on `PersonaRunSpec` for a future edit to accidentally forward even if someone tried.
- `runPersonaPipeline`'s three analytical `deps.runPersona<PersonaFinding>({...})` calls and its one `deps.runPersona<Verdict>({...})` synthesis call are unchanged, byte-for-byte, by this phase (P5c§12 confirms `personaPipeline.ts` needs **no code change at all**).
- Only `NarrativeStreamSpec` (in `streamingNarrative.ts`) and `CompleteAiAssistedOptions` (in `provider.ts`) gain the two fields, and only `ClaudeCliProvider.completeAiAssisted`'s single `this.streamNarrative({...})` call threads them through.

A future refactor that tried to give a persona continuity would have to add a new field to `PersonaRunSpec<T>` and thread it through `makeClaudeRunner`'s hand-written literal — a visible, deliberate change, not a silent one.

### P5c§5.4 Known, accepted limitation: a missing resume target

If `--resume <uuid>` is passed for a `claude_session_id` that Claude's own CLI no longer has on disk (e.g. its own local retention/cleanup, outside this app's control), the narrative call fails like any other narrative failure — non-zero exit, or a non-`success` terminal `result` line — which `makeNarrativeStreamer` already turns into a rejected promise. No special detection or automatic fallback (e.g. silently re-pinning a fresh id) is built for this case: it surfaces through the existing error path (P5c§7.2's orphaned-user-message behavior, an error narrative event, a visible chat error). The user's only recourse in this phase is to start a New Chat. This is called out explicitly so it reads as a considered, deliberate non-goal rather than a gap nobody noticed.

## P5c§6 IPC contract additions

### P5c§6.1 `rendererApi.ts`

```typescript
export type { SessionSummary, HistoryMessage, SessionDetail } from "../services/history/historyStore";
import type { SessionSummary, HistoryMessage, SessionDetail } from "../services/history/historyStore";

export type AnalysisRunParams =
  | { mode: "engine_only"; sessionId: string; instrument: InstrumentSelection; horizon: Horizon; intent_lens: IntentLens }
  | { mode: "ai_assisted"; sessionId: string; query: string; intent_lens: IntentLens; requestId: string };

export interface RendererApi {
  getStatus(): Promise<AppStatus>;
  onBanner(handler: (banner: BannerEvent) => void): void;
  onNarrative(handler: (event: NarrativeEvent) => void): void;
  login(): Promise<LoginResult>;
  searchInstruments(query: string): Promise<unknown>;
  runAnalysis(params: AnalysisRunParams): Promise<AnalysisResult>;
  createSession(mode: AnalysisMode): Promise<SessionSummary>;
  listSessions(): Promise<SessionSummary[]>;
  getSession(id: string): Promise<SessionDetail>;
}
```

`AnalysisResult` itself is **unchanged** — the renderer already knows which session is active from its own state (P5c§8.2), so the result flowing back over IPC doesn't need to redundantly carry `sessionId`.

`buildRendererApi` gains three plain invoke/response wirings, no new subscribe channel:

```typescript
createSession: (mode) => invoke("history:createSession", { mode }) as Promise<SessionSummary>,
listSessions: () => invoke("history:listSessions") as Promise<SessionSummary[]>,
getSession: (id) => invoke("history:getSession", { id }) as Promise<SessionDetail>,
```

`preload.ts` needs **no change** — `buildRendererApi`'s existing generic `invoke`/`subscribe` plumbing already covers these three the same way it covers `login`/`searchInstruments`/`runAnalysis`; there is no new IPC mechanism to expose.

### P5c§6.2 `ipc/historyBridge.ts` (new)

```typescript
import type { IpcMain } from "electron";
import type { HistoryStore } from "../services/history/historyStore";
import type { AnalysisMode } from "./rendererApi";

export interface HistoryBridgeDeps {
  ipcMain: Pick<IpcMain, "handle">;
  history: Pick<HistoryStore, "createSession" | "listSessions" | "getSession">;
}

export function registerHistoryBridge(deps: HistoryBridgeDeps): void {
  deps.ipcMain.handle("history:createSession", (_event, args: { mode: AnalysisMode }) =>
    deps.history.createSession(args.mode),
  );
  deps.ipcMain.handle("history:listSessions", () => deps.history.listSessions());
  deps.ipcMain.handle("history:getSession", (_event, args: { id: string }) => {
    const detail = deps.history.getSession(args.id);
    if (!detail) throw new Error(`unknown session ${args.id}`);
    return detail;
  });
}
```

Channel names (`history:createSession`, `history:listSessions`, `history:getSession`) follow the existing `domain:action` convention (`kite:login`, `kite:searchInstruments`, `analysis:run`, `status:get`). The `getSession` handler is the layer that turns "not found" (`HistoryStore.getSession` returning `null`, an honest store-level primitive) into a thrown/rejected error — mirroring `analysisBridge.ts`'s existing `requireSession` helper, which does the same not-null-vs-throw conversion for the Kite session. In normal use this branch is unreachable (every id the renderer ever passes originated from `listSessions()`/`createSession()`); it exists to fail loudly on a bug rather than hand the renderer a silent `null`.

Naming note, called out to preempt confusion rather than silently live with it: `analysisBridge.ts`'s existing `AnalysisBridgeDeps.getSession: () => KiteSession | null` (the live Kite MCP session) and this phase's new `RendererApi.getSession(id): Promise<SessionDetail>` / `HistoryStore.getSession(id)` (a persisted chat session) share the name "session" and the method name "getSession" while meaning entirely different things. They never appear on the same interface, so there is no actual TypeScript collision — but a future reader skimming both files should not assume they're related.

## P5c§7 Backend wiring / capture chokepoint mechanics

`analysisBridge.ts`'s `runAnalysisRequest` and `runAiAssistedRequest` are the capture chokepoint, per the brainstorm's own framing — both functions write history directly, not a wrapper around them.

### P5c§7.1 `RunAnalysisDeps` / `AiAssistedRequestDeps` / `AnalysisBridgeDeps`

```typescript
export interface RunAnalysisDeps {
  kite: KiteClient;
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles">;
  history: Pick<HistoryStore, "appendMessage">;
  now?: () => Date;
}

export interface AiAssistedRequestDeps {
  kite: KiteClient;
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles">;
  provider: AiAssistedProvider;
  history: Pick<HistoryStore, "appendMessage" | "getClaudeSessionId" | "setClaudeSessionId">;
  now?: () => Date;
}

export interface AnalysisBridgeDeps {
  ipcMain: Pick<IpcMain, "handle">;
  login: () => Promise<LoginResult>;
  getSession: () => KiteSession | null;
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles">;
  provider: AiAssistedProvider;
  history: Pick<HistoryStore, "appendMessage" | "getClaudeSessionId" | "setClaudeSessionId">;
  sendNarrative: (event: NarrativeEvent) => void;
  markNeedsLogin: () => void;
  now?: () => Date;
}
```

The `analysis:run` handler passes `history: deps.history` into both branches, alongside the existing `kite`/`sidecar`/`now`.

### P5c§7.2 `runAnalysisRequest` (engine_only) — ordering and the orphan edge case

```typescript
function describeEngineOnlyQuery(params: Extract<AnalysisRunParams, { mode: "engine_only" }>): string {
  return `${params.instrument.symbol} · ${params.horizon} · ${params.intent_lens}`;
}

export async function runAnalysisRequest(
  deps: RunAnalysisDeps,
  params: Extract<AnalysisRunParams, { mode: "engine_only" }>,
): Promise<AnalysisResult> {
  const now = deps.now?.() ?? new Date();
  deps.history.appendMessage({
    sessionId: params.sessionId,
    role: "user",
    renderedText: describeEngineOnlyQuery(params),
    structuredPayload: params,
  });
  const { timeframe, from, to } = horizonToFetchParams(params.horizon, now);
  const envelope = await assembleEnvelope(
    { kite: deps.kite, sidecar: deps.sidecar },
    { trigger: "reactive", instrument: params.instrument, timeframe, horizon_requested: params.horizon, intent_lens: params.intent_lens, from, to },
  );
  const response = generateDeterministicResponse(envelope);
  const result: AnalysisResult = {
    mode: "engine_only",
    instrument: envelope.instrument,
    horizon: params.horizon,
    response,
    algo_results: envelope.algo_results,
  };
  deps.history.appendMessage({
    sessionId: params.sessionId,
    role: "assistant",
    renderedText: response.text,
    structuredPayload: result,
  });
  return result;
}
```

**Explicit resolution of the orphaned-user-message edge case:** the user message is written **before** `assembleEnvelope` runs; the assistant message is written **only after** the full engine call succeeds. If `assembleEnvelope` (Kite fetch, sidecar compute) throws anywhere in between, the function does not reach the second `appendMessage` call — the thrown error propagates to the `ipcMain.handle` caller exactly as it does today, and the user's message is left persisted in `messages` with no matching assistant reply for that turn.

**This is accepted and intentional, not a bug to fix later:**
- It matches ordinary chat-app behavior (ChatGPT, Claude.ai): if a turn fails, the user's sent message still appears in the transcript — it is not retroactively deleted, because the user really did ask it.
- Deleting or suppressing the write after the fact would make the persisted history lie about what was actually asked.
- The IPC call still rejects to the renderer exactly as before (`registerAnalysisBridge`'s existing `guardSessionExpiry` wrapping is untouched), so the live UI still shows the error; the orphan only affects what a *later* reopen of that session sees (one unanswered turn in the transcript, rendered as a user message with nothing following it — P5c§8.5/8.6 render this plainly, they do not hide or specially flag it).

### P5c§7.3 `runAiAssistedRequest` — the same ordering, plus `claude_session_id` timing

```typescript
import { randomUUID } from "node:crypto";

export async function runAiAssistedRequest(
  deps: AiAssistedRequestDeps,
  params: Extract<AnalysisRunParams, { mode: "ai_assisted" }>,
  sendNarrative: (event: NarrativeEvent) => void,
): Promise<AnalysisResult> {
  const now = deps.now?.() ?? new Date();
  try {
    deps.history.appendMessage({
      sessionId: params.sessionId,
      role: "user",
      renderedText: params.query,
      structuredPayload: params,
    });
    const intake = await deps.provider.intake(params.query);
    const { timeframe, from, to } = horizonToFetchParams(intake.horizon, now);
    const envelope = await assembleEnvelope(
      { kite: deps.kite, sidecar: deps.sidecar },
      { trigger: "reactive", instrument: intake.instrument, timeframe, horizon_requested: intake.horizon, intent_lens: params.intent_lens, from, to },
    );
    const existingClaudeSessionId = deps.history.getClaudeSessionId(params.sessionId);
    const claudeSessionId = existingClaudeSessionId ?? randomUUID();
    const { verdict, narrative } = await deps.provider.completeAiAssisted(envelope, {
      researchNotes: intake.researchNotes,
      onNarrativeToken: (chunk) => sendNarrative({ requestId: params.requestId, chunk }),
      claudeSessionId,
      resumeSession: existingClaudeSessionId !== null,
    });
    if (existingClaudeSessionId === null) {
      deps.history.setClaudeSessionId(params.sessionId, claudeSessionId);
    }
    sendNarrative({ requestId: params.requestId, done: true });
    const result: AnalysisResult = {
      mode: "ai_assisted",
      instrument: envelope.instrument,
      horizon: intake.horizon,
      intent_lens: params.intent_lens,
      verdict,
      narrative,
      algo_results: envelope.algo_results,
      confluence: envelope.confluence,
    };
    deps.history.appendMessage({ sessionId: params.sessionId, role: "assistant", renderedText: narrative, structuredPayload: result });
    return result;
  } catch (error) {
    sendNarrative({ requestId: params.requestId, error: (error as Error).message });
    throw error;
  }
}
```

The orphan behavior is identical in shape to P5c§7.2: the user message is written first, unconditionally; the assistant message is written only on full success (after `completeAiAssisted` resolves); any throw along the way (the user-message write itself, intake, envelope assembly, the persona pipeline, or the narrative call) leaves the user's query persisted with no reply, for the same reasons as P5c§7.2. Unlike P5c§7.2's engine_only version, the user-message write here sits *inside* the `try` rather than before it — engine_only has no narrative channel to notify, but ai_assisted does, so every failure (including, in principle, the write itself) must still reach the `catch` block's existing narrative-error-push-then-rethrow behavior, which is otherwise untouched.

**Explicit resolution of `claude_session_id` persistence timing:** `sessions.claude_session_id` is written **only after `completeAiAssisted` resolves successfully**, never before the call, and never on a first-turn failure. This is deliberate: if the very first AI-Assisted turn in a session generates a fresh uuid, passes it as `--session-id`, and the call then fails (timeout, Claude CLI error, abort), persisting that uuid anyway would risk a *later* retry passing `--resume <uuid>` against a session the CLI's own on-disk store may never have actually materialized (the call never got far enough to produce a result). Leaving `claude_session_id` `NULL` on a failed first turn means the *next* attempt in that session is correctly treated as "still the first call" — a brand-new uuid is generated and pinned again, never a resume against a possibly-nonexistent transcript. The only cost is a handful of abandoned, never-referenced Claude-side session ids from failed first attempts — never a corrupted or confusing resume target.

## P5c§8 Renderer flow

### P5c§8.1 `HomeScreen.tsx` / `HistorySidebar.tsx` (new)

```typescript
// HistorySidebar.tsx
export interface HistorySidebarProps {
  sessions: SessionSummary[];
  onOpenSession: (id: string) => void;
}
export function HistorySidebar({ sessions, onOpenSession }: HistorySidebarProps): JSX.Element { /* one <li> per session: mode, preview, last_active_at */ }

// HomeScreen.tsx
export interface HomeScreenProps {
  sessions: SessionSummary[];
  onNewChat: () => void;
  onOpenSession: (id: string) => void;
}
export function HomeScreen({ sessions, onNewChat, onOpenSession }: HomeScreenProps): JSX.Element {
  return (
    <section className="home-screen">
      <button type="button" onClick={onNewChat}>New Chat</button>
      <HistorySidebar sessions={sessions} onOpenSession={onOpenSession} />
    </section>
  );
}
```

`HomeScreen` is the **first** thing shown, ahead of `ModePicker` — mirroring how P5b§8.1 made `ModePicker` the first thing shown ahead of the login gate. The ordering is now: **Home → (New Chat →) mode picker → login gate → intent_lens control → mode-specific intake/chat → result**, or **Home → (reopen →) login gate → intent_lens (seeded) → mode-specific view (restored) → result**.

### P5c§8.2 `App.tsx` state

```typescript
interface ActiveSession {
  id: string;
  mode: AnalysisMode;
}

const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
const [showModePicker, setShowModePicker] = useState(false);
const [sessions, setSessions] = useState<SessionSummary[]>([]);
const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
```

`mode` (the old bare state) is retired in favor of `activeSession?.mode` — combining id and mode into one state object makes "a mode is chosen without a session existing yet" structurally unrepresentable, rather than a transient state the rest of the tree has to tolerate. `sessionDetail` replaces the old bare `result: AnalysisResult | null` state for engine_only rendering (P5c§8.6) and doubles as the seed data for a reopened ai_assisted `ChatView` (P5c§8.5); it is fetched fresh from `getSession()` whenever the current session's transcript needs to be (re-)displayed from server-side truth, rather than maintained as a separately-diverging client-side mirror.

`sessions` is loaded once on mount (`bridge().listSessions().then(setSessions)`, alongside the existing `getStatus()`/`onBanner` wiring) and refreshed whenever `HomeScreen` is shown again (P5c§8.4).

### P5c§8.3 New Chat flow

```typescript
const onNewChat = (): void => setShowModePicker(true);

const onSelectMode = async (mode: AnalysisMode): Promise<void> => {
  const session = await bridge().createSession(mode);
  setSessions((prev) => [session, ...prev]);
  setSessionDetail(null);
  setActiveSession({ id: session.id, mode });
  setShowModePicker(false);
};
```

Rendering: `{activeSession === null && !showModePicker && <HomeScreen sessions={sessions} onNewChat={onNewChat} onOpenSession={onOpenSession} />}`, `{activeSession === null && showModePicker && <ModePicker onSelect={onSelectMode} />}` (`onOpenSession` is defined in P5c§8.4, immediately below). `createSession(mode)` fires exactly once mode is picked, per the brainstorm's own framing — there is no intermediate render where a mode is "chosen" but no session id exists yet, since `activeSession` is only ever set once `createSession` has resolved.

### P5c§8.4 Reopen-and-continue flow, including `intent_lens` seeding

```typescript
const onOpenSession = async (id: string): Promise<void> => {
  const detail = await bridge().getSession(id);
  setSessionDetail(detail);
  setActiveSession({ id: detail.id, mode: detail.response_mode });
  const lastUserMessage = [...detail.messages].reverse().find((m) => m.role === "user");
  if (lastUserMessage) {
    // Both AnalysisRunParams variants carry intent_lens, so no narrowing by mode is needed here.
    const payload = lastUserMessage.structured_payload as AnalysisRunParams;
    setIntentLens(payload.intent_lens);
  }
};

const onBackToHome = (): void => {
  setActiveSession(null);
  setSessionDetail(null);
  void bridge().listSessions().then(setSessions);
};
```

**Explicit resolution of the `intent_lens`-on-reopen edge case:** `IntentLensSelector` is, per its own existing design, "a shared per-request control, not a per-session-fixed one" — it must stay fully interactive after reopening, never locked to whatever was used last. This phase resolves the initialization question (the brainstorm did not spell out a value) as follows: on reopen, `intentLens` is **seeded** from the `intent_lens` field of the most recent **user** message's `structured_payload` in that session (both `AnalysisRunParams` variants carry `intent_lens`, so this works identically for engine_only and ai_assisted sessions) — i.e. "last used in this session," not hardcoded, not locked. If the session has zero messages yet (created but never used — possible if a user picks New Chat, gets a session id, then closes the app before a first turn), there is nothing to seed from and `intentLens` keeps its existing component-level default (`"buying"`). After seeding, the control behaves exactly as it does in a live session: the user can change it before their next submission, and that submission's `intent_lens` is whatever the control currently shows, not whatever was seeded.

A minimal "Home" navigation affordance is added to `App.tsx`'s header (a button calling `onBackToHome`, visible whenever `activeSession !== null`) — the smallest necessary addition to make the Home/New-Chat/reopen flow actually navigable; it is not a broader session-management UI (no rename/delete/export, per P5c§2).

### P5c§8.5 `ChatView.tsx` (ai_assisted)

```typescript
export interface ChatViewProps {
  intentLens: IntentLens;
  sessionId: string;
  initialMessages?: ChatMessage[];
}

export function historyToChatMessages(messages: HistoryMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role === "user") return { role: "user", text: message.rendered_text };
    const payload = message.structured_payload as AnalysisResult | null;
    const verdict = payload && payload.mode === "ai_assisted" ? payload.verdict : undefined;
    return { role: "assistant", requestId: newRequestId(), text: message.rendered_text, verdict };
  });
}

export function ChatView({ intentLens, sessionId, initialMessages }: ChatViewProps): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages ?? []);
  // ...
  const result = await bridge().runAnalysis({ mode: "ai_assisted", sessionId, query, intent_lens: intentLens, requestId });
  // ... (unchanged beyond threading sessionId into the runAnalysis call)
}
```

`historyToChatMessages` is exported from `ChatView.tsx` (colocated with the `ChatMessage` type it targets) and called from `App.tsx` as `initialMessages={historyToChatMessages(sessionDetail?.messages ?? [])}` when rendering a reopened ai_assisted session. The synthetic `requestId` generated per historical assistant message (via the file's existing `newRequestId()`) is never referenced again by `onNarrative` — that hook only ever matches against `activeRequestId.current`, which always points at the one currently in-flight request — so there is no collision risk between replayed history and a live stream. Once seeded, a reopened `ChatView` behaves exactly like a live one: `onSend` appends new turns to local state and calls `runAnalysis` with the same `sessionId`, which (per P5c§7.3) resumes the same `claude_session_id`.

### P5c§8.6 `AnalysisResult.tsx` (engine_only) — last result plus history

```typescript
export interface AnalysisResultViewProps {
  result: AnalysisResult;
  history?: HistoryMessage[];
}
```

`App.tsx` derives both props from `sessionDetail` with one rule, precise enough to handle the orphaned-trailing-user-message case (P5c§7.2) without special-casing it:

```typescript
function deriveEngineOnlyView(detail: SessionDetail | null): { result?: AnalysisResult; history: HistoryMessage[] } {
  const messages = detail?.messages ?? [];
  const lastAssistantIndex = messages.map((m) => m.role).lastIndexOf("assistant");
  if (lastAssistantIndex === -1) return { history: messages };
  return {
    result: messages[lastAssistantIndex].structured_payload as AnalysisResult,
    history: messages.filter((_, index) => index !== lastAssistantIndex),
  };
}
```

The most recent assistant message's `structured_payload` renders as the live result (through `AnalysisResultView`'s existing, unchanged body — direction/conviction/confluence stats, the response text); every other message — including any trailing orphaned user turn with no reply — renders in a collapsible "past turns in this session" list above it, via the existing `MessageMarkdown` component:

```typescript
{history.length > 0 && (
  <details className="session-history">
    <summary>Past turns in this session</summary>
    <ul>
      {history.map((message, index) => (
        <li key={index} className={`message message-${message.role}`}>
          <MessageMarkdown text={message.rendered_text} />
        </li>
      ))}
    </ul>
  </details>
)}
```

`App.tsx`'s engine_only render calls `deriveEngineOnlyView(sessionDetail)` and only mounts `AnalysisResultView` once a result exists (there is nothing to show yet for a brand-new, never-run session):

```typescript
const { result, history } = deriveEngineOnlyView(sessionDetail);
// ...
{result && <AnalysisResultView result={result} history={history} />}
```

`App.tsx`'s engine_only `onAnalyze` refetches `getSession(activeSession.id)` after every successful `runAnalysis` call and stores the result in `sessionDetail`, so `result`/`history` are always derived from the store's own up-to-date truth rather than a separately-maintained client mirror that could drift from it:

```typescript
const onAnalyze = async (instrument: InstrumentSelection, horizon: Horizon): Promise<void> => {
  if (!activeSession) return;
  setAnalysisError(null);
  try {
    await bridge().runAnalysis({ mode: "engine_only", sessionId: activeSession.id, instrument, horizon, intent_lens: intentLens });
    setSessionDetail(await bridge().getSession(activeSession.id));
  } catch (error) {
    setAnalysisError((error as Error).message);
  }
};
```

This one extra IPC round-trip per turn is an acceptable cost against a local SQLite file with no concurrent writers — not a performance concern for a personal, single-user app.

`InstrumentSearch.tsx` needs **no change**: it never constructs `AnalysisRunParams` itself (its `onSubmit: (instrument, horizon) => void` callback is unchanged); `App.tsx`'s `onAnalyze` is the only place that assembles the run params, and that is where `sessionId` gets threaded in.

## P5c§9 Testing strategy

- **`historyStore.test.ts`** (new): a real `better-sqlite3` `:memory:` database, no mocking — matching this codebase's established preference for real-integration tests over internal-collaborator mocks (`aiAssisted.integration.test.ts`). Covers: opening twice against the same file is idempotent (no error, no data loss); `createSession` returns `preview: "(no messages yet)"`; `appendMessage` bumps `last_active_at` and is retrievable via `getSession`; `listSessions` orders by `last_active_at DESC` and derives `preview` from the most recent message, collapsing whitespace and truncating past 120 chars; a session with no messages previews as `"(no messages yet)"`; `getClaudeSessionId`/`setClaudeSessionId` round-trip and default to `null`; `getSession` on an unknown id returns `null`; `getClaudeSessionId` on an unknown id throws; `appendMessage` against a nonexistent `sessionId` throws a foreign-key-constraint error (proving `PRAGMA foreign_keys = ON` actually took effect).
- **`historyBridge.test.ts`** (new): the existing bridge-registration test harness pattern (`analysisBridge.test.ts`'s `Map`-of-channel-to-handler style) with a fake `Pick<HistoryStore, ...>` double — asserts each channel forwards to the right store method and that `history:getSession` throws (not returns `null`) on an unknown id.
- **`analysisBridge.test.ts`** extension: a fake `history` double (not real `better-sqlite3` — already proven real in `historyStore.test.ts`) records calls in order. New assertions: the user-message `appendMessage` call happens before the sidecar/provider call resolves, for both `runAnalysisRequest` and `runAiAssistedRequest`; when the underlying call throws (mocked sidecar/provider rejection), the user-message write happened but the assistant-message write did not, and the error still rethrows; `getClaudeSessionId` returning `null` drives `completeAiAssisted` to receive a freshly-generated `claudeSessionId` and `resumeSession: false`, followed by exactly one `setClaudeSessionId` call with that id; `getClaudeSessionId` returning an existing id drives `resumeSession: true` with that same id and **no** `setClaudeSessionId` call; a `completeAiAssisted` rejection on a session with no prior `claude_session_id` results in **no** `setClaudeSessionId` call (proving the failure-before-persist resolution in P5c§7.3).
- **`aiAssisted.integration.test.ts`** extension: threads a `sessionId` and a fake history double through the existing scripted-subprocess pipeline test, asserting the final `AnalysisResult` is unaffected and that history capture composes correctly with the real (mocked-subprocess) `ClaudeCliProvider`.
- **`claudeProvider.test.ts`** extension: `buildClaudeArgs` emits `--session-id <uuid>` when `claudeSessionId` is set and `resumeSession` is falsy/absent; emits `--resume <uuid>` when both are set; `--print <prompt>` stays the last pair in both cases; the three safety flags still come first (extends the existing combinatorial "never drops or reorders the safety flags" test with these two new option shapes); omitting `claudeSessionId` entirely emits neither flag and produces byte-identical argv to today (mirrors the existing `allowWebTools` additive-parity test).
- **`streamingNarrative.test.ts`** extension: a fake `spawnFn` captures argv; asserts `makeNarrativeStreamer` forwards `claudeSessionId`/`resumeSession` from `NarrativeStreamSpec` into the underlying `spawnClaude` call unchanged, on top of the existing scripted-NDJSON token/result assertions.
- **`claudeCliProvider.test.ts`** extension: asserts `completeAiAssisted` forwards `opts.claudeSessionId`/`opts.resumeSession` into the one `streamNarrative` call, and that the `runPersonaPipeline` call it makes is unaffected (same arguments as before this phase).
- **Renderer tests** (`App.test.tsx`, `ChatView.test.tsx`, `AnalysisResult.test.tsx`, plus new `HomeScreen.test.tsx`/`HistorySidebar.test.tsx`): `testBridge.ts`'s `installBridge` default gains `createSession`/`listSessions`/`getSession` stubs. Existing `App.test.tsx` tests that currently click a mode-picker button directly must be updated to first click "New Chat" (Home now renders first). New coverage: Home renders first and lists sessions from `listSessions()`; New Chat → mode picker → `createSession` called with the picked mode → login gate/lens/mode view as before; opening a session from `HistorySidebar` calls `getSession`, restores `mode` and `activeSession`, and seeds `intentLens` from the session's last user message; a reopened ai_assisted session's `ChatView` shows the replayed messages before any new turn; a reopened engine_only session shows the last result via `AnalysisResultView` plus a collapsed "past turns" list; a new turn in a reopened session calls `runAnalysis` with the same `sessionId` as the reopened session's id.

## P5c§10 Manual verification checklist

Mirrors P5a§11/P5b§11: an automatable golden path, never a blocker for calling 5c done.

**Automatable (mocked bridge + `npm start`):** Home shows first with an empty session list on a fresh `history.sqlite3`; New Chat in each mode creates a session and proceeds through the existing login/lens/mode flow; sending a couple of turns in AI-Assisted, then reopening the app, shows the session in Home with a sensible preview and last-active time; reopening it restores the chat transcript and pre-selects the last-used intent lens, still changeable; the equivalent engine_only reopen shows the last result plus a collapsed history of prior turns.

**Live follow-ups (real Kite + real `claude` auth):** a second AI-Assisted turn in the same reopened session actually resumes — confirmed via `claude`'s own debug output (`--debug`) showing `--resume <uuid>` in argv on turn 2 where turn 1 showed `--session-id <uuid>`, and the narrative's prose referencing the earlier turn's framing; the three analytical personas and synthesis call, inspected the same way, never show `--session-id`/`--resume` at all, on any turn; killing the app mid-narrative-stream (simulating a crash) and reopening the session shows the orphaned user message with no reply, exactly as designed, not silently dropped.

## P5c§11 Relationship to existing design (flagged tensions & resolutions)

1. **Real Claude continuity is a new decision, not something §8.5 already settled.** §8.5 described `--resume`/`--session-id` only to distinguish it from the UI-level transcript store it was specifying ("Distinct from Claude's own multi-turn memory..."). It never decided whether this app would use that mechanism. This phase makes that decision (P5c§1, P5c§5) — the single biggest way this doc goes further than §8.5, not a contradiction of it.
2. **Schema divergence from §8.5's sketch.** §8.5 sketched `sessions(id, started_at, ended_at, response_mode, instrument(s) touched)`. This phase's locked schema (P5c§3.1) has no `ended_at` (the session model explicitly has no "end," P5c§4) and no `instrument(s) touched` column (deliberately not denormalized — the instruments a session touched are already recoverable from each message's `structured_payload` when needed, e.g. for a richer session-list entry later, without a column that could drift out of sync with the messages that actually determine it). It adds `claude_session_id`, which §8.5's sketch had no reason to anticipate since it wasn't yet deciding on real continuity. **Resolution:** treat P5c§3.1 as superseding §8.5's sketch, not extending it verbatim — called out explicitly rather than left as a silent inconsistency between the two docs.
3. **A pre-existing, unrelated, still-unpopulated `session_id` field.** `AnalysisEnvelope` (in `contracts.ts`, present since Phase 4) already has an optional `session_id?: string` that has never been populated by `assembleEnvelope` and is not touched by this phase. It is unrelated to this phase's new `sessionId` (the history/chat-thread identifier) despite the name collision — flagged here, per P5c§6.2's naming note, so a future reader doesn't conflate the two or assume this phase populated the older field. Left alone deliberately: renaming or repurposing it is out of this phase's scope (P5c§13).
4. **A native Node addon, in a codebase that specifically avoided one for the compute layer.** §3/§11 chose a Rust sidecar partly to avoid native-Node-addon cross-compilation risk. `better-sqlite3` reintroduces a native Node addon, but for a different reason (embedded persistence, not compute) and without the cross-compilation shape that made the sidecar's alternative risky — each dev machine builds its own copy locally (P5c§3.3). Flagged explicitly so the apparent tension reads as considered, not missed.
5. **Existing tests that must change, not just extend.** `App.test.tsx`'s current tests click a mode-picker button as the very first interaction; after this phase, `HomeScreen` renders first and "New Chat" must be clicked before the mode picker appears. This is a real behavior change to an already-passing test suite, not purely additive — called out so it isn't mistaken for scope creep when the next implementation phase touches those tests.

## P5c§12 File layout summary

New:

- `electron-app/src/main/services/history/historyStore.ts` — schema, migration, `HistoryStore` (P5c§3).
- `electron-app/src/main/ipc/historyBridge.ts` — `createSession`/`listSessions`/`getSession` IPC wiring (P5c§6.2).
- `electron-app/src/renderer/HomeScreen.tsx`, `HistorySidebar.tsx` — Home screen + session list (P5c§8.1).
- `electron-app/test/main/services/history/historyStore.test.ts`, `electron-app/test/main/ipc/historyBridge.test.ts`, `electron-app/test/renderer/HomeScreen.test.tsx`, `electron-app/test/renderer/HistorySidebar.test.tsx` (P5c§9).

Changed:

- `electron-app/src/main/ipc/rendererApi.ts` — `sessionId` on both `AnalysisRunParams` variants; `SessionSummary`/`HistoryMessage`/`SessionDetail` re-exports; `RendererApi`/`buildRendererApi` gain the three new methods (P5c§6.1).
- `electron-app/src/main/ipc/analysisBridge.ts` — `history` threaded into `RunAnalysisDeps`/`AiAssistedRequestDeps`/`AnalysisBridgeDeps`; capture chokepoint in both request functions; `claude_session_id` first-call-vs-resume branching (P5c§7).
- `electron-app/src/main/services/claude/claudeProvider.ts` — `ClaudeArgOptions` gains `claudeSessionId?`/`resumeSession?`; `buildClaudeArgs` emits `--session-id`/`--resume` (P5c§5.1).
- `electron-app/src/main/services/claude/provider.ts` — `CompleteAiAssistedOptions` gains required `claudeSessionId: string; resumeSession: boolean` (P5c§5.3).
- `electron-app/src/main/services/claude/claudeCliProvider.ts` — `completeAiAssisted` threads the two fields into the one `streamNarrative` call only; its `runPersonaPipeline` call is unchanged (P5c§5.3).
- `electron-app/src/main/services/claude/streamingNarrative.ts` — `NarrativeStreamSpec` gains the two (optional) fields; `makeNarrativeStreamer`'s spawn call forwards them (P5c§5.1).
- `electron-app/src/main/bootstrap.ts` — construct `HistoryStore` (env-overridable path per P5c§3.2), wire it into `registerAnalysisBridge` and a new `registerHistoryBridge` call, close it in `stop()`.
- `electron-app/src/renderer/App.tsx` — `activeSession`/`showModePicker`/`sessions`/`sessionDetail` state; Home/New-Chat/reopen flow; `intent_lens` seeding on reopen; `sessionId` threaded into both `runAnalysis` call sites; engine_only result/history derivation (P5c§8.2–8.4, P5c§8.6).
- `electron-app/src/renderer/ChatView.tsx` — `sessionId`/`initialMessages` props; exported `historyToChatMessages` (P5c§8.5).
- `electron-app/src/renderer/AnalysisResult.tsx` — `history?: HistoryMessage[]` prop; collapsible past-turns list (P5c§8.6).
- `electron-app/package.json` — `better-sqlite3` (dependency), `@electron/rebuild` + `@types/better-sqlite3` (devDependencies), `postinstall` rebuild script (P5c§3.3).
- `electron-app/test/main/ipc/analysisBridge.test.ts`, `test/main/ipc/aiAssisted.integration.test.ts`, `test/main/services/claude/claudeProvider.test.ts`, `test/main/services/claude/streamingNarrative.test.ts`, `test/main/services/claude/claudeCliProvider.test.ts`, `test/renderer/App.test.tsx`, `test/renderer/ChatView.test.tsx`, `test/renderer/AnalysisResult.test.tsx`, `test/renderer/testBridge.ts` — extended per P5c§9.

Explicitly considered, **not** changed:

- `electron-app/src/main/services/claude/personaPipeline.ts` — no session-continuity fields threaded into `runPersonaPipeline`/`narrativePrompt`; the exclusion is structural, via `PersonaRunSpec<T>`'s fixed shape (P5c§5.3).
- `electron-app/src/main/ipc/preload.ts` — the existing generic `invoke`/`subscribe` wiring already covers the three new methods (P5c§6.1).
- `electron-app/src/renderer/InstrumentSearch.tsx` — never constructs `AnalysisRunParams` itself; `App.tsx`'s `onAnalyze` does (P5c§8.6).
- `electron-app/src/main/services/claude/systemPrompts/*.ts` — no prompt content changes in this phase.
- `electron.vite.config.ts` — `externalizeDepsPlugin()` already handles a native `dependencies` entry correctly; no config change needed (P5c§3.3).

## P5c§13 Out of scope for this phase

- **Engine-Only's "synthetic memory."** Engine-Only mode has no Claude call and therefore nothing analogous to `--resume` — its only memory of past turns is the `structured_payload` history this phase already persists (§9.2, unchanged, restated here per the master doc's own framing). No separate mechanism is built or needed.
- **Session renaming, deletion, or export UI.** Not built. A session persists forever once created; there is no user-facing way to remove one in this phase.
- **Any settings-window, scanning, or scheduler feature.** That is Phase 5d, entirely untouched here — no settings UI, no proactive scan scheduler, no tray-resident behavior.
- **Any change to the hard no-order-placement safety invariant (§2, §4).** Unaffected by this phase, as it must be restated to be for every phase in this project: no method, no allowed tool, and no code path added here can place, modify, or cancel an order.
- **Automatic recovery from a missing `--resume` target** (P5c§5.4) — treated as an ordinary narrative failure.
- **The `auto` horizon** — still deferred (P5a§12 tension 3, P5b§12 tension 5); nothing here depends on or revisits it.
- **Populating `AnalysisEnvelope.news_context` or `AnalysisEnvelope.session_id`.** Both remain exactly as unpopulated as Phase 4/5b left them.
