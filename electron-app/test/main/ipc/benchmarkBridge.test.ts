import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));

import { registerBenchmarkBridge } from "../../../src/main/ipc/benchmarkBridge";

function harness(sidecar: {
  listLakeSymbols: ReturnType<typeof vi.fn>;
  listAlgorithms: ReturnType<typeof vi.fn>;
  readLakeCandles: ReturnType<typeof vi.fn>;
  benchmarkCompute: ReturnType<typeof vi.fn>;
  evaluateScanGateStateless: ReturnType<typeof vi.fn>;
  cancelCurrent: ReturnType<typeof vi.fn>;
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
    listAlgorithms: vi.fn(),
    readLakeCandles: vi.fn(),
    benchmarkCompute: vi.fn(),
    evaluateScanGateStateless: vi.fn(),
    cancelCurrent: vi.fn(),
  };
}

function fakeEvent() {
  return { sender: { send: vi.fn() } };
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
    const entries = (await handlers.get("benchmark:listLakeSymbols")!(fakeEvent(), undefined)) as Array<Record<string, unknown>>;
    expect(entries[0]).toEqual({ symbol: "NSE:INFY", timeframe: "day", source: "bhavcopy", fromTs: 100, toTs: 200, candleCount: 3, horizon: "positional" });
    expect(entries[1].horizon).toBe("intraday");
  });

  it("maps the algorithms wire response to AlgorithmEntry", async () => {
    const sidecar = idleSidecar();
    sidecar.listAlgorithms.mockResolvedValue({
      type: "algorithms",
      id: 1,
      algorithms: [
        { id: "sma", cost: "fast" },
        { id: "kronos", cost: "slow" },
      ],
    });
    const handlers = harness(sidecar);
    const entries = await handlers.get("benchmark:listAlgorithms")!(fakeEvent(), undefined);
    expect(entries).toEqual([
      { id: "sma", cost: "fast" },
      { id: "kronos", cost: "slow" },
    ]);
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
      algoId: "sma",
      lookaheadBars: 5,
      fromTs: 0,
      toTs: 1e12,
    };
    const result = (await handlers.get("benchmark:runBenchmark")!(fakeEvent(), params)) as { params: unknown; decisionPoints: unknown[] };
    expect(sidecar.readLakeCandles).toHaveBeenCalledWith("NSE:INFY", "day", "bhavcopy");
    expect(result.params).toEqual(params);
    expect(result.decisionPoints).toHaveLength(0);
  });

  it("forwards per-bar progress to the requesting window via event.sender.send on benchmark:progress", async () => {
    const sidecar = idleSidecar();
    sidecar.readLakeCandles.mockResolvedValue({
      type: "lake_candles",
      id: 1,
      candles: [
        { ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { ts: 2, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      ],
    });
    sidecar.benchmarkCompute.mockResolvedValue({
      type: "benchmark_compute",
      id: 1,
      algo_results: [],
      confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
    });
    const handlers = harness(sidecar);
    const event = fakeEvent();
    const params = {
      symbol: "NSE:INFY",
      timeframe: "day",
      source: "bhavcopy",
      horizon: "positional",
      algoId: "sma",
      lookaheadBars: 0,
      fromTs: 0,
      toTs: 1e12,
    };
    await handlers.get("benchmark:runBenchmark")!(event, params);
    // series has 2 bars, lookaheadBars=0 -> eligible i in {0} only.
    expect(event.sender.send).toHaveBeenCalledWith("benchmark:progress", { index: 0, total: 2 });
  });

  it("calls cancelCurrent on the sidecar", async () => {
    const sidecar = idleSidecar();
    const handlers = harness(sidecar);
    await handlers.get("benchmark:cancelBenchmark")!(fakeEvent(), undefined);
    expect(sidecar.cancelCurrent).toHaveBeenCalledTimes(1);
  });

  it("writes the copy-raw text to the clipboard", async () => {
    const { clipboard } = await import("electron");
    const handlers = harness(idleSidecar());
    await handlers.get("benchmark:copyToClipboard")!(fakeEvent(), "raw-json-blob");
    expect(clipboard.writeText).toHaveBeenCalledWith("raw-json-blob");
  });
});
