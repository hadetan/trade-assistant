import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  horizonToFetchParams,
  registerAnalysisBridge,
  runAiAssistedRequest,
  runAnalysisRequest,
} from "../../../src/main/ipc/analysisBridge";
import { KiteClient } from "../../../src/main/services/kite/kiteClient";
import type { KiteSession } from "../../../src/main/services/kite/kiteLogin";
import type { AiAssistedProvider } from "../../../src/main/services/claude/provider";
import { checkEngineOnlyReadiness } from "../../../src/main/services/market/readinessGate";
import { assembleWarmedEnvelope } from "../../../src/main/services/analysis/warmedEnvelope";
import type { CandleWire } from "../../../src/main/services/sidecar/sidecarProtocol";
import { computeResponse, historicalResponse, mockSidecar } from "../../fixtures/sidecarFixtures";

function fakeProvider(overrides: Partial<AiAssistedProvider> = {}): AiAssistedProvider {
  return {
    intake: vi.fn().mockResolvedValue({
      instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
      horizon: "positional",
      researchNotes: "context",
    }),
    completeAiAssisted: vi.fn(async (_env, opts) => {
      opts.onTrace({ source: "narrative", kind: "token", detail: "Infy " });
      opts.onTrace({ source: "narrative", kind: "token", detail: "is constructive." });
      opts.onTrace({ source: "narrative", kind: "done" });
      return {
        verdict: { direction: "bullish", conviction: "high", reasoning: "rsi", cited_algo_ids: ["rsi"], verify_before_acting: "check LTP" },
        narrative: "Infy is constructive.",
      };
    }),
    ...overrides,
  };
}

function sidecarWithProgress() {
  const bus = new EventEmitter();
  const compute = vi.fn(async (_s: string, _t: string, _h: string, _c: unknown[], onRequestId?: (id: number) => void) => {
    onRequestId?.(42);
    return computeResponse();
  });
  return Object.assign(bus, {
    compute,
    persistCandles: vi.fn(async (_s: string, _t: string, candles: unknown[]) => ({ type: "persist_candles" as const, id: 1, written: candles.length })),
  });
}

