import { clipboard, type IpcMain } from "electron";
import type { SidecarSupervisor } from "../services/sidecar/sidecarSupervisor";
import { runBenchmark, horizonForTimeframe } from "../services/benchmark/benchmarkRunner";
import type { AlgorithmEntry, BenchmarkRunParams, LakeSymbolEntry } from "./rendererApi";

export interface BenchmarkBridgeDeps {
  ipcMain: Pick<IpcMain, "handle">;
  sidecar: Pick<
    SidecarSupervisor,
    "listLakeSymbols" | "listAlgorithms" | "readLakeCandles" | "benchmarkCompute" | "evaluateScanGateStateless" | "cancelCurrent"
  >;
}

export function registerBenchmarkBridge(deps: BenchmarkBridgeDeps): void {
  deps.ipcMain.handle("benchmark:listLakeSymbols", async (): Promise<LakeSymbolEntry[]> => {
    const { entries } = await deps.sidecar.listLakeSymbols();
    return entries.map((e) => ({
      symbol: e.symbol,
      timeframe: e.timeframe,
      source: e.source,
      fromTs: e.from_ts,
      toTs: e.to_ts,
      candleCount: e.candle_count,
      horizon: horizonForTimeframe(e.timeframe),
    }));
  });
  deps.ipcMain.handle("benchmark:listAlgorithms", async (): Promise<AlgorithmEntry[]> => {
    const { algorithms } = await deps.sidecar.listAlgorithms();
    return algorithms.map((a) => ({ id: a.id, cost: a.cost as "fast" | "slow", requiredLookback: a.required_lookback }));
  });
  deps.ipcMain.handle("benchmark:runBenchmark", (event, params: BenchmarkRunParams) =>
    runBenchmark({ sidecar: deps.sidecar }, params, (index, total) =>
      event.sender.send("benchmark:progress", { index, total }),
    ),
  );
  deps.ipcMain.handle("benchmark:cancelBenchmark", () => {
    deps.sidecar.cancelCurrent();
  });
  deps.ipcMain.handle("benchmark:copyToClipboard", (_event, text: string) => clipboard.writeText(text));
}
