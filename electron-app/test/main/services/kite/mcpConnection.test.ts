import { describe, expect, it, vi } from "vitest";
import { connectKiteMcp } from "../../../../src/main/services/kite/mcpConnection";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { connectKiteMcpOAuth } from "../../../../src/main/services/kite/mcpConnection";

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

function fakeOAuthClient() {
  return {
    connect: vi.fn(),
    callTool: vi.fn().mockResolvedValue({ ok: true }),
    listTools: vi.fn().mockResolvedValue({ tools: [{ name: "login" }, { name: "get_ltp" }] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function oauthHarness() {
  const callOrder: string[] = [];
  const client = fakeOAuthClient();
  // The normal flow: the first connect on a fresh in-memory provider throws
  // UnauthorizedError (after the browser opens); the retry after finishAuth resolves.
  // Each mock implementation records its call into `callOrder` so tests can assert
  // finishAuth genuinely runs between the two connect attempts, not just that
  // "call 1 rejects, call 2 resolves" independent of sequencing.
  client.connect
    .mockImplementationOnce(() => {
      callOrder.push("connect:1");
      return Promise.reject(new UnauthorizedError("auth required"));
    })
    .mockImplementationOnce(() => {
      callOrder.push("connect:2");
      return Promise.resolve(undefined);
    });
  const transport = {
    finishAuth: vi.fn().mockImplementation((code: string) => {
      callOrder.push(`finishAuth:${code}`);
      return Promise.resolve(undefined);
    }),
  };
  const provider = {} as unknown as OAuthClientProvider;
  return {
    client,
    transport,
    provider,
    callOrder,
    createProvider: vi.fn().mockReturnValue(provider),
    createClient: vi.fn().mockReturnValue({ client, transport }),
    captureCallback: vi.fn().mockResolvedValue({ code: "AUTH_CODE", state: "xyz" }),
  };
}

describe("connectKiteMcpOAuth", () => {
  it("runs challenge -> capture -> finishAuth -> reconnect and adapts the client identically to the header path", async () => {
    const h = oauthHarness();

    const conn = await connectKiteMcpOAuth({
      loginPort: 3000,
      openExternal: vi.fn(),
      createProvider: h.createProvider,
      createClient: h.createClient,
      captureCallback: h.captureCallback,
    });

    expect(h.createProvider).toHaveBeenCalledWith({ loginPort: 3000, openExternal: expect.any(Function) });
    expect(h.createClient).toHaveBeenCalledWith({ url: "https://mcp.kite.trade/mcp", provider: h.provider });
    expect(h.captureCallback).toHaveBeenCalledWith({ port: 3000, signal: expect.any(AbortSignal) });
    expect(h.transport.finishAuth).toHaveBeenCalledWith("AUTH_CODE");
    expect(h.client.connect).toHaveBeenCalledTimes(2);
    expect(h.client.connect).toHaveBeenCalledWith(h.transport);
    expect(h.callOrder).toEqual(["connect:1", "finishAuth:AUTH_CODE", "connect:2"]);

    await conn.caller.callTool("get_ltp", { instruments: ["NSE:INFY"] });
    expect(h.client.callTool).toHaveBeenCalledWith({ name: "get_ltp", arguments: { instruments: ["NSE:INFY"] } });
    expect(await conn.listing.listTools()).toEqual(["login", "get_ltp"]);
    await conn.close();
    expect(h.client.close).toHaveBeenCalledTimes(1);
  });

  it("aborts the still-listening callback capture and skips finishAuth when the first connect succeeds outright", async () => {
    const client = fakeOAuthClient();
    client.connect.mockResolvedValueOnce(undefined);
    const transport = { finishAuth: vi.fn() };
    let capturedSignal: AbortSignal | undefined;
    const captureCallback = vi.fn().mockImplementation((opts: { signal?: AbortSignal }) => {
      capturedSignal = opts.signal;
      return new Promise<{ code: string; state: string | null }>(() => {});
    });

    await connectKiteMcpOAuth({
      loginPort: 3000,
      openExternal: vi.fn(),
      createProvider: () => ({} as unknown as OAuthClientProvider),
      createClient: () => ({ client, transport }),
      captureCallback,
    });

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(transport.finishAuth).not.toHaveBeenCalled();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("rethrows a non-UnauthorizedError from the first connect and never calls finishAuth", async () => {
    const client = fakeOAuthClient();
    client.connect.mockRejectedValueOnce(new Error("network down"));
    const transport = { finishAuth: vi.fn() };

    await expect(
      connectKiteMcpOAuth({
        loginPort: 3000,
        openExternal: vi.fn(),
        createProvider: () => ({} as unknown as OAuthClientProvider),
        createClient: () => ({ client, transport }),
        captureCallback: vi.fn().mockResolvedValue({ code: "unused", state: null }),
      }),
    ).rejects.toThrow(/network down/);
    expect(transport.finishAuth).not.toHaveBeenCalled();
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it("honours a custom url and otherwise defaults to https://mcp.kite.trade/mcp", async () => {
    const custom = oauthHarness();
    await connectKiteMcpOAuth({
      loginPort: 3000,
      openExternal: vi.fn(),
      url: "https://example.test/mcp",
      createProvider: custom.createProvider,
      createClient: custom.createClient,
      captureCallback: custom.captureCallback,
    });
    expect(custom.createClient).toHaveBeenCalledWith({ url: "https://example.test/mcp", provider: custom.provider });

    const dflt = oauthHarness();
    await connectKiteMcpOAuth({
      loginPort: 3000,
      openExternal: vi.fn(),
      createProvider: dflt.createProvider,
      createClient: dflt.createClient,
      captureCallback: dflt.captureCallback,
    });
    expect(dflt.createClient).toHaveBeenCalledWith({ url: "https://mcp.kite.trade/mcp", provider: dflt.provider });
  });
});
