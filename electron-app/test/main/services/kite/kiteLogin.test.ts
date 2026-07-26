import { describe, expect, it, vi } from "vitest";
import { runKiteLogin } from "../../../../src/main/services/kite/kiteLogin";
import type { McpConnection } from "../../../../src/main/services/kite/mcpConnection";

function fakeConnection(): McpConnection {
  return {
    caller: { callTool: vi.fn().mockResolvedValue({ ok: true }) },
    listing: { listTools: vi.fn().mockResolvedValue(["login", "get_ltp"]) },
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function baseDeps() {
  const connection = fakeConnection();
  return {
    connection,
    deps: {
      config: { apiKey: "k123", apiSecret: "s456", loginPort: 3000 },
      captureRequestToken: vi.fn().mockResolvedValue("req_tok"),
      exchangeAccessToken: vi.fn().mockResolvedValue({ data: { access_token: "at_999" } }),
      postForm: vi.fn(),
      openExternal: vi.fn(),
      connectMcp: vi.fn().mockResolvedValue(connection),
      checkDrift: vi.fn().mockResolvedValue({ added: [], removed: [], hasDrift: false }),
    },
  };
}

describe("runKiteLogin", () => {
  it("runs capture -> exchange -> connect -> drift and returns a KiteClient session", async () => {
    const { deps, connection } = baseDeps();

    const session = await runKiteLogin(deps);

    expect(deps.captureRequestToken).toHaveBeenCalledWith({
      port: 3000,
      loginUrl: "https://kite.zerodha.com/connect/login?api_key=k123&v=3",
      openExternal: deps.openExternal,
    });
    expect(deps.exchangeAccessToken).toHaveBeenCalledWith({
      apiKey: "k123",
      apiSecret: "s456",
      requestToken: "req_tok",
      postForm: deps.postForm,
    });
    expect(deps.connectMcp).toHaveBeenCalledWith({ apiKey: "k123", accessToken: "at_999" });
    expect(deps.checkDrift).toHaveBeenCalledWith(connection.listing);
    expect(session.connection).toBe(connection);
    expect(session.drift.hasDrift).toBe(false);

    await session.kite.getLTP(["NSE:INFY"]);
    expect(connection.caller.callTool).toHaveBeenCalledWith("get_ltp", { instruments: ["NSE:INFY"] });
  });

  it("surfaces detected drift on the returned session", async () => {
    const { deps } = baseDeps();
    deps.checkDrift = vi.fn().mockResolvedValue({ added: ["new_tool"], removed: [], hasDrift: true });

    const session = await runKiteLogin(deps);
    expect(session.drift).toEqual({ added: ["new_tool"], removed: [], hasDrift: true });
  });

  it("wires onKiteResponse through to the session's KiteClient", async () => {
    const { deps, connection } = baseDeps();
    connection.caller.callTool = vi.fn().mockResolvedValue({ data: { user_id: "AB1234" } });
    const onKiteResponse = vi.fn();

    const session = await runKiteLogin({ ...deps, onKiteResponse });
    await session.kite.getProfile();

    expect(onKiteResponse).toHaveBeenCalledWith({ data: { user_id: "AB1234" } });
  });

  it("rejects with a clear error when the token exchange has no access_token", async () => {
    const { deps } = baseDeps();
    deps.exchangeAccessToken = vi.fn().mockResolvedValue({ data: {} });

    await expect(runKiteLogin(deps)).rejects.toThrow(/did not include data.access_token/);
    expect(deps.connectMcp).not.toHaveBeenCalled();
  });
});
