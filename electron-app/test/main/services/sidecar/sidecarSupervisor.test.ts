import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { SidecarSupervisor } from "../../../../src/main/services/sidecar/sidecarSupervisor";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  kill(): void {
    this.killed = true;
    this.emit("exit", 0, null);
  }
}

function makeSupervisor() {
  const children: FakeChild[] = [];
  const spawnFn = (_command: string, _args: string[]) => {
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ReturnType<typeof spawnFn>;
  };
  const supervisor = new SidecarSupervisor({ binaryPath: "/fake/sidecar", lakeRoot: "/fake/lake", spawnFn });
  supervisor.start();
  return { supervisor, children };
}

function readRequests(child: FakeChild): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    let buffer = "";
    child.stdin.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n").filter((line) => line.length > 0);
      if (lines.length >= 1) resolve(lines.map((line) => JSON.parse(line)));
    });
  });
}

describe("SidecarSupervisor", () => {
  it("passes --lake-root when spawning", () => {
    const args: string[] = [];
    const spawnFn = (_command: string, spawnArgs: string[]) => {
      args.push(...spawnArgs);
      return new FakeChild() as unknown as ReturnType<typeof spawnFn>;
    };
    const supervisor = new SidecarSupervisor({ binaryPath: "/fake/sidecar", lakeRoot: "/fake/lake", spawnFn });
    supervisor.start();
    expect(args).toEqual(["--lake-root", "/fake/lake"]);
  });

  it("resolves a compute request with the response carrying the matching id", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.compute("NSE:INFY", "day", [1, 2, 3]);

    await requestsSeen;
    children[0].stdout.write(
      `${JSON.stringify({ type: "compute", id: 1, algo_results: [], confluence: { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 } })}\n`,
    );

    const response = await pending;
    expect(response.id).toBe(1);
    expect(response.type).toBe("compute");
  });

  it("routes interleaved out-of-order responses to the correct waiting promise", async () => {
    const { supervisor, children } = makeSupervisor();
    const first = supervisor.compute("NSE:INFY", "day", [1, 2, 3]);
    const second = supervisor.persistCandles("NSE:INFY", "day", [
      { ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ]);

    children[0].stdout.write(`${JSON.stringify({ type: "persist_candles", id: 2, written: 1 })}\n`);
    children[0].stdout.write(
      `${JSON.stringify({ type: "compute", id: 1, algo_results: [], confluence: { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 } })}\n`,
    );

    expect((await second).written).toBe(1);
    expect((await first).id).toBe(1);
  });

  it("rejects in-flight requests and respawns when the child exits unexpectedly", async () => {
    const { supervisor, children } = makeSupervisor();
    const pending = supervisor.compute("NSE:INFY", "day", [1, 2, 3]);

    children[0].emit("exit", 1, null);

    await expect(pending).rejects.toThrow(/sidecar exited/);
    // Respawn is on a RESTART_BACKOFF_MS timer, so wait past it before asserting.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(children.length).toBe(2);
  });
});
