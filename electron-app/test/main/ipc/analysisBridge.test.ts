import { describe, expect, it, vi } from "vitest";
import { horizonToFetchParams, registerAnalysisBridge, runAnalysisRequest } from "../../../src/main/ipc/analysisBridge";
import { KiteClient } from "../../../src/main/services/kite/kiteClient";
import type { CandleWire } from "../../../src/main/services/sidecar/sidecarProtocol";
import type { KiteSession } from "../../../src/main/services/kite/kiteLogin";

function historicalResponse() {
  return {
    data: {
      candles: [
        ["2026-01-02T00:00:00+0530", 100, 105, 99, 104, 5000],
        ["2026-01-03T00:00:00+0530", 104, 108, 103, 107, 6000],
      ],
    },
  };
}

function computeResponse() {
  return {
    type: "compute" as const,
    id: 1,
    algo_results: [
      {
        algo_id: "rsi",
        symbol: "NSE:INFY",
        timeframe: "day",
        horizon: "positional",
        direction: "Bullish",
        magnitude: 0.4,
        confidence: 0.6,
        evidence: ["RSI 62"],
        computed_at: "2026-07-25T00:00:00+00:00",
      },
    ],
    confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
  };
}

function mockSidecar() {
  return {
    persistCandles: vi.fn(async (_s: string, _t: string, candles: CandleWire[]) => ({
      type: "persist_candles" as const,
      id: 1,
      written: candles.length,
    })),
    compute: vi.fn(async () => computeResponse()),
  };
}

describe("horizonToFetchParams", () => {
  const now = new Date("2026-07-25T10:30:00+05:30");

  it("maps intraday to a 5minute datetime window", () => {
    const params = horizonToFetchParams("intraday", now);
    expect(params.timeframe).toBe("5minute");
    expect(params.from).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(params.to).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("maps positional to a day date window", () => {
    const params = horizonToFetchParams("positional", now);
    expect(params.timeframe).toBe("day");
    expect(params.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(params.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("runAnalysisRequest", () => {
  it("assembles an envelope and returns a generated engine_only result", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const sidecar = mockSidecar();

    const result = await runAnalysisRequest(
      { kite, sidecar: sidecar as never },
      { instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" }, horizon: "positional" },
    );

    expect(result.mode).toBe("engine_only");
    expect(result.horizon).toBe("positional");
    expect(result.instrument.kite_token_asof).toBe("408065");
    expect(result.response.direction).toBe("bullish");
    expect(result.algo_results[0].algo_id).toBe("rsi");
    expect(sidecar.compute).toHaveBeenCalledWith("NSE:INFY", "day", [104, 107]);
  });
});

describe("registerAnalysisBridge", () => {
  function harness(session: KiteSession | null) {
    const handlers = new Map<string, (event: unknown, arg: unknown) => unknown>();
    const login = vi.fn().mockResolvedValue({ status: "authenticated" });
    const markNeedsLogin = vi.fn();
    registerAnalysisBridge({
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn as never) } as never,
      login,
      getSession: () => session,
      sidecar: mockSidecar() as never,
      markNeedsLogin,
    });
    return { handlers, login, markNeedsLogin };
  }

  it("routes kite:login to the injected login effect", async () => {
    const { handlers, login } = harness(null);
    await handlers.get("kite:login")!(null, undefined);
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("rejects searchInstruments and analysis:run when there is no session", async () => {
    const { handlers } = harness(null);
    expect(() => handlers.get("kite:searchInstruments")!(null, { query: "infy" })).toThrow(/not logged in/);
    expect(() =>
      handlers.get("analysis:run")!(null, {
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        horizon: "positional",
      }),
    ).toThrow(/not logged in/);
  });

  it("forwards searchInstruments to the live session's KiteClient", async () => {
    const callTool = vi.fn().mockResolvedValue({ data: [] });
    const session = { kite: new KiteClient({ callTool }) } as KiteSession;
    const { handlers } = harness(session);
    await handlers.get("kite:searchInstruments")!(null, { query: "infy" });
    expect(callTool).toHaveBeenCalledWith("search_instruments", { query: "infy" });
  });

  it("calls markNeedsLogin when kite:searchInstruments fails with a session-expiry-shaped error, then rethrows", async () => {
    const callTool = vi.fn().mockRejectedValue(new Error('{"error_type":"TokenException","message":"Invalid token"}'));
    const session = { kite: new KiteClient({ callTool }) } as KiteSession;
    const { handlers, markNeedsLogin } = harness(session);

    await expect(handlers.get("kite:searchInstruments")!(null, { query: "infy" })).rejects.toThrow(/TokenException/);
    expect(markNeedsLogin).toHaveBeenCalledTimes(1);
  });

  it("does not call markNeedsLogin when kite:searchInstruments fails with an ordinary error", async () => {
    const callTool = vi.fn().mockRejectedValue(new Error("network down"));
    const session = { kite: new KiteClient({ callTool }) } as KiteSession;
    const { handlers, markNeedsLogin } = harness(session);

    await expect(handlers.get("kite:searchInstruments")!(null, { query: "infy" })).rejects.toThrow(/network down/);
    expect(markNeedsLogin).not.toHaveBeenCalled();
  });

  it("calls markNeedsLogin when analysis:run fails with a session-expiry-shaped error, then rethrows", async () => {
    const callTool = vi.fn().mockRejectedValue(new Error("request failed with status 403"));
    const session = { kite: new KiteClient({ callTool }) } as KiteSession;
    const { handlers, markNeedsLogin } = harness(session);

    await expect(
      handlers.get("analysis:run")!(null, {
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        horizon: "positional",
      }),
    ).rejects.toThrow(/403/);
    expect(markNeedsLogin).toHaveBeenCalledTimes(1);
  });

  it("does not call markNeedsLogin when analysis:run fails with an ordinary error", async () => {
    const callTool = vi.fn().mockRejectedValue(new Error("sidecar unreachable"));
    const session = { kite: new KiteClient({ callTool }) } as KiteSession;
    const { handlers, markNeedsLogin } = harness(session);

    await expect(
      handlers.get("analysis:run")!(null, {
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        horizon: "positional",
      }),
    ).rejects.toThrow(/sidecar unreachable/);
    expect(markNeedsLogin).not.toHaveBeenCalled();
  });
});
