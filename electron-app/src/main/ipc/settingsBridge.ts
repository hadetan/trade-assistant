import type { IpcMain } from "electron";
import type { HistoryStore, ScanConfig } from "../services/history/historyStore";
import type { ScanScheduler } from "../scanScheduler";
import type { SidecarSupervisor } from "../services/sidecar/sidecarSupervisor";
import type { AppStatus } from "./rendererApi";

export interface SettingsBridgeDeps {
  ipcMain: Pick<IpcMain, "handle">;
  history: Pick<HistoryStore, "getScanConfig" | "setScanConfig">;
  scanScheduler: Pick<ScanScheduler, "setConfig">;
  sidecar: Pick<SidecarSupervisor, "listWatchlist" | "addWatchlistSymbol" | "removeWatchlistSymbol">;
  getStatus: () => AppStatus;
}

export function registerSettingsBridge(deps: SettingsBridgeDeps): void {
  deps.ipcMain.handle("settings:getScanConfig", () => deps.history.getScanConfig());
  deps.ipcMain.handle("settings:setScanConfig", (_event, config: ScanConfig) => {
    deps.history.setScanConfig(config);
    deps.scanScheduler.setConfig(config);
    return deps.history.getScanConfig();
  });
  deps.ipcMain.handle("settings:listWatchlist", async () => (await deps.sidecar.listWatchlist()).symbols);
  deps.ipcMain.handle("settings:addWatchlistSymbol", async (_event, args: { symbol: string }) =>
    (await deps.sidecar.addWatchlistSymbol(args.symbol)).symbols,
  );
  deps.ipcMain.handle("settings:removeWatchlistSymbol", async (_event, args: { symbol: string }) =>
    (await deps.sidecar.removeWatchlistSymbol(args.symbol)).symbols,
  );
  deps.ipcMain.handle("settings:getAccountStatus", () => deps.getStatus());
}
