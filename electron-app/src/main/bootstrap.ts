import { app, BrowserWindow, ipcMain, Notification, shell, type Tray } from "electron";
import dotenv from "dotenv";
import path from "node:path";
import { mainWindowOptions } from "./mainWindow";
import { settingsWindowOptions } from "./settingsWindow";
import { SidecarSupervisor } from "./services/sidecar/sidecarSupervisor";
import { KiteSessionState, classifyKiteResponse } from "./services/kite/kiteSessionState";
import { loadKiteConfig } from "./services/kite/kiteConfig";
import { runKiteLogin } from "./services/kite/kiteLogin";
import type { KiteSession } from "./services/kite/kiteLogin";
import { captureRequestToken, exchangeAccessToken } from "./services/kite/kiteOAuth";
import { ClaudeCliProvider } from "./services/claude/claudeCliProvider";
import { registerStatusBridge } from "./ipc/appBridge";
import { registerAnalysisBridge } from "./ipc/analysisBridge";
import { registerHistoryBridge } from "./ipc/historyBridge";
import { registerSettingsBridge } from "./ipc/settingsBridge";
import { makeNarrativeSender } from "./ipc/narrativeBridge";
import { HistoryStore } from "./services/history/historyStore";
import { ScanScheduler } from "./scanScheduler";
import { createTray } from "./tray";
import type { AppStatus, BannerEvent, KiteSessionStatus, LoginResult, SidecarStatus } from "./ipc/rendererApi";

export interface AppRuntime {
  start(): void;
  stop(): void;
  showMainWindow(): void;
  isScanningEnabled(): boolean;
}

