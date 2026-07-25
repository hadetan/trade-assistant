import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { toToolCaller, toToolListing } from "./mcpClientAdapter";
import type { McpToolCaller } from "./kiteClient";
import type { ToolListing } from "./mcpDriftMonitor";

const DEFAULT_MCP_URL = "https://mcp.kite.trade/mcp";

interface SdkLikeClient {
  callTool(a: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  listTools(): Promise<{ tools: { name: string }[] }>;
  close(): Promise<void>;
}

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
  // Lazy require keeps this module importable under Vitest's node env without an
  // electron runtime; the real path runs only in the packaged/dev app.
  const { app } = require("electron") as typeof import("electron");
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
