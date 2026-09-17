import { describe, expect, it, vi } from "vitest";
import { topUpCandles, WARMUP_SOURCE } from "../../../../src/main/services/market/candleWarmup";
import type { CandleWire } from "../../../../src/main/services/sidecar/sidecarProtocol";

const NOW = new Date("2026-09-17T14:00:00+05:30");

function kiteReturning(rows: [string, number, number, number, number, number][]) {
  return { getHistoricalData: vi.fn().mockResolvedValue({ data: { candles: rows } }) };
}

function sidecarWithLake(existing: CandleWire[]) {
  const stored = [...existing];
  return {
    readLakeCandles: vi.fn(async () => ({ type: "lake_candles" as const, id: 1, candles: [...stored] })),
    persistCandles: vi.fn(async (_s: string, _t: string, candles: CandleWire[]) => {
      for (const candle of candles) {
        const at = stored.findIndex((c) => c.ts === candle.ts);
        if (at === -1) stored.push(candle);
        else stored[at] = candle;
      }
      stored.sort((a, b) => a.ts - b.ts);
      return { type: "persist_candles" as const, id: 1, written: candles.length };
    }),
  };
}

const params = {
  symbol: "NSE:INFY",
  instrumentToken: "408065",
  interval: "5minute" as const,
  requiredBars: 512,
  now: NOW,
};

describe("topUpCandles", () => {
  it("issues one sized bulk backfill when the lake partition is empty", async () => {
    const kite = kiteReturning([["2026-09-17T09:15:00+0530", 1, 2, 0.5, 1.5, 10]]);
    const sidecar = sidecarWithLake([]);

    const result = await topUpCandles({ kite, sidecar }, params);

    expect(kite.getHistoricalData).toHaveBeenCalledTimes(1);
    const call = kite.getHistoricalData.mock.calls[0][0] as { from: string; to: string; interval: string };
    expect(call.interval).toBe("5minute");
    // calendarDaysForBackfill("5minute", 512) === 15 -> 2026-09-02.
    expect(call.from).toBe("2026-09-02 14:00:00");
    expect(call.to).toBe("2026-09-17 14:00:00");
    expect(result.backfilled).toBe(true);
    expect(result.fetched).toBe(1);
  });

  it("fetches only the delta since the lake's last stored candle on a subsequent top-up", async () => {
    const lastTs = Math.floor(new Date("2026-09-17T13:30:00+05:30").getTime() / 1000);
    const kite = kiteReturning([["2026-09-17T13:35:00+0530", 1, 2, 0.5, 1.5, 10]]);
    const sidecar = sidecarWithLake([{ ts: lastTs, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);

    const result = await topUpCandles({ kite, sidecar }, params);

    const call = kite.getHistoricalData.mock.calls[0][0] as { from: string; to: string };
    expect(call.from).toBe("2026-09-17 13:30:00");
    expect(call.to).toBe("2026-09-17 14:00:00");
    expect(result.backfilled).toBe(false);
  });

  it("persists into the interval's own partition under the kite source", async () => {
    const kite = kiteReturning([["2026-09-17T09:15:00+0530", 1, 2, 0.5, 1.5, 10]]);
    const sidecar = sidecarWithLake([]);

    await topUpCandles({ kite, sidecar }, { ...params, interval: "15minute" });

    expect(sidecar.persistCandles).toHaveBeenCalledWith("NSE:INFY", "15minute", expect.any(Array), WARMUP_SOURCE);
    expect(sidecar.readLakeCandles).toHaveBeenCalledWith("NSE:INFY", "15minute", WARMUP_SOURCE);
  });

  it("returns the merged lake contents, not just what this call fetched", async () => {
    const oldTs = Math.floor(new Date("2026-09-17T09:15:00+05:30").getTime() / 1000);
    const kite = kiteReturning([["2026-09-17T13:35:00+0530", 1, 2, 0.5, 1.5, 10]]);
    const sidecar = sidecarWithLake([{ ts: oldTs, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);

    const result = await topUpCandles({ kite, sidecar }, params);

    expect(result.candles).toHaveLength(2);
    expect(result.candles[0].ts).toBe(oldTs);
  });

  it("skips the Kite call entirely when the lake is already current, instead of re-fetching a zero-width window", async () => {
    const lastTs = Math.floor(NOW.getTime() / 1000);
    const kite = kiteReturning([]);
    const sidecar = sidecarWithLake([{ ts: lastTs, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);

    const result = await topUpCandles({ kite, sidecar }, params);

    expect(kite.getHistoricalData).not.toHaveBeenCalled();
    expect(sidecar.persistCandles).not.toHaveBeenCalled();
    expect(result.fetched).toBe(0);
    expect(result.candles).toHaveLength(1);
  });

  it("propagates a persist failure instead of reporting a warm lake that was never written", async () => {
    const kite = kiteReturning([["2026-09-17T09:15:00+0530", 1, 2, 0.5, 1.5, 10]]);
    const sidecar = {
      readLakeCandles: vi.fn(async () => ({ type: "lake_candles" as const, id: 1, candles: [] })),
      persistCandles: vi.fn(async () => ({ type: "persist_candles" as const, id: 1, written: 0, error: "disk full" })),
    };

    await expect(topUpCandles({ kite, sidecar }, params)).rejects.toThrow(
      /warming NSE:INFY 5minute failed: disk full/,
    );
  });
});
