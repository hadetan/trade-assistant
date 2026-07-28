import { describe, expect, it, vi } from "vitest";
import { runKiteLogin, runKiteMcpOnlyLogin } from "../../../../src/main/services/kite/kiteLogin";
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

const LOGIN_TOOL_RESPONSE = {
  content: [{ type: "text", text: "click here: https://mcp.kite.trade/authorize?session_id=abc%7C123" }],
};

function mcpOnlyDeps() {
  const connection = fakeConnection();
  connection.caller.callTool = vi.fn().mockImplementation((name: string) => {
    if (name === "login") return Promise.resolve(LOGIN_TOOL_RESPONSE);
    return Promise.resolve({ ok: true });
  });
  return {
    connection,
    deps: {
      config: { mode: "mcpOnly" as const, loginPort: 3000 },
      openExternal: vi.fn(),
      connectMcp: vi.fn().mockResolvedValue(connection),
      checkDrift: vi.fn().mockResolvedValue({ added: [], removed: [], hasDrift: false }),
      verifyLogin: vi.fn().mockResolvedValue(true),
      delayFn: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 10,
      pollTimeoutMs: 100,
    },
  };
}

describe("runKiteMcpOnlyLogin", () => {
  it("connects anonymously, calls login, opens the returned URL, polls until verified, then drift-checks and returns a KiteClient session", async () => {
    const { deps, connection } = mcpOnlyDeps();

    const session = await runKiteMcpOnlyLogin(deps);

    expect(deps.connectMcp).toHaveBeenCalledWith({});
    expect(connection.caller.callTool).toHaveBeenCalledWith("login", {});
    expect(deps.openExternal).toHaveBeenCalledWith("https://mcp.kite.trade/authorize?session_id=abc%7C123");
    expect(deps.verifyLogin).toHaveBeenCalled();
    expect(deps.checkDrift).toHaveBeenCalledWith(connection.listing);
    expect(session.connection).toBe(connection);
    expect(session.drift.hasDrift).toBe(false);

    await session.kite.getLTP(["NSE:INFY"]);
    expect(connection.caller.callTool).toHaveBeenCalledWith("get_ltp", { instruments: ["NSE:INFY"] });
  });

  it("surfaces detected drift on the returned session", async () => {
    const { deps } = mcpOnlyDeps();
    deps.checkDrift = vi.fn().mockResolvedValue({ added: ["new_tool"], removed: [], hasDrift: true });

    const session = await runKiteMcpOnlyLogin(deps);
    expect(session.drift).toEqual({ added: ["new_tool"], removed: [], hasDrift: true });
  });

  it("wires onKiteResponse through to the session's KiteClient", async () => {
    const { deps, connection } = mcpOnlyDeps();
    const onKiteResponse = vi.fn();

    const session = await runKiteMcpOnlyLogin({ ...deps, onKiteResponse });
    // The login() call during setup already went through onKiteResponse; this
    // just confirms subsequent calls on the returned session do too.
    connection.caller.callTool = vi.fn().mockResolvedValue({ data: { user_id: "AB1234" } });
    await session.kite.getProfile();

    expect(onKiteResponse).toHaveBeenCalledWith({ data: { user_id: "AB1234" } });
  });

  it("closes the connection exactly once and rethrows when checkDrift fails after connect", async () => {
    const { deps, connection } = mcpOnlyDeps();
    deps.checkDrift = vi.fn().mockRejectedValue(new Error("tools/list failed"));
    const callOrder: string[] = [];
    connection.close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            callOrder.push("close-resolved");
            resolve(undefined);
          }, 0);
        }),
    );

    await expect(runKiteMcpOnlyLogin(deps)).rejects.toThrow(/tools\/list failed/);
    callOrder.push("rejected");

    expect(connection.close).toHaveBeenCalledTimes(1);
    // Proves the implementation awaits close() before rethrowing: if the
    // await were dropped, the rejection would race ahead of the delayed
    // close and this order would come out reversed (or incomplete).
    expect(callOrder).toEqual(["close-resolved", "rejected"]);
  });

  it("rejects and closes the connection when the login response has no extractable URL", async () => {
    const { deps, connection } = mcpOnlyDeps();
    connection.caller.callTool = vi.fn().mockResolvedValue({ content: [{ text: "no link here" }] });

    await expect(runKiteMcpOnlyLogin(deps)).rejects.toThrow(/did not include a login URL/);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it("opens the login URL but rejects and closes the connection when login is never detected as complete (the never-pass-through-on-failure case)", async () => {
    const { deps, connection } = mcpOnlyDeps();
    deps.verifyLogin = vi.fn().mockResolvedValue(false);

    await expect(runKiteMcpOnlyLogin(deps)).rejects.toThrow(/Kite login/i);
    // The URL was genuinely opened (the user had a real chance to log in) --
    // only the never-confirmed verification fails, proving the session is
    // never marked authenticated on an unconfirmed login.
    expect(deps.openExternal).toHaveBeenCalledWith("https://mcp.kite.trade/authorize?session_id=abc%7C123");
    expect(deps.checkDrift).not.toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalledTimes(1);
  });
});
