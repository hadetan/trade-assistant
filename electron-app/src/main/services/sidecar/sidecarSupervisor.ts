import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import {
  BenchmarkComputeResponseWire,
  CandleWire,
  ComputeResponseWire,
  ConfluenceWire,
  DayBackfillResponseWire,
  LakeCandlesResponseWire,
  LakeSymbolsResponseWire,
  ListAlgorithmsResponseWire,
  PersistCandlesResponseWire,
  ScanGateResponseWire,
  SidecarProgressWire,
  SidecarRequestWire,
  SidecarResponseWire,
  WatchlistResponseWire,
  encodeRequest,
} from "./sidecarProtocol";
import type { SidecarStatus } from "../../ipc/rendererApi";

interface ChildProcessLike extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  kill(signal?: string): void;
}

type SpawnFn = (command: string, args: string[]) => ChildProcessLike;

export interface SidecarSupervisorOptions {
  binaryPath: string;
  lakeRoot: string;
  spawnFn?: SpawnFn;
  requestTimeoutMs?: number;
}

interface Pending {
  resolve: (response: SidecarResponseWire) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const RESTART_BACKOFF_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
// A from-scratch backfill is up to ~750 sequential HTTP requests with a
// politeness delay between each (P14§3) -- minutes, not seconds. The user's
// escape hatch is Stop (cancelCurrent), not this ceiling.
export const BACKFILL_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

export class SidecarSupervisor extends EventEmitter {
  private readonly binaryPath: string;
  private readonly lakeRoot: string;
  private readonly spawnFn: SpawnFn;
  private readonly requestTimeoutMs: number;
  private child: ChildProcessLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stdoutBuffer = "";
  private stopped = false;
  private cancelling = false;
  private readonly dayProgress = new Map<number, (index: number, total: number) => void>();

  constructor(options: SidecarSupervisorOptions) {
    super();
    this.binaryPath = options.binaryPath;
    this.lakeRoot = options.lakeRoot;
    this.spawnFn = options.spawnFn ?? ((command, args) => spawn(command, args) as unknown as ChildProcessLike);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  start(): void {
    this.stopped = false;
    this.spawnChild();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const waiting of this.pending.values()) clearTimeout(waiting.timer);
    this.child?.kill();
    this.child = null;
  }

  cancelCurrent(): void {
    if (!this.child) return;
    this.cancelling = true;
    this.child.kill();
  }

  compute(
    symbol: string,
    timeframe: string,
    horizon: string,
    candles: CandleWire[],
    onRequestId?: (id: number) => void,
  ): Promise<ComputeResponseWire> {
    return this.send(
      { type: "compute", id: this.nextId, symbol, timeframe, horizon, candles },
      onRequestId,
    ) as Promise<ComputeResponseWire>;
  }

  persistCandles(
    symbol: string,
    timeframe: string,
    candles: CandleWire[],
    source = "kite",
  ): Promise<PersistCandlesResponseWire> {
    return this.send({
      type: "persist_candles",
      id: this.nextId,
      symbol,
      timeframe,
      source,
      candles,
    }) as Promise<PersistCandlesResponseWire>;
  }

  addWatchlistSymbol(symbol: string): Promise<WatchlistResponseWire> {
    return this.send({ type: "add_watchlist_symbol", id: this.nextId, symbol }) as Promise<WatchlistResponseWire>;
  }

  removeWatchlistSymbol(symbol: string): Promise<WatchlistResponseWire> {
    return this.send({ type: "remove_watchlist_symbol", id: this.nextId, symbol }) as Promise<WatchlistResponseWire>;
  }

  listWatchlist(): Promise<WatchlistResponseWire> {
    return this.send({ type: "list_watchlist", id: this.nextId }) as Promise<WatchlistResponseWire>;
  }

  evaluateScanGate(symbol: string, confluence: ConfluenceWire): Promise<ScanGateResponseWire> {
    return this.send({ type: "evaluate_scan_gate", id: this.nextId, symbol, confluence }) as Promise<ScanGateResponseWire>;
  }

  listLakeSymbols(): Promise<LakeSymbolsResponseWire> {
    return this.send({ type: "list_lake_symbols", id: this.nextId }) as Promise<LakeSymbolsResponseWire>;
  }

