import type { IpcMain } from "electron";
import type { AppStatus, BannerEvent } from "./rendererApi";

export interface StatusBridgeDeps {
  ipcMain: IpcMain;
  getStatus: () => AppStatus;
  onBanner: (handler: (banner: BannerEvent) => void) => void;
  sendToRenderer: (channel: string, payload: unknown) => void;
}

export function registerStatusBridge(deps: StatusBridgeDeps): void {
  deps.ipcMain.handle("status:get", () => deps.getStatus());
  deps.onBanner((banner) => deps.sendToRenderer("banner:push", banner));
}
