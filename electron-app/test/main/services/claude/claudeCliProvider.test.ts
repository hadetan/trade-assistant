import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { makeClaudeRunner } from "../../../../src/main/services/claude/claudeCliProvider";
import { personaFindingSchema, personaFindingJsonSchema } from "../../../../src/main/services/analysis/contracts";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  kill(): void {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
  }
}

function emitResult(child: FakeChild, structuredOutput: unknown, exitCode = 0) {
  queueMicrotask(() => {
    child.stdout.write(`${JSON.stringify({ result: "ok", structured_output: structuredOutput })}`);
    child.stdout.end();
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
    name: "technical_quant",
    systemPrompt: "sys",
    jsonSchema: personaFindingJsonSchema,
    schema: personaFindingSchema,
    prompt: "user prompt",
  };
}

describe("makeClaudeRunner", () => {
  it("parses and validates structured_output on the first try", async () => {
    const children: FakeChild[] = [];
    const spawnFn = () => {
      const child = new FakeChild();
      children.push(child);
      emitResult(child, validFinding);
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
      emitResult(child, children.length === 1 ? { direction: "buy" } : validFinding);
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
      emitResult(child, { direction: "buy" });
      return child as never;
    };
    const run = makeClaudeRunner({ spawnFn });
    await expect(run(baseSpec())).rejects.toThrow(
      /persona technical_quant failed to produce valid structured output after retry/,
    );
  });

  it("kills the child and rejects on timeout", async () => {
    const children: FakeChild[] = [];
    const spawnFn = () => {
      const child = new FakeChild();
      children.push(child);
      return child as never; // never emits a result
    };
    const run = makeClaudeRunner({ spawnFn, personaTimeoutMs: 15 });
    await expect(run(baseSpec())).rejects.toThrow(/persona technical_quant timed out after 15ms/);
    expect(children[0].killed).toBe(true);
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
      emitResult(child, validFinding);
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
      emitResult(child, validFinding);
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
      emitResult(child, validFinding);
      return child as never;
    };
    await makeClaudeRunner({ spawnFn })(baseSpec());
    expect(argvs[0][argvs[0].indexOf("--allowedTools") + 1]).not.toContain("WebSearch");
  });
});
