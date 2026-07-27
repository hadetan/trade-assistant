import { describe, expect, it, vi } from "vitest";
import { ScanScheduler, type ScanSchedulerDeps } from "../../src/main/scanScheduler";
import type { ScanConfig } from "../../src/main/services/history/historyStore";
import { historicalResponse } from "../fixtures/sidecarFixtures";

type Decision = "NoChange" | "WorthLook" | "WorthAiCall";

function computeResult() {
  return {
    type: "compute" as const,
    id: 1,
    algo_results: [
      { algo_id: "rsi", symbol: "NSE:INFY", timeframe: "5minute", horizon: "intraday", direction: "Bullish", magnitude: 0.4, confidence: 0.6, evidence: ["RSI 62"], computed_at: "2026-07-27T00:00:00+00:00" },
    ],
    confluence: { bullish_count: 8, bearish_count: 1, neutral_count: 2, weighted_vote: 0.5 },
  };
}

function searchResult(exchange: string, tradingsymbol: string, token: number) {
  return { data: [{ tradingsymbol, exchange, segment: exchange, instrument_token: token }] };
}

interface HarnessOptions {
  config?: ScanConfig;
  watchlist?: string[];
  decision?: Decision;
  kiteLoggedIn?: boolean;
  completeAiAssisted?: ScanSchedulerDeps["provider"]["completeAiAssisted"];
  computeImpl?: () => Promise<ReturnType<typeof computeResult>>;
  listWatchlistImpl?: () => Promise<{ type: "watchlist"; id: number; symbols: string[] }>;
  searchImpl?: (query: string) => Promise<unknown>;
}

function makeHarness(options: HarnessOptions = {}) {
  const decision: Decision = options.decision ?? "NoChange";
  const watchlist = options.watchlist ?? ["NSE:INFY"];

  const searchInstruments = vi.fn(
    options.searchImpl ?? ((query: string) => Promise.resolve(searchResult("NSE", query, 408065))),
  );
  const getHistoricalData = vi.fn(async () => historicalResponse());
  const kite = { searchInstruments, getHistoricalData };

  const compute = vi.fn(options.computeImpl ?? (async () => computeResult()));
  const persistCandles = vi.fn(async (_s: string, _t: string, candles: { length: number }) => ({
    type: "persist_candles" as const,
    id: 1,
    written: candles.length,
  }));
  const listWatchlist = vi.fn(
    options.listWatchlistImpl ?? (async () => ({ type: "watchlist" as const, id: 1, symbols: watchlist })),
  );
  const evaluateScanGate = vi.fn(async () => ({ type: "scan_gate" as const, id: 1, decision }));
  const sidecar = { compute, persistCandles, listWatchlist, evaluateScanGate };

  const completeAiAssisted =
    options.completeAiAssisted ??
    vi.fn(async () => ({
      verdict: { direction: "bullish", conviction: "high", reasoning: "r", cited_algo_ids: ["rsi"], verify_before_acting: "check LTP" },
      narrative: "Infy looks constructive.",
    }));
  const provider = { intake: vi.fn(), completeAiAssisted };

  const createSession = vi.fn((mode: string) => ({ id: `session-${mode}`, response_mode: mode, created_at: "t", last_active_at: "t", preview: "(no messages yet)" }));
  const appendMessage = vi.fn();
  const getClaudeSessionId = vi.fn().mockReturnValue(null);
  const setClaudeSessionId = vi.fn();
  const history = { createSession, appendMessage, getClaudeSessionId, setClaudeSessionId };

  const notify = vi.fn();

  const intervals: Array<{ cb: () => void; ms: number; handle: NodeJS.Timeout }> = [];
  const cleared: NodeJS.Timeout[] = [];
  let handleCounter = 0;
  const setIntervalFn = (cb: () => void, ms: number) => {
    const handle = ++handleCounter as unknown as NodeJS.Timeout;
    intervals.push({ cb, ms, handle });
    return handle;
  };
  const clearIntervalFn = (handle: NodeJS.Timeout) => cleared.push(handle);

  const deps: ScanSchedulerDeps = {
    sidecar: sidecar as unknown as ScanSchedulerDeps["sidecar"],
    getKite: () => (options.kiteLoggedIn === false ? null : (kite as unknown as ReturnType<ScanSchedulerDeps["getKite"]>)),
    provider: provider as unknown as ScanSchedulerDeps["provider"],
    history: history as unknown as ScanSchedulerDeps["history"],
    notify,
    now: () => new Date("2026-07-27T10:00:00Z"),
    setIntervalFn,
    clearIntervalFn,
  };

  const config: ScanConfig = options.config ?? { enabled: false, intervalMinutes: 15 };
  return {
    scheduler: new ScanScheduler(deps, config),
    spies: { searchInstruments, getHistoricalData, compute, listWatchlist, evaluateScanGate, completeAiAssisted, createSession, appendMessage, getClaudeSessionId, setClaudeSessionId, notify },
    timers: { intervals, cleared },
  };
}

