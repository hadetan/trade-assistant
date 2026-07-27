# Phase 5c — Session/History Store + Real Claude Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every session and message locally in a new Electron-main SQLite store, make sessions browsable and reopenable with New-Chat semantics, and give the narrative-authoring Claude call — and only that call — real multi-turn continuity via `--session-id`/`--resume`.

**Architecture:** A new main-process `HistoryStore` (`better-sqlite3`) owns chat persistence, separate from the Rust sidecar's `rusqlite` and the DuckDB/Parquet lake. `analysisBridge.ts`'s two request functions become the single capture chokepoint (user turn before dispatch, assistant turn only on success). Continuity is threaded as two narrowly-typed, named fields (`claudeSessionId`/`resumeSession`) from `buildClaudeArgs` up through `streamingNarrative` → `provider` → `ClaudeCliProvider.completeAiAssisted` into exactly one `streamNarrative` call; the three parallel analytical personas and the serial synthesis call are excluded structurally (their `PersonaRunSpec` has no such field). The renderer gains a Home screen shown before the mode picker, plus reopen-and-continue with last-used `intent_lens` seeding. No Kite capability, no new Claude tool grant, and no new subprocess-spawning path is added.

**Tech Stack:** TypeScript, Electron 33 (`contextIsolation`/`sandbox` on), React 18 + `@testing-library/react` + jsdom, Vitest, `zod`, `better-sqlite3` (native, Electron-ABI-rebuilt), `@electron/rebuild`, Claude CLI v2.1.209 (`--session-id`/`--resume`, `--output-format stream-json`).

## Global Constraints

Every task's requirements implicitly include this section.

- **Hard safety invariant (non-negotiable, restated every phase):** the app NEVER places, modifies, cancels, or automates any order. This phase adds no Kite capability, no new Claude tool grant, and no new subprocess-spawning path — Claude's tool grants are **unchanged** this phase. Any task whose diff could plausibly be read as expanding Claude's tool access must call that out in its review criteria (none here should — the continuity fields are a self-generated `crypto.randomUUID()` or a value already round-tripped through `historyStore.getClaudeSessionId`, never argv passthrough).
- **Comments:** default to none. Only add one when the *why* isn't obvious (a hidden invariant, a workaround, a formula's source) — never restate what the next line does, never a numbered step-by-step comment block. (From `/Users/salman/ws/trade-assistant/CLAUDE.md`.)
- **Naming:** TypeScript `camelCase` functions/vars, `PascalCase` types/classes/React components, no Hungarian notation, no non-standard abbreviations. File names describe responsibility, not file kind.
- **Structure:** small focused files, one clear responsibility each; pure logic separate from I/O where the codebase already does this. This phase is mostly I/O (a new SQLite store, IPC wiring) — so this mainly means: don't let `historyStore.ts` grow multiple responsibilities; keep query/statement logic together but don't fold in unrelated renderer logic.
- **Commit convention:** every task's implementer commits as the repo's own configured git user (`hadetan <aquibsyed83@gmail.com>`) via plain `git commit` — NEVER pass `--author`, NEVER add a `Co-Authored-By` trailer, NEVER use `--no-verify`. Conventional-commit subjects, matching the sibling plans.
- **`better-sqlite3` is a native module.** The first task adds it as a dependency AND wires the Electron-ABI native rebuild (`@electron/rebuild` in a `postinstall`) so `npm install` in `electron-app/` leaves a working native binary for Electron's own Node ABI on both macOS and Windows dev machines. This must be working and smoke-verified before any task that uses the library, since a broken native module blocks everything downstream. (See Task 1's rationale for the vitest-vs-Electron dual-ABI resolution.)
- **Testing:** `historyStore` tests use a real `better-sqlite3` database (`:memory:` for logic, a real temp file for persistence/idempotency) — **no mocking of the DB layer itself** (matches the codebase's real-integration-over-mocking pattern, e.g. `test/main/ipc/aiAssisted.integration.test.ts`). `analysisBridge` tests may use a fake/in-memory store double since `historyStore` is proven real separately. Every task specifies its exact test file path and exact test code — no placeholders.
- **All commands run from `electron-app/`** unless noted. Full suite: `npm test`. Typecheck: `npm run typecheck` (excludes test files; checks `src/**` only). Per-file: `npx vitest run <path>`. **DB-touching test runs are prefixed with `npm rebuild better-sqlite3`** to guarantee the system-Node ABI build under vitest (see Task 1).
- No test performs a real live Kite OAuth/MCP call, a real `claude` subprocess invocation, or a real web search/fetch — everything is DI-mocked via the established `spawnFn`/`callTool` pattern.

---

### Task 1: `better-sqlite3` dependency + Electron-ABI rebuild wiring + smoke test

Add the native dependency and its rebuild wiring first, and prove the compiled binary loads and opens an in-memory database before any task uses it. `electron.vite.config.ts` needs **no change** — `main`'s `externalizeDepsPlugin()` already leaves `dependencies` as runtime `require()`s, which is exactly what a native `.node` addon needs (P5c§3.3).

**Resolved gap (dual-ABI):** `postinstall`'s `electron-rebuild` leaves the binary at Electron's ABI, but vitest runs under **system Node**, whose ABI differs — a naive setup would make every DB test fail to load the module. Resolution: keep the spec-locked `postinstall` (so the app works right after install), and add `pretest` (`npm rebuild better-sqlite3` → system-Node ABI for vitest) plus `predev`/`prestart` (`electron-rebuild` → Electron ABI before running the app). Each entrypoint self-heals its ABI. This is flagged again in the Self-Review.

**Files:**
- Modify: `electron-app/package.json`
- Test: `electron-app/test/main/services/history/betterSqlite3Smoke.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `better-sqlite3` (dependency), `@electron/rebuild` + `@types/better-sqlite3` (devDependencies), and the `postinstall`/`pretest`/`predev`/`prestart` scripts. No TS exports.

- [ ] **Step 1: Write the failing smoke test** — create `test/main/services/history/betterSqlite3Smoke.test.ts`:

```typescript
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

describe("better-sqlite3 native module", () => {
  it("loads the compiled addon and opens an in-memory database", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
      db.prepare("INSERT INTO t (v) VALUES (?)").run("hello");
      const row = db.prepare("SELECT v FROM t WHERE id = 1").get() as { v: string };
      expect(row.v).toBe("hello");
    } finally {
      db.close();
    }
  });

  it("enforces foreign keys once the pragma is set (proves the build is not a stub)", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      db.exec("CREATE TABLE parent (id TEXT PRIMARY KEY)");
      db.exec("CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id))");
      const insertOrphan = () => db.prepare("INSERT INTO child (id, parent_id) VALUES (?, ?)").run("c1", "nope");
      expect(insertOrphan).toThrow(/FOREIGN KEY/);
    } finally {
      db.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/main/services/history/betterSqlite3Smoke.test.ts`
Expected: FAIL — `better-sqlite3` is not installed (module not found).

- [ ] **Step 3: Add the dependency, devDependencies, and ABI scripts** — edit `electron-app/package.json`. Replace the `"scripts"` block with:

```json
  "scripts": {
    "dev": "electron-vite dev",
    "predev": "electron-rebuild -f -w better-sqlite3",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "start": "electron-vite build && electron-vite preview",
    "prestart": "electron-rebuild -f -w better-sqlite3",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "pretest": "npm rebuild better-sqlite3",
    "postinstall": "electron-rebuild -f -w better-sqlite3"
  },
```

Add to `"devDependencies"` (alongside the existing entries):

```json
    "@electron/rebuild": "^3.7.0",
    "@types/better-sqlite3": "^7.6.11",
```

Add to `"dependencies"` (alongside the existing entries):

```json
    "better-sqlite3": "^11.8.0",
```

- [ ] **Step 4: Install and rebuild for the system-Node ABI, then run the smoke test**

Run: `npm install && npm rebuild better-sqlite3 && npx vitest run test/main/services/history/betterSqlite3Smoke.test.ts`
Expected: `npm install` completes (its `postinstall` runs `electron-rebuild` against Electron's ABI; `npm rebuild better-sqlite3` then restores the system-Node ABI for vitest); smoke test PASS (both cases green).

- [ ] **Step 5: Confirm the full existing suite still passes under the system-Node build**

Run: `npm test`
Expected: PASS (`pretest` re-runs `npm rebuild better-sqlite3`; the pre-existing suite is unaffected).

- [ ] **Step 6: Commit**

```bash
git add electron-app/package.json electron-app/package-lock.json electron-app/test/main/services/history/betterSqlite3Smoke.test.ts
git commit -m "chore(deps): add better-sqlite3 with Electron-ABI rebuild + native smoke test"
```

---

### Task 2: `historyStore.ts` — schema bootstrap + full `HistoryStore` surface

The persistence core: idempotent open-time DDL (both `CREATE TABLE IF NOT EXISTS`, both `CREATE INDEX IF NOT EXISTS`, `PRAGMA foreign_keys = ON`), and the exact `HistoryStore` method surface from P5c§3.5. Mirrors the Rust `StateStore::open` "open-time idempotent DDL" pattern (`rust-core/crates/storage/src/state_store.rs`), carried into TypeScript. Real `better-sqlite3` in tests — no DB mocking.

**Files:**
- Create: `electron-app/src/main/services/history/historyStore.ts`
- Test: `electron-app/test/main/services/history/historyStore.test.ts`

**Interfaces:**
- Consumes: `AnalysisMode` (`import type` from `../../ipc/rendererApi` — erased, type-only; matches `contracts.ts` importing `Horizon` from the same place, no runtime cycle); `randomUUID` (`node:crypto`); `Database` (`better-sqlite3`).
- Produces:
  - `export type MessageRole = "user" | "assistant";`
  - `export interface SessionSummary { id: string; response_mode: AnalysisMode; created_at: string; last_active_at: string; preview: string; }`
  - `export interface HistoryMessage { role: MessageRole; rendered_text: string; structured_payload: unknown; created_at: string; }`
  - `export interface SessionDetail { id: string; response_mode: AnalysisMode; messages: HistoryMessage[]; }`
  - `export interface AppendMessageParams { sessionId: string; role: MessageRole; renderedText: string; structuredPayload?: unknown; }`
  - `export interface HistoryStoreOptions { path: string; now?: () => Date; }`
  - `export class HistoryStore` with `constructor(options: HistoryStoreOptions)`, `createSession(mode: AnalysisMode): SessionSummary`, `listSessions(): SessionSummary[]`, `getSession(id: string): SessionDetail | null`, `appendMessage(params: AppendMessageParams): void`, `getClaudeSessionId(sessionId: string): string | null`, `setClaudeSessionId(sessionId: string, claudeSessionId: string): void`, `close(): void`.

- [ ] **Step 1: Write the failing test** — create `test/main/services/history/historyStore.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryStore } from "../../../../src/main/services/history/historyStore";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ta-history-"));
  tempDirs.push(dir);
  return path.join(dir, "history.sqlite3");
}

// Monotonic clock so created_at / last_active_at are distinct and lexically
// ordered, letting the ORDER BY assertions below be deterministic.
function monotonicNow(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 27, 0, 0, tick++));
}

