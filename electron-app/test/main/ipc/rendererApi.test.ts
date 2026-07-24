import { describe, expect, it, vi } from "vitest";
import { buildRendererApi } from "../../../src/main/ipc/rendererApi";

describe("buildRendererApi", () => {
  it("exposes exactly getStatus and onBanner, and never leaks the raw transport", () => {
    const invoke = vi.fn().mockResolvedValue({ sidecar: "up" });
    const subscribe = vi.fn();
    const api = buildRendererApi(invoke, subscribe);

    expect(Object.keys(api).sort()).toEqual(["getStatus", "onBanner"]);
    expect((api as Record<string, unknown>).ipcRenderer).toBeUndefined();
    expect((api as Record<string, unknown>).invoke).toBeUndefined();
  });

  it("routes getStatus through the injected invoke on the status:get channel", async () => {
    const invoke = vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null });
    const api = buildRendererApi(invoke, vi.fn());

    const status = await api.getStatus();

    expect(invoke).toHaveBeenCalledWith("status:get");
    expect(status.sidecar).toBe("up");
  });

  it("registers onBanner against the banner subscribe channel", () => {
    const subscribe = vi.fn();
    const api = buildRendererApi(vi.fn(), subscribe);
    const handler = vi.fn();

    api.onBanner(handler);

    expect(subscribe).toHaveBeenCalledWith("banner:push", handler);
  });
});
