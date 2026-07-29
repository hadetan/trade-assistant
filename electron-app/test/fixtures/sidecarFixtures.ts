import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { CandleWire } from "../../src/main/services/sidecar/sidecarProtocol";

export function historicalResponse() {
  return {
    data: {
      candles: [
        ["2026-01-02T00:00:00+0530", 100, 105, 99, 104, 5000],
        ["2026-01-03T00:00:00+0530", 104, 108, 103, 107, 6000],
      ],
    },
  };
}

export function computeResponse() {
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

export function mockSidecar() {
  const bus = new EventEmitter();
  return Object.assign(bus, {
    persistCandles: vi.fn(async (_s: string, _t: string, candles: CandleWire[]) => ({
      type: "persist_candles" as const,
      id: 1,
      written: candles.length,
    })),
    compute: vi.fn(async () => computeResponse()),
  });
}