// classifyKiteResponse fails closed: ordinary successful reads (search
// results, quotes, candles) match neither the needsLogin nor the
// authenticated shape and classify as "unknown". Calling the general
// sessionState.observe() here on every resolved response would downgrade an
// authenticated session to "unknown" after the very next ordinary call, so
// this only ever acts on the needsLogin verdict — mirrors
// looksLikeSessionExpiry's one-directional check on thrown errors.
export function handleKiteResponse(sessionState: KiteSessionState, response: unknown): void {
  if (classifyKiteResponse(response) === "needsLogin") sessionState.markNeedsLogin();
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
  const provider = new ClaudeCliProvider();
  const history = new HistoryStore({
    path: process.env.TRADE_ASSISTANT_HISTORY_DB ?? path.join(app.getPath("userData"), "history.sqlite3"),
  });

  let sidecarStatus: SidecarStatus = "down";
  let driftWarning: string | null = null;
  let session: KiteSession | null = null;
  let loginInFlight: Promise<LoginResult> | null = null;
  let mainWindow: BrowserWindow | null = null;
  let settingsWindow: BrowserWindow | null = null;
  // Retained so Electron does not garbage-collect the tray icon (a documented
  // Electron gotcha for an otherwise-unreferenced Tray).
  let tray: Tray | null = null;
  const bannerHandlers: ((banner: BannerEvent) => void)[] = [];

  const dispatchBanner = (banner: BannerEvent): void => bannerHandlers.forEach((handler) => handler(banner));

  supervisor.on("statusChange", (status: SidecarStatus) => {
    sidecarStatus = status;
  });
  sessionState.on("banner", dispatchBanner);
  // Once the session state moves to needsLogin — whether from a live
  // response/rejection classified as expired, or a failed re-login attempt
  // below — the previous connection is no longer trustworthy. Closing and
  // clearing it here (rather than only at quit) keeps `session` consistent
  // with what the "needs login" banner is telling the user: kite:*
  // IPC calls should reject with "not logged in", not keep succeeding
  // against a stale connection.
  sessionState.on("change", (status: KiteSessionStatus) => {
    if (status === "needsLogin" && session) {
      const closing = session;
      session = null;
      void closing.close().catch(() => {});
    }
  });

  const currentStatus = (): AppStatus => ({ sidecar: sidecarStatus, kiteSession: sessionState.status, driftWarning });

  const login = (): Promise<LoginResult> => {
    if (loginInFlight) return loginInFlight;
    loginInFlight = (async (): Promise<LoginResult> => {
      try {
        const previousSession = session;
        const newSession = await runKiteLogin({
          config,
          captureRequestToken,
          exchangeAccessToken,
          postForm,
          openExternal: (url) => shell.openExternal(url),
          onKiteResponse: (response) => handleKiteResponse(sessionState, response),
        });
        // Defense in depth: the "change" listener above already closes a
        // session as soon as it goes stale, but close whatever is still
        // referenced here too so a redundant login() call can never leak it.
        if (previousSession && previousSession !== newSession) {
          void previousSession.close().catch(() => {});
        }
        session = newSession;
        driftWarning = newSession.drift.hasDrift
          ? `MCP tools changed: added [${newSession.drift.added.join(", ")}], removed [${newSession.drift.removed.join(", ")}]`
          : null;
        if (newSession.drift.hasDrift) {
          dispatchBanner({ kind: "mcpDrift", message: driftWarning as string });
        }
        sessionState.markAuthenticated();
        return { status: "authenticated" };
      } catch (error) {
        sessionState.markNeedsLogin();
        return { status: "error", message: (error as Error).message };
      } finally {
        loginInFlight = null;
      }
    })();
    return loginInFlight;
  };

  // Reads the current mainWindow at call time rather than closing over one fixed
  // window instance, so a recreated window (tray "Show"/activate) still receives
  // pushed banner/narrative events.
  const sendToRenderer = (channel: string, payload: unknown): void => {
    mainWindow?.webContents.send(channel, payload);
  };

  const createMainWindow = (): BrowserWindow => {
    const window = new BrowserWindow(mainWindowOptions(path.join(__dirname, "..", "preload", "preload.js")));
    mainWindow = window;
    window.on("closed", () => {
      mainWindow = null;
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|mailto):/.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl) window.loadURL(rendererUrl);
    else window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
    return window;
  };

  const showMainWindow = (): void => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    createMainWindow();
  };

  const createSettingsWindow = (): BrowserWindow => {
    const window = new BrowserWindow(settingsWindowOptions(path.join(__dirname, "..", "preload", "settingsPreload.js")));
    settingsWindow = window;
    window.on("closed", () => {
      settingsWindow = null;
    });
    // Mirrors createMainWindow's handler exactly: without it, this window falls
    // back to Electron's default of allowing window.open() for arbitrary URLs.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|mailto):/.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl) window.loadURL(`${rendererUrl}/settings.html`);
    else window.loadFile(path.join(__dirname, "..", "renderer", "settings.html"));
    return window;
  };

  const showSettingsWindow = (): void => {
    if (settingsWindow) {
      settingsWindow.show();
      settingsWindow.focus();
      return;
    }
    createSettingsWindow();
  };

  const sendScanNotification = (title: string, body: string): void => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body });
    // Resolves showMainWindow at click time (long after every const above is
    // assigned), so a notification click reaches whichever window is current.
    notification.on("click", () => showMainWindow());
    notification.show();
  };

  const scanScheduler = new ScanScheduler(
    {
      sidecar: supervisor,
      getKite: () => session?.kite ?? null,
      provider,
      history,
      notify: sendScanNotification,
    },
    history.getScanConfig(),
  );

  // IPC handlers are registered exactly once, decoupled from window creation:
  // ipcMain.handle throws on a second registration for the same channel, and
  // createMainWindow/createSettingsWindow can now run more than once (showMainWindow/
  // showSettingsWindow after a close).
  registerStatusBridge({
    ipcMain,
    getStatus: currentStatus,
    onBanner: (handler) => bannerHandlers.push(handler),
    sendToRenderer,
  });
  registerAnalysisBridge({
    ipcMain,
    login,
    getSession: () => session,
    sidecar: supervisor,
    provider,
    history,
    sendNarrative: makeNarrativeSender(sendToRenderer),
    markNeedsLogin: () => sessionState.markNeedsLogin(),
  });
  registerHistoryBridge({ ipcMain, history });
  registerSettingsBridge({ ipcMain, history, scanScheduler, sidecar: supervisor, getStatus: currentStatus });

  return {
    start: () => {
      supervisor.start();
      createMainWindow();
      tray = createTray({ showMainWindow, showSettingsWindow, quit: () => app.quit() });
    },
    stop: () => {
      // Stop the scheduler first, before the sidecar/history teardown it depends
      // on. stop() only clears the interval timer; a tick already in flight is
      // caught by tickOneSymbol's own try/catch if it hits a closed store.
      scanScheduler.stop();
      void session?.close().catch(() => {});
      history.close();
      supervisor.stop();
      tray?.destroy();
      tray = null;
    },
    showMainWindow,
    isScanningEnabled: () => scanScheduler.getConfig().enabled,
  };
}
