import { describe, expect, it, vi } from "vitest";
import { createKiteRestCaller } from "../../../../src/main/services/kite/kiteRestCaller";

function fakeResponse(body: unknown, overrides: Partial<{ ok: boolean; status: number }> = {}) {
  return { ok: true, status: 200, json: async () => body, ...overrides };
}

function baseDeps(fetchFn = vi.fn()) {
  return {
    apiKey: "k123",
    accessToken: "at999",
    instrumentMaster: { search: vi.fn().mockResolvedValue([{ instrument_token: "408065", tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", name: "INFOSYS" }]) },
    fetchFn,
  };
}

describe("createKiteRestCaller", () => {
  it("search_instruments delegates to instrumentMaster.search and wraps the result as {data: [...]}", async () => {
    const deps = baseDeps();
    const caller = createKiteRestCaller(deps);

    const result = await caller.callTool("search_instruments", { query: "infy" });

    expect(deps.instrumentMaster.search).toHaveBeenCalledWith("infy");
    expect(result).toEqual({ data: [{ instrument_token: "408065", tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", name: "INFOSYS" }] });
  });

  it("get_historical_data builds the correct URL and query params", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse({ data: { candles: [] } }));
    const caller = createKiteRestCaller(baseDeps(fetchFn));

    await caller.callTool("get_historical_data", {
      instrument_token: "408065",
      interval: "5minute",
      from: "2026-09-01 09:15:00",
      to: "2026-09-26 15:30:00",
    });

    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.kite.trade/instruments/historical/408065/5minute?from=2026-09-01+09%3A15%3A00&to=2026-09-26+15%3A30%3A00",
    );
    expect(init.headers).toEqual({ Authorization: "token k123:at999", "X-Kite-Version": "3" });
  });

  it("get_quotes/get_ohlc/get_ltp send repeated i= params for each instrument", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse({ data: {} }));
    const caller = createKiteRestCaller(baseDeps(fetchFn));

    await caller.callTool("get_quotes", { instruments: ["NSE:INFY", "NSE:TCS"] });
    expect(String(fetchFn.mock.calls[0][0])).toBe("https://api.kite.trade/quote?i=NSE%3AINFY&i=NSE%3ATCS");

    await caller.callTool("get_ohlc", { instruments: ["NSE:INFY"] });
    expect(String(fetchFn.mock.calls[1][0])).toBe("https://api.kite.trade/quote/ohlc?i=NSE%3AINFY");

    await caller.callTool("get_ltp", { instruments: ["NSE:INFY"] });
    expect(String(fetchFn.mock.calls[2][0])).toBe("https://api.kite.trade/quote/ltp?i=NSE%3AINFY");
  });

  it.each([
    ["get_margins", "https://api.kite.trade/user/margins"],
    ["get_holdings", "https://api.kite.trade/portfolio/holdings"],
    ["get_positions", "https://api.kite.trade/portfolio/positions"],
    ["get_profile", "https://api.kite.trade/user/profile"],
    ["get_gtts", "https://api.kite.trade/gtt/triggers"],
  ])("%s calls %s with no query params", async (toolName, expectedUrl) => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse({ data: {} }));
    const caller = createKiteRestCaller(baseDeps(fetchFn));

    await caller.callTool(toolName, {});

    expect(String(fetchFn.mock.calls[0][0])).toBe(expectedUrl);
  });

  it("returns the parsed JSON body on success", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse({ data: { user_id: "AB1234" } }));
    const caller = createKiteRestCaller(baseDeps(fetchFn));

    await expect(caller.callTool("get_profile", {})).resolves.toEqual({ data: { user_id: "AB1234" } });
  });

  it("throws an error embedding the raw error_type on a non-ok response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      fakeResponse({ error_type: "TokenException", message: "Invalid access token" }, { ok: false, status: 403 }),
    );
    const caller = createKiteRestCaller(baseDeps(fetchFn));

    await expect(caller.callTool("get_profile", {})).rejects.toThrow(
      /Kite API error \(403 TokenException\): Invalid access token/,
    );
  });

  it("throws for an unsupported tool name", async () => {
    const caller = createKiteRestCaller(baseDeps());
    await expect(caller.callTool("place_order", {})).rejects.toThrow(/unsupported tool "place_order"/);
  });
});
