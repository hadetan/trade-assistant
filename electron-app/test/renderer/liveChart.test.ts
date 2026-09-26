// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createLiveChart } from "../../src/renderer/liveChart";

vi.mock("lightweight-charts", () => {
  const seriesUpdate = vi.fn();
  const seriesSetData = vi.fn();
  const addSeries = vi.fn(() => ({ update: seriesUpdate, setData: seriesSetData, priceLineVisible: undefined }));
  const chartRemove = vi.fn();
  const createChart = vi.fn(() => ({ addSeries, remove: chartRemove }));
  return { createChart, CandlestickSeries: "CandlestickSeries", __seriesUpdate: seriesUpdate, __seriesSetData: seriesSetData, __chartRemove: chartRemove };
});

describe("createLiveChart", () => {
  it("loads initial candles via setData", async () => {
    const { __seriesSetData } = (await import("lightweight-charts")) as unknown as { __seriesSetData: ReturnType<typeof vi.fn> };
    const container = document.createElement("div");
    const initial = [{ ts: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }];

    createLiveChart(container, initial);

    expect(__seriesSetData).toHaveBeenCalledWith([
      expect.objectContaining({ time: 1000, open: 1, high: 2, low: 0.5, close: 1.5 }),
    ]);
  });

  it("applyTick() calls series.update() with the forming bar's running OHLC", async () => {
    const { __seriesUpdate } = (await import("lightweight-charts")) as unknown as { __seriesUpdate: ReturnType<typeof vi.fn> };
    const container = document.createElement("div");
    const handle = createLiveChart(container, []);

    handle.applyTick({ ts: 1000, price: 100 }, 300); // 300 = interval in seconds (5 min)
    handle.applyTick({ ts: 1010, price: 105 }, 300);

    expect(__seriesUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ time: 1000, open: 100, high: 105, low: 100, close: 105 }));
  });

  it("applyClosedCandle() calls series.update() with the finished candle", async () => {
    const { __seriesUpdate } = (await import("lightweight-charts")) as unknown as { __seriesUpdate: ReturnType<typeof vi.fn> };
    const container = document.createElement("div");
    const handle = createLiveChart(container, []);

    handle.applyClosedCandle({ ts: 1000, open: 100, high: 106, low: 99, close: 101 });

    expect(__seriesUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ time: 1000, open: 100, high: 106, low: 99, close: 101 }));
  });

  it("dispose() removes the chart", async () => {
    const { __chartRemove } = (await import("lightweight-charts")) as unknown as { __chartRemove: ReturnType<typeof vi.fn> };
    const container = document.createElement("div");
    const handle = createLiveChart(container, []);

    handle.dispose();

    expect(__chartRemove).toHaveBeenCalledTimes(1);
  });
});
