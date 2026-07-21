import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { mainWindowOptions } from "./mainWindow";
import { SidecarSupervisor } from "./sidecarSupervisor";
import { KiteSessionState } from "./kiteSessionState";
import { registerStatusBridge } from "./appBridge";
import type { AppStatus, BannerEvent, SidecarStatus } from "./rendererApi";

const supervisor = new SidecarSupervisor({
  binaryPath: process.env.SIDECAR_BINARY ?? path.join(__dirname, "..", "..", "..", "rust-core", "target", "debug", "sidecar"),
  lakeRoot: process.env.TRADE_ASSISTANT_LAKE ?? path.join(app.getPath("userData"), "candle-lake"),
});
const sessionState = new KiteSessionState();

let sidecarStatus: SidecarStatus = "down";
let driftWarning: string | null = null;
const bannerHandlers: ((banner: BannerEvent) => void)[] = [];

supervisor.on("statusChange", (status: SidecarStatus) => {
  sidecarStatus = status;
});
sessionState.on("banner", (banner: BannerEvent) => bannerHandlers.forEach((handler) => handler(banner)));

function currentStatus(): AppStatus {
  return { sidecar: sidecarStatus, kiteSession: sessionState.status, driftWarning };
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow(mainWindowOptions(path.join(__dirname, "..", "preload", "preload.js")));
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
}

app.whenReady().then(() => {
  supervisor.start();
  createMainWindow();
});

app.on("window-all-closed", () => {
  supervisor.stop();
  if (process.platform !== "darwin") app.quit();
});