function fakeHistory(overrides: Partial<{
  appendMessage: ReturnType<typeof vi.fn>;
  getClaudeSessionId: ReturnType<typeof vi.fn>;
  setClaudeSessionId: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    appendMessage: vi.fn(),
    getClaudeSessionId: vi.fn().mockReturnValue(null),
    setClaudeSessionId: vi.fn(),
    ...overrides,
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

describe("runAiAssistedRequest", () => {
  const aiParams = { mode: "ai_assisted" as const, sessionId: "sess-1", query: "how is infy", intent_lens: "selling" as const, requestId: "r7" };

  it("streams tokens, sends done, and returns an ai_assisted result with the real intent_lens", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const sends: unknown[] = [];
    const result = await runAiAssistedRequest(
      { kite, sidecar: mockSidecar() as never, provider: fakeProvider(), history: fakeHistory() },
      aiParams,
      (event) => sends.push(event),
    );
    expect(result.mode).toBe("ai_assisted");
    if (result.mode !== "ai_assisted") throw new Error("mode");
    expect(result.verdict.direction).toBe("bullish");
    expect(result.narrative).toBe("Infy is constructive.");
    expect(result.intent_lens).toBe("selling");
    expect(sends).toEqual([
      { requestId: "r7", source: "narrative", kind: "token", detail: "Infy ", at: expect.any(String) },
      { requestId: "r7", source: "narrative", kind: "token", detail: "is constructive.", at: expect.any(String) },
      { requestId: "r7", source: "narrative", kind: "done", at: expect.any(String) },
    ]);
  });

  it("writes the user message before the provider call and the assistant message only after success", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const history = fakeHistory();
    await runAiAssistedRequest({ kite, sidecar: mockSidecar() as never, provider: fakeProvider(), history }, aiParams, () => {});
    expect(history.appendMessage).toHaveBeenCalledTimes(2);
    expect(history.appendMessage.mock.calls[0][0]).toMatchObject({ sessionId: "sess-1", role: "user" });
    expect(history.appendMessage.mock.calls[1][0]).toMatchObject({ sessionId: "sess-1", role: "assistant" });
  });

  it("pins a fresh claude_session_id on the first turn and persists it once after success", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const history = fakeHistory({ getClaudeSessionId: vi.fn().mockReturnValue(null) });
    const provider = fakeProvider();
    await runAiAssistedRequest({ kite, sidecar: mockSidecar() as never, provider, history }, aiParams, () => {});
    const opts = (provider.completeAiAssisted as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as {
      claudeSessionId: string;
      resumeSession: boolean;
    };
    expect(opts.resumeSession).toBe(false);
    expect(typeof opts.claudeSessionId).toBe("string");
    expect(history.setClaudeSessionId).toHaveBeenCalledTimes(1);
    expect(history.setClaudeSessionId).toHaveBeenCalledWith("sess-1", opts.claudeSessionId);
  });

  it("resumes the persisted claude_session_id on a later turn and never re-persists it", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const history = fakeHistory({ getClaudeSessionId: vi.fn().mockReturnValue("prev-uuid") });
    const provider = fakeProvider();
    await runAiAssistedRequest({ kite, sidecar: mockSidecar() as never, provider, history }, aiParams, () => {});
    const opts = (provider.completeAiAssisted as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as {
      claudeSessionId: string;
      resumeSession: boolean;
    };
    expect(opts.claudeSessionId).toBe("prev-uuid");
    expect(opts.resumeSession).toBe(true);
    expect(history.setClaudeSessionId).not.toHaveBeenCalled();
  });

  it("does not persist claude_session_id when the first turn fails (leaves it NULL for a clean retry)", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const history = fakeHistory({ getClaudeSessionId: vi.fn().mockReturnValue(null) });
    const provider = fakeProvider({ completeAiAssisted: vi.fn().mockRejectedValue(new Error("claude down")) });
    const sends: unknown[] = [];
    await expect(
      runAiAssistedRequest({ kite, sidecar: mockSidecar() as never, provider, history }, aiParams, (e) => sends.push(e)),
    ).rejects.toThrow(/claude down/);
    expect(history.setClaudeSessionId).not.toHaveBeenCalled();
    expect(history.appendMessage).toHaveBeenCalledTimes(1);
    expect(history.appendMessage.mock.calls[0][0]).toMatchObject({ role: "user" });
    // The bridge itself no longer stamps a generic error; this fake provider
    // rejects without ever touching onTrace, so nothing is sent.
    expect(sends).toEqual([]);
  });

  it("maps an owned compute id's progress to sidecar started/done and ignores unowned ids", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const sidecar = sidecarWithProgress();
    const sends: Array<{ source: string; kind: string; detail?: string }> = [];
    // emit an unowned id BEFORE the owned compute registers 42, and owned ones after
    sidecar.compute.mockImplementationOnce(async (_s, _t, _h, _c, onRequestId?: (id: number) => void) => {
      (sidecar as unknown as EventEmitter).emit("progress", { type: "progress", id: 999, step: "compute", status: "running" }); // unowned → ignored
      onRequestId?.(42);
      (sidecar as unknown as EventEmitter).emit("progress", { type: "progress", id: 42, step: "compute", status: "running" });
      (sidecar as unknown as EventEmitter).emit("progress", { type: "progress", id: 42, step: "rsi", status: "running" });
      (sidecar as unknown as EventEmitter).emit("progress", { type: "progress", id: 42, step: "rsi", status: "done" });
      (sidecar as unknown as EventEmitter).emit("progress", { type: "progress", id: 42, step: "compute", status: "done" });
      return computeResponse();
    });
    await runAiAssistedRequest({ kite, sidecar: sidecar as never, provider: fakeProvider(), history: fakeHistory() }, aiParams, (e) => sends.push(e as never));
    const sidecarEvents = sends.filter((e) => e.source === "sidecar");
    expect(sidecarEvents).toEqual([
      { source: "sidecar", kind: "started", detail: "compute", requestId: "r7", at: expect.any(String) },
      { source: "sidecar", kind: "started", detail: "rsi", requestId: "r7", at: expect.any(String) },
      { source: "sidecar", kind: "done", detail: "rsi", requestId: "r7", at: expect.any(String) },
      { source: "sidecar", kind: "done", detail: "compute", requestId: "r7", at: expect.any(String) },
    ]);
  });

  it("persists the accumulated trace on success and removes the progress listener afterwards", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const sidecar = sidecarWithProgress();
    const history = fakeHistory();
    await runAiAssistedRequest({ kite, sidecar: sidecar as never, provider: fakeProvider(), history }, aiParams, () => {});
    const assistant = history.appendMessage.mock.calls.find((c) => c[0].role === "assistant")![0];
    expect(Array.isArray(assistant.trace)).toBe(true);
    expect((sidecar as unknown as EventEmitter).listenerCount("progress")).toBe(0);
  });

  it("does not push a generic run-level error event; each step attributes its own", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const provider = fakeProvider({ completeAiAssisted: vi.fn().mockRejectedValue(new Error("boom")) });
    const sends: Array<{ source: string; kind: string }> = [];
    await expect(runAiAssistedRequest({ kite, sidecar: sidecarWithProgress() as never, provider, history: fakeHistory() }, aiParams, (e) => sends.push(e as never))).rejects.toThrow(/boom/);
    // No narrative done, and no generic run-level error stamped by the bridge itself.
    expect(sends.some((e) => e.source === "narrative" && e.kind === "done")).toBe(false);
  });
});

