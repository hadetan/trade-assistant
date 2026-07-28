import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));

import { registerBenchmarkBridge } from "../../../src/main/ipc/benchmarkBridge";

function harness(sidecar: {
  listLakeSymbols: ReturnType<typeof vi.fn>;
  readLakeCandles: ReturnType<typeof vi.fn>;
  benchmarkCompute: ReturnType<typeof vi.fn>;
  evaluateScanGateStateless: ReturnType<typeof vi.fn>;
}) {
  const handlers = new Map<string, (event: unknown, arg: unknown) => unknown>();
  registerBenchmarkBridge({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn as never) } as never,
    sidecar: sidecar as never,
  });
  return handlers;
}

function idleSidecar() {
  return {
    listLakeSymbols: vi.fn(),
    readLakeCandles: vi.fn(),
    benchmarkCompute: vi.fn(),
    evaluateScanGateStateless: vi.fn(),
  };
}

describe("registerBenchmarkBridge", () => {
  it("maps the snake_case wire to the camelCase app type and attaches the derived horizon", async () => {
    const sidecar = idleSidecar();
    sidecar.listLakeSymbols.mockResolvedValue({
      type: "lake_symbols",
      id: 1,
      entries: [
        { symbol: "NSE:INFY", timeframe: "day", source: "bhavcopy", from_ts: 100, to_ts: 200, candle_count: 3 },
        { symbol: "NSE:BANKNIFTY", timeframe: "minute", source: "kaggle", from_ts: 10, to_ts: 20, candle_count: 5 },
      ],
    });
    const handlers = harness(sidecar);
    const entries = (await handlers.get("benchmark:listLakeSymbols")!(null, undefined)) as Array<Record<string, unknown>>;
    expect(entries[0]).toEqual({ symbol: "NSE:INFY", timeframe: "day", source: "bhavcopy", fromTs: 100, toTs: 200, candleCount: 3, horizon: "positional" });
    expect(entries[1].horizon).toBe("intraday");
  });

  it("forwards params to runBenchmark with the injected sidecar and returns its BenchmarkResult", async () => {
    const sidecar = idleSidecar();
    // runBenchmark reads the lake first; an empty read yields an empty walk.
    sidecar.readLakeCandles.mockResolvedValue({ type: "lake_candles", id: 1, candles: [] });
    const handlers = harness(sidecar);
    const params = {
      symbol: "NSE:INFY",
      timeframe: "day",
      source: "bhavcopy",
      horizon: "positional",
      cadence: { mode: "session_close" },
      lookaheadBars: 5,
      fromTs: 0,
      toTs: 1e12,
    };
    const result = (await handlers.get("benchmark:runBenchmark")!({}, params)) as { params: unknown; decisionPoints: unknown[] };
    expect(sidecar.readLakeCandles).toHaveBeenCalledWith("NSE:INFY", "day", "bhavcopy");
    expect(result.params).toEqual(params);
    expect(result.decisionPoints).toHaveLength(0);
  });

  it("writes the copy-raw text to the clipboard", async () => {
    const { clipboard } = await import("electron");
    const handlers = harness(idleSidecar());
    await handlers.get("benchmark:copyToClipboard")!({}, "raw-json-blob");
    expect(clipboard.writeText).toHaveBeenCalledWith("raw-json-blob");
  });
});
