import { describe, expect, it, vi } from "vitest";
import { connectKiteMcp } from "../../../../src/main/services/kite/mcpConnection";

function fakeClient() {
  return {
    callTool: vi.fn().mockResolvedValue({ ok: true }),
    listTools: vi.fn().mockResolvedValue({ tools: [{ name: "login" }, { name: "get_ltp" }] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("connectKiteMcp", () => {
  it("passes the Authorization header and default url to createClient", async () => {
    const client = fakeClient();
    const createClient = vi.fn().mockResolvedValue(client);

    await connectKiteMcp({ apiKey: "K", accessToken: "T", createClient });

    expect(createClient).toHaveBeenCalledWith({
      url: "https://mcp.kite.trade/mcp",
      headers: { Authorization: "token K:T" },
    });
  });

  it("adapts callTool and listTools through mcpClientAdapter", async () => {
    const client = fakeClient();
    const conn = await connectKiteMcp({ apiKey: "K", accessToken: "T", createClient: async () => client });

    await conn.caller.callTool("get_ltp", { instruments: ["NSE:INFY"] });
    expect(client.callTool).toHaveBeenCalledWith({ name: "get_ltp", arguments: { instruments: ["NSE:INFY"] } });
    expect(await conn.listing.listTools()).toEqual(["login", "get_ltp"]);
  });

  it("forwards close() to the underlying client", async () => {
    const client = fakeClient();
    const conn = await connectKiteMcp({ apiKey: "K", accessToken: "T", createClient: async () => client });

    await conn.close();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("honours a custom url", async () => {
    const createClient = vi.fn().mockResolvedValue(fakeClient());
    await connectKiteMcp({ apiKey: "K", accessToken: "T", url: "https://example.test/mcp", createClient });
    expect(createClient).toHaveBeenCalledWith({ url: "https://example.test/mcp", headers: { Authorization: "token K:T" } });
  });
});
