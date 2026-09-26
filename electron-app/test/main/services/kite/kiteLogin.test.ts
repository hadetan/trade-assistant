import { describe, expect, it, vi } from "vitest";
import { runKiteLogin } from "../../../../src/main/services/kite/kiteLogin";

function baseDeps() {
  const callTool = vi.fn().mockResolvedValue({ ok: true });
  const ticker = {
    connect: vi.fn(),
    updateCredentialsAndConnect: vi.fn(),
    disconnect: vi.fn(),
    subscribe: vi.fn(),
    onTick: vi.fn(),
    onConnectionChange: vi.fn(),
  };
  return {
    callTool,
    ticker,
    deps: {
      config: { apiKey: "k123", apiSecret: "s456", loginPort: 3000 },
      cacheDir: "/tmp/does-not-matter",
      captureRequestToken: vi.fn().mockResolvedValue("req_tok"),
      exchangeAccessToken: vi.fn().mockResolvedValue({ data: { access_token: "at_999" } }),
      postForm: vi.fn(),
      openExternal: vi.fn(),
      createRestCaller: vi.fn().mockReturnValue({ callTool }),
      createTicker: vi.fn().mockReturnValue(ticker),
    },
  };
}

describe("runKiteLogin", () => {
  it("runs capture -> exchange -> builds a REST-backed KiteClient and a ticker", async () => {
    const { deps, callTool, ticker } = baseDeps();

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
    expect(deps.createRestCaller).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "k123", accessToken: "at_999" }),
    );
    expect(deps.createTicker).toHaveBeenCalledWith("k123", "at_999");
    expect(ticker.updateCredentialsAndConnect).toHaveBeenCalledWith("k123", "at_999");
    expect(session.ticker).toBe(ticker);

    await session.kite.getLTP(["NSE:INFY"]);
    expect(callTool).toHaveBeenCalledWith("get_ltp", { instruments: ["NSE:INFY"] });
  });

  it("wires onKiteResponse through to the session's KiteClient", async () => {
    const { deps, callTool } = baseDeps();
    callTool.mockResolvedValue({ data: { user_id: "AB1234" } });
    const onKiteResponse = vi.fn();

    const session = await runKiteLogin({ ...deps, onKiteResponse });
    await session.kite.getProfile();

    expect(onKiteResponse).toHaveBeenCalledWith({ data: { user_id: "AB1234" } });
  });

  it("rejects with a clear error when the token exchange has no access_token", async () => {
    const { deps } = baseDeps();
    deps.exchangeAccessToken = vi.fn().mockResolvedValue({ data: {} });

    await expect(runKiteLogin(deps)).rejects.toThrow(/did not include data.access_token/);
    expect(deps.createRestCaller).not.toHaveBeenCalled();
  });

  it("reuses an existingTicker instead of constructing a new one, and updates its credentials", async () => {
    const { deps, ticker } = baseDeps();
    const existingTicker = { ...ticker, updateCredentialsAndConnect: vi.fn() };

    const session = await runKiteLogin({ ...deps, existingTicker });

    expect(deps.createTicker).not.toHaveBeenCalled();
    expect(existingTicker.updateCredentialsAndConnect).toHaveBeenCalledWith("k123", "at_999");
    expect(session.ticker).toBe(existingTicker);
  });
});
