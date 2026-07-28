import { describe, expect, it, vi } from "vitest";
import { KiteMcpOAuthProvider } from "../../../../src/main/services/kite/kiteMcpOAuthProvider";

describe("KiteMcpOAuthProvider", () => {
  it("exposes the public-client OAuth metadata for the given loginPort", () => {
    const provider = new KiteMcpOAuthProvider({ loginPort: 3000, openExternal: vi.fn() });
    expect(provider.clientMetadata).toEqual({
      client_name: "Trade Assistant",
      redirect_uris: ["http://127.0.0.1:3000/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  it("uses the same redirect URL as its single registered redirect_uri", () => {
    const provider = new KiteMcpOAuthProvider({ loginPort: 4100, openExternal: vi.fn() });
    expect(provider.redirectUrl).toBe("http://127.0.0.1:4100/callback");
    expect(provider.clientMetadata.redirect_uris).toEqual([provider.redirectUrl]);
  });

  it("returns undefined before any save and round-trips tokens/clientInformation in memory", () => {
    const provider = new KiteMcpOAuthProvider({ loginPort: 3000, openExternal: vi.fn() });
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toBeUndefined();

    const info = { client_id: "cid-1", redirect_uris: ["http://127.0.0.1:3000/callback"] };
    provider.saveClientInformation(info);
    expect(provider.clientInformation()).toEqual(info);

    const tokens = { access_token: "at-1", token_type: "bearer" };
    provider.saveTokens(tokens);
    expect(provider.tokens()).toEqual(tokens);
  });

  it("round-trips a PKCE code verifier and throws if read before it is saved", () => {
    const provider = new KiteMcpOAuthProvider({ loginPort: 3000, openExternal: vi.fn() });
    expect(() => provider.codeVerifier()).toThrow(/PKCE flow out of order/);
    provider.saveCodeVerifier("verifier-123");
    expect(provider.codeVerifier()).toBe("verifier-123");
  });

  it("redirects to authorization by opening the exact URL once", () => {
    const openExternal = vi.fn();
    const provider = new KiteMcpOAuthProvider({ loginPort: 3000, openExternal });
    provider.redirectToAuthorization(new URL("https://kite.example/auth?x=1"));
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith("https://kite.example/auth?x=1");
  });
});
