// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const { createSeriesMarkers, remove, addSeries, subscribeClick } = vi.hoisted(() => ({
  createSeriesMarkers: vi.fn(() => ({ setMarkers: vi.fn() })),
  remove: vi.fn(),
  addSeries: vi.fn(() => ({ setData: vi.fn() })),
  subscribeClick: vi.fn(),
}));

vi.mock("lightweight-charts", () => ({
  createChart: vi.fn(() => ({ addSeries, subscribeClick, remove })),
  CandlestickSeries: "Candlestick",
  HistogramSeries: "Histogram",
  createSeriesMarkers,
}));

import { createBenchmarkChart } from "../../src/renderer/benchmarkChart";
import type { BenchmarkResult } from "../../src/main/ipc/rendererApi";

function resultWith(outcomes: Array<BenchmarkResult["decisionPoints"][number]["outcome"]>): BenchmarkResult {
  return {
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
    candles: [{ ts: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }],
    cancelled: false,
    decisionPoints: outcomes.map((outcome, i) => ({
      frontierIndex: i,
      ts: i + 1,
      closeAtFrontier: 1,
      closeAtLookahead: 1,
      realizedReturn: 0,
      direction: outcome === "incorrect" ? "bearish" : "bullish",
      conviction: "medium",
      responseText: "",
      algoResults: [],
      confluence: { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 },
      outcome,
    })),
  };
}

function containerWithTokens(): HTMLElement {
  const container = document.createElement("div");
  container.style.setProperty("--bullish", "#16a34a");
  container.style.setProperty("--bearish", "#dc2626");
  container.style.setProperty("--neutral", "#6b7280");
  document.body.appendChild(container);
  return container;
}

describe("createBenchmarkChart", () => {
  it("reads each marker's color from the container's --bullish/--bearish/--neutral custom properties", () => {
    createSeriesMarkers.mockClear();
    const container = containerWithTokens();
    createBenchmarkChart(container, resultWith(["correct", "incorrect", "neutral"]), () => {});
    const markers = createSeriesMarkers.mock.calls[0][1] as Array<{ color: string }>;
    expect(markers).toHaveLength(3);
    expect(markers.map((m) => m.color)).toEqual(["#16a34a", "#dc2626", "#6b7280"]);
  });

  it("dispose() removes the chart", () => {
    remove.mockClear();
    const container = containerWithTokens();
    const handle = createBenchmarkChart(container, resultWith([]), () => {});
    handle.dispose();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("recolors already-created markers when data-theme changes anywhere in the document", async () => {
    const setMarkers = vi.fn();
    createSeriesMarkers.mockReturnValueOnce({ setMarkers });
    const container = containerWithTokens();
    createBenchmarkChart(container, resultWith(["correct"]), () => {});

    container.style.setProperty("--bullish", "#000000");
    container.setAttribute("data-theme", "light");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setMarkers).toHaveBeenCalled();
    const updated = setMarkers.mock.calls[setMarkers.mock.calls.length - 1][0] as Array<{ color: string }>;
    expect(updated[0].color).toBe("#000000");
  });

  it("dispose() stops watching for further theme changes", async () => {
    const setMarkers = vi.fn();
    createSeriesMarkers.mockReturnValueOnce({ setMarkers });
    const container = containerWithTokens();
    const handle = createBenchmarkChart(container, resultWith(["correct"]), () => {});
    handle.dispose();

    container.setAttribute("data-theme", "light");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setMarkers).not.toHaveBeenCalled();
  });
});
