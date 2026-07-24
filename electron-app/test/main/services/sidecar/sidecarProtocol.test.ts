import { describe, expect, it } from "vitest";
import type { ComputeResponseWire } from "../../../../src/main/services/sidecar/sidecarProtocol";

describe("ComputeResponseWire (widened AlgoResultWire)", () => {
  it("decodes all nine AlgoOutput fields from a sidecar compute line", () => {
    const line = JSON.stringify({
      type: "compute",
      id: 7,
      algo_results: [
        {
          algo_id: "rsi",
          symbol: "NSE:INFY",
          timeframe: "day",
          horizon: "positional",
          direction: "Bullish",
          magnitude: 0.42,
          confidence: 0.61,
          evidence: ["RSI 62 > 50"],
          computed_at: "2026-07-24T00:00:00+00:00",
        },
      ],
      confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
    });

    const decoded = JSON.parse(line) as ComputeResponseWire;
    const first = decoded.algo_results[0];

    expect(first.algo_id).toBe("rsi");
    expect(first.symbol).toBe("NSE:INFY");
    expect(first.timeframe).toBe("day");
    expect(first.horizon).toBe("positional");
    expect(first.direction).toBe("Bullish");
    expect(first.magnitude).toBe(0.42);
    expect(first.confidence).toBe(0.61);
    expect(first.evidence).toEqual(["RSI 62 > 50"]);
    expect(first.computed_at).toBe("2026-07-24T00:00:00+00:00");
  });
});
