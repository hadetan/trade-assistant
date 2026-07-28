import { app } from "electron";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { toToolCaller, toToolListing } from "./mcpClientAdapter";
import type { SdkCallClient, SdkListClient } from "./mcpClientAdapter";
import type { McpToolCaller } from "./kiteClient";
import type { ToolListing } from "./mcpDriftMonitor";

const DEFAULT_MCP_URL = "https://mcp.kite.trade/mcp";

type SdkLikeClient = SdkCallClient & SdkListClient & { close(): Promise<void> };

export interface McpConnection {
  caller: McpToolCaller;
  listing: ToolListing;
  close(): Promise<void>;
}

export interface ConnectKiteMcpDeps {
  apiKey: string;
  accessToken: string;
  url?: string;
  createClient?: (params: { url: string; headers: Record<string, string> }) => Promise<SdkLikeClient>;
}

async function defaultCreateClient(params: { url: string; headers: Record<string, string> }): Promise<SdkLikeClient> {
  const transport = new StreamableHTTPClientTransport(new URL(params.url), {
    requestInit: { headers: params.headers },
  });
  const client = new Client({ name: "trade-assistant", version: app.getVersion() }, {});
  await client.connect(transport);
  return client as unknown as SdkLikeClient;
}

export async function connectKiteMcp(deps: ConnectKiteMcpDeps): Promise<McpConnection> {
  const url = deps.url ?? DEFAULT_MCP_URL;
  const headers = { Authorization: `token ${deps.apiKey}:${deps.accessToken}` };
  const createClient = deps.createClient ?? defaultCreateClient;
  const client = await createClient({ url, headers });
  return {
    caller: toToolCaller(client),
    listing: toToolListing(client),
    close: () => client.close(),
  };
}

export interface ConnectKiteMcpAnonymousDeps {
  url?: string;
  createClient?: (params: { url: string }) => Promise<SdkLikeClient>;
}

async function defaultCreateAnonymousClient(params: { url: string }): Promise<SdkLikeClient> {
  const transport = new StreamableHTTPClientTransport(new URL(params.url));
  const client = new Client({ name: "trade-assistant", version: app.getVersion() }, {});
  await client.connect(transport);
  return client as unknown as SdkLikeClient;
}

// mcp.kite.trade accepts an anonymous connect unconditionally (confirmed
// against the live endpoint: no WWW-Authenticate/401 challenge at the
// transport level) -- real login happens later, via the "login" tool itself
// (see kiteMcpLoginFlow.ts), not via the MCP Authorization spec's OAuth
// discovery/DCR/PKCE flow.
export async function connectKiteMcpAnonymous(deps: ConnectKiteMcpAnonymousDeps = {}): Promise<McpConnection> {
  const url = deps.url ?? DEFAULT_MCP_URL;
  const createClient = deps.createClient ?? defaultCreateAnonymousClient;
  const client = await createClient({ url });
  return {
    caller: toToolCaller(client),
    listing: toToolListing(client),
    close: () => client.close(),
  };
}