  readLakeCandles(symbol: string, timeframe: string, source: string): Promise<LakeCandlesResponseWire> {
    return this.send({ type: "read_lake_candles", id: this.nextId, symbol, timeframe, source }) as Promise<LakeCandlesResponseWire>;
  }

  benchmarkCompute(symbol: string, timeframe: string, horizon: string, candles: CandleWire[], algoId: string): Promise<BenchmarkComputeResponseWire> {
    return this.send({
      type: "benchmark_compute",
      id: this.nextId,
      symbol,
      timeframe,
      horizon,
      candles,
      algo_id: algoId,
    }) as Promise<BenchmarkComputeResponseWire>;
  }

  listAlgorithms(): Promise<ListAlgorithmsResponseWire> {
    return this.send({ type: "list_algorithms", id: this.nextId }) as Promise<ListAlgorithmsResponseWire>;
  }

  ensureDayBackfill(
    symbol: string,
    algoId: string,
    onDayProgress?: (index: number, total: number) => void,
  ): Promise<DayBackfillResponseWire> {
    return this.send(
      { type: "ensure_day_backfill", id: this.nextId, symbol, algo_id: algoId },
      (id) => {
        if (onDayProgress) this.dayProgress.set(id, onDayProgress);
      },
      BACKFILL_REQUEST_TIMEOUT_MS,
    ) as Promise<DayBackfillResponseWire>;
  }

  evaluateScanGateStateless(prev: ConfluenceWire | null, curr: ConfluenceWire): Promise<ScanGateResponseWire> {
    return this.send({ type: "evaluate_scan_gate_stateless", id: this.nextId, prev, curr }) as Promise<ScanGateResponseWire>;
  }

  private send(
    request: SidecarRequestWire,
    onRequestId?: (id: number) => void,
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<SidecarResponseWire> {
    const id = this.nextId++;
    onRequestId?.(id);
    request.id = id;
    return new Promise<SidecarResponseWire>((resolve, reject) => {
      if (!this.child) {
        this.dayProgress.delete(id);
        reject(new Error("sidecar is not running"));
        return;
      }
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.dayProgress.delete(id);
          reject(new Error(`sidecar request ${id} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(encodeRequest(request));
    });
  }

  private spawnChild(): void {
    const child = this.spawnFn(this.binaryPath, ["--lake-root", this.lakeRoot]);
    this.child = child;
    this.emitStatus("up");

    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk.toString()));
    child.on("exit", (code: number | null) => this.onExit(code));
  }

  private onStdout(text: string): void {
    this.stdoutBuffer += text;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim().length > 0) this.dispatch(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    let parsed: SidecarProgressWire | SidecarResponseWire;
    try {
      parsed = JSON.parse(line) as SidecarProgressWire | SidecarResponseWire;
    } catch (error) {
      console.error(`sidecar: failed to parse response line: ${(error as Error).message}`, line);
      return;
    }
    if (parsed.type === "progress") {
      const counted = this.dayProgress.get(parsed.id);
      if (counted && parsed.index !== undefined && parsed.total !== undefined) {
        counted(parsed.index, parsed.total);
      }
      this.emit("progress", parsed);
      return;
    }
    const waiting = this.pending.get(parsed.id);
    if (!waiting) return;
    this.pending.delete(parsed.id);
    this.dayProgress.delete(parsed.id);
    clearTimeout(waiting.timer);
    waiting.resolve(parsed);
  }

  private onExit(code: number | null): void {
    this.child = null;
    const wasCancelling = this.cancelling;
    this.cancelling = false;
    const error = wasCancelling
      ? Object.assign(new Error("sidecar run cancelled"), { cancelled: true })
      : new Error(`sidecar exited (code ${code ?? "null"})`);
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
    this.dayProgress.clear();

    if (this.stopped) {
      this.emitStatus("down");
      return;
    }
    this.emitStatus("restarting");
    setTimeout(() => {
      if (!this.stopped) this.spawnChild();
    }, RESTART_BACKOFF_MS);
  }

  private emitStatus(status: SidecarStatus): void {
    this.emit("statusChange", status);
  }
}
