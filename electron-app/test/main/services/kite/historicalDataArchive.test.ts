import { describe, expect, it, vi } from "vitest";
import { fetchAndArchive, parseKiteCandles } from "../../../../src/main/services/kite/historicalDataArchive";
import { KiteClient } from "../../../../src/main/services/kite/kiteClient";
import type { CandleWire } from "../../../../src/main/services/sidecar/sidecarProtocol";

describe("parseKiteCandles", () => {
  it("parses the +0530 offset timestamp offset-aware into epoch seconds", () => {
    const candles = parseKiteCandles([["2026-01-02T09:15:00+0530", 100, 105, 99, 104, 5000]]);
    // 2026-01-02T09:15:00+0530 == 2026-01-02T03:45:00Z == 1767325500 epoch seconds.
    expect(candles[0].ts).toBe(1767325500);
    expect(candles[0].close).toBe(104);
    expect(candles[0].volume).toBe(5000);
  });
});

describe("fetchAndArchive", () => {
  it("persists every fetched candle and returns the closes", async () => {
    const callTool = vi.fn().mockResolvedValue({
      data: {
        candles: [
          ["2026-01-02T00:00:00+0530", 100, 105, 99, 104, 5000],
          ["2026-01-03T00:00:00+0530", 104, 108, 103, 107, 6000],
        ],
      },
    });
    const kite = new KiteClient({ callTool });

    const persisted: CandleWire[] = [];
    const sidecar = {
      persistCandles: vi.fn(async (_symbol: string, _tf: string, candles: CandleWire[]) => {
        persisted.push(...candles);
        return { type: "persist_candles" as const, id: 1, written: candles.length };
      }),
    };

    const result = await fetchAndArchive(
      { kite, sidecar: sidecar as never },
      { symbol: "NSE:INFY", instrumentToken: "408065", timeframe: "day", from: "2026-01-01", to: "2026-01-03" },
    );

    expect(result.candles.length).toBe(2);
    expect(result.persisted).toBe(2);
    expect(persisted.length).toBe(2);
    expect(result.closes).toEqual([104, 107]);
    expect(sidecar.persistCandles).toHaveBeenCalledWith("NSE:INFY", "day", result.candles, "kite");
  });

  it("throws when the sidecar reports a persist error instead of returning a false success", async () => {
    const callTool = vi.fn().mockResolvedValue({
      data: { candles: [["2026-01-02T00:00:00+0530", 100, 105, 99, 104, 5000]] },
    });
    const kite = new KiteClient({ callTool });
    const sidecar = {
      persistCandles: vi.fn(async () => ({
        type: "persist_candles" as const,
        id: 1,
        written: 0,
        error: "disk full",
      })),
    };

    await expect(
      fetchAndArchive(
        { kite, sidecar: sidecar as never },
        { symbol: "NSE:INFY", instrumentToken: "408065", timeframe: "day", from: "2026-01-01", to: "2026-01-03" },
      ),
    ).rejects.toThrow(/archiving NSE:INFY day failed: disk full/);
  });
});
