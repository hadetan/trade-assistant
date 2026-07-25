import { app, BrowserWindow, ipcMain, shell } from "electron";
import dotenv from "dotenv";
import path from "node:path";
import { mainWindowOptions } from "./mainWindow";
import { SidecarSupervisor } from "./services/sidecar/sidecarSupervisor";
import { KiteSessionState } from "./services/kite/kiteSessionState";
import { loadKiteConfig } from "./services/kite/kiteConfig";
import { runKiteLogin } from "./services/kite/kiteLogin";
import type { KiteSession } from "./services/kite/kiteLogin";
import { captureRequestToken, exchangeAccessToken } from "./services/kite/kiteOAuth";
import { registerStatusBridge } from "./ipc/appBridge";
import { registerAnalysisBridge } from "./ipc/analysisBridge";
import type { AppStatus, BannerEvent, LoginResult, SidecarStatus } from "./ipc/rendererApi";

export interface AppRuntime {
  start(): void;
  stop(): void;
}

async function postForm(url: string, form: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Kite-Version": "3" },
    body: new URLSearchParams(form).toString(),
  });
  return response.json();
}

export function createApp(): AppRuntime {
  // loadKiteConfig reads process.env directly; nothing else in this codebase
  // populates it from electron-app/.env, so this must run first.
  dotenv.config({ path: path.join(app.getAppPath(), ".env") });
  const config = loadKiteConfig();
  const supervisor = new SidecarSupervisor({
    binaryPath:
      process.env.SIDECAR_BINARY ??
      path.join(__dirname, "..", "..", "..", "rust-core", "target", "debug", "sidecar"),
    lakeRoot: process.env.TRADE_ASSISTANT_LAKE ?? path.join(app.getPath("userData"), "candle-lake"),
  });
  const sessionState = new KiteSessionState();

  let sidecarStatus: SidecarStatus = "down";
  let driftWarning: string | null = null;
  let session: KiteSession | null = null;
  const bannerHandlers: ((banner: BannerEvent) => void)[] = [];

  supervisor.on("statusChange", (status: SidecarStatus) => {
    sidecarStatus = status;
  });
  sessionState.on("banner", (banner: BannerEvent) => bannerHandlers.forEach((handler) => handler(banner)));

  const currentStatus = (): AppStatus => ({ sidecar: sidecarStatus, kiteSession: sessionState.status, driftWarning });

  const login = async (): Promise<LoginResult> => {
    try {
      session = await runKiteLogin({
        config,
        captureRequestToken,
        exchangeAccessToken,
        postForm,
        openExternal: (url) => shell.openExternal(url),
      });
      if (session.drift.hasDrift) {
        driftWarning = `MCP tools changed: added [${session.drift.added.join(", ")}], removed [${session.drift.removed.join(", ")}]`;
        const banner: BannerEvent = { kind: "mcpDrift", message: driftWarning };
        bannerHandlers.forEach((handler) => handler(banner));
      }
      sessionState.markAuthenticated();
      return { status: "authenticated" };
    } catch (error) {
      sessionState.markNeedsLogin();
      return { status: "error", message: (error as Error).message };
    }
  };

  const createMainWindow = (): BrowserWindow => {
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
    registerAnalysisBridge({ ipcMain, login, getSession: () => session, sidecar: supervisor });
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
      void session?.close();
      supervisor.stop();
    },
  };
}