function gateReadySidecar() {
  return {
    ...mockSidecar(),
    readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles" as const, id: 1, candles: [] }),
    listAlgorithms: vi.fn().mockResolvedValue({
      type: "algorithms" as const,
      id: 1,
      algorithms: [{ id: "rsi", cost: "fast" as const, required_lookback: 200 }],
    }),
  };
}

describe("registerAnalysisBridge", () => {
  function harness(session: KiteSession | null) {
    const handlers = new Map<string, (event: unknown, arg: unknown) => unknown>();
    const login = vi.fn().mockResolvedValue({ status: "authenticated" });
    const markNeedsLogin = vi.fn();
    const history = fakeHistory();
    registerAnalysisBridge({
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn as never) } as never,
      login,
      getSession: () => session,
      sidecar: gateReadySidecar() as never,
      provider: fakeProvider(),
      history,
      sendTrace: vi.fn(),
      markNeedsLogin,
      kiteStatus: () => "authenticated" as const,
    });
    return { handlers, login, markNeedsLogin, history };
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
        mode: "engine_only",
        sessionId: "sess-1",
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        interval: "5minute" as const,
        intent_lens: "buying",
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
        mode: "engine_only",
        sessionId: "sess-1",
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        interval: "5minute" as const,
        intent_lens: "buying",
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
        mode: "engine_only",
        sessionId: "sess-1",
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        interval: "5minute" as const,
        intent_lens: "buying",
      }),
    ).rejects.toThrow(/sidecar unreachable/);
    expect(markNeedsLogin).not.toHaveBeenCalled();
  });

  it("calls markNeedsLogin when analysis:checkReadiness fails with a session-expiry-shaped error, then rethrows", async () => {
    const callTool = vi.fn().mockRejectedValue(new Error("request failed with status 403"));
    const session = { kite: new KiteClient({ callTool }) } as KiteSession;
    const { handlers, markNeedsLogin } = harness(session);

    await expect(
      handlers.get("analysis:checkReadiness")!(null, {
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        interval: "5minute" as const,
      }),
    ).rejects.toThrow(/403/);
    expect(markNeedsLogin).toHaveBeenCalledTimes(1);
  });

  it("does not call markNeedsLogin when analysis:checkReadiness fails with an ordinary error", async () => {
    const callTool = vi.fn().mockRejectedValue(new Error("sidecar unreachable"));
    const session = { kite: new KiteClient({ callTool }) } as KiteSession;
    const { handlers, markNeedsLogin } = harness(session);

    await expect(
      handlers.get("analysis:checkReadiness")!(null, {
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        interval: "5minute" as const,
      }),
    ).rejects.toThrow(/sidecar unreachable/);
    expect(markNeedsLogin).not.toHaveBeenCalled();
  });
});

