import { describe, expect, it, vi } from "vitest";
import { KiteSessionState, classifyKiteResponse } from "../../../../src/main/services/kite/kiteSessionState";

describe("classifyKiteResponse", () => {
  it("treats a TokenException error payload as needsLogin", () => {
    expect(classifyKiteResponse({ error_type: "TokenException", message: "Invalid token" })).toBe("needsLogin");
  });

  it("treats an HTTP 403 shape as needsLogin", () => {
    expect(classifyKiteResponse({ status: 403 })).toBe("needsLogin");
  });

  it("treats the MCP login auth-gate text as needsLogin", () => {
    expect(classifyKiteResponse({ content: [{ type: "text", text: "Please login to Kite first to continue." }] })).toBe(
      "needsLogin",
    );
  });

  it("treats a normal profile payload as authenticated", () => {
    expect(classifyKiteResponse({ data: { user_id: "AB1234", user_name: "Trader" } })).toBe("authenticated");
  });

  it("treats an unrecognized generic object as unknown, not authenticated", () => {
    expect(classifyKiteResponse({ foo: "bar" })).toBe("unknown");
  });

  it("treats a data.user_id shape as authenticated", () => {
    expect(classifyKiteResponse({ data: { user_id: "AB1234" } })).toBe("authenticated");
  });

  it("treats a data payload without user_id as unknown, not authenticated", () => {
    expect(classifyKiteResponse({ data: { something_else: 1 } })).toBe("unknown");
  });
});

describe("KiteSessionState", () => {
  it("emits a banner when transitioning into needsLogin", () => {
    const state = new KiteSessionState();
    const bannerHandler = vi.fn();
    state.on("banner", bannerHandler);

    state.observe({ error_type: "TokenException" });

    expect(state.status).toBe("needsLogin");
    expect(bannerHandler).toHaveBeenCalledWith({ kind: "kiteLogin", message: expect.stringContaining("Kite") });
  });

  it("does not re-emit the banner while already in needsLogin", () => {
    const state = new KiteSessionState();
    const bannerHandler = vi.fn();
    state.on("banner", bannerHandler);

    state.observe({ status: 403 });
    state.observe({ status: 403 });

    expect(bannerHandler).toHaveBeenCalledTimes(1);
  });
});
