import type { KiteFullConfig, KiteMcpOnlyConfig } from "./kiteConfig";
import { captureRequestToken, exchangeAccessToken } from "./kiteOAuth";
import { KiteClient } from "./kiteClient";
import { connectKiteMcp, connectKiteMcpOAuth } from "./mcpConnection";
import type { ConnectKiteMcpDeps, ConnectKiteMcpOAuthDeps, McpConnection } from "./mcpConnection";
import { checkKiteToolDrift } from "./mcpDriftMonitor";
import type { DriftResult, ToolListing } from "./mcpDriftMonitor";

export interface KiteLoginDeps {
  config: KiteFullConfig;
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

  const loginUrl = `https://kite.zerodha.com/connect/login?api_key=${encodeURIComponent(apiKey)}&v=3`;
  const requestToken = await deps.captureRequestToken({ port: loginPort, loginUrl, openExternal: deps.openExternal });
  const tokenResponse = await deps.exchangeAccessToken({ apiKey, apiSecret, requestToken, postForm: deps.postForm });
  const accessToken = extractAccessToken(tokenResponse);

  const connection = await connectMcp({ apiKey, accessToken });
  try {
    const kite = new KiteClient(connection.caller, { onResponse: deps.onKiteResponse });
    const drift = await checkDrift(connection.listing);
    return { kite, connection, drift, close: connection.close };
  } catch (error) {
    // checkDrift is a real network call (mcp.kite.trade's tools/list); if it
    // fails after connectMcp already opened the connection, close it here —
    // the caller only sees this rejection, never the open connection.
    await connection.close().catch(() => {});
    throw error;
  }
}

export interface KiteMcpOnlyLoginDeps {
  config: KiteMcpOnlyConfig;
  openExternal: (url: string) => void;
  connectMcp?: (d: ConnectKiteMcpOAuthDeps) => Promise<McpConnection>;
  checkDrift?: (listing: ToolListing) => Promise<DriftResult>;
  onKiteResponse?: (response: unknown) => void;
}

export async function runKiteMcpOnlyLogin(deps: KiteMcpOnlyLoginDeps): Promise<KiteSession> {
  const connectMcp = deps.connectMcp ?? connectKiteMcpOAuth;
  const checkDrift = deps.checkDrift ?? checkKiteToolDrift;
  const { loginPort } = deps.config;

  const connection = await connectMcp({ loginPort, openExternal: deps.openExternal });
  try {
    const kite = new KiteClient(connection.caller, { onResponse: deps.onKiteResponse });
    const drift = await checkDrift(connection.listing);
    return { kite, connection, drift, close: connection.close };
  } catch (error) {
    // Mirrors runKiteLogin: checkDrift is a real tools/list network call; if it
    // fails after connectMcp already opened the connection, close it here so the
    // caller only sees the rejection, never a leaked open connection.
    await connection.close().catch(() => {});
    throw error;
  }
}
