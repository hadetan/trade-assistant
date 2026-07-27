import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCliProvider } from "../../../src/main/services/claude/claudeCliProvider";
import { runAiAssistedRequest } from "../../../src/main/ipc/analysisBridge";
import { KiteClient } from "../../../src/main/services/kite/kiteClient";
import { historicalResponse, mockSidecar } from "../../fixtures/sidecarFixtures";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  kill(): void {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
  }
}

const intakeOut = {
  instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
  horizon: "positional",
  researchNotes: "results due",
};
const findingOut = { persona: "technical_quant", direction: "bullish", conviction: "high", findings: ["rsi>50"], cited_algo_ids: ["rsi"] };
const verdictOut = { direction: "bullish", conviction: "high", reasoning: "rsi confluence", cited_algo_ids: ["rsi"], verify_before_acting: "check LTP in Kite" };

// One scripted subprocess for the whole pipeline: branch on argv. The narrative
// call is the only stream-json invocation; the persona system prompts carry
// their own names so we can key the buffered replies off them.
function scriptedSpawn(_command: string, args: string[]): never {
  const child = new FakeChild();
  const system = args[args.indexOf("--system-prompt") + 1] ?? "";
  queueMicrotask(() => {
    if (args.includes("stream-json")) {
      child.stdout.write(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Infy " } } })}\n`);
      child.stdout.write(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "is constructive." } } })}\n`);
      child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "Infy is constructive." })}\n`);
      child.emit("exit", 0, null);
      return;
    }
    let structured: unknown = findingOut;
    if (system.includes("intake")) structured = intakeOut;
    else if (system.includes("synthesis")) structured = verdictOut;
    child.stdout.write(`${JSON.stringify({ result: "ok", structured_output: structured })}`);
    child.stdout.end();
    child.emit("exit", 0, null);
  });
  return child as never;
}

describe("AI-assisted pipeline (fully mocked subprocess)", () => {
  it("drives intake → envelope → verdict → streamed narrative into an ai_assisted result", async () => {
    const provider = new ClaudeCliProvider({ spawnFn: scriptedSpawn });
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const events: unknown[] = [];
    const history = { appendMessage: vi.fn(), getClaudeSessionId: vi.fn().mockReturnValue(null), setClaudeSessionId: vi.fn() };

    const result = await runAiAssistedRequest(
      { kite, sidecar: mockSidecar() as never, provider, history },
      { mode: "ai_assisted", sessionId: "sess-Z", query: "how is infy for a swing", intent_lens: "buying", requestId: "rZ" },
      (event) => events.push(event),
    );

    expect(result.mode).toBe("ai_assisted");
    if (result.mode !== "ai_assisted") throw new Error("mode");
    expect(result.verdict.direction).toBe("bullish");
    expect(result.narrative).toBe("Infy is constructive.");
    expect(result.intent_lens).toBe("buying");
    expect(result.algo_results[0].algo_id).toBe("rsi");
    expect(result.confluence.bullish_count).toBe(1);
    expect(events).toEqual([
      { requestId: "rZ", chunk: "Infy " },
      { requestId: "rZ", chunk: "is constructive." },
      { requestId: "rZ", done: true },
    ]);
    expect(history.appendMessage).toHaveBeenCalledTimes(2);
    expect(history.setClaudeSessionId).toHaveBeenCalledTimes(1);
  });
});
