import { KiteInstrumentMaster } from "./kiteInstrumentMaster";
import { createKiteRestCaller } from "./kiteRestCaller";
import { createKiteTicker } from "./kiteTicker";
import type { KiteTickerClient } from "./kiteTicker";
import { captureRequestToken, exchangeAccessToken } from "./kiteOAuth";
import { KiteClient } from "./kiteClient";
import type { KiteConfig } from "./kiteConfig";

export interface KiteLoginDeps {
  config: KiteConfig;
  cacheDir: string;
  captureRequestToken: typeof captureRequestToken;
  exchangeAccessToken: typeof exchangeAccessToken;
  postForm: (url: string, form: Record<string, string>) => Promise<unknown>;
  openExternal: (url: string) => void;
  onKiteResponse?: (response: unknown) => void;
  createRestCaller?: typeof createKiteRestCaller;
  createTicker?: typeof createKiteTicker;
  existingTicker?: KiteTickerClient;
}

export interface KiteSession {
  kite: KiteClient;
  ticker: KiteTickerClient;
}

function extractAccessToken(tokenResponse: unknown): string {
  const token = (tokenResponse as { data?: { access_token?: unknown } })?.data?.access_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("kite session/token response did not include data.access_token");
  }
  return token;
}

export async function runKiteLogin(deps: KiteLoginDeps): Promise<KiteSession> {
  const { apiKey, apiSecret, loginPort } = deps.config;
  const loginUrl = `https://kite.zerodha.com/connect/login?api_key=${encodeURIComponent(apiKey)}&v=3`;
  const requestToken = await deps.captureRequestToken({ port: loginPort, loginUrl, openExternal: deps.openExternal });
  const tokenResponse = await deps.exchangeAccessToken({ apiKey, apiSecret, requestToken, postForm: deps.postForm });
  const accessToken = extractAccessToken(tokenResponse);

  const instrumentMaster = new KiteInstrumentMaster({ apiKey, accessToken, cacheDir: deps.cacheDir });
  const createRestCaller = deps.createRestCaller ?? createKiteRestCaller;
  const caller = createRestCaller({ apiKey, accessToken, instrumentMaster });
  const kite = new KiteClient(caller, { onResponse: deps.onKiteResponse });

  const ticker = deps.existingTicker ?? (deps.createTicker ?? createKiteTicker)(apiKey, accessToken);
  ticker.updateCredentialsAndConnect(apiKey, accessToken);

  return { kite, ticker };
}