function memoryStore(): HistoryStore {
  return new HistoryStore({ path: ":memory:", now: monotonicNow() });
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

describe("HistoryStore.createSession", () => {
  it("returns a fresh session with an empty-messages preview", () => {
    const store = memoryStore();
    const session = store.createSession("engine_only");
    expect(session.response_mode).toBe("engine_only");
    expect(session.preview).toBe("(no messages yet)");
    expect(session.created_at).toBe(session.last_active_at);
    expect(session.id).toMatch(/[0-9a-f-]{36}/);
    store.close();
  });
});

describe("HistoryStore.appendMessage / getSession", () => {
  it("persists messages in insertion order and bumps last_active_at", () => {
    const store = memoryStore();
    const session = store.createSession("ai_assisted");
    store.appendMessage({ sessionId: session.id, role: "user", renderedText: "how is infy", structuredPayload: { q: 1 } });
    store.appendMessage({ sessionId: session.id, role: "assistant", renderedText: "constructive", structuredPayload: { mode: "ai_assisted" } });
    const detail = store.getSession(session.id);
    expect(detail).not.toBeNull();
    expect(detail?.response_mode).toBe("ai_assisted");
    expect(detail?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(detail?.messages[0].rendered_text).toBe("how is infy");
    expect(detail?.messages[0].structured_payload).toEqual({ q: 1 });
    const bumped = store.listSessions().find((s) => s.id === session.id);
    expect(bumped?.last_active_at).not.toBe(session.last_active_at);
    store.close();
  });

  it("stores a null structured_payload when none is supplied", () => {
    const store = memoryStore();
    const session = store.createSession("engine_only");
    store.appendMessage({ sessionId: session.id, role: "user", renderedText: "x" });
    expect(store.getSession(session.id)?.messages[0].structured_payload).toBeNull();
    store.close();
  });

  it("returns null for an unknown session id", () => {
    const store = memoryStore();
    expect(store.getSession("missing")).toBeNull();
    store.close();
  });

  it("throws a foreign-key error when appending to a nonexistent session (pragma took effect)", () => {
    const store = memoryStore();
    expect(() => store.appendMessage({ sessionId: "nope", role: "user", renderedText: "x" })).toThrow(/FOREIGN KEY/);
    store.close();
  });
});

describe("HistoryStore.listSessions", () => {
  it("orders by last_active_at DESC and previews the most recent message, whitespace-collapsed", () => {
    const store = memoryStore();
    const a = store.createSession("engine_only");
    const b = store.createSession("ai_assisted");
    store.appendMessage({ sessionId: a.id, role: "user", renderedText: "  first   turn  " });
    const listed = store.listSessions();
    expect(listed.map((s) => s.id)).toEqual([a.id, b.id]);
    expect(listed[0].preview).toBe("first turn");
    expect(listed[1].preview).toBe("(no messages yet)");
    store.close();
  });

  it("truncates a long preview to 120 chars with an ellipsis", () => {
    const store = memoryStore();
    const session = store.createSession("engine_only");
    store.appendMessage({ sessionId: session.id, role: "assistant", renderedText: "x".repeat(200) });
    const preview = store.listSessions()[0].preview;
    expect(preview.length).toBe(121);
    expect(preview.endsWith("…")).toBe(true);
    store.close();
  });
});

describe("HistoryStore claude_session_id", () => {
  it("defaults to null and round-trips through set/get", () => {
    const store = memoryStore();
    const session = store.createSession("ai_assisted");
    expect(store.getClaudeSessionId(session.id)).toBeNull();
    store.setClaudeSessionId(session.id, "claude-uuid-1");
    expect(store.getClaudeSessionId(session.id)).toBe("claude-uuid-1");
    store.close();
  });

  it("throws when reading claude_session_id for an unknown session", () => {
    const store = memoryStore();
    expect(() => store.getClaudeSessionId("missing")).toThrow(/unknown session/);
    store.close();
  });
});

describe("HistoryStore persistence across instances", () => {
  it("re-opens the same file idempotently with no data loss", () => {
    const dbPath = tempDbPath();
    const first = new HistoryStore({ path: dbPath, now: monotonicNow() });
    const session = first.createSession("ai_assisted");
    first.appendMessage({ sessionId: session.id, role: "user", renderedText: "kept" });
    first.setClaudeSessionId(session.id, "persisted-uuid");
    first.close();

    const second = new HistoryStore({ path: dbPath, now: monotonicNow() });
    expect(second.getSession(session.id)?.messages[0].rendered_text).toBe("kept");
    expect(second.getClaudeSessionId(session.id)).toBe("persisted-uuid");
    expect(second.listSessions().map((s) => s.id)).toContain(session.id);
    second.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm rebuild better-sqlite3 && npx vitest run test/main/services/history/historyStore.test.ts`
Expected: FAIL — `historyStore` module does not exist.

- [ ] **Step 3: Implement `historyStore.ts`** — create `electron-app/src/main/services/history/historyStore.ts`:

```typescript
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { Database as DatabaseHandle } from "better-sqlite3";
import type { AnalysisMode } from "../../ipc/rendererApi";

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

const PREVIEW_MAX_LENGTH = 120;

function summarizePreview(latestMessageText: string | null): string {
  if (latestMessageText === null) return "(no messages yet)";
  const collapsed = latestMessageText.replace(/\s+/g, " ").trim();
  return collapsed.length > PREVIEW_MAX_LENGTH ? `${collapsed.slice(0, PREVIEW_MAX_LENGTH)}…` : collapsed;
}

export class HistoryStore {
  private readonly db: DatabaseHandle;
  private readonly now: () => Date;
  private readonly appendMessageTxn: (params: AppendMessageParams, timestamp: string) => void;

  constructor(options: HistoryStoreOptions) {
    this.now = options.now ?? (() => new Date());
    this.db = new Database(options.path);
    // Without this pragma SQLite treats REFERENCES as inert documentation; it
    // must be set per connection, before any write, for the messages ->
    // sessions foreign key to actually be enforced (P5c§3.1).
    this.db.pragma("foreign_keys = ON");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS sessions (
         id TEXT PRIMARY KEY,
         response_mode TEXT NOT NULL,
         claude_session_id TEXT,
         created_at TEXT NOT NULL,
         last_active_at TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS messages (
         id TEXT PRIMARY KEY,
         session_id TEXT NOT NULL REFERENCES sessions(id),
         role TEXT NOT NULL,
         rendered_text TEXT NOT NULL,
         structured_payload TEXT,
         created_at TEXT NOT NULL
       );
       CREATE INDEX IF NOT EXISTS messages_session_id_idx ON messages(session_id);
       CREATE INDEX IF NOT EXISTS sessions_last_active_at_idx ON sessions(last_active_at);`,
    );

    const insertMessage = this.db.prepare(
      `INSERT INTO messages (id, session_id, role, rendered_text, structured_payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const bumpSession = this.db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?");
    this.appendMessageTxn = this.db.transaction((params: AppendMessageParams, timestamp: string) => {
      insertMessage.run(
        randomUUID(),
        params.sessionId,
        params.role,
        params.renderedText,
        params.structuredPayload === undefined ? null : JSON.stringify(params.structuredPayload),
        timestamp,
      );
      bumpSession.run(timestamp, params.sessionId);
    });
  }

  createSession(mode: AnalysisMode): SessionSummary {
    const id = randomUUID();
    const timestamp = this.now().toISOString();
    this.db
      .prepare(
        "INSERT INTO sessions (id, response_mode, claude_session_id, created_at, last_active_at) VALUES (?, ?, NULL, ?, ?)",
      )
      .run(id, mode, timestamp, timestamp);
    return { id, response_mode: mode, created_at: timestamp, last_active_at: timestamp, preview: "(no messages yet)" };
  }

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
      id: string;
      response_mode: AnalysisMode;
      created_at: string;
      last_active_at: string;
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
      .all(id) as Array<{
      role: MessageRole;
      rendered_text: string;
      structured_payload: string | null;
      created_at: string;
    }>;
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

  appendMessage(params: AppendMessageParams): void {
    const timestamp = this.now().toISOString();
    this.appendMessageTxn(params, timestamp);
  }

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
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `npm rebuild better-sqlite3 && npx vitest run test/main/services/history/historyStore.test.ts && npm run typecheck`
Expected: PASS; typecheck clean (`AnalysisMode` resolves via the type-only import; no runtime cycle).

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/history/historyStore.ts electron-app/test/main/services/history/historyStore.test.ts
git commit -m "feat(history): SQLite-backed HistoryStore with idempotent schema bootstrap"
```

---

### Task 3: `rendererApi.ts` — session type re-exports + three new bridge methods

Add the three history methods to `RendererApi`/`buildRendererApi`, re-export the three store-owned types (the same re-export pattern `rendererApi.ts` already uses for `IntentLens`/`Verdict`), and update `testBridge.ts` + `rendererApi.test.ts`. **`AnalysisRunParams` is NOT touched here** — its required `sessionId` addition is coupled to the App/ChatView call sites and lands in Task 9. `preload.ts` needs no change (its generic `invoke` plumbing already covers these three).

**Files:**
- Modify: `electron-app/src/main/ipc/rendererApi.ts`
- Test: `electron-app/test/main/ipc/rendererApi.test.ts`, `electron-app/test/renderer/testBridge.ts`

**Interfaces:**
- Consumes: `SessionSummary`, `HistoryMessage`, `SessionDetail` (Task 2); `AnalysisMode` (already declared in `rendererApi.ts`).
- Produces:
  - `export type { SessionSummary, HistoryMessage, SessionDetail } from "../services/history/historyStore";`
  - `RendererApi` gains `createSession(mode: AnalysisMode): Promise<SessionSummary>;`, `listSessions(): Promise<SessionSummary[]>;`, `getSession(id: string): Promise<SessionDetail>;`
  - `buildRendererApi` returns those three wired to `history:createSession` / `history:listSessions` / `history:getSession`.
  - `installBridge` (test helper) default now includes stubs for all three.

- [ ] **Step 1: Update the failing tests** — replace the first test in `test/main/ipc/rendererApi.test.ts` (the "exactly the six bridge methods" test) and append history-routing tests. The full updated file:

```typescript
import { describe, expect, it, vi } from "vitest";
import { buildRendererApi } from "../../../src/main/ipc/rendererApi";

describe("buildRendererApi", () => {
  it("exposes exactly the nine bridge methods and never leaks the raw transport", () => {
    const api = buildRendererApi(vi.fn().mockResolvedValue({}), vi.fn());
    expect(Object.keys(api).sort()).toEqual([
      "createSession",
      "getSession",
      "getStatus",
      "listSessions",
      "login",
      "onBanner",
      "onNarrative",
      "runAnalysis",
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

describe("buildRendererApi narrative wiring", () => {
  it("subscribes onNarrative to the analysis:narrative push channel", () => {
    const subscribe = vi.fn();
    const api = buildRendererApi(vi.fn(), subscribe);
    const handler = vi.fn();
    api.onNarrative(handler);
    expect(subscribe).toHaveBeenCalledWith("analysis:narrative", handler);
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

Note: the runAnalysis payload tests now include `sessionId` even though Task 3 hasn't added it to the type yet — tests are transpiled (esbuild), not type-checked, so this is a harmless forward-looking payload that Task 9 makes type-exact. The assertion only checks the passthrough is byte-faithful.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/main/ipc/rendererApi.test.ts`
Expected: FAIL — `createSession`/`listSessions`/`getSession` are not on the api; the "nine methods" assertion fails.

- [ ] **Step 3: Implement** — edit `electron-app/src/main/ipc/rendererApi.ts`. Add the re-export + import near the existing `export type { IntentLens, Verdict } ...` lines (top of file):

```typescript
export type { SessionSummary, HistoryMessage, SessionDetail } from "../services/history/historyStore";
import type { SessionSummary, HistoryMessage, SessionDetail } from "../services/history/historyStore";
```

Add the three methods to the `RendererApi` interface (after `runAnalysis`):

```typescript
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

Add the three wirings to `buildRendererApi`'s returned object (after `runAnalysis`):

```typescript
    runAnalysis: (params) => invoke("analysis:run", params) as Promise<AnalysisResult>,
    createSession: (mode) => invoke("history:createSession", { mode }) as Promise<SessionSummary>,
    listSessions: () => invoke("history:listSessions") as Promise<SessionSummary[]>,
    getSession: (id) => invoke("history:getSession", { id }) as Promise<SessionDetail>,
```

The `HistoryMessage` re-export is unused inside `rendererApi.ts` itself but is consumed by later renderer tasks (Task 8/9) via `import type { HistoryMessage } from "../main/ipc/rendererApi"`; keep it exported.

- [ ] **Step 4: Update `testBridge.ts`** — the `installBridge` helper builds a `RendererApi` literal, which now needs the three new methods. Replace `test/renderer/testBridge.ts`:

```typescript
import { vi } from "vitest";
import type { RendererApi } from "../../src/main/ipc/rendererApi";

export function installBridge(overrides: Partial<RendererApi> = {}): RendererApi {
  const bridge: RendererApi = {
    getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "needsLogin", driftWarning: null }),
    onBanner: vi.fn(),
    onNarrative: vi.fn(),
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
    ...overrides,
  };
  (window as unknown as { tradeAssistant: RendererApi }).tradeAssistant = bridge;
  return bridge;
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run test/main/ipc/rendererApi.test.ts test/renderer/ && npm run typecheck`
Expected: PASS (existing renderer suites still green — App still shows the mode picker first; the new bridge methods are present but unused by the current App); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/ipc/rendererApi.ts electron-app/test/main/ipc/rendererApi.test.ts electron-app/test/renderer/testBridge.ts
git commit -m "feat(ipc): expose createSession/listSessions/getSession on the renderer bridge"
```

---

### Task 4: `ipc/historyBridge.ts` — the three history IPC handlers

A new bridge registrar mirroring `analysisBridge.ts`'s `Map`-of-channel-to-handler shape. `history:getSession` is the layer that converts the store's honest `null` (not found) into a thrown error — mirroring `requireSession`'s not-null-vs-throw for the Kite session.

**Files:**
- Create: `electron-app/src/main/ipc/historyBridge.ts`
- Test: `electron-app/test/main/ipc/historyBridge.test.ts`

**Interfaces:**
- Consumes: `HistoryStore` (Task 2) as a `Pick`; `AnalysisMode` (`rendererApi.ts`); `IpcMain` (`electron`).
- Produces:
  - `export interface HistoryBridgeDeps { ipcMain: Pick<IpcMain, "handle">; history: Pick<HistoryStore, "createSession" | "listSessions" | "getSession">; }`
  - `export function registerHistoryBridge(deps: HistoryBridgeDeps): void;`

- [ ] **Step 1: Write the failing test** — create `test/main/ipc/historyBridge.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { registerHistoryBridge } from "../../../src/main/ipc/historyBridge";
import type { HistoryStore } from "../../../src/main/services/history/historyStore";

function harness(history: Pick<HistoryStore, "createSession" | "listSessions" | "getSession">) {
  const handlers = new Map<string, (event: unknown, arg: unknown) => unknown>();
  registerHistoryBridge({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn as never) } as never,
    history,
  });
  return handlers;
}

describe("registerHistoryBridge", () => {
  it("forwards history:createSession to the store with the requested mode", () => {
    const created = { id: "s1", response_mode: "ai_assisted", created_at: "t", last_active_at: "t", preview: "(no messages yet)" };
    const history = {
      createSession: vi.fn().mockReturnValue(created),
      listSessions: vi.fn(),
      getSession: vi.fn(),
    };
    const handlers = harness(history);
    const result = handlers.get("history:createSession")!(null, { mode: "ai_assisted" });
    expect(history.createSession).toHaveBeenCalledWith("ai_assisted");
    expect(result).toBe(created);
  });

  it("forwards history:listSessions to the store", () => {
    const history = {
      createSession: vi.fn(),
      listSessions: vi.fn().mockReturnValue([{ id: "s1" }]),
      getSession: vi.fn(),
    };
    const handlers = harness(history);
    expect(handlers.get("history:listSessions")!(null, undefined)).toEqual([{ id: "s1" }]);
    expect(history.listSessions).toHaveBeenCalledTimes(1);
  });

  it("returns the detail for a known session", () => {
    const detail = { id: "s1", response_mode: "engine_only", messages: [] };
    const history = {
      createSession: vi.fn(),
      listSessions: vi.fn(),
      getSession: vi.fn().mockReturnValue(detail),
    };
    const handlers = harness(history);
    expect(handlers.get("history:getSession")!(null, { id: "s1" })).toBe(detail);
    expect(history.getSession).toHaveBeenCalledWith("s1");
  });

  it("throws (never returns null) for an unknown session id", () => {
    const history = {
      createSession: vi.fn(),
      listSessions: vi.fn(),
      getSession: vi.fn().mockReturnValue(null),
    };
    const handlers = harness(history);
    expect(() => handlers.get("history:getSession")!(null, { id: "missing" })).toThrow(/unknown session missing/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/main/ipc/historyBridge.test.ts`
Expected: FAIL — `historyBridge` module does not exist.

- [ ] **Step 3: Implement `historyBridge.ts`** — create `electron-app/src/main/ipc/historyBridge.ts`:

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

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run test/main/ipc/historyBridge.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/ipc/historyBridge.ts electron-app/test/main/ipc/historyBridge.test.ts
git commit -m "feat(ipc): historyBridge registrar for the three session channels"
```

---

### Task 5: `claudeProvider.ts` — `buildClaudeArgs` emits `--session-id` / `--resume`

The safety-critical arg builder. Two new **optional** `ClaudeArgOptions` fields; a self-generated uuid pins a new conversation (`--session-id`), a persisted uuid resumes one (`--resume`), and they are mutually exclusive per call. **Review criteria (safety):** independently verify the exact flag in each of the three cases (neither set / `claudeSessionId` alone / both set) and that the three unconditional safety flags (`--allowedTools`, `--disallowedTools`, `--strict-mcp-config`) and the web-tool grant are **untouched** — this task widens no tool access.

**Files:**
- Modify: `electron-app/src/main/services/claude/claudeProvider.ts`
- Test: `electron-app/test/main/services/claude/claudeProvider.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ClaudeArgOptions` gains `claudeSessionId?: string;` and `resumeSession?: boolean;`. `buildClaudeArgs` emits `--session-id <uuid>` when `claudeSessionId` is set and `resumeSession` is falsy, `--resume <uuid>` when both are set, neither otherwise; `--print <prompt>` stays the last pair.

- [ ] **Step 1: Write the failing tests** — append to `test/main/services/claude/claudeProvider.test.ts`:

```typescript
describe("session continuity flags (--session-id vs --resume)", () => {
  const uuid = "11111111-2222-3333-4444-555555555555";

  it("pins a new conversation with --session-id when resumeSession is falsy", () => {
    const args = buildClaudeArgs("p", { claudeSessionId: uuid });
    expect(args.slice(args.indexOf("--session-id"), args.indexOf("--session-id") + 2)).toEqual(["--session-id", uuid]);
    expect(args).not.toContain("--resume");
  });

  it("resumes with --resume when both fields are set", () => {
    const args = buildClaudeArgs("p", { claudeSessionId: uuid, resumeSession: true });
    expect(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2)).toEqual(["--resume", uuid]);
    expect(args).not.toContain("--session-id");
  });

  it("emits neither flag and stays byte-identical to today when claudeSessionId is absent", () => {
    expect(buildClaudeArgs("analyze INFY", { resumeSession: true })).toEqual(buildClaudeArgs("analyze INFY"));
    const args = buildClaudeArgs("p", {});
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--resume");
  });

  it("keeps the three safety flags first and --print last for every continuity combination", () => {
    const combos: Array<Parameters<typeof buildClaudeArgs>[1]> = [
      { claudeSessionId: uuid },
      { claudeSessionId: uuid, resumeSession: true },
      { claudeSessionId: uuid, outputFormat: "stream-json", includePartialMessages: true, systemPrompt: "s" },
    ];
    for (const opts of combos) {
      const args = buildClaudeArgs("p", opts);
      expect(args[0]).toBe("--allowedTools");
      expect(args[2]).toBe("--disallowedTools");
      expect(args[3]).toBe(KITE_WRITE_TOOL_DENYLIST);
      expect(args[4]).toBe("--strict-mcp-config");
      expect(args.slice(-2)).toEqual(["--print", "p"]);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/main/services/claude/claudeProvider.test.ts`
Expected: FAIL — `claudeSessionId`/`resumeSession` are not honored; no `--session-id`/`--resume` emitted.

- [ ] **Step 3: Implement** — in `claudeProvider.ts`, add the two fields to `ClaudeArgOptions`:

```typescript
export interface ClaudeArgOptions {
  systemPrompt?: string;
  jsonSchema?: string;
  outputFormat?: "json" | "text" | "stream-json";
  allowWebTools?: boolean;
  includePartialMessages?: boolean;
  claudeSessionId?: string;
  resumeSession?: boolean;
}
```

In `buildClaudeArgs`, insert the continuity flag emission between the `--include-partial-messages` push and the final `--print` push:

```typescript
  if (opts.includePartialMessages) args.push("--include-partial-messages");
  if (opts.claudeSessionId !== undefined) {
    args.push(opts.resumeSession ? "--resume" : "--session-id", opts.claudeSessionId);
  }
  args.push("--print", prompt);
  return args;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/main/services/claude/claudeProvider.test.ts`
Expected: PASS (all existing + new; the existing "byte-identical when falsy"/"safety flags first" tests still hold).

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/claude/claudeProvider.ts electron-app/test/main/services/claude/claudeProvider.test.ts
git commit -m "feat(claude): buildClaudeArgs emits --session-id/--resume for continuity"
```

---

### Task 6: `streamingNarrative.ts` — forward continuity fields into the narrative spawn

`NarrativeStreamSpec` gains the two optional fields; `makeNarrativeStreamer`'s `spawnClaude` call forwards them. Everything else (NDJSON parsing, timeout/abort/kill discipline) is unchanged.

**Files:**
- Modify: `electron-app/src/main/services/claude/streamingNarrative.ts`
- Test: `electron-app/test/main/services/claude/streamingNarrative.test.ts`

**Interfaces:**
- Consumes: `spawnClaude` with the new `claudeSessionId`/`resumeSession` opts (Task 5).
- Produces: `NarrativeStreamSpec` gains `claudeSessionId?: string;` and `resumeSession?: boolean;`; the spawned argv reflects them.

- [ ] **Step 1: Write the failing tests** — append to `test/main/services/claude/streamingNarrative.test.ts` (the `FakeChild`/`delta`/`baseSpec` helpers already exist in the file):

```typescript
describe("makeNarrativeStreamer continuity forwarding", () => {
  const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  function captureArgv(spec: Parameters<ReturnType<typeof makeNarrativeStreamer>>[0]) {
    let captured: string[] = [];
    const child = new FakeChild();
    const run = makeNarrativeStreamer({
      spawnFn: (_c, args) => {
        captured = args;
        return child as never;
      },
    });
    const pending = run(spec);
    child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "done" })}\n`);
    child.emit("exit", 0, null);
    return { captured, pending };
  }

  it("passes --session-id through when pinning a new conversation", async () => {
    const { captured, pending } = captureArgv({ ...baseSpec(() => {}), claudeSessionId: uuid });
    await pending;
    expect(captured.slice(captured.indexOf("--session-id"), captured.indexOf("--session-id") + 2)).toEqual(["--session-id", uuid]);
    expect(captured).not.toContain("--resume");
  });

  it("passes --resume through when resuming", async () => {
    const { captured, pending } = captureArgv({ ...baseSpec(() => {}), claudeSessionId: uuid, resumeSession: true });
    await pending;
    expect(captured.slice(captured.indexOf("--resume"), captured.indexOf("--resume") + 2)).toEqual(["--resume", uuid]);
    expect(captured).not.toContain("--session-id");
  });

  it("passes neither flag when no continuity is requested", async () => {
    const { captured, pending } = captureArgv(baseSpec(() => {}));
    await pending;
    expect(captured).not.toContain("--session-id");
    expect(captured).not.toContain("--resume");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/main/services/claude/streamingNarrative.test.ts`
Expected: FAIL — the argv never carries `--session-id`/`--resume` because the spec fields aren't forwarded.

- [ ] **Step 3: Implement** — in `streamingNarrative.ts`, add the two fields to `NarrativeStreamSpec`:

```typescript
export interface NarrativeStreamSpec {
  systemPrompt: string;
  prompt: string;
  onToken: (text: string) => void;
  signal?: AbortSignal;
  claudeSessionId?: string;
  resumeSession?: boolean;
}
```

Forward them in the `spawnClaude` call:

```typescript
    const child = spawnClaude(
      spec.prompt,
      {
        systemPrompt: spec.systemPrompt,
        outputFormat: "stream-json",
        includePartialMessages: true,
        claudeSessionId: spec.claudeSessionId,
        resumeSession: spec.resumeSession,
      },
      spawnFn,
    );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/main/services/claude/streamingNarrative.test.ts && npm run typecheck`
Expected: PASS (existing NDJSON/timeout/abort tests still green); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/claude/streamingNarrative.ts electron-app/test/main/services/claude/streamingNarrative.test.ts
git commit -m "feat(claude): forward continuity fields into the narrative stream spawn"
```

---

### Task 7: `HomeScreen.tsx` + `HistorySidebar.tsx` — the pre-mode-picker Home screen

Two small presentational components. `HomeScreen` is the first thing shown, ahead of `ModePicker` (mirroring how 5b made `ModePicker` first). They are new files, not yet rendered by `App`, so this task is fully additive.

**Files:**
- Create: `electron-app/src/renderer/HistorySidebar.tsx`, `electron-app/src/renderer/HomeScreen.tsx`
- Test: `electron-app/test/renderer/HistorySidebar.test.tsx`, `electron-app/test/renderer/HomeScreen.test.tsx`

**Interfaces:**
- Consumes: `SessionSummary` (`rendererApi.ts` re-export, Task 3).
- Produces:
  - `export interface HistorySidebarProps { sessions: SessionSummary[]; onOpenSession: (id: string) => void; }`
  - `export function HistorySidebar(props: HistorySidebarProps): JSX.Element;`
  - `export interface HomeScreenProps { sessions: SessionSummary[]; onNewChat: () => void; onOpenSession: (id: string) => void; }`
  - `export function HomeScreen(props: HomeScreenProps): JSX.Element;`

- [ ] **Step 1: Write the failing tests** — create `test/renderer/HistorySidebar.test.tsx`:

```typescript
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistorySidebar } from "../../src/renderer/HistorySidebar";
import type { SessionSummary } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);

const sessions: SessionSummary[] = [
  { id: "s1", response_mode: "ai_assisted", created_at: "t", last_active_at: "t2", preview: "how is infy" },
  { id: "s2", response_mode: "engine_only", created_at: "t", last_active_at: "t1", preview: "(no messages yet)" },
];

describe("HistorySidebar", () => {
  it("renders one entry per session showing its preview", () => {
    render(<HistorySidebar sessions={sessions} onOpenSession={vi.fn()} />);
    expect(screen.getByText("how is infy")).toBeTruthy();
    expect(screen.getByText("(no messages yet)")).toBeTruthy();
  });

  it("calls onOpenSession with the session id when an entry is clicked", () => {
    const onOpenSession = vi.fn();
    render(<HistorySidebar sessions={sessions} onOpenSession={onOpenSession} />);
    fireEvent.click(screen.getByText("how is infy"));
    expect(onOpenSession).toHaveBeenCalledWith("s1");
  });
});
```

Create `test/renderer/HomeScreen.test.tsx`:

```typescript
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeScreen } from "../../src/renderer/HomeScreen";
import type { SessionSummary } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);

const sessions: SessionSummary[] = [
  { id: "s1", response_mode: "ai_assisted", created_at: "t", last_active_at: "t2", preview: "how is infy" },
];

describe("HomeScreen", () => {
  it("offers New Chat and lists existing sessions", () => {
    const onNewChat = vi.fn();
    render(<HomeScreen sessions={sessions} onNewChat={onNewChat} onOpenSession={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /new chat/i }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(screen.getByText("how is infy")).toBeTruthy();
  });

  it("forwards a session click to onOpenSession", () => {
    const onOpenSession = vi.fn();
    render(<HomeScreen sessions={sessions} onNewChat={vi.fn()} onOpenSession={onOpenSession} />);
    fireEvent.click(screen.getByText("how is infy"));
    expect(onOpenSession).toHaveBeenCalledWith("s1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/renderer/HomeScreen.test.tsx test/renderer/HistorySidebar.test.tsx`
Expected: FAIL — both modules are missing.

- [ ] **Step 3: Implement `HistorySidebar.tsx`** — create `electron-app/src/renderer/HistorySidebar.tsx`:

```typescript
import type { SessionSummary } from "../main/ipc/rendererApi";

export interface HistorySidebarProps {
  sessions: SessionSummary[];
  onOpenSession: (id: string) => void;
}

export function HistorySidebar({ sessions, onOpenSession }: HistorySidebarProps): JSX.Element {
  return (
    <ul className="history-sidebar">
      {sessions.map((session) => (
        <li key={session.id}>
          <button type="button" className={`session session-${session.response_mode}`} onClick={() => onOpenSession(session.id)}>
            <span className="session-mode">{session.response_mode}</span>
            <span className="session-preview">{session.preview}</span>
            <span className="session-active-at">{session.last_active_at}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Implement `HomeScreen.tsx`** — create `electron-app/src/renderer/HomeScreen.tsx`:

```typescript
import { HistorySidebar } from "./HistorySidebar";
import type { SessionSummary } from "../main/ipc/rendererApi";

export interface HomeScreenProps {
  sessions: SessionSummary[];
  onNewChat: () => void;
  onOpenSession: (id: string) => void;
}

export function HomeScreen({ sessions, onNewChat, onOpenSession }: HomeScreenProps): JSX.Element {
  return (
    <section className="home-screen">
      <button type="button" onClick={onNewChat}>
        New Chat
      </button>
      <HistorySidebar sessions={sessions} onOpenSession={onOpenSession} />
    </section>
  );
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run test/renderer/HomeScreen.test.tsx test/renderer/HistorySidebar.test.tsx && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/renderer/HistorySidebar.tsx electron-app/src/renderer/HomeScreen.tsx electron-app/test/renderer/HistorySidebar.test.tsx electron-app/test/renderer/HomeScreen.test.tsx
git commit -m "feat(renderer): Home screen with session-history sidebar"
```

---

### Task 8: `AnalysisResult.tsx` — optional `history` prop + collapsible past-turns list

Engine-Only's result view gains an optional `history` prop rendering prior turns (including any orphaned trailing user turn, P5c§7.2) in a collapsible list above the last result. The prop is **optional**, so `App`'s current `<AnalysisResultView result={result} />` render stays valid — this task is additive and does not touch `AnalysisRunParams`.

**Files:**
- Modify: `electron-app/src/renderer/AnalysisResult.tsx`
- Test: `electron-app/test/renderer/AnalysisResult.test.tsx`

**Interfaces:**
- Consumes: `HistoryMessage` (`rendererApi.ts` re-export, Task 3); `MessageMarkdown` (existing).
- Produces: `AnalysisResultViewProps` gains `history?: HistoryMessage[];`; the component renders a `<details className="session-history">` list when `history` is non-empty.

- [ ] **Step 1: Update the failing test** — replace the body of `test/renderer/AnalysisResult.test.tsx` with:

```typescript
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AnalysisResultView } from "../../src/renderer/AnalysisResult";
import type { AnalysisResult, HistoryMessage } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);

const result: AnalysisResult = {
  mode: "engine_only",
  instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
  horizon: "positional",
  response: {
    direction: "bullish",
    conviction: "high",
    text: "Overall read: bullish (high conviction).\nConfluence: 4 bullish / 1 bearish / 0 neutral, weighted vote +0.62.",
    confluence: { bullish_count: 4, bearish_count: 1, neutral_count: 0, weighted_vote: 0.62 },
  },
  algo_results: [],
};

describe("AnalysisResultView", () => {
  it("renders the prose through the markdown pipeline and the raw confluence numbers", async () => {
    render(<AnalysisResultView result={result} />);
    expect(await screen.findByText(/Overall read: bullish/)).toBeTruthy();
    expect(screen.getByText("bullish")).toBeTruthy();
    expect(screen.getByText("0.62")).toBeTruthy();
    expect(screen.queryByText(/Past turns in this session/i)).toBeNull();
  });

  it("renders prior turns in a collapsible list when history is supplied", async () => {
    const history: HistoryMessage[] = [
      { role: "user", rendered_text: "earlier question", structured_payload: null, created_at: "t0" },
      { role: "assistant", rendered_text: "earlier answer", structured_payload: null, created_at: "t1" },
    ];
    render(<AnalysisResultView result={result} history={history} />);
    expect(screen.getByText(/Past turns in this session/i)).toBeTruthy();
    expect(await screen.findByText(/earlier question/)).toBeTruthy();
    expect(await screen.findByText(/earlier answer/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/renderer/AnalysisResult.test.tsx`
Expected: FAIL — no `history` prop; the "Past turns" list is never rendered.

- [ ] **Step 3: Implement** — replace `electron-app/src/renderer/AnalysisResult.tsx`:

```typescript
import type { AnalysisResult, HistoryMessage } from "../main/ipc/rendererApi";
import { MessageMarkdown } from "./MessageMarkdown";

export interface AnalysisResultViewProps {
  result: AnalysisResult;
  history?: HistoryMessage[];
}

// Matches the precision the prose paragraph renders at (see
// deterministicResponseGenerator.ts's formatVote) so the stat tile can never
// show raw floating-point noise (e.g. 0.6200000000000001) next to prose that
// reads a clean "+0.62".
function formatWeightedVote(vote: number): string {
  return vote.toFixed(2);
}

export function AnalysisResultView({ result, history = [] }: AnalysisResultViewProps): JSX.Element | null {
  if (result.mode !== "engine_only") return null;
  const { response } = result;
  const stats: Array<[string, string | number]> = [
    ["Direction", response.direction],
    ["Conviction", response.conviction],
    ["Bullish", response.confluence.bullish_count],
    ["Bearish", response.confluence.bearish_count],
    ["Neutral", response.confluence.neutral_count],
    ["Weighted vote", formatWeightedVote(response.confluence.weighted_vote)],
  ];
  return (
    <section className="analysis-result">
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
      <MessageMarkdown text={response.text} />
      <dl className="confluence">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/renderer/AnalysisResult.test.tsx && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/renderer/AnalysisResult.tsx electron-app/test/renderer/AnalysisResult.test.tsx
git commit -m "feat(renderer): collapsible past-turns list on the Engine-Only result view"
```

---

### Task 9: `App.tsx` + `ChatView.tsx` + `AnalysisRunParams.sessionId` — the renderer session flow

The coupled renderer unit. Making `AnalysisRunParams.sessionId` **required** (both variants, per the spec) breaks both `runAnalysis` call sites at once, and making `ChatView`'s `sessionId` prop required breaks `App`'s render — so the type change, `ChatView`, and `App` land in one commit to keep `tsc` green. `App` now shows Home first, drives New-Chat → mode picker → `createSession`, reopens sessions with `getSession`, seeds (not locks) `intent_lens` from the last user message, threads `sessionId` into both runs, and re-fetches `getSession` after each Engine-Only turn so the rendered result/history always reflect the store's truth. `InstrumentSearch.tsx` is **not** touched (it never builds `AnalysisRunParams` — `App.onAnalyze` does).

**Files:**
- Modify: `electron-app/src/main/ipc/rendererApi.ts` (add `sessionId` to both `AnalysisRunParams` variants)
- Modify: `electron-app/src/renderer/ChatView.tsx`, `electron-app/src/renderer/App.tsx`
- Test: `electron-app/test/renderer/ChatView.test.tsx`, `electron-app/test/renderer/App.test.tsx`

**Interfaces:**
- Consumes: `HomeScreen` (Task 7), `AnalysisResultView` w/ `history` (Task 8), `ModePicker`/`IntentLensSelector`/`InstrumentSearch` (existing), `createSession`/`listSessions`/`getSession` (Task 3), `SessionSummary`/`SessionDetail`/`HistoryMessage`/`AnalysisRunParams`/`AnalysisResult`/`AnalysisMode`/`IntentLens` (`rendererApi.ts`).
- Produces:
  - `AnalysisRunParams` = `{ mode: "engine_only"; sessionId: string; instrument: InstrumentSelection; horizon: Horizon; intent_lens: IntentLens } | { mode: "ai_assisted"; sessionId: string; query: string; intent_lens: IntentLens; requestId: string }`.
  - `ChatViewProps` gains `sessionId: string;` and `initialMessages?: ChatMessage[];`; `export function historyToChatMessages(messages: HistoryMessage[]): ChatMessage[];`.
  - `App` renders the Home → mode picker → login → lens → mode-specific flow with reopen-and-continue.

- [ ] **Step 1: Update the failing tests** — replace `test/renderer/ChatView.test.tsx`:

```typescript
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView, historyToChatMessages } from "../../src/renderer/ChatView";
import { installBridge } from "./testBridge";
import type { HistoryMessage, NarrativeEvent } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);

describe("ChatView", () => {
  it("submits an ai_assisted run with the session id, lens and a requestId, then streams tokens", async () => {
    let narrativeHandler: ((event: NarrativeEvent) => void) | undefined;
    const bridge = installBridge({
      onNarrative: vi.fn((handler) => {
        narrativeHandler = handler as (event: NarrativeEvent) => void;
      }),
      runAnalysis: vi.fn(async (params) => {
        if (params.mode !== "ai_assisted") throw new Error("mode");
        narrativeHandler?.({ requestId: params.requestId, chunk: "Infy " });
        narrativeHandler?.({ requestId: params.requestId, chunk: "constructive." });
        narrativeHandler?.({ requestId: params.requestId, done: true });
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

  it("seeds its transcript from initialMessages so a reopened session shows prior turns", () => {
    installBridge({ onNarrative: vi.fn(), runAnalysis: vi.fn() });
    const history: HistoryMessage[] = [
      { role: "user", rendered_text: "earlier ask", structured_payload: null, created_at: "t0" },
      {
        role: "assistant",
        rendered_text: "earlier reply",
        structured_payload: { mode: "ai_assisted", verdict: { direction: "bearish", conviction: "low", reasoning: "x", cited_algo_ids: ["rsi"], verify_before_acting: "y" } },
        created_at: "t1",
      },
    ];
    render(<ChatView intentLens="selling" sessionId="sess-9" initialMessages={historyToChatMessages(history)} />);
    expect(screen.getByText(/earlier ask/)).toBeTruthy();
    expect(screen.getByText(/earlier reply/)).toBeTruthy();
    expect(screen.getByText(/bearish/i)).toBeTruthy();
  });

  it("shows an error when the run rejects", async () => {
    installBridge({ onNarrative: vi.fn(), runAnalysis: vi.fn().mockRejectedValue(new Error("claude down")) });
    render(<ChatView intentLens="selling" sessionId="sess-9" />);
    fireEvent.change(screen.getByLabelText(/ask about an instrument/i), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByText(/claude down/)).toBeTruthy();
  });
});
```

Replace `test/renderer/App.test.tsx` (existing flows now click "New Chat" first; new coverage for Home/reopen/seeding/sessionId):

```typescript
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/App";
import { installBridge } from "./testBridge";

afterEach(cleanup);

async function startEngineOnlyChat(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /new chat/i }));
  fireEvent.click(await screen.findByRole("button", { name: /engine-only/i }));
}

describe("App", () => {
  it("renders the status line from the bridge", async () => {
    installBridge();
    render(<App />);
    await startEngineOnlyChat();
    expect(await screen.findByText(/sidecar: up \| kite: needsLogin/)).toBeTruthy();
  });

  it("shows Home first and lists existing sessions from the bridge", async () => {
    installBridge({
      listSessions: vi.fn().mockResolvedValue([
        { id: "s1", response_mode: "ai_assisted", created_at: "t", last_active_at: "t", preview: "how is infy" },
      ]),
    });
    render(<App />);
    expect(await screen.findByRole("button", { name: /new chat/i })).toBeTruthy();
    expect(await screen.findByText("how is infy")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /engine-only/i })).toBeNull();
  });

  it("shows the Login button after New Chat + mode, and no analysis form", async () => {
    installBridge();
    render(<App />);
    await startEngineOnlyChat();
    expect(await screen.findByRole("button", { name: /login to kite/i })).toBeTruthy();
    expect(screen.queryByLabelText(/instrument search/i)).toBeNull();
  });

  it("creates a session with the picked mode on New Chat", async () => {
    const bridge = installBridge();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new chat/i }));
    fireEvent.click(await screen.findByRole("button", { name: /ai-assisted/i }));
    await waitFor(() => expect(bridge.createSession).toHaveBeenCalledWith("ai_assisted"));
  });

  it("gates the login button behind Home + mode picker, then reflects authenticated status", async () => {
    const bridge = installBridge({
      getStatus: vi
        .fn()
        .mockResolvedValueOnce({ sidecar: "up", kiteSession: "needsLogin", driftWarning: null })
        .mockResolvedValueOnce({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
    });
    render(<App />);
    expect(screen.queryByRole("button", { name: /login to kite/i })).toBeNull();
    await startEngineOnlyChat();
    fireEvent.click(await screen.findByRole("button", { name: /login to kite/i }));
    await waitFor(() => expect(bridge.login).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/kite: authenticated/)).toBeTruthy();
  });

  it("runs an Engine-Only analysis with the session id and chosen intent lens", async () => {
    const bridge = installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      searchInstruments: vi.fn().mockResolvedValue({
        data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      }),
      runAnalysis: vi.fn().mockResolvedValue({
        mode: "engine_only",
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
        horizon: "positional",
        response: { direction: "bullish", conviction: "high", text: "Overall read: bullish.", confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 } },
        algo_results: [],
      }),
    });
    render(<App />);
    await startEngineOnlyChat();
    fireEvent.click(screen.getByLabelText(/selling stance/i));
    fireEvent.change(await screen.findByLabelText(/instrument search/i), { target: { value: "infy" } });
    fireEvent.click(await screen.findByRole("button", { name: "NSE:INFY" }));
    fireEvent.click(screen.getByLabelText(/positional/i));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));
    await waitFor(() =>
      expect(bridge.runAnalysis).toHaveBeenCalledWith({
        mode: "engine_only",
        sessionId: "session-1",
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        horizon: "positional",
        intent_lens: "selling",
      }),
    );
  });

  it("shows an error message when analysis fails instead of failing silently", async () => {
    installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      searchInstruments: vi.fn().mockResolvedValue({
        data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      }),
      runAnalysis: vi.fn().mockRejectedValue(new Error("sidecar unreachable")),
    });
    render(<App />);
    await startEngineOnlyChat();
    fireEvent.change(await screen.findByLabelText(/instrument search/i), { target: { value: "infy" } });
    fireEvent.click(await screen.findByRole("button", { name: "NSE:INFY" }));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));
    expect(await screen.findByText(/sidecar unreachable/)).toBeTruthy();
  });

  it("reopens an ai_assisted session, replays its transcript, and seeds the last-used lens", async () => {
    installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      listSessions: vi.fn().mockResolvedValue([
        { id: "s7", response_mode: "ai_assisted", created_at: "t", last_active_at: "t", preview: "prior ask" },
      ]),
      getSession: vi.fn().mockResolvedValue({
        id: "s7",
        response_mode: "ai_assisted",
        messages: [
          { role: "user", rendered_text: "prior ask", structured_payload: { mode: "ai_assisted", sessionId: "s7", query: "prior ask", intent_lens: "selling", requestId: "r0" }, created_at: "t0" },
          { role: "assistant", rendered_text: "prior reply", structured_payload: { mode: "ai_assisted" }, created_at: "t1" },
        ],
      }),
    });
    render(<App />);
    fireEvent.click(await screen.findByText("prior ask"));
    expect(await screen.findByText(/prior reply/)).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText(/selling stance/i) as HTMLInputElement).checked).toBe(true));
  });

  it("continues a reopened ai_assisted session with the same session id", async () => {
    const runAnalysis = vi.fn().mockResolvedValue({
      mode: "ai_assisted",
      instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
      horizon: "positional",
      intent_lens: "selling",
      verdict: { direction: "bullish", conviction: "high", reasoning: "rsi", cited_algo_ids: ["rsi"], verify_before_acting: "x" },
      narrative: "fresh reply",
      algo_results: [],
      confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
    });
    installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      onNarrative: vi.fn(),
      runAnalysis,
      listSessions: vi.fn().mockResolvedValue([{ id: "s7", response_mode: "ai_assisted", created_at: "t", last_active_at: "t", preview: "prior ask" }]),
      getSession: vi.fn().mockResolvedValue({ id: "s7", response_mode: "ai_assisted", messages: [] }),
    });
    render(<App />);
    fireEvent.click(await screen.findByText("prior ask"));
    fireEvent.change(await screen.findByLabelText(/ask about an instrument/i), { target: { value: "next turn" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(runAnalysis).toHaveBeenCalledTimes(1));
    expect((runAnalysis.mock.calls[0][0] as { sessionId: string }).sessionId).toBe("s7");
  });

  it("shows the AI-Assisted chat input after New Chat + AI-Assisted + login", async () => {
    installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new chat/i }));
    fireEvent.click(await screen.findByRole("button", { name: /ai-assisted/i }));
    expect(await screen.findByLabelText(/ask about an instrument/i)).toBeTruthy();
    expect(screen.getByText(/claude auth login/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/renderer/App.test.tsx test/renderer/ChatView.test.tsx`
Expected: FAIL — `historyToChatMessages` is not exported; `App` has no Home/New-Chat flow; `runAnalysis` is not called with `sessionId`.

- [ ] **Step 3: Add `sessionId` to `AnalysisRunParams`** — in `electron-app/src/main/ipc/rendererApi.ts`, replace the `AnalysisRunParams` union:

```typescript
export type AnalysisRunParams =
  | { mode: "engine_only"; sessionId: string; instrument: InstrumentSelection; horizon: Horizon; intent_lens: IntentLens }
  | { mode: "ai_assisted"; sessionId: string; query: string; intent_lens: IntentLens; requestId: string };
```

- [ ] **Step 4: Implement `ChatView.tsx`** — replace `electron-app/src/renderer/ChatView.tsx`:

```typescript
import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { MessageMarkdown } from "./MessageMarkdown";
import type { AnalysisResult, HistoryMessage, IntentLens, NarrativeEvent, Verdict } from "../main/ipc/rendererApi";

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
    return { role: "assistant", requestId: newRequestId(), text: message.rendered_text, verdict };
  });
}

export function ChatView({ intentLens, sessionId, initialMessages }: ChatViewProps): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages ?? []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRequestId = useRef<string | null>(null);

  useEffect(() => {
    bridge().onNarrative((event: NarrativeEvent) => {
      if (event.requestId !== activeRequestId.current) return;
      if (event.chunk !== undefined) {
        setMessages((prev) =>
          prev.map((message) =>
            message.role === "assistant" && message.requestId === event.requestId
              ? { ...message, text: message.text + event.chunk }
              : message,
          ),
        );
      }
      if (event.error !== undefined) setError(event.error);
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
    setMessages((prev) => [...prev, { role: "user", text: query }, { role: "assistant", requestId, text: "" }]);
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

- [ ] **Step 5: Implement `App.tsx`** — replace `electron-app/src/renderer/App.tsx`:

```typescript
import { useEffect, useState } from "react";
import { ModePicker } from "./ModePicker";
import { IntentLensSelector } from "./IntentLensSelector";
import { InstrumentSearch } from "./InstrumentSearch";
import { AnalysisResultView } from "./AnalysisResult";
import { ChatView, historyToChatMessages } from "./ChatView";
import { HomeScreen } from "./HomeScreen";
import { bridge } from "./bridge";
import type {
  AnalysisMode,
  AnalysisResult,
  AnalysisRunParams,
  AppStatus,
  BannerEvent,
  HistoryMessage,
  Horizon,
  InstrumentSelection,
  IntentLens,
  SessionDetail,
  SessionSummary,
} from "../main/ipc/rendererApi";

interface ActiveSession {
  id: string;
  mode: AnalysisMode;
}

function deriveEngineOnlyView(detail: SessionDetail | null): { result?: AnalysisResult; history: HistoryMessage[] } {
  const messages = detail?.messages ?? [];
  const lastAssistantIndex = messages.map((m) => m.role).lastIndexOf("assistant");
  if (lastAssistantIndex === -1) return { history: messages };
  return {
    result: messages[lastAssistantIndex].structured_payload as AnalysisResult,
    history: messages.filter((_, index) => index !== lastAssistantIndex),
  };
}

export function App(): JSX.Element {
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [showModePicker, setShowModePicker] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [intentLens, setIntentLens] = useState<IntentLens>("buying");
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [banners, setBanners] = useState<BannerEvent[]>([]);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  useEffect(() => {
    void bridge().getStatus().then(setStatus);
    void bridge().listSessions().then(setSessions);
    bridge().onBanner((banner) => {
      setBanners((prev) => [...prev, banner]);
      if (banner.kind === "kiteLogin") void bridge().getStatus().then(setStatus);
    });
  }, []);

  const onNewChat = (): void => setShowModePicker(true);

  const onSelectMode = async (mode: AnalysisMode): Promise<void> => {
    const session = await bridge().createSession(mode);
    setSessions((prev) => [session, ...prev]);
    setSessionDetail(null);
    setActiveSession({ id: session.id, mode });
    setShowModePicker(false);
  };

  const onOpenSession = async (id: string): Promise<void> => {
    const detail = await bridge().getSession(id);
    setSessionDetail(detail);
    setActiveSession({ id: detail.id, mode: detail.response_mode });
    const lastUserMessage = [...detail.messages].reverse().find((m) => m.role === "user");
    if (lastUserMessage) {
      const payload = lastUserMessage.structured_payload as AnalysisRunParams;
      setIntentLens(payload.intent_lens);
    }
  };

  const onBackToHome = (): void => {
    setActiveSession(null);
    setSessionDetail(null);
    void bridge().listSessions().then(setSessions);
  };

  const onLogin = async (): Promise<void> => {
    setLoggingIn(true);
    setLoginError(null);
    const loginResult = await bridge().login();
    setLoggingIn(false);
    if (loginResult.status === "authenticated") setStatus(await bridge().getStatus());
    else setLoginError(loginResult.message);
  };

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

  const authenticated = status?.kiteSession === "authenticated";
  const { result, history } = deriveEngineOnlyView(sessionDetail);

  return (
    <main className="app">
      <h1>Trade Assistant</h1>
      <div className="status">
        {status ? `sidecar: ${status.sidecar} | kite: ${status.kiteSession}` : "Loading…"}
      </div>
      {activeSession !== null && (
        <button type="button" onClick={onBackToHome}>
          Home
        </button>
      )}
      <ul className="banners">
        {banners.map((banner, index) => (
          <li key={index}>
            [{banner.kind}] {banner.message}
          </li>
        ))}
      </ul>

      {activeSession === null && !showModePicker && (
        <HomeScreen sessions={sessions} onNewChat={onNewChat} onOpenSession={onOpenSession} />
      )}
      {activeSession === null && showModePicker && <ModePicker onSelect={onSelectMode} />}

      {activeSession !== null && !authenticated && (
        <>
          {activeSession.mode === "ai_assisted" && (
            <p className="banner-hint">AI-Assisted needs the claude CLI authenticated — run `claude auth login`.</p>
          )}
          <button type="button" onClick={onLogin} disabled={loggingIn}>
            {loggingIn ? "Logging in…" : "Login to Kite"}
          </button>
          {loginError && <div className="error">{loginError}</div>}
        </>
      )}

      {activeSession !== null && authenticated && (
        <>
          <IntentLensSelector value={intentLens} onChange={setIntentLens} />
          {activeSession.mode === "engine_only" ? (
            <>
              <InstrumentSearch onSubmit={onAnalyze} />
              {analysisError && <div className="error">{analysisError}</div>}
              {result && <AnalysisResultView result={result} history={history} />}
            </>
          ) : (
            <>
              <p className="banner-hint">AI-Assisted needs the claude CLI authenticated — run `claude auth login`.</p>
              <ChatView
                intentLens={intentLens}
                sessionId={activeSession.id}
                initialMessages={historyToChatMessages(sessionDetail?.messages ?? [])}
              />
            </>
          )}
        </>
      )}
    </main>
  );
}
```

- [ ] **Step 6: Run the full renderer suite + typecheck**

Run: `npx vitest run test/renderer/ && npm run typecheck`
Expected: PASS across the renderer suite; typecheck clean project-wide (both `runAnalysis` call sites now supply `sessionId`; `analysisBridge.ts` receives the extra field harmlessly).

- [ ] **Step 7: Commit**

```bash
git add electron-app/src/main/ipc/rendererApi.ts electron-app/src/renderer/App.tsx electron-app/src/renderer/ChatView.tsx electron-app/test/renderer/App.test.tsx electron-app/test/renderer/ChatView.test.tsx
git commit -m "feat(renderer): Home/New-Chat/reopen session flow with sessionId threading"
```

---

### Task 10: `analysisBridge` Engine-Only capture + `HistoryStore` bootstrap wiring

The capture chokepoint for the deterministic path, plus wiring the store into the app. `runAnalysisRequest` writes the user message **before** `assembleEnvelope` and the assistant message **only after** success — the orphaned-user-message-on-throw is intentional (P5c§7.2). Adding required `history` to `AnalysisBridgeDeps` forces `bootstrap.ts` to supply it in the same commit, so the store construction (env-overridable path), `registerHistoryBridge` call, and `stop()` close land here too. `AnalysisBridgeDeps.history` is typed with the full three-method `Pick` now so Task 11 need not re-touch it. The ai_assisted branch is unchanged this task (its `history` wiring is Task 11). **Bootstrap is not unit-tested** — `createApp` is Electron-runtime-bound (uses `app.getPath`, `ipcMain`, `BrowserWindow`), exactly as the existing `bootstrap.test.ts` treats it (it only covers the pure `handleKiteResponse`); the wiring is covered by `historyBridge.test.ts` (Task 4) + typecheck + the P5c§10 manual checklist.

**Files:**
- Modify: `electron-app/src/main/ipc/analysisBridge.ts`, `electron-app/src/main/bootstrap.ts`
- Test: `electron-app/test/main/ipc/analysisBridge.test.ts`

**Interfaces:**
- Consumes: `HistoryStore` (Task 2) as a `Pick`; `HistoryStore` constructor + `registerHistoryBridge` (Task 4) in bootstrap; `AnalysisRunParams.sessionId` (Task 9).
- Produces:
  - `RunAnalysisDeps` gains `history: Pick<HistoryStore, "appendMessage">;`
  - `AnalysisBridgeDeps` gains `history: Pick<HistoryStore, "appendMessage" | "getClaudeSessionId" | "setClaudeSessionId">;`
  - `export function describeEngineOnlyQuery(params: Extract<AnalysisRunParams, { mode: "engine_only" }>): string;` (module-internal helper; not re-exported).
  - `runAnalysisRequest` writes user-then-assistant messages around the engine call; the `analysis:run` engine_only dispatch passes `history: deps.history`.
  - `bootstrap.ts` constructs `HistoryStore`, passes `history` to `registerAnalysisBridge`, calls `registerHistoryBridge`, and closes the store in `stop()`.

- [ ] **Step 1: Write the failing tests** — in `test/main/ipc/analysisBridge.test.ts`, add a fake-history helper near the top (after the imports) and new engine_only capture tests; also update the existing `runAnalysisRequest` test and the `registerAnalysisBridge` harness to supply `history`. Add this helper after `fakeProvider`:

```typescript
function fakeHistory(overrides: Partial<{
  appendMessage: ReturnType<typeof vi.fn>;
  getClaudeSessionId: ReturnType<typeof vi.fn>;
  setClaudeSessionId: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    appendMessage: vi.fn(),
    getClaudeSessionId: vi.fn().mockReturnValue(null),
    setClaudeSessionId: vi.fn(),
    ...overrides,
  };
}
```

Replace the existing `describe("runAnalysisRequest", ...)` block with:

```typescript
describe("runAnalysisRequest", () => {
  it("assembles an envelope and returns a generated engine_only result", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const sidecar = mockSidecar();
    const history = fakeHistory();

    const result = await runAnalysisRequest(
      { kite, sidecar: sidecar as never, history },
      {
        mode: "engine_only",
        sessionId: "sess-1",
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        horizon: "positional",
        intent_lens: "selling",
      },
    );

    expect(result.mode).toBe("engine_only");
    if (result.mode !== "engine_only") throw new Error("mode");
    expect(result.response.direction).toBe("bullish");
    expect(result.algo_results[0].algo_id).toBe("rsi");
    expect(sidecar.compute).toHaveBeenCalledWith("NSE:INFY", "day", [104, 107]);
  });

  it("writes the user message before analysis and the assistant message only after success", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const history = fakeHistory();
    await runAnalysisRequest(
      { kite, sidecar: mockSidecar() as never, history },
      { mode: "engine_only", sessionId: "sess-1", instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" }, horizon: "positional", intent_lens: "buying" },
    );
    expect(history.appendMessage).toHaveBeenCalledTimes(2);
    expect(history.appendMessage.mock.calls[0][0]).toMatchObject({ sessionId: "sess-1", role: "user" });
    expect(history.appendMessage.mock.calls[1][0]).toMatchObject({ sessionId: "sess-1", role: "assistant" });
  });

  it("leaves the user message orphaned (no assistant write) when the engine call throws", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockRejectedValue(new Error("boom")) });
    const history = fakeHistory();
    await expect(
      runAnalysisRequest(
        { kite, sidecar: mockSidecar() as never, history },
        { mode: "engine_only", sessionId: "sess-1", instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" }, horizon: "positional", intent_lens: "buying" },
      ),
    ).rejects.toThrow(/boom/);
    expect(history.appendMessage).toHaveBeenCalledTimes(1);
    expect(history.appendMessage.mock.calls[0][0]).toMatchObject({ role: "user" });
  });
});
```

Update the `registerAnalysisBridge` `harness` function to pass `history` (and return it), and update the two `analysis:run` engine_only payloads to carry `sessionId`. Replace the `harness` definition:

```typescript
  function harness(session: KiteSession | null) {
    const handlers = new Map<string, (event: unknown, arg: unknown) => unknown>();
    const login = vi.fn().mockResolvedValue({ status: "authenticated" });
    const markNeedsLogin = vi.fn();
    const history = fakeHistory();
    registerAnalysisBridge({
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn as never) } as never,
      login,
      getSession: () => session,
      sidecar: mockSidecar() as never,
      provider: fakeProvider(),
      history,
      sendNarrative: vi.fn(),
      markNeedsLogin,
    });
    return { handlers, login, markNeedsLogin, history };
  }
```

In the same `describe`, update every `handlers.get("analysis:run")!(null, { mode: "engine_only", ... })` payload to include `sessionId: "sess-1"` (the "rejects ... when there is no session", "calls markNeedsLogin when analysis:run fails ...", and "does not call markNeedsLogin ..." tests). Each engine_only payload becomes:

```typescript
        mode: "engine_only",
        sessionId: "sess-1",
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        horizon: "positional",
        intent_lens: "buying",
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/main/ipc/analysisBridge.test.ts`
Expected: FAIL — `runAnalysisRequest` does not accept/write `history`; the capture-order and orphan assertions fail.

- [ ] **Step 3: Implement `analysisBridge.ts` (engine_only)** — add the `HistoryStore` type import at the top:

```typescript
import type { HistoryStore } from "../services/history/historyStore";
```

Replace `RunAnalysisDeps` and `runAnalysisRequest`:

```typescript
export interface RunAnalysisDeps {
  kite: KiteClient;
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles">;
  history: Pick<HistoryStore, "appendMessage">;
  now?: () => Date;
}

export function describeEngineOnlyQuery(params: Extract<AnalysisRunParams, { mode: "engine_only" }>): string {
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
    {
      trigger: "reactive",
      instrument: params.instrument,
      timeframe,
      horizon_requested: params.horizon,
      intent_lens: params.intent_lens,
      from,
      to,
    },
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

Add `history` to `AnalysisBridgeDeps` (full three-method `Pick`, after `provider`):

```typescript
  provider: AiAssistedProvider;
  history: Pick<HistoryStore, "appendMessage" | "getClaudeSessionId" | "setClaudeSessionId">;
  sendNarrative: (event: NarrativeEvent) => void;
```

In `registerAnalysisBridge`, thread `history` into the engine_only dispatch branch (leave the ai_assisted branch unchanged for now):

```typescript
    return guardSessionExpiry(
      deps.markNeedsLogin,
      runAnalysisRequest({ kite, sidecar: deps.sidecar, history: deps.history, now: deps.now }, params),
    );
```

- [ ] **Step 4: Wire `bootstrap.ts`** — add imports:

```typescript
import { HistoryStore } from "./services/history/historyStore";
import { registerHistoryBridge } from "./ipc/historyBridge";
```

Construct the store after `const provider = new ClaudeCliProvider();`:

```typescript
  const provider = new ClaudeCliProvider();
  const history = new HistoryStore({
    path: process.env.TRADE_ASSISTANT_HISTORY_DB ?? path.join(app.getPath("userData"), "history.sqlite3"),
  });
```

Add `history` to the `registerAnalysisBridge({ ... })` deps and register the history bridge immediately after it (inside `createMainWindow`):

```typescript
    registerAnalysisBridge({
      ipcMain,
      login,
      getSession: () => session,
      sidecar: supervisor,
      provider,
      history,
      sendNarrative: makeNarrativeSender((channel, payload) => window.webContents.send(channel, payload)),
      markNeedsLogin: () => sessionState.markNeedsLogin(),
    });
    registerHistoryBridge({ ipcMain, history });
```

Close the store in `stop()`:

```typescript
    stop: () => {
      void session?.close().catch(() => {});
      history.close();
      supervisor.stop();
    },
```

- [ ] **Step 5: Run tests + typecheck + full suite**

Run: `npx vitest run test/main/ipc/analysisBridge.test.ts && npm run typecheck && npm test`
Expected: PASS (engine_only capture + orphan behavior verified); typecheck clean (bootstrap now supplies `history`); full suite green.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/ipc/analysisBridge.ts electron-app/src/main/bootstrap.ts electron-app/test/main/ipc/analysisBridge.test.ts
git commit -m "feat(ipc): capture Engine-Only turns to history + wire HistoryStore into bootstrap"
```

---

### Task 11: `analysisBridge` AI-Assisted capture + Claude continuity through the provider

The crux. The provider layer gains the required continuity fields, `ClaudeCliProvider.completeAiAssisted` forwards them into the single `streamNarrative` call (and only that call — the persona pipeline call is unchanged), and `runAiAssistedRequest` becomes the capture-plus-continuity chokepoint: read the persisted `claude_session_id`, pin a fresh `crypto.randomUUID()` on the first turn (`resumeSession: false`) or resume the existing id on later turns (`resumeSession: true`), and persist the id **only after** `completeAiAssisted` resolves (never before, never on a first-turn failure — P5c§7.3). Making `CompleteAiAssistedOptions`'s fields required forces its one src caller (`runAiAssistedRequest`) to supply them in this same commit, so both live together. **Safety review:** the continuity fields reach only the narrative spawn; verify (via the argv-capture test below) that no persona/synthesis `--output-format json` call ever carries `--session-id`/`--resume`, and that Claude's tool grants are untouched.

**Files:**
- Modify: `electron-app/src/main/services/claude/provider.ts`, `electron-app/src/main/services/claude/claudeCliProvider.ts`, `electron-app/src/main/ipc/analysisBridge.ts`
- Test: `electron-app/test/main/services/claude/claudeCliProvider.test.ts`, `electron-app/test/main/ipc/analysisBridge.test.ts`

**Interfaces:**
- Consumes: `CompleteAiAssistedOptions` w/ new fields (this task), `streamNarrative` w/ continuity forwarding (Task 6), `HistoryStore.getClaudeSessionId`/`setClaudeSessionId`/`appendMessage` (Task 2), `randomUUID` (`node:crypto`), `AnalysisRunParams.sessionId` (Task 9).
- Produces:
  - `CompleteAiAssistedOptions` gains `claudeSessionId: string;` and `resumeSession: boolean;` (both required).
  - `ClaudeCliProvider.completeAiAssisted` forwards `opts.claudeSessionId`/`opts.resumeSession` into its `streamNarrative({...})` call; the `runPersonaPipeline` call is unchanged.
  - `AiAssistedRequestDeps` gains `history: Pick<HistoryStore, "appendMessage" | "getClaudeSessionId" | "setClaudeSessionId">;`
  - `runAiAssistedRequest` captures both turns and manages first-turn-pin / later-turn-resume / persist-after-success; the `analysis:run` ai_assisted dispatch passes `history: deps.history`.

- [ ] **Step 1: Write the failing tests** — in `test/main/services/claude/claudeCliProvider.test.ts`, add a continuity-forwarding + persona-exclusion test to the `ClaudeCliProvider.completeAiAssisted` describe block:

```typescript
  it("forwards continuity flags to the narrative call only, never to any persona/synthesis call", async () => {
    const verdictOut = { direction: "bullish", conviction: "high", reasoning: "rsi", cited_algo_ids: ["rsi"], verify_before_acting: "check LTP" };
    const streamArgvs: string[][] = [];
    const jsonArgvs: string[][] = [];
    const spawnFn = (_c: string, args: string[]) => {
      const child = new FakeChild();
      if (args.includes("stream-json")) {
        streamArgvs.push(args);
        queueMicrotask(() => {
          child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "narrative text" })}\n`);
          child.emit("exit", 0, null);
        });
      } else {
        jsonArgvs.push(args);
        emitResult(child, args.some((a) => a.includes("synthesis")) ? verdictOut : validFinding);
      }
      return child as never;
    };
    const provider = new ClaudeCliProvider({ spawnFn });
    await provider.completeAiAssisted(aiEnvelope, {
      onNarrativeToken: () => {},
      claudeSessionId: "uuid-xyz",
      resumeSession: true,
    });
    expect(streamArgvs).toHaveLength(1);
    expect(streamArgvs[0].slice(streamArgvs[0].indexOf("--resume"), streamArgvs[0].indexOf("--resume") + 2)).toEqual(["--resume", "uuid-xyz"]);
    for (const argv of jsonArgvs) {
      expect(argv).not.toContain("--session-id");
      expect(argv).not.toContain("--resume");
    }
  });
```

In `test/main/ipc/analysisBridge.test.ts`, replace the existing `describe("runAiAssistedRequest", ...)` block with capture + continuity coverage (the `fakeHistory` helper from Task 10 is reused):

```typescript
describe("runAiAssistedRequest", () => {
  const aiParams = { mode: "ai_assisted" as const, sessionId: "sess-1", query: "how is infy", intent_lens: "selling" as const, requestId: "r7" };

  it("streams tokens, sends done, and returns an ai_assisted result with the real intent_lens", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const sends: unknown[] = [];
    const result = await runAiAssistedRequest(
      { kite, sidecar: mockSidecar() as never, provider: fakeProvider(), history: fakeHistory() },
      aiParams,
      (event) => sends.push(event),
    );
    expect(result.mode).toBe("ai_assisted");
    if (result.mode !== "ai_assisted") throw new Error("mode");
    expect(result.verdict.direction).toBe("bullish");
    expect(result.narrative).toBe("Infy is constructive.");
    expect(result.intent_lens).toBe("selling");
    expect(sends).toEqual([
      { requestId: "r7", chunk: "Infy " },
      { requestId: "r7", chunk: "is constructive." },
      { requestId: "r7", done: true },
    ]);
  });

  it("writes the user message before the provider call and the assistant message only after success", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const history = fakeHistory();
    await runAiAssistedRequest({ kite, sidecar: mockSidecar() as never, provider: fakeProvider(), history }, aiParams, () => {});
    expect(history.appendMessage).toHaveBeenCalledTimes(2);
    expect(history.appendMessage.mock.calls[0][0]).toMatchObject({ sessionId: "sess-1", role: "user" });
    expect(history.appendMessage.mock.calls[1][0]).toMatchObject({ sessionId: "sess-1", role: "assistant" });
  });

  it("pins a fresh claude_session_id on the first turn and persists it once after success", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const history = fakeHistory({ getClaudeSessionId: vi.fn().mockReturnValue(null) });
    const provider = fakeProvider();
    await runAiAssistedRequest({ kite, sidecar: mockSidecar() as never, provider, history }, aiParams, () => {});
    const opts = (provider.completeAiAssisted as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as {
      claudeSessionId: string;
      resumeSession: boolean;
    };
    expect(opts.resumeSession).toBe(false);
    expect(typeof opts.claudeSessionId).toBe("string");
    expect(history.setClaudeSessionId).toHaveBeenCalledTimes(1);
    expect(history.setClaudeSessionId).toHaveBeenCalledWith("sess-1", opts.claudeSessionId);
  });

  it("resumes the persisted claude_session_id on a later turn and never re-persists it", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const history = fakeHistory({ getClaudeSessionId: vi.fn().mockReturnValue("prev-uuid") });
    const provider = fakeProvider();
    await runAiAssistedRequest({ kite, sidecar: mockSidecar() as never, provider, history }, aiParams, () => {});
    const opts = (provider.completeAiAssisted as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as {
      claudeSessionId: string;
      resumeSession: boolean;
    };
    expect(opts.claudeSessionId).toBe("prev-uuid");
    expect(opts.resumeSession).toBe(true);
    expect(history.setClaudeSessionId).not.toHaveBeenCalled();
  });

  it("does not persist claude_session_id when the first turn fails (leaves it NULL for a clean retry)", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const history = fakeHistory({ getClaudeSessionId: vi.fn().mockReturnValue(null) });
    const provider = fakeProvider({ completeAiAssisted: vi.fn().mockRejectedValue(new Error("claude down")) });
    const sends: unknown[] = [];
    await expect(
      runAiAssistedRequest({ kite, sidecar: mockSidecar() as never, provider, history }, aiParams, (e) => sends.push(e)),
    ).rejects.toThrow(/claude down/);
    expect(history.setClaudeSessionId).not.toHaveBeenCalled();
    expect(history.appendMessage).toHaveBeenCalledTimes(1);
    expect(history.appendMessage.mock.calls[0][0]).toMatchObject({ role: "user" });
    expect(sends).toContainEqual({ requestId: "r7", error: "claude down" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/main/services/claude/claudeCliProvider.test.ts test/main/ipc/analysisBridge.test.ts`
Expected: FAIL — `completeAiAssisted` doesn't forward continuity flags; `runAiAssistedRequest` doesn't accept `history` or manage `claude_session_id`.

- [ ] **Step 3: Implement `provider.ts`** — add the two required fields to `CompleteAiAssistedOptions`:

```typescript
export interface CompleteAiAssistedOptions {
  researchNotes?: string;
  onNarrativeToken: (text: string) => void;
  signal?: AbortSignal;
  claudeSessionId: string;
  resumeSession: boolean;
}
```

- [ ] **Step 4: Implement `claudeCliProvider.ts`** — forward the two fields in `completeAiAssisted`'s single `streamNarrative` call (the `runPersonaPipeline` call above it is unchanged):

```typescript
    const narrativeText = await this.streamNarrative({
      systemPrompt: narrative.systemPrompt,
      prompt: narrativePrompt(verdict, findings, envelope.intent_lens, opts.researchNotes),
      onToken: opts.onNarrativeToken,
      signal: opts.signal,
      claudeSessionId: opts.claudeSessionId,
      resumeSession: opts.resumeSession,
    });
```

- [ ] **Step 5: Implement `analysisBridge.ts` (ai_assisted)** — add the `randomUUID` import at the top:

```typescript
import { randomUUID } from "node:crypto";
```

Add `history` to `AiAssistedRequestDeps` (after `provider`):

```typescript
export interface AiAssistedRequestDeps {
  kite: KiteClient;
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles">;
  provider: AiAssistedProvider;
  history: Pick<HistoryStore, "appendMessage" | "getClaudeSessionId" | "setClaudeSessionId">;
  now?: () => Date;
}
```

Replace `runAiAssistedRequest`:

```typescript
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
      {
        trigger: "reactive",
        instrument: intake.instrument,
        timeframe,
        horizon_requested: intake.horizon,
        intent_lens: params.intent_lens,
        from,
        to,
      },
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

Thread `history` into the ai_assisted dispatch branch of `registerAnalysisBridge`:

```typescript
    if (params.mode === "ai_assisted") {
      return guardSessionExpiry(
        deps.markNeedsLogin,
        runAiAssistedRequest(
          { kite, sidecar: deps.sidecar, provider: deps.provider, history: deps.history, now: deps.now },
          params,
          deps.sendNarrative,
        ),
      );
    }
```

- [ ] **Step 6: Run tests + typecheck + full suite**

Run: `npx vitest run test/main/services/claude/claudeCliProvider.test.ts test/main/ipc/analysisBridge.test.ts && npm run typecheck && npm test`
Expected: PASS — continuity forwarded to the narrative call only; personas/synthesis carry no continuity flags; first-turn-pin/later-turn-resume/persist-after-success all verified; typecheck clean; full suite green (`bootstrap.ts` already supplies the full-`Pick` `history`).

- [ ] **Step 7: Commit**

```bash
git add electron-app/src/main/services/claude/provider.ts electron-app/src/main/services/claude/claudeCliProvider.ts electron-app/src/main/ipc/analysisBridge.ts electron-app/test/main/services/claude/claudeCliProvider.test.ts electron-app/test/main/ipc/analysisBridge.test.ts
git commit -m "feat(ipc): AI-Assisted history capture with real Claude session continuity"
```

---

### Task 12: End-to-end proof — persistence across restart + real resume + Engine-Only no-Claude

The crown-jewel integration test over a **real** `HistoryStore` (temp file, not `:memory:`) and a `ClaudeCliProvider` driven by one scripted `spawnFn`: a new session → first AI-Assisted turn pins `--session-id <uuid>` → a *fresh* store instance over the same file (simulated app restart) → a second turn resumes `--resume <uuid>` (same uuid) → history intact; and an Engine-Only session appends turns with **no** Claude involvement and a `NULL` `claude_session_id`. Also threads `sessionId` + a fake history through the existing `aiAssisted.integration.test.ts`. Closes with the full-suite gate and the P5c§10 manual checklist.

**Files:**
- Modify: `electron-app/test/main/ipc/aiAssisted.integration.test.ts`
- Test: `electron-app/test/main/ipc/sessionContinuity.integration.test.ts` (new)

**Interfaces:**
- Consumes: `ClaudeCliProvider` (Task 11), `runAiAssistedRequest`/`runAnalysisRequest` (Tasks 10–11), `HistoryStore` (Task 2), `KiteClient`, `mockSidecar`/`historicalResponse` fixtures.
- Produces: no exports — integration tests + the manual checklist.

- [ ] **Step 1: Update `aiAssisted.integration.test.ts`** — thread a real-shaped `sessionId` and a fake history double through the existing scripted-subprocess test. Replace the `runAiAssistedRequest(...)` call and its deps:

```typescript
    const history = {
      appendMessage: vi.fn(),
      getClaudeSessionId: vi.fn().mockReturnValue(null),
      setClaudeSessionId: vi.fn(),
    };
    const result = await runAiAssistedRequest(
      { kite, sidecar: mockSidecar() as never, provider, history },
      { mode: "ai_assisted", sessionId: "sess-Z", query: "how is infy for a swing", intent_lens: "buying", requestId: "rZ" },
      (event) => events.push(event),
    );
```

And add two assertions after the existing ones (history composes with the real mocked-subprocess provider):

```typescript
    expect(history.appendMessage).toHaveBeenCalledTimes(2);
    expect(history.setClaudeSessionId).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Write the failing continuity integration test** — create `test/main/ipc/sessionContinuity.integration.test.ts`:

```typescript
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCliProvider } from "../../../src/main/services/claude/claudeCliProvider";
import { runAiAssistedRequest, runAnalysisRequest } from "../../../src/main/ipc/analysisBridge";
import { HistoryStore } from "../../../src/main/services/history/historyStore";
import { KiteClient } from "../../../src/main/services/kite/kiteClient";
import { historicalResponse, mockSidecar } from "../../fixtures/sidecarFixtures";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  kill(): void {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
  }
}

const intakeOut = { instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" }, horizon: "positional", researchNotes: "results due" };
const findingOut = { persona: "technical_quant", direction: "bullish", conviction: "high", findings: ["rsi>50"], cited_algo_ids: ["rsi"] };
const verdictOut = { direction: "bullish", conviction: "high", reasoning: "rsi confluence", cited_algo_ids: ["rsi"], verify_before_acting: "check LTP in Kite" };

const tempDirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ta-continuity-"));
  tempDirs.push(dir);
  return path.join(dir, "history.sqlite3");
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function makeScriptedSpawn(streamArgvs: string[][], jsonArgvs: string[][]) {
  return function scriptedSpawn(_command: string, args: string[]): never {
    const child = new FakeChild();
    const system = args[args.indexOf("--system-prompt") + 1] ?? "";
    queueMicrotask(() => {
      if (args.includes("stream-json")) {
        streamArgvs.push(args);
        child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "Infy is constructive." })}\n`);
        child.emit("exit", 0, null);
        return;
      }
      jsonArgvs.push(args);
      let structured: unknown = findingOut;
      if (system.includes("intake")) structured = intakeOut;
      else if (system.includes("synthesis")) structured = verdictOut;
      child.stdout.write(`${JSON.stringify({ result: "ok", structured_output: structured })}`);
      child.stdout.end();
      child.emit("exit", 0, null);
    });
    return child as never;
  };
}

function kiteClient(): KiteClient {
  return new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
}

describe("session continuity across a simulated restart", () => {
  it("pins on turn 1, resumes the same uuid on turn 2 from a fresh store, and keeps continuity off every persona/synthesis call", async () => {
    const dbPath = tempDbPath();
    const streamArgvs: string[][] = [];
    const jsonArgvs: string[][] = [];
    const provider = new ClaudeCliProvider({ spawnFn: makeScriptedSpawn(streamArgvs, jsonArgvs) });

    const store1 = new HistoryStore({ path: dbPath });
    const session = store1.createSession("ai_assisted");
    await runAiAssistedRequest(
      { kite: kiteClient(), sidecar: mockSidecar() as never, provider, history: store1 },
      { mode: "ai_assisted", sessionId: session.id, query: "turn one", intent_lens: "buying", requestId: "r1" },
      () => {},
    );
    store1.close();

    // Fresh store over the same file == app restart; the pinned id must survive.
    const store2 = new HistoryStore({ path: dbPath });
    const pinned = store2.getClaudeSessionId(session.id);
    expect(pinned).not.toBeNull();
    await runAiAssistedRequest(
      { kite: kiteClient(), sidecar: mockSidecar() as never, provider, history: store2 },
      { mode: "ai_assisted", sessionId: session.id, query: "turn two", intent_lens: "buying", requestId: "r2" },
      () => {},
    );

    expect(streamArgvs).toHaveLength(2);
    expect(streamArgvs[0].slice(streamArgvs[0].indexOf("--session-id"), streamArgvs[0].indexOf("--session-id") + 2)).toEqual(["--session-id", pinned]);
    expect(streamArgvs[0]).not.toContain("--resume");
    expect(streamArgvs[1].slice(streamArgvs[1].indexOf("--resume"), streamArgvs[1].indexOf("--resume") + 2)).toEqual(["--resume", pinned]);
    expect(streamArgvs[1]).not.toContain("--session-id");
    for (const argv of jsonArgvs) {
      expect(argv).not.toContain("--session-id");
      expect(argv).not.toContain("--resume");
    }

    expect(store2.getSession(session.id)?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    store2.close();
  });

  it("appends Engine-Only turns with no Claude involvement and a NULL claude_session_id", async () => {
    const dbPath = tempDbPath();
    const store = new HistoryStore({ path: dbPath });
    const session = store.createSession("engine_only");
    const params = {
      mode: "engine_only" as const,
      sessionId: session.id,
      instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
      horizon: "positional" as const,
      intent_lens: "buying" as const,
    };
    await runAnalysisRequest({ kite: kiteClient(), sidecar: mockSidecar() as never, history: store }, params);
    await runAnalysisRequest({ kite: kiteClient(), sidecar: mockSidecar() as never, history: store }, params);
    expect(store.getSession(session.id)?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(store.getClaudeSessionId(session.id)).toBeNull();
    store.close();
  });
});
```

- [ ] **Step 3: Run the new + updated integration tests to verify fail→pass**

Run: `npm rebuild better-sqlite3 && npx vitest run test/main/ipc/sessionContinuity.integration.test.ts test/main/ipc/aiAssisted.integration.test.ts`
Expected: initially FAIL only if any prior wiring is incomplete; with Tasks 1–11 in, PASS. Fix wiring (never the assertions) if red.

- [ ] **Step 4: Full-suite + typecheck gate**

Run: `npm test && npm run typecheck`
Expected: ALL green (`pretest` restores the system-Node `better-sqlite3` build); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add electron-app/test/main/ipc/sessionContinuity.integration.test.ts electron-app/test/main/ipc/aiAssisted.integration.test.ts
git commit -m "test(ipc): end-to-end session persistence, restart-resume, and Engine-Only no-Claude"
```

- [ ] **Step 6: Manual verification checklist** (run once via `npm start`; live items require a paid Kite session + authenticated `claude` and are never a blocker for calling 5c done — P5c§10)

**Automatable (mocked/real bridge + `npm start`):**
- On a fresh `history.sqlite3`, Home shows first with an empty session list; the mode picker is unreachable until "New Chat" is clicked.
- New Chat in each mode creates a session and proceeds through the existing login → lens → mode flow.
- Sending a couple of AI-Assisted turns, then reopening the app, shows the session in Home with a sensible preview and last-active time.
- Reopening it restores the chat transcript and pre-selects the last-used intent lens — which is still changeable before the next submit.
- The equivalent Engine-Only reopen shows the last result via `AnalysisResultView` plus a collapsed "Past turns in this session" list.
- A session created via New Chat but never used previews as `(no messages yet)` and seeds the default `buying` lens on reopen.

**Live follow-ups (real Kite + real `claude` auth):**
- Via `claude --debug`, turn 2 of a reopened AI-Assisted session shows `--resume <uuid>` in argv where turn 1 showed `--session-id <uuid>` (same uuid), and the narrative prose references the earlier turn's framing.
- The three analytical personas and the synthesis call, inspected the same way, never show `--session-id`/`--resume` on any turn — and offer no tool beyond the existing Kite reads + `WebSearch`/`WebFetch` (grant unchanged this phase).
- Killing the app mid-narrative-stream and reopening the session shows the orphaned user message with no reply, exactly as designed — not silently dropped.

---

## Self-Review

Run after the plan was written; findings fixed inline above.

**1. Spec coverage (against `2026-07-27-phase5c-session-history-design.md`):**
- P5c§2 scope (in/out) → Tasks 1–12 cover every in-scope item; nothing touches 5d, session rename/delete/export, `auto` horizon, `news_context`/`session_id` population, or the order-placement surface.
- P5c§3.1 schema (tables, indexes, `PRAGMA foreign_keys = ON`, `MessageRole`, ISO timestamps) → Task 2.
- P5c§3.2 file location + `TRADE_ASSISTANT_HISTORY_DB` override → Task 10 (bootstrap).
- P5c§3.3 native module + Electron-ABI rebuild + no vite/renderer change → Task 1 (with the dual-ABI resolution flagged below).
- P5c§3.4 open-time idempotent DDL, no migration framework → Task 2.
- P5c§3.5 full `HistoryStore` surface incl. `preview`/`summarizePreview`/rowid tiebreaks → Task 2.
- P5c§4 session semantics (no lifecycle binding, New-Chat-only creation, reopen-continue, fixed `response_mode`) → Tasks 9 (renderer flow) + 2 (no `ended_at`).
- P5c§5.1 mechanics (`--session-id` pin vs `--resume`) → Tasks 5 (args), 6 (stream), 11 (bridge logic).
- P5c§5.2 which call gets it (narrative only) → Task 11 (`completeAiAssisted` forwards to the one `streamNarrative` call).
- P5c§5.3 structural exclusion of personas/synthesis → Task 11's argv-capture negative test; `personaPipeline.ts` and `PersonaRunSpec` untouched.
- P5c§5.4 missing-resume-target = ordinary narrative failure → no special handling added (existing error path), noted in Task 11.
- P5c§6.1 `rendererApi` additions (`sessionId` on both variants, re-exports, three methods) → Tasks 3 (methods/re-exports) + 9 (`sessionId`).
- P5c§6.2 `historyBridge.ts` (channels, null→throw) → Task 4.
- P5c§7.1 deps shape → Tasks 10 + 11.
- P5c§7.2 engine_only capture + orphan edge case → Task 10.
- P5c§7.3 ai_assisted capture + `claude_session_id` timing → Task 11.
- P5c§8.1–8.6 renderer (Home/sidebar, App state, New-Chat, reopen+seeding, ChatView replay, AnalysisResult history) → Tasks 7, 8, 9.
- P5c§9 testing strategy → every task's tests (`historyStore` real `:memory:`/temp file, `historyBridge` fake double, `analysisBridge` fake history, `claudeProvider`/`streamingNarrative`/`claudeCliProvider` argv assertions, renderer testBridge stubs, `aiAssisted.integration` extension) + Task 12.
- P5c§10 manual checklist → Task 12 Step 6.
- P5c§11 tensions (real continuity is new; schema supersedes §8.5; unrelated `session_id`; native addon justified; existing tests must change) → honored; the "existing App tests must change" tension is realized in Task 9's full `App.test.tsx` rewrite.
- P5c§12 file layout → every named create/modify has a task; the "not changed" list (`personaPipeline.ts`, `preload.ts`, `InstrumentSearch.tsx`, `systemPrompts/*`, `electron.vite.config.ts`) is respected — none are touched.
- P5c§13 out-of-scope → nothing in any task implements engine-only synthetic memory, rename/delete/export, settings/scan, order placement, resume auto-recovery, `auto` horizon, or envelope-field population.

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"add appropriate error handling"/"similar to Task N"/"write tests for the above". Every code step shows complete code; every test step shows real assertions; every run step shows an exact command + expected result.

**3. Type consistency (cross-task):**
- `HistoryStore`/`SessionSummary`/`HistoryMessage`/`SessionDetail`/`AppendMessageParams`/`MessageRole` (Task 2) are consumed with identical shapes by Tasks 3 (re-export), 4 (Pick), 8/9 (renderer types), 10/11 (deps Pick), 12 (real store).
- `RendererApi.createSession/listSessions/getSession` (Task 3) match `HistoryBridgeDeps` channels (Task 4), the `bridge()` calls in `App` (Task 9), and bootstrap's `registerHistoryBridge` (Task 10).
- `AnalysisRunParams` with required `sessionId` (Task 9) is read by `runAnalysisRequest`/`runAiAssistedRequest` as `params.sessionId` (Tasks 10, 11) and supplied by both renderer call sites (Task 9).
- `ClaudeArgOptions.claudeSessionId/resumeSession` (Task 5) → `NarrativeStreamSpec` (Task 6) → `CompleteAiAssistedOptions` (Task 11) → `streamNarrative` call (Task 11): one field name/type (`claudeSessionId: string`, `resumeSession: boolean`) threaded unchanged; only `ClaudeArgOptions`/`NarrativeStreamSpec` keep them optional (they may legitimately be absent), while `CompleteAiAssistedOptions` requires them per spec.
- `AnalysisBridgeDeps.history` is defined once with the full three-method `Pick` (Task 10) so Task 11 reuses it without re-typing; `RunAnalysisDeps.history` (one-method Pick) and `AiAssistedRequestDeps.history` (three-method Pick) match the methods each function actually calls.
- `describeEngineOnlyQuery` (Task 10) and `historyToChatMessages` (Task 9) are named identically wherever referenced.

**Deviations / gaps I resolved (none left as open questions for the human):**
1. **Native dual-ABI (genuine gap the spec missed).** The spec locks `postinstall: electron-rebuild -f -w better-sqlite3`, which leaves the binary at Electron's ABI, but the spec also mandates real `better-sqlite3` tests under vitest, which runs on **system Node** (a different ABI) — those tests would fail to load the module. Resolved by keeping the spec's `postinstall` and adding self-healing `pretest` (`npm rebuild better-sqlite3` → system-Node ABI) plus `predev`/`prestart` (`electron-rebuild` → Electron ABI). DB-touching per-file test runs are prefixed with `npm rebuild better-sqlite3`. Runtime behavior of the shipped app is unchanged; this only makes the test/dev commands executable.
2. **`:memory:` vs "same file" in the spec's `historyStore` test list.** P5c§9 says `:memory:` yet also requires an "opening twice against the same file is idempotent" test — which `:memory:` (per-connection, private) structurally cannot express. Resolved by using `:memory:` for logic tests and a real temp file (via `node:os` `mkdtemp`, cleaned up) for the persistence/idempotency tests. Still real `better-sqlite3`, no DB mocking.
3. **Task ordering forced by TS coupling (not a spec change).** `AnalysisRunParams.sessionId` (required) cannot be added without simultaneously fixing both `runAnalysis` call sites, so the renderer session flow (Task 9) precedes the backend capture (Tasks 10–11), and bootstrap's `history` wiring is folded into Task 10 because adding required `history` to `AnalysisBridgeDeps` would otherwise leave `bootstrap.ts` un-compilable for one commit. `CompleteAiAssistedOptions`'s required fields are added in the same task (11) as their sole caller's update, for the same reason. These are ordering/packaging decisions; every field type and value still matches the spec exactly.
4. **Bootstrap has no unit test.** `createApp` is Electron-runtime-bound (`app.getPath`, `ipcMain`, `BrowserWindow`), and the existing `bootstrap.test.ts` already only covers the pure `handleKiteResponse`. The store wiring is instead covered by `historyBridge.test.ts` + typecheck + full-suite-green + the P5c§10 manual checklist. Stated in Task 10 rather than left implicit.

No task expands Claude's tool access: the continuity fields carry only a self-generated `randomUUID()` or a value round-tripped through `historyStore.getClaudeSessionId`, and the three safety flags + web-tool grant are asserted untouched in Tasks 5 and 11.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-27-phase5c-session-history-plan.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
