import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SCAN_CONFIG, HistoryStore } from "../../../../src/main/services/history/historyStore";

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

describe("HistoryStore scan_config", () => {
  it("returns the seeded default on a fresh database", () => {
    const store = memoryStore();
    expect(store.getScanConfig()).toEqual({ enabled: false, intervalMinutes: 15 });
    expect(DEFAULT_SCAN_CONFIG).toEqual({ enabled: false, intervalMinutes: 15 });
    store.close();
  });

  it("round-trips setScanConfig through getScanConfig", () => {
    const store = memoryStore();
    store.setScanConfig({ enabled: true, intervalMinutes: 30 });
    expect(store.getScanConfig()).toEqual({ enabled: true, intervalMinutes: 30 });
    store.close();
  });

  it("does not reset or duplicate the singleton row when re-opened against the same file", () => {
    const dbPath = tempDbPath();
    const first = new HistoryStore({ path: dbPath, now: monotonicNow() });
    first.setScanConfig({ enabled: true, intervalMinutes: 60 });
    first.close();

    const second = new HistoryStore({ path: dbPath, now: monotonicNow() });
    // INSERT OR IGNORE on re-open must not clobber the persisted value back to default.
    expect(second.getScanConfig()).toEqual({ enabled: true, intervalMinutes: 60 });
    second.close();
  });
});
