import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
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

  it("logs and skips a malformed JSON line without crashing, then still resolves later requests", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { supervisor, children } = makeSupervisor();
    const pending = supervisor.compute("NSE:INFY", "day", [1, 2, 3]);

    expect(() => children[0].stdout.write("{not valid json\n")).not.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    children[0].stdout.write(
      `${JSON.stringify({ type: "compute", id: 1, algo_results: [], confluence: { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 } })}\n`,
    );

    const response = await pending;
    expect(response.id).toBe(1);
    expect(response.type).toBe("compute");

    consoleErrorSpy.mockRestore();
  });

  it("rejects a request that never gets a response after requestTimeoutMs and leaves no pending leak", async () => {
    const children: FakeChild[] = [];
    const spawnFn = (_command: string, _args: string[]) => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ReturnType<typeof spawnFn>;
    };
    const supervisor = new SidecarSupervisor({
      binaryPath: "/fake/sidecar",
      lakeRoot: "/fake/lake",
      spawnFn,
      requestTimeoutMs: 20,
    });
    supervisor.start();

    const pending = supervisor.compute("NSE:INFY", "day", [1, 2, 3]);

    await expect(pending).rejects.toThrow(/sidecar request 1 timed out after 20ms/);
    // No leak: a late response for id 1 must find no pending entry and be dropped.
    expect(() =>
      children[0].stdout.write(
        `${JSON.stringify({ type: "compute", id: 1, algo_results: [], confluence: { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 } })}\n`,
      ),
    ).not.toThrow();
  });

  it("resolves addWatchlistSymbol with a watchlist response carrying the matching id", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.addWatchlistSymbol("NSE:INFY");
    await requestsSeen;
    children[0].stdout.write(`${JSON.stringify({ type: "watchlist", id: 1, symbols: ["NSE:INFY"] })}\n`);
    const response = await pending;
    expect(response.type).toBe("watchlist");
    expect(response.symbols).toEqual(["NSE:INFY"]);
  });

  it("resolves removeWatchlistSymbol with the updated list", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.removeWatchlistSymbol("NSE:INFY");
    await requestsSeen;
    children[0].stdout.write(`${JSON.stringify({ type: "watchlist", id: 1, symbols: [] })}\n`);
    expect((await pending).symbols).toEqual([]);
  });

  it("resolves listWatchlist with the current list", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.listWatchlist();
    await requestsSeen;
    children[0].stdout.write(`${JSON.stringify({ type: "watchlist", id: 1, symbols: ["NSE:TCS"] })}\n`);
    expect((await pending).symbols).toEqual(["NSE:TCS"]);
  });

  it("resolves evaluateScanGate with a scan_gate decision", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.evaluateScanGate("NSE:INFY", {
      bullish_count: 5,
      bearish_count: 2,
      neutral_count: 10,
      weighted_vote: 0.12,
    });
    await requestsSeen;
    children[0].stdout.write(`${JSON.stringify({ type: "scan_gate", id: 1, decision: "WorthLook" })}\n`);
    expect((await pending).decision).toBe("WorthLook");
  });

  it("rejects evaluateScanGate on timeout exactly like compute (shared send path, no new timeout code)", async () => {
    const children: FakeChild[] = [];
    const spawnFn = (_command: string, _args: string[]) => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ReturnType<typeof spawnFn>;
    };
    const supervisor = new SidecarSupervisor({ binaryPath: "/fake/sidecar", lakeRoot: "/fake/lake", spawnFn, requestTimeoutMs: 20 });
    supervisor.start();
    await expect(
      supervisor.evaluateScanGate("NSE:INFY", { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 }),
    ).rejects.toThrow(/sidecar request 1 timed out after 20ms/);
  });

  it("resolves listLakeSymbols with a lake_symbols response carrying the matching id", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.listLakeSymbols();
    await requestsSeen;
    children[0].stdout.write(
      `${JSON.stringify({ type: "lake_symbols", id: 1, entries: [{ symbol: "NSE:INFY", timeframe: "day", source: "bhavcopy", from_ts: 1, to_ts: 2, candle_count: 3 }] })}\n`,
    );
    const response = await pending;
    expect(response.type).toBe("lake_symbols");
    expect(response.entries[0].symbol).toBe("NSE:INFY");
  });

  it("resolves readLakeCandles with the sourced series", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.readLakeCandles("NSE:INFY", "day", "bhavcopy");
    await requestsSeen;
    children[0].stdout.write(
      `${JSON.stringify({ type: "lake_candles", id: 1, candles: [{ ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }] })}\n`,
    );
    expect((await pending).candles).toHaveLength(1);
  });

  it("resolves benchmarkCompute with algo_results and confluence", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.benchmarkCompute("NSE:INFY", "day", "positional", [
      { ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ]);
    await requestsSeen;
    children[0].stdout.write(
      `${JSON.stringify({ type: "benchmark_compute", id: 1, algo_results: [], confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 } })}\n`,
    );
    expect((await pending).confluence.bullish_count).toBe(1);
  });

  it("resolves evaluateScanGateStateless with a scan_gate decision", async () => {
    const { supervisor, children } = makeSupervisor();
    const requestsSeen = readRequests(children[0]);
    const pending = supervisor.evaluateScanGateStateless(null, {
      bullish_count: 5,
      bearish_count: 2,
      neutral_count: 10,
      weighted_vote: 0.12,
    });
    await requestsSeen;
    children[0].stdout.write(`${JSON.stringify({ type: "scan_gate", id: 1, decision: "WorthLook" })}\n`);
    expect((await pending).decision).toBe("WorthLook");
  });

  it("rejects benchmarkCompute on timeout exactly like compute (shared send path)", async () => {
    const children: FakeChild[] = [];
    const spawnFn = (_command: string, _args: string[]) => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ReturnType<typeof spawnFn>;
    };
    const supervisor = new SidecarSupervisor({ binaryPath: "/fake/sidecar", lakeRoot: "/fake/lake", spawnFn, requestTimeoutMs: 20 });
    supervisor.start();
    await expect(
      supervisor.benchmarkCompute("NSE:INFY", "day", "positional", [{ ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }]),
    ).rejects.toThrow(/sidecar request 1 timed out after 20ms/);
  });
});