describe("ScanScheduler.tick", () => {
  it("does nothing when Kite is not logged in", async () => {
    const { scheduler, spies } = makeHarness({ kiteLoggedIn: false });
    await scheduler.tick();
    expect(spies.listWatchlist).not.toHaveBeenCalled();
  });

  it("processes watchlist symbols sequentially, not concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const computeImpl = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return computeResult();
    };
    const { scheduler } = makeHarness({ watchlist: ["NSE:INFY", "NSE:TCS"], computeImpl });
    await scheduler.tick();
    expect(maxInFlight).toBe(1);
  });

  it("a NoChange decision writes nothing to history and does not notify", async () => {
    const { scheduler, spies } = makeHarness({ decision: "NoChange" });
    await scheduler.tick();
    expect(spies.createSession).not.toHaveBeenCalled();
    expect(spies.appendMessage).not.toHaveBeenCalled();
    expect(spies.notify).not.toHaveBeenCalled();
  });

  it("a WorthLook decision creates an engine_only session, appends both messages with a proactive_scan trigger, and notifies", async () => {
    const { scheduler, spies } = makeHarness({ decision: "WorthLook" });
    await scheduler.tick();
    expect(spies.createSession).toHaveBeenCalledWith("engine_only");
    expect(spies.appendMessage).toHaveBeenCalledTimes(2);
    const userTurn = spies.appendMessage.mock.calls[0][0];
    expect(userTurn.role).toBe("user");
    expect(userTurn.structuredPayload).toEqual({ trigger: "proactive_scan", symbol: "NSE:INFY", horizon: "intraday", intent_lens: "buying" });
    const assistantTurn = spies.appendMessage.mock.calls[1][0];
    expect(assistantTurn.role).toBe("assistant");
    const notifyBody = spies.notify.mock.calls[0][1];
    expect(assistantTurn.renderedText.split("\n")[0]).toBe(notifyBody);
    expect(spies.completeAiAssisted).not.toHaveBeenCalled();
  });

  it("a WorthAiCall decision creates an ai_assisted session, calls completeAiAssisted with a fresh claudeSessionId and resumeSession false, and persists claude_session_id only after success", async () => {
    const { scheduler, spies } = makeHarness({ decision: "WorthAiCall" });
    await scheduler.tick();
    expect(spies.createSession).toHaveBeenCalledWith("ai_assisted");
    expect(spies.completeAiAssisted).toHaveBeenCalledTimes(1);
    const opts = spies.completeAiAssisted.mock.calls[0][1];
    expect(opts.resumeSession).toBe(false);
    expect(typeof opts.claudeSessionId).toBe("string");
    expect(opts.claudeSessionId.length).toBeGreaterThan(0);
    expect(spies.setClaudeSessionId).toHaveBeenCalledWith("session-ai_assisted", opts.claudeSessionId);
    expect(spies.notify).toHaveBeenCalledTimes(1);
  });

  it("a WorthAiCall failure leaves the user message orphaned and never calls setClaudeSessionId", async () => {
    const completeAiAssisted = vi.fn().mockRejectedValue(new Error("claude failed"));
    const { scheduler, spies } = makeHarness({ decision: "WorthAiCall", completeAiAssisted });
    await scheduler.tick();
    expect(spies.appendMessage).toHaveBeenCalledTimes(1);
    expect(spies.appendMessage.mock.calls[0][0].role).toBe("user");
    expect(spies.setClaudeSessionId).not.toHaveBeenCalled();
    expect(spies.notify).not.toHaveBeenCalled();
  });

  it("skips a symbol that fails to resolve to an instrument without aborting the rest of the tick", async () => {
    const searchImpl = (query: string) =>
      Promise.resolve(query === "INFY" ? { data: [] } : searchResult("NSE", query, 26000));
    const { scheduler, spies } = makeHarness({ decision: "WorthLook", watchlist: ["NSE:INFY", "NSE:TCS"], searchImpl });
    await scheduler.tick();
    // INFY resolved to nothing (skipped); TCS still produced a session.
    expect(spies.createSession).toHaveBeenCalledTimes(1);
    expect(spies.evaluateScanGate).toHaveBeenCalledWith("NSE:TCS", expect.anything());
  });

  it("does not let an error processing one symbol stop the next symbol", async () => {
    let call = 0;
    const computeImpl = async () => {
      call += 1;
      if (call === 1) throw new Error("compute blew up for the first symbol");
      return computeResult();
    };
    const { scheduler, spies } = makeHarness({ decision: "WorthLook", watchlist: ["NSE:INFY", "NSE:TCS"], computeImpl });
    await scheduler.tick();
    expect(spies.createSession).toHaveBeenCalledTimes(1);
  });
});

describe("ScanScheduler timer control", () => {
  it("setConfig restarts the interval, clearing the previous timer and scheduling a new one at the new period", () => {
    const { scheduler, timers } = makeHarness({ config: { enabled: true, intervalMinutes: 15 } });
    expect(timers.intervals).toHaveLength(1);
    expect(timers.intervals[0].ms).toBe(15 * 60_000);
    const firstHandle = timers.intervals[0].handle;

    scheduler.setConfig({ enabled: true, intervalMinutes: 30 });
    expect(timers.cleared).toContain(firstHandle);
    expect(timers.intervals).toHaveLength(2);
    expect(timers.intervals[1].ms).toBe(30 * 60_000);
    expect(scheduler.getConfig()).toEqual({ enabled: true, intervalMinutes: 30 });
  });

  it("does not schedule a timer while scanning is disabled", () => {
    const { timers } = makeHarness({ config: { enabled: false, intervalMinutes: 15 } });
    expect(timers.intervals).toHaveLength(0);
  });

  it("skips an overlapping tick while one is already in flight", async () => {
    let resolveList: (value: { type: "watchlist"; id: number; symbols: string[] }) => void = () => {};
    const listWatchlistImpl = () =>
      new Promise<{ type: "watchlist"; id: number; symbols: string[] }>((resolve) => {
        resolveList = resolve;
      });
    const { scheduler, spies } = makeHarness({ listWatchlistImpl });
    const first = scheduler.tick();
    const second = scheduler.tick();
    resolveList({ type: "watchlist", id: 1, symbols: [] });
    await Promise.all([first, second]);
    expect(spies.listWatchlist).toHaveBeenCalledTimes(1);
  });
});
