import type { McpToolCaller } from "./kiteClient";
import type { ToolListing } from "./mcpDriftMonitor";

interface SdkCallClient {
  callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

interface SdkListClient {
  listTools(): Promise<{ tools: { name: string }[] }>;
}

export function toToolCaller(client: SdkCallClient): McpToolCaller {
  return {
    callTool: (name, args) => client.callTool({ name, arguments: args }),
  };
}

export function toToolListing(client: SdkListClient): ToolListing {
  return {
    listTools: async () => (await client.listTools()).tools.map((tool) => tool.name),
  };
}
