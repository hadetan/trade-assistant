import { vi } from "vitest";
import type { RendererApi } from "../../src/main/ipc/rendererApi";

export function installBridge(overrides: Partial<RendererApi> = {}): RendererApi {
  const bridge: RendererApi = {
    getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "needsLogin" }),
    onBanner: vi.fn(),
    onTrace: vi.fn(),
    login: vi.fn().mockResolvedValue({ status: "authenticated" }),
    searchInstruments: vi.fn().mockResolvedValue({ data: [] }),
    runAnalysis: vi.fn(),
    checkReadiness: vi.fn().mockResolvedValue({ ok: true }),
    createSession: vi.fn().mockResolvedValue({
      id: "session-1",
      response_mode: "engine_only",
      created_at: "2026-07-27T00:00:00.000Z",
      last_active_at: "2026-07-27T00:00:00.000Z",
      preview: "(no messages yet)",
    }),
    listSessions: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockResolvedValue({ id: "session-1", response_mode: "engine_only", messages: [] }),
    listLakeSymbols: vi.fn().mockResolvedValue([]),
    listAlgorithms: vi.fn().mockResolvedValue([]),
    runBenchmark: vi.fn().mockResolvedValue({
      params: {
        symbol: "NSE:INFY",
        timeframe: "day",
        source: "bhavcopy",
        horizon: "positional",
        algoId: "sma",
        lookaheadBars: 5,
        fromTs: 0,
        toTs: 0,
      },
      candles: [],
      decisionPoints: [],
      cancelled: false,
    }),
    cancelBenchmark: vi.fn().mockResolvedValue(undefined),
    onBenchmarkProgress: vi.fn(),
    copyBenchmarkResult: vi.fn().mockResolvedValue(undefined),
    startLiveSession: vi.fn().mockResolvedValue(undefined),
    stopLiveSession: vi.fn().mockResolvedValue(undefined),
    // These three hand back an unsubscribe function (see RendererApi); a bare
    // vi.fn() returning undefined would blow up in LiveSessionView's cleanup.
    onLiveTick: vi.fn(() => vi.fn()),
    onLiveCandleClose: vi.fn(() => vi.fn()),
    onLiveStatus: vi.fn(() => vi.fn()),
    ...overrides,
  };
  (window as unknown as { tradeAssistant: RendererApi }).tradeAssistant = bridge;
  return bridge;
}
