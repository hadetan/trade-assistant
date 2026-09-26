import { KiteTicker } from "kiteconnect";

export type TickerConnectionStatus = "connected" | "reconnecting" | "error";

export interface KiteTickerClient {
  connect(): void;
  subscribe(instrumentTokens: number[], mode?: "ltp" | "quote" | "full"): void;
  onTick(handler: (ticks: unknown[]) => void): void;
  onConnectionChange(handler: (status: TickerConnectionStatus) => void): void;
  disconnect(): void;
}

// The subset of the kiteconnect npm package's real KiteTicker surface this
// wrapper depends on -- named so a test can inject a fake without importing
// the real (network-opening) class. Verified against kiteconnectjs's own
// lib/ticker.ts (github.com/zerodha/kiteconnectjs), not guessed from docs.
export interface KiteTickerLike {
  connect(): void;
  disconnect(): void;
  subscribe(tokens: number[]): void;
  setMode(mode: string, tokens: number[]): void;
  autoReconnect(enable: boolean, maxRetry: number, maxDelaySeconds: number): void;
  on(event: string, callback: (...args: unknown[]) => void): void;
  modeLTP: string;
  modeQuote: string;
  modeFull: string;
}

export interface KiteTickerFactoryDeps {
  createTicker?: (opts: { api_key: string; access_token: string }) => KiteTickerLike;
}

function defaultCreateTicker(opts: { api_key: string; access_token: string }): KiteTickerLike {
  return new KiteTicker(opts) as unknown as KiteTickerLike;
}

export function createKiteTicker(
  apiKey: string,
  accessToken: string,
  deps: KiteTickerFactoryDeps = {},
): KiteTickerClient {
  const ticker = (deps.createTicker ?? defaultCreateTicker)({ api_key: apiKey, access_token: accessToken });
  // -1 is a footgun, not "retry forever": kiteconnectjs's attemptReconnection()
  // checks `current_reconnection_count > reconnect_max_tries` and calls
  // process.exit(1) once that's true, so with max_retry = -1 the very first
  // disconnect (0 > -1) already trips it and kills the whole Electron main
  // process. 300 is the library's own documented maximum retry count --
  // passing anything higher has no additional effect -- so it's used here
  // to get the most real reconnect attempts the library supports.
  ticker.autoReconnect(true, 300, 5);

  const tickHandlers: ((ticks: unknown[]) => void)[] = [];
  const connectionHandlers: ((status: TickerConnectionStatus) => void)[] = [];
  const notifyConnection = (status: TickerConnectionStatus): void => connectionHandlers.forEach((h) => h(status));

  ticker.on("connect", () => notifyConnection("connected"));
  ticker.on("reconnect", () => notifyConnection("reconnecting"));
  ticker.on("noreconnect", () => notifyConnection("error"));
  ticker.on("error", () => notifyConnection("error"));
  ticker.on("ticks", (...args: unknown[]) => tickHandlers.forEach((h) => h(args[0] as unknown[])));

  return {
    connect: () => ticker.connect(),
    subscribe: (instrumentTokens, mode = "full") => {
      ticker.subscribe(instrumentTokens);
      const modeValue = mode === "ltp" ? ticker.modeLTP : mode === "quote" ? ticker.modeQuote : ticker.modeFull;
      ticker.setMode(modeValue, instrumentTokens);
    },
    onTick: (handler) => tickHandlers.push(handler),
    onConnectionChange: (handler) => connectionHandlers.push(handler),
    disconnect: () => ticker.disconnect(),
  };
}
