import { describe, expect, it } from "vitest";
import {
  classifyDecision,
  defaultCadenceForHorizon,
  defaultLookaheadForHorizon,
  horizonForTimeframe,
  summarize,
  NEUTRAL_BAND,
} from "../../../../src/main/services/benchmark/benchmarkRunner";
import type { DecisionPoint } from "../../../../src/main/services/benchmark/benchmarkRunner";

function point(outcome: DecisionPoint["outcome"]): DecisionPoint {
  return {
    frontierIndex: 0,
    ts: 0,
    closeAtFrontier: 1,
    closeAtLookahead: 1,
    realizedReturn: 0,
    direction: "bullish",
    conviction: "low",
    responseText: "",
    algoResults: [],
    confluence: { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 },
    outcome,
  };
}

describe("horizon / cadence / lookahead derivation", () => {
  it("derives positional only for the day timeframe, intraday for everything else", () => {
    expect(horizonForTimeframe("day")).toBe("positional");
    expect(horizonForTimeframe("minute")).toBe("intraday");
    expect(horizonForTimeframe("5minute")).toBe("intraday");
    expect(horizonForTimeframe("15minute")).toBe("intraday");
  });

  it("binds cadence to horizon", () => {
    expect(defaultCadenceForHorizon("positional")).toEqual({ mode: "session_close" });
    expect(defaultCadenceForHorizon("intraday")).toEqual({ mode: "stateless_gate" });
  });

  it("binds lookahead defaults to horizon", () => {
    expect(defaultLookaheadForHorizon("positional")).toBe(5);
    expect(defaultLookaheadForHorizon("intraday")).toBe(30);
  });
});

describe("classifyDecision (TS mirror of algo_core::benchmark_classify)", () => {
  it("scores a directional call by the sign of the realized return", () => {
    expect(classifyDecision("bullish", 0.05)).toBe("correct");
    expect(classifyDecision("bullish", -0.05)).toBe("incorrect");
    expect(classifyDecision("bearish", -0.05)).toBe("correct");
  });

  it("scores a neutral call neutral regardless of magnitude", () => {
    expect(classifyDecision("neutral", 0.42)).toBe("neutral");
    expect(classifyDecision("neutral", -0.42)).toBe("neutral");
  });

  it("scores a within-band or band-edge directional call neutral (inclusive)", () => {
    expect(classifyDecision("bullish", 0.0005)).toBe("neutral");
    expect(classifyDecision("bullish", NEUTRAL_BAND)).toBe("neutral");
  });
});

describe("summarize", () => {
  it("counts each outcome and excludes neutral from the hit-rate", () => {
    const result = summarize([point("correct"), point("correct"), point("incorrect"), point("neutral")]);
    expect(result).toEqual({ correct: 2, incorrect: 1, neutral: 1, hitRate: 2 / 3 });
  });

  it("returns a null hit-rate when there are zero directional outcomes", () => {
    expect(summarize([]).hitRate).toBeNull();
    expect(summarize([point("neutral"), point("neutral")]).hitRate).toBeNull();
  });
});
