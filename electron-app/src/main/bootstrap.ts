import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { mainWindowOptions } from "./mainWindow";
import { SidecarSupervisor } from "./services/sidecar/sidecarSupervisor";
import { KiteSessionState } from "./kiteSessionState";
import { registerStatusBridge } from "./ipc/appBridge";
import type { AppStatus, BannerEvent, SidecarStatus } from "./ipc/rendererApi";

export interface AppRuntime {
  start(): void;
  stop(): void;
}

export function createApp(): AppRuntime {
  const supervisor = new SidecarSupervisor({
    binaryPath:
      process.env.SIDECAR_BINARY ??
      path.join(__dirname, "..", "..", "..", "rust-core", "target", "debug", "sidecar"),
    lakeRoot: process.env.TRADE_ASSISTANT_LAKE ?? path.join(app.getPath("userData"), "candle-lake"),
  });
  const sessionState = new KiteSessionState();

  let sidecarStatus: SidecarStatus = "down";
  let driftWarning: string | null = null;
  const bannerHandlers: ((banner: BannerEvent) => void)[] = [];

  supervisor.on("statusChange", (status: SidecarStatus) => {
    sidecarStatus = status;
  });
  sessionState.on("banner", (banner: BannerEvent) =>
    bannerHandlers.forEach((handler) => handler(banner)),
  );

  const currentStatus = (): AppStatus => ({
    sidecar: sidecarStatus,
    kiteSession: sessionState.status,
    driftWarning,
  });

  const createMainWindow = (): BrowserWindow => {
    const window = new BrowserWindow(
      mainWindowOptions(path.join(__dirname, "..", "preload", "preload.js")),
    );
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|mailto):/.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    registerStatusBridge({
      ipcMain,
      getStatus: currentStatus,
      onBanner: (handler) => bannerHandlers.push(handler),
      sendToRenderer: (channel, payload) => window.webContents.send(channel, payload),
    });
    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl) window.loadURL(rendererUrl);
    else window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
    return window;
  };

  return {
    start: () => {
      supervisor.start();
      createMainWindow();
    },
    stop: () => {
      supervisor.stop();
    },
  };
}
