import { describe, expect, it, vi } from "vitest";
import { buildRendererApi } from "../../../src/main/ipc/rendererApi";

describe("buildRendererApi", () => {
  it("exposes exactly the thirteen bridge methods and never leaks the raw transport", () => {
    const api = buildRendererApi(vi.fn().mockResolvedValue({}), vi.fn());
    expect(Object.keys(api).sort()).toEqual([
      "copyBenchmarkResult",
      "createSession",
      "getSession",
      "getStatus",
      "listLakeSymbols",
      "listSessions",
      "login",
      "onBanner",
      "onNarrative",
      "onTrace",
      "runAnalysis",
      "runBenchmark",
      "searchInstruments",
    ]);
    expect((api as Record<string, unknown>).ipcRenderer).toBeUndefined();
    expect((api as Record<string, unknown>).invoke).toBeUndefined();
  });

  it("routes getStatus through status:get", async () => {
    const invoke = vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null });
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
});

describe("buildRendererApi narrative wiring", () => {
  it("subscribes onTrace and the onNarrative adapter to analysis:trace", () => {
    const subscribe = vi.fn();
    const api = buildRendererApi(vi.fn(), subscribe);
    api.onTrace(vi.fn());
    expect(subscribe).toHaveBeenLastCalledWith("analysis:trace", expect.any(Function));
    const narrHandler = vi.fn();
    api.onNarrative(narrHandler);
    const adapter = subscribe.mock.calls.at(-1)![1] as (p: unknown) => void;
    adapter({ requestId: "r1", source: "narrative", kind: "token", detail: "hi", at: "t" });
    adapter({ requestId: "r1", source: "intake", kind: "started", at: "t" }); // ignored
    expect(narrHandler).toHaveBeenCalledTimes(1);
    expect(narrHandler).toHaveBeenCalledWith({ requestId: "r1", chunk: "hi" });

    adapter({ requestId: "r1", source: "narrative", kind: "done", at: "t" });
    expect(narrHandler).toHaveBeenLastCalledWith({ requestId: "r1", done: true });

    adapter({ requestId: "r1", source: "narrative", kind: "error", detail: "boom", at: "t" });
    expect(narrHandler).toHaveBeenLastCalledWith({ requestId: "r1", error: "boom" });

    expect(narrHandler).toHaveBeenCalledTimes(3);
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
});

import { buildSettingsApi } from "../../../src/main/ipc/rendererApi";

describe("buildSettingsApi", () => {
  it("routes each Settings channel to the right ipc name", async () => {
    const invoke = vi.fn().mockResolvedValue({});
    const api = buildSettingsApi(invoke);

    await api.getScanConfig();
    expect(invoke).toHaveBeenCalledWith("settings:getScanConfig");

    await api.setScanConfig({ enabled: true, intervalMinutes: 30 });
    expect(invoke).toHaveBeenCalledWith("settings:setScanConfig", { enabled: true, intervalMinutes: 30 });

    await api.listWatchlist();
    expect(invoke).toHaveBeenCalledWith("settings:listWatchlist");

    await api.addWatchlistSymbol("NSE:INFY");
    expect(invoke).toHaveBeenCalledWith("settings:addWatchlistSymbol", { symbol: "NSE:INFY" });

    await api.removeWatchlistSymbol("NSE:INFY");
    expect(invoke).toHaveBeenCalledWith("settings:removeWatchlistSymbol", { symbol: "NSE:INFY" });

    await api.getAccountStatus();
    expect(invoke).toHaveBeenCalledWith("settings:getAccountStatus");

    await api.searchInstruments("infy");
    expect(invoke).toHaveBeenCalledWith("kite:searchInstruments", { query: "infy" });
  });
});
