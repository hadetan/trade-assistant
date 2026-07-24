import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import {
  CandleWire,
  ComputeResponseWire,
  PersistCandlesResponseWire,
  SidecarRequestWire,
  SidecarResponseWire,
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
}

interface Pending {
  resolve: (response: SidecarResponseWire) => void;
  reject: (error: Error) => void;
}

const RESTART_BACKOFF_MS = 500;

export class SidecarSupervisor extends EventEmitter {
  private readonly binaryPath: string;
  private readonly lakeRoot: string;
  private readonly spawnFn: SpawnFn;
  private child: ChildProcessLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stdoutBuffer = "";
  private stopped = false;

  constructor(options: SidecarSupervisorOptions) {
    super();
    this.binaryPath = options.binaryPath;
    this.lakeRoot = options.lakeRoot;
    this.spawnFn = options.spawnFn ?? ((command, args) => spawn(command, args) as unknown as ChildProcessLike);
  }

  start(): void {
    this.stopped = false;
    this.spawnChild();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.child?.kill();
    this.child = null;
  }

  compute(symbol: string, timeframe: string, closes: number[]): Promise<ComputeResponseWire> {
    return this.send({ type: "compute", id: this.nextId, symbol, timeframe, closes }) as Promise<ComputeResponseWire>;
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

  private send(request: SidecarRequestWire): Promise<SidecarResponseWire> {
    const id = this.nextId++;
    request.id = id;
    return new Promise<SidecarResponseWire>((resolve, reject) => {
      if (!this.child) {
        reject(new Error("sidecar is not running"));
        return;
      }
      this.pending.set(id, { resolve, reject });
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
    let response: SidecarResponseWire;
    try {
      response = JSON.parse(line) as SidecarResponseWire;
    } catch (error) {
      console.error(`sidecar: failed to parse response line: ${(error as Error).message}`, line);
      return;
    }
    const waiting = this.pending.get(response.id);
    if (!waiting) return;
    this.pending.delete(response.id);
    waiting.resolve(response);
  }

  private onExit(code: number | null): void {
    this.child = null;
    const error = new Error(`sidecar exited (code ${code ?? "null"})`);
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();

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
