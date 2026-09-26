import { KiteTicker } from "kiteconnect";

export type TickerConnectionStatus = "connected" | "reconnecting" | "error";

export interface KiteTickerClient {
  connect(): void;
  updateCredentialsAndConnect(apiKey: string, accessToken: string): void;
  subscribe(instrumentTokens: number[], mode?: "ltp" | "quote" | "full"): void;
  // Both return an unsubscribe function. The ticker outlives every live
  // session (it is built once, on first login), so a handler that can only
  // ever be added would grow this client's handler lists for the lifetime of
  // the process -- once per liveSessionRunner.start().
  onTick(handler: (ticks: unknown[]) => void): () => void;
  onConnectionChange(handler: (status: TickerConnectionStatus) => void): () => void;
  disconnect(): void;
}

// The subset of the kiteconnect npm package's real KiteTicker surface this
// wrapper depends on -- named so a test can inject a fake without importing
// the real (network-opening) class. Verified against kiteconnectjs's own
// compiled source (dist/lib/ticker.js), not guessed from docs or types.
export interface KiteTickerLike {
  connect(): void;
  disconnect(): void;
  connected(): boolean;
  subscribe(tokens: number[]): void;
  setMode(mode: string, tokens: number[]): void;
  autoReconnect(enable: boolean, maxRetry: number, maxDelaySeconds: number): void;
  on(event: string, callback: (...args: unknown[]) => void): void;
  modeLTP: string;
  modeQuote: string;
  modeFull: string;
  api_key: string;
  access_token: string;
}

export interface KiteTickerFactoryDeps {
  createTicker?: (opts: { api_key: string; access_token: string }) => KiteTickerLike;
}

function defaultCreateTicker(opts: { api_key: string; access_token: string }): KiteTickerLike {
  return new KiteTicker(opts) as unknown as KiteTickerLike;
}

// Removes by reference, and only the first match, so registering the same
// function twice and unsubscribing once still leaves one live registration.
function removeHandler<T>(handlers: T[], handler: T): void {
  const index = handlers.indexOf(handler);
  if (index !== -1) handlers.splice(index, 1);
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
  // Dispatch over a snapshot: a handler is allowed to unsubscribe itself from
  // inside its own callback, which would otherwise shift the array mid-forEach
  // and skip the handler queued right after it.
  const notifyConnection = (status: TickerConnectionStatus): void =>
    [...connectionHandlers].forEach((h) => h(status));

  ticker.on("connect", () => notifyConnection("connected"));
  ticker.on("reconnect", () => notifyConnection("reconnecting"));
  ticker.on("noreconnect", () => notifyConnection("error"));
  ticker.on("error", () => notifyConnection("error"));
  ticker.on("ticks", (...args: unknown[]) => [...tickHandlers].forEach((h) => h(args[0] as unknown[])));

  return {
    connect: () => ticker.connect(),
    // connect() is a no-op if the socket is already open/connecting (verified
    // against the real library source), so this is always safe to call: on
    // first-ever login it establishes the initial connection; on every later
    // re-login it just updates the credentials the library will use the next
    // time it naturally reconnects. This library's disconnect() permanently
    // disables auto-reconnect at module scope for the rest of the process
    // (see the comment on the autoReconnect() call above), so there is no way
    // to force an immediate reconnect with the new token -- only a lazy one,
    // the next time the socket drops on its own.
    updateCredentialsAndConnect: (apiKey, accessToken) => {
      ticker.api_key = apiKey;
      ticker.access_token = accessToken;
      ticker.connect();
    },
    subscribe: (instrumentTokens, mode = "full") => {
      ticker.subscribe(instrumentTokens);
      const modeValue = mode === "ltp" ? ticker.modeLTP : mode === "quote" ? ticker.modeQuote : ticker.modeFull;
      ticker.setMode(modeValue, instrumentTokens);
    },
    onTick: (handler) => {
      tickHandlers.push(handler);
      return () => removeHandler(tickHandlers, handler);
    },
    onConnectionChange: (handler) => {
      connectionHandlers.push(handler);
      return () => removeHandler(connectionHandlers, handler);
    },
    disconnect: () => ticker.disconnect(),
  };
}
