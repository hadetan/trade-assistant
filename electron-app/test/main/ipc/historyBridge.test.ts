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