describe("runAnalysisRequest readiness gate", () => {
  const INSTRUMENT = { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" };
  const PARAMS = {
    mode: "engine_only" as const,
    sessionId: "sess-1",
    instrument: INSTRUMENT,
    interval: "5minute" as const,
    intent_lens: "buying" as const,
  };

  function gateDeps(readiness: import("../../../src/main/services/market/readinessGate").ReadinessResult) {
    return {
      kite: { getHistoricalData: vi.fn() },
      sidecar: {
        compute: vi.fn(),
        persistCandles: vi.fn(),
        readLakeCandles: vi.fn(),
        listAlgorithms: vi.fn(),
      },
      history: { appendMessage: vi.fn() },
      checkReadiness: vi.fn().mockResolvedValue(readiness),
      assembleEnvelope: vi.fn(),
      now: () => new Date("2026-09-17T11:00:00+05:30"),
    };
  }

  it("returns a blocked result and computes nothing when the gate fails", async () => {
    const deps = gateDeps({ ok: false, reason: "insufficient_history", have: 180, need: 256 });

    const result = await runAnalysisRequest(deps as never, PARAMS);

    expect(result).toEqual({
      mode: "engine_only_blocked",
      instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
      interval: "5minute",
      readiness: { ok: false, reason: "insufficient_history", have: 180, need: 256 },
    });
    expect(deps.assembleEnvelope).not.toHaveBeenCalled();
  });

  it("persists the blocked result as the session's assistant turn so a reopen can replay it", async () => {
    const deps = gateDeps({ ok: false, reason: "kite_not_connected" });

    await runAnalysisRequest(deps as never, PARAMS);

    const assistant = deps.history.appendMessage.mock.calls.find((c) => c[0].role === "assistant");
    expect(assistant).toBeTruthy();
    expect(assistant![0].structuredPayload.mode).toBe("engine_only_blocked");
  });

  it("runs the warmed envelope and returns an ordinary engine_only result when the gate passes", async () => {
    const deps = gateDeps({ ok: true, warmed: { candles: [], requiredBars: 256 } });
    deps.assembleEnvelope = vi.fn().mockResolvedValue({
      trigger: "reactive",
      instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
      horizon_requested: "intraday",
      intent_lens: "buying",
      algo_results: [],
      confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
      overlays: {},
    });

    const result = await runAnalysisRequest(deps as never, PARAMS);

    expect(result.mode).toBe("engine_only");
    expect((result as { interval: string }).interval).toBe("5minute");
    expect(deps.assembleEnvelope).toHaveBeenCalledTimes(1);
  });

  it("returns the readiness gate's own warmed candles as initialCandles, without a second fetch", async () => {
    const warmedCandles: CandleWire[] = [{ ts: 1_758_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }];
    const deps = gateDeps({ ok: true, warmed: { candles: warmedCandles, requiredBars: 256 } });
    deps.assembleEnvelope = vi.fn().mockResolvedValue({
      trigger: "reactive",
      instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
      horizon_requested: "intraday",
      intent_lens: "buying",
      algo_results: [],
      confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
      overlays: {},
    });

    const result = await runAnalysisRequest(deps as never, PARAMS);

    expect(result.mode).toBe("engine_only");
    expect((result as { initialCandles: CandleWire[] }).initialCandles).toBe(warmedCandles);
  });

  it("leaves the user's message with no assistant reply when assembleEnvelope throws after the gate passes", async () => {
    const deps = gateDeps({ ok: true, warmed: { candles: [], requiredBars: 256 } });
    deps.assembleEnvelope = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(runAnalysisRequest(deps as never, PARAMS)).rejects.toThrow("boom");

    expect(deps.history.appendMessage).toHaveBeenCalledTimes(1);
    expect(deps.history.appendMessage).toHaveBeenCalledWith(expect.objectContaining({ role: "user" }));
  });

  it("warms the lake only ONCE for a full readiness-gate-then-analysis run, not once per stage", async () => {
    // Wires the REAL gate and REAL envelope assembler (not mocks), so this
    // actually proves the fix: without it, both stages call topUpCandles
    // independently and this doubles the Kite fetch and the lake read/write.
    const lastTs = Math.floor(new Date("2026-09-17T10:55:00+05:30").getTime() / 1000);
    let stored: CandleWire[] = [
      { ts: lastTs - 300, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { ts: lastTs, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ];
    const readLakeCandles = vi.fn(async () => ({ type: "lake_candles" as const, id: 1, candles: [...stored] }));
    const persistCandles = vi.fn(async (_s: string, _t: string, candles: CandleWire[]) => {
      stored = [...stored, ...candles].sort((a, b) => a.ts - b.ts);
      return { type: "persist_candles" as const, id: 1, written: candles.length };
    });
    const kite = {
      getHistoricalData: vi.fn().mockResolvedValue({
        data: { candles: [["2026-09-17T11:00:00+0530", 1, 2, 0.5, 1.5, 10]] },
      }),
    };
    const sidecar = {
      readLakeCandles,
      persistCandles,
      listAlgorithms: vi.fn().mockResolvedValue({
        type: "algorithms" as const,
        id: 1,
        algorithms: [{ id: "rsi", cost: "fast" as const, required_lookback: 3 }],
      }),
      compute: vi.fn().mockResolvedValue(computeResponse()),
    };

    const result = await runAnalysisRequest(
      {
        kite,
        sidecar,
        history: { appendMessage: vi.fn() },
        checkReadiness: checkEngineOnlyReadiness,
        assembleEnvelope: assembleWarmedEnvelope,
        kiteStatus: () => "authenticated" as const,
        now: () => new Date("2026-09-17T11:00:00+05:30"),
      } as never,
      PARAMS,
    );

    expect(result.mode).toBe("engine_only");
    expect(kite.getHistoricalData).toHaveBeenCalledTimes(1);
    expect(readLakeCandles).toHaveBeenCalledTimes(2);
    expect(persistCandles).toHaveBeenCalledTimes(1);
  });
});
