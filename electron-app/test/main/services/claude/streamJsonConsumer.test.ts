import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { consumeStreamJson, type StreamCallbacks } from "../../../../src/main/services/claude/streamJsonConsumer";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
}

function collect() {
  const calls: string[] = [];
  const cbs: StreamCallbacks = {
    onToken: (t) => calls.push(`token:${t}`),
    onToolCall: (n, i) => calls.push(`toolCall:${n}:${JSON.stringify(i)}`),
    onToolResult: (n, r) => calls.push(`toolResult:${n}:${r}`),
    onResult: (f) => calls.push(`result:${f}`),
    onFailure: (e) => calls.push(`failure:${e.message}`),
  };
  return { calls, cbs };
}

describe("consumeStreamJson", () => {
  it("emits token, tool_use, tool_result (correlated by id), then the terminal result in order", async () => {
    const child = new FakeChild();
    const { calls, cbs } = collect();
    consumeStreamJson(child as never, cbs);
    child.stdout.write(
      `${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi " } } })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "search_instruments", input: { query: "infy" } }] } })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: [{ type: "text", text: "NSE:INFY 408065" }],
            },
          ],
        },
      })}\n`,
    );
    child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "done text" })}\n`);
    child.emit("exit", 0, null);
    expect(calls).toEqual([
      "token:hi ",
      'toolCall:search_instruments:{"query":"infy"}',
      "toolResult:search_instruments:NSE:INFY 408065",
      "result:done text",
    ]);
  });

  it("falls back to tool_use_id when no correlating name was seen", () => {
    const child = new FakeChild();
    const { calls, cbs } = collect();
    consumeStreamJson(child as never, cbs);
    child.stdout.write(
      `${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_9", content: "raw" }] } })}\n`,
    );
    expect(calls).toContain("toolResult:tu_9:raw");
  });

  it("fails on a non-success terminal result and on a non-zero exit", () => {
    const child = new FakeChild();
    const { calls, cbs } = collect();
    consumeStreamJson(child as never, cbs);
    child.stdout.write(`${JSON.stringify({ type: "result", subtype: "error_max_turns" })}\n`);
    expect(calls.some((c) => c.startsWith("failure:"))).toBe(true);
  });
});
