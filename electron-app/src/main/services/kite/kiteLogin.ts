import type { KiteFullConfig, KiteMcpOnlyConfig } from "./kiteConfig";
import { captureRequestToken, exchangeAccessToken } from "./kiteOAuth";
import { KiteClient } from "./kiteClient";
import { connectKiteMcp, connectKiteMcpAnonymous } from "./mcpConnection";
import type { ConnectKiteMcpDeps, ConnectKiteMcpAnonymousDeps, McpConnection } from "./mcpConnection";
import { checkKiteToolDrift } from "./mcpDriftMonitor";
import type { DriftResult, ToolListing } from "./mcpDriftMonitor";
import { extractKiteLoginUrl, pollForKiteLogin } from "./kiteMcpLoginFlow";
import type { PollForKiteLoginDeps } from "./kiteMcpLoginFlow";

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
  connectMcp?: (d: ConnectKiteMcpAnonymousDeps) => Promise<McpConnection>;
  checkDrift?: (listing: ToolListing) => Promise<DriftResult>;
  onKiteResponse?: (response: unknown) => void;
  verifyLogin?: PollForKiteLoginDeps["verifyLogin"];
  delayFn?: PollForKiteLoginDeps["delayFn"];
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export async function runKiteMcpOnlyLogin(deps: KiteMcpOnlyLoginDeps): Promise<KiteSession> {
  const connectMcp = deps.connectMcp ?? connectKiteMcpAnonymous;
  const checkDrift = deps.checkDrift ?? checkKiteToolDrift;

  const connection = await connectMcp({});
  try {
    const kite = new KiteClient(connection.caller, { onResponse: deps.onKiteResponse });
    // Kite's MCP server has no transport-level auth challenge (see
    // mcpConnection.ts's connectKiteMcpAnonymous) -- calling "login" is the
    // real mechanism: it returns a URL for the user to complete Zerodha login
    // in their browser, tied server-side to this same connection.
    const loginResponse = await kite.login();
    const loginUrl = extractKiteLoginUrl(loginResponse);
    deps.openExternal(loginUrl);
    // Do not mark this session authenticated until a real call actually
    // succeeds -- the server gives no synchronous "login complete" signal, so
    // this is the only way to avoid returning a session that looks fine but
    // fails on the first real use.
    await pollForKiteLogin({
      kite,
      verifyLogin: deps.verifyLogin,
      delayFn: deps.delayFn,
      pollIntervalMs: deps.pollIntervalMs,
      pollTimeoutMs: deps.pollTimeoutMs,
    });
    const drift = await checkDrift(connection.listing);
    return { kite, connection, drift, close: connection.close };
  } catch (error) {
    // Mirrors runKiteLogin: if anything above fails after connectMcp already
    // opened the connection, close it here so the caller only sees the
    // rejection, never a leaked open connection.
    await connection.close().catch(() => {});
    throw error;
  }
}
