import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCliProvider } from "../../../src/main/services/claude/claudeCliProvider";
import { runAiAssistedRequest, runAnalysisRequest } from "../../../src/main/ipc/analysisBridge";
import { HistoryStore } from "../../../src/main/services/history/historyStore";
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

const intakeOut = { instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" }, horizon: "positional", researchNotes: "results due" };
const findingOut = { persona: "technical_quant", direction: "bullish", conviction: "high", findings: ["rsi>50"], cited_algo_ids: ["rsi"] };
const verdictOut = { direction: "bullish", conviction: "high", reasoning: "rsi confluence", cited_algo_ids: ["rsi"], verify_before_acting: "check LTP in Kite" };

const tempDirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ta-continuity-"));
  tempDirs.push(dir);
  return path.join(dir, "history.sqlite3");
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function makeScriptedSpawn(streamArgvs: string[][], jsonArgvs: string[][]) {
  return function scriptedSpawn(_command: string, args: string[]): never {
    const child = new FakeChild();
    const system = args[args.indexOf("--system-prompt") + 1] ?? "";
    queueMicrotask(() => {
      if (args.includes("stream-json")) {
        streamArgvs.push(args);
        child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "Infy is constructive." })}\n`);
        child.emit("exit", 0, null);
        return;
      }
      jsonArgvs.push(args);
      let structured: unknown = findingOut;
      if (system.includes("intake")) structured = intakeOut;
      else if (system.includes("synthesis")) structured = verdictOut;
      child.stdout.write(`${JSON.stringify({ result: "ok", structured_output: structured })}`);
      child.stdout.end();
      child.emit("exit", 0, null);
    });
    return child as never;
  };
}

function kiteClient(): KiteClient {
  return new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
}

describe("session continuity across a simulated restart", () => {
  it("pins on turn 1, resumes the same uuid on turn 2 from a fresh store, and keeps continuity off every persona/synthesis call", async () => {
    const dbPath = tempDbPath();
    const streamArgvs: string[][] = [];
    const jsonArgvs: string[][] = [];
    const provider = new ClaudeCliProvider({ spawnFn: makeScriptedSpawn(streamArgvs, jsonArgvs) });

    const store1 = new HistoryStore({ path: dbPath });
    const session = store1.createSession("ai_assisted");
    await runAiAssistedRequest(
      { kite: kiteClient(), sidecar: mockSidecar() as never, provider, history: store1 },
      { mode: "ai_assisted", sessionId: session.id, query: "turn one", intent_lens: "buying", requestId: "r1" },
      () => {},
    );
    store1.close();

    // Fresh store over the same file == app restart; the pinned id must survive.
    const store2 = new HistoryStore({ path: dbPath });
    const pinned = store2.getClaudeSessionId(session.id);
    expect(pinned).not.toBeNull();
    await runAiAssistedRequest(
      { kite: kiteClient(), sidecar: mockSidecar() as never, provider, history: store2 },
      { mode: "ai_assisted", sessionId: session.id, query: "turn two", intent_lens: "buying", requestId: "r2" },
      () => {},
    );

    expect(streamArgvs).toHaveLength(2);
    expect(streamArgvs[0].slice(streamArgvs[0].indexOf("--session-id"), streamArgvs[0].indexOf("--session-id") + 2)).toEqual(["--session-id", pinned]);
    expect(streamArgvs[0]).not.toContain("--resume");
    expect(streamArgvs[1].slice(streamArgvs[1].indexOf("--resume"), streamArgvs[1].indexOf("--resume") + 2)).toEqual(["--resume", pinned]);
    expect(streamArgvs[1]).not.toContain("--session-id");
    for (const argv of jsonArgvs) {
      expect(argv).not.toContain("--session-id");
      expect(argv).not.toContain("--resume");
    }

    expect(store2.getSession(session.id)?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    store2.close();
  });

  it("appends Engine-Only turns with no Claude involvement and a NULL claude_session_id", async () => {
    const dbPath = tempDbPath();
    const store = new HistoryStore({ path: dbPath });
    const session = store.createSession("engine_only");
    const params = {
      mode: "engine_only" as const,
      sessionId: session.id,
      instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
      horizon: "positional" as const,
      intent_lens: "buying" as const,
    };
    await runAnalysisRequest({ kite: kiteClient(), sidecar: mockSidecar() as never, history: store }, params);
    await runAnalysisRequest({ kite: kiteClient(), sidecar: mockSidecar() as never, history: store }, params);
    expect(store.getSession(session.id)?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(store.getClaudeSessionId(session.id)).toBeNull();
    store.close();
  });
});
