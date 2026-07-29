import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { makeClaudeRunner, ClaudeCliProvider } from "../../../../src/main/services/claude/claudeCliProvider";
import { personaFindingSchema, personaFindingJsonSchema } from "../../../../src/main/services/analysis/contracts";
import type { AnalysisEnvelope } from "../../../../src/main/services/analysis/contracts";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  kill(): void {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
  }
}

function emitStructured(child: FakeChild, structuredOutput: unknown, exitCode = 0) {
  queueMicrotask(() => {
    child.stdout.write(`${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "search_instruments", input: { q: "infy" } }] } })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "NSE:INFY" }] } })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: JSON.stringify(structuredOutput) })}\n`);
    child.emit("exit", exitCode, null);
  });
}

const validFinding = {
  persona: "technical_quant",
  direction: "bullish",
  conviction: "high",
  findings: ["rsi above 50"],
  cited_algo_ids: ["rsi"],
};

function baseSpec() {
  return {
    name: "technical_quant" as const,
    systemPrompt: "sys",
    jsonSchema: personaFindingJsonSchema,
    schema: personaFindingSchema,
    prompt: "user prompt",
    timeoutMs: 120000,
  };
}

describe("makeClaudeRunner", () => {
  it("parses and validates structured_output on the first try", async () => {
    const children: FakeChild[] = [];
    const spawnFn = () => {
      const child = new FakeChild();
      children.push(child);
      emitStructured(child, validFinding);
      return child as never;
    };
    const run = makeClaudeRunner({ spawnFn });
    const finding = await run(baseSpec());
    expect(finding.direction).toBe("bullish");
    expect(children.length).toBe(1);
  });

  it("retries once with a corrective note when the first output is schema-invalid", async () => {
    const prompts: string[] = [];
    const children: FakeChild[] = [];
    const spawnFn = (_c: string, args: string[]) => {
      prompts.push(args[args.length - 1]);
      const child = new FakeChild();
      children.push(child);
      emitStructured(child, children.length === 1 ? { direction: "buy" } : validFinding);
      return child as never;
    };
    const run = makeClaudeRunner({ spawnFn });
    const finding = await run(baseSpec());
    expect(finding.direction).toBe("bullish");
    expect(children.length).toBe(2);
    expect(prompts[1]).toContain("did not match the required JSON schema");
  });

  it("throws after a second schema failure", async () => {
    const spawnFn = () => {
      const child = new FakeChild();
      emitStructured(child, { direction: "buy" });
      return child as never;
    };
    const run = makeClaudeRunner({ spawnFn });
    await expect(run(baseSpec())).rejects.toThrow(
      /persona technical_quant failed to produce valid structured output after retry/,
    );
  });

  it("trips each spec's own timeoutMs and names the persona", async () => {
    const children: FakeChild[] = [];
    const spawnFn = () => {
      const c = new FakeChild();
      children.push(c);
      return c as never; // never emits
    };
    const run = makeClaudeRunner({ spawnFn });
    await expect(run({ ...baseSpec(), timeoutMs: 15 })).rejects.toThrow(/persona technical_quant timed out after 15ms/);
    expect(children[0].killed).toBe(true);
  });

  it("exposes the P9A§6 default timeout table", async () => {
    const { PERSONA_TIMEOUTS_MS } = await import("../../../../src/main/services/claude/claudeCliProvider");
    expect(PERSONA_TIMEOUTS_MS).toEqual({
      sidecar: 20000, intake: 20000, options_greeks: 45000, technical_quant: 45000,
      position_risk: 45000, synthesis: 25000, narrative: 60000,
    });
  });

  it("kills the child and rejects when the caller aborts", async () => {
    const children: FakeChild[] = [];
    const spawnFn = () => {
      const child = new FakeChild();
      children.push(child);
      return child as never;
    };
    const controller = new AbortController();
    const run = makeClaudeRunner({ spawnFn });
    const pending = run({ ...baseSpec(), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/persona technical_quant aborted/);
    expect(children[0].killed).toBe(true);
  });

  it("rejects without spawning when the signal is already aborted", async () => {
    const children: FakeChild[] = [];
    const spawnFn = () => {
      const child = new FakeChild();
      children.push(child);
      return child as never;
    };
    const controller = new AbortController();
    controller.abort();
    const run = makeClaudeRunner({ spawnFn });
    await expect(run({ ...baseSpec(), signal: controller.signal })).rejects.toThrow(
      /persona technical_quant aborted/,
    );
    expect(children.length).toBe(0);
  });

  it("removes its abort listener once the attempt settles", async () => {
    const spawnFn = () => {
      const child = new FakeChild();
      emitStructured(child, validFinding);
      return child as never;
    };
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const run = makeClaudeRunner({ spawnFn });
    await run({ ...baseSpec(), signal: controller.signal });
    const abortAdds = addSpy.mock.calls.filter((call) => call[0] === "abort").length;
    const abortRemoves = removeSpy.mock.calls.filter((call) => call[0] === "abort").length;
    expect(abortAdds).toBeGreaterThan(0);
    expect(abortRemoves).toBe(abortAdds);
  });

  it("passes allowWebTools through to the spawned argv when the spec sets it", async () => {
    const argvs: string[][] = [];
    const spawnFn = (_c: string, args: string[]) => {
      argvs.push(args);
      const child = new FakeChild();
      emitStructured(child, validFinding);
      return child as never;
    };
    const run = makeClaudeRunner({ spawnFn });
    await run({ ...baseSpec(), allowWebTools: true });
    expect(argvs[0][argvs[0].indexOf("--allowedTools") + 1]).toContain("WebSearch");
    expect(argvs[0][argvs[0].indexOf("--allowedTools") + 1]).toContain("WebFetch");
  });

  it("does not grant web tools when the spec omits allowWebTools", async () => {
    const argvs: string[][] = [];
    const spawnFn = (_c: string, args: string[]) => {
      argvs.push(args);
      const child = new FakeChild();
      emitStructured(child, validFinding);
      return child as never;
    };
    await makeClaudeRunner({ spawnFn })(baseSpec());
    expect(argvs[0][argvs[0].indexOf("--allowedTools") + 1]).not.toContain("WebSearch");
  });

  it("emits exactly one started, the tool events, and one done for a first-try success (no token)", async () => {
    const events: Array<{ source: string; kind: string; detail?: string }> = [];
    const spawnFn = () => { const c = new FakeChild(); emitStructured(c, validFinding); return c as never; };
    await makeClaudeRunner({ spawnFn })({ ...baseSpec(), onTrace: (e) => events.push(e) });
    expect(events.map((e) => e.kind)).toEqual(["started", "toolCall", "toolResult", "done"]);
    expect(events[1].detail).toBe(`search_instruments ${JSON.stringify({ q: "infy" })}`);
    expect(events[2].detail).toBe("search_instruments → NSE:INFY");
    expect(events.every((e) => e.source === "technical_quant")).toBe(true);
    expect(events.some((e) => e.kind === "token")).toBe(false);
  });

  it("emits a single started across a corrective retry and one done", async () => {
    const events: string[] = [];
    let n = 0;
    const spawnFn = () => { const c = new FakeChild(); emitStructured(c, ++n === 1 ? { direction: "buy" } : validFinding); return c as never; };
    await makeClaudeRunner({ spawnFn })({ ...baseSpec(), onTrace: (e) => events.push(e.kind) });
    expect(events.filter((k) => k === "started")).toHaveLength(1);
    expect(events.filter((k) => k === "done")).toHaveLength(1);
  });

  it("emits started then error (no done) on timeout, with the same message it rejects with", async () => {
    const events: Array<{ kind: string; detail?: string }> = [];
    const spawnFn = () => new FakeChild() as never; // never emits
    const run = makeClaudeRunner({ spawnFn });
    await expect(run({ ...baseSpec(), timeoutMs: 15, onTrace: (e) => events.push(e) }))
      .rejects.toThrow(/persona technical_quant timed out after 15ms/);
    expect(events.map((e) => e.kind)).toEqual(["started", "error"]);
    expect(events[1].detail).toBe("persona technical_quant timed out after 15ms");
  });
});

const aiEnvelope: AnalysisEnvelope = {
  trigger: "reactive",
  instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
  horizon_requested: "positional",
  intent_lens: "buying",
  algo_results: [
    { algo_id: "rsi", symbol: "NSE:INFY", timeframe: "day", horizon: "positional", direction: "Bullish", magnitude: 0.4, confidence: 0.6, evidence: ["RSI 62"], computed_at: "2026-07-24T00:00:00+00:00" },
  ],
  confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
  overlays: {},
};

describe("ClaudeCliProvider.completeAiAssisted", () => {
  it("runs the pipeline for a frozen verdict, then streams the narrative tokens", async () => {
    const verdictOut = { direction: "bullish", conviction: "high", reasoning: "rsi", cited_algo_ids: ["rsi"], verify_before_acting: "check LTP" };
    const spawnFn = (_c: string, args: string[]) => {
      const child = new FakeChild();
      // All six persona kinds stream-json now; only structured personas carry --json-schema.
      if (args.includes("--json-schema")) {
        emitStructured(child, args.some((a) => a.includes("synthesis")) ? verdictOut : validFinding);
      } else {
        queueMicrotask(() => {
          child.stdout.write(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Infy " } } })}\n`);
          child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "Infy looks constructive." })}\n`);
          child.emit("exit", 0, null);
        });
      }
      return child as never;
    };
    const provider = new ClaudeCliProvider({ spawnFn });
    const tokens: string[] = [];
    const result = await provider.completeAiAssisted(aiEnvelope, { onNarrativeToken: (t) => tokens.push(t) });
    expect(result.verdict.direction).toBe("bullish");
    expect(result.narrative).toBe("Infy looks constructive.");
    expect(tokens).toEqual(["Infy "]);
  });

  it("delegates intake to runIntake through the runner", async () => {
    const intakeOut = { instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" }, horizon: "positional" };
    const provider = new ClaudeCliProvider({
      spawnFn: () => {
        const child = new FakeChild();
        emitStructured(child, intakeOut);
        return child as never;
      },
    });
    await expect(provider.intake("infosys swing")).resolves.toMatchObject({ horizon: "positional" });
  });

  it("forwards continuity flags to the narrative call only, never to any persona/synthesis call", async () => {
    const verdictOut = { direction: "bullish", conviction: "high", reasoning: "rsi", cited_algo_ids: ["rsi"], verify_before_acting: "check LTP" };
    const streamArgvs: string[][] = [];
    const jsonArgvs: string[][] = [];
    const spawnFn = (_c: string, args: string[]) => {
      const child = new FakeChild();
      if (args.includes("--json-schema")) {
        jsonArgvs.push(args);
        emitStructured(child, args.some((a) => a.includes("synthesis")) ? verdictOut : validFinding);
      } else {
        streamArgvs.push(args);
        queueMicrotask(() => {
          child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "narrative text" })}\n`);
          child.emit("exit", 0, null);
        });
      }
      return child as never;
    };
    const provider = new ClaudeCliProvider({ spawnFn });
    await provider.completeAiAssisted(aiEnvelope, {
      onNarrativeToken: () => {},
      claudeSessionId: "uuid-xyz",
      resumeSession: true,
    });
    expect(streamArgvs).toHaveLength(1);
    expect(streamArgvs[0].slice(streamArgvs[0].indexOf("--resume"), streamArgvs[0].indexOf("--resume") + 2)).toEqual(["--resume", "uuid-xyz"]);
    for (const argv of jsonArgvs) {
      expect(argv).not.toContain("--session-id");
      expect(argv).not.toContain("--resume");
    }
  });
});
