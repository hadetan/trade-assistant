import { vi } from "vitest";
import type { RendererApi } from "../../src/main/ipc/rendererApi";

export function installBridge(overrides: Partial<RendererApi> = {}): RendererApi {
  const bridge: RendererApi = {
    getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "needsLogin", driftWarning: null }),
    onBanner: vi.fn(),
    onNarrative: vi.fn(),
    login: vi.fn().mockResolvedValue({ status: "authenticated" }),
    searchInstruments: vi.fn().mockResolvedValue({ data: [] }),
    runAnalysis: vi.fn(),
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
    runBenchmark: vi.fn().mockResolvedValue({
      params: {
        symbol: "NSE:INFY",
        timeframe: "day",
        source: "bhavcopy",
        horizon: "positional",
        cadence: { mode: "session_close" },
        lookaheadBars: 5,
        fromTs: 0,
        toTs: 0,
      },
      candles: [],
      decisionPoints: [],
    }),
    copyBenchmarkResult: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  (window as unknown as { tradeAssistant: RendererApi }).tradeAssistant = bridge;
  return bridge;
}
