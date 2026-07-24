import { describe, expect, it, vi } from "vitest";
import { assembleEnvelope } from "../../../../src/main/services/analysis/analysisEnvelope";
import { KiteClient } from "../../../../src/main/services/kite/kiteClient";
import type { CandleWire } from "../../../../src/main/services/sidecar/sidecarProtocol";

function historicalResponse() {
  return {
    data: {
      candles: [
        ["2026-01-02T00:00:00+0530", 100, 105, 99, 104, 5000],
        ["2026-01-03T00:00:00+0530", 104, 108, 103, 107, 6000],
      ],
    },
  };
}

function computeResponse() {
  return {
    type: "compute" as const,
    id: 1,
    algo_results: [
      {
        algo_id: "rsi",
        symbol: "NSE:INFY",
        timeframe: "day",
        horizon: "positional",
        direction: "Bullish",
        magnitude: 0.4,
        confidence: 0.6,
        evidence: ["RSI 62"],
        computed_at: "2026-07-24T00:00:00+00:00",
      },
    ],
    confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
  };
}

describe("assembleEnvelope", () => {
  it("assembles the widened algo_results, confluence, and request metadata", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const sidecar = {
      persistCandles: vi.fn(async (_s: string, _t: string, candles: CandleWire[]) => ({
        type: "persist_candles" as const,
        id: 1,
        written: candles.length,
      })),
      compute: vi.fn(async () => computeResponse()),
    };

    const envelope = await assembleEnvelope(
      { kite, sidecar: sidecar as never },
      {
        trigger: "reactive",
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        timeframe: "day",
        horizon_requested: "positional",
        intent_lens: "buying",
        from: "2026-01-01",
        to: "2026-01-03",
      },
    );

    expect(envelope.trigger).toBe("reactive");
    expect(envelope.instrument.kite_token_asof).toBe("408065");
    expect(envelope.horizon_requested).toBe("positional");
    expect(envelope.intent_lens).toBe("buying");
    expect(envelope.algo_results[0].algo_id).toBe("rsi");
    expect(envelope.algo_results[0].symbol).toBe("NSE:INFY");
    expect(envelope.confluence.weighted_vote).toBe(1);
    expect(envelope.overlays).toEqual({});
    expect(sidecar.compute).toHaveBeenCalledWith("NSE:INFY", "day", [104, 107]);
  });

  it("propagates a persist failure (P4§5.2) instead of returning a false envelope", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const sidecar = {
      persistCandles: vi.fn(async () => ({ type: "persist_candles" as const, id: 1, written: 0, error: "disk full" })),
      compute: vi.fn(async () => computeResponse()),
    };

    await expect(
      assembleEnvelope(
        { kite, sidecar: sidecar as never },
        {
          trigger: "reactive",
          instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
          timeframe: "day",
          horizon_requested: "positional",
          intent_lens: "buying",
          from: "2026-01-01",
          to: "2026-01-03",
        },
      ),
    ).rejects.toThrow(/archiving NSE:INFY day failed: disk full/);
    expect(sidecar.compute).not.toHaveBeenCalled();
  });
});
