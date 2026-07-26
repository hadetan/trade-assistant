import { describe, expect, it } from "vitest";
import {
  personaFindingSchema,
  verdictSchema,
  personaFindingJsonSchema,
  verdictJsonSchema,
  citedIdsWithinEnvelope,
  type AnalysisEnvelope,
} from "../../../../src/main/services/analysis/contracts";
import { intakeResultSchema, intakeResultJsonSchema } from "../../../../src/main/services/analysis/contracts";

const envelope: AnalysisEnvelope = {
  trigger: "reactive",
  instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
  horizon_requested: "positional",
  intent_lens: "buying",
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
  overlays: {},
};

describe("contracts schemas", () => {
  it("accepts a well-formed PersonaFinding", () => {
    const result = personaFindingSchema.safeParse({
      persona: "technical_quant",
      direction: "bullish",
      conviction: "high",
      findings: ["rsi above 50"],
      cited_algo_ids: ["rsi"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an imperative direction on a PersonaFinding", () => {
    const result = personaFindingSchema.safeParse({
      persona: "technical_quant",
      direction: "buy",
      conviction: "high",
      findings: ["rsi above 50"],
      cited_algo_ids: ["rsi"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an imperative direction on a Verdict", () => {
    const result = verdictSchema.safeParse({
      direction: "sell",
      conviction: "low",
      reasoning: "x",
      cited_algo_ids: ["rsi"],
      verify_before_acting: "check LTP",
    });
    expect(result.success).toBe(false);
  });

  it("exposes closed direction enums in the JSON-schema objects", () => {
    expect((personaFindingJsonSchema.properties.direction as { enum: string[] }).enum).toEqual([
      "bullish",
      "bearish",
      "neutral",
    ]);
    expect((verdictJsonSchema.properties.direction as { enum: string[] }).enum).toEqual([
      "bullish",
      "bearish",
      "neutral",
    ]);
  });

  it("rejects a PersonaFinding citing zero algo_ids", () => {
    const result = personaFindingSchema.safeParse({
      persona: "technical_quant",
      direction: "bullish",
      conviction: "high",
      findings: ["rsi above 50"],
      cited_algo_ids: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a Verdict citing zero algo_ids", () => {
    const result = verdictSchema.safeParse({
      direction: "bullish",
      conviction: "high",
      reasoning: "x",
      cited_algo_ids: [],
      verify_before_acting: "check LTP",
    });
    expect(result.success).toBe(false);
  });

  it("requires at least one cited algo_id in the JSON-schema objects", () => {
    expect((personaFindingJsonSchema.properties.cited_algo_ids as { minItems: number }).minItems).toBe(1);
    expect((verdictJsonSchema.properties.cited_algo_ids as { minItems: number }).minItems).toBe(1);
  });

  it("checks cited ids are a subset of the envelope's algo ids", () => {
    expect(citedIdsWithinEnvelope(["rsi"], envelope)).toBe(true);
    expect(citedIdsWithinEnvelope(["rsi", "made_up"], envelope)).toBe(false);
  });
});

describe("IntakeResult contract", () => {
  const valid = {
    instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
    horizon: "positional",
    researchNotes: "Q3 results due",
  };

  it("accepts a well-formed intake result", () => {
    expect(intakeResultSchema.parse(valid)).toEqual(valid);
  });

  it("accepts an omitted researchNotes", () => {
    const { researchNotes, ...withoutNotes } = valid;
    expect(intakeResultSchema.safeParse(withoutNotes).success).toBe(true);
  });

  it("rejects an unsupported horizon (auto still deferred) and extra properties", () => {
    expect(intakeResultSchema.safeParse({ ...valid, horizon: "auto" }).success).toBe(false);
    expect(intakeResultSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });

  it("mirrors the closed horizon enum in the CLI JSON schema", () => {
    expect(intakeResultJsonSchema.properties.horizon.enum).toEqual(["intraday", "positional"]);
    expect(intakeResultJsonSchema.additionalProperties).toBe(false);
  });
});
