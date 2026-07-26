import type { KiteConfig } from "./kiteConfig";
import { captureRequestToken, exchangeAccessToken } from "./kiteOAuth";
import { KiteClient } from "./kiteClient";
import { connectKiteMcp } from "./mcpConnection";
import type { ConnectKiteMcpDeps, McpConnection } from "./mcpConnection";
import { checkKiteToolDrift } from "./mcpDriftMonitor";
import type { DriftResult, ToolListing } from "./mcpDriftMonitor";

export interface KiteLoginDeps {
  config: KiteConfig;
  captureRequestToken: typeof captureRequestToken;
  exchangeAccessToken: typeof exchangeAccessToken;
  postForm: (url: string, form: Record<string, string>) => Promise<unknown>;
  openExternal: (url: string) => void;
  connectMcp?: (d: ConnectKiteMcpDeps) => Promise<McpConnection>;
  checkDrift?: (listing: ToolListing) => Promise<DriftResult>;
  onKiteResponse?: (response: unknown) => void;
}

export interface KiteSession {
  kite: KiteClient;
  connection: McpConnection;
  drift: DriftResult;
  close(): Promise<void>;
}

function extractAccessToken(tokenResponse: unknown): string {
  const token = (tokenResponse as { data?: { access_token?: unknown } })?.data?.access_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("kite session/token response did not include data.access_token");
  }
  return token;
}

export async function runKiteLogin(deps: KiteLoginDeps): Promise<KiteSession> {
  const connectMcp = deps.connectMcp ?? connectKiteMcp;
  const checkDrift = deps.checkDrift ?? checkKiteToolDrift;
  const { apiKey, apiSecret, loginPort } = deps.config;

  const loginUrl = `https://kite.zerodha.com/connect/login?api_key=${apiKey}&v=3`;
  const requestToken = await deps.captureRequestToken({ port: loginPort, loginUrl, openExternal: deps.openExternal });
  const tokenResponse = await deps.exchangeAccessToken({ apiKey, apiSecret, requestToken, postForm: deps.postForm });
  const accessToken = extractAccessToken(tokenResponse);

  const connection = await connectMcp({ apiKey, accessToken });
  const kite = new KiteClient(connection.caller, { onResponse: deps.onKiteResponse });
  const drift = await checkDrift(connection.listing);

  return { kite, connection, drift, close: connection.close };
}
