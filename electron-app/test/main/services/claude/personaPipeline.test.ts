import { describe, expect, it, vi } from "vitest";
import { runPipeline, type PipelinePrompts } from "../../../../src/main/services/claude/personaPipeline";
import type { PersonaRunner, PersonaRunSpec } from "../../../../src/main/services/claude/claudeCliProvider";
import type { AnalysisEnvelope, PersonaFinding, Verdict } from "../../../../src/main/services/analysis/contracts";

const prompts: PipelinePrompts = {
  optionsGreeks: { systemPrompt: "og", outputSchema: {} },
  technicalQuant: { systemPrompt: "tq", outputSchema: {} },
  positionRisk: { systemPrompt: "pr", outputSchema: {} },
  synthesis: { systemPrompt: "syn", outputSchema: {} },
};

const envelope: AnalysisEnvelope = {
  trigger: "reactive",
  instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
  horizon_requested: "positional",
  intent_lens: "buying",
  algo_results: [
    { algo_id: "rsi", symbol: "NSE:INFY", timeframe: "day", horizon: "positional", direction: "Bullish", magnitude: 0.4, confidence: 0.6, evidence: ["RSI 62"], computed_at: "2026-07-24T00:00:00+00:00" },
    { algo_id: "sma", symbol: "NSE:INFY", timeframe: "day", horizon: "positional", direction: "Bullish", magnitude: 0.2, confidence: 0.5, evidence: ["above SMA"], computed_at: "2026-07-24T00:00:00+00:00" },
  ],
  confluence: { bullish_count: 2, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
  overlays: {},
};

function finding(persona: PersonaFinding["persona"]): PersonaFinding {
  return { persona, direction: "bullish", conviction: "high", findings: ["x"], cited_algo_ids: ["rsi"] };
}

const verdict: Verdict = {
  direction: "bullish",
  conviction: "high",
  reasoning: "rsi and sma agree",
  cited_algo_ids: ["rsi", "sma"],
  verify_before_acting: "check LTP in Kite",
};

describe("runPipeline", () => {
  it("runs three analytical personas in parallel, then synthesis, and returns the verdict", async () => {
    const seen: string[] = [];
    const runPersona: PersonaRunner = vi.fn(async (spec: PersonaRunSpec<unknown>) => {
      seen.push(spec.name);
      if (spec.name === "synthesis") return verdict as never;
      return finding(spec.name as PersonaFinding["persona"]) as never;
    });

    const result = await runPipeline(envelope, { runPersona, prompts });

    expect(result).toEqual(verdict);
    expect(seen.slice(0, 3).sort()).toEqual(["options_greeks", "position_risk", "technical_quant"]);
    expect(seen[3]).toBe("synthesis");
  });

  it("embeds all three findings and the allowed algo_ids in the synthesis prompt", async () => {
    let synthesisPrompt = "";
    const runPersona: PersonaRunner = async (spec: PersonaRunSpec<unknown>) => {
      if (spec.name === "synthesis") {
        synthesisPrompt = spec.prompt;
        return verdict as never;
      }
      return finding(spec.name as PersonaFinding["persona"]) as never;
    };

    await runPipeline(envelope, { runPersona, prompts });

    expect(synthesisPrompt).toContain("options_greeks");
    expect(synthesisPrompt).toContain("technical_quant");
    expect(synthesisPrompt).toContain("position_risk");
    expect(synthesisPrompt).toContain("rsi");
    expect(synthesisPrompt).toContain("sma");
  });

  it("fails the whole run and aborts siblings if any analytical persona fails, with no synthesis", async () => {
    let synthesisCalled = false;
    let aborted = false;
    const runPersona: PersonaRunner = (spec: PersonaRunSpec<unknown>) => {
      if (spec.name === "synthesis") {
        synthesisCalled = true;
        return Promise.resolve(verdict as never);
      }
      if (spec.name === "options_greeks") {
        return Promise.reject(new Error("persona options_greeks failed to produce valid structured output after retry"));
      }
      return new Promise((_resolve, reject) => {
        spec.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error(`persona ${spec.name} aborted`));
        });
      });
    };

    await expect(runPipeline(envelope, { runPersona, prompts })).rejects.toThrow(
      /persona options_greeks failed to produce valid structured output after retry/,
    );
    expect(synthesisCalled).toBe(false);
    expect(aborted).toBe(true);
  });

  it("rejects when synthesis cites an algo_id absent from the envelope", async () => {
    const runPersona: PersonaRunner = async (spec: PersonaRunSpec<unknown>) => {
      if (spec.name === "synthesis") return { ...verdict, cited_algo_ids: ["rsi", "made_up"] } as never;
      return finding(spec.name as PersonaFinding["persona"]) as never;
    };

    await expect(runPipeline(envelope, { runPersona, prompts })).rejects.toThrow(
      /synthesis cited algo_ids not present in the envelope/,
    );
  });
});
