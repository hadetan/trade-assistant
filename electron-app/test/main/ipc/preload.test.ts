import { describe, expect, it, vi } from "vitest";

const ipcRenderer = { invoke: vi.fn(), on: vi.fn(), off: vi.fn() };
const contextBridge = { exposeInMainWorld: vi.fn() };

vi.mock("electron", () => ({ ipcRenderer, contextBridge }));

describe("preload", () => {
  it("exposes an unsubscribe that removes the very handler ipcRenderer.on registered", async () => {
    await import("../../../src/main/ipc/preload");
    const api = contextBridge.exposeInMainWorld.mock.calls[0][1] as {
      onLiveTick: (handler: (tick: unknown) => void) => () => void;
    };

    const handler = vi.fn();
    const unsubscribe = api.onLiveTick(handler);

    const [channel, wrapped] = ipcRenderer.on.mock.calls.at(-1) as [string, (event: unknown, payload: unknown) => void];
    expect(channel).toBe("live:tick");

    // The wrapper, not the caller's handler, is what was registered -- passing
    // the handler itself to off() would silently remove nothing.
    wrapped(undefined, { ts: 1, price: 100 });
    expect(handler).toHaveBeenCalledWith({ ts: 1, price: 100 });

    unsubscribe();
    expect(ipcRenderer.off).toHaveBeenCalledWith("live:tick", wrapped);
  });
});
