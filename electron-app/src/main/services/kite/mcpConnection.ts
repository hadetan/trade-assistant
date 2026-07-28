import { app } from "electron";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { toToolCaller, toToolListing } from "./mcpClientAdapter";
import type { SdkCallClient, SdkListClient } from "./mcpClientAdapter";
import type { McpToolCaller } from "./kiteClient";
import type { ToolListing } from "./mcpDriftMonitor";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { KiteMcpOAuthProvider } from "./kiteMcpOAuthProvider";
import { captureOAuthCallback } from "./kiteMcpOAuthCallback";

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

type OAuthCapableSdkClient = SdkLikeClient & { connect(transport: unknown): Promise<void> };
interface OAuthTransport { finishAuth(code: string): Promise<void>; }

export interface ConnectKiteMcpOAuthDeps {
  loginPort: number;
  openExternal: (url: string) => void;
  url?: string;
  // Injection seams for unit tests; defaults build the real SDK objects.
  createProvider?: (opts: { loginPort: number; openExternal: (url: string) => void }) => OAuthClientProvider;
  createClient?: (opts: { url: string; provider: OAuthClientProvider }) => {
    client: OAuthCapableSdkClient;
    transport: OAuthTransport;
  };
  captureCallback?: (opts: { port: number; signal?: AbortSignal }) => Promise<{ code: string; state: string | null }>;
}

function defaultCreateOAuthProvider(opts: { loginPort: number; openExternal: (url: string) => void }): OAuthClientProvider {
  return new KiteMcpOAuthProvider(opts);
}

function defaultCreateOAuthClient(opts: { url: string; provider: OAuthClientProvider }): {
  client: OAuthCapableSdkClient;
  transport: OAuthTransport;
} {
  const transport = new StreamableHTTPClientTransport(new URL(opts.url), { authProvider: opts.provider });
  const client = new Client({ name: "trade-assistant", version: app.getVersion() }, {});
  return { client: client as unknown as OAuthCapableSdkClient, transport: transport as unknown as OAuthTransport };
}

export async function connectKiteMcpOAuth(deps: ConnectKiteMcpOAuthDeps): Promise<McpConnection> {
  const url = deps.url ?? DEFAULT_MCP_URL;
  const provider = (deps.createProvider ?? defaultCreateOAuthProvider)({
    loginPort: deps.loginPort,
    openExternal: deps.openExternal,
  });
  const capture = deps.captureCallback ?? captureOAuthCallback;
  const { client, transport } = (deps.createClient ?? defaultCreateOAuthClient)({ url, provider });

  const abort = new AbortController();
  const callbackPromise = capture({ port: deps.loginPort, signal: abort.signal });
  try {
    await client.connect(transport);
    // A fresh in-memory provider has no tokens, so connect normally throws
    // UnauthorizedError after opening the browser. Reaching here means it
    // authorized with no redirect — no callback will arrive, so stop listening.
    abort.abort();
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) {
      abort.abort();
      throw error;
    }
    const { code } = await callbackPromise;
    await transport.finishAuth(code);
    await client.connect(transport);
  }
  return {
    caller: toToolCaller(client),
    listing: toToolListing(client),
    close: () => client.close(),
  };
}
