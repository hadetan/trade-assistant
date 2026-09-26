import { describe, expect, it, vi } from "vitest";
import { registerLiveBridge } from "../../../src/main/ipc/liveBridge";

function fakeIpcMain() {
  const handlers = new Map<string, (event: unknown, args: unknown) => unknown>();
  return {
    handle: vi.fn((channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      handlers.set(channel, handler);
    }),
    invoke: (channel: string, args: unknown) => handlers.get(channel)?.(undefined, args),
  };
}

describe("registerLiveBridge", () => {
  it("wires live:start to runner.start and live:stop to runner.stop", () => {
    const ipcMain = fakeIpcMain();
    const runner = { start: vi.fn(), stop: vi.fn() };

    registerLiveBridge({ ipcMain, runner });

    const params = {
      sessionId: "s1",
      assistantMessageId: "m1",
      instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
      interval: "5minute" as const,
    };
    ipcMain.invoke("live:start", params);
    expect(runner.start).toHaveBeenCalledWith(params);

    ipcMain.invoke("live:stop", {});
    expect(runner.stop).toHaveBeenCalledTimes(1);
  });
});
