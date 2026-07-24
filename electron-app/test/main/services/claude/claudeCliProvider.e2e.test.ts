import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ClaudeCliProvider } from "../../../../src/main/services/claude/claudeCliProvider";
import { verdictJsonSchema } from "../../../../src/main/services/analysis/contracts";
import type { AnalysisEnvelope } from "../../../../src/main/services/analysis/contracts";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  kill(): void {
    this.emit("exit", null, "SIGTERM");
  }
}

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

const finding = { persona: "technical_quant", direction: "bullish", conviction: "high", findings: ["rsi and sma agree"], cited_algo_ids: ["rsi", "sma"] };
const verdict = { direction: "bullish", conviction: "high", reasoning: "rsi and sma both bullish", cited_algo_ids: ["rsi", "sma"], verify_before_acting: "check LTP in Kite" };

describe("ClaudeCliProvider.complete (end-to-end, scripted subprocess)", () => {
  it("produces a Verdict citing only algo_ids present in the envelope", async () => {
    const isSynthesis = (args: string[]) => args.includes(JSON.stringify(verdictJsonSchema));
    const spawnFn = (_command: string, args: string[]) => {
      const child = new FakeChild();
      const structuredOutput = isSynthesis(args) ? verdict : finding;
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ result: "ok", structured_output: structuredOutput }));
        child.stdout.end();
        child.emit("exit", 0, null);
      });
      return child as never;
    };

    const provider = new ClaudeCliProvider({ spawnFn });
    const result = await provider.complete(envelope);

    expect(result.direction).toBe("bullish");
    expect(["bullish", "bearish", "neutral"]).toContain(result.direction);
    const allowed = new Set(envelope.algo_results.map((r) => r.algo_id));
    expect(result.cited_algo_ids.every((id) => allowed.has(id))).toBe(true);
  });
});
