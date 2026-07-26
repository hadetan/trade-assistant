import { app, BrowserWindow, ipcMain, shell } from "electron";
import dotenv from "dotenv";
import path from "node:path";
import { mainWindowOptions } from "./mainWindow";
import { SidecarSupervisor } from "./services/sidecar/sidecarSupervisor";
import { KiteSessionState, classifyKiteResponse } from "./services/kite/kiteSessionState";
import { loadKiteConfig } from "./services/kite/kiteConfig";
import { runKiteLogin } from "./services/kite/kiteLogin";
import type { KiteSession } from "./services/kite/kiteLogin";
import { captureRequestToken, exchangeAccessToken } from "./services/kite/kiteOAuth";
import { ClaudeCliProvider } from "./services/claude/claudeCliProvider";
import { registerStatusBridge } from "./ipc/appBridge";
import { registerAnalysisBridge } from "./ipc/analysisBridge";
import { makeNarrativeSender } from "./ipc/narrativeBridge";
import type { AppStatus, BannerEvent, KiteSessionStatus, LoginResult, SidecarStatus } from "./ipc/rendererApi";

export interface AppRuntime {
  start(): void;
  stop(): void;
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

  let sidecarStatus: SidecarStatus = "down";
  let driftWarning: string | null = null;
  let session: KiteSession | null = null;
  let loginInFlight: Promise<LoginResult> | null = null;
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
    registerAnalysisBridge({
      ipcMain,
      login,
      getSession: () => session,
      sidecar: supervisor,
      provider,
      sendNarrative: makeNarrativeSender((channel, payload) => window.webContents.send(channel, payload)),
      markNeedsLogin: () => sessionState.markNeedsLogin(),
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
      void session?.close().catch(() => {});
      supervisor.stop();
    },
  };
}
