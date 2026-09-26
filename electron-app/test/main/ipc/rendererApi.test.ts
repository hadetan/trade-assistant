import { describe, expect, it, vi } from "vitest";
import { buildRendererApi } from "../../../src/main/ipc/rendererApi";

describe("buildRendererApi", () => {
  it("exposes exactly the twenty-one bridge methods and never leaks the raw transport", () => {
    const api = buildRendererApi(vi.fn().mockResolvedValue({}), vi.fn());
    expect(Object.keys(api).sort()).toEqual([
      "cancelBenchmark",
      "checkReadiness",
      "copyBenchmarkResult",
      "createSession",
      "getSession",
      "getStatus",
      "listAlgorithms",
      "listLakeSymbols",
      "listSessions",
      "login",
      "onBanner",
      "onBenchmarkProgress",
      "onLiveCandleClose",
      "onLiveStatus",
      "onLiveTick",
      "onTrace",
      "runAnalysis",
      "runBenchmark",
      "searchInstruments",
      "startLiveSession",
      "stopLiveSession",
    ]);
    expect((api as Record<string, unknown>).ipcRenderer).toBeUndefined();
    expect((api as Record<string, unknown>).invoke).toBeUndefined();
  });

  it("routes getStatus through status:get", async () => {
    const invoke = vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated" });
    const status = await buildRendererApi(invoke, vi.fn()).getStatus();
    expect(invoke).toHaveBeenCalledWith("status:get");
    expect(status.sidecar).toBe("up");
  });

  it("registers onBanner against the banner:push channel", () => {
    const subscribe = vi.fn();
    const handler = vi.fn();
    buildRendererApi(vi.fn(), subscribe).onBanner(handler);
    expect(subscribe).toHaveBeenCalledWith("banner:push", handler);
  });

  it("routes login through kite:login", async () => {
    const invoke = vi.fn().mockResolvedValue({ status: "authenticated" });
    expect(await buildRendererApi(invoke, vi.fn()).login()).toEqual({ status: "authenticated" });
    expect(invoke).toHaveBeenCalledWith("kite:login");
  });

  it("routes searchInstruments through kite:searchInstruments with a query payload", async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    await buildRendererApi(invoke, vi.fn()).searchInstruments("infy");
    expect(invoke).toHaveBeenCalledWith("kite:searchInstruments", { query: "infy" });
  });

  it("routes runAnalysis through analysis:run with the params payload", async () => {
    const invoke = vi.fn().mockResolvedValue({ mode: "engine_only" });
    const params = {
      mode: "engine_only" as const,
      sessionId: "s1",
      instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
      horizon: "positional" as const,
      intent_lens: "buying" as const,
    };
    await buildRendererApi(invoke, vi.fn()).runAnalysis(params);
    expect(invoke).toHaveBeenCalledWith("analysis:run", params);
  });

  it("routes listAlgorithms through benchmark:listAlgorithms", async () => {
    const invoke = vi.fn().mockResolvedValue([{ id: "sma", cost: "fast", requiredLookback: 20 }]);
    const entries = await buildRendererApi(invoke, vi.fn()).listAlgorithms();
    expect(invoke).toHaveBeenCalledWith("benchmark:listAlgorithms");
    expect(entries[0].id).toBe("sma");
  });

  it("subscribes onBenchmarkProgress to the benchmark:progress channel", () => {
    const subscribe = vi.fn();
    const handler = vi.fn();
    buildRendererApi(vi.fn(), subscribe).onBenchmarkProgress(handler);
    expect(subscribe).toHaveBeenCalledWith("benchmark:progress", handler);
  });
});

describe("buildRendererApi trace wiring", () => {
  it("subscribes onTrace to analysis:trace", () => {
    const subscribe = vi.fn();
    const handler = vi.fn();
    buildRendererApi(vi.fn(), subscribe).onTrace(handler);
    expect(subscribe).toHaveBeenCalledWith("analysis:trace", handler);
  });

  it("routes an ai_assisted run through analysis:run", async () => {
    const invoke = vi.fn().mockResolvedValue({ mode: "ai_assisted" });
    const api = buildRendererApi(invoke, vi.fn());
    await api.runAnalysis({ mode: "ai_assisted", sessionId: "s1", query: "infy", intent_lens: "buying", requestId: "r1" });
    expect(invoke).toHaveBeenCalledWith("analysis:run", { mode: "ai_assisted", sessionId: "s1", query: "infy", intent_lens: "buying", requestId: "r1" });
  });
});

describe("buildRendererApi history wiring", () => {
  it("routes createSession through history:createSession with a mode payload", async () => {
    const invoke = vi.fn().mockResolvedValue({ id: "s1" });
    await buildRendererApi(invoke, vi.fn()).createSession("engine_only");
    expect(invoke).toHaveBeenCalledWith("history:createSession", { mode: "engine_only" });
  });

  it("routes listSessions through history:listSessions with no args", async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    await buildRendererApi(invoke, vi.fn()).listSessions();
    expect(invoke).toHaveBeenCalledWith("history:listSessions");
  });

  it("routes getSession through history:getSession with an id payload", async () => {
    const invoke = vi.fn().mockResolvedValue({ id: "s1", response_mode: "ai_assisted", messages: [] });
    await buildRendererApi(invoke, vi.fn()).getSession("s1");
    expect(invoke).toHaveBeenCalledWith("history:getSession", { id: "s1" });
  });

  it("routes checkReadiness through analysis:checkReadiness", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const params = {
      instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
      interval: "5minute" as const,
    };
    expect(await buildRendererApi(invoke, vi.fn()).checkReadiness(params)).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("analysis:checkReadiness", params);
  });
});

describe("buildRendererApi live wiring", () => {
  it("startLiveSession invokes live:start with the given params", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const params = {
      sessionId: "s1",
      assistantMessageId: "m1",
      instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
      interval: "5minute" as const,
    };
    await buildRendererApi(invoke, vi.fn()).startLiveSession(params);
    expect(invoke).toHaveBeenCalledWith("live:start", params);
  });

  it("stopLiveSession invokes live:stop", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    await buildRendererApi(invoke, vi.fn()).stopLiveSession();
    expect(invoke).toHaveBeenCalledWith("live:stop");
  });

  it("onLiveTick/onLiveCandleClose/onLiveStatus subscribe to their channels", () => {
    const subscribe = vi.fn();
    const api = buildRendererApi(vi.fn(), subscribe);
    const tickHandler = vi.fn();
    const closeHandler = vi.fn();
    const statusHandler = vi.fn();

    api.onLiveTick(tickHandler);
    api.onLiveCandleClose(closeHandler);
    api.onLiveStatus(statusHandler);

    expect(subscribe).toHaveBeenCalledWith("live:tick", expect.any(Function));
    expect(subscribe).toHaveBeenCalledWith("live:candleClose", expect.any(Function));
    expect(subscribe).toHaveBeenCalledWith("live:status", expect.any(Function));
  });

  it("onLiveTick/onLiveCandleClose/onLiveStatus hand back the transport's unsubscribe", () => {
    // LiveSessionView remounts on every Analyze click; without this each mount
    // would leave three more listeners on these channels forever.
    const unsubscribe = vi.fn();
    const subscribe = vi.fn().mockReturnValue(unsubscribe);
    const api = buildRendererApi(vi.fn(), subscribe);

    expect(api.onLiveTick(vi.fn())).toBe(unsubscribe);
    expect(api.onLiveCandleClose(vi.fn())).toBe(unsubscribe);
    expect(api.onLiveStatus(vi.fn())).toBe(unsubscribe);
  });
});
