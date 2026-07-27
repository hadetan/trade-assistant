import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { makeNarrativeStreamer } from "../../../../src/main/services/claude/streamingNarrative";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  kill(): void {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
  }
}

function delta(text: string): string {
  return JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  });
}

const baseSpec = (onToken: (t: string) => void) => ({ systemPrompt: "sys", prompt: "explain", onToken });

describe("makeNarrativeStreamer", () => {
  it("fires onToken per text_delta in order and resolves with the terminal result text", async () => {
    const tokens: string[] = [];
    const child = new FakeChild();
    const run = makeNarrativeStreamer({ spawnFn: () => child as never });
    const pending = run(baseSpec((t) => tokens.push(t)));
    child.stdout.write(`${JSON.stringify({ type: "system", subtype: "init" })}\n`);
    child.stdout.write(`${delta("Bank")}\n${delta(" Nifty")}\n`);
    child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Bank Nifty full text" })}\n`);
    child.emit("exit", 0, null);
    await expect(pending).resolves.toBe("Bank Nifty full text");
    expect(tokens).toEqual(["Bank", " Nifty"]);
  });

  it("reassembles a delta split across two stdout chunks", async () => {
    const tokens: string[] = [];
    const child = new FakeChild();
    const run = makeNarrativeStreamer({ spawnFn: () => child as never });
    const pending = run(baseSpec((t) => tokens.push(t)));
    const line = delta("Hello");
    child.stdout.write(line.slice(0, 20));
    child.stdout.write(`${line.slice(20)}\n${JSON.stringify({ type: "result", subtype: "success", result: "Hello" })}\n`);
    child.emit("exit", 0, null);
    await pending;
    expect(tokens).toEqual(["Hello"]);
  });

  it("skips a malformed line without crashing and still resolves on the terminal result", async () => {
    const tokens: string[] = [];
    const child = new FakeChild();
    const run = makeNarrativeStreamer({ spawnFn: () => child as never });
    const pending = run(baseSpec((t) => tokens.push(t)));
    child.stdout.write(`${delta("Bank")}\nnot valid json\n${delta(" Nifty")}\n`);
    child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "Bank Nifty" })}\n`);
    child.emit("exit", 0, null);
    await expect(pending).resolves.toBe("Bank Nifty");
    expect(tokens).toEqual(["Bank", " Nifty"]);
  });

  it("swallows a throwing onToken and still processes subsequent tokens and the terminal result", async () => {
    const tokens: string[] = [];
    const child = new FakeChild();
    const run = makeNarrativeStreamer({ spawnFn: () => child as never });
    const pending = run(
      baseSpec((t) => {
        tokens.push(t);
        if (t === "Bank") throw new Error("onToken boom");
      }),
    );
    child.stdout.write(`${delta("Bank")}\n${delta(" Nifty")}\n`);
    child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "Bank Nifty" })}\n`);
    child.emit("exit", 0, null);
    await expect(pending).resolves.toBe("Bank Nifty");
    expect(tokens).toEqual(["Bank", " Nifty"]);
  });

  it("rejects when the stream ends without a terminal success result", async () => {
    const child = new FakeChild();
    const pending = makeNarrativeStreamer({ spawnFn: () => child as never })(baseSpec(() => {}));
    child.stdout.write(`${delta("x")}\n`);
    child.emit("exit", 0, null);
    await expect(pending).rejects.toThrow(/without a terminal result/);
  });

  it("rejects on a non-zero exit", async () => {
    const child = new FakeChild();
    const pending = makeNarrativeStreamer({ spawnFn: () => child as never })(baseSpec(() => {}));
    child.emit("exit", 1, null);
    await expect(pending).rejects.toThrow(/exited with code 1/);
  });

  it("rejects and kills the child on timeout", async () => {
    const child = new FakeChild();
    const pending = makeNarrativeStreamer({ spawnFn: () => child as never, timeoutMs: 15 })(baseSpec(() => {}));
    await expect(pending).rejects.toThrow(/timed out after 15ms/);
    expect(child.killed).toBe(true);
  });

  it("rejects when the caller aborts", async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const pending = makeNarrativeStreamer({ spawnFn: () => child as never })({
      ...baseSpec(() => {}),
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(child.killed).toBe(true);
  });
});

describe("makeNarrativeStreamer continuity forwarding", () => {
  const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  function captureArgv(spec: Parameters<ReturnType<typeof makeNarrativeStreamer>>[0]) {
    let captured: string[] = [];
    const child = new FakeChild();
    const run = makeNarrativeStreamer({
      spawnFn: (_c, args) => {
        captured = args;
        return child as never;
      },
    });
    const pending = run(spec);
    child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "done" })}\n`);
    child.emit("exit", 0, null);
    return { captured, pending };
  }

  it("passes --session-id through when pinning a new conversation", async () => {
    const { captured, pending } = captureArgv({ ...baseSpec(() => {}), claudeSessionId: uuid });
    await pending;
    expect(captured.slice(captured.indexOf("--session-id"), captured.indexOf("--session-id") + 2)).toEqual(["--session-id", uuid]);
    expect(captured).not.toContain("--resume");
  });

  it("passes --resume through when resuming", async () => {
    const { captured, pending } = captureArgv({ ...baseSpec(() => {}), claudeSessionId: uuid, resumeSession: true });
    await pending;
    expect(captured.slice(captured.indexOf("--resume"), captured.indexOf("--resume") + 2)).toEqual(["--resume", uuid]);
    expect(captured).not.toContain("--session-id");
  });

  it("passes neither flag when no continuity is requested", async () => {
    const { captured, pending } = captureArgv(baseSpec(() => {}));
    await pending;
    expect(captured).not.toContain("--session-id");
    expect(captured).not.toContain("--resume");
  });
});
