import type { IpcMain } from "electron";
import type { LiveSessionRunner, StartLiveSessionParams } from "../services/market/liveSessionRunner";

export interface LiveBridgeDeps {
  ipcMain: Pick<IpcMain, "handle">;
  runner: Pick<LiveSessionRunner, "start" | "stop">;
}

export function registerLiveBridge(deps: LiveBridgeDeps): void {
  deps.ipcMain.handle("live:start", (_event, params: StartLiveSessionParams) => {
    deps.runner.start(params);
  });
  deps.ipcMain.handle("live:stop", () => {
    deps.runner.stop();
  });
}
