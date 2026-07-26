import { describe, expect, it } from "vitest";
import { generateDeterministicResponse } from "../../../../src/main/services/analysis/deterministicResponseGenerator";
import type { AnalysisEnvelope } from "../../../../src/main/services/analysis/contracts";
import type { AlgoResultWire, ConfluenceWire } from "../../../../src/main/services/sidecar/sidecarProtocol";

const IMPERATIVE = /\b(buy|sell|hold|add|reduce|book|exit|enter|watch)\b/i;

function algo(id: string, direction: string, magnitude: number, confidence: number): AlgoResultWire {
  return {
    algo_id: id,
    symbol: "NSE:INFY",
    timeframe: "day",
    horizon: "positional",
    direction,
    magnitude,
    confidence,
    evidence: [`${id} evidence`],
    computed_at: "2026-07-25T00:00:00+00:00",
  };
}

function envelope(algo_results: AlgoResultWire[], confluence: ConfluenceWire): AnalysisEnvelope {
  return {
    trigger: "reactive",
    instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
    horizon_requested: "positional",
    intent_lens: "buying",
    algo_results,
    confluence,
    overlays: {},
  };
}

describe("generateDeterministicResponse", () => {
  it("maps a bullish-heavy scorecard to bullish/high", () => {
    const env = envelope(
      [algo("rsi", "Bullish", 0.6, 0.71), algo("macd", "Bullish", 0.4, 0.6)],
      { bullish_count: 4, bearish_count: 1, neutral_count: 0, weighted_vote: 0.62 },
    );
    const out = generateDeterministicResponse(env);
    expect(out.direction).toBe("bullish");
    expect(out.conviction).toBe("high");
    expect(out.text).toContain("weighted vote +0.62");
  });

  it("maps a bearish-heavy scorecard to bearish", () => {
    const env = envelope([algo("rsi", "Bearish", 0.5, 0.7)], {
      bullish_count: 1,
      bearish_count: 4,
      neutral_count: 0,
      weighted_vote: -0.6,
    });
    expect(generateDeterministicResponse(env).direction).toBe("bearish");
  });

  it("treats a near-zero vote as neutral with low conviction", () => {
    const env = envelope([algo("rsi", "Neutral", 0.01, 0.5)], {
      bullish_count: 2,
      bearish_count: 2,
      neutral_count: 1,
      weighted_vote: 0.02,
    });
    const out = generateDeterministicResponse(env);
    expect(out.direction).toBe("neutral");
    expect(out.conviction).toBe("low");
  });

  it("handles an empty envelope without throwing", () => {
    const out = generateDeterministicResponse(
      envelope([], { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 }),
    );
    expect(out.direction).toBe("neutral");
    expect(out.conviction).toBe("low");
    expect(out.text.length).toBeGreaterThan(0);
  });

  it("normalizes wire casing and cites algorithms by id", () => {
    const env = envelope([algo("rsi", "Bullish", 0.6, 0.71)], {
      bullish_count: 1,
      bearish_count: 0,
      neutral_count: 0,
      weighted_vote: 1,
    });
    const out = generateDeterministicResponse(env);
    expect(out.text).toContain("rsi reads a bullish signal");
    expect(out.text).not.toContain("Bullish");
  });

  it("cites more algorithms in full than concise", () => {
    const algos = [
      algo("a", "Bullish", 0.9, 0.9),
      algo("b", "Bullish", 0.8, 0.8),
      algo("c", "Bearish", 0.7, 0.7),
      algo("d", "Neutral", 0.6, 0.6),
      algo("e", "Bullish", 0.5, 0.5),
    ];
    const env = envelope(algos, { bullish_count: 3, bearish_count: 1, neutral_count: 1, weighted_vote: 0.3 });
    const concise = generateDeterministicResponse(env, { variant: "concise" }).text.split("\n").length;
    const full = generateDeterministicResponse(env, { variant: "full" }).text.split("\n").length;
    expect(full).toBeGreaterThan(concise);
  });

  it("never emits an imperative trade directive", () => {
    const cases = [
      envelope([algo("rsi", "Bullish", 0.6, 0.7)], { bullish_count: 5, bearish_count: 0, neutral_count: 0, weighted_vote: 0.9 }),
      envelope([algo("rsi", "Bearish", 0.6, 0.7)], { bullish_count: 0, bearish_count: 5, neutral_count: 0, weighted_vote: -0.9 }),
      envelope([algo("rsi", "Neutral", 0.0, 0.5)], { bullish_count: 2, bearish_count: 2, neutral_count: 1, weighted_vote: 0 }),
    ];
    for (const env of cases) {
      expect(generateDeterministicResponse(env, { variant: "full" }).text).not.toMatch(IMPERATIVE);
    }
  });
});
