import { describe, expect, it, vi } from "vitest";
import { toToolCaller, toToolListing } from "../../../../src/main/services/kite/mcpClientAdapter";

describe("mcpClientAdapter", () => {
  it("adapts callTool(name, args) to the SDK's { name, arguments } shape", async () => {
    const client = { callTool: vi.fn().mockResolvedValue({ ok: true }) };
    const caller = toToolCaller(client);

    await caller.callTool("get_quotes", { instruments: ["NSE:INFY"] });

    expect(client.callTool).toHaveBeenCalledWith({ name: "get_quotes", arguments: { instruments: ["NSE:INFY"] } });
  });

  it("adapts listTools() to a flat array of tool names", async () => {
    const client = { listTools: vi.fn().mockResolvedValue({ tools: [{ name: "login" }, { name: "get_ltp" }] }) };
    const listing = toToolListing(client);

    expect(await listing.listTools()).toEqual(["login", "get_ltp"]);
  });
});
