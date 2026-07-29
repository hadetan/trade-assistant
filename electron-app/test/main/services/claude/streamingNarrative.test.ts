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

const baseSpec = (onTrace: (e: { source: string; kind: string; detail?: string }) => void) =>
  ({ systemPrompt: "sys", prompt: "explain", onTrace, timeoutMs: 180000 });

describe("makeNarrativeStreamer", () => {
  it("emits started, a token per delta, and done on success, and returns the final text", async () => {
    const events: Array<{ kind: string; detail?: string }> = [];
    const child = new FakeChild();
    const run = makeNarrativeStreamer({ spawnFn: () => child as never });
    const pending = run(baseSpec((e) => events.push(e)));
    child.stdout.write(`${delta("Bank")}\n${delta(" Nifty")}\n`);
    child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "Bank Nifty" })}\n`);
    child.emit("exit", 0, null);
    await expect(pending).resolves.toBe("Bank Nifty");
    expect(events.map((e) => e.kind)).toEqual(["started", "token", "token", "done"]);
    expect(events.filter((e) => e.kind === "token").map((e) => e.detail)).toEqual(["Bank", " Nifty"]);
  });

  it("emits started then error (before reject) on a non-zero exit", async () => {
    const events: Array<{ kind: string; detail?: string }> = [];
    const child = new FakeChild();
    const pending = makeNarrativeStreamer({ spawnFn: () => child as never })(baseSpec((e) => events.push(e)));
    child.emit("exit", 1, null);
    await expect(pending).rejects.toThrow(/exited with code 1/);
    expect(events[0].kind).toBe("started");
    expect(events.at(-1)).toMatchObject({ kind: "error" });
  });

  it("fires a token trace event per text_delta in order and resolves with the terminal result text", async () => {
    const tokens: string[] = [];
    const child = new FakeChild();
    const run = makeNarrativeStreamer({ spawnFn: () => child as never });
    const pending = run(
      baseSpec((e) => {
        if (e.kind === "token" && e.detail !== undefined) tokens.push(e.detail);
      }),
    );
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
    const pending = run(
      baseSpec((e) => {
        if (e.kind === "token" && e.detail !== undefined) tokens.push(e.detail);
      }),
    );
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
    const pending = run(
      baseSpec((e) => {
        if (e.kind === "token" && e.detail !== undefined) tokens.push(e.detail);
      }),
    );
    child.stdout.write(`${delta("Bank")}\nnot valid json\n${delta(" Nifty")}\n`);
    child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "Bank Nifty" })}\n`);
    child.emit("exit", 0, null);
    await expect(pending).resolves.toBe("Bank Nifty");
    expect(tokens).toEqual(["Bank", " Nifty"]);
  });

  it("swallows a throwing onTrace token handler and still processes subsequent tokens and the terminal result", async () => {
    const tokens: string[] = [];
    const child = new FakeChild();
    const run = makeNarrativeStreamer({ spawnFn: () => child as never });
    const pending = run(
      baseSpec((e) => {
        if (e.kind !== "token" || e.detail === undefined) return;
        tokens.push(e.detail);
        if (e.detail === "Bank") throw new Error("onTrace boom");
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

  it("rejects and kills the child on its spec timeoutMs", async () => {
    const child = new FakeChild();
    const pending = makeNarrativeStreamer({ spawnFn: () => child as never })({ ...baseSpec(() => {}), timeoutMs: 15 });
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
